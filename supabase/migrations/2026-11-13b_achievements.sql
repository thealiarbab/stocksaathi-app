-- =============================================================================
-- Achievements (queue item #3, 13 Nov 2026). Applied to production in parts
-- through the Supabase connector (achievements_a ... achievements_m); this
-- file is the same SQL in one place. Idempotent.
--
-- The DATABASE awards achievements: _ach_facts() derives every metric from
-- the trades, events and real closes; _ach_eval() compares them with
-- public.achievement_defs; _ach_award() inserts and notifies. Users read
-- their own rows only (no writes). Rule twin in JS: js/achievements/core.js
-- (tests: scripts/test-achievements.mjs). See AGENTS.md, "Achievements".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Real daily closes for the rules (bhavcopy since 2026-09-25; the Yahoo
--    daily bars fetched on 2026-10-24 for every traded symbol before that).
-- ---------------------------------------------------------------------------
create table if not exists public.hist_daily_closes (
  symbol      text not null,
  d           date not null,
  close_paise bigint not null check (close_paise > 0),
  source      text not null default 'yahoo_daily',
  primary key (symbol, d)
);
alter table public.hist_daily_closes enable row level security;
revoke all on public.hist_daily_closes from public, anon, authenticated;
grant all on public.hist_daily_closes to service_role;

insert into public.hist_daily_closes (symbol, d, close_paise)
select distinct on (z.symbol, d) z.symbol, d, c
from (
  select z.symbol, (to_timestamp((b->>'t')::bigint / 1000) at time zone 'Asia/Kolkata')::date as d, (b->>'c')::numeric::bigint as c, z.fetched_at
  from public.zz_bias_eval_bars z, jsonb_array_elements(z.bars) b
  where z.status = 200 and jsonb_typeof(z.bars) = 'array' and (b->>'c') is not null
) z
where z.d < date '2026-09-25' and z.c > 0
order by z.symbol, z.d, z.fetched_at desc
on conflict do nothing;

create or replace view public.real_daily_closes
with (security_invoker = true) as
  select symbol, trade_date as d, close_paise, 'nse_eod'::text as source from public.nse_eod_prices
  union all
  select h.symbol, h.d, h.close_paise, h.source from public.hist_daily_closes h
  where not exists (select 1 from public.nse_eod_prices n where n.symbol = h.symbol and n.trade_date = h.d);
revoke all on public.real_daily_closes from public, anon, authenticated;
grant select on public.real_daily_closes to service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- Dated market events. Next year's dates are an insert (see AGENTS.md,
-- "Achievements"). Seasonal achievements refer to a KIND, so a new row of
-- that kind counts automatically.
create table if not exists public.market_events (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('results_season', 'budget', 'rbi_policy', 'diwali', 'month_end', 'quarter_end', 'fy_start', 'other')),
  name        text not null check (char_length(name) between 2 and 80),
  starts_on   date not null,
  ends_on     date not null,
  note        text,
  drafts_requested_at timestamptz,   -- AI drafting asked for (pg_net, see _ach_request_drafts)
  drafted_at  timestamptz,           -- drafts arrived in the approval queue
  created_at  timestamptz not null default now(),
  check (ends_on >= starts_on),
  unique (kind, starts_on)
);
alter table public.market_events enable row level security;
revoke all on public.market_events from public, anon, authenticated;
grant all on public.market_events to service_role;

-- One row per achievement tier. Core rows are seeded from
-- js/achievements/core.js (scripts/achievements-seed.mjs); AI-drafted
-- seasonal rows arrive as status 'draft' and go live only when the owner
-- approves them on /a.
create table if not exists public.achievement_defs (
  code        text primary key check (code ~ '^[a-z0-9_]{2,60}$'),
  family      text not null,
  tier        smallint not null check (tier between 1 and 4),
  tiers       smallint not null default 1 check (tiers between 1 and 4),
  category    text not null check (category in ('milestone', 'habit', 'learning', 'streak', 'season')),
  emoji       text not null default '🏅',
  name_en     text not null, name_hi text not null,
  desc_en     text not null, desc_hi text not null,
  why_en      text not null, why_hi text not null,
  metric      text not null,          -- a key of _ach_facts().m, or 'season'
  threshold   numeric not null check (threshold > 0),
  rule        jsonb,                  -- season: {event_kind | event_id, pad: [before, after], need: {metric: min}}
  status      text not null default 'active' check (status in ('draft', 'active', 'retired', 'rejected')),
  source      text not null default 'core' check (source in ('core', 'ai')),
  event_id    bigint references public.market_events (id),
  draft_note  text,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  approved_at timestamptz,
  approved_by text
);
alter table public.achievement_defs enable row level security;
revoke all on public.achievement_defs from public, anon, authenticated;
grant all on public.achievement_defs to service_role;

-- What each user earned. Written ONLY by the database (_ach_award). Users
-- read their own rows; they cannot insert, update or delete any.
create table if not exists public.user_achievements (
  user_id     uuid not null references auth.users (id) on delete cascade,
  code        text not null references public.achievement_defs (code),
  earned_at   timestamptz not null default now(),
  evidence    jsonb not null default '{}'::jsonb,   -- the user's own numbers behind it
  seen_at     timestamptz,                          -- the toast or list showed it (ach_mark_seen)
  backfilled  boolean not null default false,       -- earned on the first pass, from history
  seeded      boolean not null default false,       -- owner preview sample, not earned
  primary key (user_id, code)
);
create index if not exists user_achievements_code_idx on public.user_achievements (code);
create index if not exists user_achievements_unseen_idx on public.user_achievements (user_id) where seen_at is null;
alter table public.user_achievements enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_achievements' and policyname = 'user_achievements_self_read') then
    create policy user_achievements_self_read on public.user_achievements
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;
end $$;
revoke all on public.user_achievements from public, anon, authenticated;
grant select on public.user_achievements to authenticated;
grant all on public.user_achievements to service_role;

-- Server-side bookkeeping per user (throttle for ach_check).
create table if not exists public.user_achievement_state (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  last_check_at timestamptz,
  last_award_at timestamptz
);
alter table public.user_achievement_state enable row level security;
revoke all on public.user_achievement_state from public, anon, authenticated;
grant all on public.user_achievement_state to service_role;

-- One row of switches. rollout 'owner' = admin accounts only (is_admin());
-- the owner flips it to 'all' on /a when everyone should get achievements.
create table if not exists public.achievement_settings (
  id          boolean primary key default true check (id),
  rollout     text not null default 'owner' check (rollout in ('owner', 'all')),
  auto_draft  boolean not null default true,
  last_sweep  timestamptz,
  last_full_sweep date,
  updated_at  timestamptz not null default now()
);
insert into public.achievement_settings (id) values (true) on conflict do nothing;
alter table public.achievement_settings enable row level security;
revoke all on public.achievement_settings from public, anon, authenticated;
grant all on public.achievement_settings to service_role;
-- ---------------------------------------------------------------------------
-- 3. Facts: every metric the catalogue compares, per user, with the user's
--    own numbers behind it. The SQL twin of deriveFacts() in
--    js/achievements/core.js; keep the two in step (scripts/test-achievements.mjs
--    pins the JS side down).
-- ---------------------------------------------------------------------------
create or replace function public._ach_facts(p_users uuid[])
returns table (user_id uuid, m jsonb, ev jsonb)
language sql
stable
set search_path = public, pg_temp
as $$
with u as (select distinct x as user_id from unnest(p_users) x),
inst as (
  select d.symbol,
         case when d.kind = 'ETF' then 'Funds' when d.sector in ('Other', 'ETF') or d.sector is null then null else d.sector end as sector,
         (d.kind = 'ETF') as is_fund
    from public.dhan_instruments d
  union all
  select mf.symbol, 'Funds', true from public.mf_master mf
   where not exists (select 1 from public.dhan_instruments d where d.symbol = mf.symbol)
),
tx as (
  select t.user_id, t.symbol, t.side, t.qty::numeric as qty, t.price_paise::numeric as px, t.created_at, t.id, t.bias_flags,
         sum(case when t.side = 'BUY' then t.qty else -t.qty end) over w as pos_after
    from public.transactions t join u using (user_id)
   where t.side in ('BUY', 'SELL')
  window w as (partition by t.user_id, t.symbol order by t.created_at, t.id)
),
tx2 as (
  select *, sum(case when side = 'BUY' and pos_after - qty <= 0.000001 then 1 else 0 end)
              over (partition by user_id, symbol order by created_at, id) as ep
    from tx
),
tx4 as (
  select *,
         sum(case when side = 'BUY' then qty * px else 0 end) over w2 as buy_val_run,
         sum(case when side = 'BUY' then qty else 0 end) over w2 as buy_qty_run,
         min(created_at) over (partition by user_id, symbol, ep) as ep_t0
    from tx2 where ep > 0
  window w2 as (partition by user_id, symbol, ep order by created_at, id rows unbounded preceding)
),
ep as (
  select e.user_id, e.symbol, e.ep, min(e.created_at) as t0,
         max(e.created_at) filter (where e.pos_after <= 0.000001) as t_end,
         sum(e.qty * e.px) filter (where e.side = 'BUY') / nullif(sum(e.qty) filter (where e.side = 'BUY'), 0) as avg_buy,
         (array_agg(e.px order by e.created_at, e.id))[1] as first_px
    from tx4 e group by 1, 2, 3
),
ep2 as (
  select e.*, i.sector, coalesce(i.is_fund, false) as is_fund,
         floor(extract(epoch from (coalesce(e.t_end, now()) - e.t0)) / 86400)::int as hold_days,
         (e.t0 at time zone 'Asia/Kolkata')::date as d0,
         (e.t_end at time zone 'Asia/Kolkata')::date as d_end
    from ep e left join inst i using (symbol)
),
-- milestones from trades
f_first as (
  select distinct on (user_id) user_id, symbol, (created_at at time zone 'Asia/Kolkata')::date as d
    from tx order by user_id, created_at, id
),
f_ntx as (select user_id, count(*) as n from tx group by 1),
prof as (
  select user_id, symbol, ep, ep_t0, created_at, round((px / (buy_val_run / buy_qty_run) - 1) * 100, 1) as pct
    from tx4 where side = 'SELL' and buy_qty_run > 0 and px > buy_val_run / buy_qty_run
),
f_profit as (select distinct on (user_id) user_id, symbol, pct from prof order by user_id, created_at),
f_patient as (
  select user_id, count(distinct (symbol, ep)) as n,
         (array_agg(symbol order by created_at desc))[1] as symbol
    from prof where created_at - ep_t0 >= interval '30 days' group by 1
),
f_hold as (select distinct on (user_id) user_id, hold_days, symbol from ep2 order by user_id, hold_days desc, t0),
f_fhold as (select distinct on (user_id) user_id, hold_days, symbol from ep2 where is_fund order by user_id, hold_days desc, t0),
f_fund as (
  select t.user_id, count(*) as n, (array_agg(t.symbol order by t.created_at, t.id))[1] as symbol,
         count(distinct to_char(t.created_at at time zone 'Asia/Kolkata', 'YYYY-MM')) as months
    from tx t join inst i using (symbol) where t.side = 'BUY' and i.is_fund group by 1
),
f_sect as (
  select distinct on (user_id) user_id, n, sectors from (
    select a.user_id, a.t0, count(distinct b.sector) as n, array_agg(distinct b.sector order by b.sector) as sectors
      from ep2 a join ep2 b on b.user_id = a.user_id and b.t0 <= a.t0 and (b.t_end is null or b.t_end > a.t0) and b.sector is not null
     group by 1, 2) z
   order by user_id, n desc, t0
),
-- dips held and comebacks, on real closes (public.real_daily_closes)
epr as (
  select e.user_id, e.symbol, e.ep, e.avg_buy, e.first_px, e.d0, e.d_end, r.close_paise as ref
    from ep2 e
    cross join lateral (
      select c.close_paise from public.real_daily_closes c
       where c.symbol = e.symbol and c.d <= e.d0 and c.d > e.d0 - 7
       order by c.d desc limit 1) r
   where e.avg_buy > 0
),
ok as (select * from epr where abs(first_px / ref - 1) <= 0.25),
win as (
  select o.user_id, o.symbol, o.ep, o.avg_buy, c.d, c.close_paise::numeric as c,
         lag(c.close_paise) over (partition by o.user_id, o.symbol, o.ep order by c.d) as pc
    from ok o join public.real_daily_closes c
      on c.symbol = o.symbol and c.d > o.d0 and (o.d_end is null or c.d < o.d_end)
     and c.d <= (now() at time zone 'Asia/Kolkata')::date
),
epx as (
  select user_id, symbol, ep, avg_buy,
         bool_or(pc is not null and c / pc < 0.6) as bad,
         min(d) filter (where (avg_buy - c) / avg_buy >= 0.05) as dip_day
    from win group by 1, 2, 3, 4
),
lows as (
  select distinct on (w.user_id, w.symbol, w.ep) w.user_id, w.symbol, w.ep, (w.avg_buy - w.c) / w.avg_buy as dd, w.d
    from win w join epx x using (user_id, symbol, ep)
   where not x.bad
   order by w.user_id, w.symbol, w.ep, (w.avg_buy - w.c) / w.avg_buy desc, w.d
),
f_dip as (
  select distinct on (user_id) user_id, floor(dd * 1000) / 10 as pct, symbol, d
    from lows where dd > 0 order by user_id, dd desc, d
),
cbk as (
  select x.user_id, x.symbol, x.ep, min(w.d) as back_on
    from epx x join win w using (user_id, symbol, ep)
   where not x.bad and x.dip_day is not null and w.d > x.dip_day and w.c >= w.avg_buy
   group by 1, 2, 3
),
f_cb as (select user_id, count(*) as n, (array_agg(symbol order by back_on desc))[1] as symbol from cbk group by 1),
-- balanced basket on today's holdings, at real prices
hv as (
  select h.user_id, h.symbol,
         h.qty * coalesce(q.price_paise,
                          (select c.close_paise from public.real_daily_closes c where c.symbol = h.symbol order by c.d desc limit 1),
                          h.avg_cost_paise)::numeric as v
    from public.holdings h join u using (user_id)
    left join public.quote_cache q on q.symbol = h.symbol
   where h.qty > 0
),
f_bal as (
  select user_id, count(*) as n, max(v) / nullif(sum(v), 0) as top
    from hv where v > 0 group by 1
),
f_limit as (
  select l.user_id, count(*) as n from public.limit_orders l join u using (user_id)
   where l.status = 'filled' and l.order_type = 'LIMIT' group by 1
),
-- events: user_events + coach + learn_events, in one shape
evs as (
  select e.user_id, e.kind, e.subject, e.occurred_at as at
    from public.user_events e join u using (user_id)
   where e.kind in ('page_view', 'stock_view', 'news_click', 'replay_finish', 'replay_start')
  union all
  select c.user_id, case c.event_type when 'chat_user' then 'chat_user' else 'crash_end' end, c.trigger_symbol, c.created_at
    from public.coach_messages c join u using (user_id)
   where c.event_type in ('chat_user', 'CRASH_SIMULATION_END')
  union all
  select l.user_id, 'learn', l.kind || ':' || coalesce(l.subject, ''), l.occurred_at
    from public.learn_events l join u using (user_id)
),
evd as (
  select user_id, kind, subject, at, (at at time zone 'Asia/Kolkata')::date as d,
         (kind = 'page_view' and (subject like '/learn/%' or subject like '/learn-stock-market%')) as lesson
    from evs
),
f_learn as (
  select user_id,
    count(distinct subject) filter (where kind in ('replay_finish', 'crash_end') and subject is not null) as replays,
    count(distinct d) filter (where kind = 'chat_user') as q_days,
    count(distinct case when lesson then split_part(subject, '?', 1) when kind = 'learn' then 'learn:' || subject end) as reads,
    count(distinct subject) filter (where kind = 'stock_view' and subject is not null) as stocks,
    count(distinct d) filter (where kind = 'news_click') as news_days,
    count(distinct d) filter (where kind in ('page_view', 'chat_user')) as visit_days,
    bool_or(at > now() - interval '14 days') as recent
    from evd group by 1
),
learn_days as (
  select distinct user_id, d from evd
   where kind in ('chat_user', 'news_click', 'replay_start', 'replay_finish', 'crash_end', 'learn') or lesson
),
ls as (select user_id, d, case when d - lag(d) over (partition by user_id order by d) <= 2 then 0 else 1 end as brk from learn_days),
ls2 as (select user_id, sum(brk) over (partition by user_id order by d) as g from ls),
f_ls as (select user_id, max(n) as n from (select user_id, g, count(*) as n from ls2 group by 1, 2) z group by 1),
wk as (select distinct user_id, date_trunc('week', d)::date as w from evd where kind in ('page_view', 'chat_user')),
ws as (select user_id, w, case when w - lag(w) over (partition by user_id order by w) <= 14 then 0 else 1 end as brk from wk),
ws2 as (select user_id, sum(brk) over (partition by user_id order by w) as g from ws),
f_ws as (select user_id, max(n) as n from (select user_id, g, count(*) as n from ws2 group by 1, 2) z group by 1),
-- slept on it: first buy on a later day than the first look at that stock
fv as (select user_id, subject as symbol, min(d) as d from evd where kind = 'stock_view' and subject is not null group by 1, 2),
fb as (select user_id, symbol, min(created_at) as at from tx where side = 'BUY' group by 1, 2),
f_slept as (
  select fb.user_id, count(*) as n, (array_agg(fb.symbol order by fb.at desc))[1] as symbol
    from fb join fv using (user_id, symbol)
   where fv.d < (fb.at at time zone 'Asia/Kolkata')::date group by 1
),
hw as (
  select w.user_id, w.symbol, w.added_at, min(t.created_at) as bought
    from public.watchlist w join u using (user_id)
    join tx t on t.user_id = w.user_id and t.symbol = w.symbol and t.side = 'BUY' and t.created_at >= w.added_at + interval '7 days'
   group by 1, 2, 3
),
f_hw as (
  select user_id, count(*) as n,
         (array_agg(symbol order by bought desc))[1] as symbol,
         (array_agg(floor(extract(epoch from (bought - added_at)) / 86400)::int order by bought desc))[1] as days
    from hw group by 1
),
-- calm hands and getting better (trades since flags began, 2026-10-24)
fl as (
  select user_id, created_at, id,
         exists (select 1 from jsonb_array_elements(case when jsonb_typeof(bias_flags) = 'array' then bias_flags else '[]'::jsonb end) f
                  where f ? 'severity' and jsonb_typeof(f->'severity') = 'number' and (f->>'severity')::numeric >= 0.5) as flagged
    from tx where created_at >= timestamptz '2026-10-24 00:00:00+00'
),
fl2 as (select *, sum(flagged::int) over (partition by user_id order by created_at, id) as grp from fl),
f_calm as (
  select distinct on (user_id) user_id, days, n from (
    select user_id, grp, count(*) as n, floor(extract(epoch from (max(created_at) - min(created_at))) / 86400)::int as days
      from fl2 where not flagged group by 1, 2) r
   where n >= 3 order by user_id, days desc
),
fl3 as (select *, row_number() over (partition by user_id order by created_at desc, id desc) as rn from fl),
f_imp as (
  select user_id,
         avg(flagged::int) filter (where rn between 16 and 30) as a,
         avg(flagged::int) filter (where rn <= 15) as b
    from fl3 group by 1 having count(*) >= 30
),
prof_u as (select p.id as user_id, p.created_at from public.profiles p join u on u.user_id = p.id),
f_recent_tx as (select user_id, bool_or(created_at > now() - interval '14 days') as recent from tx group by 1)
select u.user_id,
  jsonb_build_object(
    'trades', coalesce(nt.n, 0),
    'profit_booked', case when pr.user_id is null then 0 else 1 end,
    'limit_fills', coalesce(lf.n, 0),
    'fund_buys', coalesce(fu.n, 0),
    'member_days', case when coalesce(fle.recent, false) or coalesce(rt.recent, false)
                        then floor(extract(epoch from (now() - pu.created_at)) / 86400)::int else 0 end,
    'visit_days', coalesce(fle.visit_days, 0),
    'max_hold_days', coalesce(fh.hold_days, 0),
    'dip_pct', coalesce(fd.pct, 0),
    'comebacks', coalesce(cb.n, 0),
    'max_sectors', coalesce(fs.n, 0),
    'balanced_level', case when fb2.n >= 10 and fb2.top <= 0.20 then 3 when fb2.n >= 6 and fb2.top <= 0.30 then 2
                           when fb2.n >= 4 and fb2.top <= 0.35 then 1 else 0 end,
    'fund_hold_days', coalesce(ffh.hold_days, 0),
    'fund_months', coalesce(fu.months, 0),
    'patient_profits', coalesce(pp.n, 0),
    'slept_on', coalesce(sl.n, 0),
    'homework', coalesce(hwk.n, 0),
    'calm_days', coalesce(ca.days, 0),
    'improver', case when im.a >= 0.2 and im.b <= im.a / 2 then 1 else 0 end,
    'replays', coalesce(fle.replays, 0),
    'question_days', coalesce(fle.q_days, 0),
    'reads', coalesce(fle.reads, 0),
    'stocks_viewed', coalesce(fle.stocks, 0),
    'news_days', coalesce(fle.news_days, 0),
    'learn_streak', coalesce(fls.n, 0),
    'week_streak', coalesce(fws.n, 0)
  ) as m,
  jsonb_strip_nulls(jsonb_build_object(
    'trades', case when ff.user_id is not null then jsonb_build_object('symbol', ff.symbol, 'date', to_char(ff.d, 'FMDD Mon YYYY')) end,
    'profit_booked', case when pr.user_id is not null then jsonb_build_object('symbol', pr.symbol, 'pct', pr.pct) end,
    'limit_fills', jsonb_build_object('n', coalesce(lf.n, 0)),
    'fund_buys', case when fu.user_id is not null then jsonb_build_object('symbol', fu.symbol) end,
    'member_days', jsonb_build_object('days', floor(extract(epoch from (now() - pu.created_at)) / 86400)::int),
    'visit_days', jsonb_build_object('n', coalesce(fle.visit_days, 0)),
    'max_hold_days', case when fh.user_id is not null then jsonb_build_object('days', fh.hold_days, 'symbol', fh.symbol) end,
    'dip_pct', case when fd.user_id is not null then jsonb_build_object('pct', fd.pct, 'symbol', fd.symbol, 'date', to_char(fd.d, 'FMDD Mon YYYY')) end,
    'comebacks', case when cb.user_id is not null then jsonb_build_object('n', cb.n, 'symbol', cb.symbol) end,
    'max_sectors', case when fs.user_id is not null then jsonb_build_object('n', fs.n, 'sectors', to_jsonb(fs.sectors)) end,
    'balanced_level', case when fb2.user_id is not null then jsonb_build_object('n', fb2.n, 'top_pct', round(fb2.top * 100, 1)) end,
    'fund_hold_days', case when ffh.user_id is not null then jsonb_build_object('days', ffh.hold_days, 'symbol', ffh.symbol) end,
    'fund_months', jsonb_build_object('months', coalesce(fu.months, 0)),
    'patient_profits', case when pp.user_id is not null then jsonb_build_object('n', pp.n, 'symbol', pp.symbol) end,
    'slept_on', case when sl.user_id is not null then jsonb_build_object('n', sl.n, 'symbol', sl.symbol) end,
    'homework', case when hwk.user_id is not null then jsonb_build_object('n', hwk.n, 'symbol', hwk.symbol, 'days', hwk.days) end,
    'calm_days', case when ca.user_id is not null then jsonb_build_object('days', ca.days, 'trades', ca.n) end,
    'improver', case when im.a >= 0.2 and im.b <= im.a / 2 then jsonb_build_object('before_pct', round(im.a * 100), 'after_pct', round(im.b * 100)) end,
    'replays', jsonb_build_object('n', coalesce(fle.replays, 0)),
    'question_days', jsonb_build_object('n', coalesce(fle.q_days, 0)),
    'reads', jsonb_build_object('n', coalesce(fle.reads, 0)),
    'stocks_viewed', jsonb_build_object('n', coalesce(fle.stocks, 0)),
    'news_days', jsonb_build_object('n', coalesce(fle.news_days, 0)),
    'learn_streak', jsonb_build_object('days', coalesce(fls.n, 0)),
    'week_streak', jsonb_build_object('weeks', coalesce(fws.n, 0))
  )) as ev
from u
left join prof_u pu using (user_id)
left join f_ntx nt using (user_id)
left join f_first ff using (user_id)
left join f_profit pr using (user_id)
left join f_patient pp using (user_id)
left join f_hold fh using (user_id)
left join f_fhold ffh using (user_id)
left join f_fund fu using (user_id)
left join f_sect fs using (user_id)
left join f_dip fd using (user_id)
left join f_cb cb using (user_id)
left join f_bal fb2 using (user_id)
left join f_limit lf using (user_id)
left join f_learn fle using (user_id)
left join f_ls fls using (user_id)
left join f_ws fws using (user_id)
left join f_slept sl using (user_id)
left join f_hw hwk using (user_id)
left join f_calm ca using (user_id)
left join f_imp im using (user_id)
left join f_recent_tx rt using (user_id);
$$;
revoke all on function public._ach_facts(uuid[]) from public, anon, authenticated;
-- ---------------------------------------------------------------------------
-- 4. Seasonal: for every active 'season' definition, how many of its market
--    events each user took part in (the window is the event's dates plus the
--    rule's pad). Twin of deriveSeason() in js/achievements/core.js.
-- ---------------------------------------------------------------------------
create or replace function public._ach_season(p_users uuid[])
returns table (user_id uuid, code text, n int, event text, d date)
language sql
stable
set search_path = public, pg_temp
as $$
with u as (select distinct x as user_id from unnest(p_users) x),
today as (select (now() at time zone 'Asia/Kolkata')::date as t),
wins as (
  select a.code, a.rule->'need' as need, e.id as event_id, e.name, e.starts_on,
         e.starts_on - coalesce((a.rule->'pad'->>0)::int, 0) as wa,
         e.ends_on + coalesce((a.rule->'pad'->>1)::int, 0) as wb
    from public.achievement_defs a
    join public.market_events e
      on (a.rule ? 'event_id' and e.id = (a.rule->>'event_id')::bigint)
      or (not (a.rule ? 'event_id') and e.kind = a.rule->>'event_kind')
   where a.status = 'active' and a.metric = 'season' and a.rule is not null
     and e.starts_on - coalesce((a.rule->'pad'->>0)::int, 0) <= (select t from today)
),
span as (select min(wa) as a, max(wb) as b from wins),
act as (
  select e.user_id, (e.occurred_at at time zone 'Asia/Kolkata')::date as d, e.kind, e.subject
    from public.user_events e join u using (user_id), span
   where e.kind in ('page_view', 'stock_view', 'news_click', 'replay_finish', 'replay_start')
     and e.occurred_at >= (span.a::timestamp at time zone 'Asia/Kolkata')
     and e.occurred_at < ((span.b + 1)::timestamp at time zone 'Asia/Kolkata')
  union all
  select c.user_id, (c.created_at at time zone 'Asia/Kolkata')::date,
         case c.event_type when 'chat_user' then 'chat_user' else 'crash_end' end, c.trigger_symbol
    from public.coach_messages c join u using (user_id), span
   where c.event_type in ('chat_user', 'CRASH_SIMULATION_END')
     and c.created_at >= (span.a::timestamp at time zone 'Asia/Kolkata')
     and c.created_at < ((span.b + 1)::timestamp at time zone 'Asia/Kolkata')
  union all
  select l.user_id, (l.occurred_at at time zone 'Asia/Kolkata')::date, 'learn', l.kind
    from public.learn_events l join u using (user_id), span
   where l.occurred_at >= (span.a::timestamp at time zone 'Asia/Kolkata')
     and l.occurred_at < ((span.b + 1)::timestamp at time zone 'Asia/Kolkata')
),
met as (
  select w.code, w.event_id, w.name, w.starts_on, w.need, a.user_id,
    count(distinct a.d) filter (where a.kind in ('page_view', 'chat_user')) as visit_days,
    count(*) filter (where a.kind in ('chat_user', 'news_click', 'replay_start', 'replay_finish', 'crash_end', 'learn')
                     or (a.kind = 'page_view' and (a.subject like '/learn/%' or a.subject like '/learn-stock-market%'))) as learn_actions,
    count(distinct a.subject) filter (where a.kind = 'stock_view') as stock_views,
    count(*) filter (where a.kind = 'page_view' and a.subject = '/report-card') as report_views,
    count(*) filter (where a.kind = 'page_view' and a.subject in ('/report-card', '/portfolio')) as review_views,
    count(*) filter (where a.kind = 'chat_user') as questions,
    count(*) filter (where a.kind in ('replay_finish', 'crash_end')) as replays,
    count(*) filter (where a.kind = 'news_click') as news_reads
    from wins w join act a on a.d between w.wa and w.wb
   group by 1, 2, 3, 4, 5, 6
),
-- Held through: a holding bought before the window opened and not sold out
-- until it closed. Judged only once the window is over.
tx as (
  select t.user_id, t.symbol, t.side, t.qty, t.created_at, t.id,
         sum(case when t.side = 'BUY' then t.qty else -t.qty end) over (partition by t.user_id, t.symbol order by t.created_at, t.id) as pos_after
    from public.transactions t join u using (user_id) where t.side in ('BUY', 'SELL')
),
tx2 as (select *, sum(case when side = 'BUY' and pos_after - qty <= 0.000001 then 1 else 0 end) over (partition by user_id, symbol order by created_at, id) as ep from tx),
ep as (select user_id, symbol, ep, min(created_at) as t0, max(created_at) filter (where pos_after <= 0.000001) as t_end from tx2 where ep > 0 group by 1, 2, 3),
held as (
  select w.code, w.event_id, w.name, w.starts_on, w.need, e.user_id
    from wins w join ep e
      on e.t0 < (w.wa::timestamp at time zone 'Asia/Kolkata')
     and (e.t_end is null or e.t_end >= ((w.wb + 1)::timestamp at time zone 'Asia/Kolkata'))
   where w.wb < (select t from today)
   group by 1, 2, 3, 4, 5, 6
),
allm as (
  select coalesce(m.code, h.code) as code, coalesce(m.event_id, h.event_id) as event_id,
         coalesce(m.name, h.name) as name, coalesce(m.starts_on, h.starts_on) as starts_on,
         coalesce(m.need, h.need) as need, coalesce(m.user_id, h.user_id) as user_id,
         jsonb_build_object(
           'visit_days', coalesce(m.visit_days, 0), 'learn_actions', coalesce(m.learn_actions, 0),
           'stock_views', coalesce(m.stock_views, 0), 'report_views', coalesce(m.report_views, 0),
           'review_views', coalesce(m.review_views, 0), 'questions', coalesce(m.questions, 0),
           'replays', coalesce(m.replays, 0), 'news_reads', coalesce(m.news_reads, 0),
           'held_through', case when h.user_id is null then 0 else 1 end) as mx
    from met m full join held h on h.code = m.code and h.event_id = m.event_id and h.user_id = m.user_id
),
ok as (
  select * from allm a
   where not exists (select 1 from jsonb_each_text(a.need) k
                      where coalesce((a.mx->>k.key)::numeric, 0) < k.value::numeric)
)
select user_id, code, count(*)::int as n,
       (array_agg(name order by starts_on desc))[1] as event,
       max(starts_on) as d
  from ok group by 1, 2;
$$;
revoke all on function public._ach_season(uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Evaluation and awarding
-- ---------------------------------------------------------------------------

-- Fill "{key}" in a copy template from the evidence. Twin of fill() in core.js.
create or replace function public._ach_fill(p_tpl text, p_ev jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  r record;
  s text := coalesce(p_tpl, '');
  v text;
begin
  for r in select key, value from jsonb_each(coalesce(p_ev, '{}'::jsonb)) loop
    v := case jsonb_typeof(r.value)
           when 'array' then (select string_agg(x, ', ') from jsonb_array_elements_text(r.value) x)
           when 'number' then case when (r.value)::text::numeric = trunc((r.value)::text::numeric)
                                   then trunc((r.value)::text::numeric)::text
                                   else to_char(round((r.value)::text::numeric, 1), 'FM999999990.0') end
           when 'null' then null
           else r.value #>> '{}' end;
    s := replace(s, '{' || r.key || '}', coalesce(nullif(v, ''), '—'));
  end loop;
  return regexp_replace(s, '\{[a-z_]+\}', '—', 'g');
end $$;
revoke all on function public._ach_fill(text, jsonb) from public, anon;

-- How a symbol reads in copy: a fund's short name ("Parag Parikh Flexi Cap
-- Fund"), not its MF_ code; stocks keep their ticker.
create or replace function public._ach_label(p_symbol text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((select left(split_part(m.name, ' - ', 1), 48) from public.mf_master m where m.symbol = p_symbol), p_symbol);
$$;
revoke all on function public._ach_label(text) from public, anon, authenticated;

-- Every active definition each user currently satisfies, with evidence.
create or replace function public._ach_eval(p_users uuid[])
returns table (user_id uuid, code text, evidence jsonb)
language sql
stable
set search_path = public, pg_temp
as $$
  select f.user_id, d.code,
         case when (f.ev -> d.metric) ? 'symbol'
              then jsonb_set(f.ev -> d.metric, '{symbol}', to_jsonb(public._ach_label(f.ev -> d.metric ->> 'symbol')))
              else coalesce(f.ev -> d.metric, '{}'::jsonb) end
           || jsonb_build_object('value', f.m -> d.metric)
    from public._ach_facts(p_users) f
    join public.achievement_defs d
      on d.status = 'active' and d.metric <> 'season'
     and coalesce((f.m ->> d.metric)::numeric, 0) >= d.threshold
  union all
  select s.user_id, d.code, jsonb_build_object('n', s.n, 'event', s.event, 'date', to_char(s.d, 'FMDD Mon YYYY'))
    from public._ach_season(p_users) s
    join public.achievement_defs d on d.code = s.code and d.status = 'active' and s.n >= d.threshold;
$$;
revoke all on function public._ach_eval(uuid[]) from public, anon, authenticated;

-- Users who get achievements right now: the owner accounts while rollout is
-- 'owner' (same set as is_admin()), everyone once the owner flips it.
create or replace function public._ach_in_scope(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user is not null and (
    (select rollout from public.achievement_settings where id) = 'all'
    or exists (select 1 from public.admin_users a where a.user_id = p_user)
    or p_user in ('63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid, '73c89104-24ab-47c0-9c71-5fe7c82323dc'::uuid)
  );
$$;
revoke all on function public._ach_in_scope(uuid) from public, anon, authenticated;

-- Award what the users now qualify for and tell them: one bell row per new
-- achievement, or ONE summary row when 3 or more arrive together (a
-- returning user who already qualifies for 12 gets "You've earned 12
-- achievements", not 12 pushes). Push and the 22:00-07:00 IST hold follow
-- from the notifications trigger. Returns {users, awarded}.
create or replace function public._ach_award(p_users uuid[], p_backfill boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_awarded int := 0;
  v_users int := 0;
  v_new jsonb;
  r record;
begin
  if p_users is null or cardinality(p_users) = 0 then
    return jsonb_build_object('users', 0, 'awarded', 0);
  end if;

  with ins as (
    insert into public.user_achievements (user_id, code, evidence, backfilled)
    select e.user_id, e.code, e.evidence, p_backfill
      from public._ach_eval(p_users) e
     where public._ach_in_scope(e.user_id)
    on conflict (user_id, code) do update
      set seeded = false, evidence = excluded.evidence, earned_at = now(), seen_at = null, backfilled = excluded.backfilled
      where public.user_achievements.seeded   -- a preview sample becomes the real thing
    returning user_id, code, evidence
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'code', code, 'evidence', evidence)), '[]'::jsonb)
    into v_new from ins;
  v_awarded := jsonb_array_length(v_new);

  for r in
    select n.user_id, count(*) as k,
           jsonb_agg(jsonb_build_object('code', n.code, 'tier', d.tier, 'family', d.family, 'name', d.name_en,
                                        'why', public._ach_fill(d.why_en, n.evidence))
                     order by d.tier desc, d.sort) as items
      from jsonb_to_recordset(v_new) as n(user_id uuid, code text, evidence jsonb)
      join public.achievement_defs d using (code)
     group by n.user_id
  loop
    v_users := v_users + 1;
    if r.k >= 3 then
      insert into public.notifications (user_id, kind, category, title, body, url, payload)
      values (r.user_id, 'achievement_summary', 'achievements',
              'You''ve earned ' || r.k || ' achievements',
              'Including ' || (select string_agg(nm, ', ' order by t desc, nm) from (
                                  select t, nm from (
                                    select distinct on (x->>'family') (x->>'tier')::int as t,
                                           (x->>'name') || case (x->>'tier')::int when 2 then ' (Silver)' when 3 then ' (Gold)' when 4 then ' (Platinum)' else '' end as nm
                                      from jsonb_array_elements(r.items) x
                                     order by x->>'family', (x->>'tier')::int desc) y
                                   order by t desc, nm limit 3) z)
                || '. Tap to see them all and what earned each one.',
              '/report-card#achievements',
              jsonb_build_object('codes', (select jsonb_agg(x->>'code') from jsonb_array_elements(r.items) x), 'count', r.k));
    else
      insert into public.notifications (user_id, kind, category, title, body, url, payload)
      select r.user_id, 'achievement', 'achievements',
             'Achievement unlocked: ' || (x->>'name')
               || case (x->>'tier')::int when 2 then ' (Silver)' when 3 then ' (Gold)' when 4 then ' (Platinum)' else '' end,
             left(x->>'why', 300),
             '/report-card#achievements',
             jsonb_build_object('codes', jsonb_build_array(x->>'code'), 'count', 1)
        from jsonb_array_elements(r.items) x;
    end if;
    insert into public.user_achievement_state (user_id, last_award_at) values (r.user_id, now())
    on conflict (user_id) do update set last_award_at = now();
  end loop;

  return jsonb_build_object('users', v_users, 'awarded', v_awarded);
end $$;
revoke all on function public._ach_award(uuid[], boolean) from public, anon, authenticated;

-- pg_cron, every 10 minutes: award everyone in scope who did something since
-- the last sweep; once a night (after 02:30 IST) everyone in scope, for the
-- achievements time alone can bring (days held, days since joining, an event
-- window closing).
create or replace function public.ach_sweep()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  s public.achievement_settings%rowtype;
  v_since timestamptz;
  v_users uuid[];
  v_full boolean;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  res jsonb;
begin
  select * into s from public.achievement_settings where id for update;
  v_since := coalesce(s.last_sweep, now() - interval '1 day') - interval '2 minutes';
  v_full := (s.last_full_sweep is distinct from v_today) and (now() at time zone 'Asia/Kolkata')::time >= time '02:30';

  if s.rollout = 'owner' then
    select array_agg(distinct x) into v_users from (
      select user_id as x from public.admin_users
      union select '63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid
      union select '73c89104-24ab-47c0-9c71-5fe7c82323dc'::uuid) z
     where exists (select 1 from auth.users au where au.id = z.x);
  elsif v_full then
    select array_agg(id) into v_users from public.profiles;
  else
    select array_agg(distinct x) into v_users from (
      select user_id as x from public.transactions where created_at >= v_since
      union select user_id from public.user_events where occurred_at >= v_since and user_id is not null
      union select user_id from public.coach_messages where created_at >= v_since
      union select user_id from public.learn_events where occurred_at >= v_since) z;
  end if;

  res := public._ach_award(coalesce(v_users, '{}'::uuid[]), false);
  update public.achievement_settings
     set last_sweep = now(), last_full_sweep = case when v_full then v_today else last_full_sweep end
   where id;
  return res || jsonb_build_object('full', v_full, 'rollout', s.rollout);
end $$;
revoke all on function public.ach_sweep() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Client RPCs (signed-in users; RLS-safe, self only)
-- ---------------------------------------------------------------------------

-- "Check me now", called after a trade or a replay so a fresh achievement
-- shows within seconds instead of at the next sweep. The server still
-- decides; at most once per 30 s per user.
create or replace function public.ach_check()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  last timestamptz;
  res jsonb;
begin
  if me is null or not public._ach_in_scope(me) then return jsonb_build_object('enabled', false); end if;
  select last_check_at into last from public.user_achievement_state where user_id = me;
  if last is not null and last > now() - interval '30 seconds' then
    return jsonb_build_object('enabled', true, 'throttled', true);
  end if;
  insert into public.user_achievement_state (user_id, last_check_at) values (me, now())
  on conflict (user_id) do update set last_check_at = now();
  res := public._ach_award(array[me], false);
  return jsonb_build_object('enabled', true, 'awarded', coalesce((res->>'awarded')::int, 0));
end $$;
revoke all on function public.ach_check() from public, anon;
grant execute on function public.ach_check() to authenticated;

-- Everything the achievements sheet shows, in one call: the catalogue, what
-- this user earned (with evidence) and their progress numbers.
create or replace function public.my_achievements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  f record;
begin
  if me is null or not public._ach_in_scope(me) then return jsonb_build_object('enabled', false); end if;
  select * into f from public._ach_facts(array[me]);
  return jsonb_build_object(
    'enabled', true,
    'defs', (select coalesce(jsonb_agg(jsonb_build_object(
               'code', d.code, 'family', d.family, 'tier', d.tier, 'tiers', d.tiers, 'category', d.category, 'emoji', d.emoji,
               'name_en', d.name_en, 'name_hi', d.name_hi, 'desc_en', d.desc_en, 'desc_hi', d.desc_hi,
               'why_en', d.why_en, 'why_hi', d.why_hi, 'metric', d.metric, 'threshold', d.threshold, 'source', d.source)
               order by d.sort, d.code), '[]'::jsonb)
             from public.achievement_defs d
            where d.status = 'active'
               or exists (select 1 from public.user_achievements x where x.user_id = me and x.code = d.code)),
    'earned', (select coalesce(jsonb_agg(jsonb_build_object(
                 'code', a.code, 'earned_at', a.earned_at, 'evidence', a.evidence, 'seen', a.seen_at is not null,
                 'seeded', a.seeded) order by a.earned_at desc), '[]'::jsonb)
               from public.user_achievements a where a.user_id = me),
    'facts', jsonb_build_object('m', coalesce(f.m, '{}'::jsonb),
               'season', (select coalesce(jsonb_object_agg(s.code, jsonb_build_object('n', s.n, 'event', s.event)), '{}'::jsonb)
                            from public._ach_season(array[me]) s))
  );
end $$;
revoke all on function public.my_achievements() from public, anon;
grant execute on function public.my_achievements() to authenticated;

-- The toast or the list has shown these. Only ever sets seen_at on the
-- caller's own rows; nothing else about an achievement can be changed.
create or replace function public.ach_mark_seen(p_codes text[] default null)
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  n int;
begin
  if me is null then return 0; end if;
  update public.user_achievements set seen_at = now()
   where user_id = me and seen_at is null and (p_codes is null or code = any(p_codes));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.ach_mark_seen(text[]) from public, anon;
grant execute on function public.ach_mark_seen(text[]) to authenticated;
-- ---------------------------------------------------------------------------
-- 7. Admin (/a → Achievements tab, via /api/ai op=admin-achievements*;
--    service_role only)
-- ---------------------------------------------------------------------------

-- Earned-by counts, the approval queue, the dated events and the switches.
create or replace function public.admin_ach_overview()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'settings', (select to_jsonb(s) from public.achievement_settings s where id),
    'defs', (select coalesce(jsonb_agg(jsonb_build_object(
               'code', d.code, 'family', d.family, 'tier', d.tier, 'category', d.category, 'emoji', d.emoji,
               'name_en', d.name_en, 'name_hi', d.name_hi, 'desc_en', d.desc_en, 'desc_hi', d.desc_hi,
               'why_en', d.why_en, 'why_hi', d.why_hi, 'metric', d.metric, 'threshold', d.threshold, 'rule', d.rule,
               'status', d.status, 'source', d.source, 'event_id', d.event_id, 'draft_note', d.draft_note,
               'created_at', d.created_at, 'approved_at', d.approved_at,
               'earned', (select count(*) from public.user_achievements a where a.code = d.code and not a.seeded),
               'seeded', (select count(*) from public.user_achievements a where a.code = d.code and a.seeded))
               order by case d.status when 'draft' then 0 else 1 end, d.sort, d.created_at), '[]'::jsonb)
             from public.achievement_defs d where d.status <> 'rejected' or d.created_at > now() - interval '30 days'),
    'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.starts_on), '[]'::jsonb)
                 from public.market_events e where e.ends_on >= (now() at time zone 'Asia/Kolkata')::date - 120),
    'users_with_any', (select count(distinct user_id) from public.user_achievements where not seeded)
  );
$$;
revoke all on function public.admin_ach_overview() from public, anon, authenticated;
grant execute on function public.admin_ach_overview() to service_role;

-- What the first pass WOULD award to everyone, without writing anything:
-- {users, per: {code: users}}. Used to tune thresholds before the rollout.
create or replace function public.admin_ach_dry_run()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with e as (select * from public._ach_eval(array(select id from public.profiles)))
  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'users_with_any', (select count(distinct user_id) from e),
    'per', (select coalesce(jsonb_object_agg(code, n), '{}'::jsonb) from (select code, count(*) as n from e group by 1) z),
    'max_per_user', (select max(n) from (select user_id, count(*) as n from e group by 1) z),
    'p90_per_user', (select percentile_disc(0.9) within group (order by n) from (select user_id, count(*) as n from e group by 1) z));
$$;
revoke all on function public.admin_ach_dry_run() from public, anon, authenticated;
grant execute on function public.admin_ach_dry_run() to service_role;

-- Owner actions. p = {action, code?, note?, rollout?, event?: {kind, name, starts_on, ends_on, note}}
create or replace function public.admin_ach_set(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a text := p->>'action';
  c text := p->>'code';
  n int;
  new_id bigint;
begin
  if a = 'approve' then
    update public.achievement_defs set status = 'active', approved_at = now(), approved_by = 'owner', updated_at = now()
     where code = c and status = 'draft';
  elsif a = 'reject' then
    update public.achievement_defs set status = 'rejected', draft_note = coalesce(nullif(p->>'note', ''), draft_note), updated_at = now()
     where code = c and status = 'draft';
  elsif a = 'retire' then
    update public.achievement_defs set status = 'retired', updated_at = now() where code = c and status = 'active';
  elsif a = 'restore' then
    update public.achievement_defs set status = 'active', updated_at = now() where code = c and status = 'retired';
  elsif a = 'edit_draft' then
    update public.achievement_defs set
      name_en = coalesce(nullif(p->>'name_en', ''), name_en), name_hi = coalesce(nullif(p->>'name_hi', ''), name_hi),
      desc_en = coalesce(nullif(p->>'desc_en', ''), desc_en), desc_hi = coalesce(nullif(p->>'desc_hi', ''), desc_hi),
      why_en = coalesce(nullif(p->>'why_en', ''), why_en), why_hi = coalesce(nullif(p->>'why_hi', ''), why_hi),
      updated_at = now()
     where code = c and status = 'draft';
  elsif a = 'rollout' then
    if p->>'rollout' not in ('owner', 'all') then return jsonb_build_object('ok', false, 'why', 'rollout must be owner or all'); end if;
    update public.achievement_settings set rollout = p->>'rollout', updated_at = now() where id;
  elsif a = 'auto_draft' then
    update public.achievement_settings set auto_draft = coalesce((p->>'on')::boolean, auto_draft), updated_at = now() where id;
  elsif a = 'add_event' then
    insert into public.market_events (kind, name, starts_on, ends_on, note)
    values (p->'event'->>'kind', p->'event'->>'name', (p->'event'->>'starts_on')::date,
            coalesce((p->'event'->>'ends_on')::date, (p->'event'->>'starts_on')::date), p->'event'->>'note')
    on conflict (kind, starts_on) do update set name = excluded.name, ends_on = excluded.ends_on, note = excluded.note
    returning id into new_id;
    return jsonb_build_object('ok', true, 'id', new_id);
  elsif a = 'request_drafts' then
    update public.market_events set drafts_requested_at = null, drafted_at = null where id = (p->>'event_id')::bigint;
    return jsonb_build_object('ok', true, 'requested', public._ach_request_drafts((p->>'event_id')::bigint));
  else
    return jsonb_build_object('ok', false, 'why', 'unknown action');
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0, 'changed', n);
end $$;
revoke all on function public.admin_ach_set(jsonb) from public, anon, authenticated;
grant execute on function public.admin_ach_set(jsonb) to service_role;

-- What the drafting model needs for one event: the event, the season's
-- existing achievements (so it does not repeat them) and the allowed metrics.
create or replace function public.admin_ach_draft_context(p_event bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'event', (select to_jsonb(e) from public.market_events e where e.id = p_event),
    'existing', (select coalesce(jsonb_agg(jsonb_build_object('name', d.name_en, 'desc', d.desc_en, 'status', d.status)), '[]'::jsonb)
                   from public.achievement_defs d
                  where d.category = 'season' and d.status in ('active', 'draft', 'rejected', 'retired')));
$$;
revoke all on function public.admin_ach_draft_context(bigint) from public, anon, authenticated;
grant execute on function public.admin_ach_draft_context(bigint) to service_role;

-- The drafting op hands its concepts here. Each is checked again (the model
-- is never trusted): metric whitelist (no trade counts), sane minimums, copy
-- lengths. Valid ones join the queue as status 'draft' and stay there until
-- the owner approves them. Returns {inserted, rejected: [{i, why}]}.
create or replace function public.admin_ach_draft_insert(p_event bigint, p_concepts jsonb, p_model text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  ev public.market_events%rowtype;
  c jsonb;
  i int := 0;
  ins int := 0;
  bad jsonb := '[]'::jsonb;
  why text;
  k record;
  allowed text[] := array['visit_days', 'learn_actions', 'stock_views', 'report_views', 'review_views', 'held_through', 'questions', 'replays', 'news_reads'];
  v_code text;
  pad jsonb;
  txt text;
  cap int;
begin
  select * into ev from public.market_events where id = p_event;
  if not found then return jsonb_build_object('inserted', 0, 'why', 'no such event'); end if;
  for c in select * from jsonb_array_elements(coalesce(p_concepts, '[]'::jsonb)) loop
    i := i + 1;
    why := null;
    if coalesce(char_length(c->>'name_en'), 0) not between 2 and 40 or coalesce(char_length(c->>'name_hi'), 0) not between 2 and 40 then why := 'name'; end if;
    if why is null and (coalesce(char_length(c->>'desc_en'), 0) not between 2 and 160 or coalesce(char_length(c->>'desc_hi'), 0) not between 2 and 160
        or coalesce(char_length(c->>'why_en'), 0) not between 2 and 160 or coalesce(char_length(c->>'why_hi'), 0) not between 2 and 160) then why := 'copy'; end if;
    if why is null and (jsonb_typeof(c->'tier') is distinct from 'number' or (c->>'tier')::numeric not in (1, 2, 3)) then why := 'tier'; end if;
    if why is null and (jsonb_typeof(c->'need') is distinct from 'object' or c->'need' = '{}'::jsonb) then why := 'need'; end if;
    if why is null then
      for k in select key, value from jsonb_each(c->'need') loop
        if not (k.key = any(allowed)) then why := 'metric ' || k.key; exit; end if;
        cap := 30;
        if k.key = 'held_through' then cap := 1; end if;
        if jsonb_typeof(k.value) <> 'number' or (k.value)::text::numeric <> trunc((k.value)::text::numeric)
           or (k.value)::text::numeric < 1 or (k.value)::text::numeric > cap then
          why := 'min ' || k.key; exit;
        end if;
      end loop;
    end if;
    pad := coalesce(c->'pad', '[0,0]'::jsonb);
    if why is null and (jsonb_typeof(pad) <> 'array' or jsonb_array_length(pad) <> 2
        or exists (select 1 from jsonb_array_elements(pad) x where jsonb_typeof(x) <> 'number' or (x)::text::numeric not between 0 and 14
                                                               or (x)::text::numeric <> trunc((x)::text::numeric))) then
      why := 'pad';
    end if;
    txt := lower(concat_ws(' ', c->>'name_en', c->>'desc_en', c->>'why_en', c->>'name_hi', c->>'desc_hi', c->>'why_hi'));
    if why is null and txt ~ '(trades? (every|daily|[0-9]+ times)|[0-9]+ trades|overtrad|lose your streak|streak khatam|don''?t lose)' then
      why := 'rewards a bad habit';
    end if;
    if why is not null then
      bad := bad || jsonb_build_object('i', i, 'why', why);
      continue;
    end if;
    v_code := 'ai_' || ev.kind || '_' || to_char(ev.starts_on, 'YYYYMMDD') || '_' || substr(md5(c::text), 1, 6);
    insert into public.achievement_defs (code, family, tier, tiers, category, emoji, name_en, name_hi, desc_en, desc_hi, why_en, why_hi,
                                         metric, threshold, rule, status, source, event_id, draft_note, sort)
    values (v_code, v_code, (c->>'tier')::int, 1, 'season', left(coalesce(nullif(c->>'emoji', ''), '🏅'), 8),
            c->>'name_en', c->>'name_hi', c->>'desc_en', c->>'desc_hi', c->>'why_en', c->>'why_hi',
            'season', 1, jsonb_build_object('event_id', ev.id, 'pad', pad, 'need', c->'need'),
            'draft', 'ai', ev.id, left(concat_ws(' · ', 'drafted by ' || coalesce(p_model, 'the model'), c->>'note'), 300), 5000)
    on conflict (code) do nothing;
    if found then ins := ins + 1; end if;
  end loop;
  update public.market_events set drafted_at = now() where id = p_event;
  return jsonb_build_object('inserted', ins, 'rejected', bad);
end $$;
revoke all on function public.admin_ach_draft_insert(bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.admin_ach_draft_insert(bigint, jsonb, text) to service_role;

-- Ask the drafting op (/api/ai?op=ach-draft, bearer = Vault cron_secret) for
-- concepts for ONE upcoming event: the next one starting within 21 days that
-- has none yet (month-ends are too frequent to need their own). One call a
-- day at most, so a failing endpoint never trips the ops pg_net alert.
-- p_event forces a specific event (the "Draft now" button on /a).
create or replace function public._ach_request_drafts(p_event bigint default null)
returns bigint
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  e public.market_events%rowtype;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if p_event is null and not coalesce((select auto_draft from public.achievement_settings where id), false) then
    return null;
  end if;
  select * into e from public.market_events m
   where (p_event is not null and m.id = p_event)
      or (p_event is null and m.kind <> 'month_end' and m.drafted_at is null
          and m.starts_on between today and today + 21
          and (m.drafts_requested_at is null or m.drafts_requested_at < now() - interval '2 days'))
   order by m.starts_on limit 1;
  if not found then return null; end if;
  perform net.http_post(
    url := 'https://stocksaathi.co.in/api/ai?op=ach-draft',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := jsonb_build_object('event_id', e.id),
    timeout_milliseconds := 30000);
  update public.market_events set drafts_requested_at = now() where id = e.id;
  return e.id;
exception when others then
  return null;
end $$;
revoke all on function public._ach_request_drafts(bigint) from public, anon, authenticated;
-- ---------------------------------------------------------------------------
-- 8. The market calendar (verified dates; app-defined windows for results
--    seasons). To add next year: insert rows like these (AGENTS.md).
-- ---------------------------------------------------------------------------
insert into public.market_events (kind, name, starts_on, ends_on, note) values
  -- Union Budget: 1 February by convention (2026 was a Sunday special session).
  ('budget', 'Union Budget 2026', '2026-02-01', '2026-02-01', null),
  ('budget', 'Union Budget 2027', '2027-02-01', '2027-02-01', 'Date by convention; confirm when announced'),
  -- RBI MPC decision days, FY 2026-27 (RBI press release 2025-2026/2306, 23 Mar 2026).
  ('rbi_policy', 'RBI policy, 8 Apr 2026', '2026-04-08', '2026-04-08', 'MPC 6-8 Apr'),
  ('rbi_policy', 'RBI policy, 5 Jun 2026', '2026-06-05', '2026-06-05', 'MPC 3-5 Jun'),
  ('rbi_policy', 'RBI policy, 5 Aug 2026', '2026-08-05', '2026-08-05', 'MPC 3-5 Aug'),
  ('rbi_policy', 'RBI policy, 7 Oct 2026', '2026-10-07', '2026-10-07', 'MPC 5-7 Oct'),
  ('rbi_policy', 'RBI policy, 4 Dec 2026', '2026-12-04', '2026-12-04', 'MPC 2-4 Dec'),
  ('rbi_policy', 'RBI policy, 5 Feb 2027', '2027-02-05', '2027-02-05', 'MPC 3-5 Feb'),
  -- Diwali: the Muhurat trading day (NSE: Sun 8 Nov 2026, 14:20-15:30 IST).
  ('diwali', 'Diwali 2026', '2026-11-08', '2026-11-08', 'Muhurat trading 14:20-15:30 IST'),
  -- Results seasons: most listed companies report in these windows.
  ('results_season', 'Q4 FY26 results season', '2026-04-10', '2026-05-31', null),
  ('results_season', 'Q1 FY27 results season', '2026-07-10', '2026-08-14', null),
  ('results_season', 'Q2 FY27 results season', '2026-10-08', '2026-11-14', null),
  ('results_season', 'Q3 FY27 results season', '2027-01-10', '2027-02-14', null),
  ('results_season', 'Q4 FY27 results season', '2027-04-10', '2027-05-31', null),
  ('quarter_end', 'June 2026 quarter-end', '2026-06-30', '2026-06-30', null),
  ('quarter_end', 'September 2026 quarter-end', '2026-09-30', '2026-09-30', null),
  ('quarter_end', 'December 2026 quarter-end', '2026-12-31', '2026-12-31', null),
  ('quarter_end', 'March 2027 year-end', '2027-03-31', '2027-03-31', null),
  ('fy_start', 'the 2026-27 financial year', '2026-04-01', '2026-04-01', null),
  ('fy_start', 'the 2027-28 financial year', '2027-04-01', '2027-04-01', null)
on conflict (kind, starts_on) do nothing;

-- Month-ends, April 2026 to March 2027.
insert into public.market_events (kind, name, starts_on, ends_on)
select 'month_end', to_char(d, 'FMMonth YYYY') || ' month-end', d, d
  from (select (date_trunc('month', m) + interval '1 month - 1 day')::date as d
          from generate_series(date '2026-04-01', date '2027-03-01', interval '1 month') m) z
on conflict (kind, starts_on) do nothing;

-- ---------------------------------------------------------------------------
-- 8b. The catalogue (generated: node scripts/achievements-seed.mjs)
-- ---------------------------------------------------------------------------
insert into public.achievement_defs
  (code, family, tier, tiers, category, emoji, name_en, name_hi, desc_en, desc_hi, why_en, why_hi, metric, threshold, rule, sort)
values
  ('first_steps', 'first_steps', 1, 1, 'milestone', '🌱', 'First Steps', 'Pehla Kadam', 'Place your first trade.', 'Apna pehla trade karo.', 'Your first trade was {symbol} on {date}.', 'Tumhara pehla trade {symbol} tha, {date} ko.', 'trades', 1, null, 10),
  ('first_profit', 'first_profit', 1, 1, 'milestone', '🪙', 'First Profit Booked', 'Pehla Munafa', 'Sell shares for more than you paid.', 'Shares ko kharid se zyada daam pe becho.', 'You sold {symbol} {pct}% above what you paid.', 'Tumne {symbol} kharid se {pct}% upar becha.', 'profit_booked', 1, null, 20),
  ('your_price_bronze', 'your_price', 1, 2, 'milestone', '🎯', 'Your Price', 'Apna Daam', 'Get 1 limit order filled at the price you chose.', '1 limit order apne chune hue daam pe fill karwao.', 'Limit orders filled at your price: {n}.', 'Tumhare {n} limit order tumhare daam pe fill hue.', 'limit_fills', 1, null, 30),
  ('your_price_silver', 'your_price', 2, 2, 'milestone', '🎯', 'Your Price', 'Apna Daam', 'Get 5 limit orders filled at the price you chose.', '5 limit order apne chune hue daam pe fill karwao.', 'Limit orders filled at your price: {n}.', 'Tumhare {n} limit order tumhare daam pe fill hue.', 'limit_fills', 5, null, 40),
  ('fund_first', 'fund_first', 1, 1, 'milestone', '🧺', 'Basket Buyer', 'Basket Wala', 'Buy your first mutual fund or ETF: many companies in one go.', 'Pehla mutual fund ya ETF kharido: ek saath kai companies.', 'Your first fund was {symbol}.', 'Tumhara pehla fund {symbol} tha.', 'fund_buys', 1, null, 50),
  ('old_friend_bronze', 'old_friend', 1, 3, 'milestone', '🤝', 'Old Friend', 'Purana Dost', 'Still learning with Saathi 30 days after joining.', 'Join karne ke 30 din baad bhi Saathi ke saath seekh rahe ho.', 'You joined {days} days ago and you''re still here.', 'Tum {days} din pehle jude the aur abhi bhi yahin ho.', 'member_days', 30, null, 60),
  ('old_friend_silver', 'old_friend', 2, 3, 'milestone', '🤝', 'Old Friend', 'Purana Dost', 'Still learning with Saathi 90 days after joining.', 'Join karne ke 90 din baad bhi Saathi ke saath seekh rahe ho.', 'You joined {days} days ago and you''re still here.', 'Tum {days} din pehle jude the aur abhi bhi yahin ho.', 'member_days', 90, null, 70),
  ('old_friend_gold', 'old_friend', 3, 3, 'milestone', '🤝', 'Old Friend', 'Purana Dost', 'Still learning with Saathi 180 days after joining.', 'Join karne ke 180 din baad bhi Saathi ke saath seekh rahe ho.', 'You joined {days} days ago and you''re still here.', 'Tum {days} din pehle jude the aur abhi bhi yahin ho.', 'member_days', 180, null, 80),
  ('regular_bronze', 'regular', 1, 3, 'milestone', '📅', 'Regular', 'Regular', 'Open StockSaathi on 10 different days.', '10 alag-alag din StockSaathi kholo.', 'You''ve opened the app on {n} different days.', 'Tumne {n} alag din app khola hai.', 'visit_days', 10, null, 90),
  ('regular_silver', 'regular', 2, 3, 'milestone', '📅', 'Regular', 'Regular', 'Open StockSaathi on 20 different days.', '20 alag-alag din StockSaathi kholo.', 'You''ve opened the app on {n} different days.', 'Tumne {n} alag din app khola hai.', 'visit_days', 20, null, 100),
  ('regular_gold', 'regular', 3, 3, 'milestone', '📅', 'Regular', 'Regular', 'Open StockSaathi on 40 different days.', '40 alag-alag din StockSaathi kholo.', 'You''ve opened the app on {n} different days.', 'Tumne {n} alag din app khola hai.', 'visit_days', 40, null, 110),
  ('long_termer_bronze', 'long_termer', 1, 4, 'habit', '🏛️', 'Long Termer', 'Lambi Soch', 'Hold one position for 30 days.', 'Ek position 30 din tak hold karo.', 'You''ve held {symbol} for {days} days.', 'Tumne {symbol} ko {days} din hold kiya.', 'max_hold_days', 30, null, 120),
  ('long_termer_silver', 'long_termer', 2, 4, 'habit', '🏛️', 'Long Termer', 'Lambi Soch', 'Hold one position for 60 days.', 'Ek position 60 din tak hold karo.', 'You''ve held {symbol} for {days} days.', 'Tumne {symbol} ko {days} din hold kiya.', 'max_hold_days', 60, null, 130),
  ('long_termer_gold', 'long_termer', 3, 4, 'habit', '🏛️', 'Long Termer', 'Lambi Soch', 'Hold one position for 90 days.', 'Ek position 90 din tak hold karo.', 'You''ve held {symbol} for {days} days.', 'Tumne {symbol} ko {days} din hold kiya.', 'max_hold_days', 90, null, 140),
  ('long_termer_platinum', 'long_termer', 4, 4, 'habit', '🏛️', 'Long Termer', 'Lambi Soch', 'Hold one position for 180 days.', 'Ek position 180 din tak hold karo.', 'You''ve held {symbol} for {days} days.', 'Tumne {symbol} ko {days} din hold kiya.', 'max_hold_days', 180, null, 150),
  ('held_the_line_bronze', 'held_the_line', 1, 3, 'habit', '🛡️', 'Held the Line', 'Datey Rahe', 'Keep holding while a stock you own is 5% below what you paid.', 'Jab stock kharid se 5% neeche ho, tab bhi hold karte raho.', '{symbol} closed {pct}% below your price on {date}, and you held on.', '{date} ko {symbol} tumhare daam se {pct}% neeche band hua, phir bhi tum date rahe.', 'dip_pct', 5, null, 160),
  ('held_the_line_silver', 'held_the_line', 2, 3, 'habit', '🛡️', 'Held the Line', 'Datey Rahe', 'Keep holding while a stock you own is 10% below what you paid.', 'Jab stock kharid se 10% neeche ho, tab bhi hold karte raho.', '{symbol} closed {pct}% below your price on {date}, and you held on.', '{date} ko {symbol} tumhare daam se {pct}% neeche band hua, phir bhi tum date rahe.', 'dip_pct', 10, null, 170),
  ('held_the_line_gold', 'held_the_line', 3, 3, 'habit', '🛡️', 'Held the Line', 'Datey Rahe', 'Keep holding while a stock you own is 20% below what you paid.', 'Jab stock kharid se 20% neeche ho, tab bhi hold karte raho.', '{symbol} closed {pct}% below your price on {date}, and you held on.', '{date} ko {symbol} tumhare daam se {pct}% neeche band hua, phir bhi tum date rahe.', 'dip_pct', 20, null, 180),
  ('comeback_bronze', 'comeback', 1, 3, 'habit', '🌅', 'Comeback', 'Wapsi', 'Hold 1 position through a 5% dip until it''s back above your price.', '1 position ko 5% girne ke baad bhi hold karo, jab tak woh tumhare daam se upar na aa jaaye.', 'Holdings that dipped 5% and came back: {n} (latest: {symbol}).', 'Tumhare {n} stock 5% gire aur wapas aaye, sabse haal mein {symbol}.', 'comebacks', 1, null, 190),
  ('comeback_silver', 'comeback', 2, 3, 'habit', '🌅', 'Comeback', 'Wapsi', 'Hold 2 positions through a 5% dip until they''re back above your price.', '2 position ko 5% girne ke baad bhi hold karo, jab tak woh tumhare daam se upar na aa jaaye.', 'Holdings that dipped 5% and came back: {n} (latest: {symbol}).', 'Tumhare {n} stock 5% gire aur wapas aaye, sabse haal mein {symbol}.', 'comebacks', 2, null, 200),
  ('comeback_gold', 'comeback', 3, 3, 'habit', '🌅', 'Comeback', 'Wapsi', 'Hold 4 positions through a 5% dip until they''re back above your price.', '4 position ko 5% girne ke baad bhi hold karo, jab tak woh tumhare daam se upar na aa jaaye.', 'Holdings that dipped 5% and came back: {n} (latest: {symbol}).', 'Tumhare {n} stock 5% gire aur wapas aaye, sabse haal mein {symbol}.', 'comebacks', 4, null, 210),
  ('spread_out_bronze', 'spread_out', 1, 3, 'habit', '🧩', 'Spread Out', 'Phaila Hua Paisa', 'Hold stocks from 3 different sectors at the same time.', 'Ek saath 3 alag sectors ke stocks rakho.', 'You held {n} sectors at once: {sectors}.', 'Tumne ek saath {n} sectors rakhe: {sectors}.', 'max_sectors', 3, null, 220),
  ('spread_out_silver', 'spread_out', 2, 3, 'habit', '🧩', 'Spread Out', 'Phaila Hua Paisa', 'Hold stocks from 5 different sectors at the same time.', 'Ek saath 5 alag sectors ke stocks rakho.', 'You held {n} sectors at once: {sectors}.', 'Tumne ek saath {n} sectors rakhe: {sectors}.', 'max_sectors', 5, null, 230),
  ('spread_out_gold', 'spread_out', 3, 3, 'habit', '🧩', 'Spread Out', 'Phaila Hua Paisa', 'Hold stocks from 8 different sectors at the same time.', 'Ek saath 8 alag sectors ke stocks rakho.', 'You held {n} sectors at once: {sectors}.', 'Tumne ek saath {n} sectors rakhe: {sectors}.', 'max_sectors', 8, null, 240),
  ('balanced_basket_bronze', 'balanced_basket', 1, 3, 'habit', '⚖️', 'Balanced Basket', 'Santulit Basket', 'Hold 4+ stocks with none over 35% of your shares.', '4+ stocks rakho, koi bhi 35% se zyada na ho.', 'You hold {n} stocks and the biggest is only {top_pct}%.', 'Tumhare paas {n} stocks hain aur sabse bada sirf {top_pct}% hai.', 'balanced_level', 1, null, 250),
  ('balanced_basket_silver', 'balanced_basket', 2, 3, 'habit', '⚖️', 'Balanced Basket', 'Santulit Basket', 'Hold 6+ stocks with none over 30% of your shares.', '6+ stocks rakho, koi bhi 30% se zyada na ho.', 'You hold {n} stocks and the biggest is only {top_pct}%.', 'Tumhare paas {n} stocks hain aur sabse bada sirf {top_pct}% hai.', 'balanced_level', 2, null, 260),
  ('balanced_basket_gold', 'balanced_basket', 3, 3, 'habit', '⚖️', 'Balanced Basket', 'Santulit Basket', 'Hold 10+ stocks with none over 20% of your shares.', '10+ stocks rakho, koi bhi 20% se zyada na ho.', 'You hold {n} stocks and the biggest is only {top_pct}%.', 'Tumhare paas {n} stocks hain aur sabse bada sirf {top_pct}% hai.', 'balanced_level', 3, null, 270),
  ('fund_patience_bronze', 'fund_patience', 1, 3, 'habit', '🌳', 'Fund Patience', 'Fund Ka Sabr', 'Keep a mutual fund or ETF for 30 days.', 'Ek mutual fund ya ETF 30 din tak rakho.', 'You''ve kept {symbol} for {days} days.', 'Tumne {symbol} ko {days} din rakha hai.', 'fund_hold_days', 30, null, 280),
  ('fund_patience_silver', 'fund_patience', 2, 3, 'habit', '🌳', 'Fund Patience', 'Fund Ka Sabr', 'Keep a mutual fund or ETF for 60 days.', 'Ek mutual fund ya ETF 60 din tak rakho.', 'You''ve kept {symbol} for {days} days.', 'Tumne {symbol} ko {days} din rakha hai.', 'fund_hold_days', 60, null, 290),
  ('fund_patience_gold', 'fund_patience', 3, 3, 'habit', '🌳', 'Fund Patience', 'Fund Ka Sabr', 'Keep a mutual fund or ETF for 90 days.', 'Ek mutual fund ya ETF 90 din tak rakho.', 'You''ve kept {symbol} for {days} days.', 'Tumne {symbol} ko {days} din rakha hai.', 'fund_hold_days', 90, null, 300),
  ('sip_spirit_bronze', 'sip_spirit', 1, 3, 'habit', '🗓️', 'SIP Spirit', 'SIP Wali Aadat', 'Put money into a fund or ETF in 2 different months.', '2 alag mahino mein fund ya ETF mein paisa lagao.', 'You added to funds in {months} different months.', 'Tumne {months} alag mahino mein funds mein paisa lagaya.', 'fund_months', 2, null, 310),
  ('sip_spirit_silver', 'sip_spirit', 2, 3, 'habit', '🗓️', 'SIP Spirit', 'SIP Wali Aadat', 'Put money into a fund or ETF in 3 different months.', '3 alag mahino mein fund ya ETF mein paisa lagao.', 'You added to funds in {months} different months.', 'Tumne {months} alag mahino mein funds mein paisa lagaya.', 'fund_months', 3, null, 320),
  ('sip_spirit_gold', 'sip_spirit', 3, 3, 'habit', '🗓️', 'SIP Spirit', 'SIP Wali Aadat', 'Put money into a fund or ETF in 5 different months.', '5 alag mahino mein fund ya ETF mein paisa lagao.', 'You added to funds in {months} different months.', 'Tumne {months} alag mahino mein funds mein paisa lagaya.', 'fund_months', 5, null, 330),
  ('patient_profit_bronze', 'patient_profit', 1, 2, 'habit', '⏳', 'Worth the Wait', 'Intezaar Ka Phal', 'Sell at a profit after holding for 30+ days (1 time).', '30+ din hold karke 1 baar munafe mein becho.', 'Sales at a profit after 30+ days: {n} (latest: {symbol}).', 'Tumhari {n} sales 30+ din baad munafe mein thi, sabse haal mein {symbol}.', 'patient_profits', 1, null, 340),
  ('patient_profit_silver', 'patient_profit', 2, 2, 'habit', '⏳', 'Worth the Wait', 'Intezaar Ka Phal', 'Sell at a profit after holding for 30+ days (3 times).', '30+ din hold karke 3 baar munafe mein becho.', 'Sales at a profit after 30+ days: {n} (latest: {symbol}).', 'Tumhari {n} sales 30+ din baad munafe mein thi, sabse haal mein {symbol}.', 'patient_profits', 3, null, 350),
  ('sleep_on_it_bronze', 'sleep_on_it', 1, 3, 'habit', '🌙', 'Slept On It', 'Soch Samajh Ke', 'Buy 3 stocks only after reading about them on an earlier day.', '3 stocks ko pehle kisi din padh kar, baad mein kharido.', 'Stocks you read up on before the day you bought them: {n} (latest: {symbol}).', 'Tumne {n} stocks pehle dekh kar baad mein kharide. Sabse naya: {symbol}.', 'slept_on', 3, null, 360),
  ('sleep_on_it_silver', 'sleep_on_it', 2, 3, 'habit', '🌙', 'Slept On It', 'Soch Samajh Ke', 'Buy 8 stocks only after reading about them on an earlier day.', '8 stocks ko pehle kisi din padh kar, baad mein kharido.', 'Stocks you read up on before the day you bought them: {n} (latest: {symbol}).', 'Tumne {n} stocks pehle dekh kar baad mein kharide. Sabse naya: {symbol}.', 'slept_on', 8, null, 370),
  ('sleep_on_it_gold', 'sleep_on_it', 3, 3, 'habit', '🌙', 'Slept On It', 'Soch Samajh Ke', 'Buy 15 stocks only after reading about them on an earlier day.', '15 stocks ko pehle kisi din padh kar, baad mein kharido.', 'Stocks you read up on before the day you bought them: {n} (latest: {symbol}).', 'Tumne {n} stocks pehle dekh kar baad mein kharide. Sabse naya: {symbol}.', 'slept_on', 15, null, 380),
  ('homework_bronze', 'homework', 1, 2, 'habit', '🔖', 'Did the Homework', 'Homework Pura', 'Buy 1 stock at least a week after adding it to your watchlist.', '1 stock watchlist mein daalne ke kam se kam ek hafte baad kharido.', '{symbol} sat on your watchlist {days} days before you bought it.', '{symbol} kharidne se pehle {days} din tumhari watchlist mein raha.', 'homework', 1, null, 390),
  ('homework_silver', 'homework', 2, 2, 'habit', '🔖', 'Did the Homework', 'Homework Pura', 'Buy 3 stocks at least a week after adding them to your watchlist.', '3 stock watchlist mein daalne ke kam se kam ek hafte baad kharido.', '{symbol} sat on your watchlist {days} days before you bought it.', '{symbol} kharidne se pehle {days} din tumhari watchlist mein raha.', 'homework', 3, null, 400),
  ('calm_hands_bronze', 'calm_hands', 1, 3, 'habit', '🧘', 'Calm Hands', 'Shaant Haath', 'Trade for 7 days without the coach flagging a pattern.', '7 din tak aise trade karo ki coach koi pattern na pakde.', '{trades} trades over {days} days with no pattern flagged.', '{days} din mein {trades} trades, ek bhi pattern nahi.', 'calm_days', 7, null, 410),
  ('calm_hands_silver', 'calm_hands', 2, 3, 'habit', '🧘', 'Calm Hands', 'Shaant Haath', 'Trade for 14 days without the coach flagging a pattern.', '14 din tak aise trade karo ki coach koi pattern na pakde.', '{trades} trades over {days} days with no pattern flagged.', '{days} din mein {trades} trades, ek bhi pattern nahi.', 'calm_days', 14, null, 420),
  ('calm_hands_gold', 'calm_hands', 3, 3, 'habit', '🧘', 'Calm Hands', 'Shaant Haath', 'Trade for 21 days without the coach flagging a pattern.', '21 din tak aise trade karo ki coach koi pattern na pakde.', '{trades} trades over {days} days with no pattern flagged.', '{days} din mein {trades} trades, ek bhi pattern nahi.', 'calm_days', 21, null, 430),
  ('steady_improver', 'steady_improver', 1, 1, 'habit', '📈', 'Getting Better', 'Behtar Ho Rahe', 'Halve how often the coach flags your trades.', 'Coach ke flags ko aadha kar do.', 'Flagged trades went from {before_pct}% to {after_pct}% of your recent trades.', 'Flag wale trades {before_pct}% se {after_pct}% ho gaye.', 'improver', 1, null, 440),
  ('time_traveller_bronze', 'time_traveller', 1, 3, 'learning', '⏱️', 'Time Traveller', 'Time Traveller', 'Finish 1 crash replay.', '1 alag crash replay poore karo.', 'Crash replays you''ve finished: {n}.', 'Tumne {n} crash replay poore kiye.', 'replays', 1, null, 450),
  ('time_traveller_silver', 'time_traveller', 2, 3, 'learning', '⏱️', 'Time Traveller', 'Time Traveller', 'Finish 3 crash replays.', '3 alag crash replay poore karo.', 'Crash replays you''ve finished: {n}.', 'Tumne {n} crash replay poore kiye.', 'replays', 3, null, 460),
  ('time_traveller_gold', 'time_traveller', 3, 3, 'learning', '⏱️', 'Time Traveller', 'Time Traveller', 'Finish 5 crash replays.', '5 alag crash replay poore karo.', 'Crash replays you''ve finished: {n}.', 'Tumne {n} crash replay poore kiye.', 'replays', 5, null, 470),
  ('curious_mind_bronze', 'curious_mind', 1, 3, 'learning', '💬', 'Curious Mind', 'Jigyasu', 'Ask Saathi questions on 2 different days.', '2 alag din Saathi se sawaal poocho.', 'Days you asked Saathi something: {n}.', 'Tumne {n} din Saathi se sawaal pooche.', 'question_days', 2, null, 480),
  ('curious_mind_silver', 'curious_mind', 2, 3, 'learning', '💬', 'Curious Mind', 'Jigyasu', 'Ask Saathi questions on 5 different days.', '5 alag din Saathi se sawaal poocho.', 'Days you asked Saathi something: {n}.', 'Tumne {n} din Saathi se sawaal pooche.', 'question_days', 5, null, 490),
  ('curious_mind_gold', 'curious_mind', 3, 3, 'learning', '💬', 'Curious Mind', 'Jigyasu', 'Ask Saathi questions on 10 different days.', '10 alag din Saathi se sawaal poocho.', 'Days you asked Saathi something: {n}.', 'Tumne {n} din Saathi se sawaal pooche.', 'question_days', 10, null, 500),
  ('bookworm_bronze', 'bookworm', 1, 3, 'learning', '📚', 'Bookworm', 'Kitaabi Keeda', 'Read 1 lesson or explainer.', '1 lesson ya explainer padho.', 'Lessons and explainers you''ve read: {n}.', 'Tumne {n} lessons aur explainers padhe.', 'reads', 1, null, 510),
  ('bookworm_silver', 'bookworm', 2, 3, 'learning', '📚', 'Bookworm', 'Kitaabi Keeda', 'Read 3 lessons or explainers.', '3 lesson ya explainer padho.', 'Lessons and explainers you''ve read: {n}.', 'Tumne {n} lessons aur explainers padhe.', 'reads', 3, null, 520),
  ('bookworm_gold', 'bookworm', 3, 3, 'learning', '📚', 'Bookworm', 'Kitaabi Keeda', 'Read 8 lessons or explainers.', '8 lesson ya explainer padho.', 'Lessons and explainers you''ve read: {n}.', 'Tumne {n} lessons aur explainers padhe.', 'reads', 8, null, 530),
  ('researcher_bronze', 'researcher', 1, 3, 'learning', '🔭', 'Researcher', 'Khoji', 'Look up 10 different stocks.', '10 alag stocks dekho.', 'You''ve looked into {n} different stocks.', 'Tumne {n} alag stocks dekhe.', 'stocks_viewed', 10, null, 540),
  ('researcher_silver', 'researcher', 2, 3, 'learning', '🔭', 'Researcher', 'Khoji', 'Look up 30 different stocks.', '30 alag stocks dekho.', 'You''ve looked into {n} different stocks.', 'Tumne {n} alag stocks dekhe.', 'stocks_viewed', 30, null, 550),
  ('researcher_gold', 'researcher', 3, 3, 'learning', '🔭', 'Researcher', 'Khoji', 'Look up 75 different stocks.', '75 alag stocks dekho.', 'You''ve looked into {n} different stocks.', 'Tumne {n} alag stocks dekhe.', 'stocks_viewed', 75, null, 560),
  ('news_hound_bronze', 'news_hound', 1, 3, 'learning', '📰', 'News Reader', 'Khabri', 'Read market news on 2 different days.', '2 alag din market news padho.', 'You read the news on {n} different days.', 'Tumne {n} alag din news padhi.', 'news_days', 2, null, 570),
  ('news_hound_silver', 'news_hound', 2, 3, 'learning', '📰', 'News Reader', 'Khabri', 'Read market news on 3 different days.', '3 alag din market news padho.', 'You read the news on {n} different days.', 'Tumne {n} alag din news padhi.', 'news_days', 3, null, 580),
  ('news_hound_gold', 'news_hound', 3, 3, 'learning', '📰', 'News Reader', 'Khabri', 'Read market news on 5 different days.', '5 alag din market news padho.', 'You read the news on {n} different days.', 'Tumne {n} alag din news padhi.', 'news_days', 5, null, 590),
  ('learning_streak_bronze', 'learning_streak', 1, 3, 'streak', '🔥', 'On a Roll', 'Lagataar', 'Learn something on 3 days in a row. One day off is fine.', '3 din lagataar kuch seekho. Ek din ki chhutti chalegi.', 'Your best run: {days} learning days, never more than one day off in between.', 'Tumhara best: {days} din seekhna, beech mein ek din se zyada gap nahi.', 'learn_streak', 3, null, 600),
  ('learning_streak_silver', 'learning_streak', 2, 3, 'streak', '🔥', 'On a Roll', 'Lagataar', 'Learn something on 4 days in a row. One day off is fine.', '4 din lagataar kuch seekho. Ek din ki chhutti chalegi.', 'Your best run: {days} learning days, never more than one day off in between.', 'Tumhara best: {days} din seekhna, beech mein ek din se zyada gap nahi.', 'learn_streak', 4, null, 610),
  ('learning_streak_gold', 'learning_streak', 3, 3, 'streak', '🔥', 'On a Roll', 'Lagataar', 'Learn something on 6 days in a row. One day off is fine.', '6 din lagataar kuch seekho. Ek din ki chhutti chalegi.', 'Your best run: {days} learning days, never more than one day off in between.', 'Tumhara best: {days} din seekhna, beech mein ek din se zyada gap nahi.', 'learn_streak', 6, null, 620),
  ('weekly_regular_bronze', 'weekly_regular', 1, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 3 weeks in a row. One week off is fine.', '3 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 3, null, 630),
  ('weekly_regular_silver', 'weekly_regular', 2, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 4 weeks in a row. One week off is fine.', '4 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 4, null, 640),
  ('weekly_regular_gold', 'weekly_regular', 3, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 6 weeks in a row. One week off is fine.', '6 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 6, null, 650),
  ('weekly_regular_platinum', 'weekly_regular', 4, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 8 weeks in a row. One week off is fine.', '8 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 8, null, 660),
  ('results_reader_bronze', 'results_reader', 1, 3, 'season', '📊', 'Results Reader', 'Results Padhne Wale', 'During 1 results season, look up 5+ stocks and learn something.', '1 results season mein 5+ stocks dekho aur kuch seekho.', 'Results seasons you studied: {n} (latest: {event}).', 'Tumne {n} results season mein companies padhi, sabse naya {event}.', 'season', 1, '{"event_kind":"results_season","pad":[0,0],"need":{"stock_views":5,"learn_actions":1}}'::jsonb, 670),
  ('results_reader_silver', 'results_reader', 2, 3, 'season', '📊', 'Results Reader', 'Results Padhne Wale', 'During 2 results seasons, look up 5+ stocks and learn something.', '2 results season mein 5+ stocks dekho aur kuch seekho.', 'Results seasons you studied: {n} (latest: {event}).', 'Tumne {n} results season mein companies padhi, sabse naya {event}.', 'season', 2, '{"event_kind":"results_season","pad":[0,0],"need":{"stock_views":5,"learn_actions":1}}'::jsonb, 680),
  ('results_reader_gold', 'results_reader', 3, 3, 'season', '📊', 'Results Reader', 'Results Padhne Wale', 'During 4 results seasons, look up 5+ stocks and learn something.', '4 results season mein 5+ stocks dekho aur kuch seekho.', 'Results seasons you studied: {n} (latest: {event}).', 'Tumne {n} results season mein companies padhi, sabse naya {event}.', 'season', 4, '{"event_kind":"results_season","pad":[0,0],"need":{"stock_views":5,"learn_actions":1}}'::jsonb, 690),
  ('budget_buff_bronze', 'budget_buff', 1, 3, 'season', '🏦', 'Budget Buff', 'Budget Samajhne Wale', 'Learn something on Union Budget day (or the day after), 1 year.', 'Budget ke din (ya agle din) kuch seekho, 1 saal.', 'Budget days you learned on: {n} (latest: {event}).', 'Tumne {n} Budget din seekha, sabse naya {event}.', 'season', 1, '{"event_kind":"budget","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 700),
  ('budget_buff_silver', 'budget_buff', 2, 3, 'season', '🏦', 'Budget Buff', 'Budget Samajhne Wale', 'Learn something on Union Budget day (or the day after), 2 years.', 'Budget ke din (ya agle din) kuch seekho, 2 saal.', 'Budget days you learned on: {n} (latest: {event}).', 'Tumne {n} Budget din seekha, sabse naya {event}.', 'season', 2, '{"event_kind":"budget","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 710),
  ('budget_buff_gold', 'budget_buff', 3, 3, 'season', '🏦', 'Budget Buff', 'Budget Samajhne Wale', 'Learn something on Union Budget day (or the day after), 3 years.', 'Budget ke din (ya agle din) kuch seekho, 3 saal.', 'Budget days you learned on: {n} (latest: {event}).', 'Tumne {n} Budget din seekha, sabse naya {event}.', 'season', 3, '{"event_kind":"budget","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 720),
  ('rate_watcher_bronze', 'rate_watcher', 1, 3, 'season', '🏛', 'Rate Watcher', 'Rate Pe Nazar', 'Learn something on 1 RBI policy day.', '1 RBI policy din kuch seekho.', 'RBI policy days you learned on: {n} (latest: {event}).', 'Tumne {n} RBI policy din seekha, sabse naya {event}.', 'season', 1, '{"event_kind":"rbi_policy","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 730),
  ('rate_watcher_silver', 'rate_watcher', 2, 3, 'season', '🏛', 'Rate Watcher', 'Rate Pe Nazar', 'Learn something on 3 RBI policy days.', '3 RBI policy din kuch seekho.', 'RBI policy days you learned on: {n} (latest: {event}).', 'Tumne {n} RBI policy din seekha, sabse naya {event}.', 'season', 3, '{"event_kind":"rbi_policy","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 740),
  ('rate_watcher_gold', 'rate_watcher', 3, 3, 'season', '🏛', 'Rate Watcher', 'Rate Pe Nazar', 'Learn something on 6 RBI policy days.', '6 RBI policy din kuch seekho.', 'RBI policy days you learned on: {n} (latest: {event}).', 'Tumne {n} RBI policy din seekha, sabse naya {event}.', 'season', 6, '{"event_kind":"rbi_policy","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 750),
  ('diwali_holder_bronze', 'diwali_holder', 1, 3, 'season', '🪔', 'Diwali Holder', 'Diwali Wala Investor', 'Hold a stock from two weeks before Diwali to a week after, 1 year.', 'Diwali se do hafte pehle se ek hafte baad tak stock hold karo, 1 saal.', 'Diwalis you held through: {n} (latest: {event}).', 'Tumne {n} Diwali hold kiya, sabse naya {event}.', 'season', 1, '{"event_kind":"diwali","pad":[14,7],"need":{"held_through":1}}'::jsonb, 760),
  ('diwali_holder_silver', 'diwali_holder', 2, 3, 'season', '🪔', 'Diwali Holder', 'Diwali Wala Investor', 'Hold a stock from two weeks before Diwali to a week after, 2 years.', 'Diwali se do hafte pehle se ek hafte baad tak stock hold karo, 2 saal.', 'Diwalis you held through: {n} (latest: {event}).', 'Tumne {n} Diwali hold kiya, sabse naya {event}.', 'season', 2, '{"event_kind":"diwali","pad":[14,7],"need":{"held_through":1}}'::jsonb, 770),
  ('diwali_holder_gold', 'diwali_holder', 3, 3, 'season', '🪔', 'Diwali Holder', 'Diwali Wala Investor', 'Hold a stock from two weeks before Diwali to a week after, 3 years.', 'Diwali se do hafte pehle se ek hafte baad tak stock hold karo, 3 saal.', 'Diwalis you held through: {n} (latest: {event}).', 'Tumne {n} Diwali hold kiya, sabse naya {event}.', 'season', 3, '{"event_kind":"diwali","pad":[14,7],"need":{"held_through":1}}'::jsonb, 780),
  ('muhurat', 'muhurat', 1, 1, 'season', '✨', 'Muhurat Moment', 'Muhurat Ka Pal', 'Open StockSaathi on Muhurat trading day.', 'Muhurat trading ke din StockSaathi kholo.', 'You were here for {event}.', 'Tum {event} pe yahan the.', 'season', 1, '{"event_kind":"diwali","pad":[0,0],"need":{"visit_days":1}}'::jsonb, 790),
  ('month_end_review_bronze', 'month_end_review', 1, 3, 'season', '🧾', 'Month-end Review', 'Mahine Ka Hisaab', 'Open your report card in the last 3 days of 1 month.', '1 mahine, aakhri 3 din mein report card dekho.', 'Month-ends you reviewed: {n} (latest: {event}).', 'Tumne {n} mahine ka hisaab dekha, sabse naya {event}.', 'season', 1, '{"event_kind":"month_end","pad":[2,0],"need":{"report_views":1}}'::jsonb, 800),
  ('month_end_review_silver', 'month_end_review', 2, 3, 'season', '🧾', 'Month-end Review', 'Mahine Ka Hisaab', 'Open your report card in the last 3 days of 3 months.', '3 mahine, aakhri 3 din mein report card dekho.', 'Month-ends you reviewed: {n} (latest: {event}).', 'Tumne {n} mahine ka hisaab dekha, sabse naya {event}.', 'season', 3, '{"event_kind":"month_end","pad":[2,0],"need":{"report_views":1}}'::jsonb, 810),
  ('month_end_review_gold', 'month_end_review', 3, 3, 'season', '🧾', 'Month-end Review', 'Mahine Ka Hisaab', 'Open your report card in the last 3 days of 6 months.', '6 mahine, aakhri 3 din mein report card dekho.', 'Month-ends you reviewed: {n} (latest: {event}).', 'Tumne {n} mahine ka hisaab dekha, sabse naya {event}.', 'season', 6, '{"event_kind":"month_end","pad":[2,0],"need":{"report_views":1}}'::jsonb, 820),
  ('quarter_reflection_bronze', 'quarter_reflection', 1, 3, 'season', '🪞', 'Quarter Reflection', 'Teen Mahine Ka Hisaab', 'Open your report card in the last week of 1 quarter.', '1 quarter ke aakhri hafte mein report card dekho.', 'Quarters you looked back on: {n} (latest: {event}).', 'Tumne {n} quarter ka hisaab dekha, sabse naya {event}.', 'season', 1, '{"event_kind":"quarter_end","pad":[6,0],"need":{"report_views":1}}'::jsonb, 830),
  ('quarter_reflection_silver', 'quarter_reflection', 2, 3, 'season', '🪞', 'Quarter Reflection', 'Teen Mahine Ka Hisaab', 'Open your report card in the last week of 2 quarters.', '2 quarter ke aakhri hafte mein report card dekho.', 'Quarters you looked back on: {n} (latest: {event}).', 'Tumne {n} quarter ka hisaab dekha, sabse naya {event}.', 'season', 2, '{"event_kind":"quarter_end","pad":[6,0],"need":{"report_views":1}}'::jsonb, 840),
  ('quarter_reflection_gold', 'quarter_reflection', 3, 3, 'season', '🪞', 'Quarter Reflection', 'Teen Mahine Ka Hisaab', 'Open your report card in the last week of 4 quarters.', '4 quarter ke aakhri hafte mein report card dekho.', 'Quarters you looked back on: {n} (latest: {event}).', 'Tumne {n} quarter ka hisaab dekha, sabse naya {event}.', 'season', 4, '{"event_kind":"quarter_end","pad":[6,0],"need":{"report_views":1}}'::jsonb, 850),
  ('fresh_start', 'fresh_start', 1, 1, 'season', '🎒', 'Fresh Start', 'Nayi Shuruaat', 'Learn something in the first week of the financial year (April).', 'Financial year ke pehle hafte (April) mein kuch seekho.', 'You started {event} by learning.', 'Tumne {event} seekh kar shuru kiya.', 'season', 1, '{"event_kind":"fy_start","pad":[0,6],"need":{"learn_actions":1}}'::jsonb, 860)
on conflict (code) do update set
  family = excluded.family, tier = excluded.tier, tiers = excluded.tiers, category = excluded.category,
  emoji = excluded.emoji, name_en = excluded.name_en, name_hi = excluded.name_hi,
  desc_en = excluded.desc_en, desc_hi = excluded.desc_hi, why_en = excluded.why_en, why_hi = excluded.why_hi,
  metric = excluded.metric, threshold = excluded.threshold, rule = excluded.rule, sort = excluded.sort,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 9. Switches: AI drafting stays off until /api/ai?op=ach-draft is deployed
--    (turn it on in /a → Achievements). _ach_fill is internal.
-- ---------------------------------------------------------------------------
update public.achievement_settings set auto_draft = false, updated_at = now() where id and last_sweep is null;
revoke all on function public._ach_fill(text, jsonb) from public, anon, authenticated;

-- Owner preview (applied once on 13 Nov as achievements_k_owner_preview_seed):
-- sample rows with seeded = true for aliarbab2009 and admin, plus one bell
-- row each. Not repeated here; see the migration list in Supabase.
-- ---------------------------------------------------------------------------
-- 10. Schedules
-- ---------------------------------------------------------------------------
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('achievements-sweep', 'achievements-drafts');
end $$;
-- Every 10 minutes: award whoever did something since the last run (owner
-- accounts only while rollout = 'owner'); nightly full pass after 02:30 IST.
select cron.schedule('achievements-sweep', '*/10 * * * *', $$select public.ach_sweep()$$);
-- 09:10 IST daily: ask for AI drafts for the next upcoming event (one at most).
select cron.schedule('achievements-drafts', '40 3 * * *', $$select public._ach_request_drafts()$$);
