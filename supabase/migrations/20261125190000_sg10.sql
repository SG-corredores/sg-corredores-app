begin;
create schema if not exists sg10_private;
revoke all on schema sg10_private from public;
grant usage on schema sg10_private to authenticated;

create table public.sg10_company_users (
  workspace_id uuid not null,
  client_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, client_id, user_id),
  foreign key (workspace_id, client_id) references public.sg_clients(workspace_id, id) on delete restrict
);
create index sg10_company_user_lookup on public.sg10_company_users(user_id);
alter table public.sg10_company_users enable row level security;
revoke all on public.sg10_company_users from public, anon, authenticated;
grant select on public.sg10_company_users to authenticated;
grant select, insert, delete on public.sg10_company_users to service_role;
create policy sg10_company_users_read on public.sg10_company_users for select to authenticated
using (user_id = (select auth.uid()) or public.sg_is_owner(workspace_id));

create function sg10_private.has_company(space uuid, company text default null)
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.sg10_company_users c
    where c.user_id = auth.uid() and c.workspace_id = space
      and (company is null or c.client_id = company)
  )
$$;
revoke all on function sg10_private.has_company(uuid,text) from public, anon;
grant execute on function sg10_private.has_company(uuid,text) to authenticated;

create policy sg10_pallets_staff on public.sg_pallets as restrictive for all to authenticated
using (public.sg_is_member(workspace_id)) with check (public.sg_is_member(workspace_id));
create policy sg10_push_scope on public.sg_push_subscriptions as restrictive for all to authenticated
using (public.sg_is_member(workspace_id) or sg10_private.has_company(workspace_id))
with check (public.sg_is_member(workspace_id) or sg10_private.has_company(workspace_id));

create table public.sg10_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.sg_workspaces(id) on delete cascade,
  client_id text,
  audience text[] not null default '{}',
  visible_to_clients boolean not null default false,
  kind text not null,
  client_name text,
  article text,
  actor uuid,
  actor_name text,
  target text not null,
  record_id text not null,
  created_at timestamptz not null default now()
);
create index sg10_events_workspace_time on public.sg10_events(workspace_id,id desc);
create table public.sg10_notice_settings (
  workspace_id uuid not null references public.sg_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  muted text[] not null default '{}',
  read_through bigint not null default 0 check (read_through >= 0),
  primary key(workspace_id,user_id)
);
create table sg10_private.push_jobs (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.sg10_events(id) on delete cascade,
  subscription_id uuid not null references public.sg_push_subscriptions(id) on delete cascade,
  attempts integer not null default 0,
  due_at timestamptz not null default now(),
  lease uuid,
  unique(event_id,subscription_id)
);
create index sg10_push_due on sg10_private.push_jobs(due_at,id);

alter table public.sg10_events enable row level security;
alter table public.sg10_notice_settings enable row level security;
revoke all on public.sg10_events,public.sg10_notice_settings from public,anon,authenticated;
grant select on public.sg10_events to authenticated;
grant select,insert,update on public.sg10_notice_settings to authenticated;
create policy sg10_setting_own on public.sg10_notice_settings for all to authenticated
using (user_id=(select auth.uid()) and (public.sg_is_member(workspace_id) or sg10_private.has_company(workspace_id)))
with check (user_id=(select auth.uid()) and (public.sg_is_member(workspace_id) or sg10_private.has_company(workspace_id)));

create function sg10_private.capture_operations() returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb; after_row jsonb; payload jsonb; row_id text; space uuid; client text;
        kinds text[] := '{}'; kind text; label text; actor_label text; target text; actor_id uuid := auth.uid();
begin
  if tg_op <> 'INSERT' then before_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then after_row := to_jsonb(new); end if;
  payload := coalesce(after_row,before_row);
  space := (payload->>'workspace_id')::uuid;
  row_id := payload->>'id';
  if tg_table_name = 'sg_orders' then
    target := 'pedidos';
    if tg_op='INSERT' then kinds := array['nuevo_pedido','nuevo_articulo'];
    elsif tg_op='DELETE' then kinds := array['pedido_eliminado'];
    elsif (before_row->'data') is distinct from (after_row->'data') then kinds := array['pedido_modificado'];
    end if;
  elsif tg_table_name = 'sg_purchases' then
    target := 'compras';
    if tg_op='DELETE' then return null; end if;
    if (after_row->'data'->>'status') in ('Comprado','Cargado') and
        coalesce(before_row->'data'->>'status','') not in ('Comprado','Cargado') then
      kinds := array_append(kinds,'articulo_comprado');
    end if;
    if (after_row->'data'->>'status')='Cargado' and (before_row->'data'->>'status') is distinct from 'Cargado' then
      kinds := array_append(kinds,'mercancia_cargada');
    end if;
  end if;
  if tg_op <> 'DELETE' then
    if coalesce(after_row->'data'->>'priceCents',after_row->'data'->>'price') is distinct from
      coalesce(before_row->'data'->>'priceCents',before_row->'data'->>'price') then
      kinds := array_append(kinds,'precio');
    end if;
    if nullif(after_row->'data'->>'supplier','') is distinct from nullif(before_row->'data'->>'supplier','') then
      kinds := array_append(kinds,'puesto');
    end if;
  end if;
  client := payload->'data'->>'clientId';
  select data->>'name' into label from public.sg_clients where workspace_id=space and id=client;
  if actor_id is not null and exists(select 1 from public.sg_members where workspace_id=space and user_id=actor_id) then
    select left(coalesce(nullif(raw_user_meta_data->>'full_name',''),split_part(email,'@',1),'Empleado'),100)
      into actor_label from auth.users where id=actor_id;
  end if;
  foreach kind in array kinds loop
    insert into public.sg10_events(workspace_id,client_id,visible_to_clients,kind,client_name,article,actor,actor_name,target,record_id)
    values(space,client,false,kind,label,left(payload->'data'->>'product',160),actor_id,actor_label,target,row_id);
    if client is not null and kind in ('nuevo_pedido','articulo_comprado','mercancia_cargada','pedido_eliminado') then
      insert into public.sg10_events(workspace_id,client_id,visible_to_clients,kind,client_name,article,target,record_id)
      values(space,client,true,kind,label,left(payload->'data'->>'product',160),target,row_id);
    end if;
  end loop;
  return null;
end $$;
create trigger sg10_order_events after insert or update or delete on public.sg_orders for each row execute function sg10_private.capture_operations();
create trigger sg10_purchase_events after insert or update or delete on public.sg_purchases for each row execute function sg10_private.capture_operations();
-- Staff see the detailed copy, and clients see the redacted copy for their company.
create policy sg10_events_read on public.sg10_events for select to authenticated using (
  (not visible_to_clients and public.sg_is_member(workspace_id)) or
  (visible_to_clients and exists (
    select 1 from public.sg10_company_users m where m.workspace_id=sg10_events.workspace_id and m.user_id=(select auth.uid())
    and ((sg10_events.client_id is not null and m.client_id=sg10_events.client_id)
      or (sg10_events.client_id is null and (cardinality(audience)=0 or m.client_id=any(audience))))
  ))
);
create function sg10_private.queue_push() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into sg10_private.push_jobs(event_id, subscription_id)
  select new.id,s.id from public.sg_push_subscriptions s
  left join public.sg10_notice_settings p on p.workspace_id=s.workspace_id and p.user_id=s.user_id
  where s.workspace_id=new.workspace_id
    and not (new.kind=any(coalesce(p.muted,'{}'::text[])))
    and ((not new.visible_to_clients and exists (
      select 1 from public.sg_members m where m.workspace_id=s.workspace_id and m.user_id=s.user_id))
      or (new.visible_to_clients and exists (
        select 1 from public.sg10_company_users m where m.workspace_id=s.workspace_id and m.user_id=s.user_id
        and ((new.client_id is not null and new.client_id=m.client_id)
          or (new.client_id is null and (cardinality(new.audience)=0 or m.client_id=any(new.audience))))
      )))
  on conflict do nothing;
  return new;
end $$;

create trigger sg10_enqueue after insert on public.sg10_events for each row execute function sg10_private.queue_push();

create function public.sg10_claim_push(p_limit integer default 24)
returns table(job_id bigint, token uuid, endpoint text, p256dh text, auth_key text, kind text, event_id bigint, portal boolean, client_name text, article text, actor_name text, occurred_at timestamptz)
language sql security definer set search_path='' as $$
  with selected as (
    select j.id from sg10_private.push_jobs j where j.due_at<=now() and j.attempts<8
    order by j.due_at,j.id limit least(greatest(coalesce(p_limit,24),1),40) for update skip locked
  ), claimed as (
    update sg10_private.push_jobs j set attempts=j.attempts+1,due_at=now()+interval '2 minutes',lease=gen_random_uuid()
    from selected q where j.id=q.id returning j.*
  )
  select j.id,j.lease,
    case when not (e.kind=any(coalesce(n.muted,'{}'::text[]))) and
      ((not e.visible_to_clients and exists(select 1 from public.sg_members m where m.workspace_id=e.workspace_id and m.user_id=s.user_id))
        or (e.visible_to_clients and exists(select 1 from public.sg10_company_users m where m.workspace_id=e.workspace_id and m.user_id=s.user_id
        and ((e.client_id is not null and m.client_id=e.client_id)
          or (e.client_id is null and (cardinality(e.audience)=0 or m.client_id=any(e.audience))))))) then s.endpoint end,
    s.p256dh,s.auth,e.kind,e.id,e.visible_to_clients,e.client_name,e.article,e.actor_name,e.created_at
  from claimed j join public.sg10_events e on e.id=j.event_id join public.sg_push_subscriptions s on s.id=j.subscription_id
  left join public.sg10_notice_settings n on n.workspace_id=s.workspace_id and n.user_id=s.user_id;
$$;
create function public.sg10_finish_push(p_id bigint,p_token uuid,p_result text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_result='gone' then
    delete from public.sg_push_subscriptions s using sg10_private.push_jobs j where j.id=p_id and j.lease=p_token and s.id=j.subscription_id;
  elsif p_result='retry' then
    update sg10_private.push_jobs set due_at=now()+make_interval(mins=>least(60,power(2,attempts)::int)),lease=null
    where id=p_id and lease=p_token and attempts<8;
  else
    delete from sg10_private.push_jobs where id=p_id and lease=p_token;
  end if;
end $$;
revoke all on function public.sg10_claim_push(integer),public.sg10_finish_push(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.sg10_claim_push(integer),public.sg10_finish_push(bigint,uuid,text) to service_role;

create function sg10_private.portal_snapshot(space uuid, company text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb;
begin
  if not sg10_private.has_company(space,company) or company is null then raise insufficient_privilege; end if;
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

create table sg10_private.portal_requests (
  user_id uuid not null, request_id uuid not null, workspace_id uuid not null, client_id text not null,
  day date not null, lines jsonb not null, primary key (user_id,request_id)
);
create function sg10_private.portal_order(space uuid,company text,request uuid,day date,lines jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; idx integer:=0; product text; unit text; amount numeric; created integer:=0;
  madrid date := (now() at time zone 'Europe/Madrid')::date;
begin
  if not sg10_private.has_company(space,company) or company is null then raise insufficient_privilege; end if;
  if request is null or day is null or day<madrid or day>madrid+30 or lines is null or jsonb_typeof(lines)<>'array' then
    raise exception 'Fecha o pedido no válido' using errcode='22023'; end if;
  if jsonb_array_length(lines) not between 1 and 30 then raise exception 'Introduce de 1 a 30 artículos'; end if;
  insert into sg10_private.portal_requests values(auth.uid(),request,space,company,day,lines)
    on conflict do nothing;
  if not found then
    if not exists (select 1 from sg10_private.portal_requests x where x.user_id=auth.uid() and x.request_id=request
      and x.workspace_id=space and x.client_id=company and x.day=portal_order.day and x.lines=portal_order.lines) then
      raise exception 'La referencia del pedido ya está en uso';
    end if;
    return 0;
  end if;
  for item in select value from jsonb_array_elements(lines) loop
    idx:=idx+1; product:=btrim(coalesce(item->>'product','')); unit:=item->>'unit';
    if jsonb_typeof(item->'quantity') is distinct from 'number' or unit is null or unit not in ('cajas','pales')
      or length(product) not between 1 and 120 or length(coalesce(item->>'variety',''))>120 or length(coalesce(item->>'notes',''))>750 then
      raise exception 'Artículo % incompleto',idx using errcode='22023'; end if;
    amount:=(item->>'quantity')::numeric;
    if amount<=0 or amount>100000 or scale(amount)>3 then raise exception 'Cantidad inválida en artículo %',idx using errcode='22023'; end if;
    insert into public.sg_orders(workspace_id,id,data,updated_by)
      values(space,'portal:'||auth.uid()||':'||request||':'||idx,jsonb_build_object(
        'date',day,'clientId',company,'product',product,'variety',coalesce(item->>'variety',''),
        'boxes',amount,'quantityUnit',unit,'status','Pendiente','notes',coalesce(item->>'notes',''),'origin','portal'),auth.uid())
      ;
    created:=created+1;
  end loop;
  return created;
end $$;
create function public.sg10_portal_snapshot(space uuid,company text,from_date date,to_date date) returns jsonb
language sql stable set search_path='' as $$select sg10_private.portal_snapshot(space,company,from_date,to_date)$$;
create function public.sg10_portal_order(space uuid,company text,request uuid,day date,lines jsonb) returns integer
language sql set search_path='' as $$select sg10_private.portal_order(space,company,request,day,lines)$$;
revoke all on function sg10_private.portal_snapshot(uuid,text,date,date),sg10_private.portal_order(uuid,text,uuid,date,jsonb),
public.sg10_portal_snapshot(uuid,text,date,date),public.sg10_portal_order(uuid,text,uuid,date,jsonb) from public,anon;
grant execute on function sg10_private.portal_snapshot(uuid,text,date,date),sg10_private.portal_order(uuid,text,uuid,date,jsonb),
public.sg10_portal_snapshot(uuid,text,date,date),public.sg10_portal_order(uuid,text,uuid,date,jsonb) to authenticated;

create index sg10_orders_company_date on public.sg_orders(workspace_id,(data->>'clientId'),(data->>'date'));
create index sg10_purchases_company_date on public.sg_purchases(workspace_id,(data->>'clientId'),(data->>'date'));

create table public.sg10_gallery (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sg_workspaces(id) on delete cascade,
  client_id text,
  product text not null check(char_length(product) between 1 and 120),
  description text not null default '' check(char_length(description)<=1000),
  image_path text not null check(split_part(image_path,'/',1)=workspace_id::text),
  price numeric(12,2) check(price>=0),
  unit text check(unit in ('kg','caja','palé','unidad')),
  check((price is null)=(unit is null)),
  foreign key (workspace_id,client_id) references public.sg_clients(workspace_id,id) on delete restrict,
  updated_at timestamptz not null default now()
);
create index sg10_gallery_workspace on public.sg10_gallery(workspace_id,updated_at desc);
alter table public.sg10_gallery enable row level security;
revoke all on public.sg10_gallery from public,anon,authenticated;
grant select,insert,update,delete on public.sg10_gallery to authenticated;
create policy sg10_gallery_read on public.sg10_gallery for select to authenticated
using (public.sg_is_member(workspace_id) or sg10_private.has_company(workspace_id,client_id));
create policy sg10_gallery_staff on public.sg10_gallery for all to authenticated
using (public.sg_is_member(workspace_id)) with check (public.sg_is_member(workspace_id));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('sg10-productos','sg10-productos',false,5242880,array['image/jpeg','image/png','image/webp']);
create policy sg10_gallery_images_staff on storage.objects for all to authenticated
using (bucket_id='sg10-productos' and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.sg_is_member((case when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then (storage.foldername(name))[1] end)::uuid))
with check (bucket_id='sg10-productos' and public.sg_is_member((case when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then (storage.foldername(name))[1] end)::uuid));
create policy sg10_gallery_images_customer on storage.objects for select to authenticated using (
  bucket_id='sg10-productos' and exists (select 1 from public.sg10_gallery g
  where g.image_path=name and sg10_private.has_company(g.workspace_id,g.client_id))
);
create function sg10_private.gallery_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.sg10_events(workspace_id,client_id,visible_to_clients,kind,article,actor,target,record_id)
    values(new.workspace_id,new.client_id,false,'nueva_foto',new.product,auth.uid(),'galeria',new.id::text);
  insert into public.sg10_events(workspace_id,client_id,visible_to_clients,kind,article,target,record_id)
    values(new.workspace_id,new.client_id,true,'nueva_foto',new.product,'galeria',new.id::text);
  return new;
end $$;
create trigger sg10_gallery_notice after insert on public.sg10_gallery for each row execute function sg10_private.gallery_event();

grant select,insert,update on public.sg_invoices to authenticated,service_role;
alter table public.sg_invoices add column sg10_pdf_hash text check(sg10_pdf_hash ~ '^[a-f0-9]{64}$');
alter table public.sg_invoices add column sg10_fiscal_key text;
create unique index sg10_invoice_file on public.sg_invoices(workspace_id,sg10_pdf_hash);
create unique index sg10_invoice_fiscal on public.sg_invoices(workspace_id,sg10_fiscal_key);
create function sg10_private.label(value text) returns text
language sql immutable set search_path='' as $$
  select btrim(regexp_replace(translate(lower(coalesce(value,'')),'áéíóúüñ','aeiouun'),'[^a-z0-9]+',' ','g'))
$$;
create function sg10_private.product(value text) returns text
language sql immutable set search_path='' as $$
  select regexp_replace(regexp_replace(regexp_replace(sg10_private.label(value),'\mpat\M','patata','g'),'\mceb\M','cebolla','g'),'([a-z]{4,})s\M','\1','g')
$$;
create function sg10_private.number(value text) returns numeric
language sql immutable set search_path='' as $$
  select case when length(value)<30 and value ~ '^-?[0-9]+([.][0-9]+)?$' then value::numeric end
$$;
create function sg10_private.invoice_event() returns trigger language plpgsql security definer set search_path='' as $$
declare company text:=new.invoice_data->>'client_id'; day text:=new.invoice_data->>'fecha'; line jsonb;
  n int; n_supplier int; n_weight int; n_price int; cb numeric; ck numeric; expected_boxes numeric; expected_kg numeric;
  expected_price numeric; detail text; item text; provider text;
begin
  insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
  values(new.workspace_id,company,'factura_recibida',new.customer_name,new.invoice_number,auth.uid(),'facturas',new.id::text);
  if not exists (select 1 from public.sg_orders o where o.workspace_id=new.workspace_id
    and o.data->>'clientId'=company and o.data->>'date'=day and coalesce(o.data->>'status','') not in ('Cancelado','Anulado')) then
    insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
    values(new.workspace_id,company,'factura_sin_pedido',new.customer_name,new.invoice_number,auth.uid(),'facturas',new.id::text);
  end if;
  if new.invoice_data->>'tipo'='abono' then
    detail:='Abono pendiente de vincular y validar';
  elsif new.sg10_fiscal_key is null or company is null then
    detail:='Falta identificar empresa, fecha, número o CIF';
  elsif jsonb_typeof(new.invoice_data->'lineas') is distinct from 'array' then
    detail:='No se pudieron identificar las líneas';
  else
    provider:=sg10_private.label(new.invoice_data->>'proveedor');
    for line in select value from jsonb_array_elements(new.invoice_data->'lineas') loop
      item:=left(coalesce(line->>'producto','Mercancía'),75);
      expected_boxes:=sg10_private.number(line->>'cajas');
      expected_kg:=sg10_private.number(line->>'kilos_netos');
      expected_price:=sg10_private.number(line->>'precio');
      select count(*),count(*) filter(where puesto=provider and provider<>''),count(kg) filter(where puesto=provider and provider<>''),
        sum(boxes) filter(where puesto=provider and provider<>''),sum(kg) filter(where puesto=provider and provider<>''),
        count(*) filter(where puesto=provider and provider<>'' and abs(price-expected_price)<0.0001)
      into n,n_supplier,n_weight,cb,ck,n_price
      from (
        select sg10_private.label(data->>'supplier') as puesto,sg10_private.number(data->>'boxes') as boxes,
          case when data->>'weightMode'='fixed' then sg10_private.number(data->>'boxes')*sg10_private.number(data->>'kgPerBox')
            else nullif(sg10_private.number(data->>'kg'),0) end as kg,
          coalesce(sg10_private.number(data->>'priceCents')/100,sg10_private.number(data->>'price')) as price
        from public.sg_purchases where workspace_id=new.workspace_id and data->>'clientId'=company and data->>'date'=day
          and coalesce(data->>'status','') not in ('Cancelado','Anulado')
          and sg10_private.product(data->>'product')=sg10_private.product(line->>'producto')
      ) matched;
      detail:=case when n=0 then item||': compra no encontrada'
        when n_supplier=0 then item||': asentador distinto o sin identificar'
        else nullif(concat_ws(' · ',
          case when expected_boxes is not null and (cb is null or abs(cb-expected_boxes)>0.001) then item||': bultos distintos o pendientes' end,
          case when expected_kg is not null and (n_weight<>n_supplier or abs(ck-expected_kg)>0.01) then item||': kilos distintos o pendientes' end,
          case when expected_price is not null and n_price<>n_supplier then item||': precio distinto o pendiente' end),'')
        end;
      if detail is not null then
        insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
        values(new.workspace_id,company,'factura_discrepancia',new.customer_name,detail,auth.uid(),'facturas',new.id::text);
      end if;
    end loop;
    if jsonb_array_length(new.invoice_data->'lineas')=0 then detail:='No se pudieron identificar las líneas'; else detail:=null; end if;
  end if;
  if detail is not null then
    insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
    values(new.workspace_id,company,'factura_discrepancia',new.customer_name,detail,auth.uid(),'facturas',new.id::text);
  end if;
  return new;
end $$;
create trigger sg10_invoice_notice after insert on public.sg_invoices for each row execute function sg10_private.invoice_event();

create table public.sg10_commission_reviews (
  workspace_id uuid not null,
  client_id text not null,
  date_from date not null,
  date_to date not null check(date_to>=date_from),
  fingerprint text not null,
  status text not null default 'pendiente' check(status in ('pendiente','revisada','enviada')),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key(workspace_id,client_id,date_from,date_to),
  foreign key(workspace_id,client_id) references public.sg_clients(workspace_id,id) on delete restrict
);
alter table public.sg10_commission_reviews enable row level security;
revoke all on public.sg10_commission_reviews from public,anon,authenticated;
grant select,insert,update on public.sg10_commission_reviews to authenticated;
create policy sg10_commissions_read on public.sg10_commission_reviews for select to authenticated
using (public.sg_is_member(workspace_id));
create policy sg10_commissions_owner on public.sg10_commission_reviews for all to authenticated
using(public.sg_is_owner(workspace_id)) with check(public.sg_is_owner(workspace_id) and updated_by=auth.uid());
create function sg10_private.commission_event() returns trigger language plpgsql security definer set search_path='' as $$
declare label text;
begin
  if new.status='pendiente' and (tg_op='INSERT' or new.status is distinct from old.status or new.fingerprint is distinct from old.fingerprint) then
    select data->>'name' into label from public.sg_clients where workspace_id=new.workspace_id and id=new.client_id;
    insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
    values(new.workspace_id,new.client_id,'comision_revision',label,new.date_from::text||' a '||new.date_to::text,auth.uid(),'comisiones',new.client_id);
  end if;
  return new;
end $$;
create trigger sg10_commission_notice after insert or update on public.sg10_commission_reviews for each row execute function sg10_private.commission_event();

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array['sg_orders','sg_purchases','sg_clients','sg_pallets','sg10_events','sg10_gallery'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
        execute format('alter publication supabase_realtime add table public.%I',t);
      end if;
    end loop;
  end if;
end $$;
create function public.sg10_customer_by_email(p_email text) returns uuid
language sql stable security definer set search_path='' as $$
  select id from auth.users where lower(email)=lower(p_email) and not is_anonymous limit 1
$$;
revoke all on function public.sg10_customer_by_email(text) from public,anon,authenticated;
grant execute on function public.sg10_customer_by_email(text) to service_role;

create table sg10_private.ai_quota (user_id uuid primary key, minute timestamptz not null, count integer not null);
create function public.sg10_ai_allow(p_user uuid) returns boolean
language sql security definer set search_path='' as $$
  with hit as (
    insert into sg10_private.ai_quota as q(user_id,minute,count) values(p_user,date_trunc('minute',now()),1)
    on conflict(user_id) do update set minute=excluded.minute,count=case when q.minute=excluded.minute then q.count+1 else 1 end
    returning count
  ) select count<=10 from hit
$$;
revoke all on function public.sg10_ai_allow(uuid) from public,anon,authenticated;
grant execute on function public.sg10_ai_allow(uuid) to service_role;

create table sg10_private.staff_requests (
  workspace_id uuid not null, user_id uuid not null, request_id uuid not null, lines jsonb not null,
  primary key(workspace_id,user_id,request_id)
);
create function sg10_private.staff_order(space uuid,request uuid,lines jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; idx integer:=0; product text; client text; unit text; qty numeric; day date; price numeric; price_unit text;
begin
  if auth.uid() is null or not public.sg_is_member(space) then raise insufficient_privilege; end if;
  if request is null or lines is null or jsonb_typeof(lines)<>'array' then raise exception 'Pedido inválido'; end if;
  if jsonb_array_length(lines) not between 1 and 30 then raise exception 'Introduce de 1 a 30 artículos'; end if;
  insert into sg10_private.staff_requests values(space,auth.uid(),request,lines) on conflict do nothing;
  if not found then
    if not exists (select 1 from sg10_private.staff_requests r where r.workspace_id=space and r.user_id=auth.uid()
          and r.request_id=request and r.lines=staff_order.lines) then raise exception 'La referencia del pedido ya está en uso'; end if;
    return 0;
  end if;
  for item in select value from jsonb_array_elements(lines) loop
    product:=btrim(coalesce(item->>'product','')); client:=item->>'clientId'; unit:=item->>'quantityUnit'; day:=(item->>'date')::date;
    if product='' or length(product)>120 or unit is null or unit not in ('cajas','pales') or day is null or day<date '2000-01-01'
        or day>(now() at time zone 'Europe/Madrid')::date+365 or jsonb_typeof(item->'boxes') is distinct from 'number'
        or length(coalesce(item->>'variety',''))>120 or length(coalesce(item->>'notes',''))>750
        or not exists(select 1 from public.sg_clients c where c.workspace_id=space and c.id=client) then
      raise exception 'Artículo % incompleto',idx+1;
    end if;
    qty:=(item->>'boxes')::numeric;
    price:=sg10_private.number(item->>'price');
    price_unit:=item->>'priceUnit';
    if price is not null and (price<0 or scale(price)>2 or price_unit is null or price_unit not in ('kg','caja','pale')) then
      raise exception 'Precio inválido en artículo %',idx+1;
    end if;
    if qty<=0 or qty>100000 or scale(qty)>3 then raise exception 'Cantidad incorrecta'; end if;
    idx:=idx+1;
    insert into public.sg_orders(workspace_id,id,data)
      values(space,'agu:'||auth.uid()||':'||request||':'||idx,jsonb_build_object(
        'date',day,'clientId',client,'product',product,'variety',coalesce(item->>'variety',''),'notes',coalesce(item->>'notes',''),
        'boxes',qty,'quantityUnit',unit,'status','Pendiente','origin','sg10','price',price,'priceCents',(price*100)::bigint,
        'priceUnit',price_unit,'sourceMessage',left(item->>'sourceMessage',5500)));
  end loop;
  return idx;
end $$;
create function public.sg10_staff_order(space uuid,request uuid,lines jsonb) returns integer
language sql set search_path='' as $$select sg10_private.staff_order(space,request,lines)$$;
revoke all on function sg10_private.staff_order(uuid,uuid,jsonb),public.sg10_staff_order(uuid,uuid,jsonb) from public,anon;
grant execute on function sg10_private.staff_order(uuid,uuid,jsonb),public.sg10_staff_order(uuid,uuid,jsonb) to authenticated;

create table public.sg10_camera_counts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id text not null,
  day date not null,
  kind text not null check(kind in ('cajas','bultos','pales')),
  expected numeric,
  measured numeric not null check(measured>=0 and measured<=100000),
  image_hash text not null check(image_hash ~ '^[a-f0-9]{64}$'),
  barcode_labels text[] not null default '{}',
  confirmed_by uuid not null default auth.uid(),
  confirmed_at timestamptz not null default now(),
  unique(workspace_id,client_id,day,kind,image_hash),
  foreign key(workspace_id,client_id) references public.sg_clients(workspace_id,id) on delete restrict
);
alter table public.sg10_camera_counts enable row level security;
revoke all on public.sg10_camera_counts from public,anon,authenticated;
grant select,insert on public.sg10_camera_counts to authenticated;
create policy sg10_counts_read on public.sg10_camera_counts for select to authenticated using(public.sg_is_member(workspace_id));
create policy sg10_counts_insert on public.sg10_camera_counts for insert to authenticated
with check(public.sg_is_member(workspace_id) and confirmed_by=auth.uid());

alter table public.sg_invoices add column sg10_original_id uuid references public.sg_invoices(id) on delete restrict;
create index sg10_credits_original on public.sg_invoices(sg10_original_id) where sg10_original_id is not null;
create function public.sg10_invoice_review(space uuid,invoice_id uuid,old_data jsonb,old_status text,fields jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare orig uuid:=nullif(fields->>'original_id','')::uuid; kind text:=fields->'invoice_data'->>'tipo';
  doc jsonb:=fields->'invoice_data'; original jsonb; used numeric; amount numeric;
  approved boolean:=fields->>'status'='approved';
begin
  if not public.sg_is_owner(space) then raise insufficient_privilege; end if;
  if kind='abono' and approved then
    select i.invoice_data into original from public.sg_invoices i where i.workspace_id=space and i.id=orig
      and i.id<>invoice_id and i.status='approved' and i.approved_at is not null and i.invoice_data->>'tipo'='factura'
      for no key update;
    if not found or original->>'client_id' is distinct from doc->>'client_id'
      or sg10_private.label(original->>'cif_proveedor') is distinct from sg10_private.label(doc->>'cif_proveedor') then
      raise exception 'Vincula el abono a una factura aprobada del mismo cliente y asentador';
    end if;
    amount:=abs(sg10_private.number(doc->>'total'));
    select coalesce(sum(abs(sg10_private.number(i.invoice_data->>'total'))),0) into used from public.sg_invoices i
      where i.workspace_id=space and i.sg10_original_id=orig and i.id<>invoice_id and i.status='approved' and i.approved_at is not null;
    if amount is null or amount<=0 or sg10_private.number(original->>'total') is null
      or used+amount>sg10_private.number(original->>'total') then
      raise exception 'El abono supera el importe disponible de la factura original';
    end if;
  elsif kind='factura' then
    if exists(select 1 from public.sg_invoices i where i.workspace_id=space and i.sg10_original_id=invoice_id and i.status='approved')
      and (not approved or doc is distinct from old_data) then
      raise exception 'Hay abonos aprobados vinculados a esta factura. Revisa y rectifica esos abonos antes de modificarla';
    end if;
    orig:=null;
  else
    orig:=null;
  end if;
  update public.sg_invoices i set invoice_number=fields->>'invoice_number', customer_name=coalesce(fields->>'customer_name',i.customer_name),
    sg10_fiscal_key=fields->>'sg10_fiscal_key', sg10_original_id=orig, invoice_data=doc,status=fields->>'status',
    approved_by=case when approved then auth.uid() end,
    approved_at=case when approved then now() end
  where i.workspace_id=space and i.id=invoice_id and i.invoice_data=old_data and i.status=old_status;
  return found;
end $$;
revoke all on function public.sg10_invoice_review(uuid,uuid,jsonb,text,jsonb) from public,anon;
grant execute on function public.sg10_invoice_review(uuid,uuid,jsonb,text,jsonb) to authenticated;

create view public.sg10_invoice_balances with (security_invoker=true) as
select f.workspace_id,f.id,f.invoice_number,f.customer_name,f.invoice_data->>'client_id' as client_id,
  f.invoice_data->>'fecha' as day,sg10_private.number(f.invoice_data->>'total') as gross,
  coalesce(a.credit,0) as credit,sg10_private.number(f.invoice_data->>'total')-coalesce(a.credit,0) as net
from public.sg_invoices f
left join lateral (
  select sum(abs(sg10_private.number(c.invoice_data->>'total'))) as credit from public.sg_invoices c
  where c.workspace_id=f.workspace_id and c.sg10_original_id=f.id and c.approved_at is not null and c.status='approved'
    and c.invoice_data->>'tipo'='abono'
) a on true
where f.approved_at is not null and f.status='approved' and f.invoice_data->>'tipo'='factura';
revoke all on public.sg10_invoice_balances from public,anon,authenticated;
grant select on public.sg10_invoice_balances to authenticated;

create table sg10_private.purchase_requests (
  workspace_id uuid not null, user_id uuid not null, request_id uuid not null,
  order_id text not null, lines jsonb not null, primary key(workspace_id,user_id,request_id)
);
create function sg10_private.split_purchase(space uuid,order_id text,request uuid,lines jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; order_data jsonb; amount numeric; kg numeric; boxes numeric; price numeric; used numeric;
  total numeric:=0; idx integer:=0; supplier text; unit text; places text[]:='{}';
begin
  if auth.uid() is null or not public.sg_is_member(space) then raise insufficient_privilege; end if;
  if request is null or lines is null or jsonb_typeof(lines)<>'array' then raise exception 'Compra inválida'; end if;
  if jsonb_array_length(lines) not between 2 and 12 then raise exception 'Introduce de 2 a 12 puestos'; end if;
  insert into sg10_private.purchase_requests values(space,auth.uid(),request,order_id,lines) on conflict do nothing;
  if not found then
    if not exists(select 1 from sg10_private.purchase_requests p where p.workspace_id=space and p.user_id=auth.uid()
      and p.request_id=request and p.order_id=split_purchase.order_id and p.lines=split_purchase.lines) then
      raise exception 'La referencia de compra ya está en uso';
    end if;
    return 0;
  end if;
  select o.data into order_data from public.sg_orders o where o.workspace_id=space and o.id=order_id for no key update;
  if not found or coalesce(order_data->>'status','') in ('Cancelado','Anulado')
    or order_data->>'quantityUnit' is distinct from 'pales' then raise exception 'Selecciona un pedido activo en palés'; end if;
  select coalesce(sum((p.data->>'sgBoughtPallets')::numeric),0) into used from public.sg_purchases p
    where p.workspace_id=space and p.data->>'orderId'=order_id and coalesce(p.data->>'status','') not in ('Anulado','Cancelado')
      and coalesce(p.data->>'sgBoughtPallets','') ~ '^\d+(\.\d+)?$';
  for item in select value from jsonb_array_elements(lines) loop
    supplier:=btrim(coalesce(item->>'supplier','')); unit:=item->>'priceUnit';
    if supplier='' or length(supplier)>160 or lower(supplier)=any(places) then raise exception 'Cada puesto debe ser distinto'; end if;
    if jsonb_typeof(item->'amount') is distinct from 'number' then raise exception 'Cantidad de palés incorrecta'; end if;
    amount:=(item->>'amount')::numeric; kg:=(item->>'kg')::numeric; boxes:=(item->>'boxes')::numeric;price:=(item->>'price')::numeric;
    if amount<=0 or amount>1000 or mod(amount,0.5)<>0 or coalesce(kg,0)<0 or coalesce(boxes,0)<0 or coalesce(price,0)<0
      or coalesce(scale(price),0)>2 or (price is not null and (unit is null or unit not in ('kg','caja','pale'))) then
      raise exception 'Revisa cantidades y precio de %',supplier;
    end if;
    places:=array_append(places,lower(supplier)); total:=total+amount; idx:=idx+1;
    insert into public.sg_purchases(workspace_id,id,data) values(space,'reparto:'||auth.uid()||':'||request||':'||idx,
      jsonb_build_object('date',order_data->>'date','clientId',order_data->>'clientId','orderId',order_id,
      'product',order_data->>'product','variety',coalesce(order_data->>'variety',''),'quantityUnit','pales',
      'requestedQuantity',order_data->'boxes','sgBoughtPallets',amount,'supplier',supplier,'boxes',coalesce(boxes,0),'kg',kg,
      'weightMode','real','kgPerBox',null,'priceCents',case when price is not null then (price*100)::bigint end,
      'price',price,'priceUnit',coalesce(unit,'kg'),'status','Comprado','notes','Compra repartida entre puestos'));
  end loop;
  if used+total>(order_data->>'boxes')::numeric then raise exception 'El reparto supera los palés pendientes del pedido'; end if;
  return idx;
end $$;
create function public.sg10_split_purchase(space uuid,order_id text,request uuid,lines jsonb) returns integer
language sql set search_path='' as $$select sg10_private.split_purchase(space,order_id,request,lines)$$;
revoke all on function sg10_private.split_purchase(uuid,text,uuid,jsonb),public.sg10_split_purchase(uuid,text,uuid,jsonb) from public,anon;
grant execute on function sg10_private.split_purchase(uuid,text,uuid,jsonb),public.sg10_split_purchase(uuid,text,uuid,jsonb) to authenticated;

create unique index sg10_unique_pallet_number on public.sg_pallets(workspace_id,(data->>'date'),(data->>'clientId'),lower(data->>'number'))
where data ? 'date' and data ? 'clientId' and data ? 'number';
create table public.sg10_gmail_messages (
  workspace_id uuid not null references public.sg_workspaces(id) on delete cascade,
  message_id text not null,
  processed_at timestamptz not null default now(),
  primary key(workspace_id,message_id)
);
create table public.sg10_gmail_cursor (
  workspace_id uuid primary key references public.sg_workspaces(id) on delete cascade,
  page_token text,
  updated_at timestamptz not null default now()
);
alter table public.sg10_gmail_messages enable row level security;
alter table public.sg10_gmail_cursor enable row level security;
revoke all on public.sg10_gmail_messages, public.sg10_gmail_cursor from public, anon, authenticated;
grant select, insert, update on public.sg10_gmail_messages, public.sg10_gmail_cursor to service_role;
grant insert on public.sg10_events to service_role;
grant usage on sequence public.sg10_events_id_seq to service_role;

create unique index sg10_unique_incident on public.sg10_events(workspace_id,record_id) where kind='incidencia';
create function public.sg10_gmail_incident(space uuid,mail_id text,subject text) returns void
language sql security definer set search_path='' as $$
  insert into public.sg10_events(workspace_id,kind,article,target,record_id)
  values(space,'incidencia',left(subject,150),'facturas',mail_id)
  on conflict do nothing
$$;
revoke all on function public.sg10_gmail_incident(uuid,text,text) from public,anon,authenticated;
grant execute on function public.sg10_gmail_incident(uuid,text,text) to service_role;

notify pgrst, 'reload schema';
commit;
