// generate-supplement-description/index.ts
// Generates or re-generates the search_description field for a supplement.
//
// Mode A — Generate (new or first-time, or rerun):
//   { url, pdf_url, context, cookie, page_text, curriculum_hint, pdf_vision_override }
//   Combines all available signals — curriculum_hint, page_text, PDF (both text
//   extraction and vision when available) — into a single Gemini call.
//   PDF text extraction and vision both run when pdf_url present and buffer <=
//   PDF_BULK_SIZE_LIMIT. If buffer > limit in bulk mode (pdf_vision_override
//   absent/false), PDF is skipped and response includes pdf_skipped: true so
//   the UI can flag the row. If pdf_vision_override: true, limit is raised to
//   PDF_OVERRIDE_SIZE_LIMIT.
//   When no page_text and no pdf_url are passed (rerun against a promoted
//   supplement), the EF fetches source_url directly and scans the HTML for a
//   PDF link — enabling full-quality reruns without stored raw material.
//   Returns { description, pdf_skipped? }.
//
// System instruction is fetched from the prompts table at runtime
// (prompt_key: supplement_description_system). Edit there without a deploy.
//
// JWT verification: OFF (ES256 incompatibility — see WDN-041)
// Auth: admin-only. Verified via is_admin check on Teachers table.
// Secrets required: GEMINI_API_KEY (add manually in Supabase dashboard)

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

// ── PDF size limits ───────────────────────────────────────────────────────────
// Bulk runs skip PDFs larger than PDF_BULK_SIZE_LIMIT and return pdf_skipped:true.
// Single-row manual calls with pdf_vision_override:true allow up to PDF_OVERRIDE_SIZE_LIMIT.
const PDF_BULK_SIZE_LIMIT     = 2 * 1024 * 1024;  // 2 MB
const PDF_OVERRIDE_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB

// ── Gemini fetch with retry ───────────────────────────────────────────────────
// Shared by callGeminiText and callGeminiMultimodal.
// Retries up to 2 times on 503 (UNAVAILABLE) and 429 (rate limit) only.
// All other error statuses throw immediately — retrying a 400 won't help.
const GEMINI_MAX_RETRIES  = 2;
const GEMINI_RETRY_DELAY  = 3000; // ms — multiplied by attempt number (3s, 6s)

async function geminiRequest(url: string, body: unknown): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, GEMINI_RETRY_DELAY * attempt));
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return response.json();
    const errText = await response.text();
    if (response.status === 503 || response.status === 429) {
      lastError = `Gemini API error ${response.status}: ${errText}`;
      continue;
    }
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }
  throw new Error(`Gemini unavailable after ${GEMINI_MAX_RETRIES + 1} attempts: ${lastError}`);
}

// ── Gemini: text-only call ────────────────────────────────────────────────────
// Used for any Mode A path that has no PDF vision input.
// Matches the pattern used in session-close: gemini-2.5-flash-lite,
// thinkingBudget: 0, system_instruction required.
// systemInstruction is fetched from the prompts table at handler entry.
async function callGeminiText(prompt: string, systemInstruction: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const data = await geminiRequest(url, body) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter((p: { text?: string }) => p.text)
    ?.map((p: { text: string }) => p.text)
    ?.join("") ?? "";

  if (!text) throw new Error("Gemini returned empty response");
  return text.trim();
}

// ── Gemini: multimodal call ───────────────────────────────────────────────────
// Used when PDF vision is included. Accepts a mixed parts array:
//   { text: string }  — text content (assembled signals)
//   { inline_data: { mime_type: string, data: string } }  — base64 PDF bytes
// All parts are sent as a single user message so Gemini treats them as one request.
// systemInstruction is fetched from the prompts table at handler entry.
type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

async function callGeminiMultimodal(parts: GeminiPart[], systemInstruction: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const data = await geminiRequest(url, body) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter((p: { text?: string }) => p.text)
    ?.map((p: { text: string }) => p.text)
    ?.join("") ?? "";

  if (!text) throw new Error("Gemini returned empty response");
  return text.trim();
}

// ── PDF text extraction ───────────────────────────────────────────────────────
// Fetches a PDF and extracts readable text.
// PDFs are binary; we use a simple text extraction approach that works for
// most text-layer PDFs without a full parsing library.
// Deno Edge Functions do not have pdf.js available, so we extract raw text
// streams from the PDF binary — sufficient for supplement descriptions.
function extractPdfText(buffer: Uint8Array): string {
  // Convert to string — works for text-layer PDFs
  const raw = new TextDecoder("latin1").decode(buffer);

  // Extract BT...ET blocks (PDF text objects)
  const texts: string[] = [];
  const btEt = raw.matchAll(/BT([\s\S]*?)ET/g);
  for (const block of btEt) {
    // Extract Tj and TJ operator content
    const tjMatches = block[1].matchAll(/\(([^)]*)\)\s*Tj/g);
    for (const m of tjMatches) texts.push(m[1]);
    const tjArrayMatches = block[1].matchAll(/\[([^\]]*)\]\s*TJ/g);
    for (const m of tjArrayMatches) {
      const strings = m[1].matchAll(/\(([^)]*)\)/g);
      for (const s of strings) texts.push(s[1]);
    }
  }

  const extracted = texts
    .join(" ")
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Return up to 3000 chars — enough for description context
  return extracted.slice(0, 3000);
}

// ── PDF URL extraction ────────────────────────────────────────────────────────
// Scans page HTML for a .pdf href. Used on the page-fetch fallback path to
// locate a PDF when none was passed in the request body (e.g. rerun against
// a promoted supplement where pdf_url is not stored).
// Mirrors extractPdfUrl() from scrape-supplement/index.ts.
// Prioritises /wp-content/uploads/ paths as the most reliable PDF source.
function extractPdfUrl(html: string, baseUrl: string): string {
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

// ── Cookie header builder ─────────────────────────────────────────────────────
function buildCookieHeader(raw: string): string {
  if (raw.includes("=")) return raw;
  return `wp-postpass_cn=${raw}`;
}

// ── Cookie expired detection ──────────────────────────────────────────────────
function isGated(text: string): boolean {
  return (
    text.includes('name="post_password"') ||
    text.includes("This content is password protected")
  );
}

// ── PDF fetch and process ─────────────────────────────────────────────────────
// Shared helper: fetches a PDF by URL, runs text extraction, and prepares
// vision data if within the size limit. Returns both outputs so the caller
// can include whichever are available in the signal assembly.
// Non-fatal — failures return empty results so description generation continues
// with whatever other signals are available.
async function fetchAndProcessPdf(
  pdfUrl: string,
  cookie: string | undefined,
  pdf_vision_override: boolean,
): Promise<{ pdfText: string; visionPart: GeminiPart | null; skipped: boolean }> {
  try {
    const pdfHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (compatible; CreativeNote/1.0)",
    };
    if (cookie && (
      pdfUrl.includes("wunderkeys.com") ||
      pdfUrl.includes("teachpianotoday.com")
    )) {
      pdfHeaders["Cookie"] = buildCookieHeader(cookie);
    }

    const pdfRes = await fetch(pdfUrl, { headers: pdfHeaders, redirect: "follow" });
    if (!pdfRes.ok) return { pdfText: "", visionPart: null, skipped: false };

    const buffer = new Uint8Array(await pdfRes.arrayBuffer());

    // Always attempt text extraction
    const pdfText = extractPdfText(buffer);

    // Always attempt vision — subject to size limit
    const sizeLimit = pdf_vision_override ? PDF_OVERRIDE_SIZE_LIMIT : PDF_BULK_SIZE_LIMIT;
    if (buffer.length > sizeLimit) {
      // Oversized — return text extraction result only, flag as skipped
      return { pdfText, visionPart: null, skipped: true };
    }

    // Within limit — base64 encode for vision
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < buffer.length; i += chunkSize) {
      binary += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    const visionPart: GeminiPart = {
      inline_data: { mime_type: "application/pdf", data: base64 },
    };

    return { pdfText, visionPart, skipped: false };
  } catch {
    // Non-fatal — PDF fetch or processing failure should not block description
    return { pdfText: "", visionPart: null, skipped: false };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") return err("Method not allowed", 405);

  // ── Auth check ─────────────────────────────────────────────────────────────
  // auth.getUser() not viable — ES256 incompatibility (WDN-045, D-102).
  // Ownership validation via auth_user_id in POST body against service role client.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: {
    auth_user_id?: string;
    pdf_vision_override?: boolean; // single-row manual override: raises PDF size limit to 10 MB
    system_instruction_override?: string; // prompt lab: test a draft prompt without saving to DB
    // Mode A — generate
    url?: string;
    pdf_url?: string;
    context?: string;
    cookie?: string;
    page_text?: string;
    curriculum_hint?: string;    // parsed title signal — included as a description input
  };

  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { auth_user_id, url, pdf_url, context, cookie, page_text, curriculum_hint, pdf_vision_override, system_instruction_override } = body;

  // ── Ownership validation ────────────────────────────────────────────────────
  if (!auth_user_id) return err("Unauthorized", 401);
  const { data: teacher, error: teacherErr } = await sbAdmin
    .from("teachers")
    .select("is_admin")
    .eq("auth_user_id", auth_user_id)
    .single();
  if (teacherErr || !teacher?.is_admin) return err("Admin access required", 403);

  // ── Fetch system instruction ────────────────────────────────────────────────
  // Stored in the prompts table for editing without a code deploy.
  // Hard fail if missing — a description generated without the system instruction
  // would be unreliable and should not silently succeed.
  const { data: promptRow, error: promptErr } = await sbAdmin
    .from("prompts")
    .select("prompt_text")
    .eq("prompt_key", "supplement_description_system")
    .single();
  if (promptErr || !promptRow?.prompt_text) {
    return err("System prompt not found — add prompt_key supplement_description_system to the prompts table", 500);
  }
  const systemInstruction = (system_instruction_override?.trim())
    ? system_instruction_override.trim()
    : promptRow.prompt_text;

  // ── Assemble signals ────────────────────────────────────────────────────────
  // Signal priority (highest to lowest specificity):
  //   1. curriculum_hint  — parsed title signal (e.g. "Level 1B Spring Solo")
  //   2. page_text        — scraped HTML text passed in body, or fetched from url
  //   3. PDF              — text extraction + vision both attempted when available
  //   4. SME context      — optional human notes

  const textParts: string[] = [];
  let pdfVisionPart: GeminiPart | null = null;
  let pdfSkipped = false;

  // 1. Curriculum hint — most specific signal, listed first
  if (curriculum_hint?.trim()) {
    textParts.push(`Supplement title/level: ${curriculum_hint.trim()}`);
  }

  // 2. Page text — use what scrape-supplement already extracted if available,
  //    otherwise fetch the page now (rerun against a promoted supplement, or
  //    called standalone without a prior scrape).
  //    While fetching the page, also scan for a PDF link if none was passed
  //    in the body — enables full-quality reruns without stored raw material.
  let resolvedPdfUrl: string | undefined = pdf_url;

  if (page_text) {
    textParts.push(`Page content:\n${page_text}`);
  } else if (url) {
    try {
      const fetchHeaders: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (compatible; CreativeNote/1.0)",
        "Accept": "text/html",
      };
      if (cookie) fetchHeaders["Cookie"] = buildCookieHeader(cookie);
      const res = await fetch(url, { headers: fetchHeaders, redirect: "follow" });
      const html = await res.text();
      if (!isGated(html)) {
        const text = html
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim()
          .slice(0, 3000);
        if (text) textParts.push(`Page content:\n${text}`);

        // Scan for PDF link if none was passed in the body
        if (!resolvedPdfUrl) {
          const found = extractPdfUrl(html, url);
          if (found) resolvedPdfUrl = found;
        }
      }
    } catch {
      // Non-fatal — continue with whatever other signals are available
    }
  }

  // 3. PDF — fetch and process using resolvedPdfUrl (passed in body or found
  //    on the page). Both text extraction and vision are attempted. Gemini
  //    synthesizes from all available material.
  if (resolvedPdfUrl) {
    const { pdfText, visionPart, skipped } = await fetchAndProcessPdf(
      resolvedPdfUrl,
      cookie,
      pdf_vision_override ?? false,
    );
    if (pdfText) textParts.push(`PDF content:\n${pdfText}`);
    if (visionPart) pdfVisionPart = visionPart;
    if (skipped) pdfSkipped = true;
  }

  // 4. SME context
  if (context?.trim()) {
    textParts.push(`Curriculum notes from music educator:\n${context.trim()}`);
  }

  if (!textParts.length && !pdfVisionPart) {
    return err("No content available to generate a description. Provide a URL, PDF URL, or context.");
  }

  // ── Call Gemini ───────────────────────────────────────────────────────────
  // Multimodal when vision data is available; text-only otherwise.
  // User turn is assembled signals only — task definition is in the system instruction.
  try {
    let description: string;

    if (pdfVisionPart) {
      // Multimodal call: assembled text signals + PDF as inline_data
      const geminiParts: GeminiPart[] = [
        ...(textParts.length ? [{ text: textParts.join("\n\n") }] : []),
        pdfVisionPart,
      ];
      description = await callGeminiMultimodal(geminiParts, systemInstruction);
    } else {
      // Text-only call
      description = await callGeminiText(textParts.join("\n\n"), systemInstruction);
    }

    // Return description plus optional pdf_skipped flag
    return ok({ description, ...(pdfSkipped ? { pdf_skipped: true } : {}) });
  } catch (e) {
    return err(`Gemini error: ${(e as Error).message}`, 502);
  }
});
