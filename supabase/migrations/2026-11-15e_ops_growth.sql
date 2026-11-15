-- Ops agent, phase 4: growth.
--   * Sunday consolidation at no AI cost: merges exact duplicate memory cards
--     (by a flag, nothing is removed), retires lessons that misled, lists what
--     needs the agent's judgement, refreshes the site profile, and scores the
--     agent's week.
--   * Self-tuning inside bounds that are written in this file. Anything
--     outside them is filed as a proposal for the owner.
--   * Facts for the watcher's tell-only reflexes (read-only).
-- Nothing here removes a row or changes a user's data.

create table if not exists public.ops_weekly (
  week_start date primary key,
  built_at   timestamptz not null default now(),
  score      jsonb not null default '{}'::jsonb,
  merged     jsonb not null default '[]'::jsonb,
  candidates jsonb not null default '{}'::jsonb
);
create table if not exists public.ops_tuning (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
create table if not exists public.ops_tuning_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  key         text not null,
  old         numeric,
  new         numeric,
  why         text,
  actor       text,
  applied     boolean not null default false,
  refused_why text
);
create index if not exists ops_tuning_log_at on public.ops_tuning_log (at desc);

alter table public.ops_weekly enable row level security;
alter table public.ops_tuning enable row level security;
alter table public.ops_tuning_log enable row level security;
revoke all on public.ops_weekly, public.ops_tuning, public.ops_tuning_log from public, anon, authenticated;
grant select on public.ops_weekly, public.ops_tuning, public.ops_tuning_log to service_role;

-- The only settings the agent may tune, with their fixed limits. To widen a
-- limit, this function has to be changed in a migration: a person's decision.
create or replace function public._ops_tuning_bounds()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    -- how alike (0..1) a past case must be before memory search returns it
    'memory_min_meaning',          jsonb_build_object('def', 0.80, 'lo', 0.76, 'hi', 0.84, 'step', 0.01),
    -- sign-up forms sent in 30 minutes with no account created = "stuck"
    'signup_stuck_submits',        jsonb_build_object('def', 7, 'lo', 5, 'hi', 12, 'step', 1),
    -- e-mail accounts created in 60 minutes with none confirmed = "unconfirmed"
    'signup_unconfirmed_accounts', jsonb_build_object('def', 8, 'lo', 6, 'hi', 14, 'step', 1));
$$;
revoke execute on function public._ops_tuning_bounds() from public, anon, authenticated;

-- One small step, inside the limits, at most once a week per setting, with a
-- written reason. Anything else is written down as a proposal and not applied.
create or replace function public.ops_tune(p_actor text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := p ->> 'key';
  v_why text := btrim(coalesce(p ->> 'why', ''));
  b jsonb;
  v_new numeric;
  v_old numeric;
  v_refuse text;
begin
  perform public._ops_actor(p_actor);
  b := public._ops_tuning_bounds() -> v_key;
  begin v_new := (p ->> 'value')::numeric; exception when others then v_new := null; end;
  if b is null then
    v_refuse := 'not a setting the agent may tune';
  elsif v_new is null then
    v_refuse := 'no number given';
  else
    select value into v_old from public.ops_tuning where key = v_key;
    v_old := coalesce(v_old, (b ->> 'def')::numeric);
    if length(v_why) < 20 then
      v_refuse := 'no reason given (20 characters or more)';
    elsif v_new < (b ->> 'lo')::numeric or v_new > (b ->> 'hi')::numeric then
      v_refuse := format('outside the fixed limits (%s to %s)', b ->> 'lo', b ->> 'hi');
    elsif v_new = v_old then
      v_refuse := 'already at that value';
    elsif abs(v_new - v_old) > (b ->> 'step')::numeric then
      v_refuse := format('more than one step (%s) at a time', b ->> 'step');
    elsif exists (select 1 from public.ops_tuning_log l where l.key = v_key and l.applied and l.at > now() - interval '7 days') then
      v_refuse := 'already tuned in the last 7 days';
    end if;
  end if;

  insert into public.ops_tuning_log (key, old, new, why, actor, applied, refused_why)
  values (coalesce(v_key, '(none)'), v_old, v_new, left(v_why, 500), p_actor, v_refuse is null, v_refuse);

  if v_refuse is not null then
    return jsonb_build_object('ok', true, 'applied', false, 'proposal', true, 'why_not', v_refuse,
                              'note', 'written down as a proposal; the owner sees it in the daily brief');
  end if;

  insert into public.ops_tuning (key, value, updated_at, updated_by) values (v_key, v_new, now(), p_actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  -- Memory search reads its own setting from ops_config.
  if v_key = 'memory_min_meaning' then
    insert into public.ops_config (key, value, updated_at, updated_by)
    values ('memory', jsonb_build_object('min_meaning', v_new), now(), p_actor)
    on conflict (key) do update set value = coalesce(public.ops_config.value, '{}'::jsonb) || excluded.value,
                                    updated_at = now(), updated_by = excluded.updated_by;
  end if;
  return jsonb_build_object('ok', true, 'applied', true, 'key', v_key, 'old', v_old, 'new', v_new);
end $$;
revoke execute on function public.ops_tune(text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_tune(text, jsonb) to service_role;

-- Sunday 04:50 IST, by pg_cron. Plain SQL only.
create or replace function public.ops_consolidate()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_week date := date_trunc('week', now() at time zone 'Asia/Kolkata')::date;
  v_since timestamptz := now() - interval '7 days';
  v_merged jsonb := '[]'::jsonb;
  v_retired jsonb := '[]'::jsonb;
  v_cand jsonb;
  v_score jsonb;
  v_profile text := 'ok';
  i int;
begin
  -- 1. Exact duplicates: the same commit, the same component, and near
  --    identical meaning. The weaker card points at the better one; memory
  --    search already skips cards that point elsewhere. Nothing is removed.
  with q as (
    select c.id, c.commit_ref, coalesce(c.component, '') comp,
           (case when c.outcome = 'held' then 2 when c.outcome = 'pending' then 1 else 0 end) * 1000
             + coalesce(c.confirmed, 0) - coalesce(c.contradicted, 0) as rank
      from public.ops_cases c
     where c.superseded_by is null and coalesce(c.commit_ref, '') <> ''
  ), pairs as (
    select a.id a_id, a.rank a_rank, b.id b_id, b.rank b_rank
      from q a join q b on b.id > a.id and b.commit_ref = a.commit_ref and b.comp = a.comp
      join public.ops_vectors va on va.t = 'case' and va.id = a.id
      join public.ops_vectors vb on vb.t = 'case' and vb.id = b.id
     where 1 - (va.embedding operator(extensions.<=>) vb.embedding) >= 0.90
  ), lose as (
    -- in each pair the lower rank loses; on a tie the newer card loses
    select case when a_rank >= b_rank then b_id else a_id end loser,
           case when a_rank >= b_rank then a_id else b_id end keeper,
           greatest(a_rank, b_rank) keeper_rank
      from pairs
  ), pick as (
    select distinct on (loser) loser, keeper from lose order by loser, keeper_rank desc, keeper
  ), done as (
    update public.ops_cases c set superseded_by = p.keeper
      from pick p where c.id = p.loser and c.superseded_by is null
    returning c.id, c.superseded_by
  )
  select coalesce(jsonb_agg(jsonb_build_object('card', id, 'into', superseded_by) order by id), '[]'::jsonb) into v_merged from done;
  -- A keeper that itself lost to a better card: point straight at the end.
  for i in 1..3 loop
    update public.ops_cases c set superseded_by = k.superseded_by
      from public.ops_cases k
     where c.superseded_by = k.id and k.superseded_by is not null and k.superseded_by <> c.id;
    exit when not found;
  end loop;

  -- 2. Lessons that misled more often than they helped are retired (kept,
  --    not shown to the agent any more).
  with r as (
    update public.ops_lessons set status = 'retired', updated_at = now()
     where status = 'active' and coalesce(misled, 0) >= 2 and coalesce(misled, 0) > coalesce(helped, 0)
    returning id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_retired from r;

  -- 3. What needs judgement: lists for the agent's weekly review.
  select jsonb_build_object(
    'near_duplicates', coalesce((
      select jsonb_agg(x order by (x ->> 'alike')::numeric desc) from (
        select jsonb_build_object('a', a.id, 'b', b.id, 'alike', round((1 - (va.embedding operator(extensions.<=>) vb.embedding))::numeric, 3),
                                  'a_title', left(a.title, 80), 'b_title', left(b.title, 80)) x
          from public.ops_cases a
          join public.ops_cases b on b.id > a.id and b.superseded_by is null
          join public.ops_vectors va on va.t = 'case' and va.id = a.id
          join public.ops_vectors vb on vb.t = 'case' and vb.id = b.id
         where a.superseded_by is null and 1 - (va.embedding operator(extensions.<=>) vb.embedding) >= 0.93
         order by va.embedding operator(extensions.<=>) vb.embedding
         limit 20) n), '[]'::jsonb),
    'contradicted_cards', coalesce((
      select jsonb_agg(jsonb_build_object('card', id, 'confirmed', confirmed, 'contradicted', contradicted, 'title', left(title, 80)) order by id)
        from public.ops_cases
       where superseded_by is null and coalesce(contradicted, 0) >= 2 and coalesce(contradicted, 0) > coalesce(confirmed, 0)), '[]'::jsonb),
    'skill_candidates', coalesce((
      select jsonb_agg(jsonb_build_object('component', component, 'cards', n, 'card_ids', ids) order by n desc) from (
        select c.component, count(*) n, (array_agg(c.id order by c.id desc))[1:8] ids
          from public.ops_cases c
         where c.superseded_by is null and c.component is not null and c.outcome in ('pending', 'held')
           and not exists (select 1 from public.ops_skills s where s.component = c.component and s.stage <> 'suspended')
         group by 1 having count(*) >= 2) s), '[]'::jsonb),
    'failing_skills', coalesce((
      select jsonb_agg(jsonb_build_object('skill', id, 'name', name, 'bad_in_a_row', bad_streak) order by bad_streak desc)
        from public.ops_skills where coalesce(bad_streak, 0) >= 2), '[]'::jsonb),
    'map_missing', coalesce((
      select jsonb_agg(component order by component) from (
        select distinct i.component from public.ops_issues i
         where i.opened_at > now() - interval '30 days' and i.component is not null
           and not exists (select 1 from public.ops_system_map m where m.component = i.component)
         limit 30) m), '[]'::jsonb),
    'map_old', coalesce((
      select jsonb_agg(component order by component) from (
        select component from public.ops_system_map where updated_at < now() - interval '30 days' limit 30) m), '[]'::jsonb),
    'lessons_retired', v_retired
  ) into v_cand;

  -- 4. The hour-by-hour picture of a normal week.
  begin
    perform public.ops_profile_refresh();
  exception when others then
    v_profile := left(sqlerrm, 120);
  end;

  -- 5. The agent's score for the last 7 days.
  select jsonb_build_object(
    'days', 7,
    'issues_opened', (select count(*) from public.ops_issues where opened_at > v_since),
    'fixed', (select count(*) from public.ops_issues where opened_at > v_since and status = 'fixed'),
    -- from the first report to the issue being opened
    'notice_min_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from opened_at - first_seen) / 60))::numeric, 1)
                            from public.ops_issues where opened_at > v_since and first_seen is not null and source <> 'manual'),
    'fix_min_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from fixed_at - opened_at) / 60))::numeric)
                         from public.ops_issues where opened_at > v_since and status = 'fixed' and fixed_at is not null),
    'missed_reported_by_owner', (select count(*) from public.ops_issues where opened_at > v_since and source = 'manual'),
    'changes_made', (select count(*) from public.ops_attempts where started_at > v_since and actor <> 'owner' and live_at is not null),
    'wrong_diagnoses', (select count(*) from public.ops_attempts
                         where started_at > v_since and actor <> 'owner' and verdict in ('made_worse', 'reverted', 'no_effect')),
    'runs', (select count(*) from public.ops_episodes where started_at > v_since and coalesce(mode, '') <> 'test'),
    -- finished, wrote no card, recorded no change, tried nothing
    'runs_not_worth_it', (select count(*) from public.ops_episodes e
                           where e.started_at > v_since and coalesce(e.mode, '') <> 'test' and e.ended_at is not null
                             and coalesce(cardinality(e.case_ids), 0) = 0 and btrim(coalesce(e.changed, '')) = ''
                             and not exists (select 1 from public.ops_attempts a where a.actor <> 'owner' and a.started_at between e.started_at and e.ended_at)
                             and not exists (select 1 from public.ops_changes ch where ch.at between e.started_at and e.ended_at and ch.actor <> 'owner')),
    'runs_died', (select count(*) from public.ops_episodes
                   where started_at > v_since and ended_at is null and started_at < now() - interval '2 hours'),
    'cards_written', (select count(*) from public.ops_cases where created_at > v_since and outcome <> 'seeded'),
    'profile_refresh', v_profile,
    'board', public.ops_scoreboard(7)
  ) into v_score;

  insert into public.ops_weekly (week_start, built_at, score, merged, candidates)
  values (v_week, now(), v_score, v_merged, v_cand)
  on conflict (week_start) do update
    set built_at = now(), score = excluded.score, candidates = excluded.candidates,
        -- a second run in the same week adds to the merge list, never forgets it
        merged = public.ops_weekly.merged || excluded.merged;

  return jsonb_build_object('ok', true, 'week_start', v_week, 'merged', jsonb_array_length(v_merged),
    'lessons_retired', jsonb_array_length(v_retired),
    'near_duplicates', jsonb_array_length(v_cand -> 'near_duplicates'),
    'skill_candidates', jsonb_array_length(v_cand -> 'skill_candidates'));
end $$;
revoke execute on function public.ops_consolidate() from public, anon, authenticated;
grant execute on function public.ops_consolidate() to service_role;

-- For the watcher (once a night): the week's score in short, the tuning in
-- force, and what was tuned or proposed in the last 7 days.
create or replace function public.ops_growth(p_secret text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object(
    'ok', true, 'at', now(),
    'week', (select jsonb_build_object(
               'week_start', w.week_start, 'built_at', w.built_at,
               'score', w.score - 'board',
               'merged', jsonb_array_length(w.merged),
               'near_duplicates', jsonb_array_length(coalesce(w.candidates -> 'near_duplicates', '[]'::jsonb)),
               'skill_candidates', jsonb_array_length(coalesce(w.candidates -> 'skill_candidates', '[]'::jsonb)),
               'lessons_retired', jsonb_array_length(coalesce(w.candidates -> 'lessons_retired', '[]'::jsonb)))
               from public.ops_weekly w order by w.week_start desc limit 1),
    'tuning', jsonb_build_object(
      'values', (select jsonb_object_agg(b.key, coalesce(t.value, (b.value ->> 'def')::numeric))
                   from jsonb_each(public._ops_tuning_bounds()) b left join public.ops_tuning t on t.key = b.key),
      'changes', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'key', l.key, 'old', l.old, 'new', l.new, 'why', left(l.why, 200), 'actor', l.actor) order by l.at desc)
                             from public.ops_tuning_log l where l.applied and l.at > now() - interval '7 days'), '[]'::jsonb),
      'proposals', coalesce((select jsonb_agg(x) from (
                               select jsonb_build_object('at', l.at, 'key', l.key, 'new', l.new, 'why', left(l.why, 200), 'actor', l.actor, 'refused_why', l.refused_why) x
                                 from public.ops_tuning_log l where not l.applied and l.at > now() - interval '7 days'
                                order by l.at desc limit 10) y), '[]'::jsonb)));
end $$;
revoke execute on function public.ops_growth(text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_growth(text, jsonb) to anon, service_role;

-- Facts for the watcher's reflexes, asked only during a serious incident the
-- agent cannot start for, at most every ten minutes. Read-only; no query
-- text ever leaves the database. Gives up after 5 seconds so it cannot add
-- to the trouble it is looking at.
create or replace function public.ops_reflex_facts(p_secret text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer
set search_path = '' set statement_timeout = '5s' as $$
declare
  v_max bigint;
  v_jobs jsonb;
  v_queries jsonb;
  v_ai jsonb;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  select max(runid) into v_max from cron.job_run_details;

  -- database jobs running right now (their process must still be alive),
  -- with how long each usually takes
  select coalesce(jsonb_agg(jsonb_build_object('name', j.jobname, 'pid', r.job_pid,
           'secs', round(extract(epoch from now() - r.start_time))::int,
           'usual_s', (select round((percentile_cont(0.5) within group (order by extract(epoch from x.end_time - x.start_time)))::numeric)::int
                         from (select d.start_time, d.end_time from cron.job_run_details d
                                where d.runid > v_max - 5000 and d.jobid = r.jobid and d.status = 'succeeded'
                                order by d.runid desc limit 20) x))), '[]'::jsonb)
    into v_jobs
    from cron.job_run_details r join cron.job j on j.jobid = r.jobid
   where r.runid > v_max - 500 and r.status = 'running'
     and exists (select 1 from pg_catalog.pg_stat_activity a where a.pid = r.job_pid and a.state = 'active');

  -- queries that have been running for more than 30 seconds
  select coalesce(jsonb_agg(q order by (q ->> 'secs')::int desc), '[]'::jsonb) into v_queries from (
    select jsonb_build_object('pid', a.pid, 'user', a.usename,
             'secs', round(extract(epoch from now() - a.query_start))::int,
             'is_cron', (a.application_name ilike 'pg_cron%'
                         or exists (select 1 from cron.job_run_details r where r.runid > v_max - 500 and r.status = 'running' and r.job_pid = a.pid))) q
      from pg_catalog.pg_stat_activity a
     where a.backend_type = 'client backend' and a.state = 'active' and a.pid <> pg_catalog.pg_backend_pid()
       and a.query_start < now() - interval '30 seconds'
     order by a.query_start limit 10) s;

  -- AI use in the last 15 minutes against the busiest 15 minutes of 4 weeks
  select jsonb_build_object(
    'tok_15m', (select coalesce(sum(coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)), 0)
                  from public.llm_usage where ts > now() - interval '15 minutes'),
    'base_15m', (select coalesce(max(tok_15m_max), 0) from public.ai_watch_baseline
                  where day > current_date - 28 and not coalesce(skip_peak, false)),
    'lockdown', coalesce((select max(lockdown_until) > now() from public.ai_guard_state), false)) into v_ai;

  return jsonb_build_object('ok', true, 'now', now(), 'jobs', v_jobs, 'queries', v_queries, 'ai', v_ai);
end $$;
revoke execute on function public.ops_reflex_facts(text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_reflex_facts(text, jsonb) to anon, service_role;

-- Saturday 23:20 UTC = Sunday 04:50 IST: the quietest hour of the week.
select cron.schedule('ops-consolidate', '20 23 * * 6',
  $c$SET statement_timeout = '60s'; SELECT public.ops_consolidate();$c$);
