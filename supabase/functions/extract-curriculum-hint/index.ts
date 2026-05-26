// extract-curriculum-hint/index.ts
// Extracts a structured curriculum placement signal from a supplement record.
// Uses the supplement title and search description as input — both are small,
// making this a cheap, focused call (no PDF fetch, no page scrape).
//
// Input:  { auth_user_id, title, description }
// Output: { curriculum_hint: string | null }
//
// curriculum_hint format — one of these exactly, or null:
//   "Primer"             — primer level, no specific unit
//   "Primer N Unit N"    — e.g. Primer 1 Unit 3
//   "Level NA"           — e.g. Level 1B, Level 2A
//   "VU Level X"         — e.g. VU Level A, VU Level Q
//   "Intermediate"       — intermediate level, no specific number
//   "Intermediate Level N" — e.g. Intermediate Level 1
//   null                 — no curriculum signal present
//
// JWT verification: OFF (ES256 incompatibility — see WDN-041)
// Auth: admin-only. Verified via auth_user_id + is_admin check.
// Secrets required: GEMINI_API_KEY

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

const SYSTEM_INSTRUCTION = `You are extracting a curriculum placement signal from a piano teaching supplement.
Your task is to identify what level or unit of the WunderKeys curriculum this supplement targets.
Return a JSON object with one field: curriculum_hint.
The value must be one of these formats exactly, or null:
  "Primer"               — primer level, no specific unit identified
  "Primer N Unit N"      — e.g. "Primer 1 Unit 3"
  "Level NA"             — e.g. "Level 1B" or "Level 2A" (number + optional letter)
  "VU Level X"           — e.g. "VU Level A" or "VU Level Q" (single letter A-Y)
  "Intermediate"         — intermediate level, no specific number identified
  "Intermediate Level N" — e.g. "Intermediate Level 1"
  null                   — no clear curriculum placement signal is present
Return only valid JSON. No explanation, no markdown, no preamble.
Example valid responses:
  {"curriculum_hint":"Level 1B"}
  {"curriculum_hint":"VU Level A"}
  {"curriculum_hint":null}`;

async function callGemini(title: string, description: string): Promise<string | null> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const userPrompt = [
    `Supplement title: ${title || "(no title)"}`,
    description ? `Search description: ${description}` : "",
  ].filter(Boolean).join("\n");

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 60,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
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
  const raw = data?.candidates?.[0]?.content?.parts
    ?.filter((p: { text?: string }) => p.text)
    ?.map((p: { text: string }) => p.text)
    ?.join("") ?? "";

  if (!raw) throw new Error("Gemini returned empty response");

  // Parse JSON response
  const parsed = JSON.parse(raw.trim());
  const hint = parsed?.curriculum_hint ?? null;

  // Validate — must be a non-empty string or null
  if (hint !== null && typeof hint !== "string") return null;
  if (typeof hint === "string" && !hint.trim()) return null;
  return hint;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return err("Method not allowed", 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  let body: { auth_user_id?: string; title?: string; description?: string };
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { auth_user_id, title, description } = body;

  if (!auth_user_id) return err("Unauthorized", 401);
  const { data: teacher, error: teacherErr } = await sbAdmin
    .from("teachers")
    .select("is_admin")
    .eq("auth_user_id", auth_user_id)
    .single();
  if (teacherErr || !teacher?.is_admin) return err("Admin access required", 403);

  if (!title && !description) return err("title or description is required");

  try {
    const curriculum_hint = await callGemini(title || "", description || "");
    return ok({ curriculum_hint });
  } catch (e) {
    return err(`Gemini error: ${(e as Error).message}`, 502);
  }
});
