-- Memory search: cards and raw history are ranked separately.
-- Measured on 15 Nov: with 890 raw items and 34 cards in one ranking, raw
-- history took most of the six places and pushed the right card out when a
-- question shared no words with it. Now up to p_cards cards come first, then
-- up to three raw items. Lessons and the skill are unchanged.
create or replace function public._ops_memory_search(p_text text, p_vec extensions.vector, p_area text default null,
                                                     p_skip bigint[] default '{}', p_cards integer default 6, p_lessons integer default 3)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_q tsquery := public._ops_tsq(p_text);
  v_min real := coalesce((select (value ->> 'min_meaning')::real from public.ops_config where key = 'memory'), 0.80);
  v_cards jsonb; v_lessons jsonb; v_skill jsonb;
begin
  with docs as (
    select 'case'::text as t, c.id, c.search, c.area,
           ((case c.outcome when 'held' then 1.3 when 'seeded' then 1.1 when 'did_not_hold' then 0.6 else 1.0 end)
            * (1 + 0.05 * least(c.confirmed, 5)) * (case when c.contradicted > c.confirmed then 0.7 else 1.0 end))::real as boost
      from public.ops_cases c
     where c.superseded_by is null and c.id <> all (coalesce(p_skip, '{}'))
    union all
    select 'raw', r.id, r.search, r.area, 1.0::real from public.ops_raw r where r.card_id is null
  ), kw as (
    select d.t, d.id, row_number() over (partition by d.t order by ts_rank_cd(d.search, v_q) desc, d.id) as rk
      from docs d where v_q is not null and d.search @@ v_q
  ), ve as (
    select d.t, d.id, (1 - (v.embedding operator(extensions.<=>) p_vec))::real as sim,
           row_number() over (partition by d.t order by v.embedding operator(extensions.<=>) p_vec, d.id) as rk
      from docs d join public.ops_vectors v on v.t = d.t and v.id = d.id
     where p_vec is not null and v.embedding is not null
  ), fused as (
    select coalesce(kw.t, ve.t) as t, coalesce(kw.id, ve.id) as id, kw.rk as kw_rank, ve.rk as vec_rank, ve.sim,
           coalesce(1.0 / (60 + kw.rk), 0) + coalesce(1.0 / (60 + ve.rk), 0) as rrf
      from (select * from kw where rk <= 40) kw full join (select * from ve where rk <= 40) ve on kw.t = ve.t and kw.id = ve.id
     where kw.rk is not null or ve.sim >= v_min
  ), scored as (
    select f.*, f.rrf * d.boost * (case when coalesce(p_area, 'other') = 'other' then 1.0 when d.area = p_area then 1.3
                                        when d.area = 'core' then 1.0 when d.area is null or d.area = 'other' then 0.9 else 0.7 end) as score
      from fused f join docs d on d.t = f.t and d.id = f.id
  ), picked as (
    select * from (select s.*, row_number() over (partition by s.t order by s.score desc) as pos from scored s) x
     where (x.t = 'case' and x.pos <= greatest(p_cards, 1)) or (x.t = 'raw' and x.pos <= 3)
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(x.j) order by x.is_card desc, x.score desc), '[]'::jsonb) into v_cards
    from (
      select s.score, (s.t = 'case') as is_card,
             (case when s.t = 'case' then
                (select jsonb_build_object('card', c.id, 'title', c.title, 'symptom', c.symptom, 'cause', c.cause, 'evidence', c.evidence,
                          'fix', c.fix, 'dead_ends', c.dead_ends, 'files', c.files, 'commit', c.commit_ref, 'component', c.component,
                          'area', c.area, 'outcome', c.outcome, 'confidence', c.confidence, 'confirmed', c.confirmed,
                          'contradicted', c.contradicted, 'when', c.occurred_at::date)
                   from public.ops_cases c where c.id = s.id)
              else
                (select jsonb_build_object('raw', r.id, 'kind', r.kind, 'ref', r.ref, 'title', r.title, 'text', left(r.body, 700),
                          'files', r.files, 'area', r.area, 'when', r.occurred_at::date,
                          'note', 'History as written at the time, not a card yet. If it helped, write the card: ops_case_add with "raw_id".')
                   from public.ops_raw r where r.id = s.id)
              end)
             || jsonb_build_object('match', jsonb_strip_nulls(jsonb_build_object('score', round((s.score * 1000)::numeric, 1),
                  'meaning', round(s.sim::numeric, 3), 'word_rank', s.kw_rank, 'meaning_rank', s.vec_rank))) as j
        from picked s) x;

  with docs as (
    select 'lesson'::text as t, l.id, l.search, l.area, (0.5 + l.confidence)::real as boost
      from public.ops_lessons l where l.status = 'active'
    union all
    select 'skill', s.id, s.search, s.area, (1 + 0.1 * least(s.held, 5))::real
      from public.ops_skills s where s.stage <> 'suspended'
  ), kw as (
    select d.t, d.id, row_number() over (partition by d.t order by ts_rank_cd(d.search, v_q) desc, d.id) as rk
      from docs d where v_q is not null and d.search @@ v_q
  ), ve as (
    select d.t, d.id, (1 - (v.embedding operator(extensions.<=>) p_vec))::real as sim,
           row_number() over (partition by d.t order by v.embedding operator(extensions.<=>) p_vec, d.id) as rk
      from docs d join public.ops_vectors v on v.t = d.t and v.id = d.id
     where p_vec is not null and v.embedding is not null
  ), scored as (
    select coalesce(kw.t, ve.t) as t, coalesce(kw.id, ve.id) as id, ve.sim,
           (coalesce(1.0 / (60 + kw.rk), 0) + coalesce(1.0 / (60 + ve.rk), 0)) * d.boost
             * (case when coalesce(p_area, 'other') = 'other' then 1.0 when d.area = p_area then 1.3
                     when d.area is null or d.area in ('core', 'other') then 1.0 else 0.7 end) as score
      from kw full join ve on kw.t = ve.t and kw.id = ve.id
      join docs d on d.t = coalesce(kw.t, ve.t) and d.id = coalesce(kw.id, ve.id)
     where kw.rk is not null or ve.sim >= v_min
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object('lesson', l.id, 'text', l.lesson, 'why', l.why, 'evidence', l.evidence,
                       'confidence', round(l.confidence::numeric, 2), 'helped', l.helped, 'misled', l.misled) order by s.score desc)
                from (select * from scored where t = 'lesson' order by score desc limit greatest(p_lessons, 0)) s
                join public.ops_lessons l on l.id = s.id), '[]'::jsonb),
    (select jsonb_build_object('skill', k.id, 'name', k.name, 'when_to_use', k.when_to_use, 'steps', k.steps, 'undo', k.undo,
              'stage', k.stage, 'uses', k.uses, 'held', k.held, 'bad', k.bad, 'cases', k.case_ids)
       from (select * from scored where t = 'skill' and (sim is null or sim >= v_min + 0.02) order by score desc limit 1) s
       join public.ops_skills k on k.id = s.id)
    into v_lessons, v_skill;

  return jsonb_build_object('cards', v_cards, 'lessons', v_lessons, 'skill', v_skill);
end $$;
revoke execute on function public._ops_memory_search(text, extensions.vector, text, bigint[], integer, integer) from public, anon, authenticated;
