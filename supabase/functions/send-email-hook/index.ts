import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ── Secrets ────────────────────────────────────────────────────────────────
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

// ── Series display name map ────────────────────────────────────────────────
// Add one entry per series when new series are onboarded.
// Keyed by series_id UUID — matches what the signup page passes as user_metadata.
const SERIES_NAMES: Record<string, string> = {
  "96c05aaa-0329-4582-a35c-51423afc21dd": "WunderKeys",
};

// ── Shared email styles ────────────────────────────────────────────────────
const BASE_STYLES = `
  body { font-family: Arial, Helvetica, sans-serif; background: #fafafa; margin: 0; padding: 0; }
  .wrapper { max-width: 520px; margin: 40px auto; background: #ffffff;
             border: 1px solid #e9e9e9; border-radius: 12px; overflow: hidden; }
  .header { background: #f47c20; padding: 28px 36px; }
  .header h1 { margin: 0; font-family: Georgia, serif; font-size: 1.6rem;
               color: #ffffff; letter-spacing: -0.02em; }
  .header p { margin: 4px 0 0; font-size: 0.9rem; color: #ffe0c2; }
  .body { padding: 32px 36px; color: #171717; line-height: 1.6; }
  .body h2 { font-family: Georgia, serif; font-size: 1.15rem; margin: 0 0 12px;
             color: #171717; }
  .body p { margin: 0 0 16px; font-size: 0.95rem; color: #333; }
  .body ul { margin: 0 0 16px; padding-left: 20px; }
  .body ul li { font-size: 0.95rem; color: #333; margin-bottom: 6px; }
  .cta-btn { display: inline-block; background: #f47c20; color: #ffffff;
             text-decoration: none; font-weight: 700; font-size: 1rem;
             padding: 14px 28px; border-radius: 8px; margin: 8px 0 24px; }
  .note { font-size: 0.82rem; color: #888; }
  .footer { background: #f5f5f5; border-top: 1px solid #e9e9e9;
            padding: 16px 36px; font-size: 0.78rem; color: #aaa; }
`;

// ── Email builders ─────────────────────────────────────────────────────────

function buildConfirmationEmail(
  seriesName: string,
  confirmationUrl: string
): { subject: string; html: string } {
  const subject = `Welcome to ${seriesName} — Please confirm your email`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>${BASE_STYLES}</style></head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>${seriesName}</h1>
    <p>Powered by Creative Note</p>
  </div>
  <div class="body">
    <h2>Welcome! One quick step to get started.</h2>
    <p>Thanks for creating your ${seriesName} teacher account. Click the button below to confirm your email address and activate your free trial.</p>

    <a href="${confirmationUrl}" class="cta-btn">Confirm my email address</a>

    <p>After confirming, you will be taken to the sign-in page. Sign in with the email and password you just created — then you are ready to go.</p>

    <p><strong>Here is what to expect with your free trial:</strong></p>
    <ul>
      <li>One student seat, fully functional for 30 days</li>
      <li>AI-generated lesson summaries and practice plans after each session</li>
      <li>Supplement recommendations matched to your student's lesson progress</li>
      <li>Practice plans delivered by email as a PDF — ready to share with families</li>
    </ul>

    <p>Bookmark your sign-in page once you are in — you will return to it before every lesson:</p>
    <p class="note"><strong>app.creativenoterest.com/wunderkeys/</strong></p>

    <p class="note">This confirmation link expires in 24 hours. If you did not create this account, you can safely ignore this email.</p>
  </div>
  <div class="footer">
    Creative Note &nbsp;·&nbsp; noreply@mail.creativenoterest.com<br>
    Having trouble? Contact your series administrator.
  </div>
</div>
</body>
</html>`;

  return { subject, html };
}

function buildPasswordResetEmail(
  seriesName: string,
  resetUrl: string
): { subject: string; html: string } {
  const subject = `${seriesName} — Password reset request`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>${BASE_STYLES}</style></head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>${seriesName}</h1>
    <p>Powered by Creative Note</p>
  </div>
  <div class="body">
    <h2>Reset your password</h2>
    <p>We received a request to reset the password for your ${seriesName} teacher account. Click the button below to choose a new password.</p>

    <a href="${resetUrl}" class="cta-btn">Reset my password</a>

    <p class="note">This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email — your password has not been changed.</p>
  </div>
  <div class="footer">
    Creative Note &nbsp;·&nbsp; noreply@mail.creativenoterest.com<br>
    Having trouble? Contact your series administrator.
  </div>
</div>
</body>
</html>`;

  return { subject, html };
}

// ── Main handler ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Supabase Auth calls this hook without a user JWT — no auth check needed.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY secret is not set.");
    return new Response(
      JSON.stringify({ error: "Email service not configured." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Extract fields from Supabase Auth hook payload ──
  const email      = (payload?.user as Record<string, unknown>)?.email as string;
  const metadata   = (payload?.user as Record<string, unknown>)?.user_metadata as Record<string, unknown> ?? {};
  const emailData  = payload?.email_data as Record<string, unknown> ?? {};
  const actionType = emailData?.email_action_type as string;

  if (!email) {
    return new Response(
      JSON.stringify({ error: "Missing email in payload." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Resolve series name from metadata ──
  const seriesId   = metadata?.series_id as string ?? "";
  const seriesName = SERIES_NAMES[seriesId] ?? "Creative Note";

  // ── Route by action type ──
  let emailContent: { subject: string; html: string };

  if (actionType === "signup") {
    const confirmationUrl = emailData?.confirmation_url as string;
    if (!confirmationUrl) {
      return new Response(
        JSON.stringify({ error: "Missing confirmation_url in payload." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    emailContent = buildConfirmationEmail(seriesName, confirmationUrl);

  } else if (actionType === "recovery") {
    const resetUrl = emailData?.confirmation_url as string;
    if (!resetUrl) {
      return new Response(
        JSON.stringify({ error: "Missing confirmation_url for recovery in payload." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    emailContent = buildPasswordResetEmail(seriesName, resetUrl);

  } else {
    // Unknown or unhandled action type — log and return success so Supabase
    // Auth does not retry. Do not send an email for unknown types.
    console.warn(`send-email-hook: unhandled action type "${actionType}" for ${email}. No email sent.`);
    return new Response(
      JSON.stringify({ success: true, note: "No email sent for this action type." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Send via Resend ──
  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Creative Note <noreply@mail.creativenoterest.com>",
      to: [email],
      subject: emailContent.subject,
      html: emailContent.html,
    }),
  });

  if (!resendRes.ok) {
    const detail = await resendRes.text();
    console.error("Resend error:", detail);
    return new Response(
      JSON.stringify({ error: "Email delivery failed.", detail }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});