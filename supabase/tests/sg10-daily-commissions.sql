-- Run as postgres on a staging database. All fixture writes are rolled back.
begin;
do $$
declare r record;
begin
  for r in select * from (values
    ('Cotelo','tomate',0.040), ('Cotelo y Naya','patata',null::numeric), ('Naya','patata',0.035),
    ('Ortega Escolano','patata agria',0.020), ('Ortega','cebolla',0.020), ('Ortega','ajo',0.020),
    ('Huerta los naranjos','patata',0.020), ('Huerta los naranjos','cebolla',0.020),
    ('Huerta los naranjos','ajo',0.035), ('Ortega','tomate',0.035), ('Rocalla','patata',0.035)
  ) as expected(company,product,rate) loop
    if sg10_private.commission_rate(jsonb_build_object('name',r.company),r.product) is distinct from r.rate then
      raise exception 'Tarifa incorrecta para % / %',r.company,r.product;
    end if;
  end loop;
  if sg10_private.commission_weight('{}','remolacha','cajas',3,0,null) is distinct from 30::numeric
    or sg10_private.commission_weight('{}','kiwi','cajas',3,0,null) is not null
    or sg10_private.commission_weight('{}','mango','pales',3,0,null) is not null then
    raise exception 'Equivalencia de cajas incorrecta';
  end if;
  if sg10_private.commission_line_unit(null,2,20,5,40) is distinct from 'kg'
    or sg10_private.commission_price_matches(2,'kg',8,'caja',20,5,true) is distinct from true
    or sg10_private.commission_price_matches(2,'kg',9,'caja',20,5,true) is distinct from false
    or sg10_private.commission_price_matches(2,null,9,'caja',20,5,true) is not null then
    raise exception 'Comparación de unidades incorrecta';
  end if;
  if sg10_private.commission_supplier('FRUITS CMR, S.A.') is distinct from 'cmr'
    or sg10_private.commission_day('2026-02-30') is not null then
    raise exception 'Normalización incorrecta';
  end if;
end
$$;

do $$
declare space uuid; company text:='test-comisiones-'||gen_random_uuid(); order_key text:=company||'-pedido';
  purchase_key text:=company||'-compra'; owner uuid; report jsonb; positive jsonb; credit jsonb;
  first_invoice uuid; purchase_data jsonb; fixture_day date:='2037-05-17';
begin
  select w.id,m.user_id into space,owner
    from public.sg_workspaces w join public.sg_members m on m.workspace_id=w.id and m.role='owner' limit 1;
  if space is null then raise exception 'La base de pruebas requiere un espacio existente con propietario'; end if;
  perform set_config('request.jwt.claim.sub',owner::text,true);
  insert into public.sg_clients(workspace_id,id,data) values(space,company,
    jsonb_build_object('name','Prueba Comisiones','invoiceAliases',jsonb_build_array('Frutas Prueba Fiscal S.L.')));
  insert into public.sg_orders(workspace_id,id,data) values(space,order_key,jsonb_build_object('date',fixture_day::text,
    'clientId',company,'product','Tomate azul','boxes',5,'quantityUnit','cajas','status','Pendiente'));
  purchase_data:=jsonb_build_object('date',fixture_day::text,'clientId',company,'product','Tomate azul',
    'boxes',5,'quantityUnit','cajas','kg',0,'status','Pendiente','priceCents',200,'priceUnit','kg','supplier','Proveedor Fiscal');
  insert into public.sg_purchases(workspace_id,id,data) values(space,purchase_key,purchase_data);
  positive:=jsonb_build_object('tipo','factura','fecha',fixture_day,'cliente','Frutas Prueba Fiscal S.L.',
    'numero',company||'-F1','proveedor','Proveedor Fiscal S.L.','cif_proveedor','B12345678',
    'base',40,'total',41.6,'lineas','[{"producto":"Tomate azul CAT I","bultos":5,"tara":2,"kilos_netos":20,"precio":2,"unidad_precio":"kg"}]'::jsonb);
  insert into public.sg_invoices(workspace_id,created_by,invoice_number,invoice_data,status,sg10_fiscal_key)
    values(space,owner,positive->>'numero',positive,'pending',company||'|1') returning id into first_invoice;
  report:=sg10_private.commission_report(space,fixture_day,fixture_day);
  if report->'clients'->0->>'kg'<>'0' or (report->>'pending')::integer<>1 then raise exception 'Recepción no confirmada se ha contabilizado: %',report; end if;

  if public.sg10_confirm_reception(space,purchase_key)->'data'->>'status' is distinct from 'Cargado'
    or public.sg10_confirm_reception(space,purchase_key) is not null then raise exception 'Confirmación de recepción no idempotente'; end if;
  report:=sg10_private.commission_report(space,fixture_day,fixture_day);
  if (report->'clients'->0->>'kg')::numeric<>20 or (report->'clients'->0->>'commission')::numeric<>0.70
    or (report->>'processed')::integer<>1 then raise exception 'Factura y recepción con kilos extraídos no conciliadas: %',report; end if;

  begin
    insert into public.sg_invoices(workspace_id,created_by,invoice_number,invoice_data,status,sg10_fiscal_key)
      values(space,owner,positive->>'numero',positive,'pending',company||'|1');
    raise exception 'Se guardó una factura duplicada';
  exception when unique_violation then null;
  end;

  credit:=positive||jsonb_build_object('tipo','abono','numero',company||'-A1','fecha',fixture_day+1,'numero_original',positive->>'numero',
    'base',-8,'total',-8.32,'lineas','[{"producto":"Tomate azul CAT I","bultos":-1,"kilos_netos":-4,"precio":2,"unidad_precio":"kg"}]'::jsonb);
  insert into public.sg_invoices(workspace_id,created_by,invoice_number,invoice_data,status,sg10_fiscal_key)
    values(space,owner,credit->>'numero',credit,'pending',company||'|2');
  report:=sg10_private.commission_report(space,fixture_day,fixture_day+1);
  if (report->'clients'->0->>'kg')::numeric<>16 or (report->'clients'->0->>'commission')::numeric<>0.56
    or (report->>'processed')::integer<>2 then raise exception 'Abono verificado sin descontar: %',report; end if;
  report:=sg10_private.commission_report(space,fixture_day+1,fixture_day+1);
  if (report->'clients'->0->>'kg')::numeric<>-4 then raise exception 'El abono no aparece el día en que se emitió: %',report; end if;

  if exists(select 1 from sg10_private.invoice_review_findings(space,positive)) then raise exception 'Falsa incidencia en factura conciliada'; end if;
  if not exists(select 1 from sg10_private.invoice_review_findings(space,
    jsonb_set(positive,'{lineas,0,precio}','3')) where article like '%Precio distinto%') then raise exception 'No se detecta una diferencia verificable'; end if;
  if exists(select 1 from sg10_private.invoice_review_findings(space,
    (positive-'base')||'{"lineas":[{"producto":"Tomate azul CAT I","bultos":5,"kilos_netos":20,"precio":3}]}'::jsonb)) then
    raise exception 'Se detectó una diferencia con unidad desconocida';
  end if;
  if not exists(select 1 from sg10_private.invoice_review_findings(space,
    jsonb_set(positive,'{lineas,0,producto}','"Pimiento verde"')) where article like '%No figura%') then raise exception 'No se detecta la mercancía sin pedido'; end if;

  insert into public.sg_purchases(workspace_id,id,data) values(space,purchase_key||'-duplicada',purchase_data||'{"status":"Cargado"}');
  report:=sg10_private.commission_report(space,fixture_day,fixture_day);
  if (report->'clients'->0->>'kg')::numeric<>0 or (report->>'pending')::integer<>1 then raise exception 'Se asignó una factura a compras ambiguas'; end if;

  begin
    perform public.sg10_commission_report('00000000-0000-0000-0000-000000000000',fixture_day,fixture_day);
    raise exception 'Consulta de otro espacio permitida';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback;
