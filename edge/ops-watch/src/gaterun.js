// Runs the judge (gate.js) against the stored issues once a minute, starts the
// agent when the judge says so, and keeps the books: who was woken, whether it
// was picked up, what waits for the owner.
//
// Starting the agent creates a new session every time, so a start is never
// repeated on a guess: the rows are marked as woken BEFORE the call goes out,
// and only a clear refusal puts them back.

import { kvGet, kvPut } from "./core.js";
import { areaOf, bandOf, decide, usageNow, usageLine, wakeText, istClock } from "./gate.js";
import { severityOf, istDay } from "./rules.js";
import { sendBrief, briefDue } from "./brief.js";
import { dayInfo } from "./calendar.js";

const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;
const LIVE = new Set(["open", "fixing", "fix_live"]);
const BUSY = new Set(["fixing", "fix_live", "needs_owner", "needs_pc"]);
const MODE_RANK = { fix: 5, approved: 4, look: 3, recheck: 2, small: 1 };

const SELECT = `
SELECT g.*, s.sig, s.kind, s.trusted, s.title, s.issue_id, s.last_seen, s.state AS sstate, s.people AS t_people, s.hits AS t_hits,
       COALESCE(d.hits, 0) AS d_hits, COALESCE(d.people, 0) AS d_people,
       COALESCE(y.hits, 0) AS y_hits, COALESCE(y.people, 0) AS y_people
  FROM gate g JOIN sig s ON s.fp = g.fp
  LEFT JOIN sig_day d ON d.fp = g.fp AND d.day = ?2
  LEFT JOIN sig_day y ON y.fp = g.fp AND y.day = ?3
 WHERE g.state != 'closed'`;

function shape(x, now, today) {
  // Counts are per IST day; an issue that opened shortly before midnight
  // keeps yesterday's people for a few hours instead of dropping to zero.
  const carry = now - x.opened < 6 * HOUR && istDay(x.opened) !== today;
  const g = {
    fp: x.fp, id: x.issue_id, title: x.title, area: x.area, sev: x.sev, kind: x.kind, trusted: !!x.trusted,
    state: x.state, sstate: x.sstate, status: x.status || x.sstate, why: x.why, reason: x.reason, nextAt: x.next_at,
    opened: x.opened, lastSeen: x.last_seen,
    people: x.d_people + (carry ? x.y_people : 0), hits: x.d_hits + (carry ? x.y_hits : 0),
    openPeople: x.open_people, openHits: x.open_hits, totalPeople: x.t_people || 0, totalHits: x.t_hits || 0,
    wakes: x.wakes, wokenAt: x.woken_at, wakePeople: x.wake_people, wakeHits: x.wake_hits,
    pickedAt: x.picked_at, naggedAt: x.nagged_at, approvedAt: x.approved_at, again: x.again,
    outside: x.outside || null, sig: x.sig,
  };
  g.band = bandOf(g);
  return g;
}

export async function loadGate(env, now, where = "AND ?1 > 0") {
  const today = istDay(now);
  const r = await env.DB.prepare(`${SELECT} ${where} ORDER BY g.opened DESC LIMIT 120`).bind(now, today, istDay(now - DAY)).all();
  return (r.results || []).map((x) => shape(x, now, today));
}

async function readState(env) {
  const r = await env.DB.prepare("SELECT k, v FROM kv WHERE k IN ('gate', 'usage', 'gate_paused', 'self', 'owner_active')").all();
  const m = {};
  for (const x of r.results || []) { try { m[x.k] = JSON.parse(x.v); } catch {} }
  const G = m.gate || {};
  G.log ||= [];
  // Off until someone switches it on: a first deploy must never wake anything.
  G.ownerActiveAt = Number(m.owner_active?.at) || 0;
  return { G, usage: m.usage || null, paused: m.gate_paused !== false, origin: m.self?.origin || null };
}

// The band as the judge uses it: serious only while it is still happening.
const decideBand = (g, now) => (g.band === "serious" && now - g.lastSeen >= 30 * MIN ? "middle" : g.band);

const label = (g) => `${g.id ? `#${g.id}` : `(no number yet, ${g.fp.slice(0, 8)})`} [${g.area}, ${g.band}] ${String(g.title || "").slice(0, 110)}`;

// Issues that were already open when the judge was installed go straight to
// the brief list, so the first minute cannot set off a burst of wakes.
async function backfill(env, now) {
  const r = await env.DB.prepare(
    "SELECT fp, sig, kind, route, state, opened_at, first_seen FROM sig WHERE state IN ('open', 'fixing', 'fix_live') AND fp NOT IN (SELECT fp FROM gate) LIMIT 200",
  ).all();
  const sevOf = (x) => (/^pulse\|(site|api|db)_down$/.test(x.sig) || /^vital\|.*\|zero$/.test(x.sig) ? "critical"
    : x.sig === "pulse|baseline_review" ? "low" : x.kind === "pulse" ? "high" : severityOf(x.kind));
  const set = (r.results || []).map((x) => env.DB.prepare(
    "INSERT OR IGNORE INTO gate (fp, area, sev, opened, state, status, why, reason, next_at) VALUES (?1, ?2, ?3, ?4, 'brief', ?5, 'backlog', 'open before the judge started', ?6)",
  ).bind(x.fp, areaOf(x), sevOf(x), x.opened_at || x.first_seen, x.state, now + HOUR));
  for (let i = 0; i < set.length; i += 50) await env.DB.batch(set.slice(i, i + 50));
  return set.length;
}

// Reasons that mean "this waits for the owner or for a limit".
const ASKS = new Set(["tight", "cap", "blind_cap", "five", "nowake", "limit_full", "needs_you", "max_wakes"]);
// Decisions that stand until a set time, whatever happens in between.
const UNTIL = new Set(["snoozed", "nowake", "backlog"]);
const SMALL_BATCH = 5;

const context = (G, u, now) => ({
  now, usage: u, lastWakeAt: G.last || 0, lastSeriousWakeAt: G.last_serious || 0, lastSmallWakeAt: G.last_small || 0,
  wakesToday: G.n || 0, blindToday: G.blind || 0, ownerActiveAt: G.ownerActiveAt || 0,
  tradingDay: dayInfo(now).trading,
});

// Called on every prompt the owner sends in Claude on his PC.
export async function setActive(env, deps) {
  const now = deps.now();
  await kvPut(env, "owner_active", { at: now }, now).run();
  return { ok: true };
}

// The start call has no "same request" key: two calls are two sessions. So
// two checks that overlap must not both make it. Whoever gets this row first
// may call; the other one marks nothing and judges again a minute later.
async function takeFireLock(env, now) {
  const r = await env.DB.prepare(
    "INSERT INTO kv (k, v, t) VALUES ('gate_lock', '1', ?1) ON CONFLICT(k) DO UPDATE SET t = ?1 WHERE kv.t <= ?2",
  ).bind(now, now - 45 * 1000).run();
  return !!r?.meta?.changes;
}

export async function runGate(env, deps, opts = {}) {
  const now = deps.now();
  const { G, usage, paused, origin } = await readState(env);
  let dirty = false;
  const today = istDay(now);
  if (G.day !== today) { G.day = today; G.n = 0; G.blind = 0; dirty = true; }
  if (!G.backfilled) { await backfill(env, now); G.backfilled = now; dirty = true; }
  const u = usageNow(usage, G.log, now);
  const ctx = context(G, u, now);
  const save = () => { const { ownerActiveAt, ...keep } = G; return kvPut(env, "gate", keep, now); };

  // Every open issue is judged every minute; a row is only written when the
  // decision changes.
  const all = await loadGate(env, now);
  const set = [], nags = [], alerts = [];
  let waking = [], nearby = [], more = 0;
  const settle = (g, v, state) => {
    if (state === g.state && v.why === g.why) return;
    set.push(env.DB.prepare("UPDATE gate SET state = ?1, why = ?2, reason = ?3, next_at = ?4 WHERE fp = ?5").bind(state, v.why, v.reason, v.next, g.fp));
  };

  for (const g of all) {
    if (!LIVE.has(g.sstate)) { set.push(env.DB.prepare("UPDATE gate SET state = 'closed', status = ?1 WHERE fp = ?2").bind(g.sstate, g.fp)); continue; }
    if (UNTIL.has(g.why) && now < g.nextAt && !g.approvedAt) continue;
    const v = (g.v = decide(g, ctx));
    if (v.act === "wake" || v.act === "join") { waking.push(g); continue; }
    if (v.act === "idle") continue;
    if (v.act === "nag") {
      nags.push(g);
      set.push(env.DB.prepare("UPDATE gate SET nagged_at = ?1 WHERE fp = ?2").bind(now, g.fp));
      continue;
    }
    if (v.alert && !g.naggedAt) { alerts.push(g); set.push(env.DB.prepare("UPDATE gate SET nagged_at = ?1 WHERE fp = ?2").bind(now, g.fp)); }
    settle(g, v, v.act === "wait" ? "waiting" : v.act === "brief" ? "brief" : v.act === "hold" ? "hold" : g.state);
  }

  const seriousWake = waking.some((g) => decideBand(g, now) === "serious" && g.v.act === "wake");
  // Small work: the five that touch the most people now, the rest next time.
  // Never mixed into an incident.
  const small = waking.filter((g) => g.v.mode === "small").sort((a, b) => b.people - a.people);
  const keep = new Set((seriousWake ? [] : small.slice(0, SMALL_BATCH)).map((g) => g.fp));
  for (const g of small) {
    if (keep.has(g.fp)) continue;
    more++;
    settle(g, { why: "queued", reason: seriousWake ? "an incident is being handled: small fixes wait" : `queued behind ${SMALL_BATCH} other small fixes`, next: now + HOUR }, "brief");
  }
  waking = waking.filter((g) => g.v.mode !== "small" || keep.has(g.fp));
  const fire = waking.some((g) => g.v.act === "wake");
  if (seriousWake) {
    // One wake per incident: every other serious issue that nobody is
    // working on goes into the same start.
    const inWake = new Set(waking.map((g) => g.fp));
    for (const g of all) {
      if (inWake.has(g.fp) || !g.v || !LIVE.has(g.sstate) || BUSY.has(g.status) || g.v.act === "hold") continue;
      if (decideBand(g, now) === "serious" && !(g.state === "woken" && g.pickedAt)) {
        g.v = { act: "join", why: "joined", reason: "same incident as another serious issue", next: now + 15 * MIN, mode: "fix" };
        waking.push(g); inWake.add(g.fp);
      } else if ((g.state === "new" || g.state === "waiting") && now - g.opened < 20 * MIN) nearby.push(g);
    }
  }

  let fired = null;
  if (waking.length && paused) {
    for (const g of waking) settle(g, { why: "paused", reason: `wakes are switched off; it would have been woken (${g.v.why})`, next: now + 15 * MIN }, "brief");
  } else if (waking.length && fire && !(await takeFireLock(env, now))) {
    // Another check started the agent seconds ago.
  } else if (waking.length) {
    const before = { last: G.last, last_serious: G.last_serious, last_small: G.last_small, n: G.n, blind: G.blind };
    for (const g of waking) {
      set.push(env.DB.prepare(
        `UPDATE gate SET state = 'woken', why = ?1, reason = ?2, next_at = ?3, wakes = wakes + 1, woken_at = ?4, wake_people = ?5, wake_hits = ?6,
                picked_at = NULL, nagged_at = NULL, approved_at = NULL, again = NULL WHERE fp = ?7`,
      ).bind(g.v.why, g.v.reason, now + 15 * MIN, now, g.people, g.hits, g.fp));
    }
    if (fire) {
      const serious = seriousWake;
      const mode = waking.map((g) => g.v.mode || "small").sort((a, b) => MODE_RANK[b] - MODE_RANK[a])[0];
      G.last = now;
      if (serious) G.last_serious = now; else G.n = (G.n || 0) + 1;
      if (waking.some((g) => g.v.mode === "small")) G.last_small = now;
      if (waking.some((g) => g.v.why === "blind")) G.blind = (G.blind || 0) + 1;
      G.log.push({ at: now, mode, ids: waking.map((g) => g.id || g.fp.slice(0, 8)), ok: null });
      if (G.log.length > 40) G.log = G.log.slice(-40);
      // Books first, call second.
      await env.DB.batch([...set, save()]);
      set.length = 0; dirty = false;
      const text = wakeText({
        now, usage: u, dbOk: opts.dbOk !== false, drill: !!opts.drill, market: dayInfo(now).line,
        rows: waking.map((g) => ({ ...g, mode: g.v.mode || "small" })), nearby, more,
      });
      const reply = await deps.wake(text);
      const entry = G.log[G.log.length - 1];
      const refused = !reply?.ok && (reply?.why === "no_token" || (reply?.status || 0) >= 400);
      if (refused) {
        entry.ok = false; entry.why = reply.why || String(reply.status);
        Object.assign(G, before);
        for (const g of waking) {
          const hot = decideBand(g, now) === "serious";
          set.push(env.DB.prepare(
            "UPDATE gate SET state = ?1, why = 'nowake', reason = ?2, next_at = ?3, wakes = MAX(wakes - 1, 0), woken_at = NULL WHERE fp = ?4",
          ).bind(hot ? "new" : "brief", `the agent could not be started (${entry.why})`, now + (hot ? 15 : 60) * MIN, g.fp));
        }
        if (!G.fail_mail || now - G.fail_mail > 6 * HOUR) {
          G.fail_mail = now;
          await deps.mail("StockSaathi ops: the agent could not be started",
            [`The watcher tried to start the agent at ${istClock(now)} and was refused (${entry.why === "no_token" ? "no start token is set on the watcher" : `answer ${entry.why}`}).`,
              `For:\n${waking.map(label).join("\n")}`,
              "Serious issues are retried every 15 minutes. You get this mail at most once every 6 hours."].join("\n\n"), { force: true });
        }
      } else {
        entry.ok = reply?.ok ? true : null;
        if (reply?.id) entry.session = String(reply.id).slice(0, 80);
        // Opens this run's row in the database, so the owner's activity list
        // shows the start even if the agent never writes a word. Best effort.
        if (reply?.ok) {
          try {
            await deps.rpc("ops_run_start", {
              session: entry.session || null, mode, issues: waking.map((g) => g.id).filter(Boolean),
              limits: u ? { weekly: u.weekly ?? null, five: u.five ?? null } : null,
            });
          } catch {}
        }
      }
      dirty = true;
      fired = { ok: !!reply?.ok, refused, mode, issues: waking.length };
    }
  }

  if (nags.length) {
    await deps.mail(`StockSaathi ops: the agent did not pick up ${nags.length} issue(s)`,
      [`The agent was started for:\n${nags.map(label).join("\n")}`,
        "Nothing picked the work up within 15 minutes. Claude may be at its limit, or the routine may be switched off.",
        nags.some((g) => g.band === "serious") ? "The serious ones are tried once more 45 minutes after the first start." : ""].filter(Boolean).join("\n\n"), { force: true });
  }
  if (alerts.length) {
    await deps.mail("StockSaathi ops: serious issue, but Claude's limit is full",
      [`These are serious and the agent cannot run right now:\n${alerts.map(label).join("\n")}`,
        `Limits: ${usageLine(u, now)}.`,
        "The agent is started as soon as the limit resets. Until then it needs you."].join("\n\n"), { force: true });
  }
  // One warning a week when the weekly limit gets close.
  if (u.known && u.fresh && u.weekly >= 85 && G.warned !== u.weeklyReset) {
    G.warned = u.weeklyReset; dirty = true;
    await deps.mail(`StockSaathi ops: Claude weekly limit at ${Math.round(u.weekly)}%`,
      `Limits: ${usageLine(u, now)}.\n\nFrom here the agent still fixes anything serious at once. Small things wait for your OK or for the reset, and appear in the daily brief.`, { force: true });
  }
  if (briefDue(now) && G.brief_day !== today) {
    G.brief_day = today;
    await env.DB.batch([...set, save()]);
    set.length = 0; dirty = false;
    await sendBrief(env, deps, { rows: await loadGate(env, now), usage: u, paused, log: G.log, origin });
  }
  if (dirty) set.push(save());
  if (set.length) await env.DB.batch(set);
  return { open: all.length, woke: fired, nags: nags.length };
}

// ---- things the owner, his own sessions, or the meter script can say ----

const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
const when = (x) => (typeof x === "string" && x ? Date.parse(x) || null : num(x));

export async function setUsage(env, deps, b) {
  const now = deps.now();
  const weekly = num(b.weekly), five = num(b.five);
  if (weekly == null || weekly < 0 || weekly > 100 || (five != null && (five < 0 || five > 100))) return { ok: false, why: "bad_numbers" };
  const v = { weekly, five, weekly_reset: when(b.weekly_reset), five_reset: when(b.five_reset), at: now, src: String(b.src || "manual").slice(0, 20) };
  await kvPut(env, "usage", v, now).run();
  const G = (await kvGet(env, "gate")) || {};
  return { ok: true, usage: usageNow(v, G.log || [], now) };
}

export async function setPaused(env, deps, paused) {
  await kvPut(env, "gate_paused", !!paused, deps.now()).run();
  return { ok: true, paused: !!paused };
}

// The owner's answer to "this small thing is waiting": go ahead, or not now.
export async function answer(env, deps, { fp, issue, action }) {
  const now = deps.now();
  const row = fp
    ? await env.DB.prepare("SELECT g.fp, g.state FROM gate g WHERE g.fp = ?1").bind(String(fp)).first()
    : await env.DB.prepare("SELECT g.fp, g.state FROM gate g JOIN sig s ON s.fp = g.fp WHERE s.issue_id = ?1").bind(Number(issue) || -1).first();
  if (!row) return { ok: false, why: "unknown_issue" };
  if (row.state === "closed") return { ok: false, why: "already_closed" };
  if (action === "later") {
    await env.DB.prepare("UPDATE gate SET state = 'brief', why = 'snoozed', reason = ?1, next_at = ?2, approved_at = NULL WHERE fp = ?3")
      .bind(`you said not now; asked again after ${istClock(now + 7 * DAY)}`, now + 7 * DAY, row.fp).run();
    return { ok: true, action: "later" };
  }
  await env.DB.prepare("UPDATE gate SET approved_at = ?1, next_at = ?1 WHERE fp = ?2").bind(now, row.fp).run();
  return { ok: true, action: "approve" };
}

export async function addNote(env, deps, b) {
  const text = String(b.text || b.summary || "").trim().slice(0, 600);
  if (!text) return { ok: false, why: "empty" };
  const now = deps.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO note (at, kind, ref, text) VALUES (?1, ?2, ?3, ?4)").bind(now, String(b.kind || "work").slice(0, 20), b.ref ? String(b.ref).slice(0, 80) : null, text),
    env.DB.prepare("DELETE FROM note WHERE at < ?1").bind(now - 60 * DAY),
  ]);
  return { ok: true };
}

// What the judge would do right now, without doing it.
export async function gateView(env, deps) {
  const now = deps.now();
  const { G, usage, paused } = await readState(env);
  const u = usageNow(usage, G.log, now);
  const ctx = context(G, u, now);
  const rows = (await loadGate(env, now)).map((g) => {
    const v = decide(g, ctx);
    return { issue: g.id, fp: g.fp, area: g.area, band: g.band, sev: g.sev, kind: g.kind, state: g.state, status: g.status, people: g.people, hits: g.hits, outside: g.outside,
      opened: new Date(g.opened).toISOString(), last_seen: new Date(g.lastSeen).toISOString(), stored: g.reason, next_check: new Date(g.nextAt).toISOString(),
      now_would: v.act, mode: v.mode || null, because: v.reason };
  });
  return { ok: true, paused, usage: { ...u, line: usageLine(u, now) }, wakes_today: G.n || 0, last_wake: G.last || null, log: G.log.slice(-10), rows };
}

export async function gateSummary(env, deps) {
  const now = deps.now();
  const { G, usage, paused } = await readState(env);
  const c = await env.DB.prepare("SELECT state, COUNT(*) n FROM gate GROUP BY state").all();
  const u = usageNow(usage, G.log, now);
  const rows = await loadGate(env, now);
  const waiting = rows.filter((g) => (g.state === "brief" || g.state === "hold") && ASKS.has(g.why));
  return {
    waiting: waiting.slice(0, 15).map((g) => ({ issue: g.id, area: g.area, band: g.band, reason: g.reason })),
    waiting_count: waiting.length,
    // What is serious and still happening right now (numbers only, no titles).
    serious: rows.filter((g) => LIVE.has(g.sstate) && decideBand(g, now) === "serious").slice(0, 10).map((g) => ({ issue: g.id, fp: g.fp.slice(0, 8), area: g.area, opened: g.opened })),
    queued: rows.filter((g) => g.why === "queued").length,
    held_while_off: rows.filter((g) => g.why === "paused").length,
    // Only what the agent holds right now: claimed, or started in the last
    // 15 minutes and not yet claimed. An issue it looked at and let go is not.
    with_agent: rows.filter((g) => g.status === "fixing" || g.status === "fix_live" || (g.state === "woken" && !g.pickedAt && now - (g.wokenAt || 0) < 15 * MIN)).length,
    paused, usage: usageLine(u, now), weekly: u.weekly, five: u.five, reading_age_min: u.age == null ? null : Math.round(u.age / MIN),
    states: Object.fromEntries((c.results || []).map((r) => [r.state, r.n])),
    wakes_today: G.n || 0, last_wake: G.last || null, last_log: G.log.slice(-1)[0] || null, brief_day: G.brief_day || null,
  };
}

// A start with no issue attached, to prove the wiring end to end.
export async function testWake(env, deps) {
  const now = deps.now();
  const { G, usage } = await readState(env);
  const reply = await deps.wake(wakeText({ now, rows: [], usage: usageNow(usage, G.log, now), test: true }));
  G.log.push({ at: now, mode: "test", ids: [], ok: reply?.ok ? true : reply?.status ? false : null, why: reply?.why || (reply?.ok ? undefined : String(reply?.status || 0)) });
  await kvPut(env, "gate", G, now).run();
  return { ok: !!reply?.ok, status: reply?.status || 0, why: reply?.why || reply?.err || null, session: reply?.id || null };
}
