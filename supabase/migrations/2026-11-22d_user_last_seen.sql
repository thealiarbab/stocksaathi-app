-- /a "Active" = when the account last USED the site, not when its cash last
-- changed. portfolios.updated_at (the old source) moves on trades and on
-- server-side order fills while the person is away, and not at all on
-- visits: 573 of 1,325 accounts that visited in the week to 22 Nov showed
-- as inactive for over 7 days.
--
-- user_last_seen keeps one row per account. Sources: web_events (page views
-- etc. from signed-in browsers; rows are cleared after ~2 weeks, so this
-- table is what keeps the date) and user_events (in-app actions, kept
-- forever). refresh_user_last_seen() reads only rows newer than its last
-- run (minus 10 minutes of overlap); pg_cron runs it every 15 minutes.

create table if not exists public.user_last_seen (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  last_seen_at timestamptz not null
);
alter table public.user_last_seen enable row level security;
revoke all on public.user_last_seen from public, anon, authenticated;
grant all on public.user_last_seen to service_role;

create table if not exists public.user_last_seen_state (
  id      boolean primary key default true check (id),
  last_run timestamptz
);
insert into public.user_last_seen_state (id) values (true) on conflict do nothing;
alter table public.user_last_seen_state enable row level security;
revoke all on public.user_last_seen_state from public, anon, authenticated;
grant all on public.user_last_seen_state to service_role;

create or replace function public.refresh_user_last_seen()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  v_now   timestamptz := now();
  v_since timestamptz;
  v_n     integer;
begin
  select coalesce(last_run - interval '10 minutes', '-infinity'::timestamptz)
    into v_since from public.user_last_seen_state where id;

  insert into public.user_last_seen (user_id, last_seen_at)
  select s.user_id, max(s.at)
    from (
      select w.uid as user_id, max(w.ts) as at
        from public.web_events w
       where w.uid is not null and w.ts > v_since and w.ts <= v_now
       group by w.uid
      union all
      -- occurred_at comes from the device clock: never trust a future time.
      select e.user_id, least(max(e.occurred_at), v_now)
        from public.user_events e
       where e.user_id is not null and e.occurred_at > v_since
       group by e.user_id
    ) s
    join auth.users u on u.id = s.user_id
   group by s.user_id
  on conflict (user_id) do update
    set last_seen_at = greatest(public.user_last_seen.last_seen_at, excluded.last_seen_at);
  get diagnostics v_n = row_count;

  update public.user_last_seen_state set last_run = v_now where id;
  return v_n;
end;
$$;
revoke execute on function public.refresh_user_last_seen() from public, anon, authenticated;
grant execute on function public.refresh_user_last_seen() to service_role;

-- First run reads everything there is (last_run is null), then every 15 min.
select public.refresh_user_last_seen();
select cron.schedule('user-last-seen', '*/15 * * * *', $$select public.refresh_user_last_seen()$$);

-- admin_overview(): last_seen_at appended as position 28.
CREATE OR REPLACE FUNCTION public.admin_overview()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'users',
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            p.id, p.username, p.display_name, p.email, p.age, p.school, p.class_code, p.city,
            p.risk_profile, p.avatar_color, p.onboarded, p.created_at, p.updated_at,
            u.cash_paise, u.starting_cash_paise, u.portfolio_updated_at,
            coalesce(round(u.holdings_cost), 0), coalesce(u.holdings_count, 0),
            coalesce(u.transaction_count, 0), coalesce(u.traded_value, 0),
            coalesce(u.bias_flags_count, 0), u.last_transaction_at,
            coalesce(u.coach_message_count, 0), coalesce(u.watchlist_count, 0),
            coalesce(u.limit_order_count, 0),
            p.heard_from, p.heard_from_detail,
            ls.last_seen_at
          )
          order by p.created_at desc, p.id desc
        )
        from public.profiles p
        left join public.admin_overview_user_cache u on u.user_id = p.id
        left join public.user_last_seen ls on ls.user_id = p.id
      ),
      '[]'::jsonb
    ),
    'counts',
    coalesce(
      (select c.data from public.admin_overview_counts_cache c where c.cache_id = 1),
      pg_catalog.jsonb_build_object(
        'profiles', 0, 'portfolios', 0, 'transactions', 0, 'coach_messages', 0,
        'holdings', 0, 'watchlist', 0, 'limit_orders', 0, 'ai_response_cache', 0,
        'quote_cache', 0, 'dhan_instruments', 0, 'admin_audit_log', 0,
        'portfolio_history', 0
      )
    )
  );
$function$;
