-- Run after the migration in an isolated workspace or inside a single transaction with ROLLBACK.
do $$
declare
  space uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); staff uuid := gen_random_uuid();
  client_a text := 'sg10-a'; client_b text := 'sg10-b';
  day date := (now() at time zone 'Europe/Madrid')::date;
  request_id uuid := gen_random_uuid(); split_id uuid := gen_random_uuid();
  lines jsonb := '[{"product":"Pera prueba","quantity":3,"unit":"pales"}]';
  split_lines jsonb := '[{"supplier":"Salas","amount":1,"price":0.65,"priceUnit":"kg"},{"supplier":"Grupo Fernández","amount":1.5,"price":0.7,"priceUnit":"kg"}]';
  jpg_a uuid:=gen_random_uuid(); jpg_b uuid:=gen_random_uuid(); order_id text;
  actual integer; snapshot jsonb; n numeric; original uuid:=gen_random_uuid(); credit uuid:=gen_random_uuid(); other_credit uuid:=gen_random_uuid();
  doc jsonb; credit_doc jsonb;
begin
  insert into auth.users(id,aud,role,email,is_anonymous) values
    (a,'authenticated','authenticated',a||'@sg10.invalid',false),
    (b,'authenticated','authenticated',b||'@sg10.invalid',false),
    (staff,'authenticated','authenticated',staff||'@sg10.invalid',false);
  insert into public.sg_workspaces(id,name) values(space,'SG10 prueba');
  insert into public.sg_members(workspace_id,user_id,role) values(space,staff,'owner');
  insert into public.sg_clients(workspace_id,id,data) values
    (space,client_a,'{"name":"Empresa prueba A","notes":"interno A"}'),
    (space,client_b,'{"name":"Empresa prueba B","notes":"interno B"}');
  insert into public.sg10_company_users(workspace_id,client_id,user_id) values(space,client_a,a),(space,client_b,b);
  insert into public.sg10_gallery(id,workspace_id,client_id,product,image_path) values
    (jpg_a,space,client_a,'Foto A',space||'/a.jpg'),(jpg_b,space,client_b,'Foto B',space||'/b.jpg');
  insert into public.sg_pallets(workspace_id,data) values(space,'{"number":"P1","size":"half"}');

  perform set_config('request.jwt.claims',json_build_object('sub',a,'role','authenticated')::text,true);
  set local role authenticated;
  select public.sg10_portal_order(space,client_a,request_id,day,lines) into actual;
  if actual<>1 then raise exception 'El pedido de A no se guardó'; end if;
  select public.sg10_portal_order(space,client_a,request_id,day,lines) into actual;
  if actual<>0 then raise exception 'El reintento de A se duplicó'; end if;
  select public.sg10_portal_snapshot(space,client_a,day,day) into snapshot;
  if jsonb_array_length(snapshot->'orders')<>1 or snapshot->>'company' <> 'Empresa prueba A' then
    raise exception 'Lectura propia de A incorrecta'; end if;
  order_id:=snapshot->'orders'->0->>'id';
  begin
    perform public.sg10_portal_snapshot(space,client_b,day,day);
    raise exception 'A pudo leer B';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sg10_portal_order(space,client_b,gen_random_uuid(),day,lines);
    raise exception 'A pudo escribir B';
  exception when insufficient_privilege then null;
  end;
  if exists(select 1 from public.sg_orders where workspace_id=space) then raise exception 'Lectura directa de pedidos por clientes'; end if;
  if exists(select 1 from public.sg_pallets where workspace_id=space) then raise exception 'Lectura directa de palés por clientes'; end if;
  if not exists(select 1 from public.sg10_gallery where id=jpg_a) or exists(select 1 from public.sg10_gallery where id=jpg_b)
    then raise exception 'Visibilidad de la galería incorrecta'; end if;
  if exists(select 1 from public.sg10_events where workspace_id=space and (not visible_to_clients or client_id=client_b))
    then raise exception 'A recibió avisos de empleados o de B'; end if;

  perform set_config('request.jwt.claims',json_build_object('sub',b,'role','authenticated')::text,true);
  select public.sg10_portal_snapshot(space,client_b,day,day) into snapshot;
  if jsonb_array_length(snapshot->'orders')<>0 then raise exception 'B pudo leer pedidos de A'; end if;

  perform set_config('request.jwt.claims',json_build_object('sub',staff,'role','authenticated')::text,true);
  select public.sg10_split_purchase(space,order_id,split_id,split_lines) into actual;
  if actual<>2 then raise exception 'No se guardaron los dos puestos'; end if;
  select public.sg10_split_purchase(space,order_id,split_id,split_lines) into actual;
  if actual<>0 then raise exception 'Reintento de reparto duplicado'; end if;
  select sum((data->>'sgBoughtPallets')::numeric) into n from public.sg_purchases where workspace_id=space and data->>'orderId'=order_id;
  if n is distinct from 2.5 then raise exception 'No se mantuvo el medio palé'; end if;
  select (data->>'priceCents')::numeric into n from public.sg_purchases where workspace_id=space and data->>'supplier'='Salas';
  if n is distinct from 65 then raise exception 'El precio 0,65 cambió'; end if;
  begin
    perform public.sg10_split_purchase(space,order_id,gen_random_uuid(),split_lines);
    raise exception 'La sobrecompra no se bloqueó';
  exception when raise_exception then
    if sqlerrm is distinct from 'El reparto supera los palés pendientes del pedido' then raise; end if;
  end;
  if (select count(*) from public.sg_purchases where workspace_id=space and data->>'orderId'=order_id)<>2
    then raise exception 'La sobrecompra dejó líneas parciales'; end if;
  if not exists(select 1 from public.sg10_events where workspace_id=space and kind='precio' and not visible_to_clients)
    then raise exception 'No se registró el aviso de precio'; end if;
  doc:=jsonb_build_object('tipo','factura','fecha',day,'cif_proveedor','B12345678','proveedor','Salas','client_id',client_a,
    'numero','PRUEBA-100','total',100,'lineas',jsonb_build_array(jsonb_build_object('producto','Pera prueba','cajas',4,'precio',0.85)));
  credit_doc:=jsonb_build_object('tipo','abono','fecha',day,'cif_proveedor','B12345678','proveedor','Salas','client_id',client_a,
    'numero','ABONO-20','total',20,'lineas',jsonb_build_array(jsonb_build_object('producto','Pera prueba')));
  insert into public.sg_invoices(id,workspace_id,invoice_number,customer_name,invoice_data,status,sg10_fiscal_key)
  values (original,space,'PRUEBA-100','Empresa prueba A',doc,'pending','fixture-100'),
    (credit,space,'ABONO-20','Empresa prueba A',credit_doc,'pending','fixture-20'),
    (other_credit,space,'ABONO-90','Empresa prueba A',credit_doc||'{"numero":"ABONO-90","total":90}'::jsonb,'pending','fixture-90');
  if not exists(select 1 from public.sg10_events where workspace_id=space and record_id=original::text and kind='factura_discrepancia'
    and article like '%precio%') then raise exception 'No se notificó el precio distinto en factura'; end if;
  if not public.sg10_invoice_review(space,original,doc,'pending',
    jsonb_build_object('invoice_number','PRUEBA-100','invoice_data',doc,'status','approved','sg10_fiscal_key','fixture-100')) then
    raise exception 'No se aprobó la factura original'; end if;
  if not public.sg10_invoice_review(space,credit,credit_doc,'pending',
    jsonb_build_object('invoice_number','ABONO-20','invoice_data',credit_doc,'status','approved','sg10_fiscal_key','fixture-20','original_id',original)) then
    raise exception 'No se aprobó el abono'; end if;
  select net into n from public.sg10_invoice_balances where id=original;
  if n is distinct from 80 then raise exception 'El abono no dejó un saldo de 80 euros'; end if;
  begin
    perform public.sg10_invoice_review(space,other_credit,credit_doc||'{"numero":"ABONO-90","total":90}'::jsonb,'pending',
      jsonb_build_object('invoice_number','ABONO-90','invoice_data',credit_doc||'{"numero":"ABONO-90","total":90}'::jsonb,
      'status','approved','sg10_fiscal_key','fixture-90','original_id',original));
    raise exception 'Se admitió un abono excesivo';
  exception when raise_exception then
    if sqlerrm is distinct from 'El abono supera el importe disponible de la factura original' then raise; end if;
  end;
  reset role;
end $$;
