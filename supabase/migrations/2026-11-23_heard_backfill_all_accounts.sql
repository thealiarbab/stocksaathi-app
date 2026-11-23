-- One-time "How did you hear" ask: no signup-date limit (owner, 23 Nov).
-- Was: accounts onboarded in the last 14 days. Now: any onboarded account
-- with no answer that was never asked. Still once per account.

create or replace function public.heard_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_admin boolean := coalesce(public.is_admin(), false);
  s       public.heard_settings;
  p       public.profiles;
  v_on    boolean;
begin
  if v_uid is null then
    return jsonb_build_object('popup', false, 'backfill', false, 'debug', false);
  end if;
  select * into s from public.heard_settings where id;
  select * into p from public.profiles where id = v_uid;
  v_on := coalesce(s.backfill_mode, 'off') = 'live'
       or (coalesce(s.backfill_mode, 'off') = 'admin_only' and v_admin);
  return jsonb_build_object(
    'popup', coalesce(s.popup_mode, 'off') = 'live'
          or (coalesce(s.popup_mode, 'off') = 'admin_only' and v_admin),
    'backfill', v_on
          and p.id is not null
          and coalesce(p.onboarded, false)
          and p.heard_from is null
          and p.heard_backfill_shown_at is null,
    'debug', v_admin
  );
end;
$$;
revoke execute on function public.heard_config() from public, anon;
grant execute on function public.heard_config() to authenticated;

create or replace function public.admin_heard_overview()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'settings', (select to_jsonb(s) from public.heard_settings s where id),
    'backfill_eligible', (
      select count(*) from public.profiles
       where onboarded and heard_from is null and heard_backfill_shown_at is null),
    'backfill_shown', (select count(*) from public.profiles where heard_backfill_shown_at is not null),
    'answers_14d', coalesce((
      select jsonb_object_agg(k, n) from (
        select coalesce(heard_from, 'none') as k, count(*) as n
          from public.profiles
         where onboarded and created_at >= now() - interval '14 days'
         group by 1) t), '{}'::jsonb)
  );
$$;
revoke execute on function public.admin_heard_overview() from public, anon, authenticated;
grant execute on function public.admin_heard_overview() to service_role;
