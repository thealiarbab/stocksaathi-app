// Tries-left bar for wrong passwords and wrong sign-in codes.
// The server counts wrong tries per account (10 in a row locks the check
// for 15 minutes, api/ai.js authAttempt); errors from loginAccount and
// verifySignupOtp carry { left, max, lockedUntil } for this bar.

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// HTML for the bar, or "" when there is nothing to show yet.
export function triesBarHtml(err, noun = "tries") {
  if (!err) return "";
  const max = err.max || 10;
  if (err.lockedUntil && err.lockedUntil > Date.now()) {
    return `<div class="tries tries-locked" role="status" data-locked-until="${err.lockedUntil}">
      <div class="tries-track"><div class="tries-fill" style="width:0%"></div></div>
      <div class="tries-text">Locked for <strong class="tries-clock">${fmtLeft(err.lockedUntil - Date.now())}</strong> after ${max} wrong ${noun} in a row.</div>
    </div>`;
  }
  if (typeof err.left !== "number") return "";
  const pct = Math.max(0, Math.min(100, (err.left / max) * 100));
  const level = err.left <= 2 ? "tries-low" : err.left <= 5 ? "tries-mid" : "";
  return `<div class="tries ${level}" role="status">
    <div class="tries-track"><div class="tries-fill" style="width:${pct}%"></div></div>
    <div class="tries-text"><strong>${err.left}</strong> of ${max} ${noun} left before a 15-minute lock.</div>
  </div>`;
}

// Runs the lock countdown inside `root`; disables `btn` until it ends.
// Returns a stop function.
export function runLockCountdown(root, btn, onEnd) {
  const box = root?.querySelector?.(".tries-locked");
  if (!box) return () => {};
  const until = Number(box.dataset.lockedUntil) || 0;
  const clock = box.querySelector(".tries-clock");
  const label = btn ? btn.textContent : "";
  if (btn) btn.disabled = true;
  const tick = () => {
    const left = until - Date.now();
    if (left <= 0 || !box.isConnected) {
      clearInterval(t);
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
      if (box.isConnected) onEnd?.();
      return;
    }
    if (clock) clock.textContent = fmtLeft(left);
  };
  const t = setInterval(tick, 1000);
  tick();
  return () => clearInterval(t);
}
