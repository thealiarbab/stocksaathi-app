-- 2026-11-12 (applied live ~05:30 IST via SQL; this file records it).
-- 11 Nov outage: 504s from 09:00 IST, DB unreachable 12:30-~15:30. Request
-- volume was lower than 9 Nov; disk reads were the problem (cache hit 94.8%,
-- user_events 77%). Three changes, each reversible in one line.

-- 1. admin_signup_stats counts page_view over 91 days; with no (kind, time)
--    index that was a full read of user_events (169 MB) every run. Now an
--    index-only scan of an 18 MB index.
--    Undo: drop index concurrently public.user_events_kind_occurred_at_idx;
create index concurrently if not exists user_events_kind_occurred_at_idx
  on public.user_events (kind, occurred_at);

-- 2. Signup stats cache refresh: every 30 min outside 08:30-16:29 IST
--    (03:00-10:59 UTC) instead of all day.
--    Undo: select cron.alter_job(jobid, schedule := '13,43 * * * *') from cron.job where jobname='signup-stats-cache';
select cron.alter_job(jobid, schedule := '13,43 0-2,11-23 * * *')
  from cron.job where jobname = 'signup-stats-cache';

-- 3. /api/admin-sync-mf re-upserts all ~14,300 schemes 5x a day (one run at
--    09:10 IST); only cached_at_ms differs on most rows. Skip those rewrites.
--    The app never reads mf_master.cached_at_ms.
--    Undo: drop trigger mf_master_skip_noop on public.mf_master;
create or replace function public.mf_master_skip_noop_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'cached_at_ms' - 'updated_at') = (to_jsonb(old) - 'cached_at_ms' - 'updated_at') then
    return null;
  end if;
  return new;
end $$;
drop trigger if exists mf_master_skip_noop on public.mf_master;
create trigger mf_master_skip_noop before update on public.mf_master
  for each row execute function public.mf_master_skip_noop_update();
