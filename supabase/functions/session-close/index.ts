// session-close Edge Function
// May 2026 — Phase 2 replaced: vector similarity ranking replaces tag-based AI call
// Phase 3 retired — supplement selection now pure JS passthrough
// June 2026 — Phase 2 extraction prompt added: focus query distilled from entries before embedding
// Read-only. All writes occur in the browser on teacher approval.
// Phases: 1 (Piece Correlation), 2 (Focus Extraction + Vector Supplement Ranking),
//         4 (Teacher Summary), 5 (Student Practice Plan)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_EMBEDDING_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

const ALLOWED_MODEL_OVERRIDES = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];

const PHASE_MAX_OUTPUT_TOKENS: Record<number, number> = {
  1: 3000,
  4: 5000,
  5: 5000,
};

const PHASE_DEFAULT_THINKING_BUDGET: Record<number, number> = {
  1: 0,
  4: 1024,
  5: 1024,
};

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const geminiApiKey = Deno.env.get('GEMINI_API_KEY')!;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }

  try {
    const body = await req.json();
    const {
      session_id,
      teacher_id,
      student_id,
      series_id,
      lesson_book_id,
      student_name,
      // Debug fields
      dry_run,
      single_phase_run,
      prompt_only,
      model_override,
      thinking_budget: thinking_budget_override,
      assembled_prompt,
      phase1_output: supplied_phase1_output,
      improve_prompt,
      prompt_override,
    } = body;

    // improve_prompt path — admin-only, direct Gemini call for prompt improvement modal
    // Must sit before the required-field guard — improve calls carry no session fields.
    // -----------------------------------------------------------------------
    if (improve_prompt) {
      const { contents, system_instruction, model: improveModel } = body;
      if (!contents || !Array.isArray(contents) || !contents.length) {
        return jsonResponse({ success: false, error: 'improve_prompt requires a non-empty contents array.' });
      }
      const model = (typeof improveModel === 'string' && ALLOWED_MODEL_OVERRIDES.includes(improveModel))
        ? improveModel
        : 'gemini-2.5-flash';
      const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${geminiApiKey}`;
      const geminiBody: Record<string, unknown> = {
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      };
      if (system_instruction) {
        geminiBody.system_instruction = { parts: [{ text: system_instruction }] };
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });
      if (!res.ok) {
        const errText = await res.text();
        return jsonResponse({ success: false, error: `Gemini error: ${errText}` });
      }
      const json = await res.json();
      const suggestion = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      if (!suggestion) {
        return jsonResponse({ success: false, error: 'Empty response from Gemini.' });
      }
      return jsonResponse({ success: true, suggestion });
    }

    if (!session_id || !teacher_id || !student_id || !series_id || !lesson_book_id || !student_name) {
      return jsonResponse({ success: false, error: 'Missing required fields.' });
    }

    const now = new Date();
    const sessionMmdd = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Ownership check — verify the session belongs to this teacher before any AI work.
    // Service role key bypasses RLS, so this explicit check is required.
    const { data: ownerCheck } = await supabase
      .from('sessions')
      .select('session_id')
      .eq('session_id', session_id)
      .eq('teacher_id', teacher_id)
      .eq('session_status', 'active')
      .single();

    if (!ownerCheck) {
      return jsonResponse({ success: false, error: 'Session not found or access denied.' }, 403);
    }

    const data = await fetchSessionData({
      supabase,
      session_id,
      teacher_id,
      student_id,
      series_id,
      lesson_book_id,
      session_mmdd: sessionMmdd,
    });

    if (data.error) {
      return jsonResponse({ success: false, error_type: 'system_error', message: data.error });
    }

    const {
      entries,
      birthYear,
      bookName,
      equivalentBooks,
      booksUnits,
      booksPieces,
      prevLessonPage,
      activeAssignments,
      supplementCandidates,
      configMap,
      promptMap,
      sessionDate,
    } = data;

    // Validate required prompts
    const requiredPromptKeys = [
      'session_close_phase1',
      'session_close_phase4',
      'session_close_phase5',
    ];
    for (const key of requiredPromptKeys) {
      if (!promptMap.has(key)) {
        return jsonResponse({ success: false, error_type: 'system_error', message: `Missing required prompt key: ${key}` });
      }
    }

    // -----------------------------------------------------------------------
    // Derived values
    // -----------------------------------------------------------------------

    const sessionYear = new Date(sessionDate).getFullYear();
    const studentAge = birthYear ? sessionYear - birthYear : null;

    const { text: pieceListText, keyMap: pieceKeyMap } = assemblePieceList(booksUnits, booksPieces);
    const activeSuppsText = activeSupplementsText(activeAssignments);
    const priorLessonPageStr = prevLessonPage !== null ? String(prevLessonPage) : 'not recorded';
    const bookThreshold = parseInt(configMap.get('book_transition_page_threshold') ?? '10');
    const supplementMaxDisplay = parseInt(configMap.get('supplement_max_display') ?? '10');

    // ── Supplement filter rules ──────────────────────────────────────
    // Read once from configMap; passed to equivalent-books RPC calls and JS post-filter.
    // Empty arrays are treated as null (no filter) to match SQL DEFAULT NULL semantics.
    let filterExcludeTopics: string[] | null = null;
    let filterExcludeCategories: string[] | null = null;
    let filterOverrideTopics: string[] | null = null;
    const filterRulesRaw = configMap.get('supplement_filter_rules');
    if (filterRulesRaw) {
      try {
        const filterRules = JSON.parse(filterRulesRaw);
        filterExcludeTopics     = filterRules.exclude_topics?.length     ? filterRules.exclude_topics     : null;
        filterExcludeCategories = filterRules.exclude_categories?.length ? filterRules.exclude_categories : null;
        filterOverrideTopics    = filterRules.override_topics?.length    ? filterRules.override_topics    : null;
      } catch (_) {
        // Malformed config — no filter applied; pipeline continues normally
      }
    }

    const resolvedModelOverride = (model_override && ALLOWED_MODEL_OVERRIDES.includes(model_override))
      ? model_override
      : null;

    // -----------------------------------------------------------------------
    // dry_run path
    // -----------------------------------------------------------------------

    if (dry_run) {
      // If caller supplied a working-copy template, use it instead of the saved DB version
      if (typeof prompt_override === 'string' && prompt_override.trim()) {
        promptMap.set('session_close_phase1', prompt_override);
      }

      const phaseAiConfig = {
        phase1: resolvePhaseAIConfig(configMap, 1),
        phase4: resolvePhaseAIConfig(configMap, 4),
        phase5: resolvePhaseAIConfig(configMap, 5),
      };

      const phase1Prompt = assemblePhase1Prompt(promptMap, student_name, bookName, entries, pieceListText, priorLessonPageStr);
      const phase2PromptDry = (promptMap.get('session_close_phase2') ?? '[session_close_phase2 prompt not found]')
        .replace('{{entries}}', entries);
      const phase4PromptDry = promptMap.get('session_close_phase4')!
        .replace('{{student_name}}', student_name)
        .replace('{{session_date}}', sessionDate)
        .replace('{{book_name}}', bookName)
        .replace('{{lesson_page}}', '[Phase 1 dependent — not available in dry_run]')
        .replace('{{piece_references}}', '[Phase 1 dependent — not available in dry_run]')
        .replace('{{entries}}', entries)
        .replace('{{active_supplements}}', activeSuppsText);
      const phase5PromptDry = promptMap.get('session_close_phase5')!
        .replace('{{student_name}}', student_name)
        .replace('{{session_date}}', sessionDate)
        .replace('{{book_name}}', bookName)
        .replace('{{lesson_page}}', '[Phase 1 dependent — not available in dry_run]')
        .replace('{{piece_references}}', '[Phase 1 dependent — not available in dry_run]')
        .replace('{{entries}}', entries)
        .replace('{{active_supplements}}', activeSuppsText)
        .replace('{{student_age}}', studentAge !== null ? String(studentAge) : 'not recorded');

      return jsonResponse({
        success: true,
        dry_run: true,
        debug_prompts: {
          phase1: phase1Prompt,
          phase2: phase2PromptDry,
          phase4: phase4PromptDry,
          phase5: phase5PromptDry,
        },
        phase_ai_config: phaseAiConfig,
        debug_piece_key_map: Object.fromEntries(pieceKeyMap),
      });
    }

    // -----------------------------------------------------------------------
    // single_phase_run debug path
    // -----------------------------------------------------------------------

    if (single_phase_run) {
      const phase = body.phase as number;

      // If caller supplied a working-copy template, override the saved DB version for this phase
      if (typeof prompt_override === 'string' && prompt_override.trim()) {
        promptMap.set(`session_close_phase${phase}`, prompt_override);
      }

      if (phase === 1) {
        if (!assembled_prompt) {
          return jsonResponse({ success: false, error: 'single_phase_run phase 1 requires assembled_prompt.' });
        }
        const aiConfig = resolvePhaseAIConfig(configMap, 1, resolvedModelOverride, thinking_budget_override);
        const raw = await callAI(assembled_prompt, aiConfig);
        const parsed = parsePhase1JSON(raw);
        const validated = parsed ? validatePhase1Output(parsed, booksPieces, booksUnits, pieceKeyMap) : null;
        return jsonResponse({ success: true, phase: 1, raw_output: raw, parsed_output: validated });
      }

      if (phase === 2) {
        // prompt_only: assemble and return the resolved prompt without running the embedding
        if (prompt_only) {
          const assembled = (promptMap.get('session_close_phase2') ?? '')
            .replace('{{entries}}', entries);
          return jsonResponse({ success: true, phase: 2, assembled_prompt_used: assembled });
        }

        let allCandidates = supplementCandidates;
        if (equivalentBooks && equivalentBooks.length > 0) {
          const { data: equivData } = await supabase.rpc('get_supplement_candidates', {
            p_book_id: lesson_book_id,
            p_equivalent_books: equivalentBooks,
            p_max_lesson_page: null,
            p_series_id: series_id,
            p_student_id: student_id,
            p_session_id: session_id,
            p_session_mmdd: sessionMmdd,
            p_exclude_topics: filterExcludeTopics,
            p_exclude_categories: filterExcludeCategories,
            p_override_topics: filterOverrideTopics,
          });
          if (equivData) allCandidates = equivData;
        }
        const effectiveLessonPage = deriveEffectiveLessonPage(
          supplied_phase1_output
            ? validatePhase1Output(supplied_phase1_output as Phase1Output, booksPieces, booksUnits, pieceKeyMap)
            : { piece_references: [], unit_references: [], max_lesson_page: null, book_transition_suspected: false },
          booksPieces,
          prevLessonPage,
        );
        const focusQuery2 = await extractFocusQuery(entries, promptMap);
        const ranked2 = await rankSupplementsByVector(supabase, allCandidates, entries, effectiveLessonPage, supplementMaxDisplay, focusQuery2);
        const rankedWithScore = ranked2.fullList.map(s => ({ title: s.title, similarity: (s as any).similarity ?? null, pool: s.pool }));
        return jsonResponse({ success: true, phase: 2, ranked_supplements: rankedWithScore, debug_candidate_count: allCandidates.length, debug_focus_query: focusQuery2 || null });
      }

      if ([4, 5].includes(phase)) {
        if (!supplied_phase1_output) {
          return jsonResponse({ success: false, error: `single_phase_run phase ${phase} requires phase1_output.` });
        }
        const phase1 = supplied_phase1_output as Phase1Output;
        const validatedPhase1 = validatePhase1Output(phase1, booksPieces, booksUnits, pieceKeyMap);
        const effectiveLessonPage = deriveEffectiveLessonPage(validatedPhase1, booksPieces, prevLessonPage);
        validatedPhase1.book_transition_suspected = deriveBookTransition(entries, effectiveLessonPage, bookThreshold);

        const pieceBlock = assemblePieceBlock(validatedPhase1, booksPieces, entries, false);
        const pieceBlockWithBook = assemblePieceBlock(validatedPhase1, booksPieces, entries, true);

        if (phase === 4) {
          const promptText = assemblePhase4Prompt(promptMap, student_name, sessionDate, bookName, effectiveLessonPage, pieceBlock, pieceBlockWithBook, entries, activeSuppsText);
          if (prompt_only) return jsonResponse({ success: true, phase: 4, assembled_prompt_used: promptText });
          const aiConfig = resolvePhaseAIConfig(configMap, 4, resolvedModelOverride, thinking_budget_override);
          const raw = await callAI(promptText, aiConfig);
          return jsonResponse({ success: true, phase: 4, raw_output: raw, assembled_prompt_used: promptText });
        }

        if (phase === 5) {
          const promptText = assemblePhase5Prompt(promptMap, student_name, sessionDate, bookName, effectiveLessonPage, pieceBlock, pieceBlockWithBook, entries, activeSuppsText, studentAge);
          if (prompt_only) return jsonResponse({ success: true, phase: 5, assembled_prompt_used: promptText });
          const aiConfig = resolvePhaseAIConfig(configMap, 5, resolvedModelOverride, thinking_budget_override);
          const raw = await callAI(promptText, aiConfig);
          return jsonResponse({ success: true, phase: 5, raw_output: raw, assembled_prompt_used: promptText });
        }
      }

      return jsonResponse({ success: false, error: `Unknown phase: ${phase}` });
    }

    // -----------------------------------------------------------------------
    // Production path — sequential phases 1, 2, 4, 5
    // -----------------------------------------------------------------------

    // Second RPC for equivalent books
    // JS post-filter on initial candidates: the first RPC fires before configMap is read,
    // so filter params cannot be passed to it. Apply the same logic here in JS instead.
    function applySupplementFilterRules(candidates: SupplementCandidate[]): SupplementCandidate[] {
      if (!filterExcludeTopics?.length && !filterExcludeCategories?.length) return candidates;
      return candidates.filter(s => {
        const topics = s.wk_topics ?? [];
        const cats   = s.wk_categories ?? [];
        const hasOverride = filterOverrideTopics?.length
          ? topics.some(t => filterOverrideTopics!.includes(t))
          : false;
        if (hasOverride) return true;
        if (filterExcludeTopics?.length && topics.some(t => filterExcludeTopics!.includes(t))) return false;
        if (filterExcludeCategories?.length && cats.some(c => filterExcludeCategories!.includes(c))) return false;
        return true;
      });
    }
    let allSupplementCandidates = applySupplementFilterRules(supplementCandidates);
    if (equivalentBooks && equivalentBooks.length > 0) {
      const { data: equivData } = await supabase.rpc('get_supplement_candidates', {
        p_book_id: lesson_book_id,
        p_equivalent_books: equivalentBooks,
        p_max_lesson_page: null,
        p_series_id: series_id,
        p_student_id: student_id,
        p_session_id: session_id,
        p_session_mmdd: sessionMmdd,
        p_exclude_topics: filterExcludeTopics,
        p_exclude_categories: filterExcludeCategories,
        p_override_topics: filterOverrideTopics,
      });
      if (equivData) allSupplementCandidates = equivData;
    }

    // --- Phase 1 + Phase 2 extraction — run in parallel ---
    // extractFocusQuery has no dependencies; Phase 1 has no dependencies.
    // Both need only entries and promptMap, which are resolved before this point.
    const phase1Prompt = assemblePhase1Prompt(promptMap, student_name, bookName, entries, pieceListText, priorLessonPageStr);
    const phase1Config = resolvePhaseAIConfig(configMap, 1, resolvedModelOverride, thinking_budget_override);

    // Token accumulator — production path only.
    let totalTokenUsage = 0;
    let totalCallCount  = 0;

    const [phase1Raw, focusQueryResult] = await Promise.all([
      callAIWithJSONRetryWithUsage(phase1Prompt, phase1Config, 1),
      extractFocusQueryWithUsage(entries, promptMap),
    ]);
    totalTokenUsage += phase1Raw.tokens;
    totalCallCount  += phase1Raw.success ? 1 : 1; // count the attempt regardless
    totalTokenUsage += focusQueryResult.tokens;
    totalCallCount  += 1;

    if (!phase1Raw.success) {
      return jsonResponse({ success: false, error_type: 'system_error', message: phase1Raw.error });
    }
    const phase1Parsed = parsePhase1JSON(phase1Raw.text!);
    if (!phase1Parsed) {
      return jsonResponse({ success: false, error_type: 'system_error', message: 'Phase 1 JSON parse failed after retry.' });
    }
    const phase1 = validatePhase1Output(phase1Parsed, booksPieces, booksUnits, pieceKeyMap);
    const focusQuery = focusQueryResult.text;

    const effectiveLessonPage = deriveEffectiveLessonPage(phase1, booksPieces, prevLessonPage);
    phase1.book_transition_suspected = deriveBookTransition(entries, effectiveLessonPage, bookThreshold);

    // --- Phase 2: Focus extraction + vector similarity ranking ---
    // focusQuery is the distilled skill/difficulty signal from Phase 2 extraction.
    // Falls back to raw entries if extraction returned empty or failed.
    // Graceful fallback to position order — never fails the pipeline.
    // No display cap applied here — full ranked list returned to browser.
    // Teacher selects which supplements to include at approval time.
    const ranked = await rankSupplementsByVector(
      supabase,
      allSupplementCandidates,
      entries,
      effectiveLessonPage,
      Infinity,
      focusQuery,
    );
    totalTokenUsage += ranked.embedTokens;
    totalCallCount  += 1;

    // --- Phase 3 retired: JS passthrough ---
    // ranked.fullList already contains thumbnail_url, title, source_url, is_free, pool.
    // No AI call needed. ai_summ_supplement is a fixed string satisfying the non-null write check.
    const supplementData = ranked.fullList;
    const supplementText = 'See supplement recommendations below.';

    // --- Phase 4 ---
    const pieceBlock = assemblePieceBlock(phase1, booksPieces, entries, false);
    const pieceBlockWithBook = assemblePieceBlock(phase1, booksPieces, entries, true);
    const phase4Prompt = assemblePhase4Prompt(promptMap, student_name, sessionDate, bookName, effectiveLessonPage, pieceBlock, pieceBlockWithBook, entries, activeSuppsText);
    const phase4Config = resolvePhaseAIConfig(configMap, 4, resolvedModelOverride, thinking_budget_override);
    let phase4Result: { text: string; tokens: number };
    try {
      phase4Result = await callGeminiWithUsage(phase4Prompt, phase4Config);
    } catch (err) {
      const msg = String(err);
      return jsonResponse({ success: false, error_type: 'ai_unavailable', message: `Phase 4: ${msg}` });
    }
    totalTokenUsage += phase4Result.tokens;
    totalCallCount  += 1;

    // --- Phase 5 ---
    const phase5Prompt = assemblePhase5Prompt(promptMap, student_name, sessionDate, bookName, effectiveLessonPage, pieceBlock, pieceBlockWithBook, entries, activeSuppsText, studentAge);
    const phase5Config = resolvePhaseAIConfig(configMap, 5, resolvedModelOverride, thinking_budget_override);
    let phase5Result: { text: string; tokens: number };
    try {
      phase5Result = await callGeminiWithUsage(phase5Prompt, phase5Config);
    } catch (err) {
      const msg = String(err);
      return jsonResponse({ success: false, error_type: 'ai_unavailable', message: `Phase 5: ${msg}` });
    }
    totalTokenUsage += phase5Result.tokens;
    totalCallCount  += 1;

    return jsonResponse({
      success: true,
      ai_summ_teacher: phase4Result.text,
      ai_summ_student: phase5Result.text,
      ai_summ_supplement: supplementText,
      ai_summ_supplement_data: supplementData,
      active_assignments_data: activeAssignments,
      max_lesson_page: phase1.max_lesson_page,
      book_transition_suspected: phase1.book_transition_suspected,
      next_book_id: null,
      min_entry_character_count: parseInt(configMap.get('min_entry_character_count') ?? '20'),
      debug_focus_query: focusQuery || null,
      token_usage: totalTokenUsage,
      call_count: totalCallCount,
    });

  } catch (err) {
    console.error('session-close unhandled error:', err);
    return jsonResponse({ success: false, error_type: 'system_error', message: String(err) });
  }
});

// ---------------------------------------------------------------------------
// fetchSessionData
// ---------------------------------------------------------------------------

interface FetchResult {
  entries: string;
  birthYear: number | null;
  bookName: string;
  equivalentBooks: string[] | null;
  booksUnits: BookUnit[];
  booksPieces: BookPiece[];
  prevLessonPage: number | null;
  activeAssignments: ActiveAssignment[];
  supplementCandidates: SupplementCandidate[];
  configMap: Map<string, string>;
  promptMap: Map<string, string>;
  sessionDate: string;
  error?: string;
}

async function fetchSessionData(params: {
  supabase: ReturnType<typeof createClient>;
  session_id: string;
  teacher_id: string;
  student_id: string;
  series_id: string;
  lesson_book_id: string;
  session_mmdd: string;
}): Promise<FetchResult> {
  const { supabase, session_id, teacher_id, student_id, series_id, lesson_book_id, session_mmdd } = params;

  const [
    entriesResult,
    studentResult,
    bookResult,
    unitsResult,
    piecesResult,
    prevSessionResult,
    assignmentsResult,
    candidatesResult,
    configResult,
    promptsResult,
    sessionDateResult,
  ] = await Promise.all([
    supabase
      .from('session_entries')
      .select('entry_text, entry_sequence')
      .eq('session_id', session_id)
      .eq('entry_source', 'teacher')
      .order('entry_sequence', { ascending: true }),

    supabase
      .from('students')
      .select('birth_year')
      .eq('student_id', student_id)
      .single(),

    supabase
      .from('books')
      .select('full_display_name, equivalent_books, sequence_number')
      .eq('book_id', lesson_book_id)
      .single(),

    supabase
      .from('books_units')
      .select('unit_label, unit_sort_order, unit_title, unit_tags')
      .eq('book_id', lesson_book_id)
      .order('unit_sort_order', { ascending: true }),

    supabase
      .from('books_pieces')
      .select('piece_id, piece_title, piece_type, page_start, page_end, page_level_tags, student_instructions, unit_label, unit_sort_order')
      .eq('book_id', lesson_book_id)
      .order('page_start', { ascending: true }),

    supabase
      .from('sessions')
      .select('max_lesson_page')
      .eq('student_id', student_id)
      .eq('session_status', 'approved')
      .order('session_date', { ascending: false })
      .limit(1),

    supabase
      .from('student_assignments')
      .select('supplement_id, supplements(title, thumbnail_url, source_url)')
      .eq('student_id', student_id)
      .eq('is_active', true),

    supabase.rpc('get_supplement_candidates', {
      p_book_id: lesson_book_id,
      p_equivalent_books: null,
      p_max_lesson_page: null,
      p_series_id: series_id,
      p_student_id: student_id,
      p_session_id: session_id,
      p_session_mmdd: session_mmdd,
    }),

    supabase
      .from('config')
      .select('config_key, config_value')
      .eq('series_id', series_id)
      .in('config_key', [
        'supplement_max_display',
        'supplement_initial_display',
        'book_transition_page_threshold',
        'active_supplement_check_after_sessions',
        'min_entry_character_count',
        'ai_phase1_model', 'ai_phase1_thinking_budget',
        'ai_phase4_model', 'ai_phase4_thinking_budget',
        'ai_phase5_model', 'ai_phase5_thinking_budget',
        'supplement_filter_rules',
      ]),

    supabase
      .from('prompts')
      .select('prompt_key, prompt_text')
      .eq('series_id', series_id)
      .in('prompt_key', [
        'session_close_phase1',
        'session_close_phase2',
        'session_close_phase4',
        'session_close_phase5',
      ]),

    supabase
      .from('sessions')
      .select('session_date')
      .eq('session_id', session_id)
      .single(),
  ]);

  const configMap = new Map<string, string>();
  for (const row of configResult.data ?? []) {
    configMap.set(row.config_key, row.config_value);
  }

  const promptMap = new Map<string, string>();
  for (const row of promptsResult.data ?? []) {
    promptMap.set(row.prompt_key, row.prompt_text);
  }

  const entryRows = entriesResult.data ?? [];
  const entries = entryRows.map((r: any) => r.entry_text).join('\n');
  const sessionDate = sessionDateResult.data?.session_date ?? new Date().toISOString().split('T')[0];

  const activeAssignments: ActiveAssignment[] = (assignmentsResult.data ?? []).map((r: any) => ({
    supplement_id: r.supplement_id,
    title: r.supplements?.title ?? '',
    thumbnail_url: r.supplements?.thumbnail_url ?? null,
    source_url: r.supplements?.source_url ?? null,
  }));

  return {
    entries,
    birthYear: studentResult.data?.birth_year ?? null,
    bookName: bookResult.data?.full_display_name ?? '',
    equivalentBooks: bookResult.data?.equivalent_books ?? null,
    booksUnits: unitsResult.data ?? [],
    booksPieces: piecesResult.data ?? [],
    prevLessonPage: prevSessionResult.data?.[0]?.max_lesson_page ?? null,
    activeAssignments,
    supplementCandidates: candidatesResult.data ?? [],
    configMap,
    promptMap,
    sessionDate,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BookUnit {
  unit_label: string;
  unit_sort_order: number;
  unit_title: string;
  unit_tags: string[];
}

interface BookPiece {
  piece_id: string;
  piece_title: string;
  piece_type: string;
  page_start: number;
  page_end: number | null;
  page_level_tags: string[];
  student_instructions: string[] | null;
  unit_label: string;
  unit_sort_order: number;
}

interface ActiveAssignment {
  supplement_id: string;
  title: string;
  thumbnail_url: string | null;
  source_url: string | null;
}

interface SupplementCandidate {
  supplement_id: string;
  title: string;
  source_url: string;
  is_free: boolean | null;
  pool: string;
  page_start: number | null;
  tags: string[];
  match_context: string | null;
  thumbnail_url: string | null;
  search_description: string | null;
  wk_topics: string[] | null;
  wk_categories: string[] | null;
  similarity?: number | null;
}

interface PieceReference {
  piece_id: string;
  piece_title: string;
  confidence: 'high' | 'medium';
  teacher_notes: string[];
  page_level_tags_matched: string[];
  student_instructions: string[] | null;
}

interface UnitPieceEntry {
  piece_id: string;
  piece_title: string;
  page_start: number;
}

interface UnitReference {
  unit_label: string;
  unit_title: string;
  teacher_notes: string[];
  pieces: UnitPieceEntry[];
}

interface Phase1Output {
  piece_references: PieceReference[];
  unit_references: UnitReference[];
  max_lesson_page: number | null;
  book_transition_suspected: boolean;
}

type PieceKeyMap = Map<number, string>;

interface PhaseAIConfig {
  model: string;
  thinkingBudget: number;
  maxOutputTokens: number;
}

interface RankedResult {
  fullList: SupplementCandidate[];
  embedTokens: number;
}

// ---------------------------------------------------------------------------
// resolvePhaseAIConfig
// ---------------------------------------------------------------------------

function resolvePhaseAIConfig(
  configMap: Map<string, string>,
  phase: number,
  modelOverride?: string | null,
  thinkingBudgetOverride?: number | null,
): PhaseAIConfig {
  const model = modelOverride
    ?? configMap.get(`ai_phase${phase}_model`)
    ?? GEMINI_MODEL;
  const thinkingBudget = (thinkingBudgetOverride !== null && thinkingBudgetOverride !== undefined && thinkingBudgetOverride >= 0)
    ? thinkingBudgetOverride
    : parseInt(configMap.get(`ai_phase${phase}_thinking_budget`) ?? String(PHASE_DEFAULT_THINKING_BUDGET[phase] ?? 0));
  const maxOutputTokens = PHASE_MAX_OUTPUT_TOKENS[phase] ?? 2000;
  return { model, thinkingBudget, maxOutputTokens };
}

// ---------------------------------------------------------------------------
// callAI / callGemini — with exponential backoff retry
// ---------------------------------------------------------------------------

async function callAI(prompt: string, config: PhaseAIConfig): Promise<string> {
  return callGemini(prompt, config);
}

async function callGemini(prompt: string, config: PhaseAIConfig): Promise<string> {
  const url = `${GEMINI_BASE_URL}/${config.model}:generateContent?key=${geminiApiKey}`;

  const body: Record<string, unknown> = {
    system_instruction: {
      parts: [{ text: 'You are a data extraction tool. You extract information only from the text provided to you. You never use outside knowledge, memory, or training data. If the information is not in the provided text, you do not include it.' }]
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: config.maxOutputTokens,
    },
  };

  if (config.thinkingBudget > 0) {
    body.generationConfig = {
      ...body.generationConfig as object,
      thinkingConfig: { thinkingBudget: config.thinkingBudget },
    };
  }

  const RETRY_DELAYS = [1000, 2000, 4000];
  let lastError = '';

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return text;
      }

      if (res.status === 429 || res.status === 503) {
        lastError = `HTTP ${res.status}`;
        if (attempt < RETRY_DELAYS.length) {
          await delay(RETRY_DELAYS[attempt]);
          continue;
        }
      }

      const errText = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${errText}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Gemini HTTP')) throw err;
      lastError = String(err);
      if (attempt < RETRY_DELAYS.length) await delay(RETRY_DELAYS[attempt]);
    }
  }

  throw new Error(`Gemini call failed after retries: ${lastError}`);
}

// Like callGemini but returns { text, tokens } for token tracking.
// Used only in the production path — debug paths use callAI/callGemini unchanged.
async function callGeminiWithUsage(prompt: string, config: PhaseAIConfig): Promise<{ text: string; tokens: number }> {
  const url = `${GEMINI_BASE_URL}/${config.model}:generateContent?key=${geminiApiKey}`;

  const body: Record<string, unknown> = {
    system_instruction: {
      parts: [{ text: 'You are a data extraction tool. You extract information only from the text provided to you. You never use outside knowledge, memory, or training data. If the information is not in the provided text, you do not include it.' }]
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: config.maxOutputTokens,
    },
  };

  if (config.thinkingBudget > 0) {
    body.generationConfig = {
      ...body.generationConfig as object,
      thinkingConfig: { thinkingBudget: config.thinkingBudget },
    };
  }

  const RETRY_DELAYS = [1000, 2000, 4000];
  let lastError = '';

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const tokens = json?.usageMetadata?.totalTokenCount ?? 0;
        return { text, tokens };
      }

      if (res.status === 429 || res.status === 503) {
        lastError = `HTTP ${res.status}`;
        if (attempt < RETRY_DELAYS.length) {
          await delay(RETRY_DELAYS[attempt]);
          continue;
        }
      }

      const errText = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${errText}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Gemini HTTP')) throw err;
      lastError = String(err);
      if (attempt < RETRY_DELAYS.length) await delay(RETRY_DELAYS[attempt]);
    }
  }

  throw new Error(`Gemini call failed after retries: ${lastError}`);
}

// ---------------------------------------------------------------------------
// callAIWithJSONRetry
// ---------------------------------------------------------------------------

async function callAIWithJSONRetry(
  prompt: string,
  config: PhaseAIConfig,
  phase: number,
): Promise<{ success: boolean; text?: string; error?: string }> {
  try {
    const text = await callAI(prompt, config);
    const cleaned = stripFences(text);
    JSON.parse(cleaned);
    return { success: true, text: cleaned };
  } catch {
    const retryPrompt = prompt + '\n\nCRITICAL: Your previous response could not be parsed as JSON. Return ONLY a raw JSON object. No markdown. No code fences. No explanation. Start with { and end with }.';
    try {
      const text = await callAI(retryPrompt, config);
      const cleaned = stripFences(text);
      JSON.parse(cleaned);
      return { success: true, text: cleaned };
    } catch (err) {
      return { success: false, error: `Phase ${phase} JSON parse failed after retry: ${String(err)}` };
    }
  }
}

// Like callAIWithJSONRetry but accumulates token counts across attempts.
// Returns { success, text, tokens, error }. Used only in production path.
async function callAIWithJSONRetryWithUsage(
  prompt: string,
  config: PhaseAIConfig,
  phase: number,
): Promise<{ success: boolean; text?: string; tokens: number; error?: string }> {
  let totalTokens = 0;
  try {
    const { text, tokens } = await callGeminiWithUsage(prompt, config);
    totalTokens += tokens;
    const cleaned = stripFences(text);
    JSON.parse(cleaned);
    return { success: true, text: cleaned, tokens: totalTokens };
  } catch {
    const retryPrompt = prompt + '\n\nCRITICAL: Your previous response could not be parsed as JSON. Return ONLY a raw JSON object. No markdown. No code fences. No explanation. Start with { and end with }.';
    try {
      const { text, tokens } = await callGeminiWithUsage(retryPrompt, config);
      totalTokens += tokens;
      const cleaned = stripFences(text);
      JSON.parse(cleaned);
      return { success: true, text: cleaned, tokens: totalTokens };
    } catch (err) {
      return { success: false, tokens: totalTokens, error: `Phase ${phase} JSON parse failed after retry: ${String(err)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// stripFences
// ---------------------------------------------------------------------------

function stripFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

// ---------------------------------------------------------------------------
// parsePhase1JSON
// ---------------------------------------------------------------------------

function parsePhase1JSON(text: string): Phase1Output | null {
  try {
    const parsed = JSON.parse(stripFences(text));
    return {
      piece_references: Array.isArray(parsed.piece_references) ? parsed.piece_references : [],
      unit_references: Array.isArray(parsed.unit_references) ? parsed.unit_references : [],
      max_lesson_page: typeof parsed.max_lesson_page === 'number' ? parsed.max_lesson_page : null,
      book_transition_suspected: false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// embedText — calls Gemini embedding API, returns normalized vector
// ---------------------------------------------------------------------------

async function embedText(text: string): Promise<number[]> {
  const delays = [3000, 6000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(GEMINI_EMBEDDING_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey,
        },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text }] },
          outputDimensionality: 768,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const values: number[] = json?.embedding?.values ?? [];
        if (values.length === 0) throw new Error('Empty embedding returned');
        // Normalize to unit length — required for gemini-embedding-001 at non-3072 dimensions
        const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
        return magnitude > 0 ? values.map(v => v / magnitude) : values;
      }

      if ((res.status === 429 || res.status === 503) && attempt < delays.length) {
        await delay(delays[attempt]);
        continue;
      }

      const errText = await res.text();
      throw new Error(`Embedding API HTTP ${res.status}: ${errText}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Embedding API HTTP')) throw err;
      if (attempt < delays.length) await delay(delays[attempt]);
      else throw err;
    }
  }

  throw new Error('embedText: retries exhausted');
}

// Like embedText but also returns token count from usageMetadata.
// Used only in the production path.
async function embedTextWithUsage(text: string): Promise<{ values: number[]; tokens: number }> {
  const delays = [3000, 6000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(GEMINI_EMBEDDING_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey,
        },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text }] },
          outputDimensionality: 768,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const values: number[] = json?.embedding?.values ?? [];
        if (values.length === 0) throw new Error('Empty embedding returned');
        const tokens = json?.usageMetadata?.totalTokenCount ?? 0;
        const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
        return { values: magnitude > 0 ? values.map(v => v / magnitude) : values, tokens };
      }

      if ((res.status === 429 || res.status === 503) && attempt < delays.length) {
        await delay(delays[attempt]);
        continue;
      }

      const errText = await res.text();
      throw new Error(`Embedding API HTTP ${res.status}: ${errText}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Embedding API HTTP')) throw err;
      if (attempt < delays.length) await delay(delays[attempt]);
      else throw err;
    }
  }

  throw new Error('embedTextWithUsage: retries exhausted');
}

// ---------------------------------------------------------------------------
// extractFocusQuery
// ---------------------------------------------------------------------------

// Calls the session_close_phase2 prompt to distill the teacher's entries into
// skill/difficulty signals only, stripping praise and positive comments.
// Returns the trimmed extraction result, or '' on any failure (caller falls back to raw entries).
// thinkingBudget: 0 — pure extraction task, no reasoning required.
// maxOutputTokens: 500 — output is a few sentences at most.

async function extractFocusQuery(
  entries: string,
  promptMap: Map<string, string>,
): Promise<string> {
  const template = promptMap.get('session_close_phase2');
  if (!template || !template.trim()) return '';
  if (!entries || !entries.trim()) return '';

  const prompt = template.replace('{{entries}}', entries);
  const config: PhaseAIConfig = {
    model: GEMINI_MODEL,
    thinkingBudget: 0,
    maxOutputTokens: 500,
  };

  try {
    const result = await callAI(prompt, config);
    return result.trim();
  } catch (err) {
    console.warn('extractFocusQuery failed — will use raw entries for embedding:', err);
    return '';
  }
}

// Like extractFocusQuery but returns { text, tokens }. Used only in production path.
async function extractFocusQueryWithUsage(
  entries: string,
  promptMap: Map<string, string>,
): Promise<{ text: string; tokens: number }> {
  const template = promptMap.get('session_close_phase2');
  if (!template || !template.trim()) return { text: '', tokens: 0 };
  if (!entries || !entries.trim()) return { text: '', tokens: 0 };

  const prompt = template.replace('{{entries}}', entries);
  const config: PhaseAIConfig = {
    model: GEMINI_MODEL,
    thinkingBudget: 0,
    maxOutputTokens: 500,
  };

  try {
    const { text, tokens } = await callGeminiWithUsage(prompt, config);
    return { text: text.trim(), tokens };
  } catch (err) {
    console.warn('extractFocusQueryWithUsage failed — will use raw entries for embedding:', err);
    return { text: '', tokens: 0 };
  }
}

// ---------------------------------------------------------------------------
// rankSupplementsByVector
// ---------------------------------------------------------------------------

async function rankSupplementsByVector(
  supabase: ReturnType<typeof createClient>,
  candidates: SupplementCandidate[],
  entries: string,
  effectiveLessonPage: number | null,
  maxDisplay: number,
  focusQuery?: string,
): Promise<RankedResult> {

  // Step 1: Position filter — same gate as before
  const filtered = candidates.filter(c => {
    if (c.pool === 'fallback') return true;
    if (effectiveLessonPage === null) return true;
    return (c.page_start ?? 0) <= effectiveLessonPage;
  });

  if (filtered.length === 0) return { fullList: [], embedTokens: 0 };

  // Step 2: Embed focus query (distilled skill/difficulty signal) or fall back to raw entries.
  // Guard: empty string cannot be embedded — fall back to position order.
  const queryText = (focusQuery && focusQuery.trim()) ? focusQuery : entries;
  if (!queryText || !queryText.trim()) {
    const fallback = [...filtered].sort((a, b) => (a.page_start ?? 0) - (b.page_start ?? 0));
    return { fullList: fallback.slice(0, maxDisplay), embedTokens: 0 };
  }

  try {
    const { values: queryVector, tokens: embedTokens } = await embedTextWithUsage(queryText);
    const candidateIds = filtered.map(c => c.supplement_id);

    const { data: ranked } = await supabase.rpc('rank_supplement_candidates_by_vector', {
      p_query_embedding: `[${queryVector.join(',')}]`,
      p_supplement_ids: candidateIds,
    });

    if (ranked && ranked.length > 0) {
      // Build similarity lookup
      const similarityMap = new Map<string, number>(
        (ranked as { supplement_id: string; similarity: number }[])
          .map(r => [r.supplement_id, r.similarity])
      );

      // Reorder filtered candidates by similarity; supplements without embeddings go last
      const sorted = [...filtered].sort((a, b) => {
        const simA = similarityMap.get(a.supplement_id) ?? -1;
        const simB = similarityMap.get(b.supplement_id) ?? -1;
        return simB - simA;
      });

      return {
        fullList: sorted.slice(0, maxDisplay).map(c => ({
          ...c,
          similarity: similarityMap.get(c.supplement_id) ?? null,
        })),
        embedTokens,
      };
    }
  } catch (err) {
    console.warn('Phase 2 vector ranking failed — falling back to position order:', err);
  }

  // Fallback: position order ascending
  const fallback = [...filtered].sort((a, b) => (a.page_start ?? 0) - (b.page_start ?? 0));
  return { fullList: fallback.slice(0, maxDisplay), embedTokens: 0 };
}

// ---------------------------------------------------------------------------
// validatePhase1Output
// ---------------------------------------------------------------------------

function validatePhase1Output(
  phase1: Phase1Output,
  booksPieces: BookPiece[],
  booksUnits: BookUnit[],
  pieceKeyMap: PieceKeyMap,
): Phase1Output {
  const validPieceIds = new Set(booksPieces.map(p => p.piece_id));
  const validUnitLabels = new Set(booksUnits.map(u => u.unit_label));
  const pieceMap = new Map(booksPieces.map(p => [p.piece_id, p]));
  const validPieceRefs: PieceReference[] = (phase1.piece_references ?? [])
    .filter((ref: any) => ref != null)
    .map((ref: any) => {
    const rawKey = ref.piece_key;
    const resolvedId = rawKey !== undefined
      ? pieceKeyMap.get(Number(rawKey))
      : ref.piece_id;
    if (!resolvedId || !validPieceIds.has(resolvedId)) {
      console.error(`DROPPED: key=${rawKey} resolvedId=${resolvedId}`);
      return null;
    }
    const piece = pieceMap.get(resolvedId)!;
    return {
      piece_id: resolvedId,
      piece_title: piece.piece_title,
      confidence: ref.confidence === 'medium' ? 'medium' : 'high',
      teacher_notes: Array.isArray(ref.teacher_notes) ? ref.teacher_notes : [],
      page_level_tags_matched: piece.page_level_tags ?? [],
      student_instructions: piece.student_instructions ?? null,
    };
  }).filter((r): r is PieceReference => r !== null);

  const validUnitRefs: UnitReference[] = (phase1.unit_references ?? []).map((uref: any) => {
    if (!validUnitLabels.has(uref.unit_label)) {
      console.warn(`Phase 1 validator: dropped unit_reference — unknown unit_label: ${uref.unit_label}`);
      return null;
    }
    const validPieces: UnitPieceEntry[] = (uref.piece_keys ?? uref.pieces ?? []).map((entry: any) => {
      const rawKey = typeof entry === 'number' ? entry : entry.piece_key;
      const resolvedId = rawKey !== undefined
        ? pieceKeyMap.get(Number(rawKey))
        : entry.piece_id;
      if (!resolvedId || !validPieceIds.has(resolvedId)) {
        console.warn(`Phase 1 validator: dropped unit piece — unresolvable key/id: ${rawKey ?? entry}`);
        return null;
      }
      const piece = pieceMap.get(resolvedId)!;
      return { piece_id: resolvedId, piece_title: piece.piece_title, page_start: piece.page_start };
    }).filter((p: any): p is UnitPieceEntry => p !== null);

    return {
      unit_label: uref.unit_label,
      unit_title: uref.unit_title,
      teacher_notes: Array.isArray(uref.teacher_notes) ? uref.teacher_notes : [],
      pieces: validPieces,
    };
  }).filter((u): u is UnitReference => u !== null);

  return {
    ...phase1,
    piece_references: validPieceRefs,
    unit_references: validUnitRefs,
  };
}

// ---------------------------------------------------------------------------
// deriveEffectiveLessonPage
// ---------------------------------------------------------------------------

function deriveEffectiveLessonPage(
  phase1: Phase1Output,
  booksPieces: BookPiece[],
  prevLessonPage: number | null,
): number | null {
  const pieceMap = new Map(booksPieces.map(p => [p.piece_id, p]));

  const highConfidencePages = phase1.piece_references
    .filter(r => r.confidence === 'high')
    .map(r => pieceMap.get(r.piece_id)?.page_start ?? null)
    .filter((p): p is number => p !== null);

  const unitPages = phase1.unit_references.flatMap(u =>
    u.pieces.map(p => p.page_start).filter((p): p is number => p !== null)
  );

  const allPages = [...highConfidencePages, ...unitPages];
  let effectiveLessonPage: number | null = allPages.length > 0 ? Math.max(...allPages) : null;

  if (phase1.max_lesson_page !== null) {
    effectiveLessonPage = effectiveLessonPage !== null
      ? Math.min(effectiveLessonPage, phase1.max_lesson_page)
      : phase1.max_lesson_page;
  }

  return effectiveLessonPage;
}

// ---------------------------------------------------------------------------
// deriveBookTransition
// ---------------------------------------------------------------------------

function deriveBookTransition(
  entries: string,
  effectiveLessonPage: number | null,
  bookThreshold: number,
): boolean {
  const lower = entries.toLowerCase();
  const hasTransitionLanguage = [
    'finished the book',
    'moving to next book',
    'last page today',
    'ready for next book',
  ].some(phrase => lower.includes(phrase));
  return hasTransitionLanguage && effectiveLessonPage !== null && effectiveLessonPage < bookThreshold;
}

// ---------------------------------------------------------------------------
// assemblePieceList
// ---------------------------------------------------------------------------

function assemblePieceList(
  booksUnits: BookUnit[],
  booksPieces: BookPiece[],
): { text: string; keyMap: PieceKeyMap } {
  const lines: string[] = [];
  const keyMap: PieceKeyMap = new Map();
  let key = 1;
  for (const unit of booksUnits) {
    lines.push(`UNIT ${unit.unit_label} — ${unit.unit_title}`);
    const piecesInUnit = booksPieces.filter(p => p.unit_label === unit.unit_label);
    for (const piece of piecesInUnit) {
      keyMap.set(key, piece.piece_id);
      lines.push(`  #${key} | ${piece.piece_title} | p.${piece.page_start} | ${piece.piece_type}`);
      key++;
    }
    lines.push('');
  }
  return { text: lines.join('\n').trim(), keyMap };
}

// ---------------------------------------------------------------------------
// assemblePieceBlock
// ---------------------------------------------------------------------------

function assemblePieceBlock(
  phase1: Phase1Output,
  booksPieces: BookPiece[],
  entries: string,
  includeBookLines: boolean,
): string {
  const pieceMap = new Map(booksPieces.map(p => [p.piece_id, p]));
  const lines: string[] = [];

  const sortedRefs = [...phase1.piece_references].sort((a, b) => {
    const pa = pieceMap.get(a.piece_id)?.page_start ?? 0;
    const pb = pieceMap.get(b.piece_id)?.page_start ?? 0;
    return pa - pb;
  });

  for (const ref of sortedRefs) {
    const piece = pieceMap.get(ref.piece_id);
    const page = piece?.page_start ?? '?';
    const type = piece?.piece_type ?? '';
    lines.push(`${ref.piece_title} (p.${page}, ${type})`);
    for (const note of ref.teacher_notes ?? []) {
      lines.push(`Teacher: ${note}`);
    }
    if (includeBookLines && piece?.student_instructions) {
      const raw = piece.student_instructions;
      const instructions: string[] = Array.isArray(raw)
        ? raw
        : String(raw).split(/[\n;]+/);
      for (const instr of instructions.map(s => s.trim()).filter(s => s.length > 0)) {
        lines.push(`Book: ${instr}`);
      }
    }
    lines.push('');
  }

  for (const uref of phase1.unit_references) {
    lines.push(`Unit ${uref.unit_label} — ${uref.unit_title} [unit instruction]`);
    for (const note of uref.teacher_notes ?? []) {
      lines.push(`Teacher: ${note}`);
    }
    for (const p of uref.pieces ?? []) {
      lines.push(`  ${p.piece_title} (p.${p.page_start})`);
    }
    lines.push('');
  }

  const matchedPieceTitles = [
    ...sortedRefs.map(r => r.piece_title.toLowerCase()),
    ...phase1.unit_references.flatMap(u => u.pieces.map(p => p.piece_title.toLowerCase())),
  ];
  const matchedUnitTitles = phase1.unit_references.map(u => u.unit_title.toLowerCase());

  const sentences = entries
    .split(/(?<=[.!?])\s+|\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const isPieceSpecific = matchedPieceTitles.some(t => lower.includes(t));
    const isUnitSpecific = matchedUnitTitles.some(t => lower.includes(t));
    if (!isPieceSpecific && !isUnitSpecific) {
      lines.push(`General: ${sentence}`);
    }
  }

  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// activeSupplementsText
// ---------------------------------------------------------------------------

function activeSupplementsText(assignments: ActiveAssignment[]): string {
  if (!assignments || assignments.length === 0) return 'None.';
  return assignments
    .map(a => `Continue working on ${a.title} as previously instructed.`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Prompt assembly functions
// ---------------------------------------------------------------------------

function assemblePhase1Prompt(
  promptMap: Map<string, string>,
  studentName: string,
  bookName: string,
  entries: string,
  pieceList: string,
  priorLessonPage: string,
): string {
  return (promptMap.get('session_close_phase1') ?? '')
    .replace('{{student_name}}', studentName)
    .replace('{{book_name}}', bookName)
    .replace('{{entries}}', entries)
    .replace('{{piece_list}}', pieceList)
    .replace('{{prior_lesson_page}}', priorLessonPage);
}

function assemblePhase4Prompt(
  promptMap: Map<string, string>,
  studentName: string,
  sessionDate: string,
  bookName: string,
  effectiveLessonPage: number | null,
  pieceReferences: string,
  pieceReferencesWithBook: string,
  entries: string,
  activeSupplements: string,
): string {
  const lessonPageStr = effectiveLessonPage != null ? String(effectiveLessonPage) : 'not recorded';
  return (promptMap.get('session_close_phase4') ?? '')
    .replace('{{student_name}}', studentName)
    .replace('{{session_date}}', sessionDate)
    .replace('{{book_name}}', bookName)
    .replace('{{lesson_page}}', lessonPageStr)
    .replace('{{piece_references}}', pieceReferences)
    .replace('{{piece_references_with_book}}', pieceReferencesWithBook)
    .replace('{{entries}}', entries)
    .replace('{{active_supplements}}', activeSupplements);
}

function assemblePhase5Prompt(
  promptMap: Map<string, string>,
  studentName: string,
  sessionDate: string,
  bookName: string,
  effectiveLessonPage: number | null,
  pieceReferences: string,
  pieceReferencesWithBook: string,
  entries: string,
  activeSupplements: string,
  studentAge: number | null,
): string {
  const lessonPageStr = effectiveLessonPage != null ? String(effectiveLessonPage) : 'not recorded';
  const ageStr = studentAge !== null ? String(studentAge) : 'not recorded';
  return (promptMap.get('session_close_phase5') ?? '')
    .replace('{{student_name}}', studentName)
    .replace('{{session_date}}', sessionDate)
    .replace('{{book_name}}', bookName)
    .replace('{{lesson_page}}', lessonPageStr)
    .replace('{{piece_references}}', pieceReferences)
    .replace('{{piece_references_with_book}}', pieceReferencesWithBook)
    .replace('{{entries}}', entries)
    .replace('{{active_supplements}}', activeSupplements)
    .replace('{{student_age}}', ageStr);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
