-- "How did you hear about StockSaathi?" as a required one-tap card
-- (js/components/heardPopup.js), replacing the optional dropdown on the
-- onboarding Profile step once heard_settings.popup_mode is 'live'.
--
--   * profiles.heard_from takes the wider option list; the eight old values
--     keep their exact spelling so earlier answers stay comparable.
--   * profiles.heard_from_detail: the optional "Where?" text, only with
--     heard_from = 'other'. Trimmed, tags stripped, 60 characters at most,
--     enforced here (constraint + save_heard_from) as well as in the page.
--   * profiles.heard_backfill_shown_at: the one-time ask for recent accounts
--     that skipped the question. Set the moment the card opens; never shown
--     twice.
--   * heard_settings: one row of switches, edited on /a (Signups tab).
--     'off' | 'admin_only' | 'live'. admin_only = accounts where is_admin().
--   * heard_config(): what this caller should see (card or old dropdown,
--     the backfill ask, the debug tools). Only is_admin() gets debug = true.
--   * save_heard_from(): the one write path for the card. RLS on profiles is
--     unchanged: a user can still update only their own row.

-- 1. Wider option list ------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_heard_from_check;
alter table public.profiles
  add constraint profiles_heard_from_check
  check (
    heard_from is null or heard_from in (
      -- the original eight (2026-11-17a)
      'chatgpt', 'google', 'other_ai', 'instagram',
      'youtube', 'friend', 'school', 'other',
      -- main grid additions
      'whatsapp', 'family', 'ambassador', 'dont_remember',
      -- "More options"
      'telegram', 'reddit', 'discord', 'x', 'snapchat', 'facebook',
      'linkedin', 'quora', 'play_store', 'article', 'other_search'
    )
  );

-- 2. "Other" detail + backfill flag ------------------------------------------
alter table public.profiles add column if not exists heard_from_detail text;
alter table public.profiles add column if not exists heard_backfill_shown_at timestamptz;

alter table public.profiles drop constraint if exists profiles_heard_from_detail_check;
alter table public.profiles
  add constraint profiles_heard_from_detail_check
  check (
    heard_from_detail is null or (
      heard_from = 'other'
      and char_length(heard_from_detail) between 1 and 60
      and heard_from_detail !~ '[<>]'
      and heard_from_detail = btrim(heard_from_detail)
    )
  );

comment on column public.profiles.heard_from_detail is
  'Optional free text for heard_from = other ("Where?"), 60 chars, no markup.';
comment on column public.profiles.heard_backfill_shown_at is
  'When the one-time "how did you hear" ask was shown to an account that skipped it.';

-- 3. Switches ----------------------------------------------------------------
create table if not exists public.heard_settings (
  id            boolean primary key default true check (id),
  popup_mode    text not null default 'admin_only' check (popup_mode in ('off', 'admin_only', 'live')),
  backfill_mode text not null default 'off'        check (backfill_mode in ('off', 'admin_only', 'live')),
  updated_at    timestamptz not null default now()
);
insert into public.heard_settings (id) values (true) on conflict do nothing;
alter table public.heard_settings enable row level security;
revoke all on public.heard_settings from public, anon, authenticated;
grant all on public.heard_settings to service_role;

-- 4. What this caller should see --------------------------------------------
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
          and p.heard_backfill_shown_at is null
          and p.created_at >= now() - interval '14 days',
    'debug', v_admin
  );
end;
$$;
revoke execute on function public.heard_config() from public, anon;
grant execute on function public.heard_config() to authenticated;

-- 5. The one write path for the card ----------------------------------------
create or replace function public.save_heard_from(p_value text, p_detail text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_detail text;
begin
  if v_uid is null then raise exception 'not_logged_in'; end if;
  if p_value is null or p_value not in (
      'chatgpt', 'google', 'other_ai', 'instagram', 'youtube', 'friend', 'school', 'other',
      'whatsapp', 'family', 'ambassador', 'dont_remember',
      'telegram', 'reddit', 'discord', 'x', 'snapchat', 'facebook',
      'linkedin', 'quora', 'play_store', 'article', 'other_search') then
    raise exception 'bad_value';
  end if;
  if p_value = 'other' and p_detail is not null then
    -- Strip tags, then any stray angle brackets, collapse whitespace, cap at 60.
    v_detail := regexp_replace(p_detail, '<[^>]*>', '', 'g');
    v_detail := regexp_replace(v_detail, '[<>]', '', 'g');
    v_detail := btrim(regexp_replace(v_detail, '\s+', ' ', 'g'));
    v_detail := btrim(left(v_detail, 60));
    if v_detail = '' then v_detail := null; end if;
  end if;
  update public.profiles
     set heard_from = p_value,
         heard_from_detail = v_detail,
         updated_at = now()
   where id = v_uid;
  return jsonb_build_object('ok', true, 'heard_from', p_value, 'detail', v_detail);
end;
$$;
revoke execute on function public.save_heard_from(text, text) from public, anon;
grant execute on function public.save_heard_from(text, text) to authenticated;

-- 6. Backfill ask: mark shown (once) -----------------------------------------
create or replace function public.mark_heard_backfill_shown()
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.profiles
     set heard_backfill_shown_at = now()
   where id = auth.uid() and heard_backfill_shown_at is null;
$$;
revoke execute on function public.mark_heard_backfill_shown() from public, anon;
grant execute on function public.mark_heard_backfill_shown() to authenticated;

-- 7. /a: read + flip the switches (service role only, via api/ai.js) ---------
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
       where onboarded and heard_from is null and heard_backfill_shown_at is null
         and created_at >= now() - interval '14 days'),
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

create or replace function public.admin_heard_set(p_popup text default null, p_backfill text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_popup is not null and p_popup not in ('off', 'admin_only', 'live') then raise exception 'bad_popup_mode'; end if;
  if p_backfill is not null and p_backfill not in ('off', 'admin_only', 'live') then raise exception 'bad_backfill_mode'; end if;
  update public.heard_settings
     set popup_mode = coalesce(p_popup, popup_mode),
         backfill_mode = coalesce(p_backfill, backfill_mode),
         updated_at = now()
   where id;
  return public.admin_heard_overview();
end;
$$;
revoke execute on function public.admin_heard_set(text, text) from public, anon, authenticated;
grant execute on function public.admin_heard_set(text, text) to service_role;
