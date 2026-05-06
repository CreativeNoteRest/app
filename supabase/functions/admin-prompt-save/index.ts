// admin-prompt-save Edge Function
// Receives a prompt update from admin/prompts.html.
// Verifies the caller is an authenticated admin user.
// Writes to the Prompts table using the service role key.
// JWT verification: ON (caller must have a valid Supabase session).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS headers -- must include x-client-info and apikey for supabase-js invoke()
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const ADMIN_EMAILS = [
  "sgdensham@gmail.com",
  "creativenotemusicstudio@gmail.com"
];

Deno.serve(async (req: Request) => {

  // CORS preflight -- must return corsHeaders here
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // Guard: secrets must be present
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return respond(500, { error: "Missing required environment secrets" });
  }

  // ── 1. Verify caller has a valid Supabase session ─────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return respond(401, { error: "Missing or invalid Authorization header" });
  }

  const jwt = authHeader.replace("Bearer ", "");

  const userClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();

  if (userError || !user) {
    return respond(401, { error: "Invalid or expired session. Please log in again." });
  }

  // ── 2. Verify caller is an approved admin ─────────────────────────
  if (!ADMIN_EMAILS.includes(user.email ?? "")) {
    return respond(403, { error: "Access denied. This account does not have admin privileges." });
  }

  // ── 3. Parse request body ─────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return respond(400, { error: "Invalid JSON in request body" });
  }

  const { prompt_id, prompt_key, prompt_text, prompt_text_previous } = body;

  if (!prompt_id || !prompt_key || typeof prompt_text !== "string") {
    return respond(400, { error: "Missing required fields: prompt_id, prompt_key, prompt_text" });
  }

  if (!prompt_text.trim()) {
    return respond(400, { error: "prompt_text cannot be empty" });
  }

  // ── 4. Write to Prompts table using service role ──────────────────
  const adminClient = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { error: updateError } = await adminClient
    .from("prompts")
    .update({
      prompt_text:          prompt_text,
      prompt_text_previous: prompt_text_previous ?? null,
      updated_at:           new Date().toISOString()
    })
    .eq("prompt_id", prompt_id)
    .eq("prompt_key", prompt_key);

  if (updateError) {
    console.error("Prompts update failed:", updateError.message);
    return respond(500, { error: "Database write failed: " + updateError.message });
  }

  // ── 5. Return updated prompt ──────────────────────────────────────
  const { data: updated, error: fetchError } = await adminClient
    .from("prompts")
    .select("prompt_id, prompt_key, prompt_label, prompt_text, prompt_text_previous, updated_at, required_variables")
    .eq("prompt_id", prompt_id)
    .single();

  if (fetchError || !updated) {
    return respond(200, { success: true, prompt: null });
  }

  return respond(200, { success: true, prompt: updated });
});

function respond(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
