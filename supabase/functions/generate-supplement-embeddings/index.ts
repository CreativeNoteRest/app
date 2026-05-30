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

// Strip the AUDIENCE section from search_description before embedding.
// search_description stores AUDIENCE + GOALS for future teacher-facing browse display,
// but audience/level is already captured by curriculum_hint in the embedding input.
// Embedding only the GOALS content focuses the vector on skills — the primary
// ranking signal at session close. Fallback: if GOALS label is absent (thin-source
// rows where Gemini stopped early), use the full description rather than nothing.
function extractGoalsContent(searchDescription: string): string {
  const goalsIndex = searchDescription.indexOf("GOALS");
  if (goalsIndex === -1) return searchDescription;
  return searchDescription.slice(goalsIndex + 5).trim();
}

function buildEmbeddingInput(row: {
  title: string;
  curriculum_hint: string | null;
  search_description: string | null;
  wk_topics: string[] | null;
}): string | null {
  if (!row.search_description) return null;
  const parts: string[] = [];
  parts.push(row.title);
  if (row.curriculum_hint) parts.push(row.curriculum_hint);
  parts.push(extractGoalsContent(row.search_description));
  // Include topic slugs where present — carries seasonal and category signal
  // for teacher browse search. Guard against null and empty array.
  if (row.wk_topics && row.wk_topics.length > 0) {
    parts.push(row.wk_topics.join(" "));
  }
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
      overwrite  = false,
      batch_size = 25,
      after_id   = null,   // cursor: supplement_id of last row processed in prior batch
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

    // Build query — always order by supplement_id for stable cursor pagination
    let query = serviceClient
      .from("supplements")
      .select("supplement_id, title, curriculum_hint, search_description, wk_topics")
      .eq("series_id", series_id)
      .eq("is_active", true)
      .order("supplement_id", { ascending: true });

    if (supplement_ids && supplement_ids.length > 0) {
      // Specific IDs mode — cursor not applicable
      query = query.in("supplement_id", supplement_ids);
    } else {
      if (!overwrite) {
        // New-only mode: only rows missing an embedding
        query = query.is("embedding", null);
      }
      // Cursor: start after the last processed ID
      if (after_id) {
        query = query.gt("supplement_id", after_id);
      }
    }

    // Fetch one batch + one extra to know if more remain
    query = query.limit(batch_size + 1);

    const { data: rows, error: fetchError } = await query;

    if (fetchError) {
      return jsonResponse({ error: `Fetch error: ${fetchError.message}` }, 500);
    }

    if (!rows || rows.length === 0) {
      return jsonResponse({ processed: 0, skipped: 0, failed: 0, remaining: 0, last_id: null });
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

    // Return the last supplement_id processed so the browser can pass it
    // as after_id on the next batch call — prevents re-processing same rows
    const lastId = batch[batch.length - 1]?.supplement_id ?? null;

    return jsonResponse({
      processed,
      skipped,
      failed:    failures.length,
      remaining: hasMore ? -1 : 0,
      last_id:   lastId,
      failures:  failures.length > 0 ? failures : undefined,
    });

  } catch (err) {
    return jsonResponse({
      error: err instanceof Error ? err.message : "Unexpected error",
    }, 500);
  }
});
