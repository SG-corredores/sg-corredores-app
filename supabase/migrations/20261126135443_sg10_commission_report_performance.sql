-- Build the customer lookup once per report instead of running a customer query per invoice.
create function sg10_private.commission_client_lookup(space uuid)
returns jsonb language sql stable set search_path='' as $$
  with companies as materialized (
    select c.id,sg10_private.commission_identity(c.data->>'name') as name,
      replace(sg10_private.label(t.tax),' ','') as tax,
      nullif(t.tax,'') is null as tax_missing,
      case when jsonb_typeof(c.data->'invoiceAliases')='array' then c.data->'invoiceAliases' else '[]'::jsonb end as aliases
    from public.sg_clients c
    cross join lateral (select coalesce(c.data->>'cif',c.data->>'nif') as tax) t
    where c.workspace_id=space
  ), default_aliases(name,alias) as (
    values ('huerta los naranjos','huertas los naranjos'),
      ('ortega escolano','jose antonio ortega escolano'), ('ortega escolano','ortega escolano jose antonio'),
      ('ortega escolano','j a ortega escolano'), ('ortega escolano','jose ortega escolano'),
      ('vicente la torre','vicente de la torre moreno'), ('vicente la torre','de la torre moreno vicente'),
      ('vicente la torre','vlt de la torre moreno vicente'),
      ('david maza','david maza rozas'), ('david maza','maza rozas david'), ('david maza','damaz david maza rozas'),
      ('carrillo','hort sergio carrillo e hijo'), ('carrillo','hortcolas sergio carrillo e hijo'), ('carrillo','carrillo1'),
      ('frutorbel','frutor frutorbel'), ('castilla','castilla frutas castilla'), ('castilla','castilla platanos bananas')
  ), resolved_aliases as (
    select id,name as alias,tax_missing from companies
    union
    select c.id,sg10_private.commission_identity(a.value),c.tax_missing
      from companies c cross join lateral jsonb_array_elements_text(c.aliases) a
    union
    select c.id,a.alias,c.tax_missing from companies c join default_aliases a on a.name=c.name
  ), names as (
    select alias,jsonb_agg(id) as ids,
      coalesce(jsonb_agg(id) filter(where tax_missing),'[]'::jsonb) as ids_without_tax
    from resolved_aliases where alias<>'' group by alias
  ), taxes as (
    select tax,jsonb_agg(id) as ids from companies where tax<>'' group by tax
  )
  select jsonb_build_object(
    'ids',coalesce((select jsonb_object_agg(id,true) from companies),'{}'::jsonb),
    'names',coalesce((select jsonb_object_agg(alias,jsonb_build_object('all',ids,'without_tax',ids_without_tax)) from names),'{}'::jsonb),
    'taxes',coalesce((select jsonb_object_agg(tax,ids) from taxes),'{}'::jsonb))
$$;

create function sg10_private.commission_client_from_lookup(lookup jsonb, doc jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare
  recorded_id text:=doc->>'client_id';
  tax text;
  candidates jsonb;
begin
  if (lookup->'ids') ? recorded_id then return recorded_id; end if;
  tax:=replace(sg10_private.label(doc->>'cif_cliente'),' ','');
  if tax<>'' then
    candidates:=lookup->'taxes'->tax;
    if jsonb_array_length(candidates)=1 then return candidates->>0; end if;
    if jsonb_array_length(candidates)>1 then return null; end if;
  end if;
  candidates:=lookup->'names'->sg10_private.commission_identity(doc->>'cliente')
    ->(case when tax='' then 'all' else 'without_tax' end);
  if jsonb_array_length(candidates)=1 then return candidates->>0; end if;
  return null;
end
$$;

create or replace function sg10_private.commission_client(space uuid, doc jsonb)
returns text language sql stable set search_path='' as $$
  select sg10_private.commission_client_from_lookup(sg10_private.commission_client_lookup(space),doc)
$$;

revoke all on function sg10_private.commission_client_lookup(uuid),sg10_private.commission_client_from_lookup(jsonb,jsonb)
  from public,anon,authenticated;

create or replace function sg10_private.commission_report(space uuid, from_day date, to_day date)
returns jsonb language sql stable set search_path='' as $$
  with client_lookup as materialized (
    select sg10_private.commission_client_lookup(space) as data
  ), docs_raw as materialized (
    select i.id,i.sg10_original_id,i.invoice_data as doc,i.sg10_fiscal_key,i.invoice_number,i.created_at,i.status,i.approved_at,
      sg10_private.commission_day(i.invoice_data->>'fecha') as day,
      sg10_private.commission_client_from_lookup(l.data,i.invoice_data) as client,
      sg10_private.commission_supplier(i.invoice_data->>'proveedor') as supplier,
      replace(sg10_private.label(i.invoice_data->>'cif_proveedor'),' ','') as supplier_tax,
      replace(sg10_private.label(coalesce(nullif(i.invoice_data->>'numero',''),i.invoice_number)),' ','') as number,
      sg10_private.commission_invoice_key(i.invoice_data,i.sg10_fiscal_key,i.invoice_number) as fiscal
    from public.sg_invoices i cross join client_lookup l where i.workspace_id=space
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

