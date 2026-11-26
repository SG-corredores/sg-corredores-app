CREATE OR REPLACE FUNCTION sg10_private.capture_operations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare before_row jsonb; after_row jsonb; payload jsonb; row_id text; space uuid; client text;
        kinds text[] := '{}'; kind text; label text; actor_label text; target text; actor_id uuid := auth.uid();
begin
  if tg_op <> 'INSERT' then before_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then after_row := to_jsonb(new); end if;
  payload := coalesce(after_row,before_row);
  space := (payload->>'workspace_id')::uuid;
  row_id := payload->>'id';
  if tg_table_name = 'sg_orders' then
    target := 'pedidos';
    if tg_op='INSERT' and after_row->'data'->>'portalBatch'='true'
      and row_id like 'portal:%' and after_row->'data'->>'origin'='portal' then return null; end if;
    if tg_op='INSERT' then kinds := array['nuevo_pedido','nuevo_articulo'];
    elsif tg_op='DELETE' then kinds := array['pedido_eliminado'];
    elsif (before_row->'data') is distinct from (after_row->'data') then kinds := array['pedido_modificado'];
    end if;
  elsif tg_table_name = 'sg_purchases' then
    target := 'compras';
    if tg_op='DELETE' then return null; end if;
    if (after_row->'data'->>'status') in ('Comprado','Cargado') and
        coalesce(before_row->'data'->>'status','') not in ('Comprado','Cargado') then
      kinds := array_append(kinds,'articulo_comprado');
    end if;
    if (after_row->'data'->>'status')='Cargado' and (before_row->'data'->>'status') is distinct from 'Cargado' then
      kinds := array_append(kinds,'mercancia_cargada');
    end if;
  end if;
  if tg_op <> 'DELETE' then
    if coalesce(after_row->'data'->>'priceCents',after_row->'data'->>'price') is distinct from
      coalesce(before_row->'data'->>'priceCents',before_row->'data'->>'price') then
      kinds := array_append(kinds,'precio');
    end if;
    if nullif(after_row->'data'->>'supplier','') is distinct from nullif(before_row->'data'->>'supplier','') then
      kinds := array_append(kinds,'puesto');
    end if;
  end if;
  client := payload->'data'->>'clientId';
  select data->>'name' into label from public.sg_clients where workspace_id=space and id=client;
  if actor_id is not null and exists(select 1 from public.sg_members where workspace_id=space and user_id=actor_id) then
    select left(coalesce(nullif(raw_user_meta_data->>'full_name',''),split_part(email,'@',1),'Empleado'),100)
      into actor_label from auth.users where id=actor_id;
  end if;
  foreach kind in array kinds loop
    insert into public.sg10_events(workspace_id,client_id,visible_to_clients,kind,client_name,article,actor,actor_name,target,record_id)
    values(space,client,false,kind,label,left(payload->'data'->>'product',160),actor_id,actor_label,target,row_id);
    if client is not null and kind in ('nuevo_pedido','articulo_comprado','mercancia_cargada','pedido_eliminado') then
      insert into public.sg10_events(workspace_id,client_id,visible_to_clients,kind,client_name,article,target,record_id)
      values(space,client,true,kind,label,left(payload->'data'->>'product',160),target,row_id);
    end if;
  end loop;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION sg10_private.portal_order(space uuid, company text, request uuid, day date, lines jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare item jsonb; idx integer:=0; product text; unit text; amount numeric; created integer:=0;
  label text; first_order text; summary text;
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
  first_order:='portal:'||auth.uid()||':'||request||':1';
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
        'boxes',amount,'quantityUnit',unit,'status','Pendiente','notes',coalesce(item->>'notes',''),'origin','portal','portalBatch',true),auth.uid())
      ;
    created:=created+1;
  end loop;
  select c.data->>'name' into label from public.sg_clients c where c.workspace_id=space and c.id=company;
  summary:=case when created=1 then product else created||' artículos' end||' · Entrega '||to_char(day,'DD/MM/YYYY');
  insert into public.sg10_events(workspace_id,client_id,visible_to_clients,kind,client_name,article,actor,target,record_id)
  values (space,company,false,'pedido_cliente',label,summary,auth.uid(),'pedidos',first_order),
         (space,company,true,'nuevo_pedido',label,summary,null,'pedidos',first_order);
  return created;
end $function$;

create unique index sg10_client_message_request on public.sg10_events(workspace_id, actor, record_id)
  where kind='mensaje_cliente';
create index sg10_client_message_rate on public.sg10_events(workspace_id, actor, created_at)
  where kind='mensaje_cliente';

create function sg10_private.submit_client_message(space uuid, company text, request uuid, body text)
returns void language plpgsql security definer set search_path='' as $$
declare sender uuid:=auth.uid(); message text:=btrim(body); company_name text;
begin
  if sender is null or company is null or not sg10_private.has_company(space,company) then raise insufficient_privilege; end if;
  if request is null or message is null or length(message) not between 1 and 800 then
    raise exception 'Escribe un mensaje de hasta 800 caracteres' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(space||':'||sender||':portal_message',0));
  if exists(select 1 from public.sg10_events e where e.workspace_id=space and e.actor=sender and e.kind='mensaje_cliente' and e.record_id=request::text) then
    if not exists(select 1 from public.sg10_events e where e.workspace_id=space and e.actor=sender and e.kind='mensaje_cliente'
      and e.record_id=request::text and e.client_id=company and e.article=message) then
      raise exception 'El mensaje ya se registró con otros datos' using errcode='PT409';
    end if;
    return;
  end if;
  if (select count(*) from public.sg10_events e where e.workspace_id=space and e.actor=sender and e.kind='mensaje_cliente'
    and e.created_at > now()-interval '10 minutes') >= 8 then
    raise exception 'Has enviado varios mensajes. Vuelve a intentarlo en unos minutos.' using errcode='PT429';
  end if;
  select c.data->>'name' into company_name from public.sg_clients c where c.workspace_id=space and c.id=company;
  insert into public.sg10_events(workspace_id,client_id,kind,client_name,article,actor,target,record_id)
  values(space,company,'mensaje_cliente',company_name,message,sender,'mensaje_cliente',request::text);
end
$$;

create function public.sg10_submit_client_message(space uuid, company text, request uuid, body text)
returns void language sql set search_path='' as $$
  select sg10_private.submit_client_message(space,company,request,body)
$$;
revoke all on function sg10_private.submit_client_message(uuid,text,uuid,text),
  public.sg10_submit_client_message(uuid,text,uuid,text) from public,anon;
grant execute on function sg10_private.submit_client_message(uuid,text,uuid,text),
  public.sg10_submit_client_message(uuid,text,uuid,text) to authenticated;
