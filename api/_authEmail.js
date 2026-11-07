// Supabase Auth "Send Email" hook: every auth email (sign-up code, reset
// link, magic link, email change, security notices) comes here instead of
// going out over SMTP, and is sent with one call to Resend's HTTP API.
//
// Why: over SMTP the hand-off from Supabase to Resend took ~2.9 s of every
// sign-up (auth_logs, Nov 2026), several round trips Mumbai -> mail server.
// One HTTPS request from bom1 is a fraction of that.
//
// Same sender (accounts@stocksaathi.co.in) and the same design as the
// Supabase templates. Code emails put the code in the subject, so Gmail
// shows each new code as its own email instead of stacking them in one
// conversation (people kept typing an older code).
//
// Request signing: Standard Webhooks (webhook-id / webhook-timestamp /
// webhook-signature), secret SEND_EMAIL_HOOK_SECRET = "v1,whsec_<base64>"
// from Supabase -> Auth Hooks. Unsigned or stale requests get 401, so
// nobody else can make us send mail.

const SITE = "https://stocksaathi.co.in";
const FROM = "StockSaathi <accounts@stocksaathi.co.in>";
const enc = new TextEncoder();

function env() { return globalThis.process?.env || {}; }
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function fail(status, message) { return json(status, { error: { http_code: status, message } }); }

function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function bytesToB64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifySignature(secret, id, ts, sigHeader, body, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !id || !ts || !sigHeader) return false;
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  const raw = String(secret).trim().replace(/^v1,/, "").replace(/^whsec_/, "");
  let keyBytes;
  try { keyBytes = b64ToBytes(raw); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = bytesToB64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${ts}.${body}`))));
  return String(sigHeader).split(" ").some((part) => {
    const i = part.indexOf(",");
    return i > 0 && part.slice(0, i) === "v1" && sameString(part.slice(i + 1), want);
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- design --
const MONO = "'SF Mono', Menlo, Consolas, 'Courier New', monospace";
const BARS = [50, 43, 50, 41, 45, 44, 34, 38, 27, 29, 19, 10, 11, 24, 16, 11, 18, 34, 40, 40, 57, 47, 61, 58, 50, 42, 40, 52, 46, 52, 59, 58, 63, 53, 43, 38, 46, 47, 45, 51, 53, 50, 62, 71, 67, 74]
  .map((h) => `<td valign="bottom" style="padding:0;"><div style="height:${h}px; background-color:#7FE8CB; font-size:1px; line-height:1px;">&nbsp;</div></td>`).join("");

function row(label, value) {
  return `<tr><td valign="top" style="padding:3px 12px 3px 0; white-space:nowrap;">${label}</td><td align="right" style="padding:3px 0; color:#111827; font-weight:700; word-break:break-all;">${value}</td></tr>`;
}

function card(rows, bottom = "") {
  return `<tr><td class="px-40" style="padding: 26px 40px 8px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2FCF8" style="background-color:#F2FCF8; border: 1px solid #C7F0DE; border-radius:14px;">
      <tr><td style="padding: 14px 20px; border-bottom: 1px dashed #A7E9CF;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-family: ${MONO}; font-size: 11px; color: #00875A; letter-spacing: 2px; font-weight: 700;">STOCKSAATHI</td>
          <td align="right" style="font-family: ${MONO}; font-size: 11px; color: #00875A; letter-spacing: 1px; font-weight: 700;"><span style="color:#00B386;">&#9679;</span> ACTIVE</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding: 14px 20px 0 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family: ${MONO}; font-size: 12px; color:#4B5563;">${rows.map(([l, v]) => row(l, v)).join("")}</table>
      </td></tr>
      ${bottom || `<tr><td style="padding:0 0 14px 0; font-size:1px; line-height:1px;">&nbsp;</td></tr>`}
    </table>
  </td></tr>`;
}

function codeBlock(code) {
  return `<tr><td align="center" style="padding: 20px 20px 6px 20px;"><div style="font-family: ${MONO}; font-size: 10px; color: #6B7280; letter-spacing: 2.5px; font-weight: 600;">VERIFICATION CODE</div></td></tr>
    <tr><td align="center" style="padding: 0 20px 22px 20px;"><div class="otp-code" style="font-family: ${MONO}; font-size: 42px; font-weight: 700; color: #00B386; letter-spacing: 14px; padding-left:14px;">${esc(code)}</div></td></tr>`;
}

function button(href, label) {
  return `<tr><td class="px-40" align="center" style="padding: 24px 40px 4px 40px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#00B386" style="background-color:#00B386; border-radius:10px;">
        <a href="${esc(href)}" target="_blank" style="display:inline-block; padding:15px 34px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-size:16px; font-weight:700; color:#FFFFFF; text-decoration:none; border-radius:10px;">${label} &rarr;</a>
      </td></tr></table>
    </td></tr>
    <tr><td class="px-40" style="padding: 14px 40px 0 40px;">
      <p style="margin:0; font-size:12px; line-height:18px; color:#9CA3AF; word-break:break-all;">Button not working? Paste this into your browser:<br>
      <a href="${esc(href)}" target="_blank" style="color:#00875A;">${esc(href)}</a></p>
    </td></tr>`;
}

function para(html, pad = "18px 40px 8px 40px") {
  return `<tr><td class="px-40" style="padding: ${pad};"><p style="margin:0; font-size:13px; line-height:20px; color:#6B7280;">${html}</p></td></tr>`;
}

const NEVER_SHARE = `<tr><td class="px-40" style="padding: 16px 40px 8px 40px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFBEB" style="background-color:#FFFBEB; border-left:3px solid #F59E0B; border-radius:8px;"><tr><td style="padding:14px 16px;">
    <div style="font-size:13px; line-height:20px; color:#92400E;"><strong>Never share this code.</strong> StockSaathi will <u>never</u> ask you for it &mdash; not over call, SMS, email, or WhatsApp.</div>
  </td></tr></table>
</td></tr>`;

function layout({ title, preheader, heading, intro, body }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${esc(title)}</title>
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
  @media screen and (max-width: 600px) {
    .container { width: 100% !important; }
    .px-40 { padding-left: 22px !important; padding-right: 22px !important; }
    .hero-title { font-size: 22px !important; line-height: 30px !important; }
    .otp-code { font-size: 34px !important; letter-spacing: 8px !important; }
    .tape { font-size: 10px !important; letter-spacing: 0.5px !important; }
    .hide-sm { display: none !important; }
  }
</style></head>
<body style="margin:0; padding:0; background-color:#F3F6F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
<div style="display:none; font-size:1px; color:#F3F6F4; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F6F4" style="background-color:#F3F6F4;"><tr><td align="center" style="padding: 32px 16px;">
<table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:560px; max-width:560px; background-color:#ffffff; border-radius:20px; overflow:hidden;">
  <tr><td bgcolor="#0B1F17" style="background-color:#0B1F17; padding: 10px 24px;">
    <div class="tape" style="font-family: ${MONO}; font-size: 11px; letter-spacing: 1px; color:#D1FAE5; white-space:nowrap; overflow:hidden;">
      <span style="color:#00D09C;">&#9650;</span> NSE &nbsp; <span style="color:#00D09C;">&#9650;</span> BSE &nbsp; <span style="color:#00D09C;">&#9650;</span> NIFTY 50 &nbsp; <span style="color:#00D09C;">&#9650;</span> SENSEX &nbsp; <span style="color:#00D09C;">&#9650;</span> &#8377;1,00,000 VIRTUAL CASH<span class="hide-sm"> &nbsp; <span style="color:#00D09C;">&#9650;</span> ZERO REAL RISK</span>
    </div>
  </td></tr>
  <tr><td bgcolor="#00B386" class="px-40" style="background-color:#00B386; background-image: linear-gradient(135deg, #00B386 0%, #00D09C 100%); padding: 26px 40px 0 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="40" height="40" align="center" valign="middle" bgcolor="#FFFFFF" style="width:40px; height:40px; background-color:#FFFFFF; border-radius:10px; font-family: Georgia, serif; font-size: 20px; font-weight: bold; color:#00B386; line-height:40px;">&#8377;</td>
        <td style="vertical-align: middle; padding-left: 12px;"><div style="font-size: 19px; font-weight: 700; color: #FFFFFF; letter-spacing: -0.3px;">StockSaathi</div><div style="font-size: 12px; color: #E6FBF3; margin-top: 2px;">Invest virtually. <strong style="color:#FFFFFF;">Learn for real.</strong></div></td>
      </tr></table>
    </td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr>
      <td style="font-family: ${MONO}; font-size:10px; letter-spacing:2px; color:#D4F7EA; font-weight:700;">STARTING CAPITAL</td>
      <td align="right" style="font-family: ${MONO}; font-size:10px; letter-spacing:1.5px; color:#FFFFFF; font-weight:700;">VIRTUAL &middot; 0 REAL RISK</td>
    </tr><tr><td colspan="2" style="padding-top:4px; font-family: ${MONO}; font-size:30px; font-weight:700; color:#FFFFFF; letter-spacing:-0.5px;">&#8377;1,00,000<span style="color:#B8F5DE;">.00</span></td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px; table-layout:fixed;"><tr>${BARS}</tr></table>
  </td></tr>
  <tr><td class="px-40" style="padding: 36px 40px 8px 40px;">
    <h1 class="hero-title" style="margin:0 0 10px 0; font-size:26px; line-height:34px; color:#111827; font-weight:700; letter-spacing:-0.5px;">${esc(heading)}</h1>
    <p style="margin:0; font-size:15px; line-height:24px; color:#4B5563;">${intro}</p>
  </td></tr>
  ${body}
  <tr><td style="padding: 0 40px;"><div style="height:1px; background-color:#E5E7EB; line-height:1px; font-size:1px;">&nbsp;</div></td></tr>
  <tr><td class="px-40" style="padding: 26px 40px 34px 40px; text-align:center;">
    <div style="font-size:12px; color:#9CA3AF; line-height:20px;">StockSaathi is a paper-trading simulator. No real money is involved.</div>
    <div style="margin-top:14px;">
      <a href="${SITE}" target="_blank" style="color:#00875A; font-size:12px; font-weight:600; text-decoration:none; margin:0 8px;">stocksaathi.co.in</a><span style="color:#D1D5DB;">&bull;</span>
      <a href="${SITE}/privacy" target="_blank" style="color:#00875A; font-size:12px; font-weight:600; text-decoration:none; margin:0 8px;">Privacy</a><span style="color:#D1D5DB;">&bull;</span>
      <a href="${SITE}/terms" target="_blank" style="color:#00875A; font-size:12px; font-weight:600; text-decoration:none; margin:0 8px;">Terms</a>
    </div>
    <div style="margin-top:16px; font-size:11px; color:#9CA3AF;">&copy; ${new Date().getFullYear()} StockSaathi</div>
  </td></tr>
</table>
<table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px; max-width:560px;"><tr>
  <td align="center" style="padding: 20px 16px 0 16px; font-size:11px; color:#9CA3AF; line-height:18px;">You're receiving this because someone entered this email address on stocksaathi.co.in.</td>
</tr></table>
</td></tr></table>
</body></html>`;
}

const FOOT_TEXT = "\n\nStockSaathi is a paper-trading simulator. No real money is involved.\nhttps://stocksaathi.co.in";

// ---------------------------------------------------------------- emails --
function linkFor(page, tokenHash, type) {
  return `${SITE}/${page}?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}`;
}

function codeEmail({ code, heading, intro, typeLabel, preheader, title }) {
  return {
    subject: `${code} is your StockSaathi code`,
    html: layout({
      title, preheader, heading, intro,
      body: card([["TYPE", typeLabel], ["VALIDITY", "10 MIN"], ["QTY", "1 &middot; EXECUTES ONCE"]], codeBlock(code))
        + para("Code expired? Just go back to StockSaathi and request a fresh one.")
        + NEVER_SHARE
        + para("Didn't request this? You can safely ignore this email. Nobody can get in without the code.", "20px 40px 36px 40px"),
    }),
    text: `${heading}\n\nYour StockSaathi code: ${code}\nIt expires in 10 minutes.\n\nNever share this code. StockSaathi will never ask you for it.\nDidn't request this? Ignore this email.${FOOT_TEXT}`,
  };
}

function linkEmail({ subject, title, preheader, heading, intro, typeLabel, account, href, buttonLabel, ignore }) {
  return {
    subject,
    html: layout({
      title, preheader, heading, intro,
      body: card([["TYPE", typeLabel], ["ACCOUNT", esc(account)], ["QTY", "1 &middot; EXECUTES ONCE"]])
        + button(href, buttonLabel)
        + para(ignore, "20px 40px 36px 40px"),
    }),
    text: `${heading}\n\n${buttonLabel}: ${href}\n\n${ignore}${FOOT_TEXT}`,
  };
}

const NOTICES = {
  password_changed_notification: ["Your password was changed", "The password for your StockSaathi account was just changed."],
  email_changed_notification: ["Your email address was changed", "The email address on your StockSaathi account was just changed."],
  phone_changed_notification: ["Your phone number was changed", "The phone number on your StockSaathi account was just changed."],
  identity_linked_notification: ["A sign-in method was added", "A new way to sign in was just linked to your StockSaathi account."],
  identity_unlinked_notification: ["A sign-in method was removed", "A way to sign in was just removed from your StockSaathi account."],
  mfa_factor_enrolled_notification: ["Two-step login was turned on", "A new two-step login method was added to your StockSaathi account."],
  mfa_factor_unenrolled_notification: ["Two-step login was turned off", "A two-step login method was removed from your StockSaathi account."],
};

function noticeEmail(type, account) {
  const [heading, intro] = NOTICES[type];
  const ignore = `If this was you, there's nothing to do. If it wasn't, reset your password at <a href="${SITE}/reset-password-request" style="color:#00875A;">stocksaathi.co.in/reset-password-request</a> and write to grievance@stocksaathi.co.in.`;
  return {
    subject: `StockSaathi: ${heading.toLowerCase()}`,
    html: layout({
      title: heading, preheader: intro, heading, intro: esc(intro),
      body: card([["TYPE", "SECURITY NOTICE"], ["ACCOUNT", esc(account)], ["WHEN", esc(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC")]])
        + para(ignore, "20px 40px 36px 40px"),
    }),
    text: `${heading}\n\n${intro}\n\nIf this wasn't you, reset your password at ${SITE}/reset-password-request and write to grievance@stocksaathi.co.in.${FOOT_TEXT}`,
  };
}

// Returns [{ to, subject, html, text }] for one hook call.
export function buildAuthEmails(payload) {
  const user = payload?.user || {};
  const d = payload?.email_data || {};
  const type = d.email_action_type;
  const email = user.email;
  const out = [];
  const push = (to, msg) => { if (to && msg) out.push({ to, ...msg }); };

  if (type === "signup" || type === "email") {
    push(email, codeEmail({
      code: d.token, title: "Your StockSaathi Verification Code", heading: "Verify your email",
      preheader: `Your StockSaathi code is ${d.token}. Valid for 10 minutes.`,
      intro: `Enter the code below on StockSaathi to verify your email and start trading. It expires in <strong style="color:#00875A;">10 minutes</strong>.`,
      typeLabel: "ACCOUNT ACCESS",
    }));
  } else if (type === "reauthentication") {
    push(email, codeEmail({
      code: d.token, title: "Confirm it's you", heading: "Confirm it's you",
      preheader: `Your StockSaathi code is ${d.token}.`,
      intro: `Enter this code on StockSaathi to confirm the change you asked for. It expires in <strong style="color:#00875A;">10 minutes</strong>.`,
      typeLabel: "CONFIRM CHANGE",
    }));
  } else if (type === "recovery") {
    push(email, linkEmail({
      subject: "Reset Your Password", title: "Reset Your StockSaathi Password", preheader: "Reset your StockSaathi password. Link works once.",
      heading: "Reset your password", intro: "Tap the button below to set a new password for your StockSaathi account.",
      typeLabel: "PASSWORD RESET", account: email, href: linkFor("reset-password", d.token_hash, "recovery"), buttonLabel: "Set new password",
      ignore: "Didn't request this? Ignore this email and your password stays exactly as it is.",
    }));
  } else if (type === "magiclink") {
    push(email, linkEmail({
      subject: "Your StockSaathi login link", title: "Log in to StockSaathi", preheader: "Your one-tap StockSaathi login link. Works once.",
      heading: "Log in to StockSaathi", intro: "Tap the button below to log in. The link works once.",
      typeLabel: "LOGIN LINK", account: email, href: linkFor("login", d.token_hash, "magiclink"), buttonLabel: "Log in",
      ignore: "Didn't request this? Ignore this email. Nobody can get in without the link.",
    }));
  } else if (type === "invite") {
    push(email, linkEmail({
      subject: "You're invited to StockSaathi", title: "You're invited to StockSaathi", preheader: "Accept your StockSaathi invite.",
      heading: "You're invited", intro: "Tap the button below to accept your invite and set up your StockSaathi account.",
      typeLabel: "INVITE", account: email, href: linkFor("login", d.token_hash, "invite"), buttonLabel: "Accept invite",
      ignore: "Not expecting this? You can ignore this email.",
    }));
  } else if (type === "email_change") {
    // Supabase's field names are swapped for backward compatibility:
    // token_hash_new goes to the CURRENT address, token_hash to the NEW one.
    const newEmail = user.new_email;
    const mk = (to, hash) => linkEmail({
      subject: "Confirm your new email address", title: "Confirm your email change", preheader: "Confirm the change to your StockSaathi email.",
      heading: "Confirm your email change", intro: `Tap the button below to confirm changing your StockSaathi email${newEmail ? ` to <strong>${esc(newEmail)}</strong>` : ""}.`,
      typeLabel: "EMAIL CHANGE", account: to, href: linkFor("login", hash, "email_change"), buttonLabel: "Confirm change",
      ignore: "Didn't ask for this? Ignore this email and nothing changes. Consider resetting your password.",
    });
    if (d.token_hash_new && d.token_hash) {
      push(email, mk(email, d.token_hash_new));
      push(newEmail, mk(newEmail, d.token_hash));
    } else if (d.token_hash) {
      push(newEmail || email, mk(newEmail || email, d.token_hash));
    }
  } else if (NOTICES[type]) {
    push(email, noticeEmail(type, email));
  }
  return out;
}

async function sendViaResend(msg, idemKey) {
  const key = env().RESEND_API_KEY;
  if (!key) throw new Error("resend_not_configured");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idemKey },
    body: JSON.stringify({ from: FROM, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`resend_http_${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r.json().catch(() => ({}));
}

// Sends every email one hook payload needs. One retry after a short pause:
// on the Postgres path nobody retries for us.
export async function sendAuthEmails(payload, idemBase) {
  const msgs = buildAuthEmails(payload);
  if (!msgs.length) return { ok: false, why: "unhandled_type", n: 0 };
  const one = async (m, i) => {
    try { return await sendViaResend(m, `${idemBase}-${i}`); }
    catch (e) { await new Promise((r) => setTimeout(r, 700)); return sendViaResend(m, `${idemBase}-${i}`); }
  };
  await Promise.all(msgs.map(one));
  return { ok: true, n: msgs.length };
}

// Postgres hook path: Supabase calls public.auth_send_email_hook(), which
// queues this request through pg_net with the Vault cron_secret and returns
// at once, so sign-up never waits for the email. `authorized` is the
// caller's cron-secret check.
export async function handleAuthEmailFromDb(req, authorized) {
  const t0 = Date.now();
  if (!authorized) return fail(401, "unauthorized");
  let payload;
  try { payload = await req.json(); } catch { return fail(400, "bad payload"); }
  const d = payload?.email_data || {};
  const type = d.email_action_type || "?";
  const idem = `auth-${type}-${payload?.user?.id || "x"}-${d.token_hash || d.token || Date.now()}`.slice(0, 250);
  try {
    const r = await sendAuthEmails(payload, idem);
    console.log(JSON.stringify({ evt: "auth_email", via: "db", type, ok: r.ok, n: r.n, why: r.why, ms: Date.now() - t0, queued_ms: payload?.queued_at ? Date.now() - Date.parse(payload.queued_at) : undefined }));
    return r.ok ? json(200, {}) : fail(400, `unhandled email type ${type}`);
  } catch (e) {
    console.log(JSON.stringify({ evt: "auth_email", via: "db", type, ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 200) }));
    return fail(502, "email send failed");
  }
}

export async function handleAuthEmailHook(req) {
  const t0 = Date.now();
  const body = await req.text();
  const ok = await verifySignature(
    env().SEND_EMAIL_HOOK_SECRET,
    req.headers.get("webhook-id"), req.headers.get("webhook-timestamp"), req.headers.get("webhook-signature"),
    body,
  );
  if (!ok) return fail(401, "invalid signature");
  let payload;
  try { payload = JSON.parse(body); } catch { return fail(400, "bad payload"); }
  const type = payload?.email_data?.email_action_type || "?";
  const msgs = buildAuthEmails(payload);
  if (!msgs.length) {
    console.log(JSON.stringify({ evt: "auth_email", type, ok: false, why: "unhandled_type" }));
    return fail(400, `unhandled email type ${type}`);
  }
  const hookId = req.headers.get("webhook-id");
  try {
    await Promise.all(msgs.map((m, i) => sendViaResend(m, `auth-${hookId}-${i}`)));
  } catch (e) {
    console.log(JSON.stringify({ evt: "auth_email", type, ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 200) }));
    return fail(500, "email send failed");
  }
  console.log(JSON.stringify({ evt: "auth_email", type, ok: true, n: msgs.length, ms: Date.now() - t0 }));
  return json(200, {});
}
