-- Report card v2: what the "Learning and activity" pillar reads.
--
-- 1. learn_events: one row each time a signed-in user opens an explainer (a
--    finance term, the "What is ...?" sheet of an after-trade note, a report
--    card pillar). Nothing recorded this per user before: user_events has a
--    CHECK whitelist on kind that cannot be widened through the connector, and
--    web_events carries no account id.
-- 2. report_card_activity(): the caller's last 12 weeks as one small array,
--    [week_start, active_days, replays_finished, coach_questions, reads],
--    so the report card makes one call instead of reading event rows.
--
-- No kind whitelist on learn_events on purpose (see 1): a length check only.

create table if not exists public.learn_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null check (char_length(kind) between 1 and 24),
  subject     text check (subject is null or char_length(subject) <= 120),
  occurred_at timestamptz not null default now()
);

create index if not exists learn_events_user_time_idx
  on public.learn_events (user_id, occurred_at desc);

alter table public.learn_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'learn_events' and policyname = 'learn_events_self_read') then
    create policy learn_events_self_read on public.learn_events
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'learn_events' and policyname = 'learn_events_self_insert') then
    create policy learn_events_self_insert on public.learn_events
      for insert to authenticated with check ((select auth.uid()) = user_id);
  end if;
end $$;

revoke all on public.learn_events from public, anon, authenticated;
grant select, insert on public.learn_events to authenticated;
grant all on public.learn_events to service_role;

-- One user's weeks (Monday start, IST). Internal: called by the RPC below.
--   active_days  days with any signed-in activity (user_events, coach, learn)
--   replays      crash replays finished (user_events replay_finish, or the
--                coach's CRASH_SIMULATION_END row; the larger of the two, as
--                both can describe the same finish)
--   questions    questions asked to the coach (chat page or side panel)
--   reads        explainers opened + /learn articles read, once per day each
create or replace function public._report_card_activity(p_user uuid, p_weeks int default 12)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
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
$$;

create or replace function public.report_card_activity()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when auth.uid() is null then '[]'::jsonb
              else public._report_card_activity(auth.uid(), 12) end;
$$;

revoke all on function public._report_card_activity(uuid, int) from public, anon, authenticated;
revoke all on function public.report_card_activity() from public, anon;
grant execute on function public.report_card_activity() to authenticated;
