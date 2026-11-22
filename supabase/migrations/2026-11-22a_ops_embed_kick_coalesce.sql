-- One ops-embed sweep per burst of memory writes, not one per statement.
-- The statement triggers on the ops_* memory tables call _ops_embed_kick for
-- every statement; a burst of writes queued 20+ sweeps that pg_net sent in
-- one batch, and that many concurrent workers ran out of edge compute (546).
-- A sweep that is still waiting in the queue runs after this commit and
-- chains itself while work remains, so posting another one adds nothing.
create or replace function public._ops_embed_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_secret text;
  v_url constant text := 'https://hwlmwraowcylxzdpumca.supabase.co/functions/v1/ops-embed';
begin
  if exists (select 1 from net.http_request_queue q where q.url = v_url) then return; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ops_embed_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('op', 'sweep'),
    timeout_milliseconds := 20000);
exception when others then
  return;
end $$;
revoke execute on function public._ops_embed_kick() from public, anon, authenticated;
