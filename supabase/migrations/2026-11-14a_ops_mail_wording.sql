-- Ops mails: no admin panel address in the text, and issue mails that say
-- what their numbers count. Until now an issue mail gave the totals since the
-- issue first appeared ("196 times by 15 people") under a "came back" line,
-- which read as if all of that had happened just now.
--
-- The five functions are rewritten in place from their own source, so nothing
-- else about them (search_path, owner, grants) changes.
do $do$
declare
  f text;
  d text;
  n text;
  changed integer := 0;
  pairs text[][] := array[
    [$q$Open /a > Issues to see all of them.$q$, $q$The rest are in the admin panel, Issues tab.$q$],
    [$q$Open /a > Issues for the evidence.$q$, $q$The evidence is in the admin panel, Issues tab.$q$],
    [$q$Check /a Signups.$q$, $q$Check the Signups tab in the admin panel.$q$],
    [$q$Open /a > Issues and tap Approve or Reject.$q$, $q$Approve or reject it in the admin panel, Issues tab.$q$],
    [$q$switch the freeze off in /a > Issues.$q$, $q$switch the freeze off in the admin panel, Issues tab.$q$],
    [$q$Seen %s time(s)%s.$q$, $q$Seen %s time(s) today%s.$q$],
    [$q$v_why, coalesce(p ->> 'hits', '1'),$q$, $q$v_why, coalesce(p -> 'evidence' -> 'today' ->> 'hits', p ->> 'hits', '1'),$q$],
    [$q$case when coalesce((p ->> 'people')::integer, 0) > 0 then format(' by %s people', p ->> 'people') else '' end,$q$,
     $q$case when coalesce((p -> 'evidence' -> 'today' ->> 'people')::integer, 0) > 0 then format(' by %s people', p -> 'evidence' -> 'today' ->> 'people') else '' end || format(' (%s in total since it first appeared)', coalesce(p ->> 'hits', '1')),$q$]
  ];
begin
  foreach f in array array['_ops_issue_notify', 'ops_issue_upsert', 'ops_health_check', 'ops_request_approval', 'ops_attempt_reverted'] loop
    select pg_get_functiondef(p.oid) into strict d
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = f;
    n := d;
    for i in 1 .. array_length(pairs, 1) loop
      n := replace(n, pairs[i][1], pairs[i][2]);
    end loop;
    if n is distinct from d then
      execute n;
      changed := changed + 1;
    end if;
    if n like '%/a >%' or n like '%Check /a %' then
      raise exception 'ops mail wording: % still names the admin path', f;
    end if;
    if f = 'ops_issue_upsert' and (n not like '%time(s) today%' or n not like '%in total since it first appeared%'
                                   or n not like $q$%'evidence' -> 'today' ->> 'hits'%$q$) then
      raise exception 'ops mail wording: the issue mail counts were not rewritten as expected';
    end if;
  end loop;
  if changed <> 5 then
    raise exception 'ops mail wording: expected 5 functions to change, changed %', changed;
  end if;
end
$do$;
