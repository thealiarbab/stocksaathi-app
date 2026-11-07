-- 2026-11-08a: wrong-try lockout for sign-in codes and passwords, and the
-- Postgres Send Email hook.
--
-- auth_attempts: consecutive wrong tries per account (key = sha256 of
-- "code|<email>" or "pw|<email>", made by api/ai.js; no raw email stored).
-- 10 in a row locks that account's code / password check for 15 minutes.
-- Only the service role touches it, through auth_attempt().
--
-- auth_send_email_hook(event): Supabase Auth calls it for every auth email
-- (Authentication -> Auth Hooks -> Send Email -> Postgres). It queues one
-- pg_net POST to /api/ai?op=auth-email-send (Bearer = Vault cron_secret,
-- the same channel as ops-mail) and returns at once, so sign-up no longer
-- waits ~2.9 s for SMTP. The API sends through Resend's HTTP API.

create table if not exists public.auth_attempts (
  key          text primary key,
  kind         text not null check (kind in ('code', 'pw')),
  fails        int  not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.auth_attempts enable row level security;
revoke all on public.auth_attempts from public, anon, authenticated;

-- p_event: 'check' | 'fail' | 'clear'. Returns { left, locked, locked_until }.
-- A run of fails resets after an expired lock or 24 h without a try.
create or replace function public.auth_attempt(
  p_key text, p_kind text, p_event text, p_max int default 10, p_lock_minutes int default 15)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  r public.auth_attempts;
  stale boolean;
  f int;
  lu timestamptz;
begin
  if p_key is null or length(p_key) < 16 or p_kind not in ('code', 'pw') then
    return jsonb_build_object('left', p_max, 'locked', false);
  end if;

  select * into r from public.auth_attempts where key = p_key for update;
  stale := r.key is null
        or (r.locked_until is not null and r.locked_until <= now())
        or (r.locked_until is null and r.updated_at < now() - interval '24 hours');

  if p_event = 'check' then
    if not stale and r.locked_until is not null then
      return jsonb_build_object('left', 0, 'locked', true, 'locked_until', r.locked_until);
    end if;
    return jsonb_build_object('left', p_max - case when stale then 0 else r.fails end, 'locked', false);
  end if;

  if p_event = 'clear' then
    update public.auth_attempts set fails = 0, locked_until = null, updated_at = now() where key = p_key;
    return jsonb_build_object('left', p_max, 'locked', false);
  end if;

  -- 'fail'
  if not stale and r.locked_until is not null then
    return jsonb_build_object('left', 0, 'locked', true, 'locked_until', r.locked_until);
  end if;
  f := case when stale then 1 else r.fails + 1 end;
  lu := case when f >= p_max then now() + make_interval(mins => p_lock_minutes) else null end;
  insert into public.auth_attempts (key, kind, fails, locked_until, updated_at)
  values (p_key, p_kind, f, lu, now())
  on conflict (key) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = now();
  return jsonb_build_object('left', greatest(p_max - f, 0), 'locked', lu is not null, 'locked_until', lu);
end $$;
revoke all on function public.auth_attempt(text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.auth_attempt(text, text, text, int, int) to service_role;

create or replace function public.auth_send_email_hook(event jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform net.http_post(
    url := 'https://stocksaathi.co.in/api/ai?op=auth-email-send',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := event || jsonb_build_object('queued_at', now()),
    timeout_milliseconds := 10000);
  return '{}'::jsonb;
exception when others then
  return jsonb_build_object('error', jsonb_build_object('http_code', 500, 'message', 'Could not queue the email. Try again.'));
end $$;
revoke all on function public.auth_send_email_hook(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.auth_send_email_hook(jsonb) to supabase_auth_admin;
