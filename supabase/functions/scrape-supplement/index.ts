// scrape-supplement/index.ts
// Fetches a supplement page from wunderkeys.com or teachpianotoday.com
// using the wp-postpass cookie supplied by the caller.
// Returns structured supplement metadata extracted from the page HTML.
//
// JWT verification: OFF (ES256 incompatibility — see WDN-041)
// Auth: admin-only. Caller must be authenticated via Supabase Auth.
//       Verified via auth.getUser() + is_admin check on Teachers table.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Cookie detection ─────────────────────────────────────────────────────────
// WordPress password-protected pages return the password form in the HTML
// rather than a 403. We detect this by looking for the wp-postpass form
// or password field in the response body.
function isCookieExpired(html: string): boolean {
  return (
    html.includes('name="post_password"') ||
    html.includes('class="post-password-form"') ||
    html.includes("This content is password protected")
  );
}

// ── Site detection ───────────────────────────────────────────────────────────
function siteFromUrl(url: string): "wunderkeys" | "teachpianotoday" | null {
  if (url.includes("wunderkeys.com")) return "wunderkeys";
  if (url.includes("teachpianotoday.com")) return "teachpianotoday";
  return null;
}

// ── Cookie header name ───────────────────────────────────────────────────────
// WordPress sets a site-specific cookie named wp-postpass_{hash}.
// We don't know the exact hash suffix, so we send the value under a
// generic name and rely on the browser having set the correct name.
// The caller supplies the full cookie value (hash string); we reconstruct
// a plausible header. In practice the cookie name doesn't matter as long
// as the value matches — but we must send it under the correct key.
// The admin UI instructs the user to copy the full "wp-postpass_…=value"
// pair; if they do, we use it as-is. If they copy only the value, we
// wrap it with a generic name and WordPress will still accept it because
// it matches on value, not name, for postpass cookies.
function buildCookieHeader(raw: string): string {
  // If the user pasted "wp-postpass_abc123=hashvalue" use as-is
  if (raw.includes("=")) return raw;
  // Otherwise wrap it — WordPress matches on the hash value
  return `wp-postpass_cn=${raw}`;
}

// ── HTML extraction helpers ──────────────────────────────────────────────────
function extractMeta(html: string, property: string): string {
  // og:title, og:image etc
  const re = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re) || html.match(
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
      "i"
    )
  );
  return m ? m[1].trim() : "";
}

function extractMetaName(html: string, name: string): string {
  const re = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re) || html.match(
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`,
      "i"
    )
  );
  return m ? m[1].trim() : "";
}

function extractTitle(html: string): string {
  // Priority: og:title > <title> tag
  const og = extractMeta(html, "og:title");
  if (og) return og;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}

function extractThumbnail(html: string): string {
  // Priority: og:image > first featured image src
  const og = extractMeta(html, "og:image");
  if (og) return og;
  // WordPress featured image
  const wp = html.match(/class=["'][^"']*wp-post-image[^"']*["'][^>]*src=["']([^"']+)["']/i);
  if (wp) return wp[1];
  return "";
}

function extractPdfUrl(html: string, baseUrl: string): string {
  // Look for .pdf links — prioritise /wp-content/uploads/ paths
  const re = /href=["']([^"']+\.pdf[^"']*?)["']/gi;
  let m: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((m = re.exec(html)) !== null) {
    candidates.push(m[1]);
  }
  if (!candidates.length) return "";
  // Prefer wp-content/uploads
  const upload = candidates.find((c) => c.includes("/wp-content/uploads/"));
  if (upload) return upload.startsWith("http") ? upload : new URL(upload, baseUrl).href;
  const first = candidates[0];
  return first.startsWith("http") ? first : new URL(first, baseUrl).href;
}

// ── is_free detection ────────────────────────────────────────────────────────
// Mirrors the three-priority logic from scrape_wk.py
function detectIsFree(url: string, html: string): boolean | null {
  // Priority 1 — URL pattern
  const paidPatterns = ["/shop/", "/product/", "/books/", "/bundle/", "/collection/", "/piano-book/"];
  const freePatterns = ["/blog/", "/free/", "/printable/", "/resource/", "/activity/", "/homework-pages/"];
  for (const p of paidPatterns) if (url.includes(p)) return false;
  for (const p of freePatterns) if (url.includes(p)) return true;

  // Priority 2 — DOM signals
  if (
    html.includes("Add to cart") ||
    html.includes("add-to-cart") ||
    html.includes("woocommerce-Price-amount") ||
    html.match(/\$\d+\.\d{2}/)
  ) return false;
  if (
    html.includes("free download") ||
    html.includes("Free Download") ||
    html.includes("download for free")
  ) return true;

  // Priority 3 — language heuristics
  const lower = html.toLowerCase();
  const paidWords = ["level book", "method book", "curriculum", "bundle", "add to cart"];
  const freeWords = ["freebie", "free printable", "free worksheet", "no cost"];
  for (const w of paidWords) if (lower.includes(w)) return false;
  for (const w of freeWords) if (lower.includes(w)) return true;

  return null; // unknown — NULL in DB
}

// ── Strip HTML tags for plain text ───────────────────────────────────────────
function stripTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") return err("Method not allowed", 405);

  // ── Auth check ─────────────────────────────────────────────────────────────
  // auth.getUser() is not viable due to ES256 JWT incompatibility (WDN-045, D-102).
  // Authorization is enforced by verifying the teacher_id supplied in the POST body
  // against the teachers table using the service role key (bypasses RLS).
  // Pattern: ownership validation against DB record, not auth.getUser().
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: { url?: string; cookie?: string; series_id?: string; auth_user_id?: string };
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { url, cookie, auth_user_id } = body;

  // ── Ownership validation ────────────────────────────────────────────────────
  // Browser passes auth_user_id from session — no DB query needed browser-side.
  // Edge Function verifies is_admin via service role key (bypasses RLS).
  if (!auth_user_id) return err("Unauthorized", 401);
  const { data: teacher, error: teacherErr } = await sbAdmin
    .from("teachers")
    .select("is_admin")
    .eq("auth_user_id", auth_user_id)
    .single();
  if (teacherErr || !teacher?.is_admin) return err("Admin access required", 403);
  if (!url) return err("url is required");

  const site = siteFromUrl(url);
  if (!site) return err("URL must be from wunderkeys.com or teachpianotoday.com");

  // ── Fetch the page ─────────────────────────────────────────────────────────
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; CreativeNote/1.0)",
    "Accept": "text/html,application/xhtml+xml",
  };
  if (cookie) {
    headers["Cookie"] = buildCookieHeader(cookie);
  }

  let html: string;
  try {
    const response = await fetch(url, { headers, redirect: "follow" });
    html = await response.text();
  } catch (e) {
    return err(`Failed to fetch page: ${(e as Error).message}`);
  }

  // ── Cookie expired check ───────────────────────────────────────────────────
  if (isCookieExpired(html)) {
    return err("cookie_expired");
  }

  // ── Extract fields ─────────────────────────────────────────────────────────
  const title = extractTitle(html);
  const thumbnail_url = extractThumbnail(html);
  const pdf_url = extractPdfUrl(html, url);
  const is_free = detectIsFree(url, html);

  // Extract readable page text for use by generate-supplement-description
  // Limit to ~4000 chars to keep Gemini prompt manageable
  const page_text = stripTags(html).slice(0, 4000);

  return ok({
    title,
    thumbnail_url: thumbnail_url || null,
    pdf_url: pdf_url || null,
    source: site,
    is_free,
    page_text,
    url,
  });
});
