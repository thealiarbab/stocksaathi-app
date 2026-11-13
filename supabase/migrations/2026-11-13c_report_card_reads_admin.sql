-- Report card v2, follow-up (13 Nov 2026).
--
-- 1. News articles a user opened (user_events kind news_click) now count as
--    reads in the Learning part, next to explainers and /learn pages.
--    Explainer reads were never stored per account before 13 Nov, so without
--    this the "reads" part started at zero for everyone; news clicks go back
--    weeks (657 in the last 8 weeks, 421 users).
-- 2. The admin user view (api/ai.js computeReportCardServerSide, service
--    role) scores the same v2 card, so it may read the activity weeks.

create or replace function public._report_card_activity(p_user uuid, p_weeks integer default 12)
 returns jsonb
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  with lim as (
    select ((date_trunc('week', now() at time zone 'Asia/Kolkata')
             - make_interval(weeks => greatest(1, least(coalesce(p_weeks, 12), 26)) - 1))
            at time zone 'Asia/Kolkata') as since
  ),
  ev as (
    select (e.occurred_at at time zone 'Asia/Kolkata')::date as d, e.kind, e.subject
      from public.user_events e, lim
     where e.user_id = p_user and e.occurred_at >= lim.since
  ),
  cm as (
    select (c.created_at at time zone 'Asia/Kolkata')::date as d, c.event_type, c.trigger_symbol
      from public.coach_messages c, lim
     where c.user_id = p_user and c.created_at >= lim.since
       and c.event_type in ('chat_user', 'CRASH_SIMULATION_END')
  ),
  le as (
    select (l.occurred_at at time zone 'Asia/Kolkata')::date as d, l.kind, l.subject
      from public.learn_events l, lim
     where l.user_id = p_user and l.occurred_at >= lim.since
  ),
  per as (
    select date_trunc('week', d)::date as w, 'day' as k, d::text as v from ev
    union select date_trunc('week', d)::date, 'day', d::text from cm
    union select date_trunc('week', d)::date, 'day', d::text from le
    union select date_trunc('week', d)::date, 'r1', d::text || coalesce(subject, '') from ev where kind = 'replay_finish'
    union select date_trunc('week', d)::date, 'r2', d::text || coalesce(trigger_symbol, '') from cm where event_type = 'CRASH_SIMULATION_END'
    union select date_trunc('week', d)::date, 'x', d::text || subject from ev where kind = 'page_view' and subject like '/learn/%'
    union select date_trunc('week', d)::date, 'x', d::text || 'news' || coalesce(subject, '') from ev where kind = 'news_click'
    union select date_trunc('week', d)::date, 'x', d::text || kind || coalesce(subject, '') from le
  ),
  q as (
    select date_trunc('week', d)::date as w, count(*) as n
      from cm where event_type = 'chat_user' group by 1
  ),
  agg as (
    select w,
           count(*) filter (where k = 'day') as days,
           greatest(count(*) filter (where k = 'r1'), count(*) filter (where k = 'r2')) as replays,
           count(*) filter (where k = 'x') as reads
      from per group by w
  )
  select coalesce(jsonb_agg(jsonb_build_array(a.w, a.days, a.replays, coalesce(q.n, 0), a.reads) order by a.w), '[]'::jsonb)
    from agg a left join q on q.w = a.w;
$function$;

revoke all on function public._report_card_activity(uuid, integer) from public, anon, authenticated;
grant execute on function public._report_card_activity(uuid, integer) to service_role;
