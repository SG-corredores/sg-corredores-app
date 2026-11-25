-- Run after both migrations in a transaction that will be rolled back.
do $$
declare
  space uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid(); staff_id uuid:=gen_random_uuid();
  client_user uuid:=gen_random_uuid(); wrong_user uuid:=gen_random_uuid(); invoice_id uuid:=gen_random_uuid();
  company text:='test-company'; staff_token text; client_token text; today date:=current_date; pdf_key text:=repeat('a',64);
begin
  insert into auth.users(id,aud,role,email,email_confirmed_at,is_anonymous) values
    (owner_id,'authenticated','authenticated',owner_id||'@sg10.invalid',now(),false),
    (staff_id,'authenticated','authenticated',staff_id||'@sg10.invalid',now(),false),
    (client_user,'authenticated','authenticated',client_user||'@sg10.invalid',now(),false),
    (wrong_user,'authenticated','authenticated',wrong_user||'@sg10.invalid',now(),false);
  insert into public.sg_workspaces(id,name) values(space,'SG10 prueba');
  insert into public.sg_members(workspace_id,user_id,role) values(space,owner_id,'owner');
  insert into public.sg_clients(workspace_id,id,data) values(space,company,'{"name":"Empresa prueba"}');
  insert into public.sg_invoices(id,workspace_id,invoice_number,customer_name,status,invoice_data,sg10_pdf_hash,created_by)
  values(invoice_id,space,'TEST','Empresa prueba','pending','{"gmail_id":"test-message"}',pdf_key,owner_id);
  insert into storage.objects(bucket_id,name) values('sg10-facturas-originales',space::text||'/'||pdf_key||'.pdf');
  if exists(select 1 from public.sg10_missing_invoice_pdfs(space,4)) then raise exception 'Se intentó recuperar un PDF ya guardado'; end if;

  perform set_config('request.jwt.claims',json_build_object('sub',owner_id,'role','authenticated')::text,true);
  set local role authenticated;
  staff_token:=public.sg10_create_whatsapp_invite(space,staff_id||'@sg10.invalid',null);
  client_token:=public.sg10_create_whatsapp_invite(space,client_user||'@sg10.invalid',company);
  if public.sg10_admin_portal_snapshot(space,company,today,today)->>'company'<>'Empresa prueba' then
    raise exception 'Vista de administrador incorrecta';
  end if;
  if not public.sg10_save_invoice_observations(space,invoice_id,'Revisar importe','') then
    raise exception 'Observaciones no guardadas';
  end if;
  if public.sg10_save_invoice_observations(space,invoice_id,'Cambiar sin recargar','') then
    raise exception 'Se aceptó una edición obsoleta';
  end if;

  perform set_config('request.jwt.claims',json_build_object('sub',wrong_user,'role','authenticated')::text,true);
  begin
    perform public.sg10_redeem_whatsapp_invite(staff_token,false);
    raise exception 'Se aceptó un correo distinto';
  exception when insufficient_privilege then null; end;
  begin
    perform public.sg10_create_whatsapp_invite(space,wrong_user||'@sg10.invalid',null);
    raise exception 'Se aceptó una invitación de un usuario sin permiso';
  exception when insufficient_privilege then null; end;

  perform set_config('request.jwt.claims',json_build_object('sub',staff_id,'role','authenticated')::text,true);
  perform public.sg10_redeem_whatsapp_invite(staff_token,false);
  if not exists(select 1 from public.sg_members where workspace_id=space and user_id=staff_id and role='employee') then
    raise exception 'No se asignó el rol de empleado';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='sg10-facturas-originales' and name=space::text||'/'||pdf_key||'.pdf') then
    raise exception 'El empleado no pudo leer el original';
  end if;
  begin
    perform public.sg10_redeem_whatsapp_invite(staff_token,false);
    raise exception 'La invitación se pudo usar dos veces';
  exception when insufficient_privilege then null; end;
  begin
    perform public.sg10_admin_portal_snapshot(space,company,today,today);
    raise exception 'Un empleado abrió la vista de administrador';
  exception when insufficient_privilege then null; end;

  perform set_config('request.jwt.claims',json_build_object('sub',client_user,'role','authenticated')::text,true);
  perform public.sg10_redeem_whatsapp_invite(client_token,true);
  if not exists(select 1 from public.sg10_company_users where workspace_id=space and client_id=company and user_id=client_user) then
    raise exception 'No se vinculó la empresa';
  end if;
  if exists(select 1 from storage.objects where bucket_id='sg10-facturas-originales' and name=space::text||'/'||pdf_key||'.pdf') then
    raise exception 'Un cliente leyó un PDF privado de empleados';
  end if;
  reset role;
end $$;
