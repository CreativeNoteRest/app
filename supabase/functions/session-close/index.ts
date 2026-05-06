// session-close Edge Function
// Creative Note -- Session Close Flow
// Spec reference: Session_Close_Flow_Spec_v1_1.txt
//
// Responsibilities:
//   - Receive POST from session_close.html with session context
//   - Fetch all required data from Supabase in parallel
//   - Run JavaScript supplement ranking logic
//   - Execute five sequential Gemini AI calls (Phases 1-5)
//   - Return structured response to browser
//   - Read-only: makes no database writes
//
// All database writes occur in the browser on teacher approval only.
//
// Debug modes (admin/prompts.html only -- never sent by session_close.html):
//   dry_run: true         -- assemble all five prompts, skip Gemini, return assembled strings
//   single_phase_run: true -- call Gemini once with a provided assembled_prompt, return raw response

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestBody {
  session_id: string;
  teacher_id: string;
  student_id: string;
  series_id: string;
  lesson_book_id: string;
  student_name: string;
  bypass_gate: boolean;
  // Debug flags -- optional, absent on all production calls
  dry_run?: boolean;
  single_phase_run?: boolean;
  phase?: number;
  assembled_prompt?: string;
  model_override?: string;   // single_phase_run only -- overrides default Gemini model
  thinking_budget?: number;  // single_phase_run only -- overrides per-phase thinkingBudget
}

interface SupplementCandidate {
  supplement_id: string;
  title: string;
  source_url: string;
  is_free: boolean | null;
  thumbnail_url: string | null;
  pool: string;
  match_context: string;
  tags: string[];
  rank_score?: number;
}

interface SelectedSupplement {
  supplement_id: string;
  title: string;
  source_url: string;
  is_free: boolean | null;
  thumbnail_url: string | null;
  pool: string;
  rationale: string;
}

interface Phase1Result {
  max_lesson_page: number | null;
  detected_contexts: string[];
  lesson_signals: string[];
  behavioural_signals: string[];
  event_signals: string[];
  book_transition_suspected: boolean;
}

interface Phase2Result {
  satisfied: boolean;
  missing_items: string[];
}

interface Phase3Result {
  ai_summ_supplement: string;
  selected_supplements: SelectedSupplement[];
}

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// Valid model strings accepted by model_override in single_phase_run mode.
// Production path always uses GEMINI_MODEL -- this list is for debug use only.
const ALLOWED_MODEL_OVERRIDES = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro"
];

async function callGemini(
  apiKey: string,
  prompt: string,
  expectJson: boolean,
  maxOutputTokens: number = 2000,
  thinkingBudget: number = 0,
  model: string = GEMINI_MODEL
): Promise<string> {
  const endpoint = `${GEMINI_BASE_URL}/${model}:generateContent`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      thinkingConfig: { thinkingBudget },
      maxOutputTokens
    }
  };

  const fetchGemini = async (promptText: string): Promise<string> => {
    const response = await fetch(`${endpoint}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        contents: [{ role: "user", parts: [{ text: promptText }] }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty response");
    return text;
  };

  const stripFences = (text: string): string =>
    text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  const rawText = await fetchGemini(prompt);

  if (!expectJson) return rawText;

  try {
    const cleaned = stripFences(rawText);
    JSON.parse(cleaned);
    return cleaned;
  } catch (_e) {
    const retryPrompt =
      prompt +
      "\n\nCRITICAL: Your previous response could not be parsed as JSON. " +
      "Return only a raw JSON object. No markdown, no code fences, no explanation. " +
      "Start your response with { and end with }";
    const retryText = await fetchGemini(retryPrompt);
    const retryCleaned = stripFences(retryText);
    try {
      JSON.parse(retryCleaned);
      return retryCleaned;
    } catch (_e2) {
      throw new Error(
        "Gemini returned invalid JSON on both attempts. Raw response: " +
          retryCleaned.substring(0, 200)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt variable substitution
// ---------------------------------------------------------------------------

function fillPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (vars[key] !== undefined && vars[key] !== null && vars[key] !== "") {
      return vars[key];
    }
    const fallbacks: Record<string, string> = {
      lesson_page: "not recorded",
      prior_unit_title: "not available",
      prior_unit_skills: "not available",
      active_supplements: "",
      lesson_signals: "none recorded",
      supplement_candidates: "none available",
      student_age: "not recorded"
    };
    return fallbacks[key] ?? `[${key} not available]`;
  });
}

// ---------------------------------------------------------------------------
// Supplement ranking logic
// ---------------------------------------------------------------------------

function rankSupplements(
  candidates: SupplementCandidate[],
  maxLessonPage: number | null,
  prevLessonPage: number | null,
  lessonSignals: string[],
  unitTags: string[]
): SupplementCandidate[] {
  const filtered = candidates.filter((c) => {
    if (c.pool === "current_book") {
      if (maxLessonPage === null) return true;
      const pageStart = (c as any).page_start;
      if (pageStart === undefined || pageStart === null) return true;
      return pageStart <= maxLessonPage;
    }
    return true;
  });

  const pageSpan =
    maxLessonPage !== null && prevLessonPage !== null
      ? maxLessonPage - prevLessonPage
      : null;

  const scored = filtered.map((c) => {
    const pageStart = (c as any).page_start ?? null;
    const tags = c.tags ?? [];
    const lessonTagMatch = tags.filter((t) => lessonSignals.includes(t)).length;
    const unitTagMatch = tags.filter((t) => unitTags.includes(t)).length;

    let score = 0;
    if (c.pool === "current_book") {
      if (
        pageSpan !== null &&
        pageStart !== null &&
        prevLessonPage !== null &&
        pageStart >= prevLessonPage &&
        pageStart <= (maxLessonPage ?? 0)
      ) {
        score = 7;
      } else if (lessonTagMatch > 0) {
        score = 6;
      } else if (unitTagMatch > 0) {
        score = 5;
      } else {
        score = 4;
      }
    } else {
      if (lessonTagMatch > 0) score = 3;
      else if (unitTagMatch > 0) score = 2;
      else score = 1;
    }

    return { ...c, rank_score: score, _tagMatchCount: lessonTagMatch + unitTagMatch };
  });

  const contexts = [...new Set(scored.map((c) => c.match_context))].filter(
    (ctx) => ctx !== "studio_admin"
  );

  const sorted = scored.sort((a, b) => {
    if (b.rank_score !== a.rank_score) return (b.rank_score ?? 0) - (a.rank_score ?? 0);
    return ((b as any)._tagMatchCount ?? 0) - ((a as any)._tagMatchCount ?? 0);
  });

  const guaranteed: SupplementCandidate[] = [];
  const usedIds = new Set<string>();
  for (const ctx of contexts) {
    const topForCtx = sorted.find(
      (c) => c.match_context === ctx && !usedIds.has(c.supplement_id)
    );
    if (topForCtx) {
      guaranteed.push(topForCtx);
      usedIds.add(topForCtx.supplement_id);
    }
  }

  const remainder = sorted.filter((c) => !usedIds.has(c.supplement_id));
  return [...guaranteed, ...remainder].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatEntries(entries: { entry_text: string; entry_sequence: number }[]): string {
  return entries.map((e) => `[${e.entry_sequence}] ${e.entry_text}`).join("\n");
}

// ---------------------------------------------------------------------------
// formatPieceBlock
// Shared formatter used by both Phase 4 (piece_context) and Phase 5
// (student_instructions). Produces a structured, indented block that anchors
// every instruction unambiguously to its piece and unit.
//
// Scope: current unit -3 through current unit +1, existence-checked.
// Null fallback: full book (when max_lesson_page could not be resolved and
// currentUnitLabel is empty or unit cannot be found in the sorted list).
// ---------------------------------------------------------------------------

function formatPieceBlock(
  pieces: any[],
  units: any[],
  currentUnitLabel: string
): string {
  const sorted = [...units].sort((a, b) => a.unit_sort_order - b.unit_sort_order);

  const currentIndex = sorted.findIndex((u) => u.unit_label === currentUnitLabel);

  const windowUnits =
    currentIndex === -1
      ? sorted
      : sorted.slice(
          Math.max(0, currentIndex - 3),
          currentIndex + 2
        );

  const windowLabels = new Set(windowUnits.map((u) => u.unit_label));
  const windowPieces = pieces.filter((p) => windowLabels.has(p.unit_label));

  if (windowPieces.length === 0) return "No piece data available for this session.";

  const blocks: string[] = [];
  for (const unit of windowUnits) {
    const unitPieces = windowPieces.filter((p) => p.unit_label === unit.unit_label);
    if (unitPieces.length === 0) continue;

    const isCurrent = unit.unit_label === currentUnitLabel;
    const unitHeader = `-- ${unit.unit_title ?? unit.unit_label}${isCurrent ? " (current)" : ""} --`;
    const pieceLines: string[] = [];

    for (const p of unitPieces) {
      const pageRef = p.page_end && p.page_end !== p.page_start
        ? `p. ${p.page_start}-${p.page_end}`
        : `p. ${p.page_start}`;
      const typeLabel = p.piece_type ? `, ${p.piece_type}` : "";
      const pieceHeader = `  ${p.piece_title} (${pageRef}${typeLabel})`;

      const instructionLines =
        Array.isArray(p.student_instructions) && p.student_instructions.length > 0
          ? p.student_instructions.map((inst: string) => `    ${inst}`).join("\n")
          : "    (no instructions on file)";

      pieceLines.push(`${pieceHeader}\n${instructionLines}`);
    }

    blocks.push(`${unitHeader}\n\n${pieceLines.join("\n\n")}`);
  }

  return blocks.join("\n\n");
}

function formatSupplementCandidates(candidates: SupplementCandidate[]): string {
  return candidates
    .map((c, i) => {
      const freeLabel =
        c.is_free === true ? "[FREE]" : c.is_free === false ? "[PAID]" : "[FREE STATUS UNKNOWN]";
      return `${i + 1}. ${c.title} ${freeLabel} | Pool: ${c.pool} | Score: ${c.rank_score} | URL: ${c.source_url}`;
    })
    .join("\n");
}

function formatActiveSupplements(assignments: { title: string }[]): string {
  if (!assignments || assignments.length === 0) return "";
  return assignments.map((a) => `- ${a.title}`).join("\n");
}

function resolveCurrentUnit(
  units: any[],
  pieces: any[],
  maxLessonPage: number | null
): { currentUnit: any; priorUnit: any | null } {
  if (maxLessonPage === null) {
    return { currentUnit: units[0] ?? null, priorUnit: null };
  }

  const sorted = [...units].sort((a, b) => a.unit_sort_order - b.unit_sort_order);
  let currentUnit = sorted[0];
  for (const unit of sorted) {
    const unitPieces = pieces.filter((p) => p.unit_label === unit.unit_label);
    if (maxLessonPage >= (unitPieces[0]?.page_start ?? 0)) {
      currentUnit = unit;
    }
  }

  const currentIndex = sorted.findIndex((u) => u.unit_label === currentUnit.unit_label);
  const priorUnit = currentIndex > 0 ? sorted[currentIndex - 1] : null;
  return { currentUnit, priorUnit };
}

// ---------------------------------------------------------------------------
// Build gate message
// ---------------------------------------------------------------------------

function buildGateMessage(studentName: string, missingItems: string[]): string {
  const missingList = missingItems.map((item) => `- ${item}`).join("\n");
  return (
    `The notes for ${studentName}'s lesson appear to be missing some information:\n` +
    missingList +
    `\n\nClose Lesson is an end-of-lesson action. If the lesson is still in progress, ` +
    `continue adding notes and close when the lesson is done.\n\n` +
    `When you are ready, keep adding notes and close at the end of the lesson. ` +
    `You can also close anyway if you need to -- reopen is available the same day.`
  );
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  // -------------------------------------------------------------------------
  // Step 1: Parse and validate request body
  // -------------------------------------------------------------------------
  let body: RequestBody;
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({ success: false, error: "Invalid JSON in request body" }, 400);
  }

  // -------------------------------------------------------------------------
  // Debug mode: single_phase_run
  // Call Gemini once with the provided assembled_prompt and return raw response.
  // Data fetches and prompt assembly are skipped entirely -- the browser
  // supplies the already-assembled prompt string from a prior dry_run call.
  //
  // Accepts optional overrides (debug use only):
  //   model_override    -- one of ALLOWED_MODEL_OVERRIDES; falls back to GEMINI_MODEL
  //   thinking_budget   -- integer >= 0; falls back to per-phase default if absent
  // -------------------------------------------------------------------------
  if (body.single_phase_run === true) {
    if (!body.assembled_prompt) {
      return jsonResponse({ success: false, error: "single_phase_run requires assembled_prompt" }, 400);
    }

    const geminiKeyDebug = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKeyDebug) {
      return jsonResponse({ success: false, error: "Missing GEMINI_API_KEY" }, 500);
    }

    // Phase 1, 2, 3 expect JSON; 4 and 5 expect plain text.
    const phaseNum = body.phase ?? 0;
    const expectJson = phaseNum >= 1 && phaseNum <= 3;
    const maxTokens = phaseNum >= 4 ? 5000 : phaseNum === 3 ? 2000 : phaseNum === 1 ? 1000 : 500;
    const defaultThinking = phaseNum >= 4 ? 1024 : 0;

    // Resolve model override -- validate against allowlist, fall back to default.
    const modelOverride =
      body.model_override && ALLOWED_MODEL_OVERRIDES.includes(body.model_override)
        ? body.model_override
        : GEMINI_MODEL;

    // Resolve thinking budget -- use supplied value if a non-negative integer,
    // otherwise fall back to the per-phase default.
    const thinkingOverride =
      typeof body.thinking_budget === "number" && body.thinking_budget >= 0
        ? body.thinking_budget
        : defaultThinking;

    try {
      const aiResponse = await callGemini(
        geminiKeyDebug,
        body.assembled_prompt,
        expectJson,
        maxTokens,
        thinkingOverride,
        modelOverride
      );
      return jsonResponse({
        success: true,
        ai_response: aiResponse,
        model_used: modelOverride,
        thinking_budget_used: thinkingOverride
      });
    } catch (err: any) {
      return jsonResponse({ success: false, error: `Gemini call failed: ${err.message}` }, 500);
    }
  }

  // -------------------------------------------------------------------------
  // Standard path: validate required fields
  // -------------------------------------------------------------------------
  const required = ["session_id", "teacher_id", "student_id", "series_id", "lesson_book_id", "student_name"];
  for (const field of required) {
    if (!body[field as keyof RequestBody]) {
      return jsonResponse({ success: false, error: `Missing required field: ${field}` }, 400);
    }
  }

  const bypassGate = body.bypass_gate === true;
  const dryRun = body.dry_run === true;

  // -------------------------------------------------------------------------
  // Step 2: Initialise Supabase client
  // -------------------------------------------------------------------------
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const geminiKey = Deno.env.get("GEMINI_API_KEY");

  if (!supabaseUrl || !supabaseKey || !geminiKey) {
    return jsonResponse({ success: false, error: "Missing required environment secrets" }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // -------------------------------------------------------------------------
  // Step 3: Fetch all data in parallel
  // -------------------------------------------------------------------------
  let fetchResults: any[];
  try {
    fetchResults = await Promise.all([
      // 0: Session entries
      supabase
        .from("session_entries")
        .select("entry_text, entry_sequence")
        .eq("session_id", body.session_id)
        .eq("entry_source", "teacher")
        .not("entry_text", "like", "[IGNORE]%")
        .order("entry_sequence", { ascending: true }),

      // 1: Book context
      supabase
        .from("books")
        .select("full_display_name, equivalent_books, sequence_number")
        .eq("book_id", body.lesson_book_id)
        .single(),

      // 2: Units
      supabase
        .from("books_units")
        .select("unit_label, unit_sort_order, unit_title, unit_skill_focus, unit_tags")
        .eq("book_id", body.lesson_book_id)
        .order("unit_sort_order", { ascending: true }),

      // 3: Pieces
      supabase
        .from("books_pieces")
        .select("piece_title, piece_type, page_start, page_end, student_instructions, skill_focus, page_level_tags, unit_label, unit_sort_order")
        .eq("book_id", body.lesson_book_id)
        .order("page_start", { ascending: true }),

      // 4: Previous session (for page_span)
      supabase
        .from("sessions")
        .select("max_lesson_page")
        .eq("student_id", body.student_id)
        .eq("session_status", "approved")
        .order("session_date", { ascending: false })
        .limit(1),

      // 5: Active student assignments
      supabase
        .from("student_assignments")
        .select("supplement_id, supplements(title)")
        .eq("student_id", body.student_id)
        .eq("is_active", true),

      // 6: Supplement candidates via Postgres function
      // p_session_mmdd uses today as a fallback -- sessionDate is not yet resolved
      // at this point in the parallel fetch. The refined call below (post-resolve)
      // uses the real sessionMmdd and replaces this result when equivalent_books
      // is populated. The fallback only applies for books with no equivalent_books
      // (currently Preschool Book 1 only).
      supabase.rpc("get_supplement_candidates", {
        p_book_id: body.lesson_book_id,
        p_equivalent_books: null,
        p_max_lesson_page: null,
        p_series_id: body.series_id,
        p_student_id: body.student_id,
        p_session_id: body.session_id,
        p_session_mmdd: new Date().toISOString().slice(5, 10)
      }),

      // 7: Config values
      supabase
        .from("config")
        .select("config_key, config_value")
        .eq("series_id", body.series_id)
        .in("config_key", [
          "supplement_max_display",
          "supplement_initial_display",
          "quality_gate_enabled",
          "book_transition_page_threshold",
          "active_supplement_check_after_sessions"
        ]),

      // 8: Prompts
      supabase
        .from("prompts")
        .select("prompt_key, prompt_text")
        .eq("series_id", body.series_id)
        .in("prompt_key", [
          "session_close_phase1",
          "session_close_phase2",
          "session_close_phase3",
          "session_close_phase4",
          "session_close_phase5"
        ]),

      // 9: Session date from Sessions record
      supabase
        .from("sessions")
        .select("session_date")
        .eq("session_id", body.session_id)
        .single(),

      // 10: Student birth_year
      supabase
        .from("students")
        .select("birth_year")
        .eq("student_id", body.student_id)
        .single()
    ]);
  } catch (err: any) {
    return jsonResponse({ success: false, error: `Data fetch failed: ${err.message}` }, 500);
  }

  const [
    entriesResult,
    bookResult,
    unitsResult,
    piecesResult,
    prevSessionResult,
    assignmentsResult,
    candidatesResult,
    configResult,
    promptsResult,
    sessionDateResult,
    studentResult
  ] = fetchResults;

  if (bookResult.error) {
    return jsonResponse({ success: false, error: `Book fetch failed: ${bookResult.error.message}` }, 500);
  }
  if (promptsResult.error) {
    return jsonResponse({ success: false, error: `Prompts fetch failed: ${promptsResult.error.message}` }, 500);
  }

  // -------------------------------------------------------------------------
  // Parse fetched data
  // -------------------------------------------------------------------------
  const entries: any[] = entriesResult.data ?? [];
  const book = bookResult.data;
  const units: any[] = unitsResult.data ?? [];
  const pieces: any[] = piecesResult.data ?? [];
  const prevLessonPage: number | null = prevSessionResult.data?.[0]?.max_lesson_page ?? null;
  const rawAssignments: any[] = assignmentsResult.data ?? [];
  const activeAssignments = rawAssignments.map((a) => ({
    supplement_id: a.supplement_id,
    title: a.supplements?.title ?? "Unknown supplement"
  }));
  const rawCandidates: SupplementCandidate[] = candidatesResult.data ?? [];

  const sessionDate: string =
    sessionDateResult.data?.session_date ?? new Date().toISOString().split("T")[0];

  const sessionMmdd: string = sessionDate.slice(5, 10);

  const birthYear: number | null = studentResult.data?.birth_year ?? null;
  const sessionYear = parseInt(sessionDate.substring(0, 4), 10);
  const studentAge: string | null = birthYear !== null ? String(sessionYear - birthYear) : null;

  let candidates: SupplementCandidate[] = rawCandidates;
  if (book.equivalent_books && book.equivalent_books.length > 0) {
    const { data: refinedCandidates } = await supabase.rpc("get_supplement_candidates", {
      p_book_id: body.lesson_book_id,
      p_equivalent_books: book.equivalent_books,
      p_max_lesson_page: null,
      p_series_id: body.series_id,
      p_student_id: body.student_id,
      p_session_id: body.session_id,
      p_session_mmdd: sessionMmdd
    });
    candidates = refinedCandidates ?? rawCandidates;
  }

  const configMap: Record<string, string> = {};
  for (const row of configResult.data ?? []) {
    configMap[row.config_key] = row.config_value;
  }
  const supplementMaxDisplay = parseInt(configMap["supplement_max_display"] ?? "10");
  const supplementInitialDisplay = parseInt(configMap["supplement_initial_display"] ?? "3");
  const qualityGateEnabled = (configMap["quality_gate_enabled"] ?? "true") === "true";
  const bookThreshold = parseInt(configMap["book_transition_page_threshold"] ?? "10");

  const promptMap: Record<string, string> = {};
  for (const row of promptsResult.data ?? []) {
    promptMap[row.prompt_key] = row.prompt_text;
  }

  const requiredPromptKeys = [
    "session_close_phase1",
    "session_close_phase2",
    "session_close_phase3",
    "session_close_phase4",
    "session_close_phase5"
  ];
  for (const key of requiredPromptKeys) {
    if (!promptMap[key]) {
      return jsonResponse(
        { success: false, error: `Prompt not found: ${key}. Seed the Prompts table before running session close.` },
        500
      );
    }
  }

  const entriesText =
    entries.length > 0 ? formatEntries(entries) : "No lesson notes recorded.";

  // -------------------------------------------------------------------------
  // Assemble all five prompts
  // This block runs on both the production path and dry_run path.
  // On dry_run, Gemini is never called -- assembled strings are returned directly.
  // -------------------------------------------------------------------------

  // Phase 1 prompt
  const phase1Prompt = fillPrompt(promptMap["session_close_phase1"], {
    student_name: body.student_name,
    book_name: book.full_display_name,
    entries: entriesText,
    book_threshold: String(bookThreshold)
  });

  // Phase 2 prompt -- assembled with placeholder page since Phase 1 has not run yet.
  // On dry_run this is fine: the user is inspecting the template with real entry data.
  // On the live path Phase 2 prompt is re-assembled below with the real maxLessonPage.
  const phase2PromptDryRun = fillPrompt(promptMap["session_close_phase2"], {
    student_name: body.student_name,
    book_name: book.full_display_name,
    entries: entriesText,
    lesson_page: "not yet resolved -- requires Phase 1 AI output"
  });

  // Resolve unit context for Phases 3, 4, 5 using page null (best-guess for dry run).
  // On the live path these are re-assembled below with real Phase 1 output.
  const { currentUnit: dryRunUnit, priorUnit: dryRunPriorUnit } = resolveCurrentUnit(units, pieces, null);
  const dryRunCandidateText =
    candidates.length > 0 ? formatSupplementCandidates(rankSupplements(candidates, null, prevLessonPage, [], dryRunUnit?.unit_tags ?? [])) : "none available";

  const phase3PromptDryRun = fillPrompt(promptMap["session_close_phase3"], {
    student_name: body.student_name,
    book_name: book.full_display_name,
    lesson_page: "not yet resolved -- requires Phase 1 AI output",
    current_unit_title: dryRunUnit?.unit_title ?? "not available",
    current_unit_skills: dryRunUnit?.unit_skill_focus ?? "not available",
    lesson_signals: "not yet resolved -- requires Phase 1 AI output",
    supplement_candidates: dryRunCandidateText,
    max_display: String(supplementMaxDisplay)
  });

  const dryRunPieceBlock = formatPieceBlock(pieces, units, dryRunUnit?.unit_label ?? "");
  const dryRunActiveSupplements = formatActiveSupplements(activeAssignments);

  const phase4PromptDryRun = fillPrompt(promptMap["session_close_phase4"], {
    student_name: body.student_name,
    session_date: sessionDate,
    book_name: book.full_display_name,
    lesson_page: "not yet resolved -- requires Phase 1 AI output",
    current_unit_title: dryRunUnit?.unit_title ?? "not available",
    current_unit_skills: dryRunUnit?.unit_skill_focus ?? "not available",
    prior_unit_title: dryRunPriorUnit?.unit_title ?? "not available",
    prior_unit_skills: dryRunPriorUnit?.unit_skill_focus ?? "not available",
    piece_context: dryRunPieceBlock,
    entries: entriesText,
    active_supplements: dryRunActiveSupplements
  });

  const phase5VarsDryRun: Record<string, string> = {
    student_name: body.student_name,
    session_date: sessionDate,
    book_name: book.full_display_name,
    lesson_page: "not yet resolved -- requires Phase 1 AI output",
    current_unit_title: dryRunUnit?.unit_title ?? "not available",
    student_instructions: dryRunPieceBlock,
    entries: entriesText,
    active_supplements: dryRunActiveSupplements
  };
  if (studentAge !== null) { phase5VarsDryRun.student_age = studentAge; }
  const phase5PromptDryRun = fillPrompt(promptMap["session_close_phase5"], phase5VarsDryRun);

  // -------------------------------------------------------------------------
  // Dry run exit -- return all five assembled prompts without calling Gemini
  // -------------------------------------------------------------------------
  if (dryRun) {
    return jsonResponse({
      success: true,
      dry_run: true,
      debug_prompts: {
        phase1: phase1Prompt,
        phase2: phase2PromptDryRun,
        phase3: phase3PromptDryRun,
        phase4: phase4PromptDryRun,
        phase5: phase5PromptDryRun
      }
    });
  }

  // -------------------------------------------------------------------------
  // Phase 1 -- Working position and signals (live path only)
  // -------------------------------------------------------------------------
  let phase1: Phase1Result;
  try {
    const phase1Raw = await callGemini(geminiKey, phase1Prompt, true, 1000);
    phase1 = JSON.parse(phase1Raw) as Phase1Result;
  } catch (err: any) {
    return jsonResponse({ success: false, error: `Phase 1 failed: ${err.message}` }, 500);
  }

  const maxLessonPage = phase1.max_lesson_page;

  // -------------------------------------------------------------------------
  // JavaScript ranking logic (runs after Phase 1)
  // -------------------------------------------------------------------------
  const { currentUnit, priorUnit } = resolveCurrentUnit(units, pieces, maxLessonPage);
  const unitTags: string[] = currentUnit?.unit_tags ?? [];
  const rankedCandidates = rankSupplements(
    candidates,
    maxLessonPage,
    prevLessonPage,
    phase1.lesson_signals,
    unitTags
  );

  // -------------------------------------------------------------------------
  // Phase 2 -- Quality gate (live path only)
  // -------------------------------------------------------------------------
  if (!bypassGate && qualityGateEnabled) {
    let phase2: Phase2Result;
    try {
      const phase2Prompt = fillPrompt(promptMap["session_close_phase2"], {
        student_name: body.student_name,
        book_name: book.full_display_name,
        entries: entriesText,
        lesson_page: maxLessonPage !== null ? String(maxLessonPage) : "not recorded"
      });
      const phase2Raw = await callGemini(geminiKey, phase2Prompt, true, 500);
      phase2 = JSON.parse(phase2Raw) as Phase2Result;
    } catch (err: any) {
      return jsonResponse({ success: false, error: `Phase 2 failed: ${err.message}` }, 500);
    }

    if (!phase2.satisfied) {
      const gateMessage = buildGateMessage(body.student_name, phase2.missing_items);
      return jsonResponse({
        success: true,
        gate_satisfied: false,
        gate_message: gateMessage,
        max_lesson_page: maxLessonPage,
        book_transition_suspected: phase1.book_transition_suspected,
        book_transition_book_name: null,
        book_transition_book_id: null,
        ai_summ_teacher: null,
        ai_summ_student: null,
        ai_summ_supplement: null,
        ai_summ_supplement_data: null,
        supplement_initial_display: null
      });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3 -- Supplement selection (live path only)
  // -------------------------------------------------------------------------
  let phase3: Phase3Result;
  try {
    const candidateText =
      rankedCandidates.length > 0 ? formatSupplementCandidates(rankedCandidates) : "none available";

    const phase3Prompt = fillPrompt(promptMap["session_close_phase3"], {
      student_name: body.student_name,
      book_name: book.full_display_name,
      lesson_page: maxLessonPage !== null ? String(maxLessonPage) : "not recorded",
      current_unit_title: currentUnit?.unit_title ?? "not available",
      current_unit_skills: currentUnit?.unit_skill_focus ?? "not available",
      lesson_signals: phase1.lesson_signals.length > 0
        ? phase1.lesson_signals.join(", ")
        : "none recorded",
      supplement_candidates: candidateText,
      max_display: String(supplementMaxDisplay)
    });

    const phase3Raw = await callGemini(geminiKey, phase3Prompt, true, 2000);
    const phase3Parsed = JSON.parse(phase3Raw);

    const candidateMap = new Map(candidates.map((c) => [c.supplement_id, c]));
    const enrichedSupplements = (phase3Parsed.selected_supplements ?? []).map((s: any) => {
      const candidate = candidateMap.get(s.supplement_id);
      return { ...s, thumbnail_url: candidate?.thumbnail_url ?? null };
    });

    phase3 = {
      ai_summ_supplement: phase3Parsed.ai_summ_supplement ?? "",
      selected_supplements: enrichedSupplements
    };
  } catch (err: any) {
    return jsonResponse({ success: false, error: `Phase 3 failed: ${err.message}` }, 500);
  }

  // -------------------------------------------------------------------------
  // Phase 4 -- Teacher summary (live path only)
  // -------------------------------------------------------------------------
  let teacherSummary: string;
  try {
    const pieceContextText = formatPieceBlock(
      pieces,
      units,
      currentUnit?.unit_label ?? ""
    );
    const activeSupplementsText = formatActiveSupplements(activeAssignments);

    const phase4Prompt = fillPrompt(promptMap["session_close_phase4"], {
      student_name: body.student_name,
      session_date: sessionDate,
      book_name: book.full_display_name,
      lesson_page: maxLessonPage !== null ? String(maxLessonPage) : "not recorded",
      current_unit_title: currentUnit?.unit_title ?? "not available",
      current_unit_skills: currentUnit?.unit_skill_focus ?? "not available",
      prior_unit_title: priorUnit?.unit_title ?? "not available",
      prior_unit_skills: priorUnit?.unit_skill_focus ?? "not available",
      piece_context: pieceContextText,
      entries: entriesText,
      active_supplements: activeSupplementsText
    });

    teacherSummary = await callGemini(geminiKey, phase4Prompt, false, 5000, 1024);
  } catch (err: any) {
    return jsonResponse({ success: false, error: `Phase 4 failed: ${err.message}` }, 500);
  }

  // -------------------------------------------------------------------------
  // Phase 5 -- Student practice plan (live path only)
  // -------------------------------------------------------------------------
  let studentSummary: string;
  try {
    const studentInstructionsText = formatPieceBlock(
      pieces,
      units,
      currentUnit?.unit_label ?? ""
    );
    const activeSupplementsText = formatActiveSupplements(activeAssignments);

    const phase5Vars: Record<string, string> = {
      student_name: body.student_name,
      session_date: sessionDate,
      book_name: book.full_display_name,
      lesson_page: maxLessonPage !== null ? String(maxLessonPage) : "not recorded",
      current_unit_title: currentUnit?.unit_title ?? "not available",
      student_instructions: studentInstructionsText,
      entries: entriesText,
      active_supplements: activeSupplementsText
    };

    if (studentAge !== null) {
      phase5Vars.student_age = studentAge;
    }

    const phase5Prompt = fillPrompt(promptMap["session_close_phase5"], phase5Vars);
    studentSummary = await callGemini(geminiKey, phase5Prompt, false, 5000, 1024);
  } catch (err: any) {
    return jsonResponse({ success: false, error: `Phase 5 failed: ${err.message}` }, 500);
  }

  // -------------------------------------------------------------------------
  // Assemble and return full response
  // -------------------------------------------------------------------------
  return jsonResponse({
    success: true,
    gate_satisfied: true,
    gate_message: null,
    max_lesson_page: maxLessonPage,
    book_transition_suspected: phase1.book_transition_suspected,
    book_transition_book_name: null,
    book_transition_book_id: null,
    detected_contexts: phase1.detected_contexts,
    lesson_signals: phase1.lesson_signals,
    ai_summ_teacher: teacherSummary,
    ai_summ_student: studentSummary,
    ai_summ_supplement: phase3.ai_summ_supplement,
    ai_summ_supplement_data: phase3.selected_supplements,
    supplement_initial_display: supplementInitialDisplay
  });
});

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
