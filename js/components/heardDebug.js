// =============================================================================
// HEARD-FROM CARD · admin preview tools. Loaded by heardPopup.js only when
// heard_config() returned debug = true (is_admin() on the server), so other
// accounts never download or run this file.
//
// Reset & reopen, Shuffle again, light/dark, a 360px phone frame, the
// onboarding/backfill copy, and DRY RUN (on by default: picks are logged with
// props.debug = true and nothing is written to the profile).
// =============================================================================

export function createHeardDebug(api) {
  const root = document.documentElement;
  const startTheme = root.getAttribute("data-theme");
  const bar = document.createElement("div");
  bar.className = "hp-dbg";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Admin preview tools");
  let msgTimer = 0;

  const draw = () => {
    const st = api.state;
    const mobile = api.overlay.classList.contains("hp-sim-mobile");
    bar.innerHTML = `
      <div class="hp-dbg-row">
        <span class="hp-dbg-tag">Admin preview</span>
        <label class="hp-dbg-dry"><input type="checkbox" data-a="dry"${st.dryRun ? " checked" : ""}> Dry run</label>
      </div>
      <div class="hp-dbg-row hp-dbg-btns">
        <button type="button" data-a="reset">Reset &amp; reopen</button>
        <button type="button" data-a="shuffle">Shuffle again</button>
        <button type="button" data-a="theme">Toggle light/dark</button>
        <button type="button" data-a="mobile" aria-pressed="${mobile}">Simulate mobile width</button>
        <button type="button" data-a="variant">${st.variant === "backfill" ? "Show onboarding copy" : "Show backfill copy"}</button>
        <button type="button" data-a="close">Close</button>
      </div>
      <div class="hp-dbg-msg" aria-live="polite">${st.dryRun ? "Dry run is on: nothing is saved." : "Dry run is off: Continue writes to YOUR profile."}</div>`;
  };

  const flash = (text) => {
    const m = bar.querySelector(".hp-dbg-msg");
    if (!m) return;
    m.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(draw, 4000);
  };

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-a]");
    if (!b) return;
    switch (b.dataset.a) {
      case "reset": api.reset(); flash("Reset: nothing picked, original order."); break;
      case "shuffle": api.reshuffle(); flash("New random order."); break;
      case "theme": {
        const dark = root.getAttribute("data-theme") === "dark";
        root.setAttribute("data-theme", dark ? "light" : "dark");
        flash(`Theme: ${dark ? "light" : "dark"} (this preview only).`);
        break;
      }
      case "mobile": api.overlay.classList.toggle("hp-sim-mobile"); draw(); break;
      case "variant": api.setVariant(api.state.variant === "backfill" ? "onboarding" : "backfill"); break;
      case "close": api.close(); break;
    }
  });
  bar.addEventListener("change", (e) => {
    if (e.target.dataset?.a === "dry") api.setDryRun(e.target.checked);
  });

  return {
    mount(slot) { draw(); slot?.replaceWith(bar); },
    flash,
    destroy() {
      clearTimeout(msgTimer);
      if (startTheme == null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", startTheme);
    },
  };
}
