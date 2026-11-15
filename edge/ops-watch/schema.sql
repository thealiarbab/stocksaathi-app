-- Collector storage (Cloudflare D1). The raw error stream lives here, never in
-- the main database. Safe to re-run.

CREATE TABLE IF NOT EXISTS sig (
  fp TEXT PRIMARY KEY,
  ver INTEGER NOT NULL DEFAULT 1,
  sig TEXT NOT NULL,
  src TEXT NOT NULL,
  kind TEXT NOT NULL,
  route TEXT,
  title TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'watch',
  issue_id INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  people INTEGER NOT NULL DEFAULT 0,
  first_deploy TEXT,
  last_deploy TEXT,
  first_samples TEXT NOT NULL DEFAULT '[]',
  last_samples TEXT NOT NULL DEFAULT '[]',
  opened_at INTEGER,
  fixed_at INTEGER,
  fix_deploy TEXT,
  peak_day INTEGER NOT NULL DEFAULT 0,
  spike_day TEXT,
  alert_people INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sig_state ON sig (state, dirty);
CREATE INDEX IF NOT EXISTS sig_first ON sig (first_seen);

CREATE TABLE IF NOT EXISTS sig_day (
  fp TEXT NOT NULL, day TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, people INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fp, day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sig_day_day ON sig_day (day);

CREATE TABLE IF NOT EXISTS sig_who (
  fp TEXT NOT NULL, day TEXT NOT NULL, who TEXT NOT NULL,
  PRIMARY KEY (fp, day, who)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sig_who_day ON sig_who (day);

-- Signatures a fixer found to be the same problem: `fp` counts as `head`.
CREATE TABLE IF NOT EXISTS alias (fp TEXT PRIMARY KEY, head TEXT NOT NULL, why TEXT, at INTEGER NOT NULL);
-- Grouping learned from a merge: a new signature with this source, kind and
-- route whose text contains `needle` joins `head`. Plain text match only.
CREATE TABLE IF NOT EXISTS grouping (
  id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, kind TEXT NOT NULL, route TEXT, needle TEXT NOT NULL,
  head TEXT NOT NULL, why TEXT, at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pulse (
  t INTEGER PRIMARY KEY, site INTEGER, site_ms INTEGER, api INTEGER, api_ms INTEGER, db INTEGER, db_ms INTEGER, d TEXT
);
CREATE TABLE IF NOT EXISTS vital_hour (
  vital TEXT NOT NULL, hour INTEGER NOT NULL, v REAL NOT NULL, incident INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vital, hour)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tally (
  hour INTEGER NOT NULL, route TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, err INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, route)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rpc TEXT NOT NULL, body TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
-- Nightly copy of the casebook and recipes, so memory survives the main
-- database being down.
CREATE TABLE IF NOT EXISTS memo (kind TEXT NOT NULL, id INTEGER NOT NULL, data TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (kind, id));

-- The judge at the door: one row per open issue, saying whether the agent was
-- woken for it, is waiting, or left it for the daily brief (see src/gate.js).
--   state: new | waiting | woken | brief | hold | closed
--   why:   short code of the last decision; reason: the same in words
--   again: a time the agent asked to be woken for this issue again
CREATE TABLE IF NOT EXISTS gate (
  fp TEXT PRIMARY KEY,
  area TEXT NOT NULL DEFAULT 'other',
  sev TEXT NOT NULL DEFAULT 'medium',
  opened INTEGER NOT NULL,
  open_people INTEGER NOT NULL DEFAULT 0,
  open_hits INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new',
  status TEXT,
  why TEXT,
  reason TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  wakes INTEGER NOT NULL DEFAULT 0,
  woken_at INTEGER,
  wake_people INTEGER NOT NULL DEFAULT 0,
  wake_hits INTEGER NOT NULL DEFAULT 0,
  picked_at INTEGER,
  nagged_at INTEGER,
  approved_at INTEGER,
  again INTEGER,
  -- Set when the cause is an outside service (yahoo, google_ai, supabase,
  -- vercel, resend): nothing of ours to change, so the agent is not started.
  -- Live databases made before this column: ALTER TABLE gate ADD COLUMN outside TEXT;
  outside TEXT
);
CREATE INDEX IF NOT EXISTS gate_due ON gate (state, next_at);

-- Short notes left by the owner's own work sessions (what changed and why),
-- so the agent knows what happened today before it touches anything.
CREATE TABLE IF NOT EXISTS note (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_at ON note (at);

-- The journey robot: one row per step of each run (login, portfolio, prices,
-- order, Saathi, register page). Kept 14 days.
CREATE TABLE IF NOT EXISTS robot_run (
  t INTEGER NOT NULL, step TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0, why TEXT, what TEXT,
  PRIMARY KEY (t, step)
) WITHOUT ROWID;
-- Sign-up flow counted from the site's own events as they happen, in
-- 10-minute buckets: view, start, submit, error, otp.
CREATE TABLE IF NOT EXISTS flow (
  bucket INTEGER NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, k)
) WITHOUT ROWID;

-- Reflexes (tell-only): one row each time a reflex says "I would have done
-- X because Y" while something serious was happening and the agent could not
-- start. kind 'none' = it looked and nothing fitted. Nothing here is ever
-- acted on; `after` is filled five minutes later (still | eased), `verdict`
-- by the owner (right | wrong) or by the follow-up (unneeded).
CREATE TABLE IF NOT EXISTS reflex (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, fp TEXT NOT NULL, issue_id INTEGER, kind TEXT NOT NULL,
  why_blocked TEXT, would TEXT, because TEXT, target TEXT, after TEXT, after_at INTEGER, verdict TEXT, verdict_at INTEGER, note TEXT
);
CREATE INDEX IF NOT EXISTS reflex_fp ON reflex (fp, at);
-- The Ask box: the owner's questions and the answers. Kept 60 days.
CREATE TABLE IF NOT EXISTS ask (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, q TEXT NOT NULL, a TEXT, ok INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0
);
