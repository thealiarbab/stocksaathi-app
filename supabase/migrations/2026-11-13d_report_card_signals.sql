-- Report card v3 inputs (13 Nov 2026): what the user did around each trade,
-- not just the trade. One call returns, for the signed-in user:
--   w   learning weeks, as before (_report_card_activity)
--   r   every BUY of the last 120 days (newest 300) with the research done
--       before it: [ts_ms, symbol, view_days, chart, watchlist, asked]
--         view_days  distinct days the stock page was opened in the 14 days
--                    before, not counting the last 10 minutes (the visit the
--                    order was placed from)
--         chart      the stock's chart was used in the 14 days before
--         watchlist  the stock was on the watchlist before the buy
--         asked      Saathi was asked about it in the 14 days before: opened
--                    on that stock's page, or a chat message naming it
--   cv  the account's value per IST day for 120 days: [date, total_paise]
--       (portfolio_history, last value of each day)
-- Reads only the user's own rows through the (user_id, ...) indexes.

create or replace function public._report_card_signals(p_user uuid)
 returns jsonb
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  with buys as (
    select t.created_at as ts, t.symbol
      from public.transactions t
     where t.user_id = p_user and t.side = 'BUY' and t.created_at > now() - interval '120 days'
     order by t.created_at desc
     limit 300
  ),
  ev as (
    select e.kind, e.subject, e.occurred_at
      from public.user_events e
     where e.user_id = p_user
       and e.kind in ('stock_view', 'chart_interact', 'watchlist_add', 'coach_open')
       and e.occurred_at > now() - interval '135 days'
  ),
  chat as (
    select c.created_at, c.payload::text as body
      from public.coach_messages c
     where c.user_id = p_user and c.event_type = 'chat_user'
       and c.created_at > now() - interval '135 days'
  ),
  r as (
    select b.ts, b.symbol,
      (select count(distinct (e.occurred_at at time zone 'Asia/Kolkata')::date) from ev e
        where e.kind = 'stock_view' and e.subject = b.symbol
          and e.occurred_at >= b.ts - interval '14 days' and e.occurred_at < b.ts - interval '10 minutes') as view_days,
      exists (select 1 from ev e where e.kind = 'chart_interact' and e.subject = b.symbol
               and e.occurred_at >= b.ts - interval '14 days' and e.occurred_at <= b.ts) as chart,
      (exists (select 1 from ev e where e.kind = 'watchlist_add' and e.subject = b.symbol and e.occurred_at < b.ts)
        or exists (select 1 from public.watchlist w where w.user_id = p_user and w.symbol = b.symbol and w.added_at < b.ts)) as watch,
      (exists (select 1 from ev e where e.kind = 'coach_open' and e.subject = '/stocks/' || b.symbol
                and e.occurred_at >= b.ts - interval '14 days' and e.occurred_at <= b.ts)
        or (length(b.symbol) >= 3 and exists (select 1 from chat c
                where c.created_at >= b.ts - interval '14 days' and c.created_at <= b.ts
                  and c.body ilike '%' || b.symbol || '%'))) as asked
    from buys b
  ),
  cv as (
    select distinct on (d) d, v
      from (select (ph.ts at time zone 'Asia/Kolkata')::date as d, ph.total_value_paise as v, ph.ts
              from public.portfolio_history ph
             where ph.user_id = p_user and ph.ts > now() - interval '120 days') x
     order by d, ts desc
  )
  select jsonb_build_object(
    'w',  public._report_card_activity(p_user, 12),
    'r',  coalesce((select jsonb_agg(jsonb_build_array((extract(epoch from ts) * 1000)::bigint, symbol, view_days, chart, watch, asked) order by ts) from r), '[]'::jsonb),
    'cv', coalesce((select jsonb_agg(jsonb_build_array(d, v) order by d) from cv), '[]'::jsonb)
  );
$function$;

revoke all on function public._report_card_signals(uuid) from public, anon, authenticated;
grant execute on function public._report_card_signals(uuid) to service_role;

create or replace function public.report_card_signals()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select case when auth.uid() is null then null else public._report_card_signals(auth.uid()) end;
$function$;

revoke all on function public.report_card_signals() from public, anon;
grant execute on function public.report_card_signals() to authenticated;
