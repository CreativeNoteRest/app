import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// vector-search Edge Function
// Accepts a plain-text query, embeds it using gemini-embedding-001, and runs
// a pgvector cosine similarity search against the supplements table.
// Used by the admin vector search lab (admin/vector-search.html).
//
// Auth: auth_user_id in POST body + is_admin check via service role key.
// JWT verification must be OFF (WDN-041, WDN-072).
// GEMINI_API_KEY must be manually added to this function's secrets (WDN-042).
// ---------------------------------------------------------------------------

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

// Normalize to unit length — required for gemini-embedding-001 at non-3072 dimensions
// so cosine similarity (pgvector <=>) is accurate. Same pattern as generate-supplement-embeddings.
function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return values;
  return values.map((v) => v / magnitude);
}

// Retry on 503 (busy) and 429 (rate limit). Same pattern as other EFs.
async function generateEmbedding(
  text: string,
  geminiApiKey: string
): Promise<number[]> {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
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

    if (
      (response.status === 503 || response.status === 429) &&
      attempt < delays.length
    ) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }

    const err = await response.text();
    throw new Error(`Gemini embedding API error ${response.status}: ${err}`);
  }

  throw new Error("Gemini embedding: retries exhausted");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

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
      query_text,
      catalog_filter = null,   // 'toolkit' | 'piano-books' | null (all)
      limit          = 20,
    } = body;

    if (!auth_user_id || !series_id || !query_text?.trim()) {
      return jsonResponse(
        { error: "auth_user_id, series_id, and query_text are required" },
        400
      );
    }

    // Admin check — same pattern as all admin Edge Functions
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: teacher, error: teacherError } = await serviceClient
      .from("teachers")
      .select("is_admin")
      .eq("auth_user_id", auth_user_id)
      .single();

    if (teacherError || !teacher?.is_admin) {
      return jsonResponse({ error: "Unauthorised" }, 403);
    }

    // Embed the query text
    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(query_text.trim(), geminiApiKey);
    } catch (err) {
      return jsonResponse(
        { error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}` },
        500
      );
    }

    // pgvector similarity search via Postgres function
    const { data: results, error: rpcError } = await serviceClient.rpc(
      "rank_supplements_by_embedding",
      {
        p_query_embedding: JSON.stringify(queryEmbedding),
        p_series_id:       series_id,
        p_catalog_filter:  catalog_filter,
        p_limit:           limit,
      }
    );

    if (rpcError) {
      return jsonResponse({ error: `Search failed: ${rpcError.message}` }, 500);
    }

    return jsonResponse({ results: results ?? [] });

  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unexpected error" },
      500
    );
  }
});
