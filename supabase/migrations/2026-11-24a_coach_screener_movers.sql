-- Coach lookups (24 Nov 2026, applied to production the same day): a
-- market-wide screener over fundamentals_cache and last-session movers from
-- NSE's end-of-day file. Read-only, public market data. Used by the coach
-- tools screen_stocks and get_market_movers (js/coach/agent.js).
create or replace function public.coach_screen_stocks(
  p_sort text default 'market_cap', p_dir text default 'desc', p_sector text default null,
  p_min_market_cap_cr numeric default null, p_max_pe numeric default null,
  p_min_pe numeric default null, p_limit int default 15
) returns jsonb language sql stable security definer set search_path = public as $$
  with base as (
    select symbol, name, sector, industry, round(market_cap / 1e7, 0) as market_cap_cr,
           round(coalesce(pe_ttm, pe_ratio), 2) as pe, round(pb_ratio, 2) as pb, round(roe, 4) as roe,
           round(dividend_yield, 4) as dividend_yield, round(debt_to_equity, 2) as debt_to_equity,
           round(eps, 2) as eps, updated_at::date as as_of
    from fundamentals_cache
    where (p_sector is null or sector ilike '%' || p_sector || '%' or industry ilike '%' || p_sector || '%')
      and (p_min_market_cap_cr is null or market_cap >= p_min_market_cap_cr * 1e7)
      and (p_max_pe is null or coalesce(pe_ttm, pe_ratio) <= p_max_pe)
      and (p_min_pe is null or coalesce(pe_ttm, pe_ratio) >= p_min_pe)
  ), keyed as (
    select *, case lower(coalesce(p_sort,'market_cap'))
      when 'pe' then pe when 'pb' then pb when 'roe' then roe when 'dividend_yield' then dividend_yield
      when 'debt_to_equity' then debt_to_equity when 'eps' then eps else market_cap_cr end as k
    from base
  )
  select jsonb_build_object(
    'ok', true, 'sorted_by', lower(coalesce(p_sort,'market_cap')),
    'direction', case when lower(p_dir) = 'asc' then 'asc' else 'desc' end,
    'matched', (select count(*) from keyed where k is not null and (lower(coalesce(p_sort,'')) <> 'pe' or k > 0)),
    'note', 'P/E only counts companies with positive earnings. Figures from StockSaathi''s fundamentals store (as_of per row).',
    'results', coalesce((select jsonb_agg(to_jsonb(r) - 'k') from (
      select * from keyed where k is not null and (lower(coalesce(p_sort,'')) <> 'pe' or k > 0)
      order by case when lower(p_dir) = 'asc' then k end asc nulls last,
               case when lower(p_dir) <> 'asc' then k end desc nulls last
      limit greatest(1, least(coalesce(p_limit, 15), 25))) r), '[]'::jsonb));
$$;

create or replace function public.coach_market_movers(
  p_kind text default 'gainers', p_limit int default 10, p_min_price_inr numeric default 20
) returns jsonb language sql stable security definer set search_path = public as $$
  with d as (select max(trade_date) as dt from nse_eod_prices),
  rows as (
    select e.symbol, round(e.close_paise / 100.0, 2) as close_inr, round(e.prev_close_paise / 100.0, 2) as prev_close_inr,
           round((e.close_paise - e.prev_close_paise) * 100.0 / nullif(e.prev_close_paise, 0), 2) as change_pct, e.volume
    from nse_eod_prices e, d
    where e.trade_date = d.dt and e.series in ('EQ','BE') and e.prev_close_paise > 0
      and e.close_paise >= coalesce(p_min_price_inr, 20) * 100
  )
  select jsonb_build_object('ok', true, 'session', (select dt from d), 'kind', lower(coalesce(p_kind,'gainers')),
    'note', 'From NSE''s official end-of-day file for that session.',
    'results', coalesce((select jsonb_agg(to_jsonb(r)) from (
      select * from rows
      order by case when lower(p_kind) = 'losers' then change_pct end asc,
               case when lower(p_kind) = 'volume' then volume end desc,
               case when lower(coalesce(p_kind,'gainers')) not in ('losers','volume') then change_pct end desc
      limit greatest(1, least(coalesce(p_limit, 10), 25))) r), '[]'::jsonb));
$$;

revoke all on function public.coach_screen_stocks(text,text,text,numeric,numeric,numeric,int) from public;
revoke all on function public.coach_market_movers(text,int,numeric) from public;
grant execute on function public.coach_screen_stocks(text,text,text,numeric,numeric,numeric,int) to anon, authenticated;
grant execute on function public.coach_market_movers(text,int,numeric) to anon, authenticated;
