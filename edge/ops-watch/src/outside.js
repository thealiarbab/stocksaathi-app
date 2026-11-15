// Outside services the site depends on: Yahoo (prices), Google AI (Saathi),
// Supabase (database and login), Vercel (hosting), Resend (e-mail). When the
// cause of a problem is theirs, the issue says so, and the agent is not
// started for it: there is nothing of ours to change.

const MIN = 60_000;

export const OUTSIDE_NAME = { yahoo: "Yahoo Finance", google_ai: "Google AI", supabase: "Supabase", vercel: "Vercel", resend: "Resend" };

const PAGES = {
  supabase: "https://status.supabase.com/api/v2/status.json",
  vercel: "https://www.vercel-status.com/api/v2/status.json",
  resend: "https://resend-status.com/api/v2/status.json",
};

// Reads the three public status pages. "ok" = the service says all is well,
// "bad" = it reports an incident, "unknown" = its page could not be read.
export async function readStatus(deps) {
  const out = { at: deps.now() };
  await Promise.all(Object.entries(PAGES).map(async ([k, url]) => {
    try {
      const r = await deps.http(url, { timeoutMs: 6000 });
      const ind = r?.json?.status?.indicator;
      out[k] = r?.status === 200 && typeof ind === "string" ? (ind === "none" ? "ok" : "bad") : "unknown";
      if (out[k] === "bad") out[`${k}_says`] = String(r.json.status.description || ind).slice(0, 80);
    } catch { out[k] = "unknown"; }
  }));
  return out;
}

// A status reading older than half an hour says nothing about now.
const says = (status, k, now) => (status && Number.isFinite(status.at) && now - status.at <= 30 * MIN ? status[k] || "unknown" : "unknown");

const RE_YAHOO = /yahoo_unreachable|yahoo_rate|yahoo[^"]{0,40}(429|rate.?limit|timed? ?out|unreachable)|query[12]\.finance\.yahoo/i;
const RE_GOOGLE = /vertex|gemini|aiplatform|generativelanguage|resource_exhausted/i;
const RE_UPSTREAM = /upstream|overloaded|all_providers_failed|provider_error/i;
const RE_RESEND = /resend/i;

// Whose fault is it? Returns a service key, or null when it is ours (or
// unknown, which is treated as ours: better one look too many).
//   row: { sig, kind, route }   sample: the latest report   status: what readStatus() saved
export function blameOf(row, sample, status, now) {
  const sig = String(row?.sig || ""), route = String(row?.route || "");
  let text = "";
  try { text = `${sig} ${route} ${JSON.stringify(sample ?? "")}`.slice(0, 4000); } catch { text = `${sig} ${route}`; }
  const bad = (k) => says(status, k, now) === "bad";

  if (RE_YAHOO.test(text)) return "yahoo";
  if (RE_GOOGLE.test(text)) return "google_ai";
  if (RE_UPSTREAM.test(text) && /\/api\/(chat|ai)|^robot\|saathi/.test(`${route} ${sig}`)) return "google_ai";
  if (RE_RESEND.test(text) && !/^vital\|/.test(sig)) return "resend";
  if (sig === "vital|signups|unconfirmed" && bad("resend")) return "resend";
  if (bad("supabase") && (sig === "pulse|db_down" || sig === "pulse|db_slow" || /^robot\|(login|portfolio|order)$/.test(sig) || /db \/(auth|rest)\/v/.test(text))) return "supabase";
  if (bad("vercel") && (sig === "pulse|site_down" || sig === "pulse|api_down" || /^robot\|(page|register)$/.test(sig))) return "vercel";
  return null;
}

export function outsideNote(service, status) {
  const name = OUTSIDE_NAME[service] || service;
  const their = status && status[`${service}_says`];
  return { service, name, note: `The cause looks like ${name}, not our code${their ? ` (their status page says: ${their})` : ""}. Nothing of ours to change unless it lasts.` };
}
