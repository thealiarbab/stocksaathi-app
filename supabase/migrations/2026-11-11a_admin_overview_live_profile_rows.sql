-- Include every current profile in the admin Users list, newest first.
-- Per-user metrics remain a left join to the on-demand overview cache; this
-- avoids re-aggregating transactions, coach messages, holdings, and orders
-- for the entire user base on every Users-tab load.
create or replace function public.admin_overview()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'users',
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            p.id,
            p.username,
            p.display_name,
            p.email,
            p.age,
            p.school,
            p.class_code,
            p.city,
            p.risk_profile,
            p.avatar_color,
            p.onboarded,
            p.created_at,
            p.updated_at,
            u.cash_paise,
            u.starting_cash_paise,
            u.portfolio_updated_at,
            coalesce(round(u.holdings_cost), 0),
            coalesce(u.holdings_count, 0),
            coalesce(u.transaction_count, 0),
            coalesce(u.traded_value, 0),
            coalesce(u.bias_flags_count, 0),
            u.last_transaction_at,
            coalesce(u.coach_message_count, 0),
            coalesce(u.watchlist_count, 0),
            coalesce(u.limit_order_count, 0)
          )
          order by p.created_at desc, p.id desc
        )
        from public.profiles p
        left join public.admin_overview_user_cache u
          on u.user_id = p.id
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

-- Keep the signup snapshot fresh even while the Signups tab is closed.
-- The refresh function shares the analytics advisory lock with other cache
-- refreshes, so overlapping scheduled/on-demand work does not run together.
select cron.alter_job(job_id := 13, active := true);
