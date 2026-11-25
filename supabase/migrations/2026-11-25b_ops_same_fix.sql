-- Ops watcher: one fix that covers several issues.
--
-- Until now only an issue with its own fix attempt could be closed. When the
-- same change fixed a second issue (the browser's view of a server error, a
-- fallback route), that second issue had no attempt, so nothing could close
-- it: the fixer may not mark an issue fixed, and the collector judges
-- attempts only. Such issues were released as "open" again and again and sat
-- in the to-do list for weeks (#12 and #61 behind #10, #53 behind #52).
--
-- ops_same_fix(actor, issue, other_issue, note, attempt) links an issue to
-- the attempt that fixed the other one. It is refused when the issue was seen
-- after that fix went live. If the collector already judged the attempt
-- "held", the issue is closed at once; otherwise it waits as fix_live and the
-- collector's verdict on that attempt decides for it too.

alter table public.ops_issues add column if not exists same_fix_as bigint references public.ops_issues (id);
alter table public.ops_issues add column if not exists same_fix_attempt bigint references public.ops_attempts (id);

create or replace function public._ops_issue_guard()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
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
                        where (a.issue_id = new.id or a.id = new.same_fix_attempt)
                          and a.verdict = 'held' and a.verdict_by = 'collector') then
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
end $function$;

create or replace function public.ops_same_fix(p_actor text, p_issue bigint, p_other bigint, p_note text, p_attempt bigint default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  i public.ops_issues; a public.ops_attempts;
begin
  perform public._ops_actor(p_actor);
  if p_issue is null or p_other is null or p_issue = p_other then
    return jsonb_build_object('ok', false, 'why', 'name two different issues');
  end if;
  if length(trim(coalesce(p_note, ''))) < 10 then
    return jsonb_build_object('ok', false, 'why', 'say in a sentence why the same change fixes this issue');
  end if;
  select * into i from public.ops_issues where id = p_issue for update;
  if not found or i.status in ('fixed', 'fix_live') then
    return jsonb_build_object('ok', false, 'why', 'no such issue, or it is already fixed or being watched');
  end if;
  select * into a from public.ops_attempts
   where issue_id = p_other and live_at is not null and reverted_at is null
     and (verdict is null or (verdict = 'held' and verdict_by = 'collector'))
     and (p_attempt is null or id = p_attempt)
   order by id desc limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'why', format('issue #%s has no fix that is live or was judged held', p_other));
  end if;
  if i.last_seen > a.live_at then
    return jsonb_build_object('ok', false, 'why', format('this issue was seen at %s, after that fix went live at %s: that fix did not cover it', i.last_seen, a.live_at));
  end if;
  update public.ops_issues
     set same_fix_as = p_other, same_fix_attempt = a.id,
         cause = coalesce(nullif(trim(cause), ''), left(p_note, 600)),
         fix_commit = a.change_ref,
         fix_note = left(format('Fixed by the same change as issue #%s (%s): %s', p_other, coalesce(a.change_ref, a.change_kind), p_note), 600),
         muted_until = null, mute_reason = null, claimed_by = null, lease_until = null,
         status = case when a.verdict = 'held' then 'fixed' else 'fix_live' end
   where id = p_issue;
  perform public._ops_log(p_issue, p_actor, 'same_fix', jsonb_build_object('as', p_other, 'attempt_id', a.id, 'ref', a.change_ref, 'note', p_note));
  return jsonb_build_object('ok', true, 'attempt', a.id,
    'status', case when a.verdict = 'held' then 'fixed' else 'fix_live' end,
    'note', case when a.verdict = 'held' then 'closed: the collector already judged that fix as held'
                 else 'waits for the collector''s verdict on that fix' end);
end $function$;

revoke all on function public.ops_same_fix(text, bigint, bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.ops_same_fix(text, bigint, bigint, text, bigint) to service_role;

create or replace function public.ops_attempt_verdict(p_secret text, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  a public.ops_attempts; v_verdict text := p ->> 'verdict'; r record;
begin
  if not public._ops_collector(p_secret) then
    return jsonb_build_object('ok', false);
  end if;
  select * into a from public.ops_attempts where id = (p ->> 'attempt_id')::bigint for update;
  if not found or a.verdict is not null then
    return jsonb_build_object('ok', true, 'ignored', true);
  end if;
  perform set_config('ops.verdict_by', 'collector', true);
  -- Stamped as 'db' so the resulting status change is reported back to the
  -- collector on its next pulse like any other.
  perform set_config('ops.actor', 'db', true);
  if v_verdict is null then
    update public.ops_attempts set watch_ok_at = now(), after = p -> 'after' where id = a.id;
    perform public._ops_log(a.issue_id, 'collector', 'watch_passed', jsonb_build_object('attempt_id', a.id, 'after', p -> 'after'));
    return jsonb_build_object('ok', true);
  end if;
  if v_verdict not in ('held', 'no_effect', 'made_worse') then
    return jsonb_build_object('ok', false, 'why', 'bad verdict');
  end if;
  update public.ops_attempts set verdict = v_verdict, verdict_at = now(), verdict_by = 'collector',
         verdict_note = left(p ->> 'note', 600), after = coalesce(p -> 'after', after)
   where id = a.id;
  perform public._ops_log(a.issue_id, 'collector', 'verdict', jsonb_build_object('attempt_id', a.id, 'verdict', v_verdict, 'note', p ->> 'note'));

  if v_verdict = 'held' then
    update public.ops_issues set status = 'fixed', fix_note = coalesce(fix_note, left(p ->> 'note', 600)) where id = a.issue_id and status in ('fix_live', 'fixing', 'open');
    update public.ops_cases set outcome = 'held', confidence = case when confidence = 'low' then 'medium' else confidence end where attempt_id = a.id;
    update public.ops_cases set confirmed = confirmed + 1 where id = any (a.cases_used);
    if a.recipe_id is not null then
      update public.ops_recipes set uses = uses + 1, held = held + 1, last_used = now(), updated_at = now(),
             stage = case when stage = 'supervised' and held + 1 >= 8 and reverted = 0 then 'auto' else stage end
       where id = a.recipe_id;
    end if;
    perform public._ops_issue_notify(a.issue_id, 'fixed', format('StockSaathi issue #%s fixed and verified', a.issue_id),
      format(E'%s\n\nWhat changed: %s\n\nHow it was checked: %s',
        (select title from public.ops_issues where id = a.issue_id), left(a.hypothesis, 500), p ->> 'note'));
  elsif v_verdict = 'no_effect' then
    update public.ops_issues set status = 'open', failed_attempts = failed_attempts + 1, claimed_by = null, lease_until = null
     where id = a.issue_id and status in ('fix_live', 'fixing');
    update public.ops_cases set outcome = 'did_not_hold', contradicted = contradicted + 1 where attempt_id = a.id;
    if a.recipe_id is not null then
      update public.ops_recipes set uses = uses + 1, last_used = now(), updated_at = now() where id = a.recipe_id;
    end if;
  else
    update public.ops_issues set status = 'open', claimed_by = null, lease_until = null where id = a.issue_id and status in ('fix_live', 'fixing');
    perform public._ops_issue_notify(a.issue_id, 'made_worse', format('StockSaathi: a fix for issue #%s made things worse', a.issue_id),
      format(E'%s\n\nThe change (%s) is being undone: by the session that made it if it is still running, otherwise by the next fixer run. Undo on record: %s',
        p ->> 'note', coalesce(a.change_ref, a.change_kind), left(a.undo ->> 'how', 400)), true);
  end if;

  -- Issues linked to this attempt with ops_same_fix share its verdict. One
  -- that was seen again after the fix went live was not covered by it and
  -- goes back to open, whatever the verdict.
  for r in select id, last_seen from public.ops_issues where same_fix_attempt = a.id and status = 'fix_live' loop
    if v_verdict = 'held' and r.last_seen <= a.live_at then
      update public.ops_issues set status = 'fixed' where id = r.id;
      perform public._ops_log(r.id, 'collector', 'verdict', jsonb_build_object('attempt_id', a.id, 'verdict', 'held', 'same_fix_as', a.issue_id, 'note', p ->> 'note'));
    else
      update public.ops_issues set status = 'open', same_fix_as = null, same_fix_attempt = null, fix_note = null where id = r.id;
      perform public._ops_log(r.id, 'collector', 'same_fix_ended', jsonb_build_object('attempt_id', a.id, 'verdict', v_verdict,
        'why', case when v_verdict = 'held' then 'seen again after that fix went live' else 'that fix did not hold' end));
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end $function$;
