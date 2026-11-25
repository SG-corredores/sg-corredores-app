export function installOrderRecovery({ connection, storage = localStorage }) {
  const running = new Map();
  const prefix = ({ user, workspace }) => 'sg10-order-pending:' + user.id + ':' + workspace + ':';

  function pending(context = connection()) {
    if (!context.user || !context.workspace) return [];
    const start = prefix(context);
    const entries = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(start)) continue;
      try {
        const entry = JSON.parse(storage.getItem(key));
        if (entry?.payload && key === start + entry.id) entries.push(entry);
      } catch {}
    }
    return entries;
  }

  function send(context, entry) {
    const { api, workspace, user } = context;
    const key = prefix(context) + entry.id;
    if (running.has(key)) return running.get(key);
    const task = (async () => {
      let result;
      if (entry.kind === 'batch') {
        result = await api.rpc('sg10_staff_order', {space:workspace,request:entry.id,lines:entry.payload});
        if (!result.error && result.data !== 0 && result.data !== entry.payload.length)
          throw Error('Supabase devolvió una confirmación incompleta.');
      } else {
        const table = api.from('sg_orders');
        result = await table.upsert({workspace_id:workspace,id:entry.id,data:entry.payload,updated_by:user.id},
          {onConflict:'workspace_id,id',ignoreDuplicates:true}).select('id,data,updated_at');
        if (!result.error && !result.data?.length) {
          const existing = await api.from('sg_orders').select('id,data,updated_at')
            .eq('workspace_id',workspace).eq('id',entry.id).maybeSingle();
          result = { ...existing, data:existing.data ? [existing.data] : [] };
        }
        if (!result.error && !result.data?.length) throw Error('Supabase no confirmó la existencia del pedido.');
      }
      if (result.error) {
        if (result.status >= 400 && result.status < 500 && ![401, 408, 429].includes(result.status))
          storage.removeItem(key);
        throw Error(result.error.message);
      }
      storage.removeItem(key);
      return entry.kind === 'batch' ? entry.payload.length : result.data[0];
    })().finally(() => running.delete(key));
    running.set(key,task);
    return task;
  }

  function submit(kind, payload) {
    const context = connection();
    if (!context.user || !context.workspace) throw Error('Sesión no iniciada.');
    const signature = JSON.stringify(payload);
    const previous = pending(context).find(entry => entry.kind === kind && JSON.stringify(entry.payload) === signature);
    const entry = previous ?? {id:crypto.randomUUID(),kind,payload};
    storage.setItem(prefix(context) + entry.id, JSON.stringify(entry));
    return send(context,entry).catch(error => {
      if (storage.getItem(prefix(context) + entry.id))
        throw Error('Guardado sin confirmar. Puedes reintentarlo en Pedidos. ' + error.message);
      throw error;
    });
  }

  async function retry() {
    const context = connection();
    let confirmed = 0;
    for (const entry of pending(context)) {
      if (connection().user?.id !== context.user.id || connection().workspace !== context.workspace) break;
      try { await send(context,entry); confirmed++; } catch {}
    }
    return confirmed;
  }

  return { submit, pending, retry };
}
