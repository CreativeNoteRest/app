import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Series defaults map ────────────────────────────────────────────────────
// Keyed by series_id UUID. Add one entry per series when onboarding new series.
// Used as fallback for OAuth signups where series_id is absent from user_metadata
// (OAuth flow does not support passing custom metadata at account creation time).
// For email+password signups, series_id is always present in user_metadata.
const SERIES_DEFAULTS: Record<string, { slug: string; name: string }> = {
  "96c05aaa-0329-4582-a35c-51423afc21dd": {
    slug: "wunderkeys",
    name: "WunderKeys",
  },
};

// Default series used when metadata is absent (OAuth signups).
// Safe while only one series exists. Revisit when second series is onboarded.
const DEFAULT_SERIES_ID = "96c05aaa-0329-4582-a35c-51423afc21dd";

// ── Config key names ───────────────────────────────────────────────────────
// These match the Config table keys used platform-wide.
const CONFIG_KEY_SEAT_LIMIT  = "free_trial_seat_limit";   // expected value: 1
const CONFIG_KEY_TOKEN_CAP   = "token_cap";                // platform-wide default
const CONFIG_KEY_TRIAL_DAYS  = "free_trial_days";          // expected value: 30 (informational only here)

// ── CORS headers ───────────────────────────────────────────────────────────
// Auth hooks are called server-to-server by Supabase — no browser CORS needed.
// OPTIONS handler included defensively.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(body: unknown, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  // ── Secrets ──────────────────────────────────────────────────────────────
  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("after-user-created: missing required environment secrets.");
    return err({ error: "Missing required environment secrets." }, 500);
  }

  // Service role client — bypasses RLS for administrative row creation.
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Parse hook payload ────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return err({ error: "Invalid request body." });
  }

  // Supabase Auth after_user_created hook payload shape:
  // { type: "user.created", event: {...}, user: { id, email, user_metadata, ... } }
  const user = payload?.user as Record<string, unknown>;
  if (!user?.id || !user?.email) {
    console.error("after-user-created: missing user.id or user.email in payload.");
    return err({ error: "Missing user data in payload." });
  }

  const authUserId   = user.id as string;
  const teacherEmail = user.email as string;
  const metadata     = (user.user_metadata as Record<string, unknown>) ?? {};

  // ── Resolve series_id ─────────────────────────────────────────────────────
  // Email+password signups: series_id present in user_metadata (set by signup page).
  // OAuth signups: series_id absent — fall back to DEFAULT_SERIES_ID.
  // Both cases are correct by design — see hook comments above SERIES_DEFAULTS.
  const seriesId = (metadata?.series_id as string) || DEFAULT_SERIES_ID;

  if (!SERIES_DEFAULTS[seriesId]) {
    // Unknown series — log and continue with default rather than failing.
    // A failed hook blocks account creation entirely, which is worse than a
    // mismatched series that can be corrected manually.
    console.warn(`after-user-created: unrecognised series_id "${seriesId}" for ${teacherEmail}. Falling back to default.`);
  }

  // ── Resolve timezone ──────────────────────────────────────────────────────
  // Email+password signups: timezone present in user_metadata (set by signup page).
  // OAuth signups: timezone absent — fall back to UTC.
  // UTC is a safe default; teacher can correct in account settings.
  const timezone = (metadata?.timezone as string) || "UTC";

  // ── Fetch Config values ───────────────────────────────────────────────────
  // Read seat limit and token cap from Config table.
  // Fall back to safe defaults if Config fetch fails — don't block account creation.
  let studentSeatLimit = 1;   // free trial default: 1 seat
  let tokenCap: number | null = null;

  const { data: configRows, error: configErr } = await db
    .from("config")
    .select("config_key, config_value")
    .in("config_key", [CONFIG_KEY_SEAT_LIMIT, CONFIG_KEY_TOKEN_CAP]);

  if (configErr) {
    console.warn("after-user-created: Config fetch failed, using hardcoded defaults.", configErr.message);
  } else if (configRows) {
    for (const row of configRows) {
      if (row.config_key === CONFIG_KEY_SEAT_LIMIT) {
        studentSeatLimit = parseInt(row.config_value, 10) || 1;
      }
      if (row.config_key === CONFIG_KEY_TOKEN_CAP) {
        tokenCap = parseInt(row.config_value, 10) || null;
      }
    }
  }

  // ── Step 1: Create Teachers row ───────────────────────────────────────────
  // Check first — idempotency guard in case hook fires more than once.
  const { data: existingTeacher } = await db
    .from("teachers")
    .select("teacher_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  let teacherId: string;

  if (existingTeacher?.teacher_id) {
    // Already exists — hook may have fired twice. Use existing row.
    teacherId = existingTeacher.teacher_id;
    console.log(`after-user-created: Teachers row already exists for ${teacherEmail} (${teacherId}). Skipping insert.`);
  } else {
    const { data: newTeacher, error: teacherErr } = await db
      .from("teachers")
      .insert({
        series_id:             seriesId,
        email:                 teacherEmail,
        auth_user_id:          authUserId,
        timezone:              timezone,
        // Schema defaults handle: assistant_personality, summary_style,
        // consent_given, always_offer_pdf, display_name (null until onboarding)
      })
      .select("teacher_id")
      .single();

    if (teacherErr || !newTeacher) {
      console.error("after-user-created: Teachers insert failed.", teacherErr?.message);
      // Return 500 — Supabase Auth will surface an error to the signup page.
      // Better to fail loudly here than silently create an orphaned auth.users record.
      return err({ error: "Failed to create teacher record." }, 500);
    }

    teacherId = newTeacher.teacher_id;
    console.log(`after-user-created: Teachers row created for ${teacherEmail} (${teacherId}).`);
  }

  // ── Step 2: Create free-trial Series_Subscriptions row ───────────────────
  // Check first — idempotency guard.
  const { data: existingSub } = await db
    .from("series_subscriptions")
    .select("sub_history_id")
    .eq("teacher_id", teacherId)
    .eq("series_id", seriesId)
    .maybeSingle();

  if (existingSub?.sub_history_id) {
    console.log(`after-user-created: Series_Subscriptions row already exists for teacher ${teacherId}. Skipping insert.`);
    return ok({ success: true, teacher_id: teacherId, note: "Existing records found — no inserts performed." });
  }

  const { error: subErr } = await db
    .from("series_subscriptions")
    .insert({
      teacher_id:          teacherId,
      series_id:           seriesId,
      changed_by:          "system",
      subscription_tier:   "free",
      subscription_status: "active",
      student_seat_limit:  studentSeatLimit,
      token_cap:           tokenCap,
      token_reset_date:    1,
      stt_quality_override: false,
      onboarding_complete: true,    // No onboarding at free tier per D-108
      enrolled_via:        "series_site",
      change_note:         "Free trial — self-registered via signup page",
    });

  if (subErr) {
    console.error("after-user-created: Series_Subscriptions insert failed.", subErr.message);
    // Non-fatal — Teachers row was created successfully.
    // Log the error; subscription row can be inserted manually if needed.
    // Don't return 500 here — a missing subscription row is recoverable;
    // rolling back account creation at this point would orphan the Teachers row.
    console.warn(`after-user-created: Teacher ${teacherId} created but subscription insert failed. Manual fix required.`);
    return ok({
      success: true,
      teacher_id: teacherId,
      warning: "Teacher record created but subscription row insert failed. Check logs.",
    });
  }

  console.log(`after-user-created: Complete. teacher_id=${teacherId}, series_id=${seriesId}, tier=free.`);
  return ok({ success: true, teacher_id: teacherId });
});