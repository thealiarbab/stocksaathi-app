-- Applied to production on 24 Nov 2026 (migration 2026_11_24g).
--
-- public.admin_portfolio_snapshot_mtm(jsonb) runs twice on a trading day: the
-- pg_cron job at 16:00 IST (on time) and the GitHub backup workflow, which
-- GitHub starts about 8 hours late. The second run found the day's rows and
-- refreshed them, but also set ts = now(), so every day's point moved past
-- midnight IST (Friday's close was stamped Saturday 00:10).
--
-- A refresh now updates the values and keeps the time the snapshot was first
-- written. Rows stamped before this fix were left as they are.
do $$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.admin_portfolio_snapshot_mtm(jsonb)'::regprocedure);
  d2 := regexp_replace(d, 'SET ts = now\(\),\s*total_value_paise = tv,', 'SET total_value_paise = tv,');
  if d2 <> d then execute d2; end if;
end $$;
