CREATE OR REPLACE FUNCTION sg10_private.capture_operations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare before_row jsonb; after_row jsonb; payload jsonb; previous_price numeric; next_price numeric; row_id text; space uuid; client text;
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
    previous_price:=coalesce(sg10_private.number(before_row->'data'->>'priceCents')/100,sg10_private.number(before_row->'data'->>'price'));
    next_price:=coalesce(sg10_private.number(after_row->'data'->>'priceCents')/100,sg10_private.number(after_row->'data'->>'price'));
    if next_price is distinct from previous_price or
        (next_price is not null and coalesce(nullif(after_row->'data'->>'priceUnit',''),'kg') is distinct from
          coalesce(nullif(before_row->'data'->>'priceUnit',''),'kg')) then
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
