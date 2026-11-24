// =============================================================================
// COACH PANEL — Interactive chat. Right-docked on desktop, slide-over on
// mobile. Its lightweight launcher lives in coachLauncher.js.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";

let root;

// Routes where the coach panel is completely hidden
const COACH_HIDDEN_ROUTES = new Set(["", "/", "/login", "/register", "/chat"]);

function isCoachAllowed() {
  const state = getState();
  if (!state.isAuthed) return false;
  const path = location.pathname || "/";
  // A chat with an id (/chat/c_...) is the chat page too: the pop-up used to
  // open over it and show the same chat twice (seen 24 Nov 2026).
  if (COACH_HIDDEN_ROUTES.has(path) || path.startsWith("/chat/")) return false;
  return true;
}

export function mountCoachPanel() {
  root = document.getElementById("coach-root");
  if (!root) return;

  render();
  subscribe(render);
  window.addEventListener("ss:navigate", render);

  let wasOpenLastTick = false;
  let wasDrawerLastTick = false;
  // On phones and tablets the coach is a full-height drawer. Users couldn't
  // find their way out of it (rajveer 11 Oct, ayaan_lt 13 Oct: "chat hat hi
  // nahi rahi"): the only exit was a small ✕. Now the phone's Back button,
  // Esc and a swipe to the right also close it. Opening pushes a history
  // entry carrying ssCoach; Back pops it (navigation.js skips re-rendering
  // a same-URL pop) and the popstate listener below closes the drawer.
  const closeDrawer = () => setSetting("coachPanelOpen", false);
  let closingByNav = false;
  window.addEventListener("popstate", () => {
    if (!history.state?.ssCoach && wasDrawerLastTick) closeDrawer();
  });
  window.addEventListener("ss:navigate", () => {
    // A link inside the drawer moved the page underneath it: show the page.
    if (wasDrawerLastTick && window.innerWidth < 768) { closingByNav = true; closeDrawer(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !wasDrawerLastTick) return;
    // Esc closes the thing on top first: a sheet, a menu, the chat list, or a
    // reply that is still being written. Only then the pop-up itself.
    if (document.querySelector(".modal-overlay, .term-pop-overlay, .cc-modal-wrap, .ts-sheet, .cc-head-menu, .cc-item-menu")) return;
    if (root.querySelector(".cc.is-drawer-open")) return;
    const stop = root.querySelector("#chat-stop");
    if (stop && !stop.hidden && stop.offsetParent) return;
    closeDrawer();
  });
  let touchX = null, touchY = null;
  root.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  root.addEventListener("touchend", (e) => {
    if (touchX == null || !wasDrawerLastTick) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX, dy = Math.abs(t.clientY - touchY);
    touchX = touchY = null;
    if (dx > 80 && dy < 60) closeDrawer();
  }, { passive: true });

  const applyVisibility = () => {
    const allowed = isCoachAllowed();
    const state = getState();
    if (!allowed) {
      document.body.classList.remove("coach-docked");
      root.classList.remove("open");
      root.style.display = "none";
      document.body.classList.remove("coach-drawer-open");
      wasOpenLastTick = false;
      wasDrawerLastTick = false;
      return;
    }
    root.style.display = "";
    const shouldDock = window.innerWidth >= 1280 && state.settings.coachPanelOpen;
    const shouldOpen = !shouldDock && state.settings.coachPanelOpen;
    if (shouldDock) {
      document.body.classList.add("coach-docked");
    } else {
      document.body.classList.remove("coach-docked");
      root.classList.toggle("open", shouldOpen);
    }
    // Focus the chat input ONLY on the closed → open transition, not on
    // every applyVisibility tick (which fires on every state change and
    // every route navigation). Previously render() called input.focus()
    // unconditionally, which popped the mobile keyboard every time the
    // user tapped a nav tab — even when the coach panel wasn't visible.
    const isOpenNow = shouldDock || shouldOpen;
    // Closed, the pop-up sits off-screen with its buttons still in the page:
    // the Tab key walked into controls nobody could see. inert takes them out.
    root.inert = !isOpenNow;
    if (isOpenNow && !wasOpenLastTick && window.innerWidth >= 1024) {
      // The box to type in (it was still looking for the old panel's
      // #coach-input, so reopening the pop-up left the cursor on the page).
      // Desktop only: on a phone this would pop the keyboard.
      setTimeout(() => root.querySelector("#chat-input")?.focus(), 60);
    }
    wasOpenLastTick = isOpenNow;

    const drawerNow = shouldOpen;   // open and not docked
    if (drawerNow && !wasDrawerLastTick) {
      if (!history.state?.ssCoach) history.pushState({ ...(history.state || {}), ssCoach: 1 }, "", location.href);
      document.body.classList.add("coach-drawer-open");
    } else if (!drawerNow && wasDrawerLastTick) {
      document.body.classList.remove("coach-drawer-open");
      // Closed by ✕ / Esc / swipe: drop the entry we pushed, so Back then
      // leaves the page as usual. Not after a navigation: that would undo it.
      if (history.state?.ssCoach && !closingByNav) history.back();
      closingByNav = false;
    }
    wasDrawerLastTick = drawerNow;
  };
  applyVisibility();
  window.addEventListener("resize", applyVisibility);
  window.addEventListener("ss:navigate", applyVisibility);
  subscribe(applyVisibility);
}

// render() runs on every state change (quote ticks included). Closed, it
// does nothing; the change that opens the pop-up draws it.
function render() {
  if (!root) return;
  const state = getState();
  if (!state.settings.coachPanelOpen) return;
  // The pop-up shows the /chat view itself (same chats, sidebar, composer,
  // commands), drawn by chat.js into this box. Drawn once per opening and
  // after any page change (visiting /chat points chat.js back at <main>);
  // chat.js re-renders itself in between.
  if (!root.querySelector("#coach-embed") || root.dataset.embedPath !== location.pathname) {
    root.dataset.embedPath = location.pathname;
    root.innerHTML = `
      <div class="coach-resize" aria-hidden="true" title="Drag to resize"></div>
      <button class="coach-embed-close" id="coach-close-btn" type="button" aria-label="Close coach">✕</button>
      <div class="coach-embed" id="coach-embed"></div>`;
    root.querySelector("#coach-close-btn").addEventListener("click", () => setSetting("coachPanelOpen", false));
    wireResize(root);
    const styles = import("../features/styles.js");
    Promise.all([import("../pages/chat.js"), styles.then(st => st.ensureCoachStyles())]).then(([m]) => {
      const box = root.querySelector("#coach-embed");
      if (box) m.renderChat(box, { embedded: true });
    }).catch(async (e) => {
      // Tab still on the previous deploy: one reload opens the new build.
      try { if ((await styles).reloadForNewBuild(e)) return; } catch {}
      console.warn("[coach] embed failed", e);
    });
  }
}

// Drag the panel's left edge to resize it. The width is kept per device.
const COACH_W_KEY = "ss.coach.width.v1";
function applyCoachWidth(px) {
  const max = Math.max(320, Math.min(820, window.innerWidth - 240));
  const w = Math.round(Math.min(max, Math.max(300, px)));
  document.documentElement.style.setProperty("--coach-w", w + "px");
  return w;
}
try { const saved = parseInt(localStorage.getItem(COACH_W_KEY), 10); if (saved > 0) applyCoachWidth(saved); } catch {}
function wireResize(rootEl) {
  const handle = rootEl.querySelector(".coach-resize");
  if (!handle) return;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add("coach-resizing");
    let last = 0;
    const move = (ev) => { last = applyCoachWidth(window.innerWidth - ev.clientX); };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("is-dragging");
      document.body.classList.remove("coach-resizing");
      if (last) { try { localStorage.setItem(COACH_W_KEY, String(last)); } catch {} }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}
