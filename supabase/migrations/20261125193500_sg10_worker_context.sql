begin;
create or replace function public.sg10_worker_context(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'gmail_owner',
    (select case when count(*) = 1 then min(m.user_id::text) end from public.sg_members m where m.role = 'owner'),
    'gmail_workspace',
    (select case when count(*) = 1 then min(m.workspace_id::text) end from public.sg_members m where m.role = 'owner')
  )
  where p_token ~ '^[a-f0-9]{64}$'
    and exists (
      select 1
      from vault.decrypted_secrets s
      where s.name = 'sg10_worker_secret'
        and extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(p_token, 'sha256')
    );
$$;
revoke all on function public.sg10_worker_context(text) from public, anon, authenticated;
grant execute on function public.sg10_worker_context(text) to service_role;
notify pgrst, 'reload schema';
commit;
