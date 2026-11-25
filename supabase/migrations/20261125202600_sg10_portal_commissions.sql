begin;
alter table public.sg10_commission_reviews
  add column published_kg numeric(15,3) check (published_kg >= 0),
  add column published_total numeric(15,2) check (published_total >= 0),
  add constraint sg10_commission_published_totals check (
    (published_kg is null and published_total is null) or
    (status = 'enviada' and published_kg is not null and published_total is not null)
  );

create function public.sg10_portal_commissions(space uuid,company text,from_date date,to_date date)
returns table(date_from date,date_to date,weight numeric,total numeric)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or company is null or not (
    sg10_private.has_company(space,company) or
    (coalesce(public.sg_is_owner(space),false) and coalesce(auth.jwt()->>'is_anonymous','false')<>'true')
  ) then raise insufficient_privilege; end if;
  return query
    select c.date_from,c.date_to,c.published_kg,c.published_total
    from public.sg10_commission_reviews c
    where c.workspace_id=space and c.client_id=company and c.status='enviada'
      and c.date_from<=to_date and c.date_to>=from_date
    order by c.date_to desc,c.date_from desc
    limit 100;
end $$;
revoke all on function public.sg10_portal_commissions(uuid,text,date,date) from public,anon;
grant execute on function public.sg10_portal_commissions(uuid,text,date,date) to authenticated;
notify pgrst, 'reload schema';
commit;
