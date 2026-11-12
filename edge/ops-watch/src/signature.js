// Turns a raw error report into a stable signature.
//
// Two different jobs, kept apart on purpose:
//   scrub()     removes private values before anything is stored or sent on.
//   normalize() removes the parts that change from one occurrence to the next
//               (numbers, ids, build hashes), so repeats of one problem share
//               one signature across deploys.
// No line numbers anywhere: they move on every edit.

export const SIG_VERSION = 1;

const SCRUB = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, "<jwt>"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <token>"],
  [/\b(?:sk|pk|rk|re|sb|whsec|ghp|gho|xox[abp])[_-][A-Za-z0-9_-]{12,}/g, "<key>"],
  [/([?&;\s"'](?:token|tok|key|apikey|api_key|secret|password|passwd|pwd|access_token|refresh_token|code|otp|signature)=)[^&\s"'<>]+/gi, "$1<redacted>"],
  [/("(?:password|token|access_token|refresh_token|secret|apikey|otp)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/(?<![\d.])(?:\+?91[\s-]?)?[6-9]\d{9}(?![\d.])/g, "<phone>"],
  [/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, "<ip>"],
];

export function scrub(value, max = 600) {
  let s = typeof value === "string" ? value : value == null ? "" : String(value);
  if (s.length > max * 4) s = s.slice(0, max * 4);
  for (const [re, to] of SCRUB) s = s.replace(re, to);
  return s.length > max ? s.slice(0, max) : s;
}

// Deep copy with every string scrubbed; bounded so a hostile payload cannot
// make the collector store something huge.
export function scrubDeep(v, depth = 0) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return scrub(v, 600);
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => scrubDeep(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    let n = 0;
    for (const [k, val] of Object.entries(v)) {
      if (n++ >= 24) break;
      if (/pass|secret|token|authorization|cookie|apikey/i.test(k)) { out[k.slice(0, 40)] = "<redacted>"; continue; }
      out[k.slice(0, 40)] = scrubDeep(val, depth + 1);
    }
    return out;
  }
  return null;
}

export function normalize(value, max = 160) {
  let s = scrub(value, 800);
  s = s
    .replace(/\?[^\s"')]*/g, "")                                   // query strings
    .replace(/\.[0-9a-f]{8,}\.(js|mjs|css|map|json|woff2?)\b/gi, ".*.$1") // build hashes
    .replace(/\b[A-Z][A-Z0-9&-]{1,14}\.(?:NS|BO)\b/g, "<sym>")       // exchange symbols
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(?:[.,:]\d+)*/g, "N")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}

function cleanRoute(r) {
  let s = String(r || "").slice(0, 200);
  const q = s.indexOf("?");
  if (q >= 0) {
    const op = /[?&]op=([A-Za-z0-9_-]{1,40})/.exec(s);
    s = s.slice(0, q) + (op ? `?op=${op[1]}` : "");
  }
  return s.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/<uuid>").replace(/\/\d+(?=\/|$)/g, "/N") || "?";
}

const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Returns null for reports that are not problems (a visitor leaving the page
// mid-request, a phone that is offline).
export function describe(src, e) {
  if (!e || typeof e !== "object") return null;
  const kind = String(e.kind || "");
  if (src === "py" || src === "js") {
    const route = cleanRoute(e.route);
    if (kind === "canary") return { sig: `${src}|canary`, src, kind, route, title: `${src} canary`, trusted: 1 };
    if (kind === "exception") {
      const etype = normalize(e.etype || "Error", 60);
      const msg = normalize(e.msg || "", 160);
      const frame = normalize(Array.isArray(e.frames) ? e.frames[0] || "" : e.where || "", 100);
      return {
        sig: `${src}|exc|${route}|${etype}|${msg}|${frame}`, src, kind: "exc", route, trusted: 1,
        title: short(`${route}: ${etype}${msg ? ": " + msg : ""}${frame ? " (" + frame + ")" : ""}`, 180),
      };
    }
    if (kind === "http5xx") {
      const st = Number(e.status) || 500;
      const code = normalize(e.code || "", 60);
      return {
        sig: `${src}|http|${route}|${st}|${code}`, src, kind: "http", route, trusted: 1,
        title: short(`${route} answered ${st}${code ? " (" + code + ")" : ""}`, 180),
      };
    }
    if (kind === "timeout") return { sig: `${src}|timeout|${route}`, src, kind: "timeout", route, trusted: 1, title: `${route} hit its time limit` };
    if (kind === "slow") return { sig: `${src}|slow|${route}`, src, kind: "slow", route, trusted: 1, title: `${route} is very slow` };
    return null;
  }
  if (src === "browser") {
    if (kind === "error") {
      const msg = normalize(e.target || e.msg || "", 160);
      if (!msg) return null;
      const file = normalize(String(e.props?.src || "").replace(/:\d+:\d+$/, ""), 80);
      return {
        sig: `br|error|${msg}|${file}`, src, kind: "error", route: cleanRoute(e.path), trusted: 0,
        title: short(`Browser error: ${msg}${file ? " (" + file + ")" : ""}`, 180),
      };
    }
    if (kind === "api") {
      const label = normalize(e.target || "", 100);
      const st = e.props?.st;
      if (!label || st === "left page" || st === "offline") return null;
      let cls;
      if (typeof st === "number") cls = st >= 500 ? `5xx:${st}` : st >= 400 ? `4xx:${st}` : "slow";
      else cls = "network";
      const kindOut = cls.startsWith("5xx") || cls === "network" ? "api5" : cls === "slow" ? "apislow" : "api4";
      const words = cls === "network" ? "fails to load in browsers" : cls === "slow" ? "is slow in browsers" : `answers ${cls.slice(4)} in browsers`;
      return { sig: `br|api|${label}|${cls}`, src, kind: kindOut, route: label, trusted: 0, title: short(`${label} ${words}`, 180) };
    }
    if (kind === "form_error") {
      const form = normalize(e.target || "", 80);
      const msg = normalize(e.props?.msg || "", 120);
      if (!form && !msg) return null;
      return { sig: `br|form|${form}|${msg}`, src, kind: "form", route: cleanRoute(e.path), trusted: 0, title: short(`Form ${form}: ${msg}`, 180) };
    }
    return null;
  }
  return null;
}

export async function fingerprint(sig) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`v${SIG_VERSION}|${sig}`));
  const b = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 10; i++) hex += b[i].toString(16).padStart(2, "0");
  return hex;
}

// What is kept as evidence for one occurrence. Text here came from the public
// internet (anyone can make the site throw any message), so it is stored as
// data and must never be read as instructions.
export function sample(src, e, now) {
  const t = Number.isFinite(e.t) ? Math.min(now, e.t) : now;
  const base = { t, kind: String(e.kind || "").slice(0, 20) };
  if (src === "browser") {
    return scrubDeep({ ...base, path: e.path, target: e.target, props: e.props });
  }
  return scrubDeep({
    ...base, route: e.route, method: e.method, status: e.status, ms: e.ms, etype: e.etype, msg: e.msg,
    frames: Array.isArray(e.frames) ? e.frames.slice(0, 8) : undefined, body: e.body, region: e.region,
  });
}
