-- Run after verifying that GitHub Pages is serving version.json for this release.
begin;
insert into public.sg10_events(workspace_id,visible_to_clients,kind,article,target,record_id)
select w.id,portal,'actualizacion','SG Corredores 10.0.0-rc.1','ajustes','10.0.0-rc.1'
from public.sg_workspaces w cross join (values(false),(true)) as recipients(portal)
where not exists (select 1 from public.sg10_events e where e.workspace_id=w.id and e.kind='actualizacion'
  and e.visible_to_clients=portal and e.record_id='10.0.0-rc.1');
commit;
