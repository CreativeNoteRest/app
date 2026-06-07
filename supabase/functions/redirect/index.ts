import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Session ID encoding / decoding ────────────────────────────────────────────
// Encodes a UUID to a 22-char Base64url string for use in redirect URLs.
// The raw UUID is never exposed in externally distributed links.
// Decoding is a single operation -- no lookup table required.

function encodeSessionId(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function decodeSessionId(encoded: string): string | null {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64);
    const hex = Array.from(binary)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

// ── Bot / scanner User-Agent suppression ──────────────────────────────────────
// Suppresses log insert for known automated scanners and email security crawlers.
// The redirect always proceeds -- a suspected bot is never blocked.
// This list targets the most common false-positive sources (email security
// scanners, link previewers). Sophisticated scanners that spoof browser UAs
// will not be caught -- this is expected and acceptable at this scale.

const BOT_UA_FRAGMENTS = [
  "googlebot", "bingbot", "ahrefsbot", "semrushbot",
  "facebookexternalhit", "slackbot", "twitterbot", "linkedinbot",
  "safebrowsing", "preview", "spider", "crawler",
  "msnbot", "duckduckbot", "yahoo! slurp",
];

function isSuspectedBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return BOT_UA_FRAGMENTS.some((fragment) => ua.includes(fragment));
}

// ── UTM parameters appended to destination URL ───────────────────────────────
// These allow WunderKeys to see Creative Note as a traffic source in their
// own site analytics. Values are fixed -- no per-click variation needed.

function appendUtmParams(url: string, source: string): string {
  const medium = source === "email" ? "email" : "platform";
  const params = new URLSearchParams({
    utm_source:   "creativenote",
    utm_medium:   medium,
    utm_campaign: "supplement-recommendation",
  });
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${params.toString()}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {

  // GET only -- this function is called by clicking a link, not by the app.
  // No CORS headers needed: browser follows the 302 directly, no preflight.
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const SUPABASE_URL     = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response("Server configuration error", { status: 500 });
  }

  // ── Parse query parameters ────────────────────────────────────────
  const url    = new URL(req.url);
  const suppId = url.searchParams.get("s");   // supplement UUID (plain)
  const sidEnc = url.searchParams.get("sid"); // session ID (Base64url encoded)
  const source = url.searchParams.get("src") || "platform"; // email | platform

  if (!suppId) {
    return new Response("Missing required parameter: s", { status: 400 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Resolve supplement -- get source_url and series_id ──────────
  // supplements table has no book_id -- book relationship is via
  // supplement_eligibility_map, not a direct column. book_id is
  // omitted from click_through_log for email-originated clicks.
  const { data: supplement, error: suppErr } = await db
    .from("supplements")
    .select("supplement_id, source_url, series_id")
    .eq("supplement_id", suppId)
    .single();

  if (suppErr || !supplement?.source_url) {
    // Supplement not found or has no destination -- fail open to homepage
    console.error("Supplement lookup failed:", suppErr?.message, "suppId:", suppId);
    return Response.redirect("https://app.creativenoterest.com", 302);
  }

  // ── Decode session ID ─────────────────────────────────────────────
  const sessionId = sidEnc ? decodeSessionId(sidEnc) : null;

  // ── Bot detection ─────────────────────────────────────────────────
  const userAgent    = req.headers.get("user-agent") || "";
  const suspectedBot = isSuspectedBot(userAgent);

  // ── Build destination URL with UTM params ─────────────────────────
  const destination = appendUtmParams(supplement.source_url, source);

  // ── Log the click (non-blocking -- never delays the redirect) ────
  // student_id derivation and insert both run after the 302 fires.
  // Neither is in the critical path -- logging must never delay the user.
  (async () => {
    try {
      // Derive student_id from session -- kept inside async block so
      // this DB call never delays the redirect.
      let studentId: string | null = null;
      if (sessionId) {
        const { data: sessionRow } = await db
          .from("sessions")
          .select("student_id")
          .eq("session_id", sessionId)
          .single();
        studentId = sessionRow?.student_id ?? null;
      }

      const { error: logErr } = await db.from("click_through_log").insert({
        series_id:     supplement.series_id,
        supplement_id: supplement.supplement_id,
        session_id:    sessionId,
        student_id:    studentId,
        source:        source,
        suspected_bot: suspectedBot,
        clicked_at:    new Date().toISOString(),
        utm_params:    suspectedBot ? null : {
          utm_source:   "creativenote",
          utm_medium:   source === "email" ? "email" : "platform",
          utm_campaign: "supplement-recommendation",
        },
      });
      if (logErr) console.error("click_through_log insert failed (non-blocking):", logErr.message);
    } catch (e) {
      console.error("click_through_log unexpected error (non-blocking):", e);
    }
  })();

  // ── Issue redirect ────────────────────────────────────────────────
  // 302 (temporary) rather than 301 (permanent) so clients always
  // check back with us rather than caching the destination directly.
  return Response.redirect(destination, 302);
});
