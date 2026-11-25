create function sg10_private.walkie_topic_allowed(topic text, extension text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when topic ~ '^sg10-walkie:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:general$'
      and extension in ('presence','broadcast')
      then public.sg_is_member(split_part(topic, ':', 2)::uuid)
    when topic ~ '^sg10-walkie:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:private:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and extension = 'broadcast'
      then (select auth.uid())::text in (split_part(topic, ':', 4),split_part(topic, ':', 5))
        and split_part(topic, ':', 4) < split_part(topic, ':', 5)
        and public.sg_is_member(split_part(topic, ':', 2)::uuid)
    else false
  end;
$$;

revoke all on function sg10_private.walkie_topic_allowed(text,text) from public;
grant execute on function sg10_private.walkie_topic_allowed(text,text) to authenticated;

create policy sg10_walkie_receive on realtime.messages for select to authenticated
  using (sg10_private.walkie_topic_allowed(realtime.topic(),extension));

create policy sg10_walkie_send on realtime.messages for insert to authenticated
  with check (sg10_private.walkie_topic_allowed(realtime.topic(),extension));
