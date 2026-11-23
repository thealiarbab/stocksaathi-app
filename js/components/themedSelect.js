// =============================================================================
// THEMED SELECT: the inline trigger for a choice. Tapping it opens the site's
// pick sheet (js/components/pickSheet.js), the same sheet as the heard-from
// card. Never a native select element: the browser paints that menu itself (the
// bright-blue OS list), which the owner banned site-wide on 24 Nov 2026.
//
// Usage (unchanged since the old popover version, so callers did not move):
//   import { mountThemedSelect } from "../components/themedSelect.js";
//   const sel = mountThemedSelect(hostEl, {
//     value: "foo",
//     options: [
//       { value: "foo", label: "Foo", hint: "detail", meta: "12" },
//       { value: "bar", label: "Bar" },
//       "---",                        // divider
//     ],
//     placeholder: "pick one",
//     title: "Sort stocks by",       // sheet heading (falls back to aria-label / placeholder)
//     onChange: (v) => { ... },
//   });
//   sel.setValue(v) · sel.getValue() · sel.setOptions(list) · sel.destroy()
//
// Keyboard: Enter / Space / ↓ open the sheet; inside it ↑/↓ move, Enter
// picks, Esc closes. The host also fires a bubbling "change" event with
// .value set, so form code that listened to a select element keeps working.
// =============================================================================

import { openPickSheet } from "./pickSheet.js";

export function mountThemedSelect(hostEl, config = {}) {
  // Callers mount after an async import; the host may be gone already.
  if (!hostEl) return null;
  if (hostEl._themedSelectInstance && typeof hostEl._themedSelectInstance.destroy === "function") {
    try { hostEl._themedSelectInstance.destroy(); } catch {}
  }
  const state = {
    value: config.value ?? null,
    options: normaliseOptions(config.options || []),
    placeholder: config.placeholder || "Select…",
    onChange: config.onChange || (() => {}),
    open: false,
  };
  const title = config.title || hostEl.getAttribute("aria-label") || config.placeholder || "Choose";

  hostEl.innerHTML = `<span class="ts-trigger"><span class="ts-label"></span><span class="ts-chevron" aria-hidden="true">▾</span></span>`;
  hostEl.classList.add("themed-select");
  hostEl.setAttribute("role", "button");
  hostEl.setAttribute("aria-haspopup", "dialog");
  hostEl.setAttribute("aria-expanded", "false");
  hostEl.setAttribute("tabindex", "0");

  function renderLabel() {
    const labelEl = hostEl.querySelector(".ts-label");
    if (!labelEl) return;
    const match = state.options.find((o) => o !== "---" && o.value === state.value);
    labelEl.textContent = match ? match.label : state.placeholder;
    labelEl.classList.toggle("placeholder", !match);
  }
  function setValue(v, { silent = false } = {}) {
    const changed = v !== state.value;
    state.value = v;
    hostEl.value = v;
    renderLabel();
    if (changed && !silent) {
      try { state.onChange(v); } catch (e) { console.warn("[themedSelect] onChange:", e); }
      hostEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  async function open() {
    if (state.open) return;
    state.open = true;
    hostEl.setAttribute("aria-expanded", "true");
    const picked = await openPickSheet({ title, options: state.options, value: state.value });
    state.open = false;
    hostEl.setAttribute("aria-expanded", "false");
    if (picked !== null && picked !== undefined) setValue(picked);
  }
  const onClick = () => open();
  const onKey = (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); open(); }
  };
  hostEl.addEventListener("click", onClick);
  hostEl.addEventListener("keydown", onKey);
  hostEl.value = state.value;
  renderLabel();

  const instance = {
    setValue: (v) => setValue(v, { silent: true }),
    getValue: () => state.value,
    setOptions(next) { state.options = normaliseOptions(next); renderLabel(); },
    open,
    destroy() {
      hostEl.removeEventListener("click", onClick);
      hostEl.removeEventListener("keydown", onKey);
      hostEl.classList.remove("themed-select");
      hostEl.innerHTML = "";
      try { delete hostEl._themedSelectInstance; } catch {}
    },
  };
  try { hostEl._themedSelectInstance = instance; } catch {}
  return instance;
}

function normaliseOptions(arr) {
  return arr.map((o) => {
    if (o === "---") return "---";
    if (typeof o === "string") return { value: o, label: o };
    return { value: o.value, label: o.label, hint: o.hint, meta: o.meta };
  });
}
