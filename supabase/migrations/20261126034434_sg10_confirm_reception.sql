create function public.sg10_confirm_reception(space uuid, purchase_id text)
returns jsonb language sql set search_path='' as $$
  update public.sg_purchases p set data=p.data||jsonb_build_object('receivedAt',statement_timestamp(),'receivedBy',auth.uid()),
    updated_at=statement_timestamp(),updated_by=auth.uid()
  where p.workspace_id=space and p.id=purchase_id and public.sg_is_member(space)
    and coalesce(p.data->>'status','') not in ('Cancelado','Anulado')
    and nullif(p.data->>'receivedAt','') is null
  returning jsonb_build_object('id',p.id,'data',p.data,'updated_at',p.updated_at)
$$;
revoke all on function public.sg10_confirm_reception(uuid,text) from public,anon;
grant execute on function public.sg10_confirm_reception(uuid,text) to authenticated;
