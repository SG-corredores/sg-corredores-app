export async function openWalkieChannel(api, workspace, user, peer, handlers) {
  const prefix = "sg10-walkie:" + workspace + ":";
  const topic = peer ? prefix + "private:" + [user.id,peer].sort().join(":") : prefix + "general";
  await api.realtime.setAuth();
  const channel = api.channel(topic,{config:{private:true,broadcast:{ack:true},presence:{key:user.id,enabled:!peer}}});
  const name = String(user.user_metadata?.full_name || user.user_metadata?.username || "Empleado").trim().slice(0,80);
  let open = false;
  let closed = false;
  const room = {
    get ready() { return open && !closed; },
    online() {
      return Object.entries(channel.presenceState()).filter(([id])=>id!==user.id)
        .map(([id, sessions]) => ({id,name:sessions[0]?.name || "Empleado"}));
    },
    send(event, payload) {
      if (open && !closed) return channel.send({type:"broadcast",event,payload:{...payload,sender:user.id}});
    },
    async disconnect() {
      if (closed) return;
      closed = true;
      open = false;
      await api.removeChannel(channel);
    },
  };
  channel.on("broadcast",{event:"audio"},({payload})=>{
    if (payload?.sender !== user.id) handlers.audio(room,payload);
  });
  if (!peer) {
    channel.on("presence",{event:"sync"},()=>handlers.online());
    channel.on("broadcast",{event:"invite"},({payload})=>{
      if (payload?.to === user.id && payload.sender !== user.id) handlers.invite(payload.sender);
    });
  }

  try {
    await new Promise((resolve,reject)=>{
      let entered = false;
      channel.subscribe((status)=>{
        if (closed) return;
        open = status === "SUBSCRIBED";
        if (open) {
          if (!peer) void channel.track({name}).catch(()=>{});
          if (entered) handlers.reconnected(room);
          entered = true;
          resolve();
        } else if (["TIMED_OUT","CHANNEL_ERROR","CLOSED"].includes(status)) {
          if (entered) handlers.disconnected(room,status);
          else reject(Error("No se pudo conectar al canal de voz. Comprueba la conexión y tu acceso de empleado."));
        }
      },8000);
    });
    return room;
  } catch (error) {
    await room.disconnect();
    throw error;
  }
}
