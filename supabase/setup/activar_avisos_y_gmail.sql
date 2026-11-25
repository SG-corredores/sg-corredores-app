-- Run as postgres after applying both migrations and verifying the two workers.
-- Worker authentication uses the same secret in Vault and in the scheduled request.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name='sg10_worker_secret' and decrypted_secret ~ '^[a-f0-9]{64}$') then
    raise exception 'Crea primero el secreto sg10_worker_secret en Vault.';
  end if;
end $$;
select cron.schedule('sg10-push-delivery','20 seconds',$task$
  select net.http_post(
    url:='https://zyzcnosaavvcijsmcowq.supabase.co/functions/v1/sg10-push',
    headers:=jsonb_build_object('Content-Type','application/json','x-sg-worker',
      (select decrypted_secret from vault.decrypted_secrets where name='sg10_worker_secret' limit 1)),
    body:='{}'::jsonb,timeout_milliseconds:=30000
  )
$task$);
select cron.schedule('sg10-gmail-import','*/3 * * * *',$task$
  select net.http_post(
    url:='https://zyzcnosaavvcijsmcowq.supabase.co/functions/v1/sg10-gmail',
    headers:=jsonb_build_object('Content-Type','application/json','x-sg-worker',
      (select decrypted_secret from vault.decrypted_secrets where name='sg10_worker_secret' limit 1)),
    body:='{}'::jsonb,timeout_milliseconds:=45000
  )
$task$);
commit;
