-- A shared legal name needs a visible business destination before applying either tariff.
create or replace function sg10_private.commission_rate(client jsonb, item text)
returns numeric language sql immutable set search_path='' as $$
  select case
    when name='cotelo' then 0.040
    when name='cotelo y naya' then null
    when name='naya' then 0.035
    when name in ('ortega','ortega escolano','huerta','huerta los naranjos') and item ~ '^(patata|cebolla)( |$)' then 0.020
    when name in ('ortega','ortega escolano') and item ~ '^ajo( |$)' then 0.020
    else coalesce((select sg10_private.number(rule->>'rate')
      from jsonb_array_elements(case when jsonb_typeof(client->'sg10Rules')='array' then client->'sg10Rules' else '[]'::jsonb end) rule
      where sg10_private.commission_product(rule->>'product')=item and sg10_private.number(rule->>'rate') between 0 and 9 limit 1),0.035)
  end from sg10_private.commission_identity(client->>'name') name
$$;

create or replace function sg10_private.commission_report(space uuid, from_day date, to_day date)
returns jsonb language sql stable set search_path='' as $$
  with docs_raw as materialized (
    select i.id,i.sg10_original_id,i.invoice_data as doc,i.sg10_fiscal_key,i.invoice_number,i.created_at,i.status,i.approved_at,
      sg10_private.commission_day(i.invoice_data->>'fecha') as day,
      sg10_private.commission_client(space,i.invoice_data) as client,
      sg10_private.commission_supplier(i.invoice_data->>'proveedor') as supplier,
      replace(sg10_private.label(i.invoice_data->>'cif_proveedor'),' ','') as supplier_tax,
      replace(sg10_private.label(coalesce(nullif(i.invoice_data->>'numero',''),i.invoice_number)),' ','') as number,
      sg10_private.commission_invoice_key(i.invoice_data,i.sg10_fiscal_key,i.invoice_number) as fiscal
    from public.sg_invoices i where i.workspace_id=space
      and i.invoice_data->>'tipo' in ('factura','abono') and i.status in ('pending','approved')
  ), documents as materialized (
    select distinct on (coalesce(fiscal,id::text)) i.*, i.doc->>'tipo' as kind
    from docs_raw i
    where i.supplier_tax<>'' or i.fiscal is null or not exists(select 1 from docs_raw verified
      where verified.supplier_tax<>'' and verified.supplier=i.supplier and verified.number=i.number and verified.day=i.day)
    order by coalesce(fiscal,id::text), (approved_at is not null) desc, created_at,id
  ), credit_parents as materialized (
    select a.id,
      (select array_agg(f.id) from documents f
        where f.kind='factura' and a.client=f.client and a.supplier_tax<>'' and a.supplier_tax=f.supplier_tax
          and f.day<=a.day and f.fiscal is not null and (
            (a.status='approved' and a.approved_at is not null and a.sg10_original_id=f.id) or
            (a.sg10_original_id is null and left(a.day::text,4)=left(f.day::text,4)
              and f.number<>'' and f.number=replace(sg10_private.label(a.doc->>'numero_original'),' ','')))) as originals
    from documents a where a.kind='abono' and a.fiscal is not null and a.day<=to_day
  ), needed as (
    select d.id from documents d where d.day between from_day and to_day
    union
    select p.originals[1] from credit_parents p where cardinality(p.originals)=1
  ), purchases as materialized (
    select p.id, p.data->>'clientId' as client,p.data->>'date' as day,p.data->>'orderId' as order_id,
      c.data as company,p.data->>'product' as product,p.data->>'variety' as variety,
      sg10_private.commission_product(concat_ws(' ',p.data->>'product',nullif(p.data->>'variety',''))) as full_product,
      sg10_private.commission_supplier(p.data->>'supplier') as supplier,p.data->>'supplier' as supplier_name,
      p.data->>'quantityUnit' as quantity_unit,sg10_private.number(p.data->>'boxes') as boxes,sg10_private.number(p.data->>'tara') as tare,
      nullif(sg10_private.number(p.data->>'kg'),0) as measured_kg,
      coalesce(sg10_private.number(p.data->>'priceCents')/100,sg10_private.number(p.data->>'price')) as price,
      sg10_private.commission_unit(p.data->>'priceUnit') as price_unit,
      (p.data->>'status'='Cargado' or nullif(p.data->>'receivedAt','') is not null) as received,
      sg10_private.commission_weight(c.data,sg10_private.commission_product(p.data->>'product'),p.data->>'quantityUnit',
        sg10_private.number(p.data->>'boxes'),sg10_private.number(p.data->>'kg'),
        case when p.data->>'weightMode'='fixed' then sg10_private.number(p.data->>'kgPerBox') end) as known_kg
    from public.sg_purchases p join public.sg_clients c on c.workspace_id=space and c.id=p.data->>'clientId'
    where p.workspace_id=space and coalesce(p.data->>'status','') not in ('Cancelado','Anulado')
      and (p.data->>'date' between from_day::text and to_day::text or
        p.data->>'date' in (select d.day::text from documents d join needed n on d.id=n.id where d.kind='factura'))
  ), lines as materialized (
    select d.id as invoice_id,d.day,d.client,d.kind,d.supplier,d.fiscal,d.doc->>'proveedor' as supplier_name,
      d.doc->>'numero' as invoice_number,
      sg10_private.commission_identity(coalesce(nullif(d.doc->>'destino_comercial',''),d.doc->>'cliente')) as billing_company,l.*
    from documents d join needed a on a.id=d.id cross join lateral sg10_private.commission_lines(d.doc) l
  ), candidates as (
    select l.invoice_id,l.n,l.billing_company,p.id as purchase_id,p.company,p.product as purchase_product,p.received,
      coalesce(nullif(l.kg,0),p.known_kg) as verified_kg, coalesce(l.tare,p.tare) as verified_tare,
      count(*) over(partition by l.invoice_id,l.n) as purchases_for_line,
      count(*) over(partition by p.id) as lines_for_purchase
    from lines l join purchases p on p.client=l.client and p.day=l.day::text and p.supplier=l.supplier
      and sg10_private.commission_same_product(l.product_variety,p.full_product)
    cross join lateral (select (p.quantity_unit='cajas' and l.boxes>0 and l.boxes=p.boxes) as same_boxes,
      (l.kg>0 and p.known_kg>0 and abs(l.kg-p.known_kg)<=0.01) as same_kg) units
    cross join lateral (select sg10_private.commission_price_matches(l.price,l.unit,p.price,p.price_unit,
      l.kg,l.boxes,units.same_boxes) as price_match) compared
    where l.kind='factura' and l.fiscal is not null and l.supplier<>''
      and (units.same_boxes or units.same_kg)
      and not coalesce(p.quantity_unit='cajas' and p.boxes>0 and l.boxes>0 and p.boxes<>l.boxes,false)
      and (p.measured_kg is null or l.kg is null or l.kg=0 or abs(l.kg-p.measured_kg)<=0.01)
      and (compared.price_match is distinct from false or (units.same_boxes and p.received and p.price=l.price))
  ), matched as materialized (
    select m.*,sg10_private.commission_rate(
      case when sg10_private.commission_identity(m.company->>'name')='cotelo y naya'
        and m.billing_company in ('cotelo','naya') then jsonb_set(m.company,'{name}',to_jsonb(m.billing_company))
        else m.company end,
      sg10_private.commission_product(m.purchase_product)) as rate
    from candidates m
    where m.purchases_for_line=1 and m.lines_for_purchase=1 and m.received and m.verified_kg>0
  ), credits_candidates as (
    select a.invoice_id,a.n,f.invoice_id as original,f.n as original_line,o.rate,a.kg,a.net,a.gross,
      o.verified_kg as cap_kg,f.net as cap_net,f.gross as cap_gross,a.day,
      count(*) over(partition by a.invoice_id,a.n) as options
    from lines a join credit_parents d on d.id=a.invoice_id and cardinality(d.originals)=1
      join lines f on f.invoice_id=d.originals[1] and f.product_variety=a.product_variety and a.product_variety<>''
      join matched o on o.invoice_id=f.invoice_id and o.n=f.n
    where a.kind='abono' and o.rate is not null and a.kg>0 and a.net>0 and a.gross>0 and a.kg<=o.verified_kg and a.net<=f.net and a.gross<=f.gross
  ), credit_amounts as (
    select c.*,sum(c.kg) over ordered as used_kg,sum(c.net) over ordered as used_net,sum(c.gross) over ordered as used_gross
    from credits_candidates c where options=1
    window ordered as (partition by original,original_line order by day,invoice_id,n rows unbounded preceding)
  ), credits as materialized (
    select * from credit_amounts where used_kg<=cap_kg and used_net<=cap_net and used_gross<=cap_gross
  ), issued as (
    select l.client,l.day,l.invoice_id,l.kind,l.n,l.item,l.variety,l.supplier_name as supplier,l.invoice_number,
      case when l.kind='abono' then -l.boxes else l.boxes end as boxes,
      coalesce(m.verified_tare,l.tare) as tare,
      case when c.invoice_id is not null then -l.kg else m.verified_kg end as kg,
      l.price,l.unit,case when l.kind='abono' then -l.net else l.net end as net,
      case when l.kind='abono' then -l.gross else l.gross end as gross,
      case when c.invoice_id is not null then -l.kg*c.rate else m.verified_kg*m.rate end as commission,
      m.purchase_id
    from lines l left join matched m on m.invoice_id=l.invoice_id and m.n=l.n
      left join credits c on c.invoice_id=l.invoice_id and c.n=l.n
    where l.day between from_day and to_day
  ), period_docs as materialized (
    select d.id,d.client,d.day,
      d.fiscal is not null and d.client is not null and count(i.n)>0
        and bool_and(i.commission is not null and i.net is not null and i.gross is not null)
        and (d.approved_at is not null or not exists(select 1 from sg10_private.invoice_review_findings(space,d.doc))) as processed
    from documents d left join issued i on i.invoice_id=d.id
    where d.day between from_day and to_day group by d.id,d.client,d.day,d.fiscal,d.doc,d.approved_at
  ), pending_purchases as (
    select p.client,p.day,p.id,p.product,p.variety,p.supplier_name,
      case when p.received then 'Recepción sin factura conciliada' else 'Recepción pendiente' end as reason
    from purchases p where p.day between from_day::text and to_day::text
      and not exists(select 1 from matched m where m.purchase_id=p.id)
  ), pending_orders as (
    select o.data->>'clientId' as client,o.data->>'date' as day
    from public.sg_orders o
    where o.workspace_id=space and o.data->>'date' between from_day::text and to_day::text
      and coalesce(o.data->>'status','') not in ('Cancelado','Anulado')
      and not exists(select 1 from purchases p where p.client=o.data->>'clientId' and p.day=o.data->>'date'
        and (p.order_id=o.id or p.full_product=sg10_private.commission_product(concat_ws(' ',o.data->>'product',nullif(o.data->>'variety','')))))
  ), relevant as (
    select i.client from period_docs i where i.client is not null
    union select o.client from pending_orders o
    union select p.client from purchases p where p.day between from_day::text and to_day::text
  ), groups as (
    select c.id,c.data->>'name' as name,
      (select count(*) from period_docs f where f.client=c.id and f.processed is not true) as pending_invoices,
      (select count(*) from period_docs f where f.client=c.id and f.processed is true) as processed_invoices,
      (select count(*) from pending_orders o where o.client=c.id) as pending_orders,
      (select count(*) from pending_purchases p where p.client=c.id) as pending_purchases,
      (select coalesce(sum(i.kg),0) from issued i where i.client=c.id) as kg,
      (select coalesce(sum(i.net),0) from issued i where i.client=c.id and i.commission is not null) as net,
      (select coalesce(sum(i.gross),0) from issued i where i.client=c.id and i.commission is not null) as gross,
      (select coalesce(round(sum(i.commission),2),0) from issued i where i.client=c.id) as commission,
      (select coalesce(jsonb_agg(to_jsonb(i)-'client'-'purchase_id' order by i.supplier,i.day,i.invoice_number,i.n),'[]'::jsonb)
        from issued i where i.client=c.id) as lines
    from relevant r join public.sg_clients c on c.workspace_id=space and c.id=r.client
  )
  select jsonb_build_object(
    'clients',(select coalesce(jsonb_agg(to_jsonb(g) order by g.name),'[]'::jsonb) from groups g),
    'processed',(select count(*) from period_docs p where p.processed is true),
    'pending',(select count(*) from period_docs p where p.processed is not true),
    'unassigned',(select count(*) from period_docs p where p.client is null),
    'undated',(select count(*) from documents d where d.day is null),
    'unread',(select count(*) from public.sg10_gmail_pending p where p.workspace_id=space and p.received_day between from_day and to_day),
    'last_import',(select max(processed_at) from public.sg10_gmail_messages m where m.workspace_id=space)
  )
$$;

