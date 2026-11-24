-- =============================================================================
-- Achievements, rules v2 (25 Nov 2026). Rule twin: js/achievements/core.js
-- (tests: scripts/test-achievements.mjs). Nothing has been awarded to real
-- users yet (rollout is still 'owner'), so this is the moment to change rules.
--
-- 1. You have to be around: days held, a dip held and a comeback count only
--    for a user active in the last 14 days. Measured on all 7,931 accounts,
--    about 9 in 10 "patience" awards went to accounts that had left.
-- 2. First profit is a sale on a later day than the buy, not a same-day flip.
-- 3. Seven new metrics (watchlist, chart, sectors looked up, pattern
--    explainers, weekend learning, patient limit orders, calm on a falling
--    day). None counts trades.
-- 4. An older account's FIRST awards (the rollout, or someone coming back)
--    are saved without a bell row or a push; the app shows one summary.
-- 5. The nightly pass covers users active in the last 14 days, not every
--    profile (after 1, nobody else can gain anything).
-- 6. my_achievements() also returns the event behind an AI-drafted
--    achievement, the next window of each calendar achievement and the
--    user's own numbers (facts.ev). ach_unseen() is the light call the app
--    makes on every page load; my_achievements() runs when the sheet opens.
-- 7. Catalogue: 40 families, 107 tiers (was 33 and 86); Old Friend and
--    Regular move to "Coming back"; four ladders retuned.
-- Idempotent. No DROP or DELETE.
-- =============================================================================

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
-- first profit: sold on a later day than the holding began, not a same-day flip
f_profit as (
  select distinct on (user_id) user_id, symbol, pct from prof
   where (created_at at time zone 'Asia/Kolkata')::date > (ep_t0 at time zone 'Asia/Kolkata')::date
   order by user_id, created_at
),
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
   where e.kind in ('page_view', 'stock_view', 'news_click', 'replay_finish', 'replay_start', 'watchlist_add', 'chart_interact')
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
-- added 25 Nov 2026: parts of the site that earned nothing
f_wl as (
  select user_id, count(distinct symbol) as n from (
    select w.user_id, w.symbol from public.watchlist w join u using (user_id)
    union all
    select user_id, subject from evd where kind = 'watchlist_add' and subject is not null) z
   group by 1
),
f_new as (
  select e.user_id,
    count(distinct e.subject) filter (where e.kind = 'chart_interact' and e.subject is not null) as charts,
    count(distinct i.sector) filter (where e.kind = 'stock_view') as sectors,
    count(distinct e.subject) filter (where e.kind = 'learn' and e.subject like 'bias:%') as bias_reads
    from evd e left join inst i on e.kind = 'stock_view' and i.symbol = e.subject
   group by 1
),
f_wkd as (
  select user_id, count(distinct date_trunc('week', d)::date) as n
    from learn_days where extract(isodow from d) in (6, 7) group by 1
),
f_lwait as (
  select l.user_id, count(*) as n from public.limit_orders l join u using (user_id)
   where l.status = 'filled' and l.order_type = 'LIMIT' and l.filled_at - l.created_at >= interval '1 day' group by 1
),
-- red day calm: a session the Nifty 50 ETF closed 1% or more down, on which
-- the user opened the app, held something bought on an earlier day and sold
-- nothing
red as (
  select d from (
    select c.d, c.close_paise::numeric as c, lag(c.close_paise) over (order by c.d) as pc
      from public.real_daily_closes c where c.symbol = 'NIFTYBEES') z
   where pc is not null and c <= pc * 0.99 and d <= (now() at time zone 'Asia/Kolkata')::date
),
visit_d as (select distinct user_id, d from evd where kind in ('page_view', 'chat_user')),
sell_d as (select distinct user_id, (created_at at time zone 'Asia/Kolkata')::date as d from tx where side = 'SELL'),
f_red as (
  select v.user_id, count(*) as n, max(v.d) as d
    from visit_d v join red r using (d)
   where not exists (select 1 from sell_d s where s.user_id = v.user_id and s.d = v.d)
     and exists (select 1 from ep2 e where e.user_id = v.user_id and e.d0 < v.d and (e.d_end is null or e.d_end > v.d))
   group by 1
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
    -- time only counts while the user is around (active in the last 14 days)
    'max_hold_days', case when coalesce(fle.recent, false) or coalesce(rt.recent, false) then coalesce(fh.hold_days, 0) else 0 end,
    'dip_pct', case when coalesce(fle.recent, false) or coalesce(rt.recent, false) then coalesce(fd.pct, 0) else 0 end,
    'comebacks', case when coalesce(fle.recent, false) or coalesce(rt.recent, false) then coalesce(cb.n, 0) else 0 end,
    'max_sectors', coalesce(fs.n, 0),
    'balanced_level', case when fb2.n >= 10 and fb2.top <= 0.20 then 3 when fb2.n >= 6 and fb2.top <= 0.30 then 2
                           when fb2.n >= 4 and fb2.top <= 0.35 then 1 else 0 end,
    'fund_hold_days', case when coalesce(fle.recent, false) or coalesce(rt.recent, false) then coalesce(ffh.hold_days, 0) else 0 end,
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
    'week_streak', coalesce(fws.n, 0),
    'watchlist_adds', coalesce(wl.n, 0),
    'chart_stocks', coalesce(nw.charts, 0),
    'sectors_viewed', coalesce(nw.sectors, 0),
    'bias_reads', coalesce(nw.bias_reads, 0),
    'weekend_learn', coalesce(wkd.n, 0),
    'limit_waits', coalesce(lw.n, 0),
    'red_days', coalesce(rd.n, 0)
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
    'week_streak', jsonb_build_object('weeks', coalesce(fws.n, 0)),
    'watchlist_adds', jsonb_build_object('n', coalesce(wl.n, 0)),
    'chart_stocks', jsonb_build_object('n', coalesce(nw.charts, 0)),
    'sectors_viewed', jsonb_build_object('n', coalesce(nw.sectors, 0)),
    'bias_reads', jsonb_build_object('n', coalesce(nw.bias_reads, 0)),
    'weekend_learn', jsonb_build_object('n', coalesce(wkd.n, 0)),
    'limit_waits', jsonb_build_object('n', coalesce(lw.n, 0)),
    'red_days', case when rd.user_id is not null then jsonb_build_object('n', rd.n, 'date', to_char(rd.d, 'FMDD Mon YYYY')) end
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
left join f_wl wl using (user_id)
left join f_new nw using (user_id)
left join f_wkd wkd using (user_id)
left join f_lwait lw using (user_id)
left join f_red rd using (user_id)
left join f_recent_tx rt using (user_id);
$$;
revoke all on function public._ach_facts(uuid[]) from public, anon, authenticated;

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
  v_had uuid[];
  r record;
begin
  if p_users is null or cardinality(p_users) = 0 then
    return jsonb_build_object('users', 0, 'awarded', 0);
  end if;

  -- Who already holds something. An account older than a day whose FIRST
  -- awards arrive now is catching up on its history (the rollout, or someone
  -- coming back): those are saved quietly, with no bell row and no push. The
  -- app still shows them once, as one summary, on the next visit.
  select coalesce(array_agg(distinct a.user_id), '{}'::uuid[]) into v_had
    from public.user_achievements a where a.user_id = any(p_users) and not a.seeded;

  with ins as (
    insert into public.user_achievements (user_id, code, evidence, backfilled)
    select e.user_id, e.code, e.evidence,
           p_backfill or (not (e.user_id = any(v_had))
             and coalesce((select p.created_at < now() - interval '1 day' from public.profiles p where p.id = e.user_id), false))
      from public._ach_eval(p_users) e
     where public._ach_in_scope(e.user_id)
    on conflict (user_id, code) do update
      set seeded = false, evidence = excluded.evidence, earned_at = now(), seen_at = null, backfilled = excluded.backfilled
      where public.user_achievements.seeded   -- a preview sample becomes the real thing
    returning user_id, code, evidence, backfilled
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'code', code, 'evidence', evidence, 'quiet', backfilled)), '[]'::jsonb)
    into v_new from ins;
  v_awarded := jsonb_array_length(v_new);

  for r in
    select n.user_id, count(*) as k, bool_or(n.quiet) as quiet,
           jsonb_agg(jsonb_build_object('code', n.code, 'tier', d.tier, 'family', d.family, 'name', d.name_en,
                                        'why', public._ach_fill(d.why_en, n.evidence))
                     order by d.tier desc, d.sort) as items
      from jsonb_to_recordset(v_new) as n(user_id uuid, code text, evidence jsonb, quiet boolean)
      join public.achievement_defs d using (code)
     group by n.user_id
  loop
    v_users := v_users + 1;
    if r.quiet then
      null;   -- catching up on history: saved, not announced
    elsif r.k >= 3 then
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
    -- Time-based achievements only move for a user who has been around in the
    -- last 14 days (_ach_facts), so the nightly pass covers those users only.
    select array_agg(distinct x) into v_users from (
      select user_id as x from public.user_events where occurred_at >= now() - interval '14 days' and user_id is not null
      union select user_id from public.transactions where created_at >= now() - interval '14 days'
      union select user_id from public.coach_messages where created_at >= now() - interval '14 days'
      union select user_id from public.learn_events where occurred_at >= now() - interval '14 days') z;
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

create or replace function public.my_achievements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  today date := (now() at time zone 'Asia/Kolkata')::date;
  f record;
begin
  if me is null or not public._ach_in_scope(me) then return jsonb_build_object('enabled', false); end if;
  select * into f from public._ach_facts(array[me]);
  return jsonb_build_object(
    'enabled', true,
    -- An AI-drafted seasonal achievement also carries its event (kind, date,
    -- window) and what it asks for: the app builds its pin from those.
    'defs', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'code', d.code, 'family', d.family, 'tier', d.tier, 'tiers', d.tiers, 'category', d.category,
               'name_en', d.name_en, 'name_hi', d.name_hi, 'desc_en', d.desc_en, 'desc_hi', d.desc_hi,
               'why_en', d.why_en, 'why_hi', d.why_hi, 'metric', d.metric, 'threshold', d.threshold, 'source', d.source, 'sort', d.sort,
               'event_kind', mev.kind, 'event_on', mev.starts_on, 'need', case when d.source = 'ai' then d.rule->'need' end,
               'win_from', mev.starts_on - coalesce((d.rule->'pad'->>0)::int, 0), 'win_to', mev.ends_on + coalesce((d.rule->'pad'->>1)::int, 0)))
               order by d.sort, d.code), '[]'::jsonb)
             from public.achievement_defs d
             left join public.market_events mev on mev.id = d.event_id
            where d.status = 'active'
               or exists (select 1 from public.user_achievements x where x.user_id = me and x.code = d.code)),
    'earned', (select coalesce(jsonb_agg(jsonb_build_object(
                 'code', a.code, 'earned_at', a.earned_at, 'evidence', a.evidence, 'seen', a.seen_at is not null,
                 'seeded', a.seeded) order by a.earned_at desc), '[]'::jsonb)
               from public.user_achievements a where a.user_id = me),
    -- ev: the user's own numbers behind each metric (which stock, how long),
    -- with a fund's name instead of its code.
    'facts', jsonb_build_object('m', coalesce(f.m, '{}'::jsonb),
               'ev', (select coalesce(jsonb_object_agg(k.key, case when k.value ? 'symbol'
                               then jsonb_set(k.value, '{symbol}', to_jsonb(public._ach_label(k.value->>'symbol'))) else k.value end), '{}'::jsonb)
                        from jsonb_each(coalesce(f.ev, '{}'::jsonb)) k),
               'season', (select coalesce(jsonb_object_agg(s.code, jsonb_build_object('n', s.n, 'event', s.event)), '{}'::jsonb)
                            from public._ach_season(array[me]) s)),
    -- The next window (open now, or the next to open) of each calendar
    -- achievement, so the sheet can say when the next chance is.
    'calendar', (select coalesce(jsonb_object_agg(z.code, jsonb_build_object('name', z.name, 'from', z.wa, 'to', z.wb)), '{}'::jsonb)
                   from (select distinct on (a.code) a.code, e.name,
                                e.starts_on - coalesce((a.rule->'pad'->>0)::int, 0) as wa,
                                e.ends_on + coalesce((a.rule->'pad'->>1)::int, 0) as wb
                           from public.achievement_defs a
                           join public.market_events e on e.kind = a.rule->>'event_kind'
                          where a.status = 'active' and a.metric = 'season' and a.rule is not null and not (a.rule ? 'event_id')
                            and e.ends_on + coalesce((a.rule->'pad'->>1)::int, 0) >= today
                          order by a.code, e.starts_on) z)
  );
end $$;
revoke all on function public.my_achievements() from public, anon;
grant execute on function public.my_achievements() to authenticated;

create or replace function public.ach_unseen()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public._ach_in_scope(me) then return jsonb_build_object('enabled', false); end if;
  return jsonb_build_object('enabled', true, 'items', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'evidence', a.evidence, 'seeded', a.seeded, 'earned_at', a.earned_at,
             'def', jsonb_strip_nulls(jsonb_build_object(
               'code', d.code, 'family', d.family, 'tier', d.tier, 'tiers', d.tiers, 'category', d.category,
               'name_en', d.name_en, 'name_hi', d.name_hi, 'desc_en', d.desc_en, 'desc_hi', d.desc_hi,
               'why_en', d.why_en, 'why_hi', d.why_hi, 'metric', d.metric, 'threshold', d.threshold, 'source', d.source, 'sort', d.sort,
               'event_kind', mev.kind, 'event_on', mev.starts_on, 'need', case when d.source = 'ai' then d.rule->'need' end,
               'win_from', mev.starts_on - coalesce((d.rule->'pad'->>0)::int, 0), 'win_to', mev.ends_on + coalesce((d.rule->'pad'->>1)::int, 0)))) order by a.earned_at desc), '[]'::jsonb)
      from public.user_achievements a
      join public.achievement_defs d using (code)
      left join public.market_events mev on mev.id = d.event_id
     where a.user_id = me and a.seen_at is null));
end $$;
revoke all on function public.ach_unseen() from public, anon;
grant execute on function public.ach_unseen() to authenticated;

-- The catalogue, from js/achievements/core.js (node scripts/achievements-seed.mjs).
insert into public.achievement_defs
  (code, family, tier, tiers, category, emoji, name_en, name_hi, desc_en, desc_hi, why_en, why_hi, metric, threshold, rule, sort)
values
  ('first_steps', 'first_steps', 1, 1, 'milestone', '🌱', 'First Steps', 'Pehla Kadam', 'Place your first trade.', 'Apna pehla trade karo.', 'Your first trade was {symbol} on {date}.', 'Tumhara pehla trade {symbol} tha, {date} ko.', 'trades', 1, null, 10),
  ('first_profit', 'first_profit', 1, 1, 'milestone', '🪙', 'First Profit Booked', 'Pehla Munafa', 'Sell shares for more than you paid.', 'Shares ko kharid se zyada daam pe becho.', 'You sold {symbol} {pct}% above what you paid.', 'Tumne {symbol} kharid se {pct}% upar becha.', 'profit_booked', 1, null, 20),
  ('your_price_bronze', 'your_price', 1, 2, 'milestone', '🎯', 'Your Price', 'Apna Daam', 'Get 1 limit order filled at the price you chose.', '1 limit order apne chune hue daam pe fill karwao.', 'Limit orders filled at your price: {n}.', 'Tumhare {n} limit order tumhare daam pe fill hue.', 'limit_fills', 1, null, 30),
  ('your_price_silver', 'your_price', 2, 2, 'milestone', '🎯', 'Your Price', 'Apna Daam', 'Get 5 limit orders filled at the price you chose.', '5 limit order apne chune hue daam pe fill karwao.', 'Limit orders filled at your price: {n}.', 'Tumhare {n} limit order tumhare daam pe fill hue.', 'limit_fills', 5, null, 40),
  ('fund_first', 'fund_first', 1, 1, 'milestone', '🧺', 'Basket Buyer', 'Basket Wala', 'Buy your first mutual fund or ETF: many companies in one go.', 'Pehla mutual fund ya ETF kharido: ek saath kai companies.', 'Your first fund was {symbol}.', 'Tumhara pehla fund {symbol} tha.', 'fund_buys', 1, null, 50),
  ('old_friend_bronze', 'old_friend', 1, 3, 'streak', '🤝', 'Old Friend', 'Purana Dost', 'Still learning with Saathi 30 days after joining.', 'Join karne ke 30 din baad bhi Saathi ke saath seekh rahe ho.', 'You joined {days} days ago and you''re still here.', 'Tum {days} din pehle jude the aur abhi bhi yahin ho.', 'member_days', 30, null, 60),
  ('old_friend_silver', 'old_friend', 2, 3, 'streak', '🤝', 'Old Friend', 'Purana Dost', 'Still learning with Saathi 90 days after joining.', 'Join karne ke 90 din baad bhi Saathi ke saath seekh rahe ho.', 'You joined {days} days ago and you''re still here.', 'Tum {days} din pehle jude the aur abhi bhi yahin ho.', 'member_days', 90, null, 70),
  ('old_friend_gold', 'old_friend', 3, 3, 'streak', '🤝', 'Old Friend', 'Purana Dost', 'Still learning with Saathi 180 days after joining.', 'Join karne ke 180 din baad bhi Saathi ke saath seekh rahe ho.', 'You joined {days} days ago and you''re still here.', 'Tum {days} din pehle jude the aur abhi bhi yahin ho.', 'member_days', 180, null, 80),
  ('regular_bronze', 'regular', 1, 3, 'streak', '📅', 'Regular', 'Regular', 'Open StockSaathi on 10 different days.', '10 alag-alag din StockSaathi kholo.', 'You''ve opened the app on {n} different days.', 'Tumne {n} alag din app khola hai.', 'visit_days', 10, null, 90),
  ('regular_silver', 'regular', 2, 3, 'streak', '📅', 'Regular', 'Regular', 'Open StockSaathi on 20 different days.', '20 alag-alag din StockSaathi kholo.', 'You''ve opened the app on {n} different days.', 'Tumne {n} alag din app khola hai.', 'visit_days', 20, null, 100),
  ('regular_gold', 'regular', 3, 3, 'streak', '📅', 'Regular', 'Regular', 'Open StockSaathi on 40 different days.', '40 alag-alag din StockSaathi kholo.', 'You''ve opened the app on {n} different days.', 'Tumne {n} alag din app khola hai.', 'visit_days', 40, null, 110),
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
  ('set_and_wait_bronze', 'set_and_wait', 1, 3, 'habit', '🎣', 'Set and Wait', 'Daam Lagao, Ruko', 'Get 1 limit order filled after waiting a day or more for your price.', '1 limit order apne daam ke liye ek din ya zyada ruk kar fill karwao.', 'Limit orders that waited a day or more for your price: {n}.', 'Tumhare {n} limit order ek din ya zyada ruk kar tumhare daam pe fill hue.', 'limit_waits', 1, null, 450),
  ('set_and_wait_silver', 'set_and_wait', 2, 3, 'habit', '🎣', 'Set and Wait', 'Daam Lagao, Ruko', 'Get 3 limit orders filled after waiting a day or more for your price.', '3 limit order apne daam ke liye ek din ya zyada ruk kar fill karwao.', 'Limit orders that waited a day or more for your price: {n}.', 'Tumhare {n} limit order ek din ya zyada ruk kar tumhare daam pe fill hue.', 'limit_waits', 3, null, 460),
  ('set_and_wait_gold', 'set_and_wait', 3, 3, 'habit', '🎣', 'Set and Wait', 'Daam Lagao, Ruko', 'Get 6 limit orders filled after waiting a day or more for your price.', '6 limit order apne daam ke liye ek din ya zyada ruk kar fill karwao.', 'Limit orders that waited a day or more for your price: {n}.', 'Tumhare {n} limit order ek din ya zyada ruk kar tumhare daam pe fill hue.', 'limit_waits', 6, null, 470),
  ('red_day_calm_bronze', 'red_day_calm', 1, 3, 'habit', '☂️', 'Red Day Calm', 'Laal Din, Shaant Mann', 'On 1 day the market falls 1% or more, open the app, look at your holdings and sell nothing.', '1 din jab market 1% ya zyada gire, app kholo, apni holdings dekho aur kuch mat becho.', 'Falling days you watched without selling: {n} (latest: {date}).', 'Tumne {n} girte din bina beche dekhe, sabse naya {date}.', 'red_days', 1, null, 480),
  ('red_day_calm_silver', 'red_day_calm', 2, 3, 'habit', '☂️', 'Red Day Calm', 'Laal Din, Shaant Mann', 'On 3 days the market falls 1% or more, open the app, look at your holdings and sell nothing.', '3 din jab market 1% ya zyada gire, app kholo, apni holdings dekho aur kuch mat becho.', 'Falling days you watched without selling: {n} (latest: {date}).', 'Tumne {n} girte din bina beche dekhe, sabse naya {date}.', 'red_days', 3, null, 490),
  ('red_day_calm_gold', 'red_day_calm', 3, 3, 'habit', '☂️', 'Red Day Calm', 'Laal Din, Shaant Mann', 'On 6 days the market falls 1% or more, open the app, look at your holdings and sell nothing.', '6 din jab market 1% ya zyada gire, app kholo, apni holdings dekho aur kuch mat becho.', 'Falling days you watched without selling: {n} (latest: {date}).', 'Tumne {n} girte din bina beche dekhe, sabse naya {date}.', 'red_days', 6, null, 500),
  ('time_traveller_bronze', 'time_traveller', 1, 3, 'learning', '⏱️', 'Time Traveller', 'Time Traveller', 'Finish 1 crash replay.', '1 alag crash replay poore karo.', 'Crash replays you''ve finished: {n}.', 'Tumne {n} crash replay poore kiye.', 'replays', 1, null, 510),
  ('time_traveller_silver', 'time_traveller', 2, 3, 'learning', '⏱️', 'Time Traveller', 'Time Traveller', 'Finish 3 crash replays.', '3 alag crash replay poore karo.', 'Crash replays you''ve finished: {n}.', 'Tumne {n} crash replay poore kiye.', 'replays', 3, null, 520),
  ('time_traveller_gold', 'time_traveller', 3, 3, 'learning', '⏱️', 'Time Traveller', 'Time Traveller', 'Finish 5 crash replays.', '5 alag crash replay poore karo.', 'Crash replays you''ve finished: {n}.', 'Tumne {n} crash replay poore kiye.', 'replays', 5, null, 530),
  ('curious_mind_bronze', 'curious_mind', 1, 3, 'learning', '💬', 'Curious Mind', 'Jigyasu', 'Ask Saathi a question on 1 day.', '1 din Saathi se sawaal poocho.', 'Days you asked Saathi something: {n}.', 'Tumne {n} din Saathi se sawaal pooche.', 'question_days', 1, null, 540),
  ('curious_mind_silver', 'curious_mind', 2, 3, 'learning', '💬', 'Curious Mind', 'Jigyasu', 'Ask Saathi a question on 5 days.', '5 din Saathi se sawaal poocho.', 'Days you asked Saathi something: {n}.', 'Tumne {n} din Saathi se sawaal pooche.', 'question_days', 5, null, 550),
  ('curious_mind_gold', 'curious_mind', 3, 3, 'learning', '💬', 'Curious Mind', 'Jigyasu', 'Ask Saathi a question on 10 days.', '10 din Saathi se sawaal poocho.', 'Days you asked Saathi something: {n}.', 'Tumne {n} din Saathi se sawaal pooche.', 'question_days', 10, null, 560),
  ('bookworm_bronze', 'bookworm', 1, 3, 'learning', '📚', 'Bookworm', 'Kitaabi Keeda', 'Read 1 lesson or explainer.', '1 lesson ya explainer padho.', 'Lessons and explainers you''ve read: {n}.', 'Tumne {n} lessons aur explainers padhe.', 'reads', 1, null, 570),
  ('bookworm_silver', 'bookworm', 2, 3, 'learning', '📚', 'Bookworm', 'Kitaabi Keeda', 'Read 3 lessons or explainers.', '3 lesson ya explainer padho.', 'Lessons and explainers you''ve read: {n}.', 'Tumne {n} lessons aur explainers padhe.', 'reads', 3, null, 580),
  ('bookworm_gold', 'bookworm', 3, 3, 'learning', '📚', 'Bookworm', 'Kitaabi Keeda', 'Read 8 lessons or explainers.', '8 lesson ya explainer padho.', 'Lessons and explainers you''ve read: {n}.', 'Tumne {n} lessons aur explainers padhe.', 'reads', 8, null, 590),
  ('researcher_bronze', 'researcher', 1, 3, 'learning', '🔭', 'Researcher', 'Khoji', 'Look up 10 different stocks.', '10 alag stocks dekho.', 'You''ve looked into {n} different stocks.', 'Tumne {n} alag stocks dekhe.', 'stocks_viewed', 10, null, 600),
  ('researcher_silver', 'researcher', 2, 3, 'learning', '🔭', 'Researcher', 'Khoji', 'Look up 30 different stocks.', '30 alag stocks dekho.', 'You''ve looked into {n} different stocks.', 'Tumne {n} alag stocks dekhe.', 'stocks_viewed', 30, null, 610),
  ('researcher_gold', 'researcher', 3, 3, 'learning', '🔭', 'Researcher', 'Khoji', 'Look up 75 different stocks.', '75 alag stocks dekho.', 'You''ve looked into {n} different stocks.', 'Tumne {n} alag stocks dekhe.', 'stocks_viewed', 75, null, 620),
  ('news_hound_bronze', 'news_hound', 1, 3, 'learning', '📰', 'News Reader', 'Khabri', 'Read market news on 2 different days.', '2 alag din market news padho.', 'You read the news on {n} different days.', 'Tumne {n} alag din news padhi.', 'news_days', 2, null, 630),
  ('news_hound_silver', 'news_hound', 2, 3, 'learning', '📰', 'News Reader', 'Khabri', 'Read market news on 5 different days.', '5 alag din market news padho.', 'You read the news on {n} different days.', 'Tumne {n} alag din news padhi.', 'news_days', 5, null, 640),
  ('news_hound_gold', 'news_hound', 3, 3, 'learning', '📰', 'News Reader', 'Khabri', 'Read market news on 10 different days.', '10 alag din market news padho.', 'You read the news on {n} different days.', 'Tumne {n} alag din news padhi.', 'news_days', 10, null, 650),
  ('on_my_radar_bronze', 'on_my_radar', 1, 3, 'learning', '📡', 'On My Radar', 'Nazar Mein', 'Add 1 stock to your watchlist.', '1 stock watchlist mein daalo.', 'Stocks you''ve put on your watchlist: {n}.', 'Tumne {n} stock watchlist mein daale.', 'watchlist_adds', 1, null, 660),
  ('on_my_radar_silver', 'on_my_radar', 2, 3, 'learning', '📡', 'On My Radar', 'Nazar Mein', 'Add 5 stocks to your watchlist.', '5 stock watchlist mein daalo.', 'Stocks you''ve put on your watchlist: {n}.', 'Tumne {n} stock watchlist mein daale.', 'watchlist_adds', 5, null, 670),
  ('on_my_radar_gold', 'on_my_radar', 3, 3, 'learning', '📡', 'On My Radar', 'Nazar Mein', 'Add 10 stocks to your watchlist.', '10 stock watchlist mein daalo.', 'Stocks you''ve put on your watchlist: {n}.', 'Tumne {n} stock watchlist mein daale.', 'watchlist_adds', 10, null, 680),
  ('chart_reader_bronze', 'chart_reader', 1, 3, 'learning', '👓', 'Chart Reader', 'Chart Padhne Wale', 'Use the chart on 3 different stocks.', '3 alag stocks ka chart dekho.', 'Stocks whose chart you''ve explored: {n}.', 'Tumne {n} stocks ke chart dekhe.', 'chart_stocks', 3, null, 690),
  ('chart_reader_silver', 'chart_reader', 2, 3, 'learning', '👓', 'Chart Reader', 'Chart Padhne Wale', 'Use the chart on 10 different stocks.', '10 alag stocks ka chart dekho.', 'Stocks whose chart you''ve explored: {n}.', 'Tumne {n} stocks ke chart dekhe.', 'chart_stocks', 10, null, 700),
  ('chart_reader_gold', 'chart_reader', 3, 3, 'learning', '👓', 'Chart Reader', 'Chart Padhne Wale', 'Use the chart on 25 different stocks.', '25 alag stocks ka chart dekho.', 'Stocks whose chart you''ve explored: {n}.', 'Tumne {n} stocks ke chart dekhe.', 'chart_stocks', 25, null, 710),
  ('sector_scholar_bronze', 'sector_scholar', 1, 3, 'learning', '🧭', 'Sector Scholar', 'Sector Ka Gyaan', 'Look up stocks from 5 different sectors. No buying needed.', '5 alag sectors ke stocks dekho. Kharidna zaroori nahi.', 'Sectors you''ve looked into: {n}.', 'Tumne {n} sectors ke stocks dekhe.', 'sectors_viewed', 5, null, 720),
  ('sector_scholar_silver', 'sector_scholar', 2, 3, 'learning', '🧭', 'Sector Scholar', 'Sector Ka Gyaan', 'Look up stocks from 8 different sectors. No buying needed.', '8 alag sectors ke stocks dekho. Kharidna zaroori nahi.', 'Sectors you''ve looked into: {n}.', 'Tumne {n} sectors ke stocks dekhe.', 'sectors_viewed', 8, null, 730),
  ('sector_scholar_gold', 'sector_scholar', 3, 3, 'learning', '🧭', 'Sector Scholar', 'Sector Ka Gyaan', 'Look up stocks from 11 different sectors. No buying needed.', '11 alag sectors ke stocks dekho. Kharidna zaroori nahi.', 'Sectors you''ve looked into: {n}.', 'Tumne {n} sectors ke stocks dekhe.', 'sectors_viewed', 11, null, 740),
  ('asked_why_bronze', 'asked_why', 1, 3, 'learning', '💡', 'Asked Why', 'Kyun Poocha', 'Open the explainer for 1 pattern the coach noted on your trades.', 'Coach ne tumhare trades pe jo pattern note kiye, unme se 1 ka explainer kholo.', 'Patterns you''ve read up on after a coach note: {n}.', 'Coach ke note ke baad tumne {n} pattern samjhe.', 'bias_reads', 1, null, 750),
  ('asked_why_silver', 'asked_why', 2, 3, 'learning', '💡', 'Asked Why', 'Kyun Poocha', 'Open the explainer for 3 patterns the coach noted on your trades.', 'Coach ne tumhare trades pe jo pattern note kiye, unme se 3 ka explainer kholo.', 'Patterns you''ve read up on after a coach note: {n}.', 'Coach ke note ke baad tumne {n} pattern samjhe.', 'bias_reads', 3, null, 760),
  ('asked_why_gold', 'asked_why', 3, 3, 'learning', '💡', 'Asked Why', 'Kyun Poocha', 'Open the explainer for 5 patterns the coach noted on your trades.', 'Coach ne tumhare trades pe jo pattern note kiye, unme se 5 ka explainer kholo.', 'Patterns you''ve read up on after a coach note: {n}.', 'Coach ke note ke baad tumne {n} pattern samjhe.', 'bias_reads', 5, null, 770),
  ('learning_streak_bronze', 'learning_streak', 1, 3, 'streak', '🔥', 'On a Roll', 'Lagataar', 'Learn something on 3 days in a row. One day off is fine.', '3 din lagataar kuch seekho. Ek din ki chhutti chalegi.', 'Your best run: {days} learning days, never more than one day off in between.', 'Tumhara best: {days} din seekhna, beech mein ek din se zyada gap nahi.', 'learn_streak', 3, null, 780),
  ('learning_streak_silver', 'learning_streak', 2, 3, 'streak', '🔥', 'On a Roll', 'Lagataar', 'Learn something on 5 days in a row. One day off is fine.', '5 din lagataar kuch seekho. Ek din ki chhutti chalegi.', 'Your best run: {days} learning days, never more than one day off in between.', 'Tumhara best: {days} din seekhna, beech mein ek din se zyada gap nahi.', 'learn_streak', 5, null, 790),
  ('learning_streak_gold', 'learning_streak', 3, 3, 'streak', '🔥', 'On a Roll', 'Lagataar', 'Learn something on 7 days in a row. One day off is fine.', '7 din lagataar kuch seekho. Ek din ki chhutti chalegi.', 'Your best run: {days} learning days, never more than one day off in between.', 'Tumhara best: {days} din seekhna, beech mein ek din se zyada gap nahi.', 'learn_streak', 7, null, 800),
  ('weekly_regular_bronze', 'weekly_regular', 1, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 2 weeks in a row. One week off is fine.', '2 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 2, null, 810),
  ('weekly_regular_silver', 'weekly_regular', 2, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 4 weeks in a row. One week off is fine.', '4 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 4, null, 820),
  ('weekly_regular_gold', 'weekly_regular', 3, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 6 weeks in a row. One week off is fine.', '6 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 6, null, 830),
  ('weekly_regular_platinum', 'weekly_regular', 4, 4, 'streak', '🗓', 'Week After Week', 'Har Hafte', 'Come back 8 weeks in a row. One week off is fine.', '8 hafte lagataar wapas aao. Ek hafte ki chhutti chalegi.', 'You came back {weeks} weeks running.', 'Tum {weeks} hafte lagataar aaye.', 'week_streak', 8, null, 840),
  ('weekend_scholar_bronze', 'weekend_scholar', 1, 3, 'streak', '🛋️', 'Weekend Scholar', 'Weekend Ki Padhai', 'Learn something on 1 weekend, when the market is shut.', '1 weekend pe kuch seekho, jab market band hota hai.', 'Weekends you learned on: {n}.', 'Tumne {n} weekend pe seekha.', 'weekend_learn', 1, null, 850),
  ('weekend_scholar_silver', 'weekend_scholar', 2, 3, 'streak', '🛋️', 'Weekend Scholar', 'Weekend Ki Padhai', 'Learn something on 3 weekends, when the market is shut.', '3 weekend pe kuch seekho, jab market band hota hai.', 'Weekends you learned on: {n}.', 'Tumne {n} weekend pe seekha.', 'weekend_learn', 3, null, 860),
  ('weekend_scholar_gold', 'weekend_scholar', 3, 3, 'streak', '🛋️', 'Weekend Scholar', 'Weekend Ki Padhai', 'Learn something on 6 weekends, when the market is shut.', '6 weekend pe kuch seekho, jab market band hota hai.', 'Weekends you learned on: {n}.', 'Tumne {n} weekend pe seekha.', 'weekend_learn', 6, null, 870),
  ('results_reader_bronze', 'results_reader', 1, 3, 'season', '📊', 'Results Reader', 'Results Padhne Wale', 'During 1 results season, look up 5+ stocks and learn something.', '1 results season mein 5+ stocks dekho aur kuch seekho.', 'Results seasons you studied: {n} (latest: {event}).', 'Tumne {n} results season mein companies padhi, sabse naya {event}.', 'season', 1, '{"event_kind":"results_season","pad":[0,0],"need":{"stock_views":5,"learn_actions":1}}'::jsonb, 880),
  ('results_reader_silver', 'results_reader', 2, 3, 'season', '📊', 'Results Reader', 'Results Padhne Wale', 'During 2 results seasons, look up 5+ stocks and learn something.', '2 results season mein 5+ stocks dekho aur kuch seekho.', 'Results seasons you studied: {n} (latest: {event}).', 'Tumne {n} results season mein companies padhi, sabse naya {event}.', 'season', 2, '{"event_kind":"results_season","pad":[0,0],"need":{"stock_views":5,"learn_actions":1}}'::jsonb, 890),
  ('results_reader_gold', 'results_reader', 3, 3, 'season', '📊', 'Results Reader', 'Results Padhne Wale', 'During 4 results seasons, look up 5+ stocks and learn something.', '4 results season mein 5+ stocks dekho aur kuch seekho.', 'Results seasons you studied: {n} (latest: {event}).', 'Tumne {n} results season mein companies padhi, sabse naya {event}.', 'season', 4, '{"event_kind":"results_season","pad":[0,0],"need":{"stock_views":5,"learn_actions":1}}'::jsonb, 900),
  ('budget_buff_bronze', 'budget_buff', 1, 3, 'season', '🏦', 'Budget Buff', 'Budget Samajhne Wale', 'Learn something on Union Budget day (or the day after), 1 year.', 'Budget ke din (ya agle din) kuch seekho, 1 saal.', 'Budget days you learned on: {n} (latest: {event}).', 'Tumne {n} Budget din seekha, sabse naya {event}.', 'season', 1, '{"event_kind":"budget","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 910),
  ('budget_buff_silver', 'budget_buff', 2, 3, 'season', '🏦', 'Budget Buff', 'Budget Samajhne Wale', 'Learn something on Union Budget day (or the day after), 2 years.', 'Budget ke din (ya agle din) kuch seekho, 2 saal.', 'Budget days you learned on: {n} (latest: {event}).', 'Tumne {n} Budget din seekha, sabse naya {event}.', 'season', 2, '{"event_kind":"budget","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 920),
  ('budget_buff_gold', 'budget_buff', 3, 3, 'season', '🏦', 'Budget Buff', 'Budget Samajhne Wale', 'Learn something on Union Budget day (or the day after), 3 years.', 'Budget ke din (ya agle din) kuch seekho, 3 saal.', 'Budget days you learned on: {n} (latest: {event}).', 'Tumne {n} Budget din seekha, sabse naya {event}.', 'season', 3, '{"event_kind":"budget","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 930),
  ('rate_watcher_bronze', 'rate_watcher', 1, 3, 'season', '🏛', 'Rate Watcher', 'Rate Pe Nazar', 'Learn something on 1 RBI policy day.', '1 RBI policy din kuch seekho.', 'RBI policy days you learned on: {n} (latest: {event}).', 'Tumne {n} RBI policy din seekha, sabse naya {event}.', 'season', 1, '{"event_kind":"rbi_policy","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 940),
  ('rate_watcher_silver', 'rate_watcher', 2, 3, 'season', '🏛', 'Rate Watcher', 'Rate Pe Nazar', 'Learn something on 3 RBI policy days.', '3 RBI policy din kuch seekho.', 'RBI policy days you learned on: {n} (latest: {event}).', 'Tumne {n} RBI policy din seekha, sabse naya {event}.', 'season', 3, '{"event_kind":"rbi_policy","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 950),
  ('rate_watcher_gold', 'rate_watcher', 3, 3, 'season', '🏛', 'Rate Watcher', 'Rate Pe Nazar', 'Learn something on 6 RBI policy days.', '6 RBI policy din kuch seekho.', 'RBI policy days you learned on: {n} (latest: {event}).', 'Tumne {n} RBI policy din seekha, sabse naya {event}.', 'season', 6, '{"event_kind":"rbi_policy","pad":[0,1],"need":{"learn_actions":1}}'::jsonb, 960),
  ('diwali_holder_bronze', 'diwali_holder', 1, 3, 'season', '🪔', 'Diwali Holder', 'Diwali Wala Investor', 'Hold a stock from two weeks before Diwali to a week after, and look in at least once, 1 year.', 'Diwali se do hafte pehle se ek hafte baad tak stock hold karo aur beech mein ek baar app kholo, 1 saal.', 'Diwalis you held through: {n} (latest: {event}).', 'Tumne {n} Diwali hold kiya, sabse naya {event}.', 'season', 1, '{"event_kind":"diwali","pad":[14,7],"need":{"held_through":1,"visit_days":1}}'::jsonb, 970),
  ('diwali_holder_silver', 'diwali_holder', 2, 3, 'season', '🪔', 'Diwali Holder', 'Diwali Wala Investor', 'Hold a stock from two weeks before Diwali to a week after, and look in at least once, 2 years.', 'Diwali se do hafte pehle se ek hafte baad tak stock hold karo aur beech mein ek baar app kholo, 2 saal.', 'Diwalis you held through: {n} (latest: {event}).', 'Tumne {n} Diwali hold kiya, sabse naya {event}.', 'season', 2, '{"event_kind":"diwali","pad":[14,7],"need":{"held_through":1,"visit_days":1}}'::jsonb, 980),
  ('diwali_holder_gold', 'diwali_holder', 3, 3, 'season', '🪔', 'Diwali Holder', 'Diwali Wala Investor', 'Hold a stock from two weeks before Diwali to a week after, and look in at least once, 3 years.', 'Diwali se do hafte pehle se ek hafte baad tak stock hold karo aur beech mein ek baar app kholo, 3 saal.', 'Diwalis you held through: {n} (latest: {event}).', 'Tumne {n} Diwali hold kiya, sabse naya {event}.', 'season', 3, '{"event_kind":"diwali","pad":[14,7],"need":{"held_through":1,"visit_days":1}}'::jsonb, 990),
  ('muhurat', 'muhurat', 1, 1, 'season', '✨', 'Muhurat Moment', 'Muhurat Ka Pal', 'Open StockSaathi on Muhurat trading day.', 'Muhurat trading ke din StockSaathi kholo.', 'You were here for {event}.', 'Tum {event} pe yahan the.', 'season', 1, '{"event_kind":"diwali","pad":[0,0],"need":{"visit_days":1}}'::jsonb, 1000),
  ('month_end_review_bronze', 'month_end_review', 1, 3, 'season', '🧾', 'Month-end Review', 'Mahine Ka Hisaab', 'Open your report card in the last 3 days of 1 month.', '1 mahine, aakhri 3 din mein report card dekho.', 'Month-ends you reviewed: {n} (latest: {event}).', 'Tumne {n} mahine ka hisaab dekha, sabse naya {event}.', 'season', 1, '{"event_kind":"month_end","pad":[2,0],"need":{"report_views":1}}'::jsonb, 1010),
  ('month_end_review_silver', 'month_end_review', 2, 3, 'season', '🧾', 'Month-end Review', 'Mahine Ka Hisaab', 'Open your report card in the last 3 days of 3 months.', '3 mahine, aakhri 3 din mein report card dekho.', 'Month-ends you reviewed: {n} (latest: {event}).', 'Tumne {n} mahine ka hisaab dekha, sabse naya {event}.', 'season', 3, '{"event_kind":"month_end","pad":[2,0],"need":{"report_views":1}}'::jsonb, 1020),
  ('month_end_review_gold', 'month_end_review', 3, 3, 'season', '🧾', 'Month-end Review', 'Mahine Ka Hisaab', 'Open your report card in the last 3 days of 6 months.', '6 mahine, aakhri 3 din mein report card dekho.', 'Month-ends you reviewed: {n} (latest: {event}).', 'Tumne {n} mahine ka hisaab dekha, sabse naya {event}.', 'season', 6, '{"event_kind":"month_end","pad":[2,0],"need":{"report_views":1}}'::jsonb, 1030),
  ('quarter_reflection_bronze', 'quarter_reflection', 1, 3, 'season', '🪞', 'Quarter Reflection', 'Teen Mahine Ka Hisaab', 'Open your report card in the last week of 1 quarter.', '1 quarter ke aakhri hafte mein report card dekho.', 'Quarters you looked back on: {n} (latest: {event}).', 'Tumne {n} quarter ka hisaab dekha, sabse naya {event}.', 'season', 1, '{"event_kind":"quarter_end","pad":[6,0],"need":{"report_views":1}}'::jsonb, 1040),
  ('quarter_reflection_silver', 'quarter_reflection', 2, 3, 'season', '🪞', 'Quarter Reflection', 'Teen Mahine Ka Hisaab', 'Open your report card in the last week of 2 quarters.', '2 quarter ke aakhri hafte mein report card dekho.', 'Quarters you looked back on: {n} (latest: {event}).', 'Tumne {n} quarter ka hisaab dekha, sabse naya {event}.', 'season', 2, '{"event_kind":"quarter_end","pad":[6,0],"need":{"report_views":1}}'::jsonb, 1050),
  ('quarter_reflection_gold', 'quarter_reflection', 3, 3, 'season', '🪞', 'Quarter Reflection', 'Teen Mahine Ka Hisaab', 'Open your report card in the last week of 4 quarters.', '4 quarter ke aakhri hafte mein report card dekho.', 'Quarters you looked back on: {n} (latest: {event}).', 'Tumne {n} quarter ka hisaab dekha, sabse naya {event}.', 'season', 4, '{"event_kind":"quarter_end","pad":[6,0],"need":{"report_views":1}}'::jsonb, 1060),
  ('fresh_start', 'fresh_start', 1, 1, 'season', '🎒', 'Fresh Start', 'Nayi Shuruaat', 'Learn something in the first week of the financial year (April).', 'Financial year ke pehle hafte (April) mein kuch seekho.', 'You started {event} by learning.', 'Tumne {event} seekh kar shuru kiya.', 'season', 1, '{"event_kind":"fy_start","pad":[0,6],"need":{"learn_actions":1}}'::jsonb, 1070)
on conflict (code) do update set
  family = excluded.family, tier = excluded.tier, tiers = excluded.tiers, category = excluded.category,
  emoji = excluded.emoji, name_en = excluded.name_en, name_hi = excluded.name_hi,
  desc_en = excluded.desc_en, desc_hi = excluded.desc_hi, why_en = excluded.why_en, why_hi = excluded.why_hi,
  metric = excluded.metric, threshold = excluded.threshold, rule = excluded.rule, sort = excluded.sort,
  updated_at = now();
