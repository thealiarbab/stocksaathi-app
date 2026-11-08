// =============================================================================
// REGISTER — Signup + 6-digit OTP verification (no email links).
// =============================================================================

import {
  registerAccount, validateEmail, validatePassword, validateUsername,
  verifySignupOtp, resendSignupOtp, googleSignInLikely,
} from "../auth/accounts.js";
import { switchUser } from "../state.js";
import { navigate } from "../router.js";
import { wirePasswordToggle, finishSignIn } from "./login.js";
import { suggestEmail, checkEmailDomain, inboxLinkFor } from "../auth/emailCheck.js";
import { googleButtonHtml, wireGoogleButton } from "../components/googleButton.js";
import { triesBarHtml, runLockCountdown } from "../components/triesBar.js";

export function renderRegister(main) {
  let stage = "form";    // "form" → "otp" → done
  let pendingEmail = "";
  let pendingName = "";
  let resendCountdown = 0;
  let resendTimer = null;
  // Code emails sent this visit (times). Supabase makes every new code
  // replace the last one, so the screen always names the newest email.
  const sentAt = [];
  // "sending" while the sign-up call (which sends the email, ~3 s server
  // side) is still running; the code screen shows at once instead of the
  // button spinning.
  let sendState = "idle";
  let sendPromise = null;
  // An error from a sign-up that failed after the code screen was shown;
  // the form shows it when it re-renders.
  let pendingFormError = null;
  // What was typed, so "Change email" goes back to a filled-in form.
  const typed = { name: "", username: "", email: "" };
  // Addresses the user said are right despite a suggestion.
  const keptAsTyped = new Set();

  // From the login page: an account that never confirmed. Send a fresh code
  // and go straight to the code screen. (The address comes via
  // sessionStorage, never the URL, so analytics never sees it.)
  if (new URLSearchParams(location.search).get("verify")) {
    let email = "";
    try { email = sessionStorage.getItem("ss.verifyEmail") || ""; sessionStorage.removeItem("ss.verifyEmail"); } catch {}
    if (email) {
      pendingEmail = email;
      typed.email = email;
      stage = "otp";
      sendState = "sending";
      sendPromise = resendSignupOtp(email)
        .then(() => { sentAt.push(new Date()); sendState = "sent"; updateOtpStatus(); })
        .catch(() => { sendState = "unknown"; updateOtpStatus(); });
      startResendTimer();
    }
  }

  // If the user already has a session (e.g. they clicked the confirmation
  // link in a new tab + Supabase SDK picked up the URL hash + wrote the
  // session to localStorage), skip the register flow entirely.
  (async () => {
    try {
      const { sb } = await import("../db/supabase.js");
      const client = await sb();
      if (!client) return;
      const { data } = await client.auth.getSession();
      if (data?.session?.user) {
        const { refreshCurrentUser } = await import("../auth/accounts.js");
        await refreshCurrentUser();
        const { bootSync, loadAllFromDb } = await import("../db/sync.js");
        await bootSync();
        await loadAllFromDb();
        switchUser();
        navigate("/onboarding");
      }
    } catch {}
  })();

  render();

  function render() {
    if (stage === "otp") return renderOtp();
    return renderForm();
  }

  function renderForm() {
    // Drawn folded from the start when Google was on last time: folding it
    // after the check came back made the form flash for a moment.
    const foldEmail = googleSignInLikely();
    main.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h1>Create your StockSaathi account</h1>
          <p class="sub">Your ₹1,00,000 virtual portfolio is one minute away.</p>
          ${googleButtonHtml("Sign up with Google", { optimistic: true })}
          <button type="button" class="btn btn-ghost btn-block btn-lg" id="r-email-toggle"${foldEmail ? "" : " hidden"}>Sign up with email instead</button>

          <form class="auth-form" id="reg-form" autocomplete="on" novalidate${foldEmail ? " hidden" : ""}>
            <div class="field">
              <label class="label" for="r-name">Your full name</label>
              <input class="input" id="r-name" name="name" type="text" required autocomplete="name" placeholder="e.g. Ananya Sharma" />
            </div>
            <div class="field">
              <label class="label" for="r-username">Username</label>
              <div class="input-prefix">
                <span class="px">@</span>
                <input id="r-username" name="username" type="text" required autocomplete="username" placeholder="yourhandle" maxlength="24" autocapitalize="none" spellcheck="false" />
              </div>
              <div class="muted text-xs" id="r-username-hint" style="margin-top: 4px;">3-24 chars. Letters, numbers, underscores, dots.</div>
            </div>
            <div class="field">
              <label class="label" for="r-email">Email</label>
              <input class="input" id="r-email" name="email" type="email" required autocomplete="email" placeholder="you@gmail.com" autocapitalize="off" autocorrect="off" spellcheck="false" />
              <div class="email-hint" id="r-email-hint" role="status" aria-live="polite" hidden></div>
            </div>
            <div class="field">
              <label class="label" for="r-pw">Password</label>
              <div class="auth-pw-wrap">
                <input class="input" id="r-pw" name="password" type="password" required autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="At least 8 characters" minlength="8" />
                <button type="button" class="auth-pw-toggle" id="r-pw-toggle" aria-label="Show password" aria-pressed="false" tabindex="0">👁</button>
              </div>
              <div class="muted text-xs" style="margin-top: 4px;">At least 8 characters. Tip: tap the eye icon to check what you typed.</div>
            </div>

            <label class="reg-terms flex items-start gap-2" id="r-terms-box">
              <input type="checkbox" class="checkbox" id="r-terms" />
              <span><strong class="reg-terms-lead">Tick to agree to the Terms of Use and Privacy Policy.</strong>
              <span class="reg-terms-small">I understand StockSaathi is an <strong>educational paper-trading
              simulator</strong> with <strong>virtual money only</strong> &mdash; no real
              securities are bought or held. StockSaathi is not a SEBI-registered broker,
              investment adviser, or research analyst, and nothing here is investment advice
              or a SEBI-regulated recommendation. I accept that disputes arising from use of
              this app are not covered by SEBI's investor-protection or grievance-redressal
              mechanisms. I have read and agree to the
              <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> and
              <a href="/terms" target="_blank" rel="noopener">Terms of Use</a>.</span></span>
            </label>

            <div id="reg-error" role="alert"></div>
            <button type="submit" class="btn btn-primary btn-block btn-lg" id="reg-btn">Create account</button>
          </form>

          <div class="auth-switch">
            Already have an account? <a href="/login">Log in</a>
          </div>
        </div>
      </div>
    `;

    const form = main.querySelector("#reg-form");
    const errBox = main.querySelector("#reg-error");
    const btn = main.querySelector("#reg-btn");
    const emailInput = main.querySelector("#r-email");
    const hint = main.querySelector("#r-email-hint");
    const termsBox = main.querySelector("#r-terms-box");
    main.querySelector("#r-terms").addEventListener("change", () => termsBox.classList.remove("reg-terms-missing"));
    form.addEventListener("input", (e) => e.target.classList?.remove("input-missing"));
    if (pendingFormError) {
      const pe = pendingFormError;
      pendingFormError = null;
      queueMicrotask(() => {
        if (pe.html) {
          errBox.innerHTML = pe.html;
          try { errBox.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
        } else {
          showErr(pe.msg);
        }
      });
    }
    // Show / hide password toggle. Critical on mobile where users can't
    // see what swipe-input / autocorrect actually typed.
    wirePasswordToggle(main, "#r-pw", "#r-pw-toggle");
    // Google first (8 Nov): in one week every visitor who used Google
    // finished signing up (130 of 130), against 42% on the email form. Once
    // the Google button is confirmed, the email form folds behind a button,
    // unless the visitor already typed in it or there is something to show.
    const regForm = main.querySelector("#reg-form");
    const emailToggle = main.querySelector("#r-email-toggle");
    const openEmail = (focus) => {
      regForm.hidden = false;
      emailToggle.hidden = true;
      if (focus) { try { main.querySelector("#r-name")?.focus(); } catch {} }
    };
    emailToggle.addEventListener("click", () => openEmail(true));
    wireGoogleButton(main, (msg) => { openEmail(false); showErr(msg); }, finishSignIn, "signup_with", () => {
      const typed = [...regForm.querySelectorAll("input")].some(i => i.type !== "checkbox" && i.value.trim());
      if (typed || regForm.contains(document.activeElement) || errBox.textContent.trim()) return;
      regForm.hidden = true;
      emailToggle.hidden = false;
    }).then((shown) => { if (shown === false) openEmail(false); });   // Google is off: the form is the only way

    // Start loading the database client now, not when Create account is
    // pressed: the sign-up call used to wait for it first.
    import("../db/supabase.js").then(m => m.sb()).catch(() => {});

    // "Username already taken" showed 60 times on 18 Oct, each only after
    // pressing Create account. Check as soon as the student leaves the box.
    const unameInput = main.querySelector("#r-username");
    const unameHint = main.querySelector("#r-username-hint");
    const UNAME_HELP = unameHint.textContent;
    let unameSeq = 0;
    unameInput.addEventListener("blur", async () => {
      const u = unameInput.value.trim().replace(/\s+/g, "_").replace(/[^a-z0-9_.]/gi, "").slice(0, 24).toLowerCase();
      const mine = ++unameSeq;
      unameHint.textContent = UNAME_HELP;
      unameHint.classList.remove("error-text");
      if (validateUsername(u)) return;
      try {
        const { sb } = await import("../db/supabase.js");
        const client = await sb();
        if (!client) return;
        const { data } = await client.rpc("profile_by_username", { p_username: u });
        if (mine !== unameSeq) return;
        if (Array.isArray(data) && data.length > 0) {
          unameHint.textContent = `@${u} is already taken. Try another, like ${u}${Math.floor(10 + Math.random() * 89)}.`;
          unameHint.classList.add("error-text");
        }
      } catch {}
    });

    main.querySelector("#r-name").value = typed.name;
    main.querySelector("#r-username").value = typed.username;
    emailInput.value = typed.email;

    // "Did you mean ananya@gmail.com?" One tap fixes it; "No" keeps it.
    function showSuggestion(fromSubmit) {
      const email = emailInput.value.trim();
      const s = keptAsTyped.has(email.toLowerCase()) ? null : suggestEmail(email);
      if (!s) { hint.hidden = true; hint.innerHTML = ""; return false; }
      const at = s.lastIndexOf("@");
      hint.innerHTML = `
        <span>Did you mean <strong>${escapeHtml(s.slice(0, at))}@<u>${escapeHtml(s.slice(at + 1))}</u></strong>?</span>
        <span class="email-hint-actions">
          <button type="button" class="btn btn-primary btn-sm" data-hint="use">Yes, fix it</button>
          <button type="button" class="btn btn-ghost btn-sm" data-hint="keep">No, mine is right</button>
        </span>`;
      hint.classList.toggle("email-hint-urgent", !!fromSubmit);
      hint.hidden = false;
      hint.querySelector('[data-hint="use"]').addEventListener("click", () => {
        emailInput.value = s;
        hint.hidden = true;
        if (fromSubmit) form.requestSubmit(); else emailInput.focus();
      });
      hint.querySelector('[data-hint="keep"]').addEventListener("click", () => {
        keptAsTyped.add(email.toLowerCase());
        hint.hidden = true;
        if (fromSubmit) form.requestSubmit();
      });
      return true;
    }
    let hintTimer = null;
    emailInput.addEventListener("input", () => {
      clearTimeout(hintTimer);
      // Wait for a pause, and only once there's something after the @.
      hintTimer = setTimeout(() => { if (/@[^@]+\.[^@]{2,}$/.test(emailInput.value.trim())) showSuggestion(false); else hint.hidden = true; }, 700);
    });
    emailInput.addEventListener("blur", () => { clearTimeout(hintTimer); showSuggestion(false); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.innerHTML = "";

      const name = main.querySelector("#r-name").value.trim();
      const username = main.querySelector("#r-username").value.trim().replace(/\s+/g, "_").replace(/[^a-z0-9_.]/gi, "").slice(0, 24);
      const email = emailInput.value.trim().replace(/\s+/g, "");
      typed.name = name; typed.username = username; typed.email = email;
      // Trim password too — mobile autofill / swipe-input frequently leaves
      // trailing spaces that the user can't see.
      const pw = main.querySelector("#r-pw").value.trim();

      main.querySelectorAll(".input-missing").forEach((el) => el.classList.remove("input-missing"));
      termsBox.classList.remove("reg-terms-missing");
      if (!name || name.length < 2) return showErr("Please enter your full name.", "#r-name");
      if (!username) return showErr("Pick a username.", "#r-username");
      if (!email) return showErr("Enter your email address. Your sign-up code goes there.", "#r-email");
      if (!pw) return showErr("Choose a password (at least 8 characters).", "#r-pw");
      const uerr = validateUsername(username); if (uerr) return showErr(uerr, "#r-username");
      // A likely typo stops the submit once; the user picks the fix or keeps it.
      if (showSuggestion(true)) { hint.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
      if (!validateEmail(email)) return showErr("Enter a valid email address.", "#r-email");
      const perr = validatePassword(pw); if (perr) return showErr(perr, "#r-pw");
      if (!main.querySelector("#r-terms").checked) {
        termsBox.classList.add("reg-terms-missing");
        return showErr("Tick the box above to agree to the Terms, then press Create account.");
      }

      btn.disabled = true;
      btn.textContent = "Creating account…";
      // Supabase sends the email inside the sign-up call, so it can take a
      // few seconds; say what is happening so nobody taps again.
      const slowTimer = setTimeout(() => { if (btn.disabled) btn.textContent = "Sending your code…"; }, 3000);
      // A domain that doesn't exist can never receive the code (and every
      // bounce hurts delivery for everyone else). Unknown = let it through.
      const domainState = await checkEmailDomain(email);
      if (domainState === "nodomain" || (domainState === "nomx" && !keptAsTyped.has(email.toLowerCase()))) {
        btn.disabled = false;
        btn.textContent = "Create account";
        const domain = email.split("@")[1] || "";
        if (domainState === "nomx") keptAsTyped.add(email.toLowerCase());   // second press goes through
        return showErr(domainState === "nodomain"
          ? `"${domain}" isn't a real email domain, so your code could never arrive. Check the part after the @.`
          : `"${domain}" doesn't seem to accept email. Check the part after the @, or press Create account again if you're sure.`);
      }
      // Show the code screen now; the account is created and the email
      // sent in the background (the email alone is ~3 s on Supabase's side).
      clearTimeout(slowTimer);
      pendingEmail = email;
      pendingName = name;
      sendState = "sending";
      stage = "otp";
      startResendTimer();
      render();
      const signupPromise = registerAccount({ username, email, password: pw, displayName: name });
      sendPromise = signupPromise.then(() => {}, () => {});
      // Slow is not failed: past 15 s the email usually still arrives, so
      // say so on the code screen instead of throwing the user back.
      const slowNote = setTimeout(() => {
        if (sendState === "sending") { sendState = "slow"; updateOtpStatus(); }
      }, 15000);
      try {
        const res = await signupPromise;
        clearTimeout(slowNote);
        if (res && res.needsConfirmation) {
          sentAt.push(new Date());
          sendState = "sent";
          updateOtpStatus();
          return;
        }
        // Already signed in (email confirmation off)
        sendState = "sent";
        await finishSignIn();
      } catch (err) {
        clearTimeout(slowNote);
        sendState = "idle";
        if (stage === "otp") {
          if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
          stage = "form";
        }
        // Email-already-registered is a super common case — send them to
        // /login with the email prefilled instead of leaving them staring
        // at a red error that says "log in instead" with no link.
        if (err.code === "email_already_registered" || /already exists|already registered/i.test(err.message || "")) {
          pendingFormError = { html: `<div class="error-msg">
            An account with <strong>${escapeHtml(email)}</strong> is already registered.
            <a href="/login?email=${encodeURIComponent(email)}" style="margin-left:6px;">Log in →</a>
            <span class="dim" style="margin:0 4px;">or</span>
            <a href="/reset-password-request">reset your password</a>
          </div>` };
        } else {
          pendingFormError = { msg: err.message || "Sign-up failed. Check your connection and try again." };
        }
        render();
      }
    });

    // On a phone the error box can sit below the keyboard or off screen; a
    // student who sees nothing happen taps again (92 rapid repeat taps on
    // Create account, 18 Oct). Bring it into view.
    // field: the input to mark and focus. The message sits right above the
    // button, where the eye already is.
    function showErr(msg, field) {
      errBox.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
      const el = field ? main.querySelector(field) : null;
      if (el) { el.classList.add("input-missing"); try { el.focus({ preventScroll: true }); } catch {} }
      try { (el || errBox).scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
    }
  }

  function renderOtp() {
    const inbox = inboxLinkFor(pendingEmail);
    // OTP-first UX: the 6-digit code input is primary. The link in the same
    // email also works (onAuthStateChange picks up the session) — we list it
    // quietly as a fallback. Requires the Supabase "Confirm signup" template
    // to include {{ .Token }} — see SUPABASE_SETUP.md.
    main.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div style="text-align: center; margin-bottom: var(--sp-4);">
            <div style="font-size: 48px; margin-bottom: var(--sp-2);">📬</div>
            <h1>Check your email</h1>
            <p class="sub">Your code goes to <strong>${escapeHtml(pendingEmail)}</strong>. Enter it below to activate your account.</p>
            <div id="otp-status" class="otp-status" role="status" aria-live="polite"></div>
          </div>

          <div class="otp-spam-tip">
            <p><strong>Not in your inbox?</strong> Look in <strong>Spam</strong> and <strong>Promotions</strong>. It's from <strong>StockSaathi</strong> (accounts@stocksaathi.co.in) and usually arrives within a minute.</p>
            <p class="dim">Found it in Spam? Mark it "Not spam" so future emails reach your inbox.</p>
            ${inbox ? `<a class="btn btn-ghost btn-sm otp-inbox-btn" href="${inbox.href}" target="_blank" rel="noopener">${inbox.label} ↗</a>` : ""}
          </div>

          <form class="auth-form" id="otp-form" autocomplete="off">
            <div class="field">
              <label class="label" for="otp-input">Verification code</label>
              <input class="input" id="otp-input" type="text" inputmode="numeric" pattern="[0-9]{4,10}" maxlength="10" required
                placeholder="Enter the code" autocomplete="one-time-code"
                style="font-family: var(--font-mono); letter-spacing: 0.25em; text-align: center; font-size: var(--text-xl); font-weight: 700;" />
              <div class="dim text-xs" id="otp-hint" style="margin-top: 6px; text-align: center;">Paste or type the code from the email.</div>
            </div>

            <div id="otp-error" role="alert"></div>

            <button type="submit" class="btn btn-primary btn-block btn-lg" id="otp-btn">Verify and continue</button>
          </form>

          <div id="otp-waiting" class="dim text-xs" style="display:flex;align-items:center;justify-content:center;gap:var(--sp-2);margin-top:var(--sp-3);">
            <span class="spinner" aria-hidden="true"></span>
            <span>Or click the link in the email — we'll sign you in automatically.</span>
          </div>

          <div style="text-align: center; margin-top: var(--sp-3); font-size: var(--text-sm); color: var(--text-muted);">
            Didn't get it? <button type="button" class="btn-link" id="resend-btn"
              style="font-size: var(--text-sm); padding: 0;" disabled>Resend email</button>
            <span id="resend-countdown" class="dim"></span>
          </div>

          <details id="otp-trouble" class="dim text-xs" style="margin-top: var(--sp-3); text-align: left;">
            <summary style="cursor:pointer; text-align:center;">Still nothing?</summary>
            <div style="padding: var(--sp-3); line-height: 1.6;">
              <p style="margin: 0 0 8px 0;"><strong>Check the address above.</strong> One wrong letter and the code goes nowhere. Tap "Change email" to fix it.</p>
              <p style="margin: 0 0 8px 0;"><strong>Email has a button but no code?</strong> Tap the button in the email instead; we'll sign you in here automatically.</p>
              <p style="margin: 0;"><strong>School or office address?</strong> Some of those block outside email. A personal Gmail works best.</p>
            </div>
          </details>

          <div class="auth-switch">
            Wrong email? <a href="#" id="back-to-form">Change email</a>
          </div>
        </div>
      </div>
    `;

    const form = main.querySelector("#otp-form");
    const errBox = main.querySelector("#otp-error");
    const btn = main.querySelector("#otp-btn");
    const resendBtn = main.querySelector("#resend-btn");
    const otpInput = main.querySelector("#otp-input");
    otpInput?.focus();
    otpInput?.addEventListener("input", () => {
      const digits = otpInput.value.replace(/\D/g, "").slice(0, 10);
      if (digits !== otpInput.value) otpInput.value = digits;
    });
    otpInput?.addEventListener("paste", (e) => {
      const digits = (e.clipboardData?.getData("text") || "").replace(/\D/g, "");
      if (!/^\d{6,10}$/.test(digits)) return;
      e.preventDefault();
      otpInput.value = digits;
      form.requestSubmit();
    });
    updateOtpStatus();

    // ----- Primary path: auto-advance when Supabase establishes a session.
    // Fires when the user clicks the confirmation link (either in this tab
    // via emailRedirectTo or in another tab — the session is written to
    // localStorage key ss.sb.session.v1 and the storage event propagates).
    let authUnsub = null;
    (async () => {
      const { sb } = await import("../db/supabase.js");
      const client = await sb();
      if (!client) return;
      // Deferred: never run Supabase calls inside this callback (see db/sync.js).
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if ((event === "SIGNED_IN" || event === "USER_UPDATED") && session?.user) {
          setTimeout(onSignedIn, 0);
        }
      });
      authUnsub = () => data?.subscription?.unsubscribe?.();
      // Also check NOW — user may have arrived with a session already.
      const cur = await client.auth.getSession();
      if (cur.data?.session) onSignedIn();
    })();

    async function onSignedIn() {
      if (stage !== "otp") return;
      try {
        if (resendTimer) clearInterval(resendTimer);
        authUnsub?.();
        await finishSignIn();
      } catch (e) {
        console.warn("post-confirm flow failed:", e);
      }
    }

    // ----- Secondary path: user enters the numeric code manually.
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.innerHTML = "";
      const code = main.querySelector("#otp-input").value.trim().replace(/\s+/g, "");
      if (!/^\d{4,10}$/.test(code)) {
        errBox.innerHTML = `<div class="error-msg">Enter the code from your email (digits only).</div>`;
        return;
      }
      btn.disabled = true;
      btn.textContent = "Verifying…";
      try {
        // A code can't be checked before the account exists.
        if (sendState === "sending" || sendState === "slow") await sendPromise;
        if (stage !== "otp") return;
        await verifySignupOtp({ email: pendingEmail, code });
        await onSignedIn();
      } catch (err) {
        // Supabase's "Token has expired or is invalid" (15 times on 18 Oct)
        // reads like a fault; it is almost always a typo or the code from an
        // older email after Resend.
        const newest = sentAt.length ? timeOf(sentAt[sentAt.length - 1]) : "";
        const msg = /expired|invalid/i.test(err.message || "")
          ? (sentAt.length > 1
            ? `That code didn't work. Only the newest code works: open the email sent at ${newest}. Codes from earlier emails stop working once a new one is sent.`
            : `That code didn't work. Check each digit against the email${newest ? ` sent at ${newest}` : ""}.`)
          : err.message;
        main.querySelector("#otp-input")?.select();
        if (err.code === "locked") {
          errBox.innerHTML = `<div class="error-msg"><strong>Too many wrong codes.</strong> Code entry is paused for this email. When the timer ends, press <strong>Resend email</strong> for a fresh code.${triesBarHtml(err, "wrong codes")}</div>`;
          btn.textContent = "Verify and continue";
          runLockCountdown(errBox, btn, () => { errBox.innerHTML = `<div class="dim text-sm">You can try again now. Press Resend email for a fresh code.</div>`; });
          return;
        }
        errBox.innerHTML = `<div class="error-msg">${escapeHtml(msg)}${triesBarHtml(err, "tries")}</div>`;
        btn.disabled = false;
        btn.textContent = "Verify and continue";
      }
    });

    resendBtn.addEventListener("click", async () => {
      resendBtn.disabled = true;
      errBox.innerHTML = "";
      const input = main.querySelector("#otp-input");
      if (input) input.value = "";
      sendState = "sending";
      updateOtpStatus();
      try {
        await resendSignupOtp(pendingEmail);
        sentAt.push(new Date());
        sendState = "sent";
        startResendTimer();
        updateOtpStatus(true);
        input?.focus();
      } catch (err) {
        sendState = sentAt.length ? "sent" : "unknown";
        updateOtpStatus();
        errBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
        resendBtn.disabled = false;
      }
    });

    main.querySelector("#back-to-form").addEventListener("click", (e) => {
      e.preventDefault();
      stage = "form";
      if (resendTimer) clearInterval(resendTimer);
      authUnsub?.();
      render();
    });

    updateResendUi();
  }

  function timeOf(d) {
    try { return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }); }
    catch { return d.toTimeString().slice(0, 5); }
  }

  // The line under "Check your email": sending, sent at what time, and after
  // a resend, that only the newest email's code works. Gmail stacks every
  // code email into one conversation, which is how people ended up typing
  // an older code (34 wrong-code errors in 3 days, Nov 2026).
  function updateOtpStatus(justResent = false) {
    const el = main.querySelector("#otp-status");
    if (!el) return;
    const n = sentAt.length;
    const last = n ? timeOf(sentAt[n - 1]) : "";
    let html;
    if (sendState === "sending") {
      html = `<span class="spinner" aria-hidden="true"></span> Sending your code…`;
    } else if (sendState === "slow") {
      html = `Still sending. It usually arrives within a minute; if not, press Resend below.`;
    } else if (n > 1) {
      html = `<strong>New code sent at ${last}.</strong> Use the code from that email only: earlier codes no longer work. In Gmail, open the conversation and scroll to the <strong>last</strong> message.`;
    } else if (n === 1) {
      html = `✓ Code sent at ${last}.`;
    } else {
      html = "";
    }
    el.innerHTML = html;
    el.classList.toggle("otp-status-warn", n > 1);
    if (justResent) {
      el.classList.remove("otp-status-flash");
      void el.offsetWidth;
      el.classList.add("otp-status-flash");
    }
  }

  function startResendTimer() {
    resendCountdown = 60;
    if (resendTimer) clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      resendCountdown--;
      if (resendCountdown <= 0) {
        clearInterval(resendTimer);
        resendTimer = null;
      }
      updateResendUi();
    }, 1000);
    updateResendUi();
  }

  function updateResendUi() {
    if (stage !== "otp") return;
    const btn = main.querySelector("#resend-btn");
    const cd = main.querySelector("#resend-countdown");
    if (!btn || !cd) return;
    if (resendCountdown > 0) {
      btn.disabled = true;
      cd.textContent = ` (${resendCountdown}s)`;
    } else {
      btn.disabled = false;
      cd.textContent = "";
    }
  }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
