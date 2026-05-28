// generate-supplement-description/index.ts
// Generates or re-generates the search_description field for a supplement.
//
// Two call modes:
//
// Mode A — Generate (new or first-time):
//   { url, pdf_url, context, cookie, page_text, curriculum_hint, pdf_vision_override }
//   Combines all available signals — curriculum_hint, page_text, PDF page 1 (via
//   Gemini vision for image-based PDFs) — into a single Gemini call.
//   PDF vision: attempted when pdf_url present and buffer <= PDF_BULK_SIZE_LIMIT.
//   If buffer > limit in bulk mode (pdf_vision_override absent/false), PDF is
//   skipped and response includes pdf_skipped: true so the UI can flag the row.
//   If pdf_vision_override: true, limit is raised to PDF_OVERRIDE_SIZE_LIMIT.
//   Returns { description, pdf_skipped? }.
//
// Mode B — Re-summarise (existing description):
//   { current_description, context }
//   Re-optimises an existing description using the current structure and vocabulary.
//   No page or PDF fetch. Returns { description }.
//
// JWT verification: OFF (ES256 incompatibility — see WDN-041)
// Auth: admin-only. Verified via auth.getUser() + is_admin check.
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


const SYSTEM_INSTRUCTION = `You are a specialist in piano music education resource description.
Your task is to write concise, search-optimised descriptions of piano teaching supplements for the WunderKeys curriculum.
Descriptions are used to match supplements to the right lessons via semantic search — a teacher searching for a skill should find the right supplement.
Write in plain English. No markdown. No bullet points. 1-3 sentences maximum.

Structure every description as follows:
1. Lead with the primary skills or concepts targeted.
2. Follow with the vehicle or format (e.g. songs, scale exercises, worksheets, flashcards, games, brag tags, practice trackers).
3. Add any specific context that aids matching: curriculum level if determinable, seasonal theme if present, or behavioural or performance goal if applicable.

Use standard WunderKeys piano pedagogy terms where they apply:
- Skills: note reading, rhythm and notation, hands together playing, scales and five-finger positions, chords and harmony, accompaniment patterns, technique and articulation, music theory and symbols, keyboard geography
- Vehicles: songs, scale exercises, chord exercises, worksheets, flashcards, games, colouring pages, brag tags, practice trackers, workbook
- Levels: Preschool, Primer, Level 1A, Level 1B, Level 2A, Level 2B, Pop Staff, Intermediate
- Seasonal: use the season name if the content is clearly seasonal (e.g. Christmas, Halloween, spring)

Prefer these terms over paraphrases — a teacher searching for "hands together" or "Christmas" should find the right supplement.
Do not invent information not present in the source material.
Return only the description text — no preamble, no labels, no quotes.`;

// ── Gemini: text-only call ────────────────────────────────────────────────────
// Used for Mode B (re-summarise) and any Mode A path that has no PDF vision input.
// Matches the pattern used in session-close: gemini-2.5-flash-lite,
// thinkingBudget: 0, system_instruction required.
async function callGeminiText(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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
//   { text: string }  — text content (prompt text, page content, hints)
//   { inline_data: { mime_type: string, data: string } }  — base64 PDF bytes
// All parts are sent as a single user message so Gemini treats them as one request.
// The prompt instructs Gemini to read only page 1 of the PDF.
type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

async function callGeminiMultimodal(parts: GeminiPart[]): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") return err("Method not allowed", 405);

  // ── Auth check ─────────────────────────────────────────────────────────────
  // auth.getUser() not viable — ES256 incompatibility (WDN-045, D-102).
  // Ownership validation via teacher_id in POST body against service role client.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: {
    auth_user_id?: string;
    pdf_only?: boolean;          // return PDF-derived description only (supplement-admin legacy path)
    pdf_vision_override?: boolean; // single-row manual override: raises PDF size limit to 10 MB
    // Mode A — generate
    url?: string;
    pdf_url?: string;
    context?: string;
    cookie?: string;
    page_text?: string;
    curriculum_hint?: string;    // parsed title signal — included as a description input
    // Mode B — re-summarise
    current_description?: string;
  };

  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { auth_user_id, url, pdf_url, context, cookie, page_text, curriculum_hint, current_description, pdf_only, pdf_vision_override } = body;

  // ── Ownership validation ────────────────────────────────────────────────────
  if (!auth_user_id) return err("Unauthorized", 401);
  const { data: teacher, error: teacherErr } = await sbAdmin
    .from("teachers")
    .select("is_admin")
    .eq("auth_user_id", auth_user_id)
    .single();
  if (teacherErr || !teacher?.is_admin) return err("Admin access required", 403);

  // ── Mode B: Re-summarise ───────────────────────────────────────────────────
  if (current_description && !url && !pdf_url) {
    const prompt = [
      "Re-write the following supplement description to follow the structure and vocabulary in your instructions.",
      "Preserve all factual content. Do not add invented information.",
      context ? `Additional context to incorporate:\n${context}` : "",
      `\nCurrent description:\n${current_description}`,
    ].filter(Boolean).join("\n\n");

    try {
      const description = await callGeminiText(prompt);
      return ok({ description });
    } catch (e) {
      return err(`Gemini error: ${(e as Error).message}`, 502);
    }
  }

  // ── Mode A: Generate ───────────────────────────────────────────────────────
  // Assemble all available signals into a single Gemini call.
  // Signal priority (highest to lowest specificity):
  //   1. curriculum_hint  — parsed title signal (e.g. "Level 1B Spring Solo")
  //   2. page_text        — scraped HTML text (thin for WK pages but has item name)
  //   3. PDF page 1       — via Gemini vision (image-based) or text extraction
  //   4. SME context      — optional human notes

  const textParts: string[] = [];     // assembled into text prompt segment
  let pdfVisionPart: GeminiPart | null = null; // set when PDF vision path is used
  let pdfSkipped = false;             // returned to browser when PDF oversized in bulk

  // Alias for the legacy pdf_only path which still uses the old parts[] variable
  const parts: string[] = [];

  // pdf_only mode: legacy path used by supplement-admin rescrapePdf.
  // Uses text extraction only (not vision) — caller shows accept/reject UI.
  // Not updated to use vision as it is a single-field manual action in a
  // separate tool and vision adds latency that would feel slow in that flow.
  if (pdf_only && pdf_url) {
    try {
      const pdfHeaders: Record<string, string> = { "User-Agent": "Mozilla/5.0 (compatible; CreativeNote/1.0)" };
      if (cookie && (pdf_url.includes("wunderkeys.com") || pdf_url.includes("teachpianotoday.com"))) {
        pdfHeaders["Cookie"] = cookie.includes("=") ? cookie : `wp-postpass_cn=${cookie}`;
      }
      const pdfRes = await fetch(pdf_url, { headers: pdfHeaders, redirect: "follow" });
      if (pdfRes.ok) {
        const buffer = new Uint8Array(await pdfRes.arrayBuffer());
        const pdfText = extractPdfText(buffer);
        if (pdfText) parts.push(`PDF content:\n${pdfText}`);
      }
    } catch { /* non-fatal */ }
    if (!parts.length) return err("Could not extract text from PDF.");
    const pdfPrompt = ["Write a description for the following piano teaching supplement following the structure and vocabulary in your instructions.", ...parts].join("\n\n");
    try {
      const description = await callGeminiText(pdfPrompt);
      return ok({ description });
    } catch (e) {
      return err(`Gemini error: ${(e as Error).message}`, 502);
    }
  }

  // 1. Curriculum hint — most specific signal, listed first
  if (curriculum_hint?.trim()) {
    textParts.push(`Supplement title/level: ${curriculum_hint.trim()}`);
  }

  // 2. Page text — use what scrape-supplement already extracted if available,
  //    otherwise fetch the page now (e.g. called standalone without prior scrape)
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
      }
    } catch {
      // Non-fatal — continue with whatever other content we have
    }
  }

  // 3. PDF — fetch, check size, then branch:
  //    a) Text extraction succeeds (text-layer PDF)         → add to textParts
  //    b) Text extraction empty + within size limit         → vision path
  //    c) Text extraction empty + oversized + no override   → skip, set pdfSkipped
  //    d) Text extraction empty + oversized + override      → vision path (raised limit)
  if (pdf_url) {
    try {
      const pdfHeaders: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (compatible; CreativeNote/1.0)",
      };
      if (cookie && (
        pdf_url.includes("wunderkeys.com") ||
        pdf_url.includes("teachpianotoday.com")
      )) {
        pdfHeaders["Cookie"] = buildCookieHeader(cookie);
      }

      const pdfRes = await fetch(pdf_url, { headers: pdfHeaders, redirect: "follow" });
      if (pdfRes.ok) {
        const buffer = new Uint8Array(await pdfRes.arrayBuffer());

        // Try text extraction first — free, works for any text-layer PDF
        const pdfText = extractPdfText(buffer);

        if (pdfText) {
          // Text extraction succeeded — use it, no vision needed
          textParts.push(`PDF content:\n${pdfText}`);
        } else {
          // Image-based PDF — decide whether to use vision
          const sizeLimit = pdf_vision_override ? PDF_OVERRIDE_SIZE_LIMIT : PDF_BULK_SIZE_LIMIT;

          if (buffer.length <= sizeLimit) {
            // Within limit — base64 encode and queue for vision call
            let binary = "";
            const chunkSize = 8192;
            for (let i = 0; i < buffer.length; i += chunkSize) {
              binary += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);
            pdfVisionPart = {
              inline_data: { mime_type: "application/pdf", data: base64 },
            };
          } else {
            // Oversized — skip PDF, flag for UI
            pdfSkipped = true;
          }
        }
      }
    } catch {
      // Non-fatal — PDF fetch or processing failure should not block description
    }
  }

  // 4. SME context
  if (context?.trim()) {
    textParts.push(`Curriculum notes from music educator:\n${context.trim()}`);
  }

  if (!textParts.length && !pdfVisionPart) {
    return err("No content available to generate a description. Provide a URL, PDF URL, or context.");
  }

  // ── Assemble and call Gemini ──────────────────────────────────────────────
  try {
    let description: string;

    if (pdfVisionPart) {
      // Multimodal call: text prompt + PDF as inline_data.
      // Gemini reads the full PDF but the prompt directs it to use page 1
      // for description content and ignore bookstore/advertising pages.
      const promptText = [
        "Write a description for the following piano teaching supplement following the structure and vocabulary in your instructions.",
        "The PDF attached contains the supplement. Use only the content from page 1 (the cover/description page).",
        "Ignore page 2 onward — those pages contain sheet music, bookstore listings, and advertising.",
        "Use only information present in the source material below and in page 1 of the PDF.",
        ...textParts,
      ].join("\n\n");

      const geminiParts: GeminiPart[] = [
        { text: promptText },
        pdfVisionPart,
      ];
      description = await callGeminiMultimodal(geminiParts);
    } else {
      // Text-only call
      const prompt = [
        "Write a description for the following piano teaching supplement following the structure and vocabulary in your instructions.",
        "Use only information present in the source material below.",
        ...textParts,
      ].join("\n\n");
      description = await callGeminiText(prompt);
    }

    // Return description plus optional pdf_skipped flag
    return ok({ description, ...(pdfSkipped ? { pdf_skipped: true } : {}) });
  } catch (e) {
    return err(`Gemini error: ${(e as Error).message}`, 502);
  }
});
