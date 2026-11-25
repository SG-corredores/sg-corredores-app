CREATE OR REPLACE FUNCTION sg10_private.portal_order(space uuid, company text, request uuid, day date, lines jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    if jsonb_typeof(item->'quantity') is distinct from 'number' or unit is null or unit not in ('cajas','pales','sacos')
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
end $function$;
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
    if product='' or length(product)>120 or unit is null or unit not in ('cajas','pales','sacos') or day is null or day<date '2000-01-01'
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
end $function$;
CREATE OR REPLACE FUNCTION sg10_private.portal_snapshot(space uuid, company text, from_date date, to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        'variety',p.data->>'variety','boxes',p.data->'boxes',
        'unit',case when p.data->>'quantityUnit'='pales' and p.data->'sgBoughtPallets' is null then 'cajas'
                    else p.data->>'quantityUnit' end,
        'quantity',case when p.data->>'quantityUnit'='pales' then coalesce(p.data->'sgBoughtPallets',p.data->'boxes')
                        else p.data->'boxes' end,
        'status',p.data->>'status') order by p.data->>'date' desc,p.id)
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
end $function$;
