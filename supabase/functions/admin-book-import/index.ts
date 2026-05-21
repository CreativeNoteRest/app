// admin-book-import Edge Function
// Accepts a pre-flattened array of books_staging rows and writes them.
// Deletes any existing staging rows for the same book_id first (re-import).
// Auth: caller session verified via auth.getUser(); email checked against allowlist.
// JWT verification: OFF (ES256 incompatibility — see WDN-041).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const ADMIN_EMAILS = ["sgdensham@gmail.com", "creativenotemusicstudio@gmail.com"];

const VALID_PIECE_TYPES = [
  "Lesson Piece",
  "Challenge Piece",
  "Getting Ready Exercises",
  "Duet with Teacher",
  "Lesson Worksheet"
];

Deno.serve(async (req) => {

  // ── CORS preflight ────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // ── Environment ───────────────────────────────────────────────────────
  const supabaseUrl     = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey         = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return respond(500, { error: "Missing required environment secrets." });
  }

  // ── Verify caller is an authenticated admin ───────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return respond(401, { error: "Missing Authorization header." });
  }

  const anonClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const { data: userData, error: userError } = await anonClient.auth.getUser();
  if (userError || !userData?.user) {
    return respond(401, { error: "Could not verify caller session." });
  }

  if (!ADMIN_EMAILS.includes(userData.user.email ?? "")) {
    return respond(403, { error: "Caller is not an approved administrator." });
  }

  // ── Parse request body ────────────────────────────────────────────────
  let body: { rows?: unknown[]; book_id?: string };
  try {
    body = await req.json();
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  const { rows, book_id } = body;

  if (!book_id || typeof book_id !== "string") {
    return respond(400, { error: "book_id is required." });
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return respond(400, { error: "rows array is required and must not be empty." });
  }

  // ── Server-side row validation ────────────────────────────────────────
  // Belt-and-suspenders: client validates first, but we re-check critical
  // constraints before touching the database.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const pos = `Row ${i + 1}`;

    if (!row.piece_title)         return respond(400, { error: `${pos}: piece_title is required.` });
    if (!row.book_display_name)   return respond(400, { error: `${pos}: book_display_name is required.` });
    if (!row.series_id)           return respond(400, { error: `${pos}: series_id is required.` });
    if (row.sequence_number === null || row.sequence_number === undefined) {
      return respond(400, { error: `${pos}: sequence_number is required (cannot be null).` });
    }
    if (row.piece_type && !VALID_PIECE_TYPES.includes(row.piece_type as string)) {
      return respond(400, { error: `${pos}: invalid piece_type "${row.piece_type}".` });
    }
    if (row.book_id !== book_id) {
      return respond(400, { error: `${pos}: row book_id does not match supplied book_id.` });
    }
  }

  // ── Write to staging ──────────────────────────────────────────────────
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Delete existing staging rows for this book_id (re-import replaces all)
  const { error: deleteError } = await adminClient
    .from("books_staging")
    .delete()
    .eq("book_id", book_id);

  if (deleteError) {
    return respond(500, { error: `Failed to clear existing staging rows: ${deleteError.message}` });
  }

  // Insert new rows
  const { error: insertError } = await adminClient
    .from("books_staging")
    .insert(rows);

  if (insertError) {
    return respond(500, { error: `Failed to insert staging rows: ${insertError.message}` });
  }

  return respond(200, { success: true, count: rows.length });
});

// ── Helper ────────────────────────────────────────────────────────────────
function respond(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
