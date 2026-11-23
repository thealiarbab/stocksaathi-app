-- Coach screener v2 (24 Nov 2026). Applied to production the same day as
-- migrations 2026_11_24c .. 2026_11_24f; this file holds the final definition.
--
--   c  coach_screen_stocks_v2: companies only (no ETFs / funds), a P/E ranking
--      needs positive earnings, top_by_size ("the 49 largest, ranked by P/E"),
--      up to 50 compact rows. The old coach_screen_stocks stays for browsers
--      still running a cached bundle.
--   d  no ".BO" / ".NS" duplicate rows.
--   e  each row carries the last price and that session's move (quote_cache,
--      else the latest NSE end-of-day close), so the coach makes ONE lookup
--      for a ranking instead of one price lookup per row (48 lookups, 33 s).
--      ROE and dividend yield come back as percentages and debt-to-equity as
--      a ratio (stored as 0.27 / 0.06 / 44.3).
--   f  with no size filter, only companies worth ₹1,000 crore or more are
--      ranked (a ₹21 crore shell topped "highest ROE bank"); pass
--      min_market_cap_cr 0 to include the smallest.
create or replace function public.coach_screen_stocks_v2(
  p_sort text default 'market_cap', p_dir text default 'desc', p_sector text default null,
  p_min_market_cap_cr numeric default null, p_max_pe numeric default null, p_min_pe numeric default null,
  p_limit integer default 15, p_top_by_size integer default null)
returns jsonb
language sql stable security definer
set search_path to 'public'
as $function$
  with pat as (select public._coach_sector_pattern(p_sector) as re),
  companies as (
    select symbol, name, sector, industry, market_cap,
           coalesce(pe_ttm, pe_ratio) as pe_raw, pb_ratio, roe, dividend_yield, debt_to_equity, eps, updated_at
    from fundamentals_cache, pat
    where name is not null and market_cap is not null and market_cap > 0
      and coalesce(sector,'') !~* '^(etf|index)$'
      and name !~* '\m(etf|bees|index fund|mutual fund|nifty|sensex|amc-|liquid)\M'
      and symbol !~* '(BEES|ETF|IETF)$' and symbol !~ '\.(BO|NS)$'
      and (pat.re is null or coalesce(sector,'') ~* pat.re or coalesce(industry,'') ~* pat.re)
  ), sized as (
    select *, row_number() over (order by market_cap desc) as size_rank from companies
  ), base as (
    select symbol, name, sector, round(market_cap / 1e7, 0) as market_cap_cr, size_rank,
           round(pe_raw, 2) as pe, round(pb_ratio, 2) as pb, round(roe * 100, 2) as roe,
           round(dividend_yield * 100, 2) as dividend_yield, round(debt_to_equity / 100, 2) as debt_to_equity,
           round(eps, 2) as eps, updated_at::date as as_of
    from sized
    where (p_top_by_size is null or size_rank <= greatest(1, least(p_top_by_size, 500)))
      and market_cap >= coalesce(p_min_market_cap_cr, case when p_top_by_size is null then 1000 else 0 end) * 1e7
      and (p_max_pe is null or pe_raw <= p_max_pe)
      and (p_min_pe is null or pe_raw >= p_min_pe)
  ), keyed as (
    select *, case lower(coalesce(p_sort,'market_cap'))
      when 'pe' then (case when pe > 0 and (eps is null or eps > 0) then pe end)
      when 'pb' then pb when 'roe' then roe when 'dividend_yield' then dividend_yield
      when 'debt_to_equity' then debt_to_equity when 'eps' then eps else market_cap_cr end as k
    from base
  ), picked as (
    select *, row_number() over (
        order by case when lower(p_dir) = 'asc' then k end asc nulls last,
                 case when lower(p_dir) <> 'asc' then k end desc nulls last) as ord
    from keyed where k is not null
    order by ord
    limit greatest(1, least(coalesce(p_limit, 15), 50))
  ), eod_day as (select max(trade_date) as dt from nse_eod_prices),
  priced as (
    select r.*,
      coalesce(q.price_paise, e.close_paise) as px,
      case when q.price_paise is not null then q.prev_close_paise else e.prev_close_paise end as prev_px
    from picked r
    left join quote_cache q on q.symbol = r.symbol and q.price_paise > 0
         and q.updated_at > now() - interval '5 days'
    left join nse_eod_prices e on e.symbol = r.symbol and e.series in ('EQ','BE')
         and e.trade_date = (select dt from eod_day)
  )
  select jsonb_build_object(
    'ok', true, 'sorted_by', lower(coalesce(p_sort,'market_cap')),
    'direction', case when lower(p_dir) = 'asc' then 'asc' else 'desc' end,
    'sector_filter', p_sector, 'top_by_size', p_top_by_size,
    'min_market_cap_cr', coalesce(p_min_market_cap_cr, case when p_top_by_size is null then 1000 else 0 end),
    'matched', (select count(*) from keyed where k is not null),
    'as_of', (select max(as_of) from keyed),
    'value_unit', case lower(coalesce(p_sort,'market_cap'))
      when 'roe' then 'percent' when 'dividend_yield' then 'percent'
      when 'debt_to_equity' then 'ratio (0.5 = debt is half of equity)'
      when 'eps' then 'rupees per share' when 'pb' then 'times book value' else null end,
    'note', 'Companies only (no ETFs or funds). A P/E ranking leaves out loss-making companies. Unless top_by_size or min_market_cap_cr is given, only companies worth ₹1,000 crore or more are ranked (pass min_market_cap_cr 0 to include the smallest). price_inr is the last traded or closing price and change_pct is that session''s move.',
    'results', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'symbol', r.symbol, 'name', left(r.name, 40), 'sector', r.sector, 'market_cap_cr', r.market_cap_cr,
        'pe', r.pe, 'size_rank', r.size_rank,
        'value', case when lower(coalesce(p_sort,'market_cap')) in ('pe','market_cap') then null else r.k end,
        'price_inr', round(r.px / 100.0, 2),
        'change_pct', case when r.prev_px > 0 then round((r.px - r.prev_px) * 100.0 / r.prev_px, 2) end
      )) order by r.ord) from priced r), '[]'::jsonb));
$function$;

revoke all on function public.coach_screen_stocks_v2(text,text,text,numeric,numeric,numeric,int,int) from public;
grant execute on function public.coach_screen_stocks_v2(text,text,text,numeric,numeric,numeric,int,int) to anon, authenticated;
