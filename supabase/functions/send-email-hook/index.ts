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

function buildEmailChangeEmail(
  seriesName: string,
  changeUrl: string,
  newEmail: string
): { subject: string; html: string } {
  const subject = `${seriesName} — Confirm your new email address`;

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
    <h2>Confirm your new email address</h2>
    <p>We received a request to change your login email address to <strong>${newEmail}</strong>. Click the button below to confirm this change.</p>

    <a href="${changeUrl}" class="cta-btn">Confirm new email address</a>

    <p class="note">If you did not request this change, you can safely ignore this email — your email address has not been changed.</p>
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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  // ── Guard: RESEND_API_KEY must be set ──
  if (!RESEND_API_KEY) {
    console.error("send-email-hook: RESEND_API_KEY secret is not set.");
    return new Response(JSON.stringify({ error: "Email service not configured." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Parse payload ──
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    console.error("send-email-hook: could not parse request body.");
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Extract fields ──
  const user       = payload?.user       as Record<string, unknown> ?? {};
  const email_data = payload?.email_data as Record<string, unknown> ?? {};

  const email           = user?.email           as string ?? "";
  const new_email       = user?.new_email        as string ?? "";
  const user_metadata   = user?.user_metadata    as Record<string, unknown> ?? {};
  const action_type     = email_data?.email_action_type as string ?? "";
  const token_hash      = email_data?.token_hash      as string ?? "";
  const token_hash_new  = email_data?.token_hash_new  as string ?? "";
  const redirect_to     = email_data?.redirect_to     as string ?? "";
  const site_url        = email_data?.site_url        as string ?? "";

  if (!email) {
    console.error("send-email-hook: missing email in payload.");
    return new Response(JSON.stringify({ error: "Missing email in payload." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Resolve series name ──
  const seriesId   = (user_metadata?.series_id as string) ?? "";
  const seriesName = SERIES_NAMES[seriesId] ?? "Creative Note";

  // ── Build confirmation URL from token_hash ──
  // confirmation_url is not reliably present in the Supabase payload.
  // Construct from token_hash + redirect_to instead.
  function buildUrl(hash: string, type: string): string {
    const base = site_url || "https://xaayekfrlphyyxenhcjl.supabase.co";
    return `${base}/auth/v1/verify?token=${hash}&type=${type}&redirect_to=${encodeURIComponent(redirect_to)}`;
  }

  // ── Route by action type ──
  let to: string;
  let emailContent: { subject: string; html: string };

  if (action_type === "signup") {
    to = email;
    emailContent = buildConfirmationEmail(seriesName, buildUrl(token_hash, "signup"));

  } else if (action_type === "recovery") {
    to = email;
    emailContent = buildPasswordResetEmail(seriesName, buildUrl(token_hash, "recovery"));

  } else if (action_type === "email_change") {
    // Send to new email to confirm ownership of the new address
    to = new_email || email;
    emailContent = buildEmailChangeEmail(
      seriesName,
      buildUrl(token_hash, "email_change"),
      new_email
    );

  } else if (action_type === "email_change_new") {
    // Secure Email Change ON: also send to current email to authorise the change
    to = email;
    emailContent = buildEmailChangeEmail(
      seriesName,
      buildUrl(token_hash_new, "email_change_new"),
      new_email
    );

  } else {
    // Unknown action type — return 200 so Supabase does not retry.
    console.warn(`send-email-hook: unhandled action type "${action_type}" for ${email}. No email sent.`);
    return new Response(null, { status: 200 });
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
      to: [to],
      subject: emailContent.subject,
      html: emailContent.html,
    }),
  });

  if (!resendRes.ok) {
    const detail = await resendRes.text();
    console.error("send-email-hook: Resend error:", detail);
    return new Response(JSON.stringify({ error: "Email delivery failed.", detail }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Empty 200 — Supabase Auth requires this to consider the hook successful.
  return new Response(null, { status: 200 });
});
