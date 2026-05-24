// generate-supplement-description/index.ts
// Generates or re-generates the search_description field for a supplement.
//
// Two call modes:
//
// Mode A — Generate (new or first-time):
//   { url, pdf_url, context, cookie }
//   Fetches the PDF if pdf_url provided, combines with page_text (if supplied)
//   and SME context, calls Gemini, returns { description }.
//
// Mode B — Re-summarise (existing description):
//   { current_description, context }
//   Re-optimises an existing description for searchability.
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

// ── Gemini call ───────────────────────────────────────────────────────────────
// Matches the pattern used in session-close: gemini-2.5-flash-lite,
// thinkingBudget: 0 (description generation does not benefit from thinking),
// system_instruction required on all calls.
async function callGemini(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: {
      parts: [{
        text: `You are a specialist in music education resource description.
Your task is to write concise, search-optimised descriptions of piano teaching supplements.
Descriptions are used internally to help match supplements to the right lessons.
Write in plain English. No markdown. No bullet points. 2-4 sentences maximum.
Focus on: what skill or concept the supplement targets, what format it is (worksheet, game, printable, workbook), and what type of student or lesson it suits.
Do not invent information not present in the source material.
Return only the description text — no preamble, no labels, no quotes.`
      }]
    },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
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
  const authHeader = req.headers.get("authorization") || "";
  const apiKey = req.headers.get("apikey") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const callerToken = authHeader.replace("Bearer ", "").trim() || apiKey;
  const sbAnon = createClient(supabaseUrl, callerToken);
  const { data: { user }, error: userErr } = await sbAnon.auth.getUser();
  if (userErr || !user) return err("Unauthorized", 401);

  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);
  const { data: teacher, error: teacherErr } = await sbAdmin
    .from("teachers")
    .select("is_admin")
    .eq("auth_user_id", user.id)
    .single();
  if (teacherErr || !teacher?.is_admin) return err("Admin access required", 403);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: {
    // Mode A — generate
    url?: string;
    pdf_url?: string;
    context?: string;
    cookie?: string;
    page_text?: string;  // optional — scrape-supplement already extracted this
    // Mode B — re-summarise
    current_description?: string;
  };

  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { url, pdf_url, context, cookie, page_text, current_description } = body;

  // ── Mode B: Re-summarise ───────────────────────────────────────────────────
  if (current_description && !url && !pdf_url) {
    const prompt = [
      "Re-write the following supplement description to be more concise and search-optimised.",
      "Preserve all factual content. Do not add invented information.",
      context ? `Additional context to incorporate:\n${context}` : "",
      `\nCurrent description:\n${current_description}`,
    ].filter(Boolean).join("\n\n");

    try {
      const description = await callGemini(prompt);
      return ok({ description });
    } catch (e) {
      return err(`Gemini error: ${(e as Error).message}`, 502);
    }
  }

  // ── Mode A: Generate ───────────────────────────────────────────────────────
  // Assemble content from: page_text (already extracted) + PDF + SME context

  const parts: string[] = [];

  // 1. Page text — use what scrape-supplement already extracted if available,
  //    otherwise fetch the page now (e.g. called standalone without prior scrape)
  if (page_text) {
    parts.push(`Page content:\n${page_text}`);
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
        if (text) parts.push(`Page content:\n${text}`);
      }
    } catch {
      // Non-fatal — continue with whatever other content we have
    }
  }

  // 2. PDF text
  if (pdf_url) {
    try {
      const pdfHeaders: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (compatible; CreativeNote/1.0)",
      };
      // Apply cookie only if PDF is on a gated domain
      if (cookie && (
        pdf_url.includes("wunderkeys.com") ||
        pdf_url.includes("teachpianotoday.com")
      )) {
        pdfHeaders["Cookie"] = buildCookieHeader(cookie);
      }

      const pdfRes = await fetch(pdf_url, { headers: pdfHeaders, redirect: "follow" });
      if (pdfRes.ok) {
        const buffer = new Uint8Array(await pdfRes.arrayBuffer());
        const pdfText = extractPdfText(buffer);
        if (pdfText) parts.push(`PDF content:\n${pdfText}`);
      }
    } catch {
      // Non-fatal — PDF extraction failure should not block description generation
    }
  }

  // 3. SME context
  if (context?.trim()) {
    parts.push(`Curriculum notes from music educator:\n${context.trim()}`);
  }

  if (!parts.length) {
    return err("No content available to generate a description. Provide a URL, PDF URL, or context.");
  }

  const prompt = [
    "Write a search-optimised description for the following piano teaching supplement.",
    "Use only information present in the source material below.",
    ...parts,
  ].join("\n\n");

  try {
    const description = await callGemini(prompt);
    return ok({ description });
  } catch (e) {
    return err(`Gemini error: ${(e as Error).message}`, 502);
  }
});
