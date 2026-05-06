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

  const { session_id, send_type, teacher_id } = body;
  if (!session_id || !send_type || !teacher_id) {
    return err({ error: "Missing required fields: session_id, send_type, teacher_id." });
  }
  if (!["auto", "manual"].includes(send_type)) {
    return err({ error: "send_type must be auto or manual." });
  }

  // ── Step 1: Read session and verify ownership ──────────────────────
  const { data: session, error: sessErr } = await db
    .from("sessions")
    .select("session_id, teacher_id, student_id, session_date, max_lesson_page, lesson_book_id, ai_summ_student, ai_summ_supplement")
    .eq("session_id", session_id)
    .single();

  if (sessErr || !session) return err({ error: "Session not found." }, 404);
  if (session.teacher_id !== teacher_id) return err({ error: "Unauthorized." }, 403);

  // ── Step 2: Read student ───────────────────────────────────────────
  const { data: student, error: stuErr } = await db
    .from("students")
    .select("safe_name, email_primary, email_secondary, email_primary_unsubscribed")
    .eq("student_id", session.student_id)
    .single();

  if (stuErr || !student) return err({ error: "Student record not found." }, 404);

  // ── Step 3: Check unsubscribe ──────────────────────────────────────
  if (student.email_primary_unsubscribed) {
    return err({ error: "Student email is unsubscribed. No email sent." });
  }

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

  // ── Step 5: Build recipient list ───────────────────────────────────
  const recipients = [student.email_primary];
  if (student.email_secondary && student.email_secondary.trim() !== "") {
    recipients.push(student.email_secondary.trim());
  }

  // ── Step 6: Top 3 supplements ──────────────────────────────────────
  const supplementText = (session.ai_summ_supplement || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3)
    .join("\n");

  // ── Step 7: Build HTML for PDFShift ───────────────────────────────
  const sessionDate = session.session_date
    ? new Date(session.session_date).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })
    : "Date not recorded";
  const pageStr = session.max_lesson_page ? `Page ${session.max_lesson_page}` : "Page not recorded";

  function renderSupplementLine(line) {
    return line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2');
  }

  const supplementLines = supplementText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `<li style="margin-bottom:8px;">${renderSupplementLine(l)}</li>`)
    .join("");

  const practiceLines = (session.ai_summ_student || "No practice plan recorded.")
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l === "" ? "<br>" : `<p style="margin:0 0 6px 0;">${l}</p>`)
    .join("");

  const htmlPayload = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #1A1A1A; padding: 40px; max-width: 680px; margin: 0 auto; }
  h1 { font-size: 20px; color: #E26B0A; margin-bottom: 4px; }
  .meta { font-size: 13px; color: #555; margin-bottom: 28px; }
  h2 { font-size: 15px; color: #E26B0A; border-bottom: 1px solid #E8E4DF; padding-bottom: 4px; margin-top: 28px; margin-bottom: 12px; }
  .practice { line-height: 1.65; }
  ul { padding-left: 20px; margin: 0; }
  li { line-height: 1.6; }
</style>
</head>
<body>
  <h1>${student.safe_name} -- Practice Plan</h1>
  <div class="meta">${sessionDate} &nbsp;|&nbsp; ${bookName} &nbsp;|&nbsp; ${pageStr}</div>
  <h2>Practice Plan</h2>
  <div class="practice">${practiceLines}</div>
  ${supplementLines ? `<h2>Recommended Supplements</h2><ul>${supplementLines}</ul>` : ""}
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
  const pdfBase64 = btoa(String.fromCharCode(...new Uint8Array(pdfBuffer)));

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
