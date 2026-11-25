begin;

create table sg10_private.direct_whatsapp_invites (
  token_hash bytea primary key,
  workspace_id uuid not null references public.sg_workspaces(id) on delete cascade,
  client_id text,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  foreign key (workspace_id, client_id) references public.sg_clients(workspace_id, id) on delete cascade
);
alter table sg10_private.direct_whatsapp_invites enable row level security;
revoke all on sg10_private.direct_whatsapp_invites from public, anon, authenticated;
create index sg10_direct_whatsapp_invites_company on sg10_private.direct_whatsapp_invites(workspace_id, client_id);
create index sg10_direct_whatsapp_invites_creator on sg10_private.direct_whatsapp_invites(created_by);
create index sg10_direct_whatsapp_invites_recipient on sg10_private.direct_whatsapp_invites(used_by);

create function sg10_private.create_direct_whatsapp_invite(p_workspace uuid, p_client text)
returns text language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid();
  token text;
begin
  if actor is null or coalesce(auth.jwt()->>'is_anonymous','true') <> 'false'
    or not coalesce(public.sg_is_owner(p_workspace),false) then
    raise insufficient_privilege;
  end if;
  if p_client is not null and not exists(
    select 1 from public.sg_clients where workspace_id=p_workspace and id=p_client
  ) then
    raise exception 'Selecciona una empresa válida' using errcode='22023';
  end if;
  token := encode(extensions.gen_random_bytes(32),'hex');
  insert into sg10_private.direct_whatsapp_invites(token_hash, workspace_id, client_id, created_by)
    values(extensions.digest(token,'sha256'), p_workspace, p_client, actor);
  return token;
end $$;

create function sg10_private.redeem_direct_whatsapp_invite(p_token text, p_customer boolean)
returns void language plpgsql security definer set search_path='' as $$
declare
  invite sg10_private.direct_whatsapp_invites;
  recipient uuid := auth.uid();
begin
  if recipient is null or coalesce(auth.jwt()->>'is_anonymous','false') <> 'true'
    or p_customer is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise insufficient_privilege;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(recipient::text,0));
  select * into invite from sg10_private.direct_whatsapp_invites
    where token_hash=extensions.digest(p_token,'sha256')
    for update;
  if not found or (invite.client_id is not null) <> p_customer then
    raise exception 'Esta invitación no es válida' using errcode='42501';
  end if;
  if invite.used_at is not null then
    if invite.used_by=recipient and (
      (p_customer and exists(select 1 from public.sg10_company_users
        where workspace_id=invite.workspace_id and client_id=invite.client_id and user_id=recipient))
      or (not p_customer and exists(select 1 from public.sg_members
        where workspace_id=invite.workspace_id and user_id=recipient and role='employee'))
    ) then
      return;
    end if;
    raise exception 'Esta invitación ya se usó. Pide un enlace nuevo.' using errcode='42501';
  end if;
  if invite.expires_at<=now() or not exists(
    select 1 from public.sg_members
    where workspace_id=invite.workspace_id and user_id=invite.created_by and role='owner'
  ) then
    raise exception 'La invitación ha caducado o se ha revocado. Pide un enlace nuevo.' using errcode='42501';
  end if;

  if p_customer then
    if exists(select 1 from public.sg_members where user_id=recipient) then
      raise exception 'Abre el enlace desde un navegador sin sesión de empleado.' using errcode='42501';
    end if;
    insert into public.sg10_company_users(workspace_id, client_id, user_id)
      values(invite.workspace_id, invite.client_id, recipient) on conflict do nothing;
  else
    if exists(select 1 from public.sg_members where user_id=recipient)
      or exists(select 1 from public.sg10_company_users where user_id=recipient) then
      raise exception 'Ya hay un acceso activo en este navegador. Abre el enlace en otro navegador.' using errcode='42501';
    end if;
    insert into public.sg_members(workspace_id, user_id, role)
      values(invite.workspace_id, recipient, 'employee');
  end if;
  update sg10_private.direct_whatsapp_invites
    set used_at=now(), used_by=recipient where token_hash=invite.token_hash;
end $$;

create function public.sg10_create_direct_whatsapp_invite(p_workspace uuid,p_client text)
returns text language sql security invoker set search_path='' as $$
  select sg10_private.create_direct_whatsapp_invite(p_workspace,p_client)
$$;
create function public.sg10_redeem_direct_whatsapp_invite(p_token text,p_customer boolean)
returns void language sql security invoker set search_path='' as $$
  select sg10_private.redeem_direct_whatsapp_invite(p_token,p_customer)
$$;

revoke all on function sg10_private.create_direct_whatsapp_invite(uuid,text),
  sg10_private.redeem_direct_whatsapp_invite(text,boolean),
  public.sg10_create_direct_whatsapp_invite(uuid,text),
  public.sg10_redeem_direct_whatsapp_invite(text,boolean)
  from public, anon, authenticated;
grant execute on function sg10_private.create_direct_whatsapp_invite(uuid,text),
  sg10_private.redeem_direct_whatsapp_invite(text,boolean),
  public.sg10_create_direct_whatsapp_invite(uuid,text),
  public.sg10_redeem_direct_whatsapp_invite(text,boolean)
  to authenticated;

commit;
