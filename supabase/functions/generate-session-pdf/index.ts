import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(body, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  // ── Secrets ────────────────────────────────────────────────────────
  const SUPABASE_URL     = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const PDFSHIFT_API_KEY = Deno.env.get("PDFSHIFT_API_KEY");
  const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PDFSHIFT_API_KEY || !RESEND_API_KEY) {
    return err({ error: "Missing required environment secrets." }, 500);
  }

  // ── Service role client ────────────────────────────────────────────
  // Authorization enforced by verifying teacher_id owns the session (Step 1).
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Parse request body ─────────────────────────────────────────────
  let body;
  try { body = await req.json(); } catch { return err({ error: "Invalid request body." }); }

  const { session_id, send_type, teacher_id, to_emails } = body;
  if (!session_id || !send_type || !teacher_id) {
    return err({ error: "Missing required fields: session_id, send_type, teacher_id." });
  }
  if (!Array.isArray(to_emails) || to_emails.length === 0) {
    return err({ error: "to_emails must be a non-empty array of recipient addresses." });
  }
  if (!["auto", "manual"].includes(send_type)) {
    return err({ error: "send_type must be auto or manual." });
  }

  // ── Step 1: Read session and verify ownership ──────────────────────
  const { data: session, error: sessErr } = await db
    .from("sessions")
    .select("session_id, teacher_id, student_id, session_date, max_lesson_page, lesson_book_id, ai_summ_student, ai_summ_supplement_data, active_assignments_data")
    .eq("session_id", session_id)
    .single();

  if (sessErr || !session) return err({ error: "Session not found." }, 404);
  if (session.teacher_id !== teacher_id) return err({ error: "Unauthorized." }, 403);

  // ── Step 2: Read student ───────────────────────────────────────────
  const { data: student, error: stuErr } = await db
    .from("students")
    .select("safe_name, email_primary, email_primary_unsubscribed, email_secondary, email_secondary_unsubscribed, email_tertiary, email_tertiary_unsubscribed")
    .eq("student_id", session.student_id)
    .single();

  if (stuErr || !student) return err({ error: "Student record not found." }, 404);

  // ── Step 3: Validate recipient list ───────────────────────────────
  // Recipient selection is made by the teacher in the UI; to_emails is
  // already validated as non-empty above. Sanitise to strings only.
  const recipients = to_emails.filter((e: unknown) => typeof e === "string" && e.trim() !== "");

  // ── Step 4: Read book name ─────────────────────────────────────────
  let bookName = "Unknown book";
  if (session.lesson_book_id) {
    const { data: book } = await db
      .from("books")
      .select("full_display_name")
      .eq("book_id", session.lesson_book_id)
      .single();
    if (book) bookName = book.full_display_name;
  }

  // ── Step 5: Build supplement arrays ───────────────────────────────
  const supplements      = (session.ai_summ_supplement_data || []).slice(0, 3);
  const activeAssignments = (session.active_assignments_data || []);

  // ── Step 7: Build HTML for PDFShift ───────────────────────────────
  const sessionDate = session.session_date
    ? new Date(session.session_date).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })
    : "Date not recorded";
  const pageStr = session.max_lesson_page ? `Page ${session.max_lesson_page}` : "Page not recorded";

  const practiceLines = (session.ai_summ_student || "No practice plan recorded.")
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l === "" ? "<br>" : `<p style="margin:0 0 6px 0;">${l}</p>`)
    .join("");

  // Recommended supplement card — 44×56 portrait thumb matches screen, free/resource badge, fallback label
  function buildSupplementCard(s) {
    const badge = s.is_free === true
      ? `<span style="font-size:10px;font-weight:700;background:#F0FDF4;color:#16A34A;border-radius:3px;padding:1px 5px;margin-left:6px;">Free</span>`
      : s.is_free === false
        ? `<span style="font-size:10px;font-weight:700;background:#FCE4D6;color:#E26B0A;border-radius:3px;padding:1px 5px;margin-left:6px;">Resource</span>`
        : "";
    const thumb = s.thumbnail_url
      ? `<img src="${s.thumbnail_url}" width="44" height="56" style="object-fit:cover;flex-shrink:0;" />`
      : `<div style="width:44px;height:56px;background:#FCE4D6;flex-shrink:0;"></div>`;
    const titleEl = s.source_url
      ? `<a href="${s.source_url}" style="font-size:13px;font-weight:600;color:#E26B0A;text-decoration:none;">${s.title || "Untitled"}</a>`
      : `<span style="font-size:13px;font-weight:600;color:#1A1A1A;">${s.title || "Untitled"}</span>`;
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #E8E4DF;border-radius:8px;margin-bottom:8px;">
      ${thumb}
      <div style="flex:1;min-width:0;">
        <div>${titleEl}${badge}</div>
        ${s.pool === "fallback" ? `<div style="font-size:11px;color:#9A9A9A;margin-top:2px;">General resource</div>` : ""}
      </div>
    </div>`;
  }

  // Active supplement card — 44×56 portrait thumb, title only (no badge), matches screen
  function buildActiveSupplementCard(a) {
    const thumb = a.thumbnail_url
      ? `<img src="${a.thumbnail_url}" width="44" height="56" style="object-fit:cover;flex-shrink:0;" />`
      : `<div style="width:44px;height:56px;background:#FCE4D6;flex-shrink:0;"></div>`;
    const titleEl = a.source_url
      ? `<a href="${a.source_url}" style="font-size:13px;font-weight:600;color:#E26B0A;text-decoration:none;">${a.title || "Untitled"}</a>`
      : `<span style="font-size:13px;font-weight:600;color:#1A1A1A;">${a.title || "Untitled"}</span>`;
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #E8E4DF;border-radius:8px;margin-bottom:8px;">
      ${thumb}
      <div style="flex:1;min-width:0;">${titleEl}</div>
    </div>`;
  }

  const supplementCardsHtml = supplements.map(buildSupplementCard).join("");

  const activeSuppsHtml = activeAssignments.length > 0
    ? `<div style="font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#DB6E2B;margin-top:18px;margin-bottom:10px;">Active Supplements</div>
       <div>${activeAssignments.map(buildActiveSupplementCard).join("")}</div>`
    : "";

  const htmlPayload = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #1A1A1A; padding: 40px; max-width: 680px; margin: 0 auto; }
  .brand-header { background: #DB6E2B; padding: 20px 28px; margin: -40px -40px 28px -40px; }
  .brand-title { font-family: Georgia, serif; font-size: 1.35rem; color: #ffffff; margin: 0; }
  .brand-sub { font-size: 0.8rem; color: #ffe0c2; margin: 3px 0 0; }
  .meta { font-size: 13px; color: #555; margin-bottom: 28px; }
  h2 { font-size: 15px; color: #DB6E2B; border-bottom: 1px solid #E8E4DF; padding-bottom: 4px; margin-top: 28px; margin-bottom: 12px; }
  .practice { line-height: 1.65; }
</style>
</head>
<body>
  <div class="brand-header">
    <div class="brand-title">${student.safe_name} \u2014 Practice Plan</div>
    <div class="brand-sub">${sessionDate} &nbsp;&middot;&nbsp; ${bookName} &nbsp;&middot;&nbsp; ${pageStr}</div>
  </div>
  <h2>Practice Plan</h2>
  <div class="practice">${practiceLines}</div>
  ${activeSuppsHtml}
  ${supplementCardsHtml ? `<h2>Recommended Supplements</h2>${supplementCardsHtml}` : ""}
</body>
</html>`;

  // ── Step 8: Call PDFShift ──────────────────────────────────────────
  const pdfShiftRes = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa("api:" + PDFSHIFT_API_KEY),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: htmlPayload, landscape: false, use_print: false }),
  });

  if (!pdfShiftRes.ok) {
    const detail = await pdfShiftRes.text();
    console.error("PDFShift error:", detail);
    return err({ error: "PDF generation failed. Please try again." }, 502);
  }

  const pdfBuffer = await pdfShiftRes.arrayBuffer();

  // ── Chunked base64 conversion (avoids call stack overflow on large PDFs) ──
  function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  const pdfBase64 = bufferToBase64(pdfBuffer);

  // ── Step 9: Send via Resend ────────────────────────────────────────
  const fileName = `${student.safe_name.replace(/\s+/g, "_")}_Practice_Plan_${session.session_date || "unknown"}.pdf`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Creative Note <noreply@mail.creativenoterest.com>",
      to: recipients,
      subject: `${student.safe_name} -- Practice Plan ${sessionDate}`,
      text: `Hi,\n\nPlease find ${student.safe_name}'s practice plan attached.\n\nCreative Note`,
      attachments: [{ filename: fileName, content: pdfBase64 }],
      headers: { "List-Unsubscribe": "<mailto:unsubscribe@mail.creativenoterest.com>" },
    }),
  });

  if (!resendRes.ok) {
    const detail = await resendRes.text();
    console.error("Resend error:", detail);
    return err({ error: "Email delivery failed. Please try again." }, 502);
  }

  // ── Step 10: Log to pdf_email_log (non-blocking) ───────────────────
  const sentTo = recipients.join(", ");
  const { error: logErr } = await db.from("pdf_email_log").insert({
    session_id, teacher_id, sent_to: sentTo, send_type,
  });
  if (logErr) console.error("pdf_email_log insert failed (non-blocking):", logErr.message);

  // ── Step 11: Update Sessions (non-blocking) ────────────────────────
  const { error: updateErr } = await db
    .from("sessions")
    .update({ pdf_sent_at: new Date().toISOString(), pdf_sent_to: sentTo })
    .eq("session_id", session_id);
  if (updateErr) console.error("Sessions update failed (non-blocking):", updateErr.message);

  // ── Step 12: Return success ────────────────────────────────────────
  return ok({ success: true, sent_to: recipients });
});
