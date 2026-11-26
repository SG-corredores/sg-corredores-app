create table public.sg10_purchase_assignments (
  workspace_id uuid not null,
  order_id text not null,
  assignee uuid,
  revision bigint not null default 1,
  primary key (workspace_id, order_id),
  foreign key (workspace_id, order_id) references public.sg_orders(workspace_id,id) on delete cascade
);
alter table public.sg10_purchase_assignments enable row level security;
revoke all on public.sg10_purchase_assignments from public, anon, authenticated;
grant select on public.sg10_purchase_assignments to authenticated;
create policy sg10_read_purchase_assignments on public.sg10_purchase_assignments
  for select to authenticated using (public.sg_is_member(workspace_id));

create table public.sg10_staff_names (
  workspace_id uuid not null,
  user_id uuid not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 60),
  primary key (workspace_id,user_id),
  foreign key (workspace_id,user_id) references public.sg_members(workspace_id,user_id) on delete cascade
);
alter table public.sg10_staff_names enable row level security;
revoke all on public.sg10_staff_names from public, anon, authenticated;
grant select, insert, update on public.sg10_staff_names to authenticated;
create policy sg10_read_staff_names on public.sg10_staff_names
  for select to authenticated using (public.sg_is_member(workspace_id));
create policy sg10_insert_staff_names on public.sg10_staff_names
  for insert to authenticated with check (public.sg_is_owner(workspace_id));
create policy sg10_update_staff_names on public.sg10_staff_names
  for update to authenticated using (public.sg_is_owner(workspace_id)) with check (public.sg_is_owner(workspace_id));

create index sg10_purchases_order_id on public.sg_purchases(workspace_id,(data->>'orderId')) where data->>'orderId' is not null;

alter publication supabase_realtime add table public.sg10_purchase_assignments, public.sg10_staff_names;

-- A private list can become a shared assignment only when there was a single claimant.
insert into public.sg10_purchase_assignments(workspace_id,order_id,assignee)
select p.workspace_id,p.order_id,min(p.user_id::text)::uuid
from public.sg_personal_buy p
join public.sg_orders o on o.workspace_id=p.workspace_id and o.id=p.order_id
join public.sg_members m on m.workspace_id=p.workspace_id and m.user_id=p.user_id
where coalesce(o.data->>'status','') not in ('Cancelado','Anulado','Comprado','Cargado','Preparado','Completado','Entregado')
group by p.workspace_id,p.order_id having count(*)=1;

create function sg10_private.confirmed_purchase_quantity(purchase jsonb, order_unit text)
returns numeric language sql immutable set search_path='' as $$
  select case when purchase->>'status' in ('Comprado','Cargado','Preparado','Completado','Entregado')
    and coalesce(nullif(purchase->>'quantityUnit',''),'cajas')=order_unit
    then greatest(0,coalesce(sg10_private.number(case when order_unit='pales' then purchase->>'sgBoughtPallets' else purchase->>'boxes' end),0))
    else 0 end
$$;

create function sg10_private.change_purchase_assignments(space uuid, changes jsonb, target uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; order_key text; order_data jsonb; current_assignee uuid; current_revision bigint;
  actor uuid:=auth.uid(); owner_access boolean; processed integer:=0;
begin
  if actor is null or not public.sg_is_member(space) then raise insufficient_privilege; end if;
  owner_access:=public.sg_is_owner(space);
  if target is not null and (not exists(select 1 from public.sg_members m where m.workspace_id=space and m.user_id=target)
    or (not owner_access and target<>actor)) then raise insufficient_privilege; end if;
  if jsonb_typeof(changes) is distinct from 'array' then raise exception 'Selección inválida'; end if;
  if jsonb_array_length(changes) not between 1 and 500 then raise exception 'Selecciona entre 1 y 500 líneas'; end if;

  for item in select value from jsonb_array_elements(changes) order by value->>'id' loop
    order_key:=item->>'id';
    select o.data into order_data from public.sg_orders o
    where o.workspace_id=space and o.id=order_key for no key update;
    if not found or (target is not null and coalesce(order_data->>'status','') in
      ('Cancelado','Anulado','Comprado','Cargado','Preparado','Completado','Entregado')) then
      raise exception 'El pedido ya no está disponible';
    end if;
    select a.assignee,a.revision into current_assignee,current_revision
    from public.sg10_purchase_assignments a where a.workspace_id=space and a.order_id=order_key;
    if coalesce(current_revision,0) is distinct from (item->>'revision')::bigint then
      raise exception 'Otra persona cambió esta asignación. Revisa la lista y vuelve a intentarlo.' using errcode='40001';
    end if;
    if not owner_access and current_assignee is not null and current_assignee<>actor and exists (
      select 1 from public.sg_members m where m.workspace_id=space and m.user_id=current_assignee
    ) then
      raise exception 'La mercancía está asignada a otro empleado' using errcode='42501';
    end if;
    if target is not null and coalesce(sg10_private.number(order_data->>'boxes'),0) <= (
      select coalesce(sum(sg10_private.confirmed_purchase_quantity(p.data,coalesce(nullif(order_data->>'quantityUnit',''),'cajas'))),0)
      from public.sg_purchases p where p.workspace_id=space and p.data->>'orderId'=order_key
    ) then raise exception 'La mercancía ya está comprada o su cantidad no es válida'; end if;
    if current_assignee is distinct from target then
      insert into public.sg10_purchase_assignments as assignment(workspace_id,order_id,assignee)
      values(space,order_key,target)
      on conflict(workspace_id,order_id) do update set assignee=excluded.assignee,revision=assignment.revision+1;
      processed:=processed+1;
    end if;
  end loop;
  return processed;
end
$$;

create function public.sg10_change_purchase_assignments(space uuid, changes jsonb, target uuid)
returns integer language sql set search_path='' as $$
  select sg10_private.change_purchase_assignments(space,changes,target)
$$;
revoke all on function sg10_private.change_purchase_assignments(uuid,jsonb,uuid),
  public.sg10_change_purchase_assignments(uuid,jsonb,uuid) from public, anon;
grant execute on function sg10_private.change_purchase_assignments(uuid,jsonb,uuid),
  public.sg10_change_purchase_assignments(uuid,jsonb,uuid) to authenticated;

create function sg10_private.guard_confirmed_purchase()
returns trigger language plpgsql security definer set search_path='' as $$
declare order_key text:=new.data->>'orderId'; order_data jsonb; order_unit text; actor uuid:=auth.uid();
  amount numeric; previous numeric:=0; purchased numeric; responsible uuid;
begin
  if actor is null or order_key is null or new.data->>'status' is null or new.data->>'status' not in
    ('Comprado','Cargado','Preparado','Completado','Entregado') then return new; end if;
  select o.data into order_data from public.sg_orders o
  where o.workspace_id=new.workspace_id and o.id=order_key for no key update;
  if not found then raise exception 'El pedido asociado ya no existe'; end if;
  order_unit:=coalesce(nullif(order_data->>'quantityUnit',''),'cajas');
  amount:=sg10_private.confirmed_purchase_quantity(new.data,order_unit);
  if tg_op='UPDATE' and old.workspace_id=new.workspace_id and old.data->>'orderId'=order_key then
    previous:=sg10_private.confirmed_purchase_quantity(old.data,order_unit);
  end if;
  if amount=0 and previous=0 and tg_op='UPDATE' and old.data->>'orderId'=order_key
    and old.data->>'status' in ('Comprado','Cargado','Preparado','Completado','Entregado')
    and (old.data->>'quantityUnit',old.data->>'boxes',old.data->>'sgBoughtPallets')
      is not distinct from (new.data->>'quantityUnit',new.data->>'boxes',new.data->>'sgBoughtPallets')
  then return new; end if;
  if amount<=0 then raise exception 'Indica una cantidad comprada en la unidad del pedido'; end if;
  if amount<=previous then return new; end if;
  if not public.sg_is_member(new.workspace_id) then raise insufficient_privilege; end if;
  if coalesce(order_data->>'status','') in ('Cancelado','Anulado','Comprado','Cargado','Preparado','Completado','Entregado')
    or new.data->>'date' is distinct from order_data->>'date'
    or new.data->>'clientId' is distinct from order_data->>'clientId' then
    raise exception 'La compra debe corresponder a un pedido activo del mismo cliente y fecha';
  end if;
  select a.assignee into responsible from public.sg10_purchase_assignments a
  join public.sg_members m on m.workspace_id=a.workspace_id and m.user_id=a.assignee
  where a.workspace_id=new.workspace_id and a.order_id=order_key;
  if responsible is not null and responsible<>actor and not public.sg_is_owner(new.workspace_id) then
    raise exception 'La mercancía está asignada a otro empleado' using errcode='42501';
  end if;
  select coalesce(sum(sg10_private.confirmed_purchase_quantity(p.data,order_unit)),0) into purchased
  from public.sg_purchases p where p.workspace_id=new.workspace_id and p.data->>'orderId'=order_key
    and p.id<>new.id;
  if purchased+amount>coalesce(sg10_private.number(order_data->>'boxes'),0) then
    if new.id like 'reparto:%' then raise exception 'El reparto supera los palés pendientes del pedido'; end if;
    raise exception 'La cantidad supera lo pendiente. Actualiza la lista de compra.' using errcode='40001';
  end if;
  new.data:=jsonb_set(new.data,'{buyerId}',to_jsonb(coalesce(responsible,actor)));
  return new;
end
$$;
revoke all on function sg10_private.guard_confirmed_purchase() from public, anon, authenticated;
create trigger sg10_guard_confirmed_purchase before insert or update on public.sg_purchases
  for each row execute function sg10_private.guard_confirmed_purchase();
CREATE OR REPLACE FUNCTION sg10_private.staff_order(space uuid, request uuid, lines jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    if product='' or length(product)>120 or unit is null or unit not in ('cajas','pales','sacos','kg') or day is null or day<date '2000-01-01'
        or day>(now() at time zone 'Europe/Madrid')::date+365 or jsonb_typeof(item->'boxes') is distinct from 'number'
        or length(coalesce(item->>'supplier',''))>160 or length(coalesce(item->>'variety',''))>120 or length(coalesce(item->>'notes',''))>750
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
        'priceUnit',price_unit,'supplier',coalesce(item->>'supplier',''),'sourceMessage',left(item->>'sourceMessage',5500)));
  end loop;
  return idx;
end $function$;
