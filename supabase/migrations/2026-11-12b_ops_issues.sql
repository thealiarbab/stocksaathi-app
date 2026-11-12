-- Ops watcher, database side (part 1 of 2): tables + what the outside
-- collector calls.
--
-- The collector (edge/ops-watch, on Cloudflare) receives every error report
-- and does the grouping and counting there. This database only gets:
--   * one cheap call a minute (ops_db_pulse): reads counters Postgres already
--     keeps in memory, plus scheduled-job runs since the last call;
--   * one small row per distinct problem (ops_issue_upsert).
-- No table scans. The raw error stream never enters Postgres.
--
-- Every function the collector calls is reachable with the public key but
-- checks the collector's own secret first (only its SHA-256 is stored here).
--
-- All tables are new and empty. Undo, if ever needed: remove the
-- 'collector_silent' block from ops_health_check(), then drop the ops_*
-- functions and tables created below (nothing else references them).

-- ───────────────────────── tables ─────────────────────────

create table if not exists public.ops_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- One row; the collector stamps it every minute. Unlogged: losing it in a
-- crash only delays the "collector silent" check by a minute.
create unlogged table if not exists public.ops_collector_seen (
  id boolean primary key default true check (id),
  at timestamptz,
  pulse_ms integer
);
insert into public.ops_collector_seen (id) values (true) on conflict do nothing;

create table if not exists public.ops_issues (
  id bigint generated always as identity primary key,
  fingerprint text not null unique,
  sig_version integer not null default 1,
  family bigint,
  source text not null check (source in ('server_py', 'server_js', 'browser', 'pulse', 'cron', 'db', 'vital', 'manual')),
  kind text,
  component text,
  title text not null,
  status text not null default 'open'
    check (status in ('open', 'fixing', 'fix_live', 'fixed', 'needs_owner', 'needs_pc', 'ignored', 'regressed')),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  trusted boolean not null default false,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  hits bigint not null default 1,
  people integer not null default 0,
  evidence jsonb,
  suspects jsonb,
  deploy_at_first_seen text,
  cause text,
  prompt text,
  fix_commit text,
  fix_deploy text,
  fix_note text,
  fixed_at timestamptz,
  claimed_by text,
  lease_until timestamptz,
  approval jsonb,
  muted_until timestamptz,
  mute_reason text,
  reopened_count integer not null default 0,
  failed_attempts integer not null default 0,
  last_alert_at timestamptz,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  status_changed_at timestamptz not null default now(),
  status_changed_by text not null default 'collector',
  updated_at timestamptz not null default now()
);
create index if not exists ops_issues_status on public.ops_issues (status, severity);
create index if not exists ops_issues_changed on public.ops_issues (status_changed_at);
create index if not exists ops_issues_component on public.ops_issues (component);

-- What happened, in order. Append-only: the ground truth everything else can
-- be rebuilt from.
create table if not exists public.ops_timeline (
  id bigint generated always as identity primary key,
  issue_id bigint references public.ops_issues (id),
  at timestamptz not null default now(),
  actor text not null check (actor in ('collector', 'cloud_fixer', 'pc_fixer', 'owner', 'db', 'review')),
  kind text not null,
  detail jsonb
);
create index if not exists ops_timeline_issue on public.ops_timeline (issue_id, at);
create index if not exists ops_timeline_kind on public.ops_timeline (kind, at);

-- Change ledger: every deploy, migration, scheduled-job change, env change
-- and fixer change. A new issue gets "suspects" from here.
create table if not exists public.ops_changes (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('deploy', 'migration', 'cron', 'env', 'function', 'flag', 'fix', 'revert', 'manual')),
  component text,
  ref text,
  summary text not null,
  actor text not null default 'db',
  detail jsonb,
  undo jsonb
);
create index if not exists ops_changes_at on public.ops_changes (at desc);
create unique index if not exists ops_changes_deploy on public.ops_changes (ref) where kind = 'deploy';

-- One row per fix attempt. The plan (hypothesis, undo, expected result) is
-- written before the change; the verdict is written afterwards by the
-- collector from its own counts.
create table if not exists public.ops_attempts (
  id bigint generated always as identity primary key,
  issue_id bigint not null references public.ops_issues (id),
  actor text not null check (actor in ('cloud_fixer', 'pc_fixer', 'owner', 'recipe')),
  started_at timestamptz not null default now(),
  hypothesis text not null check (length(trim(hypothesis)) >= 20),
  checked text,
  cases_used bigint[] not null default '{}',
  recipe_id bigint,
  change_kind text not null check (change_kind in (
    'rollback_deploy', 'pause_job', 'resume_job', 'cancel_query', 'set_flag',
    'code', 'config', 'sql_function', 'sql_index', 'sql_schema', 'sql_data', 'cron_change', 'other')),
  tier integer not null check (tier between 1 and 4),
  component text,
  undo jsonb not null,
  expected jsonb not null,
  before jsonb,
  live_at timestamptz,
  change_ref text,
  watch_ok_at timestamptz,
  after jsonb,
  verdict text check (verdict in ('held', 'no_effect', 'made_worse', 'reverted', 'abandoned')),
  verdict_at timestamptz,
  verdict_by text check (verdict_by in ('collector', 'owner', 'fixer')),
  verdict_note text,
  reverted_at timestamptz,
  came_back_at timestamptz
);
create index if not exists ops_attempts_issue on public.ops_attempts (issue_id, started_at);
create index if not exists ops_attempts_open on public.ops_attempts (live_at) where verdict is null;

-- The casebook: what was learned, one row per closed problem.
create table if not exists public.ops_cases (
  id bigint generated always as identity primary key,
  issue_id bigint references public.ops_issues (id),
  attempt_id bigint references public.ops_attempts (id),
  title text not null,
  symptom text not null,
  cause text not null,
  trigger_event text,
  fix text not null,
  dead_ends text,
  caught_sooner text,
  prevention text,
  added jsonb not null default '{}'::jsonb,
  component text,
  signatures text[] not null default '{}',
  files text[] not null default '{}',
  commit_ref text,
  confidence text not null default 'low' check (confidence in ('seeded', 'low', 'medium', 'high')),
  verified_how text,
  outcome text not null default 'pending' check (outcome in ('pending', 'held', 'did_not_hold', 'seeded')),
  confirmed integer not null default 0,
  contradicted integer not null default 0,
  superseded_by bigint,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by text not null default 'cloud_fixer',
  search tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(symptom, '') || ' ' || coalesce(cause, '') || ' ' ||
                           coalesce(fix, '') || ' ' || coalesce(component, '') || ' ' || coalesce(trigger_event, ''))) stored
);
create index if not exists ops_cases_search on public.ops_cases using gin (search);
create index if not exists ops_cases_component on public.ops_cases (component);

-- Pre-approved SQL a recipe may run by id (never free text).
create table if not exists public.ops_stored_sql (
  id bigint generated always as identity primary key,
  name text not null unique,
  purpose text not null,
  sql text not null,
  undo_sql text not null,
  approved_by text not null default 'owner',
  created_at timestamptz not null default now()
);

-- A fix that worked more than once, written as data: a match condition and
-- one action from a fixed list. No code, no free SQL.
create table if not exists public.ops_recipes (
  id bigint generated always as identity primary key,
  name text not null unique,
  match jsonb not null,
  action text not null check (action in ('rollback_deploy', 'pause_job', 'resume_job', 'cancel_long_query', 'set_flag', 'apply_stored_sql')),
  action_args jsonb not null default '{}'::jsonb,
  undo jsonb not null default '{}'::jsonb,
  guards jsonb not null default '{"max_per_day": 2}'::jsonb,
  case_ids bigint[] not null default '{}',
  stage text not null default 'shadow' check (stage in ('shadow', 'supervised', 'auto', 'retired')),
  uses integer not null default 0,
  held integer not null default 0,
  reverted integer not null default 0,
  shadow_hits integer not null default 0,
  shadow_agreed integer not null default 0,
  last_used timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_mutes (
  id bigint generated always as identity primary key,
  issue_id bigint not null references public.ops_issues (id),
  reason text not null check (length(trim(reason)) >= 8),
  who text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  lifted_at timestamptz,
  lifted_why text
);

alter table public.ops_config enable row level security;
alter table public.ops_collector_seen enable row level security;
alter table public.ops_issues enable row level security;
alter table public.ops_timeline enable row level security;
alter table public.ops_changes enable row level security;
alter table public.ops_attempts enable row level security;
alter table public.ops_cases enable row level security;
alter table public.ops_stored_sql enable row level security;
alter table public.ops_recipes enable row level security;
alter table public.ops_mutes enable row level security;
revoke all on public.ops_config, public.ops_collector_seen, public.ops_issues, public.ops_timeline, public.ops_changes,
              public.ops_attempts, public.ops_cases, public.ops_stored_sql, public.ops_recipes, public.ops_mutes
  from anon, authenticated;

insert into public.ops_config (key, value, updated_by) values
  ('freeze', '{"on": false}', 'db'),
  ('limits', '{"per_hour": 4, "per_day": 12, "max_failed_attempts": 3}', 'db')
on conflict (key) do nothing;

-- ───────────────────────── guards ─────────────────────────

-- The timeline cannot be edited or deleted, by anyone.
create or replace function public._ops_timeline_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'ops_timeline is append-only';
end $$;
revoke execute on function public._ops_timeline_frozen() from public, anon, authenticated;
create or replace trigger ops_timeline_frozen
  before update or delete on public.ops_timeline
  for each row execute function public._ops_timeline_frozen();
create or replace trigger ops_timeline_no_truncate
  before truncate on public.ops_timeline
  for each statement execute function public._ops_timeline_frozen();

-- An attempt's plan cannot be rewritten after the fact, and its verdict can
-- only be set through the verdict functions (which set ops.verdict_by).
create or replace function public._ops_attempt_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.hypothesis is distinct from old.hypothesis or new.expected is distinct from old.expected
     or new.undo is distinct from old.undo or new.tier is distinct from old.tier
     or new.change_kind is distinct from old.change_kind or new.issue_id is distinct from old.issue_id then
    raise exception 'an attempt''s plan (hypothesis, expected, undo, tier, kind) cannot be changed after it is written';
  end if;
  if (new.verdict is distinct from old.verdict or new.verdict_by is distinct from old.verdict_by
      or new.watch_ok_at is distinct from old.watch_ok_at)
     and coalesce(current_setting('ops.verdict_by', true), '') not in ('collector', 'owner', 'fixer') then
    raise exception 'a verdict is set by ops_attempt_verdict(), not by hand';
  end if;
  if new.verdict is distinct from old.verdict and old.verdict is not null and old.verdict <> 'held' then
    raise exception 'this attempt already has a verdict';
  end if;
  return new;
end $$;
revoke execute on function public._ops_attempt_guard() from public, anon, authenticated;
create or replace trigger ops_attempt_guard
  before update on public.ops_attempts
  for each row execute function public._ops_attempt_guard();

-- "Fixed" needs a written cause and either a verdict from the collector or
-- the owner saying so with a note. Every status change is stamped.
create or replace function public._ops_issue_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_actor text := coalesce(nullif(current_setting('ops.actor', true), ''), 'db');
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_at := now();
    new.status_changed_by := v_actor;
    if new.status = 'fixed' then
      if coalesce(trim(new.cause), '') = '' then
        raise exception 'issue % cannot be marked fixed without a written cause', new.id;
      end if;
      if v_actor = 'owner' then
        if coalesce(trim(new.fix_note), '') = '' then
          raise exception 'issue % needs a note to be marked fixed by hand', new.id;
        end if;
      elsif not exists (select 1 from public.ops_attempts a
                        where a.issue_id = new.id and a.verdict = 'held' and a.verdict_by = 'collector') then
        raise exception 'issue % cannot be marked fixed: no attempt has a "held" verdict from the collector', new.id;
      end if;
      new.fixed_at := coalesce(new.fixed_at, now());
      new.closed_at := now();
      new.claimed_by := null; new.lease_until := null;
    elsif new.status in ('open', 'regressed') then
      new.closed_at := null; new.fixed_at := null;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._ops_issue_guard() from public, anon, authenticated;
create or replace trigger ops_issue_guard
  before insert or update on public.ops_issues
  for each row execute function public._ops_issue_guard();

-- ───────────────────────── helpers ─────────────────────────

create or replace function public._ops_collector(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    length(p_secret) >= 32
    and encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
        = (select value #>> '{}' from public.ops_config where key = 'collector_secret_sha256'),
    false);
$$;
revoke execute on function public._ops_collector(text) from public, anon, authenticated;

create or replace function public._ops_log(p_issue bigint, p_actor text, p_kind text, p_detail jsonb default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.ops_timeline (issue_id, actor, kind, detail) values (p_issue, p_actor, p_kind, p_detail);
$$;
revoke execute on function public._ops_log(bigint, text, text, jsonb) from public, anon, authenticated;

-- Bell + push + e-mail to the owner accounts, through the path that already
-- works for ops alerts (notifications kind 'ops_alert'). Holds back a flood:
-- after 6 issue alerts in 15 minutes, one digest every 30 minutes instead
-- (critical ones always go out).
create or replace function public._ops_issue_notify(p_issue bigint, p_event text, p_title text, p_body text, p_force boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_recent integer;
begin
  select count(*) into v_recent from public.ops_timeline
   where kind = 'alert' and at > now() - interval '15 minutes';
  if v_recent >= 6 and not p_force then
    perform public._ops_log(p_issue, 'db', 'alert_held', jsonb_build_object('event', p_event, 'title', p_title));
    perform public._ops_notify('ops_issue_storm', interval '30 minutes', 'StockSaathi: many new issues at once',
      format('%s alerts went out in 15 minutes, so further ones are being held back. Open /a > Issues to see all of them.', v_recent));
    return false;
  end if;
  insert into public.notifications (user_id, kind, category, title, body, url)
  select u.id, 'ops_alert', 'account', left(p_title, 140), left(p_body, 1800), '/a'
  from (select user_id as id from public.admin_users
        union select '63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid
        union select '73c89104-24ab-47c0-9c71-5fe7c82323dc'::uuid) u
  where exists (select 1 from auth.users au where au.id = u.id);
  if p_issue is not null then
    update public.ops_issues set last_alert_at = now() where id = p_issue;
  end if;
  perform public._ops_log(p_issue, 'db', 'alert', jsonb_build_object('event', p_event, 'title', p_title));
  return true;
end $$;
revoke execute on function public._ops_issue_notify(bigint, text, text, text, boolean) from public, anon, authenticated;

-- ───────────────────────── collector: pulse ─────────────────────────

create or replace function public.ops_db_pulse(p_secret text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cron_cursor bigint := nullif(p ->> 'cron_cursor', '')::bigint;
  v_net_cursor bigint := nullif(p ->> 'net_cursor', '')::bigint;
  v_since timestamptz := nullif(p ->> 'since', '')::timestamptz;
  v_jobs jsonb; v_hash text; v_old jsonb; v_changed jsonb := '[]'::jsonb;
  v_runs jsonb; v_running jsonb; v_block bigint; v_max_run bigint;
  v_fails jsonb; v_max_net bigint;
  v_conns integer; v_active integer; v_longest numeric; v_longest_q text;
  v_db record; v_issues jsonb; v_watches jsonb;
  r record;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  update public.ops_collector_seen set at = now(), pulse_ms = nullif(p ->> 'ms', '')::integer where id;

  -- Scheduled jobs: the list, and whether it changed since last minute.
  select coalesce(jsonb_agg(jsonb_build_object('id', jobid, 'name', coalesce(jobname, 'job ' || jobid),
           'schedule', schedule, 'active', active, 'cmd', md5(command)) order by jobid), '[]'::jsonb)
    into v_jobs from cron.job;
  v_hash := md5(v_jobs::text);
  select value into v_old from public.ops_config where key = 'cron_snapshot';
  if v_old is null then
    insert into public.ops_config (key, value, updated_by) values ('cron_snapshot', jsonb_build_object('hash', v_hash, 'jobs', v_jobs), 'db')
    on conflict (key) do nothing;
  elsif v_old ->> 'hash' is distinct from v_hash then
    for r in
      select coalesce(n.j ->> 'name', o.j ->> 'name') as job,
             case when n.j is null then 'removed'
                  when o.j is null then 'added'
                  when (o.j ->> 'active')::boolean and not (n.j ->> 'active')::boolean then 'deactivated'
                  when not (o.j ->> 'active')::boolean and (n.j ->> 'active')::boolean then 'activated'
                  when o.j ->> 'schedule' is distinct from n.j ->> 'schedule' then 'schedule'
                  when o.j ->> 'cmd' is distinct from n.j ->> 'cmd' then 'command'
                  else 'same' end as what,
             o.j ->> 'schedule' as old_schedule, n.j ->> 'schedule' as new_schedule
      from jsonb_array_elements(v_old -> 'jobs') o(j)
      full join jsonb_array_elements(v_jobs) n(j) on (o.j ->> 'id') = (n.j ->> 'id')
    loop
      if r.what <> 'same' then
        v_changed := v_changed || jsonb_build_object('job', r.job, 'what', r.what, 'from', r.old_schedule, 'to', r.new_schedule);
        insert into public.ops_changes (kind, component, ref, summary, actor, detail)
        values ('cron', r.job, r.job,
                format('Scheduled job %s: %s%s', r.job, r.what,
                       case when r.what = 'schedule' then format(' (%s -> %s)', r.old_schedule, r.new_schedule) else '' end),
                'db', jsonb_build_object('what', r.what, 'from', r.old_schedule, 'to', r.new_schedule));
      end if;
    end loop;
    update public.ops_config set value = jsonb_build_object('hash', v_hash, 'jobs', v_jobs), updated_at = now(), updated_by = 'db'
     where key = 'cron_snapshot';
  end if;

  -- Job runs since the cursor (primary-key range, a handful of rows a minute).
  -- Stops short of a run that is still going, so its result is not missed.
  if v_cron_cursor is null then
    select coalesce(max(runid), 0) - 300 into v_cron_cursor from cron.job_run_details;
  end if;
  select min(runid) into v_block from cron.job_run_details
   where runid > v_cron_cursor and status not in ('succeeded', 'failed')
     and coalesce(start_time, now()) > now() - interval '15 minutes';
  select coalesce(jsonb_agg(x order by (x ->> 'id')::bigint), '[]'::jsonb), max((x ->> 'id')::bigint)
    into v_runs, v_max_run
  from (select jsonb_build_object('id', runid, 'job', jobid, 'status', status, 'start', start_time,
                 'msg', case when status = 'failed' then left(return_message, 300) end) as x
          from cron.job_run_details
         where runid > v_cron_cursor and status in ('succeeded', 'failed')
           and (v_block is null or runid < v_block)
         order by runid limit 400) s;
  select coalesce(jsonb_agg(jsonb_build_object('job', jobid, 'start', start_time)), '[]'::jsonb) into v_running
    from cron.job_run_details
   where runid > v_cron_cursor and status not in ('succeeded', 'failed') and start_time > now() - interval '15 minutes';

  -- Calls the database itself made (order matcher, push, alert mail) that failed.
  if v_net_cursor is null then
    select coalesce(max(id), 0) into v_net_cursor from net._http_response;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status_code, 'timed_out', timed_out, 'err', left(error_msg, 200)) order by id)
                    filter (where timed_out or error_msg is not null or status_code is null or status_code >= 400), '[]'::jsonb),
         max(id)
    into v_fails, v_max_net
    from net._http_response where id > v_net_cursor;

  -- Numbers Postgres already keeps in memory.
  select count(*), count(*) filter (where state = 'active' and pid <> pg_backend_pid())
    into v_conns, v_active from pg_stat_activity where datname = current_database();
  select extract(epoch from now() - query_start), left(query, 160) into v_longest, v_longest_q
    from pg_stat_activity
   where datname = current_database() and state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid()
   order by query_start limit 1;
  select deadlocks, blks_hit, blks_read, xact_commit, temp_files into v_db
    from pg_stat_database where datname = current_database();

  -- Mutes that ran out go back to open.
  for r in select id from public.ops_issues where status = 'ignored' and muted_until is not null and muted_until < now() loop
    perform set_config('ops.actor', 'db', true);
    update public.ops_issues set status = 'open', muted_until = null where id = r.id;
    update public.ops_mutes set lifted_at = now(), lifted_why = 'expired' where issue_id = r.id and lifted_at is null;
    perform public._ops_log(r.id, 'db', 'mute_expired', null);
  end loop;
  -- A fixer that stopped without letting go: release its claim.
  for r in select id, claimed_by from public.ops_issues where status = 'fixing' and lease_until < now() loop
    perform set_config('ops.actor', 'db', true);
    update public.ops_issues set status = 'open', claimed_by = null, lease_until = null where id = r.id;
    perform public._ops_log(r.id, 'db', 'lease_expired', jsonb_build_object('was', r.claimed_by));
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'fp', fingerprint, 'status', status, 'fixed_at', fixed_at, 'fix_deploy', fix_deploy)), '[]'::jsonb)
    into v_issues
    from (select id, fingerprint, status, fixed_at, fix_deploy from public.ops_issues
           where v_since is not null and status_changed_at > v_since - interval '5 seconds' and status_changed_by <> 'collector'
           order by status_changed_at limit 50) i;
  select coalesce(jsonb_agg(jsonb_build_object('attempt_id', a.id, 'issue_id', a.issue_id, 'fp', i.fingerprint,
                    'live_at', a.live_at, 'change_ref', a.change_ref, 'expected', a.expected)), '[]'::jsonb)
    into v_watches
    from public.ops_attempts a join public.ops_issues i on i.id = a.issue_id
   where a.live_at is not null and a.verdict is null and a.live_at > now() - interval '21 days';

  return jsonb_build_object(
    'ok', true, 'now', now(),
    'max_conn', current_setting('max_connections')::integer,
    'conns', v_conns, 'active', v_active,
    'longest_s', coalesce(round(v_longest), 0), 'longest_q', v_longest_q,
    'dead', v_db.deadlocks, 'hit', v_db.blks_hit, 'read', v_db.blks_read, 'commits', v_db.xact_commit, 'temp', v_db.temp_files,
    'ins', jsonb_build_object(
      'signups', pg_stat_get_tuples_inserted('auth.users'::regclass),
      'trades', pg_stat_get_tuples_inserted('public.transactions'::regclass),
      'views', pg_stat_get_tuples_inserted('public.web_events'::regclass),
      'actions', pg_stat_get_tuples_inserted('public.user_events'::regclass),
      'ai', pg_stat_get_tuples_inserted('public.llm_usage'::regclass)),
    'cron', jsonb_build_object('jobs', v_jobs, 'runs', v_runs, 'running', v_running,
                               'cursor', coalesce(v_max_run, v_cron_cursor), 'changed', v_changed),
    'net', jsonb_build_object('cursor', coalesce(v_max_net, v_net_cursor), 'fails', v_fails),
    'issues', v_issues, 'watches', v_watches,
    'freeze', coalesce((select (value ->> 'on')::boolean from public.ops_config where key = 'freeze'), false));
end $$;
revoke execute on function public.ops_db_pulse(text, jsonb) from public, authenticated;
grant execute on function public.ops_db_pulse(text, jsonb) to anon;

-- ───────────────────────── collector: issues ─────────────────────────

create or replace function public.ops_issue_upsert(p_secret text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event text := coalesce(p ->> 'event', 'open');
  v_fp text := p ->> 'fingerprint';
  v record;
  v_id bigint; v_status text; v_new boolean := false; v_notified boolean := false;
  v_suspects jsonb; v_first timestamptz; v_title text; v_body text; v_why text;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  v_fp := coalesce(v_fp, p ->> 'fp');
  if coalesce(v_fp, '') = '' or coalesce(p ->> 'title', '') = '' then
    return jsonb_build_object('ok', false, 'why', 'missing fp or title');
  end if;
  v_first := coalesce(nullif(p ->> 'first_seen', '')::timestamptz, now());
  perform set_config('ops.actor', 'collector', true);

  select * into v from public.ops_issues where fingerprint = v_fp for update;
  if not found then
    -- What changed shortly before this first appeared?
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'at', c.at, 'kind', c.kind, 'component', c.component, 'ref', c.ref,
                       'summary', c.summary, 'minutes_before', round(extract(epoch from v_first - c.at) / 60)) order by c.rank), '[]'::jsonb)
      into v_suspects
      from (select ch.*, row_number() over (order by (ch.component is not distinct from p ->> 'component') desc, ch.at desc) as rank
              from public.ops_changes ch
             where ch.at between v_first - interval '6 hours' and v_first + interval '2 minutes'
             order by rank limit 8) c;
    insert into public.ops_issues (fingerprint, sig_version, source, kind, component, title, severity, trusted,
                                   first_seen, last_seen, hits, people, evidence, suspects, deploy_at_first_seen)
    values (v_fp, coalesce((p ->> 'sig_version')::integer, 1), p ->> 'source', p ->> 'kind', p ->> 'component',
            left(p ->> 'title', 200), coalesce(p ->> 'severity', 'medium'), coalesce((p ->> 'trusted')::boolean, false),
            v_first, coalesce(nullif(p ->> 'last_seen', '')::timestamptz, now()),
            coalesce((p ->> 'hits')::bigint, 1), coalesce((p ->> 'people')::integer, 0),
            p -> 'evidence', v_suspects, p ->> 'deploy')
    returning id, status into v_id, v_status;
    v_new := true;
    perform public._ops_log(v_id, 'collector', 'opened', jsonb_build_object('event', v_event, 'hits', p -> 'hits', 'people', p -> 'people'));
  else
    v_id := v.id; v_status := v.status;
    update public.ops_issues
       set last_seen = greatest(last_seen, coalesce(nullif(p ->> 'last_seen', '')::timestamptz, now())),
           hits = greatest(hits, coalesce((p ->> 'hits')::bigint, hits)),
           people = greatest(people, coalesce((p ->> 'people')::integer, people)),
           evidence = coalesce(p -> 'evidence', evidence)
     where id = v_id;
    if v.status = 'fixed' and v_event in ('open', 'regress') then
      v_event := 'regress';
    elsif v.status = 'ignored' and v_event <> 'unmute' then
      return jsonb_build_object('ok', true, 'id', v_id, 'status', v_status, 'notified', false);
    elsif v_event = 'open' then
      return jsonb_build_object('ok', true, 'id', v_id, 'status', v_status, 'notified', false);
    end if;
    if v_event = 'regress' then
      update public.ops_issues set status = 'regressed', reopened_count = reopened_count + 1,
             claimed_by = null, lease_until = null where id = v_id returning status into v_status;
      -- The fix that was believed to have held did not: count it against the record.
      update public.ops_attempts set came_back_at = now()
       where id = (select id from public.ops_attempts where issue_id = v_id and verdict = 'held' order by verdict_at desc limit 1);
      update public.ops_cases set outcome = 'did_not_hold', contradicted = contradicted + 1
       where issue_id = v_id and outcome = 'held';
    elsif v_event = 'unmute' then
      update public.ops_issues set status = 'open', muted_until = null where id = v_id returning status into v_status;
      update public.ops_mutes set lifted_at = now(), lifted_why = 'grew tenfold' where issue_id = v_id and lifted_at is null;
    end if;
    perform public._ops_log(v_id, 'collector', v_event, jsonb_build_object('hits', p -> 'hits', 'people', p -> 'people', 'today', p -> 'evidence' -> 'today'));
  end if;

  v_why := case v_event
    when 'open' then 'New problem'
    when 'regress' then 'Came back after being fixed'
    when 'spike' then 'Far above its own worst day'
    when 'spread' then 'Now reaching many more people'
    when 'unmute' then 'Ignored problem grew tenfold, un-ignored'
    else v_event end;
  v_title := format('StockSaathi issue #%s: %s', v_id, p ->> 'title');
  v_body := format(E'%s. Seen %s time(s)%s. Source: %s%s.%s\n\nOpen /a > Issues for the evidence.',
    v_why, coalesce(p ->> 'hits', '1'),
    case when coalesce((p ->> 'people')::integer, 0) > 0 then format(' by %s people', p ->> 'people') else '' end,
    p ->> 'source', case when p ->> 'component' is not null then ' ' || (p ->> 'component') else '' end,
    case when v_new and jsonb_array_length(coalesce(v_suspects, '[]'::jsonb)) > 0
         then format(E'\n\nChanged shortly before: %s (%s min earlier).', v_suspects -> 0 ->> 'summary', v_suspects -> 0 ->> 'minutes_before')
         else '' end);
  v_notified := public._ops_issue_notify(v_id, v_event, v_title, v_body, coalesce(p ->> 'severity', '') = 'critical');
  return jsonb_build_object('ok', true, 'id', v_id, 'status', v_status, 'notified', v_notified, 'new', v_new);
end $$;
revoke execute on function public.ops_issue_upsert(text, jsonb) from public, authenticated;
grant execute on function public.ops_issue_upsert(text, jsonb) to anon;

-- Counts of open issues that moved (at most every 10 minutes per issue).
create or replace function public.ops_issues_sync(p_secret text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  update public.ops_issues i
     set hits = greatest(i.hits, (x ->> 'hits')::bigint),
         people = greatest(i.people, (x ->> 'people')::integer),
         last_seen = greatest(i.last_seen, (x ->> 'last_seen')::timestamptz)
    from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) x
   where i.fingerprint = x ->> 'fp';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'rows', n);
end $$;
revoke execute on function public.ops_issues_sync(text, jsonb) from public, authenticated;
grant execute on function public.ops_issues_sync(text, jsonb) to anon;

-- A note on an existing issue (an outage ended).
create or replace function public.ops_issue_note(p_secret text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint; v_title text;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  select id, title into v_id, v_title from public.ops_issues where fingerprint = p ->> 'fp';
  if v_id is null then
    return jsonb_build_object('ok', true, 'found', false);
  end if;
  perform public._ops_log(v_id, 'collector', coalesce(p ->> 'event', 'note'), jsonb_build_object('note', p ->> 'note'));
  if p ->> 'event' = 'recovered' then
    perform public._ops_issue_notify(v_id, 'recovered', format('StockSaathi issue #%s recovered', v_id),
      format(E'%s\n\n%s\n\nThe issue stays open until its cause is found.', v_title, p ->> 'note'), true);
  end if;
  return jsonb_build_object('ok', true, 'found', true, 'id', v_id);
end $$;
revoke execute on function public.ops_issue_note(text, jsonb) from public, authenticated;
grant execute on function public.ops_issue_note(text, jsonb) to anon;

-- A build the collector saw serving traffic for the first time.
create or replace function public.ops_change_note(p_secret text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  if p ->> 'kind' = 'deploy' and coalesce(p ->> 'ref', '') <> '' then
    insert into public.ops_changes (at, kind, component, ref, summary, actor)
    values (coalesce(nullif(p ->> 'at', '')::timestamptz, now()), 'deploy', 'site', left(p ->> 'ref', 40),
            left(coalesce(p ->> 'summary', 'New build'), 300), 'collector')
    on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.ops_change_note(text, jsonb) from public, authenticated;
grant execute on function public.ops_change_note(text, jsonb) to anon;

-- ───────────────────── the database watches the collector ─────────────────────
-- Adds one check to ops_health_check() without touching the existing six:
-- the stored definition is taken as it is and one block is inserted before
-- the loop that fires alerts.
do $$
declare
  d text;
  marker text := E'  for c in select x->>''name'' as name';
begin
  select pg_get_functiondef('public.ops_health_check()'::regprocedure) into d;
  if position('collector_silent' in d) = 0 then
    if position(marker in d) = 0 then
      raise exception 'ops_health_check() does not look as expected; collector_silent check not added';
    end if;
    d := replace(d, marker,
      E'  checks := checks || jsonb_build_object(''name'', ''collector_silent'',\n' ||
      E'    ''failing'', coalesce((select at < now() - interval ''10 minutes'' from public.ops_collector_seen), false),\n' ||
      E'    ''detail'', format(''the outside watcher last reached the database at %s; errors are not being collected'',\n' ||
      E'      coalesce((select to_char(at at time zone ''Asia/Kolkata'', ''DD Mon HH24:MI IST'') from public.ops_collector_seen), ''never'')));\n\n' ||
      marker);
    execute d;
  end if;
end $$;
