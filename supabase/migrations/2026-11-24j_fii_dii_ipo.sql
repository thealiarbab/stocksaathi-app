-- FII/DII flows and the IPO list, for two coach lookups (24 Nov 2026).
--
-- GR-1 shows "Checking FII/DII Activity" and an "Upcoming IPO pipeline";
-- Saathi had neither because NSE blocks Vercel. A GitHub runner fetches both
-- (scripts/market_extras.py, run by nse-eod.yml) and posts them to
-- /api/admin-ingest-eod with kind = "market_extras".
--
-- Only the service role writes. Students read through the two coach_ functions.

create table if not exists public.fii_dii_daily (
  trade_date  date primary key,
  fii_buy_cr  numeric(14,2),
  fii_sell_cr numeric(14,2),
  fii_net_cr  numeric(14,2),
  dii_buy_cr  numeric(14,2),
  dii_sell_cr numeric(14,2),
  dii_net_cr  numeric(14,2),
  updated_at  timestamptz not null default now()
);
alter table public.fii_dii_daily enable row level security;
revoke all on public.fii_dii_daily from anon, authenticated;

create table if not exists public.ipo_calendar (
  symbol         text primary key,
  company        text not null,
  board          text,          -- 'Mainboard' or 'SME'
  status         text,          -- as NSE gives it: Forthcoming, Active, Closed
  opens_on       date,
  closes_on      date,
  price_band     text,
  shares_offered bigint,
  listing_on     date,
  updated_at     timestamptz not null default now()
);
alter table public.ipo_calendar enable row level security;
revoke all on public.ipo_calendar from anon, authenticated;

create or replace function public.admin_ingest_market_extras(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_flow int := 0; n_ipo int := 0;
begin
  insert into fii_dii_daily (trade_date, fii_buy_cr, fii_sell_cr, fii_net_cr, dii_buy_cr, dii_sell_cr, dii_net_cr, updated_at)
  select (x->>'trade_date')::date,
         (x->>'fii_buy_cr')::numeric, (x->>'fii_sell_cr')::numeric, (x->>'fii_net_cr')::numeric,
         (x->>'dii_buy_cr')::numeric, (x->>'dii_sell_cr')::numeric, (x->>'dii_net_cr')::numeric, now()
  from jsonb_array_elements(coalesce(p->'fii_dii', '[]'::jsonb)) x
  where x->>'trade_date' ~ '^\d{4}-\d{2}-\d{2}$'
  on conflict (trade_date) do update set
    fii_buy_cr = coalesce(excluded.fii_buy_cr, fii_dii_daily.fii_buy_cr),
    fii_sell_cr = coalesce(excluded.fii_sell_cr, fii_dii_daily.fii_sell_cr),
    fii_net_cr = coalesce(excluded.fii_net_cr, fii_dii_daily.fii_net_cr),
    dii_buy_cr = coalesce(excluded.dii_buy_cr, fii_dii_daily.dii_buy_cr),
    dii_sell_cr = coalesce(excluded.dii_sell_cr, fii_dii_daily.dii_sell_cr),
    dii_net_cr = coalesce(excluded.dii_net_cr, fii_dii_daily.dii_net_cr),
    updated_at = now();
  get diagnostics n_flow = row_count;

  insert into ipo_calendar (symbol, company, board, status, opens_on, closes_on, price_band, shares_offered, listing_on, updated_at)
  select upper(x->>'symbol'), x->>'company', x->>'board', x->>'status',
         (x->>'opens_on')::date, (x->>'closes_on')::date, nullif(x->>'price_band', ''),
         (x->>'shares_offered')::bigint, (x->>'listing_on')::date, now()
  from jsonb_array_elements(coalesce(p->'ipos', '[]'::jsonb)) x
  where coalesce(x->>'symbol', '') <> '' and coalesce(x->>'company', '') <> ''
  on conflict (symbol) do update set
    company = excluded.company,
    board = coalesce(excluded.board, ipo_calendar.board),
    status = coalesce(excluded.status, ipo_calendar.status),
    opens_on = coalesce(excluded.opens_on, ipo_calendar.opens_on),
    closes_on = coalesce(excluded.closes_on, ipo_calendar.closes_on),
    price_band = coalesce(excluded.price_band, ipo_calendar.price_band),
    shares_offered = coalesce(excluded.shares_offered, ipo_calendar.shares_offered),
    listing_on = coalesce(excluded.listing_on, ipo_calendar.listing_on),
    updated_at = now();
  get diagnostics n_ipo = row_count;

  return jsonb_build_object('ok', true, 'fii_dii_rows', n_flow, 'ipo_rows', n_ipo);
end $$;
revoke all on function public.admin_ingest_market_extras(jsonb) from public, anon, authenticated;
grant execute on function public.admin_ingest_market_extras(jsonb) to service_role;

create or replace function public.coach_fii_dii(p_days int default 5)
returns jsonb language sql stable security definer set search_path = public as $$
  with d as (
    select * from fii_dii_daily order by trade_date desc
    limit least(greatest(coalesce(p_days, 5), 1), 30)
  )
  select jsonb_build_object(
    'ok', true,
    'unit', 'rupees crore, cash market, provisional figures published by NSE',
    'latest_session', (select max(trade_date) from d),
    'sessions_covered', (select count(*) from d),
    'total_foreign_net_cr', (select sum(fii_net_cr) from d),
    'total_domestic_net_cr', (select sum(dii_net_cr) from d),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
        'date', trade_date,
        'foreign_net_cr', fii_net_cr, 'foreign_bought_cr', fii_buy_cr, 'foreign_sold_cr', fii_sell_cr,
        'domestic_net_cr', dii_net_cr, 'domestic_bought_cr', dii_buy_cr, 'domestic_sold_cr', dii_sell_cr
      ) order by trade_date desc) from d), '[]'::jsonb),
    'note', 'Foreign = foreign portfolio investors (FII, also called FPI). Domestic = Indian institutions such as mutual funds and insurers (DII). Net = bought minus sold, so a positive net means they bought more than they sold that day. StockSaathi started collecting this on 24 Nov 2026, so older days are not here. One day of flows says little and is not a reason to buy or sell.'
  );
$$;
revoke all on function public.coach_fii_dii(int) from public;
grant execute on function public.coach_fii_dii(int) to anon, authenticated;

create or replace function public.coach_ipo_calendar()
returns jsonb language sql stable security definer set search_path = public as $$
  with t as (select (now() at time zone 'Asia/Kolkata')::date as d),
  r as (
    select i.*, jsonb_build_object(
      'company', company, 'symbol', symbol, 'board', board,
      'opens_on', opens_on, 'closes_on', closes_on, 'price_band', price_band,
      'shares_offered', shares_offered, 'listing_on', listing_on) as j
    from ipo_calendar i
  )
  select jsonb_build_object(
    'ok', true,
    'today', (select d from t),
    'last_updated', (select max(updated_at) from ipo_calendar),
    'open_now', coalesce((select jsonb_agg(j order by closes_on) from r, t where opens_on <= t.d and closes_on >= t.d), '[]'::jsonb),
    'opening_soon', coalesce((select jsonb_agg(j order by opens_on) from (select r.* from r, t where opens_on > t.d order by opens_on limit 15) r), '[]'::jsonb),
    'closed_recently', coalesce((select jsonb_agg(j order by closes_on desc) from (select r.* from r, t where closes_on < t.d and closes_on >= t.d - 30 order by closes_on desc limit 12) r), '[]'::jsonb),
    'note', 'IPO = a company selling its shares to the public for the first time. Mainboard IPOs are larger companies. SME IPOs are small companies on NSE Emerge: higher risk and a much larger minimum application. This list is the issues NSE has announced, not every company that has filed papers. StockSaathi does not take IPO applications; this is for learning. Source: NSE.'
  );
$$;
revoke all on function public.coach_ipo_calendar() from public;
grant execute on function public.coach_ipo_calendar() to anon, authenticated;
