-- Ops agent, phase 3 (senses).
--   1. One permanent test account for the outside journey robot, marked as a
--      test account. It is dated 2020 so it never falls inside a sign-up,
--      cohort or funnel window, and it gets no e-mail.
--   2. Funnels by source (visitor -> register -> account -> first trade), one
--      row per day and source, built once a night.
--   3. Returning users (day 1, 7, 30) per sign-up week, built once a week.
--   4. ops_senses(): the small read the outside watcher makes.
-- No DROP / DELETE. Every function: search_path set, EXECUTE revoked.

create table if not exists public.ops_test_accounts (
  uid uuid primary key,
  note text not null default '',
  created_at timestamptz not null default now()
);
alter table public.ops_test_accounts enable row level security;
revoke all on public.ops_test_accounts from public, anon, authenticated;

create or replace function public.is_test_account(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.ops_test_accounts where uid = p_uid);
$$;
revoke execute on function public.is_test_account(uuid) from public, anon, authenticated;

-- The account itself. Its password here is random and unknown to anyone; the
-- real one is set through ops_robot_password() and lives only in the watcher.
do $$
declare v_id uuid; v_mail text := 'ops-robot@stocksaathi.co.in';
begin
  select id into v_id from auth.users where email = v_mail;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_mail,
            extensions.crypt(encode(extensions.gen_random_bytes(24), 'hex'), extensions.gen_salt('bf')),
            timestamptz '2020-01-01 00:00:00+00',
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{"username":"ops_robot_test","display_name":"Test account (ops robot)"}'::jsonb,
            timestamptz '2020-01-01 00:00:00+00', timestamptz '2020-01-01 00:00:00+00', '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', v_mail, 'email_verified', true),
            'email', null, timestamptz '2020-01-01 00:00:00+00', timestamptz '2020-01-01 00:00:00+00');
  end if;
  insert into public.ops_test_accounts (uid, note) values (v_id, 'journey robot of the ops watcher')
  on conflict (uid) do nothing;
  update public.profiles
     set order_emails = false, recap_emails = false, onboarded = true,
         created_at = timestamptz '2020-01-01 00:00:00+00'
   where id = v_id;
end $$;

-- Sets the robot's password. Only ever touches an account listed in
-- ops_test_accounts. Used once at set-up and for the "break it on purpose" test.
create or replace function public.ops_robot_password(p_secret text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_pw text := p ->> 'password';
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  if v_pw is null or length(v_pw) < 16 then
    return jsonb_build_object('ok', false, 'why', 'password too short');
  end if;
  select uid into v_id from public.ops_test_accounts order by created_at limit 1;
  if v_id is null then
    return jsonb_build_object('ok', false, 'why', 'no test account');
  end if;
  update auth.users set encrypted_password = extensions.crypt(v_pw, extensions.gen_salt('bf')), updated_at = now()
   where id = v_id;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.ops_robot_password(text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_robot_password(text, jsonb) to anon;

-- Where a visitor came from, in the owner's own groups.
create or replace function public._ops_src(p_touch jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when s ~ '(chatgpt|openai)' then 'chatgpt'
    when s ~ '(perplexity|gemini|claude|copilot|bard|phind|you\.com|deepseek|grok|meta\.ai)' then 'ai_other'
    when s ~ 'google' and s !~ '(accounts\.google|android\.gm|mail\.google)' then 'google'
    when s ~ '(bing|yahoo|duckduckgo|brave|msn|ecosia|yandex)' then 'search_other'
    when s ~ '(facebook|instagram|^ig$|whatsapp|t\.co|twitter|x\.com|youtube|linkedin|reddit|telegram|snapchat|pinterest)' then 'social'
    when s in ('', 'direct') then 'direct'
    else 'other' end
  from (select lower(coalesce(p_touch ->> 'src', '')) as s) x;
$$;
revoke execute on function public._ops_src(jsonb) from public, anon, authenticated;

create table if not exists public.ops_funnel_day (
  day date not null,
  src text not null,
  visitors integer not null default 0,
  register integer not null default 0,
  accounts integer not null default 0,
  traded integer not null default 0,
  built_at timestamptz not null default now(),
  primary key (day, src)
);
alter table public.ops_funnel_day enable row level security;
revoke all on public.ops_funnel_day from public, anon, authenticated;

-- One IST day of new visitors and how far each got within 48 hours of the
-- first visit. Built three days later, so every day is measured the same way.
-- Reads one day of web_events through its time index. Test accounts never count.
create or replace function public.ops_funnel_build(p_day date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day date := coalesce(p_day, ((now() at time zone 'Asia/Kolkata')::date - 3));
  v_from timestamptz := (v_day::timestamp at time zone 'Asia/Kolkata');
  v_to timestamptz := ((v_day + 1)::timestamp at time zone 'Asia/Kolkata');
  v_n integer;
begin
  if v_to + interval '48 hours' > now() then
    return jsonb_build_object('ok', false, 'why', 'day not complete yet', 'day', v_day);
  end if;
  insert into public.ops_funnel_day (day, src, visitors, register, accounts, traded, built_at)
  select v_day, x.src, count(*), count(*) filter (where x.reg), count(*) filter (where x.uid is not null),
         count(*) filter (where x.traded), now()
  from (
    select public._ops_src(w.first_touch) as src,
           exists (select 1 from public.web_events e
                    where e.vid = w.vid and e.ts >= w.first_seen and e.ts < w.first_seen + interval '48 hours'
                      and e.kind = 'page' and e.path in ('/register', '/login')) as reg,
           a.uid,
           a.uid is not null and exists (select 1 from public.transactions t
                    where t.user_id = a.uid and t.created_at < w.first_seen + interval '48 hours') as traded
      from public.web_visitors w
      left join lateral (
        select l.uid from public.web_visitor_accounts l join auth.users u on u.id = l.uid
         where l.vid = w.vid and u.created_at >= w.first_seen - interval '1 hour'
           and u.created_at < w.first_seen + interval '48 hours'
           and not exists (select 1 from public.ops_test_accounts ta where ta.uid = l.uid)
         order by u.created_at limit 1) a on true
     where w.first_seen >= v_from and w.first_seen < v_to
  ) x
  group by x.src
  on conflict (day, src) do update
    set visitors = excluded.visitors, register = excluded.register, accounts = excluded.accounts,
        traded = excluded.traded, built_at = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'day', v_day, 'sources', v_n);
end $$;
revoke execute on function public.ops_funnel_build(date) from public, anon, authenticated;

create table if not exists public.ops_returning_week (
  week_start date primary key,
  n integer not null default 0,
  n1 integer not null default 0, d1 integer not null default 0,
  n7 integer not null default 0, d7 integer not null default 0,
  n30 integer not null default 0, d30 integer not null default 0,
  built_at timestamptz not null default now()
);
alter table public.ops_returning_week enable row level security;
revoke all on public.ops_returning_week from public, anon, authenticated;

-- Per sign-up week (Monday to Sunday, IST): how many came back on day 1, 7
-- and 30. nN = accounts old enough to be counted for that day. "Came back" =
-- any signed-in action that day (user_events, read through its user index).
create or replace function public.ops_returning_build(p_weeks integer default 10)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  insert into public.ops_returning_week (week_start, n, n1, d1, n7, d7, n30, d30, built_at)
  select c.wk, count(*),
         count(*) filter (where c.age >= interval '2 days'),
         count(*) filter (where c.age >= interval '2 days' and c.r1),
         count(*) filter (where c.age >= interval '8 days'),
         count(*) filter (where c.age >= interval '8 days' and c.r7),
         count(*) filter (where c.age >= interval '31 days'),
         count(*) filter (where c.age >= interval '31 days' and c.r30),
         now()
  from (
    select date_trunc('week', u.created_at at time zone 'Asia/Kolkata')::date as wk,
           now() - u.created_at as age,
           exists (select 1 from public.user_events e where e.user_id = u.id
                    and e.occurred_at >= u.created_at + interval '1 day' and e.occurred_at < u.created_at + interval '2 days') as r1,
           exists (select 1 from public.user_events e where e.user_id = u.id
                    and e.occurred_at >= u.created_at + interval '7 days' and e.occurred_at < u.created_at + interval '8 days') as r7,
           exists (select 1 from public.user_events e where e.user_id = u.id
                    and e.occurred_at >= u.created_at + interval '30 days' and e.occurred_at < u.created_at + interval '31 days') as r30
      from auth.users u
     where u.created_at >= date_trunc('week', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
                           - make_interval(weeks => greatest(1, least(coalesce(p_weeks, 10), 26)))
       and not exists (select 1 from public.ops_test_accounts ta where ta.uid = u.id)
  ) c
  group by c.wk
  on conflict (week_start) do update
    set n = excluded.n, n1 = excluded.n1, d1 = excluded.d1, n7 = excluded.n7, d7 = excluded.d7,
        n30 = excluded.n30, d30 = excluded.d30, built_at = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'weeks', v_n);
end $$;
revoke execute on function public.ops_returning_build(integer) from public, anon, authenticated;

-- What the outside watcher reads. Every 10 minutes: how many e-mail sign-ups
-- were created and confirmed in the last hour (a tiny table). Once a night
-- (full = true): the stored funnel days and returning-user weeks.
create or replace function public.ops_senses(p_secret text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_out jsonb;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  select jsonb_build_object(
    'ok', true, 'now', now(),
    'email_created_60', count(*) filter (where u.created_at > now() - interval '60 minutes'
                                           and coalesce(u.raw_app_meta_data ->> 'provider', 'email') = 'email'),
    'email_created_30', count(*) filter (where u.created_at > now() - interval '30 minutes'
                                           and coalesce(u.raw_app_meta_data ->> 'provider', 'email') = 'email'),
    'confirmed_60', count(*) filter (where u.email_confirmed_at > now() - interval '60 minutes'
                                       and coalesce(u.raw_app_meta_data ->> 'provider', 'email') = 'email'),
    'created_60', count(*) filter (where u.created_at > now() - interval '60 minutes'),
    'created_30', count(*) filter (where u.created_at > now() - interval '30 minutes'))
    into v_out
    from auth.users u
   where u.created_at > now() - interval '3 hours' or u.email_confirmed_at > now() - interval '60 minutes';
  if coalesce((p ->> 'full')::boolean, false) then
    v_out := v_out || jsonb_build_object(
      'funnel', (select coalesce(jsonb_agg(jsonb_build_object('day', f.day, 'src', f.src, 'v', f.visitors, 'r', f.register,
                         'a', f.accounts, 't', f.traded) order by f.day, f.src), '[]'::jsonb)
                   from public.ops_funnel_day f where f.day >= (now() at time zone 'Asia/Kolkata')::date - 45),
      'returning', (select coalesce(jsonb_agg(jsonb_build_object('week', r.week_start, 'n', r.n, 'n1', r.n1, 'd1', r.d1,
                         'n7', r.n7, 'd7', r.d7, 'n30', r.n30, 'd30', r.d30) order by r.week_start), '[]'::jsonb)
                      from public.ops_returning_week r where r.week_start >= (now() at time zone 'Asia/Kolkata')::date - 120));
  end if;
  return v_out;
end $$;
revoke execute on function public.ops_senses(text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_senses(text, jsonb) to anon;

-- Nightly build, after the day's other night jobs (01:50 IST). The returning
-- users are rebuilt on Sunday night only.
select cron.schedule('ops-senses-nightly', '20 20 * * *',
  $c$SET statement_timeout = '60s'; SELECT public.ops_funnel_build(null); SELECT case when extract(dow from now()) = 0 then public.ops_returning_build(10) end;$c$);
