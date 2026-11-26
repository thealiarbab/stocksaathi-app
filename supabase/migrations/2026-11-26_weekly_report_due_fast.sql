-- weekly_report_due() hit the 8 s PostgREST statement timeout every Sunday
-- since 8 Nov (edge log 22 Nov 04:30:21 UTC: POST rpc/weekly_report_due 500,
-- "canceling statement due to statement timeout"), so no weekly report went
-- out on 8, 15 or 22 Nov. Cause: four correlated sub-selects over `moves` per
-- due user (2,208 users x 4 scans). Now best/worst come from one DISTINCT ON
-- pass and trades from one GROUP BY. Same rows, same values (md5 of the full
-- output matched the old function, 26 Nov); 5.4 s -> 0.33 s.
CREATE OR REPLACE FUNCTION public.weekly_report_due(p_limit integer DEFAULT 3000)
 RETURNS TABLE(user_id uuid, email text, display_name text, value_now bigint, value_then bigint, trades integer, best_symbol text, best_pct numeric, worst_symbol text, worst_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with wk as (select (now() at time zone 'Asia/Kolkata')::date as today),
  users as materialized (
    select p.id, p.email, p.display_name
    from public.profiles p, wk
    where p.recap_emails and p.email like '%@%'
      and not public.in_holdout('recap', p.id)
      and not exists (select 1 from public.weekly_report_log l where l.user_id = p.id and l.week_of = wk.today)
      and (exists (select 1 from public.transactions t where t.user_id = p.id and t.created_at > now() - interval '30 days')
        or exists (select 1 from public.user_events e where e.user_id = p.id and e.occurred_at > now() - interval '30 days'))),
  snap as materialized (
    select u.id,
      (select h.total_value_paise from public.portfolio_history h where h.user_id = u.id and h.source = 'daily_snapshot'
         and h.ts > now() - interval '7 days' order by h.ts desc limit 1) v_now,
      coalesce(
        (select h.total_value_paise from public.portfolio_history h where h.user_id = u.id and h.source = 'daily_snapshot'
           and h.ts <= now() - interval '7 days' order by h.ts desc limit 1),
        (select pf.starting_cash_paise from public.portfolios pf where pf.user_id = u.id)) v_then
    from users u),
  eod as (
    select (select max(trade_date) from public.nse_eod_prices where trade_date <= (select today from wk)) d1,
           (select max(trade_date) from public.nse_eod_prices where trade_date <= (select today from wk) - 7) d0),
  moves as materialized (
    select h.user_id, h.symbol, 100.0 * (e1.close_paise - e0.close_paise) / e0.close_paise pct
    from public.holdings h cross join eod
    join public.nse_eod_prices e1 on e1.symbol = h.symbol and e1.trade_date = eod.d1
    join public.nse_eod_prices e0 on e0.symbol = h.symbol and e0.trade_date = eod.d0
    where h.qty > 0 and e0.close_paise > 0 and h.first_bought_at <= (eod.d0::timestamp + time '15:30') at time zone 'Asia/Kolkata'
      and h.user_id in (select id from users)),
  best as (select distinct on (m.user_id) m.user_id, m.symbol, m.pct from moves m order by m.user_id, m.pct desc, m.symbol),
  worst as (select distinct on (m.user_id) m.user_id, m.symbol, m.pct from moves m order by m.user_id, m.pct asc, m.symbol),
  tr as (
    select t.user_id, count(*)::int n from public.transactions t
    where t.created_at > now() - interval '7 days' and t.user_id in (select id from users) group by t.user_id)
  select u.id, u.email, u.display_name, s.v_now, s.v_then,
         coalesce(tr.n, 0),
         b.symbol, round(b.pct, 2), w.symbol, round(w.pct, 2)
  from users u join snap s on s.id = u.id
  left join best b on b.user_id = u.id
  left join worst w on w.user_id = u.id
  left join tr on tr.user_id = u.id
  where s.v_now is not null and s.v_then > 0
  limit greatest(1, least(p_limit, 5000));
$function$;
revoke execute on function public.weekly_report_due(integer) from public, anon, authenticated;
grant execute on function public.weekly_report_due(integer) to service_role;
