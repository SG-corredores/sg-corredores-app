begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('sg10-facturas-originales','sg10-facturas-originales',false,10000000,array['application/pdf']);
create policy sg10_invoice_original_staff on storage.objects for select to authenticated using (
  bucket_id='sg10-facturas-originales'
  and public.sg_is_member(
    case when split_part(name,'/',1) ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    then split_part(name,'/',1)::uuid end
  )
);

create function public.sg10_missing_invoice_pdfs(p_workspace uuid,p_limit integer default 4)
returns table(gmail_id text,pdf_hash text)
language sql stable security invoker set search_path='' as $$
  select i.invoice_data->>'gmail_id',i.sg10_pdf_hash
  from public.sg_invoices i
  where i.workspace_id=p_workspace and i.sg10_pdf_hash ~ '^[a-f0-9]{64}$'
    and coalesce(i.invoice_data->>'gmail_id','')<>''
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id='sg10-facturas-originales' and o.name=p_workspace::text||'/'||i.sg10_pdf_hash||'.pdf'
    )
  order by i.created_at
  limit least(greatest(coalesce(p_limit,4),1),100);
$$;
revoke all on function public.sg10_missing_invoice_pdfs(uuid,integer) from public,anon,authenticated;
grant execute on function public.sg10_missing_invoice_pdfs(uuid,integer) to service_role;

create function public.sg10_save_invoice_observations(p_workspace uuid,p_invoice uuid,p_notes text,p_previous text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if not coalesce(public.sg_is_owner(p_workspace),false) then raise insufficient_privilege; end if;
  if length(coalesce(p_notes,''))>2000 then raise exception 'Máximo 2000 caracteres' using errcode='22023'; end if;
  update public.sg_invoices set invoice_data=jsonb_set(invoice_data,'{observaciones}',to_jsonb(btrim(coalesce(p_notes,''))),true)
  where workspace_id=p_workspace and id=p_invoice and coalesce(invoice_data->>'observaciones','')=coalesce(p_previous,'');
  get diagnostics changed=row_count;
  return changed=1;
end $$;
revoke all on function public.sg10_save_invoice_observations(uuid,uuid,text,text) from public,anon;
grant execute on function public.sg10_save_invoice_observations(uuid,uuid,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
