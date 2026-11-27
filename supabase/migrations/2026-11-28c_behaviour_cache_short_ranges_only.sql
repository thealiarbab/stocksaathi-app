-- behaviour-cache: the nightly job refreshes only the 1-day and 7-day ranges.
--
-- 28 Nov 2026 03:00 IST the job's 30-day pass of admin_behaviour_stats ran
-- 275 s (web_events now holds 30 days, ~1.1M rows, larger than shared
-- buffers; the pass spills to temp files) and the database stopped answering
-- for about 3 minutes until it ended. The 90-day pass did the same work for
-- 70 s on 24 Nov. The 30 and 90 day ranges now run only when asked for:
--   set statement_timeout = '10min'; select public.refresh_admin_behaviour(true);
-- (p_force refreshes the most overdue range, so call it once per range.)
--
-- Undo: restore the previous condition
--   and (r.d <= 7 or night or c.days is null or p_force)
-- with the variable
--   night boolean := extract(hour from (now() at time zone 'Asia/Kolkata')) between 2 and 5;

create or replace function public.refresh_admin_behaviour(p_force boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare d integer; t0 timestamptz; j jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('stocksaathi_admin_analytics_refresh')) then return -1; end if;
  -- One range per run (the most overdue). The 30/90-day passes read every
  -- raw web_events row and stall the database for minutes (28 Nov 03:01 IST),
  -- so the scheduled run never picks them; p_force does.
  select r.d into d
    from unnest(array[1, 7, 30, 90]) as r(d)
    left join admin_behaviour_cache c on c.days = r.d
   where (p_force or c.days is null
      or c.computed_at < clock_timestamp() - case r.d when 1 then interval '9 minutes'
                                                    when 7 then interval '119 minutes'
                                                    else interval '23 hours' end)
     and (r.d <= 7 or p_force)
   order by c.computed_at nulls first, r.d
   limit 1;
  if d is null then return 0; end if;
  t0 := clock_timestamp();
  j := admin_behaviour_stats(d);
  insert into admin_behaviour_cache (days, data, computed_at, ms)
  values (d, j, t0, round(extract(epoch from clock_timestamp() - t0) * 1000))
  on conflict (days) do update set data = excluded.data, computed_at = excluded.computed_at, ms = excluded.ms;
  return d;
end $function$;

revoke all on function public.refresh_admin_behaviour(boolean) from public, anon, authenticated;
