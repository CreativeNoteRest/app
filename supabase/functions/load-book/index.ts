// load-book Edge Function
// Promotes a verified book from books_staging to production.
// Calls the load_book_to_production Postgres RPC for atomic writes.
//
// Auth: caller session verified via auth.getUser(); email checked
//       against allowlist. Same pattern as admin-book-import.
// JWT verification: OFF (ES256 incompatibility — see WDN-041).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ADMIN_EMAILS = [
  "sgdensham@gmail.com",
  "creativenotemusicstudio@gmail.com",
];

Deno.serve(async (req) => {

  // ── CORS preflight ──────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond(405, { error: "Method not allowed." });
  }

  // ── Environment ─────────────────────────────────────────────────────
  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey        = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return respond(500, { error: "Missing required environment secrets." });
  }

  // ── Verify caller is an authenticated admin ─────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return respond(401, { error: "Missing Authorization header." });
  }

  const anonClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } =
    await anonClient.auth.getUser();

  if (userError || !userData?.user) {
    return respond(401, { error: "Could not verify caller session." });
  }

  if (!ADMIN_EMAILS.includes(userData.user.email ?? "")) {
    return respond(403, { error: "Caller is not an approved administrator." });
  }

  // ── Parse request body ───────────────────────────────────────────────
  let body: { book_id?: string };
  try {
    body = await req.json();
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  const { book_id } = body;

  if (!book_id || typeof book_id !== "string") {
    return respond(400, { error: "book_id is required." });
  }

  // Basic UUID format check — catches obvious mistakes before hitting DB
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(book_id)) {
    return respond(400, { error: "book_id must be a valid UUID." });
  }

  // ── Call the Postgres RPC ────────────────────────────────────────────
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: rpcData, error: rpcError } = await adminClient
    .rpc("load_book_to_production", { p_book_id: book_id });

  if (rpcError) {
    // RPC itself failed to execute (network, auth, or function not found)
    console.error("RPC execution error:", rpcError);
    return respond(500, {
      error: "Load function failed to execute.",
      detail: rpcError.message,
    });
  }

  // rpcData is an array because the function returns RETURNS TABLE.
  // We expect exactly one row.
  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData;

  if (!result) {
    return respond(500, { error: "Load function returned no result." });
  }

  if (!result.success) {
    // The RPC ran but the load failed (bad status, count mismatch, etc.)
    // All writes were rolled back inside Postgres.
    console.error("Load failed:", result.error_message);
    return respond(422, {
      error: result.error_message ?? "Load failed — no detail returned.",
    });
  }

  // ── Success ──────────────────────────────────────────────────────────
  return respond(200, {
    success:       true,
    books_action:  result.books_action,   // 'inserted' or 'updated'
    units_loaded:  result.units_loaded,
    pieces_loaded: result.pieces_loaded,
  });
});

// ── Helper ───────────────────────────────────────────────────────────────
function respond(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
