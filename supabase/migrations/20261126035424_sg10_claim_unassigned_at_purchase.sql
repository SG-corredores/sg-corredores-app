create or replace function sg10_private.guard_confirmed_purchase()
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
    raise exception 'La cantidad supera lo pendiente. Actualiza la lista de compra.' using errcode='PT409';
  end if;
  if responsible is null then
    insert into public.sg10_purchase_assignments as assignment(workspace_id,order_id,assignee)
    values(new.workspace_id,order_key,actor)
    on conflict(workspace_id,order_id) do update set assignee=excluded.assignee,revision=assignment.revision+1;
    responsible:=actor;
  end if;
  new.data:=jsonb_set(new.data,'{buyerId}',to_jsonb(responsible));
  return new;
end
$$;
