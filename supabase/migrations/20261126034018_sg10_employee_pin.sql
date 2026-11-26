create table sg10_private.employee_pin (
  digest text primary key,
  workspace_id uuid not null,
  user_id uuid not null unique,
  foreign key (workspace_id,user_id) references public.sg_members(workspace_id,user_id) on delete cascade
);

create table sg10_private.employee_pin_attempts (
  bucket text primary key, started_at timestamptz not null, attempts integer not null
);

create function public.sg10_employee_pin_attempt(p_bucket text, p_limit integer)
returns boolean language sql security definer set search_path='' as $$
  with hit as (
    insert into sg10_private.employee_pin_attempts as a(bucket,started_at,attempts) values(p_bucket,now(),1)
    on conflict (bucket) do update
      set started_at=case when a.started_at > now()-interval '15 minutes' then a.started_at else now() end,
          attempts=case when a.started_at > now()-interval '15 minutes' then a.attempts+1 else 1 end
      where a.started_at <= now()-interval '15 minutes' or a.attempts<p_limit
    returning true
  ) select exists(select 1 from hit)
$$;

create function public.sg10_register_employee_pin(space uuid, owner_id uuid, employee_id uuid, employee_name text, p_digest text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.sg_members where workspace_id=space and user_id=owner_id and role='owner') then
    raise insufficient_privilege;
  end if;
  insert into public.sg_members(workspace_id,user_id,role) values(space,employee_id,'employee');
  insert into public.sg10_staff_names(workspace_id,user_id,display_name) values(space,employee_id,employee_name);
  insert into sg10_private.employee_pin(digest,workspace_id,user_id) values(p_digest,space,employee_id);
end
$$;

create function public.sg10_find_employee_pin(p_digest text)
returns uuid language sql stable security definer set search_path='' as $$
  select pin.user_id from sg10_private.employee_pin pin
  join public.sg_members m on m.workspace_id=pin.workspace_id and m.user_id=pin.user_id and m.role='employee'
  join auth.users u on u.id=pin.user_id and u.raw_app_meta_data->>'sg10_pin_account'='true'
  where pin.digest=p_digest and not exists(select 1 from public.sg_members elevated where elevated.user_id=pin.user_id and elevated.role<>'employee')
$$;

revoke all on function public.sg10_employee_pin_attempt(text,integer),
  public.sg10_register_employee_pin(uuid,uuid,uuid,text,text),public.sg10_find_employee_pin(text) from public,anon,authenticated;
grant execute on function public.sg10_employee_pin_attempt(text,integer),
  public.sg10_register_employee_pin(uuid,uuid,uuid,text,text),public.sg10_find_employee_pin(text) to service_role;
