-- Report card, the weekly card (28 Nov 2026).
--
-- 1. Research was unfair to taps. For each buy, _report_card_signals counted
--    what the student did BEFORE the trade's time. For an order the matcher
--    filled (after-hours and limit orders) that time is the FILL, so the
--    evening visit on which the order was placed counted as "looked into it on
--    an earlier day". Measured on the 80 accounts with the most filled orders:
--    99% of matcher-filled buys read as looked into, 65% of taps. The decision
--    was made when the order was PLACED: measure from limit_orders.created_at.
--    The row still carries the fill time (the page matches it to the trade).
--
-- 2. report_card_weeks: one saved card per student per week (Monday, IST).
--    Nothing was saved before, so the page could show no progress and the
--    grade moved with prices inside a week. Written only by the server
--    (api/ai.js op report-card-week, which scores with the same modules the
--    page runs); students read their own rows.
--
-- No DROP or DELETE (the connector cannot run them).

do $$
declare
  def text;
  src text;
begin
  select pg_get_functiondef(p.oid), p.prosrc into def, src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = '_report_card_signals';
  if def is null then raise exception '_report_card_signals not found'; end if;
  if position(' as dt' in src) > 0 then
    raise notice '_report_card_signals already measures from the order time';
    return;
  end if;
  if md5(src) <> 'fe982e7c87f8b712703cf274012351ba' then
    raise exception '_report_card_signals is not the version this patch was written for (%).', md5(src);
  end if;
  def := replace(def,
    'select t.created_at as ts, t.symbol',
    'select t.created_at as ts, t.symbol, coalesce((select lo.created_at from public.limit_orders lo where lo.filled_txn_id = t.id order by lo.created_at limit 1), t.created_at) as dt');
  def := replace(def, 'b.ts', 'b.dt');
  def := replace(def, 'select b.dt, b.symbol,', 'select b.ts, b.symbol,');
  if position(' as dt' in def) = 0 or position('select b.ts, b.symbol,' in def) = 0 or position('b.dt - interval ''14 days''' in def) = 0 then
    raise exception 'patch did not apply cleanly';
  end if;
  execute def;
end $$;

create table if not exists public.report_card_weeks (
  user_id         uuid        not null references auth.users (id) on delete cascade,
  week_start      date        not null,                          -- Monday of the IST week
  score           smallint    not null check (score between 0 and 100),
  grade           text        not null check (grade in ('A+', 'A', 'B+', 'B', 'C', 'D')),   -- the letter shown (it holds until 2 marks under its cut point)
  raw_grade       text,                                           -- the letter the score alone gives
  parts           jsonb       not null default '{}'::jsonb,       -- { discipline: 80, results: 58, ..., market: null }
  platings        jsonb       not null default '{}'::jsonb,       -- { discipline: "gold", ... }
  first_scored_at timestamptz not null default now(),
  scored_at       timestamptz not null default now(),
  primary key (user_id, week_start)
);
comment on table public.report_card_weeks is 'One saved report card per student per IST week. Written by the server only (api/ai.js op report-card-week).';

alter table public.report_card_weeks enable row level security;
revoke all on public.report_card_weeks from public, anon, authenticated;
grant select on public.report_card_weeks to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_card_weeks' and policyname = 'report_card_weeks_own') then
    create policy report_card_weeks_own on public.report_card_weeks for select to authenticated using (user_id = (select auth.uid()));
  end if;
end $$;
