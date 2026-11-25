begin;
create table sg10_private.whatsapp_invites (
  token_hash bytea primary key,
  workspace_id uuid not null references public.sg_workspaces(id) on delete cascade,
  client_id text,
  email text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  foreign key (workspace_id,client_id) references public.sg_clients(workspace_id,id) on delete cascade
);
revoke all on sg10_private.whatsapp_invites from public,anon,authenticated;
create index sg10_whatsapp_invites_target
on sg10_private.whatsapp_invites(workspace_id,email,client_id) where used_at is null;

create function public.sg10_create_whatsapp_invite(p_workspace uuid,p_email text,p_client text default null)
returns text language plpgsql security definer set search_path='' as $$
declare token text; address text:=lower(btrim(p_email));
begin
  if not coalesce(public.sg_is_owner(p_workspace),false) or (auth.jwt()->>'is_anonymous')='true' then
    raise insufficient_privilege;
  end if;
  if address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Indica un correo electrónico válido' using errcode='22023';
  end if;
  if p_client is not null and not exists(select 1 from public.sg_clients where workspace_id=p_workspace and id=p_client) then
    raise exception 'Selecciona una empresa válida' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||'/'||address||'/'||coalesce(p_client,''),0));
  update sg10_private.whatsapp_invites set expires_at=now()
    where workspace_id=p_workspace and email=address and client_id is not distinct from p_client and expires_at>now() and used_at is null;
  token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into sg10_private.whatsapp_invites(token_hash,workspace_id,client_id,email,created_by)
    values(extensions.digest(token,'sha256'),p_workspace,p_client,address,auth.uid());
  return token;
end $$;

create function public.sg10_redeem_whatsapp_invite(p_token text,p_customer boolean)
returns void language plpgsql security definer set search_path='' as $$
declare entry sg10_private.whatsapp_invites; address text; recipient uuid:=auth.uid();
begin
  if recipient is null or p_customer is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise insufficient_privilege;
  end if;
  select lower(email) into address from auth.users where id=recipient and email_confirmed_at is not null;
  if address is null or (auth.jwt()->>'is_anonymous')='true' then
    raise exception 'Confirma primero tu correo electrónico' using errcode='42501';
  end if;
  select * into entry from sg10_private.whatsapp_invites
    where token_hash=extensions.digest(p_token,'sha256') and used_at is null and expires_at>now()
    for update;
  if not found or entry.email<>address or (entry.client_id is not null)<>p_customer
    or not exists(select 1 from public.sg_members where workspace_id=entry.workspace_id and user_id=entry.created_by and role='owner') then
    raise exception 'La invitación ha caducado, ya se usó o corresponde a otro correo' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(recipient::text,0));
  if p_customer then
    if exists(select 1 from public.sg_members where user_id=recipient) then
      raise exception 'Usa una cuenta distinta de la de empleado' using errcode='42501';
    end if;
    insert into public.sg10_company_users(workspace_id,client_id,user_id)
      values(entry.workspace_id,entry.client_id,recipient) on conflict do nothing;
  else
    if exists(select 1 from public.sg10_company_users where user_id=recipient) then
      raise exception 'Usa un correo distinto del de Zona Clientes' using errcode='42501';
    end if;
    insert into public.sg_members(workspace_id,user_id,role)
      values(entry.workspace_id,recipient,'employee') on conflict do nothing;
  end if;
  update sg10_private.whatsapp_invites set used_at=now() where token_hash=entry.token_hash;
end $$;

revoke all on function public.sg10_create_whatsapp_invite(uuid,text,text),public.sg10_redeem_whatsapp_invite(text,boolean) from public,anon;
grant execute on function public.sg10_create_whatsapp_invite(uuid,text,text),public.sg10_redeem_whatsapp_invite(text,boolean) to authenticated;

create or replace function sg10_private.portal_snapshot(space uuid, company text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb;
begin
  if company is null or not (sg10_private.has_company(space,company) or (public.sg_is_owner(space) and coalesce(auth.jwt()->>'is_anonymous','false') <> 'true')) then raise insufficient_privilege; end if;
  if from_date is null or to_date is null or to_date<from_date or to_date-from_date>92 then
    raise exception 'Selecciona un periodo de hasta 93 días' using errcode='22023';
  end if;
  select jsonb_build_object(
    'company',c.data->>'name',
    'orders',coalesce((
      select jsonb_agg(jsonb_build_object('id',o.id,'date',o.data->>'date','product',o.data->>'product','variety',o.data->>'variety',
        'quantity',o.data->'boxes','unit',o.data->>'quantityUnit','status',o.data->>'status') order by o.data->>'date' desc,o.id)
      from public.sg_orders o where o.workspace_id=space and o.data->>'clientId'=company
        and o.data->>'date' between from_date::text and to_date::text
    ),'[]'),
    'purchases',coalesce((
      select jsonb_agg(jsonb_build_object('id',p.id,'date',p.data->>'date','product',p.data->>'product',
        'variety',p.data->>'variety','boxes',p.data->'boxes','status',p.data->>'status') order by p.data->>'date' desc,p.id)
      from public.sg_purchases p where p.workspace_id=space and p.data->>'clientId'=company
        and p.data->>'date' between from_date::text and to_date::text and p.data->>'status' in ('Comprado','Preparado','Cargado')
    ),'[]'),
    'invoices',coalesce((
      select jsonb_agg(jsonb_build_object('number',i.invoice_number,'date',i.invoice_data->>'fecha',
         'supplier',i.invoice_data->>'proveedor','total',i.invoice_data->'total') order by i.created_at desc)
      from public.sg_invoices i where i.workspace_id=space and i.invoice_data->>'client_id'=company
        and i.approved_at is not null and i.invoice_data->'visible_cliente'='true'::jsonb
        and i.invoice_data->>'fecha' between from_date::text and to_date::text
    ),'[]')
  ) into snapshot from public.sg_clients c where c.workspace_id=space and c.id=company;
  return snapshot;
end $$;
create function public.sg10_admin_portal_snapshot(space uuid,company text,from_date date,to_date date)
returns jsonb language plpgsql stable set search_path='' as $$
begin
  if not coalesce(public.sg_is_owner(space),false) or (auth.jwt()->>'is_anonymous')='true' then raise insufficient_privilege; end if;
  return sg10_private.portal_snapshot(space,company,from_date,to_date);
end $$;
revoke all on function public.sg10_admin_portal_snapshot(uuid,text,date,date) from public,anon;
grant execute on function public.sg10_admin_portal_snapshot(uuid,text,date,date) to authenticated;
notify pgrst, 'reload schema';
commit;
