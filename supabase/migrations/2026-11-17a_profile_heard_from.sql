-- Persist the onboarding "How did you hear about StockSaathi?" answer
-- on the account profile, independently of best-effort visitor analytics.
--
-- Historical selections were recorded as click events in web_events. Use the
-- verified event uid where present; for the few events missing that uid, use
-- the server-linked web_visitors uid. Keep the latest answer per account.

alter table public.profiles
  add column heard_from text;

alter table public.profiles
  add constraint profiles_heard_from_check
  check (
    heard_from is null or heard_from in (
      'chatgpt', 'google', 'other_ai', 'instagram',
      'youtube', 'friend', 'school', 'other'
    )
  );

comment on column public.profiles.heard_from is
  'Student-selected answer to How did you hear about StockSaathi?';

with ranked_answers as (
  select
    coalesce(e.uid, v.uid) as user_id,
    split_part(e.target, ':', 2) as heard_from,
    row_number() over (
      partition by coalesce(e.uid, v.uid)
      order by e.ts desc, e.id desc
    ) as rn
  from public.web_events e
  left join public.web_visitors v on v.vid = e.vid
  where e.path = '/onboarding'
    and e.kind = 'click'
    and e.target in (
      'heard_from:chatgpt', 'heard_from:google', 'heard_from:other_ai',
      'heard_from:instagram', 'heard_from:youtube', 'heard_from:friend',
      'heard_from:school', 'heard_from:other'
    )
    and coalesce(e.uid, v.uid) is not null
)
update public.profiles p
   set heard_from = a.heard_from
  from ranked_answers a
 where a.rn = 1
   and a.user_id = p.id
   and p.heard_from is null;
