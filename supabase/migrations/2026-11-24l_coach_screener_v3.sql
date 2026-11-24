-- Coach screener v3 (24 Nov 2026, evening). Owner chat c_mwuy70dr9f7r: "show me
-- top 100 stocks by profit" got an EPS list of 50 with GSPL Transmission at an
-- EPS of 58,140 on a Rs 104 share, Raymond's EPS not matching its P/E, and
-- Shree Cement twice.
--   * sort 'net_profit': yearly profit in Rs crore = market value / trailing P/E
--     (no profit column is stored; this is the identity P/E = value / profit).
--   * up to 100 rows (was 50).
--   * one row per company name (alias symbols such as SHREE / SHREECEM).
--   * EPS and profit rankings leave out rows whose EPS and P/E disagree by more
--     than 2x (checked against the price) and say how many were left out.
-- coach_screen_stocks_v2 stays for browsers on a cached bundle.
create or replace function public.coach_screen_stocks_v3(
  p_sort text default 'market_cap', p_dir text default 'desc', p_sector text default null,
  p_min_market_cap_cr numeric default null, p_max_pe numeric default null, p_min_pe numeric default null,
  p_limit integer default 15, p_top_by_size integer default null)
returns jsonb
language sql stable security definer
set search_path to 'public'
as $function$
  with pat as (select public._coach_sector_pattern(p_sector) as re),
  eod_day as (select max(trade_date) as dt from nse_eod_prices),
  raw as (
    select f.symbol, f.name, f.sector, f.industry, f.market_cap,
           coalesce(f.pe_ttm, f.pe_ratio) as pe_raw, f.pb_ratio, f.roe, f.dividend_yield, f.debt_to_equity, f.eps, f.updated_at,
           coalesce(q.price_paise, e.close_paise) as px,
           case when q.price_paise is not null then q.prev_close_paise else e.prev_close_paise end as prev_px,
           (e.symbol is not null) as listed
    from fundamentals_cache f
    cross join pat
    left join quote_cache q on q.symbol = f.symbol and q.price_paise > 0
         and q.updated_at > now() - interval '5 days'
    left join nse_eod_prices e on e.symbol = f.symbol and e.series in ('EQ','BE')
         and e.trade_date = (select dt from eod_day)
    where f.name is not null and f.market_cap is not null and f.market_cap > 0
      and coalesce(f.sector,'') !~* '^(etf|index)$'
      and f.name !~* '\m(etf|bees|index fund|mutual fund|nifty|sensex|amc-|liquid)\M'
      and f.symbol !~* '(BEES|ETF|IETF)$' and f.symbol !~ '\.(BO|NS)$'
      and (pat.re is null or coalesce(f.sector,'') ~* pat.re or coalesce(f.industry,'') ~* pat.re)
  ), companies as (
    -- One row per company. The feed carries alias symbols under the same name
    -- (SHREE and SHREECEM, CONTAINE and CONCOR): keep the one in NSE's
    -- end-of-day file, else the freshest.
    select * from (
      select *, row_number() over (partition by lower(name) order by listed desc, updated_at desc, market_cap desc) as rn
      from raw) t
    where rn = 1
  ), sized as (
    select *, row_number() over (order by market_cap desc) as size_rank from companies
  ), base as (
    select symbol, name, sector, round(market_cap / 1e7, 0) as market_cap_cr, size_rank,
           round(pe_raw, 2) as pe, round(pb_ratio, 2) as pb, round(roe * 100, 2) as roe,
           round(dividend_yield * 100, 2) as dividend_yield, round(debt_to_equity / 100, 2) as debt_to_equity,
           round(eps, 2) as eps, updated_at::date as as_of, px, prev_px, pe_raw,
           -- Do the stored EPS and P/E describe the same earnings? Price / P/E
           -- should be about the EPS. NULL when it cannot be checked.
           case when pe_raw > 0 and eps > 0 and px > 0
                then (eps * pe_raw / (px / 100.0)) between 0.5 and 2 end as eps_ok
    from sized
    where (p_top_by_size is null or size_rank <= greatest(1, least(p_top_by_size, 500)))
      and market_cap >= coalesce(p_min_market_cap_cr, case when p_top_by_size is null then 1000 else 0 end) * 1e7
      and (p_max_pe is null or pe_raw <= p_max_pe)
      and (p_min_pe is null or pe_raw >= p_min_pe)
  ), keyed as (
    select *, case lower(coalesce(p_sort,'market_cap'))
      when 'pe' then (case when pe > 0 and (eps is null or eps > 0) then pe end)
      when 'pb' then pb when 'roe' then roe when 'dividend_yield' then dividend_yield
      when 'debt_to_equity' then debt_to_equity
      when 'eps' then (case when eps_ok is distinct from false then eps end)
      -- Yearly profit is not stored. Market value / trailing P/E is the last
      -- twelve months' profit by definition; loss-makers have no P/E.
      when 'net_profit' then (case when pe_raw > 0 and eps_ok is distinct from false then round(market_cap_cr / pe_raw, 0) end)
      else market_cap_cr end as k
    from base
  ), picked as (
    select *, row_number() over (
        order by case when lower(p_dir) = 'asc' then k end asc nulls last,
                 case when lower(p_dir) <> 'asc' then k end desc nulls last) as ord
    from keyed where k is not null
    order by ord
    limit greatest(1, least(coalesce(p_limit, 15), 100))
  ), priced as (select * from picked)
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
      when 'eps' then 'rupees per share' when 'pb' then 'times book value'
      when 'net_profit' then 'rupees crore a year (an estimate: market value divided by P/E)' else null end,
    'left_out_inconsistent', case when lower(coalesce(p_sort,'')) in ('eps','net_profit')
      then (select count(*) from base where eps_ok = false) end,
    'note', 'Companies only (no ETFs or funds). A P/E ranking leaves out loss-making companies. Unless top_by_size or min_market_cap_cr is given, only companies worth ₹1,000 crore or more are ranked (pass min_market_cap_cr 0 to include the smallest). price_inr is the last traded or closing price and change_pct is that session''s move. net_profit is the last twelve months'' profit after tax in rupees crore, worked out as market value divided by P/E: call it an estimate and say how it was worked out. Loss-making companies have no P/E, so they are not in a profit ranking. left_out_inconsistent counts companies left out of an EPS or profit ranking because their stored EPS and P/E disagree with each other.',
    'results', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'symbol', r.symbol, 'name', left(r.name, 40), 'sector', r.sector, 'market_cap_cr', r.market_cap_cr,
        'pe', r.pe, 'size_rank', r.size_rank,
        'value', case when lower(coalesce(p_sort,'market_cap')) in ('pe','market_cap') then null else r.k end,
        'price_inr', round(r.px / 100.0, 2),
        'change_pct', case when r.prev_px > 0 then round((r.px - r.prev_px) * 100.0 / r.prev_px, 2) end
      )) order by r.ord) from priced r), '[]'::jsonb));
$function$;

revoke all on function public.coach_screen_stocks_v3(text,text,text,numeric,numeric,numeric,int,int) from public;
grant execute on function public.coach_screen_stocks_v3(text,text,text,numeric,numeric,numeric,int,int) to anon, authenticated;
