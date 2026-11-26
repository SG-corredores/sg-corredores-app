-- Derived reconciliation. Imported invoices and historical receptions remain intact.
create function sg10_private.commission_identity(value text)
returns text language sql immutable set search_path='' as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(sg10_private.label(value),
        ' (s l l|s l u|s l|s a|l d a|sll|slu|sl|sa|lda|l)$',''),
      '^(frutas|fruteria|fruter|fr|fruits) | (frutas)$','','g'),
    ' +',' ','g')
$$;

create function sg10_private.commission_client(space uuid, doc jsonb)
returns text language sql stable set search_path='' as $$
  with identity as (
    select sg10_private.commission_identity(doc->>'cliente') as company,
      replace(sg10_private.label(doc->>'cif_cliente'),' ','') as tax
  ), candidates as (
    select c.id,(i.tax<>'' and i.tax=replace(sg10_private.label(coalesce(c.data->>'cif',c.data->>'nif')),' ','')) as exact_tax
    from public.sg_clients c cross join identity i
    cross join lateral (select sg10_private.commission_identity(c.data->>'name') as name) n
    where c.workspace_id=space and (
      (i.tax<>'' and i.tax=replace(sg10_private.label(coalesce(c.data->>'cif',c.data->>'nif')),' ',''))
      or ((i.tax='' or nullif(coalesce(c.data->>'cif',c.data->>'nif'),'') is null)
        and i.company<>'' and (
          i.company=n.name
          or i.company in (select sg10_private.commission_identity(value)
            from jsonb_array_elements_text(case when jsonb_typeof(c.data->'invoiceAliases')='array'
              then c.data->'invoiceAliases' else '[]'::jsonb end))
          or (n.name='huerta los naranjos' and i.company='huertas los naranjos')
          or (n.name='ortega escolano' and i.company in ('jose antonio ortega escolano','ortega escolano jose antonio','j a ortega escolano','jose ortega escolano'))
          or (n.name='vicente la torre' and i.company in ('vicente de la torre moreno','de la torre moreno vicente','vlt de la torre moreno vicente'))
          or (n.name='david maza' and i.company in ('david maza rozas','maza rozas david','damaz david maza rozas'))
          or (n.name='carrillo' and i.company in ('hort sergio carrillo e hijo','hortcolas sergio carrillo e hijo','carrillo1'))
          or (n.name='frutorbel' and i.company='frutor frutorbel')
          or (n.name='castilla' and i.company in ('castilla frutas castilla','castilla platanos bananas'))
        )
      )
    )
  )
  select case
    when exists(select 1 from public.sg_clients c where c.workspace_id=space and c.id=doc->>'client_id')
      then doc->>'client_id'
    when count(*) filter(where exact_tax)=1 then min(id) filter(where exact_tax)
    when count(*)=1 then min(id)
  end from candidates
$$;

create function sg10_private.commission_supplier(value text)
returns text language sql immutable set search_path='' as $$
  select case sg10_private.commission_identity(value)
    when 'salto a origen' then 'salto origen'
    else sg10_private.commission_identity(value)
  end
$$;

create function sg10_private.commission_product(value text)
returns text language sql immutable set search_path='' as $$
  select regexp_replace(sg10_private.product(value), '\majos\M','ajo','g')
$$;

create function sg10_private.commission_same_product(invoice text, purchase text)
returns boolean language sql immutable set search_path='' as $$
  select invoice<>'' and purchase<>'' and
    (invoice=purchase or (position(' ' in purchase)>0 and starts_with(invoice,purchase||' ')))
$$;

create function sg10_private.commission_day(value text)
returns date language sql immutable set search_path='' as $$
  select case when value ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}($|T)' and pg_input_is_valid(left(value,10),'date')
    then left(value,10)::date end
$$;

create function sg10_private.commission_weight(client jsonb, item text, units text, boxes numeric, kg numeric, fixed_kg numeric)
returns numeric language sql immutable set search_path='' as $$
  select case when kg>0 then kg
    when units='cajas' and boxes>0 then boxes * coalesce(
      case when fixed_kg>0 then fixed_kg end,
      (select sg10_private.number(rule->>'weight')
        from jsonb_array_elements(case when jsonb_typeof(client->'sg10Rules')='array' then client->'sg10Rules' else '[]'::jsonb end) rule
        where sg10_private.commission_product(rule->>'product')=item and sg10_private.number(rule->>'weight')>0 limit 1),
      case item when 'coliflor' then 10 when 'iceberg' then 10 when 'remolacha' then 10
        when 'mango' then 5 when 'aguacate' then 5 end)
  end
$$;

create function sg10_private.commission_rate(client jsonb, item text)
returns numeric language sql immutable set search_path='' as $$
  select case
    when name in ('cotelo','cotelo y naya') then 0.040
    when name='naya' then 0.035
    when name in ('ortega','ortega escolano','huerta','huerta los naranjos') and item ~ '^(patata|cebolla)( |$)' then 0.020
    when name in ('ortega','ortega escolano') and item ~ '^ajo( |$)' then 0.020
    else coalesce((select sg10_private.number(rule->>'rate')
      from jsonb_array_elements(case when jsonb_typeof(client->'sg10Rules')='array' then client->'sg10Rules' else '[]'::jsonb end) rule
      where sg10_private.commission_product(rule->>'product')=item and sg10_private.number(rule->>'rate') between 0 and 9 limit 1),0.035)
  end from sg10_private.commission_identity(client->>'name') name
$$;

create function sg10_private.commission_unit(value text)
returns text language sql immutable set search_path='' as $$
  select case when sg10_private.label(value) in ('bulto','bultos','eur bulto') then 'bulto'
    else nullif(sg10_private.invoice_price_unit(value),'') end
$$;

create function sg10_private.commission_line_unit(explicit text, price numeric, kg numeric, boxes numeric, amount numeric)
returns text language sql immutable set search_path='' as $$
  select coalesce(sg10_private.commission_unit(explicit),case
    when price>0 and kg>0 and boxes>0 and kg<>boxes and amount is not null then
      case
        when abs(round(price*kg,2)-amount)<=0.01 and abs(round(price*boxes,2)-amount)>0.01 then 'kg'
        when abs(round(price*boxes,2)-amount)<=0.01 and abs(round(price*kg,2)-amount)>0.01 then 'bulto'
      end end)
$$;

-- NULL means the two prices cannot be compared with the available evidence.
create function sg10_private.commission_price_matches(a numeric, a_unit text, b numeric, b_unit text, kg numeric, boxes numeric, qualified_boxes boolean)
returns boolean language sql immutable set search_path='' as $$
  select case
    when a is null or b is null then null
    when a_unit=b_unit then abs(a-b)<0.0001
    when a_unit in ('caja','bulto') and b_unit in ('caja','bulto') and qualified_boxes then abs(a-b)<0.0001
    when kg>0 and boxes>0 and qualified_boxes and a_unit='kg' and b_unit in ('caja','bulto') then abs(round(a*kg,2)-round(b*boxes,2))<=0.01
    when kg>0 and boxes>0 and qualified_boxes and b_unit='kg' and a_unit in ('caja','bulto') then abs(round(a*boxes,2)-round(b*kg,2))<=0.01
  end
$$;

create function sg10_private.commission_lines(doc jsonb)
returns table(n bigint,item text,variety text,product text,product_variety text,boxes numeric,tare numeric,kg numeric,
  price numeric,unit text,net numeric,gross numeric,vat numeric)
language sql immutable set search_path='' as $$
  with source as (
    select value as x, ordinality, count(*) over() as size
    from jsonb_array_elements(case when jsonb_typeof(doc->'lineas')='array' then doc->'lineas' else '[]'::jsonb end) with ordinality
  ), parsed as (
    select ordinality, x->>'producto' as item, x->>'variedad' as variety,
      abs(sg10_private.number(coalesce(x->>'bultos',x->>'cajas'))) as boxes,
      abs(sg10_private.number(x->>'tara')) as tare,
      abs(sg10_private.number(x->>'kilos_netos')) as kg,
      abs(sg10_private.number(x->>'precio')) as price,coalesce(x->>'unidad_precio',x->>'priceUnit') as explicit,
      abs(coalesce(sg10_private.number(x->>'importe'),case when size=1 then sg10_private.number(doc->>'base') end)) as net,
      abs(coalesce(sg10_private.number(x->>'importe_con_iva'),sg10_private.number(x->>'total'),
        case when size=1 then sg10_private.number(doc->>'total') end)) as gross,
      sg10_private.number(x->>'iva_porcentaje') as vat
    from source
  )
  select ordinality,item,variety,sg10_private.commission_product(item),sg10_private.commission_product(concat_ws(' ',item,nullif(variety,''))),
    boxes,tare,kg,price,sg10_private.commission_line_unit(explicit,price,kg,boxes,net),
    net,coalesce(gross,case when vat between 0 and 100 then round(net*(1+vat/100),2) end),vat
  from parsed
$$;

create function sg10_private.commission_invoice_key(doc jsonb, fiscal text, number text)
returns text language sql immutable set search_path='' as $$
  select case when d is not null and n<>'' and s<>'' then coalesce(nullif(fiscal,''),s||'|'||left(d::text,4)||'|'||n) end
  from sg10_private.commission_day(doc->>'fecha') d,
  lateral replace(sg10_private.label(coalesce(nullif(doc->>'numero',''),number)),' ','') n,
  lateral coalesce(nullif(replace(sg10_private.label(doc->>'cif_proveedor'),' ',''),''),sg10_private.commission_supplier(doc->>'proveedor')) s
$$;

create or replace function sg10_private.invoice_review_findings(space uuid, doc jsonb)
returns table(kind text, article text) language sql stable set search_path='' as $$
  with invoice as (
    select sg10_private.commission_client(space,doc) as customer,
      sg10_private.commission_day(doc->>'fecha')::text as day,
      sg10_private.commission_supplier(doc->>'proveedor') as provider
    where doc->>'tipo'='factura'
      and sg10_private.commission_invoice_key(doc,null,null) is not null
  ), orders as (
    select o.data,sg10_private.commission_product(o.data->>'product') as product,
      sg10_private.commission_product(concat_ws(' ',o.data->>'product',nullif(o.data->>'variety',''))) as full_product
    from public.sg_orders o join invoice i on o.data->>'clientId'=i.customer and o.data->>'date'=i.day
    where o.workspace_id=space and coalesce(o.data->>'status','') not in ('Cancelado','Anulado')
  ), price_references as (
    select o.data from orders o
    union all
    select p.data from public.sg_purchases p join invoice i on p.data->>'clientId'=i.customer and p.data->>'date'=i.day
    where p.workspace_id=space and coalesce(p.data->>'status','') not in ('Cancelado','Anulado')
  ), lines as (
    select l.* from sg10_private.commission_lines(doc) l where l.product<>''
  )
  select 'factura_sin_pedido', 'Sin pedido en la fecha de la factura'
  from invoice where customer is not null and exists(select 1 from lines) and not exists(select 1 from orders)
    and exists(select 1 from public.sg_orders coverage where coverage.workspace_id=space and coverage.data->>'date'<=invoice.day)
  union
  select 'factura_discrepancia',left(l.item,75)||' · No figura en el pedido'
  from lines l cross join invoice i
  where exists(select 1 from orders)
    and not exists(select 1 from orders o where sg10_private.commission_same_product(l.product_variety,o.full_product)
      or l.product=o.product or split_part(l.product,' ',1)=split_part(o.product,' ',1))
  union
  select 'factura_discrepancia',left(l.item,75)||' · Precio distinto (factura '||l.price||' €/'||l.unit||
      ' · registrado '||checks.prices||')'
  from lines l cross join invoice i
  cross join lateral (
    select count(*) n, bool_and(match is false) differs,
      string_agg(distinct reference_price||' €/'||reference_unit,' / ') prices
    from price_references r
    cross join lateral (select coalesce(sg10_private.number(r.data->>'priceCents')/100,sg10_private.number(r.data->>'price')) reference_price,
      sg10_private.commission_unit(r.data->>'priceUnit') reference_unit) p
    cross join lateral (select sg10_private.commission_price_matches(l.price,l.unit,p.reference_price,p.reference_unit,l.kg,l.boxes,
      r.data->>'quantityUnit'='cajas' and sg10_private.number(r.data->>'boxes')=l.boxes) match) x
    where i.provider<>'' and sg10_private.commission_supplier(r.data->>'supplier')=i.provider
      and sg10_private.commission_same_product(l.product_variety,
        sg10_private.commission_product(concat_ws(' ',r.data->>'product',nullif(r.data->>'variety',''))))
      and reference_price is not null
  ) checks
  where checks.n>0 and checks.differs and l.unit is not null
$$;

create or replace function sg10_private.invoice_event()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Alert on newly issued documents. Older documents remain visible in invoice review.
  if sg10_private.commission_day(new.invoice_data->>'fecha') >= (now() at time zone 'Europe/Madrid')::date-1 then
    insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
    select new.workspace_id,sg10_private.commission_client(new.workspace_id,new.invoice_data),f.kind,
      new.customer_name,f.article,auth.uid(),'facturas',new.id::text
    from sg10_private.invoice_review_findings(new.workspace_id,new.invoice_data) f
    where not exists(
      select 1 from public.sg_invoices i where i.workspace_id=new.workspace_id and i.id<>new.id
      and sg10_private.commission_invoice_key(i.invoice_data,i.sg10_fiscal_key,i.invoice_number)=
        sg10_private.commission_invoice_key(new.invoice_data,new.sg10_fiscal_key,new.invoice_number)
    );
  end if;
  return new;
end
$$;

create function public.sg10_invoice_findings(space uuid, from_day date, to_day date)
returns table(id uuid, findings text[]) language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.sg_is_member(space) then raise insufficient_privilege; end if;
  if from_day is null or to_day is null or to_day<from_day or to_day-from_day>366 then raise invalid_parameter_value; end if;
  return query
    select d.id,array_agg(distinct f.article order by f.article)
    from public.sg_invoices d cross join lateral sg10_private.invoice_review_findings(space,d.invoice_data) f
    where d.workspace_id=space and d.approved_at is null and d.status='pending'
      and left(d.invoice_data->>'fecha',10) between from_day::text and to_day::text
      and not exists (select 1 from public.sg_invoices o where o.workspace_id=space
        and (o.created_at,o.id)<(d.created_at,d.id)
        and sg10_private.commission_invoice_key(o.invoice_data,o.sg10_fiscal_key,o.invoice_number)=
            sg10_private.commission_invoice_key(d.invoice_data,d.sg10_fiscal_key,d.invoice_number))
    group by d.id;
end
$$;

create table public.sg10_gmail_pending (
  workspace_id uuid not null references public.sg_workspaces(id),
  message_id text not null,
  part_id text not null,
  received_day date,
  reason text not null check (reason in ('retry','pdf')),
  updated_at timestamptz not null default now(),
  primary key (workspace_id,message_id,part_id)
);
alter table public.sg10_gmail_pending enable row level security;
revoke all on public.sg10_gmail_pending from public,anon,authenticated;
grant select,insert,update,delete on public.sg10_gmail_pending to service_role;

create function sg10_private.commission_report(space uuid, from_day date, to_day date)
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
      d.doc->>'numero' as invoice_number,l.*
    from documents d join needed a on a.id=d.id cross join lateral sg10_private.commission_lines(d.doc) l
  ), candidates as (
    select l.invoice_id,l.n,p.id as purchase_id,p.company,p.product as purchase_product,p.received,
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
    select m.*,sg10_private.commission_rate(m.company,sg10_private.commission_product(m.purchase_product)) as rate
    from candidates m
    where m.purchases_for_line=1 and m.lines_for_purchase=1 and m.received and m.verified_kg>0
  ), credits_candidates as (
    select a.invoice_id,a.n,f.invoice_id as original,f.n as original_line,o.rate,a.kg,a.net,a.gross,
      o.verified_kg as cap_kg,f.net as cap_net,f.gross as cap_gross,a.day,
      count(*) over(partition by a.invoice_id,a.n) as options
    from lines a join credit_parents d on d.id=a.invoice_id and cardinality(d.originals)=1
      join lines f on f.invoice_id=d.originals[1] and f.product_variety=a.product_variety and a.product_variety<>''
      join matched o on o.invoice_id=f.invoice_id and o.n=f.n
    where a.kind='abono' and a.kg>0 and a.net>0 and a.gross>0 and a.kg<=o.verified_kg and a.net<=f.net and a.gross<=f.gross
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

create function public.sg10_commission_report(space uuid,from_day date,to_day date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.sg_is_member(space) then raise insufficient_privilege; end if;
  if from_day is null or to_day is null or to_day<from_day or to_day-from_day>366 then raise invalid_parameter_value; end if;
  return sg10_private.commission_report(space,from_day,to_day);
end
$$;

create function public.sg10_gmail_invoice_client(space uuid, doc jsonb)
returns text language sql stable security definer set search_path='' as $$
  select sg10_private.commission_client(space,doc-'client_id')
$$;
revoke all on function public.sg10_gmail_invoice_client(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sg10_gmail_invoice_client(uuid,jsonb) to service_role;

create or replace function public.sg10_confirm_reception(space uuid,purchase_id text)
returns jsonb language sql set search_path='' as $$
  update public.sg_purchases p set data=p.data||jsonb_build_object('receivedAt',statement_timestamp(),
    'receivedBy',auth.uid(),'status','Cargado'),updated_at=statement_timestamp(),updated_by=auth.uid()
  where p.workspace_id=space and p.id=purchase_id and public.sg_is_member(space)
    and coalesce(p.data->>'status','') not in ('Cancelado','Anulado')
    and nullif(p.data->>'receivedAt','') is null
  returning jsonb_build_object('id',p.id,'data',p.data,'updated_at',p.updated_at)
$$;

revoke all on function public.sg10_invoice_findings(uuid,date,date),public.sg10_commission_report(uuid,date,date) from public,anon,authenticated;
grant execute on function public.sg10_invoice_findings(uuid,date,date),public.sg10_commission_report(uuid,date,date) to authenticated;

alter table public.sg10_gmail_cursor add column lease_id uuid, add column lease_until timestamptz;

create function public.sg10_take_gmail_import(space uuid, token uuid)
returns boolean language plpgsql set search_path='' as $$
begin
  insert into public.sg10_gmail_cursor(workspace_id,lease_id,lease_until)
  values(space,token,now()+interval '160 seconds')
  on conflict (workspace_id) do update
    set lease_id=excluded.lease_id,lease_until=excluded.lease_until
    where public.sg10_gmail_cursor.lease_until is null or public.sg10_gmail_cursor.lease_until<now();
  return found;
end
$$;

create function public.sg10_request_gmail_sync(space uuid)
returns bigint language plpgsql security definer set search_path='' as $$
declare worker_secret text;
begin
  if auth.uid() is null or not public.sg_is_owner(space) then raise insufficient_privilege; end if;
  if (select count(*) from public.sg_members where role='owner')<>1 then
    raise exception 'La sincronización manual requiere un propietario de Gmail configurado.';
  end if;
  select decrypted_secret into worker_secret from vault.decrypted_secrets
    where name='sg10_worker_secret' and decrypted_secret ~ '^[a-f0-9]{64}$' limit 1;
  if worker_secret is null then raise exception 'El trabajador de Gmail no está configurado.'; end if;
  return net.http_post(url:='https://zyzcnosaavvcijsmcowq.supabase.co/functions/v1/sg10-gmail',
    headers:=jsonb_build_object('Content-Type','application/json','x-sg-worker',worker_secret),
    body:='{}'::jsonb,timeout_milliseconds:=45000);
end
$$;

revoke all on function public.sg10_take_gmail_import(uuid,uuid),public.sg10_request_gmail_sync(uuid) from public,anon,authenticated;
grant execute on function public.sg10_take_gmail_import(uuid,uuid) to service_role;
grant execute on function public.sg10_request_gmail_sync(uuid) to authenticated;
revoke all on function
  sg10_private.commission_identity(text), sg10_private.commission_client(uuid,jsonb), sg10_private.commission_supplier(text),
  sg10_private.commission_product(text), sg10_private.commission_same_product(text,text), sg10_private.commission_day(text),
  sg10_private.commission_weight(jsonb,text,text,numeric,numeric,numeric), sg10_private.commission_rate(jsonb,text),
  sg10_private.commission_unit(text), sg10_private.commission_line_unit(text,numeric,numeric,numeric,numeric),
  sg10_private.commission_price_matches(numeric,text,numeric,text,numeric,numeric,boolean),
  sg10_private.commission_lines(jsonb), sg10_private.commission_invoice_key(jsonb,text,text),
  sg10_private.commission_report(uuid,date,date) from public,anon,authenticated;
notify pgrst, 'reload schema';
