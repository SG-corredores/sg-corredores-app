alter table public.sg10_buyers
  add column employee_id uuid,
  add constraint sg10_buyers_employee_unique unique (workspace_id, employee_id),
  add constraint sg10_buyers_employee_fk foreign key (workspace_id, employee_id)
    references public.sg_members (workspace_id, user_id) on delete set null (employee_id);

grant insert (employee_id), update (employee_id) on public.sg10_buyers to authenticated;
