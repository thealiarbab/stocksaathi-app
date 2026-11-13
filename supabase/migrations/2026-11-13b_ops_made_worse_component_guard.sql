-- Ops safety loop: a change that made things worse blocks the next automatic
-- change to the SAME component for 7 days, whatever issue it is filed under.
--
-- Why (13 Nov 2026): failed attempts were counted per issue only. At 01:30 IST
-- the cloud fixer changed handlers/quote.py for issue #12; the watcher judged
-- it made_worse (server errors 0.1 -> 2.5 a minute) and it was reverted at
-- 01:42. At 06:29 the same fixer put the identical change back live under
-- issue #10 (same component, /api/quote), and nothing stopped it. It turned
-- out harmless, but a change judged "made worse" must not come back without
-- the owner looking at it.
--
-- The fixer is told to hand the issue to the owner (ops_release with
-- needs_owner). The owner (p_actor = 'owner') is not blocked.
-- Only ops_attempt_start changes; everything else in it is as before.

create or replace function public.ops_attempt_start(p_actor text, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  i public.ops_issues;
  v_lim jsonb; v_tier integer := (p ->> 'tier')::integer; v_kind text := p ->> 'change_kind';
  v_id bigint; v_hour integer; v_day integer;
  v_bad record;
begin
  perform public._ops_actor(p_actor);
  select * into i from public.ops_issues where id = (p ->> 'issue_id')::bigint for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'no such issue'); end if;
  if p_actor <> 'owner' and (i.claimed_by is distinct from p_actor or i.status <> 'fixing') then
    return jsonb_build_object('ok', false, 'why', 'claim the issue first (ops_claim)');
  end if;
  if coalesce(trim(i.cause), '') = '' then
    return jsonb_build_object('ok', false, 'why', 'write the cause first (ops_diagnose); no change without a stated cause');
  end if;
  if coalesce((select (value ->> 'on')::boolean from public.ops_config where key = 'freeze'), false) and p_actor <> 'owner' then
    return jsonb_build_object('ok', false, 'why', 'freeze is on: no automatic changes. Diagnose and leave the issue for the owner.');
  end if;
  if exists (select 1 from public.ops_attempts where verdict = 'made_worse' and reverted_at is null) then
    return jsonb_build_object('ok', false, 'why', 'a change that made things worse has not been undone yet; revert it first (see ops_queue reverts_needed)');
  end if;
  if exists (select 1 from public.ops_attempts where live_at > now() - interval '30 minutes' and verdict is null and watch_ok_at is null) then
    return jsonb_build_object('ok', false, 'why', 'another change is still in its watch window; one live change at a time');
  end if;
  if v_tier is null or v_tier not between 1 and 4 then
    return jsonb_build_object('ok', false, 'why', 'tier must be 1 (instant, reversible), 2 (reversible code), 3 (reversible database) or 4 (cannot be undone)');
  end if;
  if v_tier = 4 and (i.approval ->> 'approved_at') is null then
    return jsonb_build_object('ok', false, 'why', 'tier 4 needs the owner''s Approve tap first (ops_request_approval)');
  end if;
  if public._ops_market_opening() and v_tier > 1 and p_actor <> 'owner' then
    return jsonb_build_object('ok', false, 'why', 'first 30 minutes after market open: only tier 1 changes');
  end if;
  if not i.trusted and not coalesce((p ->> 'reproduced')::boolean, false) then
    return jsonb_build_object('ok', false, 'why', 'this issue rests on browser reports only (a public endpoint); reproduce it or find a server-side trace first, then pass reproduced=true');
  end if;
  if jsonb_typeof(p -> 'undo') <> 'object' or coalesce(p -> 'undo' ->> 'how', '') = '' then
    return jsonb_build_object('ok', false, 'why', 'undo must say how: {"how": "...", plus the deploy id or the undo SQL}');
  end if;
  if jsonb_typeof(p -> 'expected') <> 'object' or coalesce(p -> 'expected' ->> 'what', '') = '' then
    return jsonb_build_object('ok', false, 'why', 'expected must say what should happen: {"what": "...", "quiet_fps": [...]}');
  end if;
  select value into v_lim from public.ops_config where key = 'limits';
  select count(*) filter (where live_at > now() - interval '1 hour'), count(*) filter (where live_at > now() - interval '1 day')
    into v_hour, v_day from public.ops_attempts where live_at is not null;
  if p_actor <> 'owner' and (v_hour >= coalesce((v_lim ->> 'per_hour')::integer, 4) or v_day >= coalesce((v_lim ->> 'per_day')::integer, 12)) then
    return jsonb_build_object('ok', false, 'why', format('change limit reached (%s this hour, %s today)', v_hour, v_day));
  end if;
  if exists (select 1 from public.ops_trust t where t.change_kind = v_kind and t.component = '*' and t.suspended) and p_actor <> 'owner' then
    return jsonb_build_object('ok', false, 'why', format('changes of kind %s are suspended after two reverts in a row; the owner lifts this', v_kind));
  end if;
  if i.failed_attempts >= coalesce((v_lim ->> 'max_failed_attempts')::integer, 3) and p_actor <> 'owner' then
    return jsonb_build_object('ok', false, 'why', 'three attempts on this issue did not work; hand it to the owner with what was learned (ops_release needs_owner)');
  end if;
  -- New (13 Nov): a made-worse change anywhere on this component in the last
  -- 7 days, under any issue, hands the next change to the owner.
  select a.id, a.issue_id, a.change_ref, a.verdict_at, a.verdict_note into v_bad
    from public.ops_attempts a
   where a.verdict = 'made_worse'
     and a.verdict_at > now() - interval '7 days'
     and a.component = coalesce(nullif(p ->> 'component', ''), i.component)
   order by a.verdict_at desc
   limit 1;
  if found and p_actor <> 'owner' then
    return jsonb_build_object('ok', false, 'why', format(
      'a change to %s made things worse on %s IST (attempt %s, issue #%s, %s: %s). The next change to this component needs the owner: hand the issue over with your diagnosis (ops_release needs_owner). Blocked until %s IST.',
      coalesce(nullif(p ->> 'component', ''), i.component),
      to_char(v_bad.verdict_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'),
      v_bad.id, v_bad.issue_id, coalesce(v_bad.change_ref, 'no commit recorded'), coalesce(v_bad.verdict_note, 'no note'),
      to_char((v_bad.verdict_at + interval '7 days') at time zone 'Asia/Kolkata', 'DD Mon HH24:MI')));
  end if;

  insert into public.ops_attempts (issue_id, actor, hypothesis, checked, cases_used, recipe_id, change_kind, tier, component, undo, expected, before)
  values (i.id, p_actor, p ->> 'hypothesis', p ->> 'checked',
          coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(coalesce(p -> 'cases_used', '[]'::jsonb)) x), '{}'),
          nullif(p ->> 'recipe_id', '')::bigint, v_kind, v_tier, coalesce(p ->> 'component', i.component),
          p -> 'undo', p -> 'expected', p -> 'before')
  returning id into v_id;
  perform public._ops_log(i.id, p_actor, 'attempt_planned', jsonb_build_object('attempt_id', v_id, 'kind', v_kind, 'tier', v_tier, 'hypothesis', left(p ->> 'hypothesis', 400)));
  return jsonb_build_object('ok', true, 'attempt_id', v_id);
end $function$;

revoke all on function public.ops_attempt_start(text, jsonb) from public, anon, authenticated;
grant execute on function public.ops_attempt_start(text, jsonb) to service_role;
