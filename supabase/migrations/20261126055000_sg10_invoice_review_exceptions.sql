create function sg10_private.invoice_price_unit(value text)
returns text language sql immutable set search_path='' as $$
  select case
    when parts && array['kg','kilo','kilos'] then 'kg'
    when parts && array['caja','cajas'] then 'caja'
    when parts && array['pale','pales','palet','palets'] then 'pale'
    else ''
  end
  from string_to_array(sg10_private.label(value),' ') as parts
$$;

create function sg10_private.invoice_review_findings(space uuid, doc jsonb)
returns table(kind text, article text) language sql stable set search_path='' as $$
  with invoice as (
    select doc->>'client_id' as customer, doc->>'fecha' as day,
      sg10_private.label(doc->>'proveedor') as provider
    where doc->>'tipo' is distinct from 'abono'
      and nullif(doc->>'client_id','') is not null and doc->>'fecha' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
  ), orders as (
    select o.id, o.data, sg10_private.product(o.data->>'product') as product
    from public.sg_orders o cross join invoice i
    where o.workspace_id=space and o.data->>'clientId'=i.customer and o.data->>'date'=i.day
      and coalesce(o.data->>'status','') not in ('Cancelado','Anulado')
  ), lines as (
    select l.value->>'producto' as item, sg10_private.product(l.value->>'producto') as product,
      sg10_private.number(l.value->>'precio') as price,
      sg10_private.invoice_price_unit(coalesce(l.value->>'unidad_precio',l.value->>'priceUnit')) as unit
    from jsonb_array_elements(case when jsonb_typeof(doc->'lineas')='array' then doc->'lineas' else '[]'::jsonb end) l
    where sg10_private.product(l.value->>'producto')<>''
  )
  select 'factura_sin_pedido', 'Sin pedido en la fecha de la factura'
  from invoice where not exists(select 1 from orders)
  union
  select 'factura_discrepancia', left(l.item,75)||' · No figura en el pedido'
  from lines l cross join invoice
  where exists(select 1 from orders) and not exists(select 1 from orders o where o.product=l.product)
  union
  select 'factura_discrepancia', left(l.item,75)||' · Precio distinto (factura '||l.price||' €)'
  from lines l cross join invoice i
  cross join lateral (
    with purchases as (
      select p.data from public.sg_purchases p
      where p.workspace_id=space and p.data->>'clientId'=i.customer and p.data->>'date'=i.day
        and coalesce(p.data->>'status','') not in ('Cancelado','Anulado')
        and (i.provider='' or sg10_private.label(p.data->>'supplier')=i.provider)
        and (sg10_private.product(p.data->>'product')=l.product
          or exists(select 1 from orders o where o.product=l.product and o.id=p.data->>'orderId'))
    ), candidates as (
      select data from purchases
      union all
      select o.data from orders o where o.product=l.product and not exists(select 1 from purchases)
        and (i.provider='' or sg10_private.label(o.data->>'supplier') in ('',i.provider))
    ), priced as (
      select coalesce(sg10_private.number(data->>'priceCents')/100,sg10_private.number(data->>'price')) as price,
        coalesce(nullif(sg10_private.invoice_price_unit(data->>'priceUnit'),''),'kg') as unit
      from candidates
    )
    select count(*) as prices, count(distinct unit) as units, bool_or(abs(price-l.price)<0.0001) as equal_price
    from priced where price is not null and (l.unit='' or priced.unit=l.unit)
  ) r
  where l.price is not null and r.prices>0 and (l.unit<>'' or r.units=1) and not r.equal_price
    and exists(select 1 from orders o where o.product=l.product)
$$;

revoke all on function sg10_private.invoice_price_unit(text),
  sg10_private.invoice_review_findings(uuid,jsonb) from public, anon, authenticated;

create or replace function sg10_private.invoice_event()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
  values(new.workspace_id,new.invoice_data->>'client_id','factura_recibida',
    new.customer_name,new.invoice_number,auth.uid(),'facturas',new.id::text);

  insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
  select new.workspace_id,new.invoice_data->>'client_id',f.kind,new.customer_name,f.article,
    auth.uid(),'facturas',new.id::text
  from sg10_private.invoice_review_findings(new.workspace_id,new.invoice_data) f;
  return new;
end
$$;
