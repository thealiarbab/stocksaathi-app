-- Ops agent memory, part 1 of 2: tables, the text scrubber, the embedding
-- plumbing and the import calls. Search and the agent's own calls are in
-- 2026-11-15b. Everything is service-role only unless it checks the
-- collector's secret itself.

create extension if not exists vector with schema extensions;

-- ───────────────────────── nothing personal in memory ─────────────────────────
-- Runs on every text that enters memory: e-mail addresses, keys and tokens,
-- user ids, IP addresses and phone numbers are replaced by a tag.
create or replace function public._ops_scrub(t text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(t,
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
    'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{4,})?', '[token]', 'g'),
    '\m(sk|pk|rk|gsk|sbp|ghp|gho|ghs|whsec)_[A-Za-z0-9_-]{20,}|\msk-[A-Za-z0-9_-]{20,}|\mre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}|\mxox[abp]-[A-Za-z0-9-]{20,}|\mAIza[A-Za-z0-9_-]{30,}', '[token]', 'g'),
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '[id]', 'g'),
    '\m[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\M', '[ip]', 'g'),
    '(\+91[ -]?)?\m[6-9][0-9]{9}\M', '[phone]', 'g'),
    '\m[A-Za-z0-9_-]{48,}\M', '[token]', 'g')
$$;
revoke execute on function public._ops_scrub(text) from public, anon, authenticated;

-- ───────────────────────── tables ─────────────────────────

-- Cards: the casebook already exists. A card now also says which part of the
-- product it is about, what was SEEN that proves the cause, and which raw
-- item it was written from.
alter table public.ops_cases
  add column if not exists area text,
  add column if not exists evidence text,
  add column if not exists raw_id bigint;
alter table public.ops_cases alter column search set expression as (
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(symptom, '') || ' ' || coalesce(cause, '') || ' ' ||
                         coalesce(fix, '') || ' ' || coalesce(component, '') || ' ' || coalesce(trigger_event, '') || ' ' ||
                         coalesce(dead_ends, '') || ' ' || coalesce(evidence, '')));

-- History as it was written at the time: fix commits, session notes, audit
-- documents, the owner's standing rules. Searchable as it is; an item
-- becomes a card the first time it is needed.
create table if not exists public.ops_raw (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('commit', 'note', 'audit', 'rule')),
  ref text not null,
  title text not null,
  body text not null,
  area text,
  files text[] not null default '{}',
  occurred_at timestamptz,
  weight real not null default 0,
  card_id bigint references public.ops_cases (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) stored,
  unique (kind, ref)
);
create index if not exists ops_raw_search on public.ops_raw using gin (search);
create index if not exists ops_raw_weight on public.ops_raw (weight desc) where card_id is null;

-- Episodes: one row per run of the agent. The collector opens it when it
-- starts the agent; the agent closes it with what it decided, per issue.
create table if not exists public.ops_episodes (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  run_ref text,
  mode text,
  issue_ids bigint[] not null default '{}',
  decisions jsonb not null default '[]'::jsonb,
  summary text,
  changed text,
  dead_ends text,
  case_ids bigint[] not null default '{}',
  limits jsonb,
  actor text not null default 'cloud_fixer',
  search tsvector generated always as (to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(dead_ends, '') || ' ' || coalesce(changed, ''))) stored
);
create index if not exists ops_episodes_at on public.ops_episodes (started_at desc);
create index if not exists ops_episodes_search on public.ops_episodes using gin (search);

-- Lessons: what several cases taught. Confidence rises when a lesson helped
-- and falls when it misled.
create table if not exists public.ops_lessons (
  id bigint generated always as identity primary key,
  lesson text not null,
  why text,
  evidence jsonb not null default '{}'::jsonb,
  area text,
  confidence real not null default 0.5 check (confidence between 0 and 1),
  helped integer not null default 0,
  misled integer not null default 0,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by text not null default 'cloud_fixer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', coalesce(lesson, '') || ' ' || coalesce(why, ''))) stored
);
create index if not exists ops_lessons_search on public.ops_lessons using gin (search);

-- Skills: step lists for fixes that repeat. They are text for the agent to
-- follow inside the safety loop, never something the database runs.
create table if not exists public.ops_skills (
  id bigint generated always as identity primary key,
  name text not null unique,
  when_to_use text not null,
  steps jsonb not null,
  undo text,
  area text,
  component text,
  case_ids bigint[] not null default '{}',
  uses integer not null default 0,
  held integer not null default 0,
  bad integer not null default 0,
  bad_streak integer not null default 0,
  stage text not null default 'draft' check (stage in ('draft', 'supervised', 'trusted', 'suspended')),
  last_used timestamptz,
  created_by text not null default 'cloud_fixer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(when_to_use, '') || ' ' || coalesce(steps::text, ''))) stored
);
create index if not exists ops_skills_search on public.ops_skills using gin (search);

-- System map: what each part is, what it depends on, where its logs are and
-- where it has broken before.
create table if not exists public.ops_system_map (
  id bigint generated always as identity primary key,
  component text not null unique,
  what text not null,
  depends_on text[] not null default '{}',
  logs text,
  weak_spots text,
  files text[] not null default '{}',
  area text,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'review',
  search tsvector generated always as (to_tsvector('english', coalesce(component, '') || ' ' || coalesce(what, '') || ' ' || coalesce(weak_spots, ''))) stored
);

-- Site profile: what normal looks like. One row per hour of history (India
-- time), and from those the usual range for each weekday and hour.
create table if not exists public.ops_site_hourly (
  hour_ist timestamp primary key,
  signups integer not null default 0,
  trades integer not null default 0,
  views integer not null default 0,
  visits integer
);
create table if not exists public.ops_site_profile (
  metric text not null,
  dow smallint not null,
  hour smallint not null,
  n integer not null,
  p10 real not null,
  median real not null,
  p90 real not null,
  updated_at timestamptz not null default now(),
  primary key (metric, dow, hour)
);

-- Free-text questions asked of memory, kept so their vector is made once.
create table if not exists public.ops_queries (
  id bigint generated always as identity primary key,
  q_hash text not null unique,
  q text not null,
  asked_at timestamptz not null default now(),
  hits integer not null default 1
);

-- One vector per remembered thing, beside the md5 of the text it was made
-- from. Kept apart from the rows so nothing that returns a whole row ever
-- carries 384 numbers along.
create table if not exists public.ops_vectors (
  t text not null check (t in ('query', 'issue', 'case', 'lesson', 'skill', 'map', 'episode', 'raw')),
  id bigint not null,
  embedding extensions.vector(384),
  text_md5 text,
  embedded_at timestamptz,
  primary key (t, id)
);

alter table public.ops_raw enable row level security;
alter table public.ops_episodes enable row level security;
alter table public.ops_lessons enable row level security;
alter table public.ops_skills enable row level security;
alter table public.ops_system_map enable row level security;
alter table public.ops_site_hourly enable row level security;
alter table public.ops_site_profile enable row level security;
alter table public.ops_queries enable row level security;
alter table public.ops_vectors enable row level security;
revoke all on public.ops_raw, public.ops_episodes, public.ops_lessons, public.ops_skills, public.ops_system_map,
              public.ops_site_hourly, public.ops_site_profile, public.ops_queries, public.ops_vectors from anon, authenticated;

-- ───────────────────────── embeddings ─────────────────────────
-- The text each thing is remembered by. A vector is out of date when the
-- md5 stored beside it no longer matches this text.
create or replace view public.ops_embed_source with (security_invoker = true) as
  select 'query'::text as t, 0 as pri, q.id, left(q.q, 1500) as txt from public.ops_queries q
  union all
  select 'issue', 1, i.id, left(i.title || '. ' || coalesce(i.component, '') || ' ' || coalesce(i.kind, '') || '. ' || coalesce(i.cause, ''), 1500)
    from public.ops_issues i
  union all
  select 'case', 2, c.id, left(c.title || '. ' || c.symptom || ' ' || c.cause || ' ' || c.fix, 1500) from public.ops_cases c
  union all
  select 'lesson', 3, l.id, left(l.lesson || ' ' || coalesce(l.why, ''), 1500) from public.ops_lessons l
  union all
  select 'skill', 3, s.id, left(s.name || '. ' || s.when_to_use, 1500) from public.ops_skills s
  union all
  select 'map', 4, m.id, left(m.component || ': ' || m.what || ' ' || coalesce(m.weak_spots, ''), 1500) from public.ops_system_map m
  union all
  select 'episode', 5, e.id, left(coalesce(e.summary, '') || ' ' || coalesce(e.dead_ends, ''), 1500) from public.ops_episodes e where e.ended_at is not null
  union all
  select 'raw', 6, r.id, left(r.title || '. ' || r.body, 1500) from public.ops_raw r;
revoke all on public.ops_embed_source from anon, authenticated;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ops_embed_secret', 'Bearer for the ops-embed edge function')
 where not exists (select 1 from vault.secrets where name = 'ops_embed_secret');

-- Called by the edge function (service role) to check who is asking: the
-- database itself (Vault secret) or the owner's import script (collector secret).
create or replace function public.ops_embed_auth(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_secret) >= 32 and (
    p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'ops_embed_secret')
    or public._ops_collector(p_secret)), false);
$$;
revoke execute on function public.ops_embed_auth(text) from public, anon, authenticated;
grant execute on function public.ops_embed_auth(text) to service_role;

create or replace function public.ops_embed_pull(p_n integer default 16) returns jsonb
language sql stable security definer set search_path = '' as $$
  with todo as (
    select s.t, s.pri, s.id, s.txt, md5(s.txt) as h
      from public.ops_embed_source s
      left join public.ops_vectors v on v.t = s.t and v.id = s.id
     where length(btrim(s.txt)) > 3 and (v.embedding is null or v.text_md5 is distinct from md5(s.txt)))
  select jsonb_build_object(
    'remaining', (select count(*) from todo),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('t', t, 'id', id, 'h', h, 'x', txt))
                        from (select * from todo order by pri, id limit least(greatest(p_n, 1), 48)) x), '[]'::jsonb));
$$;
revoke execute on function public.ops_embed_pull(integer) from public, anon, authenticated;
grant execute on function public.ops_embed_pull(integer) to service_role;

create or replace function public.ops_embed_push(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.ops_vectors (t, id, embedding, text_md5, embedded_at)
  select x ->> 't', (x ->> 'id')::bigint, (x ->> 'e')::extensions.vector(384), x ->> 'h', now()
    from jsonb_array_elements(p) x
   where jsonb_typeof(x -> 'e') = 'array' and jsonb_array_length(x -> 'e') = 384
  on conflict (t, id) do update set embedding = excluded.embedding, text_md5 = excluded.text_md5, embedded_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.ops_embed_push(jsonb) from public, anon, authenticated;
grant execute on function public.ops_embed_push(jsonb) to service_role;

-- Tells the edge function there is new text. Sent after the transaction
-- commits; a failure here never blocks the write that caused it.
create or replace function public._ops_embed_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ops_embed_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://hwlmwraowcylxzdpumca.supabase.co/functions/v1/ops-embed',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('op', 'sweep'),
    timeout_milliseconds := 20000);
exception when others then
  return;
end $$;
revoke execute on function public._ops_embed_kick() from public, anon, authenticated;

create or replace function public._ops_embed_poke() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public._ops_embed_kick();
  return null;
end $$;
revoke execute on function public._ops_embed_poke() from public, anon, authenticated;

create or replace trigger ops_cases_embed after insert or update of title, symptom, cause, fix on public.ops_cases
  for each statement execute function public._ops_embed_poke();
create or replace trigger ops_lessons_embed after insert or update of lesson, why on public.ops_lessons
  for each statement execute function public._ops_embed_poke();
create or replace trigger ops_skills_embed after insert or update of name, when_to_use on public.ops_skills
  for each statement execute function public._ops_embed_poke();
create or replace trigger ops_map_embed after insert or update of what, weak_spots on public.ops_system_map
  for each statement execute function public._ops_embed_poke();
create or replace trigger ops_episodes_embed after update of summary on public.ops_episodes
  for each statement execute function public._ops_embed_poke();
create or replace trigger ops_issues_embed after insert on public.ops_issues
  for each statement execute function public._ops_embed_poke();

-- ───────────────────────── import (the owner's script) ─────────────────────────
-- Zero model tokens: the script reads git history, the session notes and the
-- audit documents on the owner's PC and sends them here in batches.
create or replace function public.ops_raw_import(p_secret text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; v_scrubbed integer := 0;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  select count(*) into v_scrubbed from jsonb_array_elements(p) x
   where public._ops_scrub(x ->> 'body') is distinct from (x ->> 'body') or public._ops_scrub(x ->> 'title') is distinct from (x ->> 'title');
  insert into public.ops_raw (kind, ref, title, body, area, files, occurred_at, weight)
  select x ->> 'kind', left(x ->> 'ref', 200), left(public._ops_scrub(x ->> 'title'), 300), left(public._ops_scrub(x ->> 'body'), 6000),
         nullif(x ->> 'area', ''),
         coalesce((select array_agg(left(f, 200)) from jsonb_array_elements_text(coalesce(x -> 'files', '[]'::jsonb)) f), '{}'),
         nullif(x ->> 'at', '')::timestamptz, coalesce((x ->> 'weight')::real, 0)
    from jsonb_array_elements(p) x
   where coalesce(x ->> 'ref', '') <> '' and coalesce(x ->> 'title', '') <> '' and coalesce(x ->> 'body', '') <> ''
  on conflict (kind, ref) do update
     set title = excluded.title, body = excluded.body, area = excluded.area, files = excluded.files,
         occurred_at = excluded.occurred_at, weight = excluded.weight, updated_at = now()
   where (public.ops_raw.title, public.ops_raw.body, public.ops_raw.weight) is distinct from (excluded.title, excluded.body, excluded.weight);
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'written', n, 'scrubbed_here', v_scrubbed);
end $$;
revoke execute on function public.ops_raw_import(text, jsonb) from public, authenticated;
grant execute on function public.ops_raw_import(text, jsonb) to anon;

-- Counts and one fingerprint, so the script can check both sides hold the
-- same items without reading them back.
create or replace function public.ops_raw_stats(p_secret text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true,
    'count', (select count(*) from public.ops_raw),
    'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from public.ops_raw group by 1) k),
    'fingerprint', (select md5(coalesce(string_agg(kind || '|' || ref, ',' order by kind, ref), '')) from public.ops_raw),
    'made_into_cards', (select count(*) from public.ops_raw where card_id is not null),
    'vectors', (select coalesce(jsonb_object_agg(t, n), '{}'::jsonb) from (select t, count(*) n from public.ops_vectors where embedding is not null group by 1) v),
    'waiting_for_vector', (public.ops_embed_pull(1) ->> 'remaining')::integer);
end $$;
revoke execute on function public.ops_raw_stats(text, jsonb) from public, authenticated;
grant execute on function public.ops_raw_stats(text, jsonb) to anon;
