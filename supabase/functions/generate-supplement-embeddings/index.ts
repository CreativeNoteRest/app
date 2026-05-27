import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildEmbeddingInput(row: {
  title: string;
  curriculum_hint: string | null;
  search_description: string | null;
}): string | null {
  if (!row.search_description) return null;
  const parts: string[] = [];
  parts.push(row.title);
  if (row.curriculum_hint) parts.push(row.curriculum_hint);
  parts.push(row.search_description);
  return parts.join(". ");
}

// Normalize to unit length — required for gemini-embedding-001 at non-3072 dimensions
// so cosine similarity (used by pgvector) is accurate
function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return values;
  return values.map((v) => v / magnitude);
}

// Retry on 503 (busy) and 429 (rate limit) — same pattern as other EFs
async function generateEmbedding(
  text: string,
  geminiApiKey: string
): Promise<number[]> {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
  const delays = [3000, 6000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey,
      },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const values = data.embedding.values as number[];
      return normalizeVector(values);
    }

    // Retryable
    if ((response.status === 503 || response.status === 429) && attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }

    // Non-retryable or retries exhausted
    const err = await response.text();
    throw new Error(`Gemini embedding API error ${response.status}: ${err}`);
  }

  throw new Error("Gemini embedding: retries exhausted");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const geminiApiKey   = Deno.env.get("GEMINI_API_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl    = Deno.env.get("SUPABASE_URL");

    if (!geminiApiKey || !serviceRoleKey || !supabaseUrl) {
      return jsonResponse({ error: "Missing required environment secrets" }, 500);
    }

    const body = await req.json();
    const {
      auth_user_id,
      series_id,
      supplement_ids,
      overwrite   = false,
      batch_size  = 25,
    } = body;

    if (!auth_user_id || !series_id) {
      return jsonResponse({ error: "auth_user_id and series_id are required" }, 400);
    }

    // Admin check
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: teacher, error: teacherError } = await serviceClient
      .from("teachers")
      .select("is_admin")
      .eq("auth_user_id", auth_user_id)
      .single();

    if (teacherError || !teacher?.is_admin) {
      return jsonResponse({ error: "Unauthorised" }, 403);
    }

    // Build query
    let query = serviceClient
      .from("supplements")
      .select("supplement_id, title, curriculum_hint, search_description")
      .eq("series_id", series_id)
      .eq("is_active", true);

    if (supplement_ids && supplement_ids.length > 0) {
      query = query.in("supplement_id", supplement_ids);
    } else if (!overwrite) {
      query = query.is("embedding", null);
    }

    // Fetch one batch + one extra to know if more remain
    query = query.limit(batch_size + 1);

    const { data: rows, error: fetchError } = await query;

    if (fetchError) {
      return jsonResponse({ error: `Fetch error: ${fetchError.message}` }, 500);
    }

    if (!rows || rows.length === 0) {
      return jsonResponse({ processed: 0, skipped: 0, failed: 0, remaining: 0 });
    }

    const hasMore = rows.length > batch_size;
    const batch   = hasMore ? rows.slice(0, batch_size) : rows;

    let processed = 0;
    let skipped   = 0;
    const failures: { supplement_id: string; title: string; error: string }[] = [];

    for (const row of batch) {
      const embeddingInput = buildEmbeddingInput(row);

      if (!embeddingInput) {
        skipped++;
        continue;
      }

      try {
        const embedding = await generateEmbedding(embeddingInput, geminiApiKey);

        const { error: updateError } = await serviceClient
          .from("supplements")
          .update({ embedding: JSON.stringify(embedding) })
          .eq("supplement_id", row.supplement_id);

        if (updateError) {
          failures.push({
            supplement_id: row.supplement_id,
            title: row.title,
            error: updateError.message,
          });
        } else {
          processed++;
        }
      } catch (err) {
        failures.push({
          supplement_id: row.supplement_id,
          title: row.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Brief delay between calls to stay well under rate limits
      await new Promise((r) => setTimeout(r, 100));
    }

    return jsonResponse({
      processed,
      skipped,
      failed:    failures.length,
      remaining: hasMore ? -1 : 0,
      failures:  failures.length > 0 ? failures : undefined,
    });

  } catch (err) {
    return jsonResponse({
      error: err instanceof Error ? err.message : "Unexpected error",
    }, 500);
  }
});
