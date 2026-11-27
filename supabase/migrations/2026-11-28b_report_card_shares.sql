-- Public links to a report card (28 Nov 2026).
--
-- A student taps WhatsApp / Copy link in "Send my card" and the server saves
-- that week's card here under a short token. /c/<token> is a page anyone can
-- open; it shows the name, grade and marks only (no rupee amounts, no stock
-- names) and is what gives WhatsApp its picture preview.
--
-- A row is made only when the student asks for a link, and `active = false`
-- switches it off. The numbers are copied from report_card_weeks (scored on
-- the server), never taken from the browser.
--
-- No policies on purpose: only the service role (api/ai.js) reads or writes.

create table if not exists public.report_card_shares (
  token       text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  week_start  date not null,
  name        text not null default '',
  score       integer not null,
  grade       text not null,
  parts       jsonb not null default '{}'::jsonb,
  platings    jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, week_start)
);

alter table public.report_card_shares enable row level security;
revoke all on public.report_card_shares from anon, authenticated;
