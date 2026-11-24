const pendingStylesheets = new Map();

function isLoaded(link) {
  return !!link.sheet;
}

export function ensureStylesheet(id, href, preloadId = "") {
  const existing = document.getElementById(id);
  if (existing?.rel === "stylesheet" && isLoaded(existing)) return Promise.resolve();

  const pending = pendingStylesheets.get(id);
  if (pending) return pending;

  const preload = preloadId ? document.getElementById(preloadId) : null;
  const link = existing?.rel === "stylesheet" ? existing : document.createElement("link");
  if (link !== existing) {
    link.id = id;
    link.rel = "stylesheet";
    link.href = preload?.href || href;
  }

  const promise = new Promise((resolve, reject) => {
    const stylesheetHref = link.href;
    const attach = (target, retriesRemaining) => {
      target.addEventListener("load", resolve, { once: true });
      target.addEventListener("error", () => {
        target.remove();
        if (retriesRemaining > 0) {
          const retry = document.createElement("link");
          retry.id = id;
          retry.rel = "stylesheet";
          retry.href = stylesheetHref;
          attach(retry, retriesRemaining - 1);
          document.head.appendChild(retry);
          return;
        }
        failure(stylesheetHref).then(reject);
      }, { once: true });
      if (isLoaded(target)) resolve();
      else if (target !== existing) document.head.appendChild(target);
    };
    attach(link, 1);
  }).finally(() => {
    pendingStylesheets.delete(id);
    preload?.remove();
  });

  pendingStylesheets.set(id, promise);
  return promise;
}

// A stylesheet that fails twice is either a lost connection or a tab still
// running the previous deploy, whose hashed file Vercel no longer serves.
// Asking once more tells them apart: the server answering with anything but
// CSS (404) means the build moved on, and reloadForNewBuild() fixes that.
async function failure(href) {
  const err = new Error(`Failed to load stylesheet: ${href}`);
  try {
    const res = await fetch(href, { cache: "no-store" });
    if (!res.ok || !/text\/css/i.test(res.headers.get("content-type") || "")) err.staleBuild = true;
  } catch {}
  return err;
}

// A page's code or styles that will not download because the tab runs the
// previous deploy (a failed dynamic import, or a stylesheet the server no
// longer has): one reload picks up the new build. The stamp stops a reload
// loop when the server really is unreachable. Returns true when reloading.
export function reloadForNewBuild(err) {
  const stale = err?.staleBuild ||
    /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(String(err && err.message));
  if (!stale) return false;
  let last = 0;
  try { last = Number(sessionStorage.getItem("ss.chunkReload") || 0); } catch {}
  if (Date.now() - last <= 60000) return false;
  try { sessionStorage.setItem("ss.chunkReload", String(Date.now())); } catch {}
  window.location.reload();
  return true;
}

export function ensureCoachStyles() {
  return ensureStylesheet("coach-stylesheet", "/css/coach.css");
}
