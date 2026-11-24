// =============================================================================
// morphHtml(el, html): make el's children match `html` by changing only what
// differs, instead of el.innerHTML = html.
//
// Why (24 Nov 2026): re-rendering with innerHTML throws every node away. On
// the chat page that replayed card animations, flashed "Loading chart…" on
// every chart and blanked the list for a frame, each time a background sync
// or a new message repainted it ("blinking, redrawing every time").
//
// Rules, in order, when an old node and a new node are the same kind:
//   1. A card that carries the same data (data-card) and has already been
//      drawn is kept exactly as it is: its chart, its sort order, its open
//      state and its listeners.
//   2. Identical subtrees (isEqualNode) are left alone, so nothing in them
//      restarts.
//   3. Otherwise attributes are synced and the children are compared the
//      same way. What the user typed in an input or textarea is kept.
// Nodes are matched by key when they have one: data-card, id, or data-i.
// Use it only where listeners are delegated (attached to `el` or above), or
// kept nodes would not get the listeners a fresh render attaches.
// =============================================================================

function keyOf(n) {
  if (n.nodeType !== 1) return null;
  const card = n.getAttribute("data-card");
  if (card != null) return `card:${card}`;
  if (n.id) return `id:${n.id}`;
  const i = n.getAttribute("data-i");
  if (i != null) return `i:${i}`;
  return null;
}

function same(o, n) {
  if (o.nodeType !== n.nodeType) return false;
  if (o.nodeType !== 1) return true;
  return o.tagName === n.tagName && keyOf(o) === keyOf(n);
}

function morphNode(o, n) {
  if (o.nodeType !== 1) {
    if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
    return;
  }
  if (o.hasAttribute("data-card") && o.getAttribute("data-card") === n.getAttribute("data-card")
      && (o.hasAttribute("data-drawn") || o.classList.contains("ss-card-table"))) return;
  if (o.isEqualNode(n)) return;
  for (const a of Array.from(o.attributes)) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of Array.from(n.attributes)) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  if (o.tagName === "TEXTAREA" || o.tagName === "INPUT" || o.tagName === "SELECT") return;
  morphChildren(o, n);
}

function morphChildren(oldParent, newParent) {
  let o = oldParent.firstChild;
  let n = newParent.firstChild;
  while (n) {
    const nNext = n.nextSibling;
    if (!o) { oldParent.appendChild(n); n = nNext; continue; }
    if (same(o, n)) { morphNode(o, n); o = o.nextSibling; n = nNext; continue; }
    // The old list may have nodes the new one dropped: look a few ahead.
    let scan = o.nextSibling, found = null;
    for (let hops = 0; scan && hops < 8; hops++, scan = scan.nextSibling) {
      if (same(scan, n)) { found = scan; break; }
    }
    if (found) {
      while (o !== found) { const gone = o; o = o.nextSibling; gone.remove(); }
      morphNode(o, n);
      o = o.nextSibling;
    } else {
      oldParent.insertBefore(n, o);
    }
    n = nNext;
  }
  while (o) { const gone = o; o = o.nextSibling; gone.remove(); }
}

export function morphHtml(el, html) {
  if (!el) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html ?? "");
  morphChildren(el, tpl.content);
}
