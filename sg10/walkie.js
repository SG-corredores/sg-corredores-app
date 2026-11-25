import { invoke } from "./common.js";

export function installWalkie({connection,dialog}) {
  let room, privateRoom, widget, sdk, userId, microphone, muted=false, audio;
  let holding=false, tuning=0.8, opening, transmission, roomGeneration=0, switching=false;
  const tracks=new Map();
  const shortcut=document.createElement("button");
  shortcut.type="button";
  shortcut.className="sg10-walkie-shortcut";
  shortcut.hidden=true;
  shortcut.setAttribute("aria-label","Walkie-talkie · Mantén pulsado para hablar");
  shortcut.setAttribute("aria-pressed","false");
  shortcut.title="Mantén pulsado para hablar";
  shortcut.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8V3m-2 5h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm3 4h4m-4 3h4m-4 3h2m9-12a5 5 0 0 1 0 7"/></svg>';
  const feedback=document.createElement("div");
  feedback.className="sg10-walkie-feedback";
  feedback.setAttribute("role","status");
  feedback.setAttribute("aria-live","polite");
  feedback.hidden=true;
  document.body.append(shortcut,feedback);
  let feedbackTimer;
  function showFeedback(text, timeout=0){
    clearTimeout(feedbackTimer);
    feedback.textContent=text;
    feedback.hidden=!text;
    if(timeout)feedbackTimer=setTimeout(()=>showFeedback(""),timeout);
  }
  const output=()=>widget?.querySelector("[data-live]");
  const state=(text)=>{if(output())output().textContent=text;};
  function beep(){
    if(muted||audio?.state!=="running")return;
    const tone=audio.createOscillator(), vol=audio.createGain();
    tone.frequency.value=640;vol.gain.value=.055*tuning;tone.connect(vol);vol.connect(audio.destination);
    tone.start();tone.stop(audio.currentTime+.1);
  }
  function sound(){
    for(const [id,{player,privateChannel}] of tracks){
      player.volume=tuning;
      player.muted=muted||(!privateChannel&&Boolean(privateRoom));
      if(!player.muted)player.play().catch(()=>state("Pulsa Escuchar para activar el audio."));
    }
  }
  function online() {
    const select=widget?.querySelector("[data-peer]");
    if(!select||!room)return;
    const current=select.value;
    select.replaceChildren(new Option("Canal general",""),...[...room.remoteParticipants.values()].map(
      person=>new Option(person.name||"Empleado",person.identity)));
    if([...select.options].some(option=>option.value===current))select.value=current;
  }
  async function connect(peer){
    const {api,workspace,user}=connection();
    if(!workspace||!user||user.is_anonymous)throw Error("Usa tu cuenta individual de empleado.");
    sdk??=await import("https://cdn.jsdelivr.net/npm/livekit-client@2.15.6/+esm");
    const token=await invoke(api,"sg10-walkie",{workspace,peer});
    if(connection().user?.id!==user.id)throw Error("La sesión ha cambiado.");
    userId=token.identity;
    const joined=new sdk.Room({adaptiveStream:false,dynacast:false});
    const privateChannel=Boolean(peer);
    joined.on(sdk.RoomEvent.TrackSubscribed,(track)=>{
      if(track.kind!=="audio")return;
      const player=track.attach();
      player.hidden=true;
      document.body.append(player);
      tracks.set(track.sid,{player,privateChannel});
      sound();
    });
    joined.on(sdk.RoomEvent.TrackUnsubscribed,(track)=>{
      for(const item of track.detach())item.remove();
      tracks.delete(track.sid);
    });
    joined.on(sdk.RoomEvent.ActiveSpeakersChanged,speakers=>{
      if((privateRoom||room)!==joined||holding)return;
      const person=speakers.find(person=>person.identity!==userId);
      if(person){if(microphone!==person.identity)beep();microphone=person.identity;state("Habla "+(person.name||"un empleado"));}
      else {microphone=null;state(privateChannel?"Canal privado":"Canal general");}
    });
    if(!peer){
      joined.on(sdk.RoomEvent.ParticipantConnected,online).on(sdk.RoomEvent.ParticipantDisconnected,online);
      joined.on(sdk.RoomEvent.DataReceived,(packet,sender)=>{
        if(new TextDecoder().decode(packet)!=="sg10-private-invite"||!sender||privateRoom)return;
        beep();
        const dialogBox=dialog("Walkie-talkie");
        const content=dialogBox.querySelector("[data-content]");
        const line=document.createElement("p"), button=document.createElement("button");
        line.textContent=(sender.name||"Un empleado")+" quiere abrir un canal privado.";
        button.type="button";button.textContent="Entrar al canal privado";
        button.onclick=async()=>{
          button.disabled=true;
          try{privateRoom=await connect(sender.identity);sound();dialogBox.close();state("Canal privado");}
          catch(error){line.textContent=error.message;button.disabled=false;}
        };
        content.append(line,button);
      });
    }
    await joined.connect(token.url,token.token,{autoSubscribe:true});
    await joined.startAudio().catch(()=>{});
    return joined;
  }
  async function start(){
    if(holding||switching)return;
    const attempt={};
    holding=true;
    transmission=attempt;
    showFeedback(room ? "Abriendo micrófono…" : "Conectando al walkie…");
    try{
      const current=await ensureRoom();
      if(transmission!==attempt)return;
      attempt.room=privateRoom||current;
      if(!navigator.mediaDevices?.getUserMedia)throw Error("Este navegador no permite usar el micrófono.");
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(transmission!==attempt){
        stream.getTracks().forEach(track=>track.stop());
        return;
      }
      attempt.stream=stream;
      const audioTrack=stream.getAudioTracks()[0];
      if(!audioTrack)throw Error("No se encontró un micrófono.");
      audioTrack.enabled=false;
      const track=new sdk.LocalAudioTrack(audioTrack);
      attempt.track=track;
      await track.mute();
      if(transmission!==attempt)return;
      attempt.publishing=true;
      await attempt.room.localParticipant.publishTrack(track,{source:sdk.Track.Source.Microphone,stopMicTrackOnMute:false});
      if(transmission!==attempt){
        await attempt.room.localParticipant.unpublishTrack(track,false);
        return;
      }
      await track.unmute();
      if(transmission!==attempt)return;
      shortcut.setAttribute("aria-pressed","true");
      beep();state("Estás hablando");showFeedback("Estás hablando");
    }catch(error){
      if(transmission===attempt){
        stop();
        const message=error.message||"No se pudo abrir el micrófono.";
        state(message);
        showFeedback(message,5000);
      }
    }
  }
  function stop(){
    if(!holding)return;
    const attempt=transmission;
    holding=false;
    transmission=null;
    attempt?.stream?.getTracks().forEach(track=>track.stop());
    if(attempt?.track&&!attempt.publishing)attempt.track.stop();
    if(attempt?.track&&attempt.publishing)attempt.room.localParticipant.unpublishTrack(attempt.track,false).catch(()=>{});
    shortcut.setAttribute("aria-pressed","false");
    state(privateRoom?"Canal privado":"Canal general");
    showFeedback("");
  }
  function bindPushToTalk(button){
    button.addEventListener("pointerdown",event=>{
      if(!event.isPrimary||event.button!==0)return;
      button.setPointerCapture(event.pointerId);
      void start();
    });
    for(const name of ["pointerup","pointercancel","lostpointercapture","blur"])button.addEventListener(name,stop);
    button.addEventListener("keydown",event=>{
      if(!["Space","Enter"].includes(event.code))return;
      event.preventDefault();
      if(!event.repeat)void start();
    });
    button.addEventListener("keyup",event=>{
      if(!["Space","Enter"].includes(event.code))return;
      event.preventDefault();
      stop();
    });
    button.addEventListener("contextmenu",event=>event.preventDefault());
  }
  bindPushToTalk(shortcut);
  async function close(){
    roomGeneration++;
    stop();
    await Promise.allSettled([privateRoom?.disconnect(),room?.disconnect()]);
    privateRoom=room=null;
    for(const {player} of tracks.values())player.remove();
    tracks.clear();widget?.remove();widget=null;
    await audio?.close().catch(()=>{});audio=null;
  }
  function makeWidget(){
    widget=document.createElement("section");
    widget.className="sg10-walkie";
    widget.innerHTML='<div class="sg10-walkie-drag">Walkie-talkie</div><p data-live role="status">Conectando…</p>'
      +'<select data-peer aria-label="Canal"><option value="">Canal general</option></select><div class="sg10-tools">'
      +'<button data-ptt type="button" disabled>Mantén para hablar</button><button data-mute type="button">Silenciar</button>'
      +'<button data-listen type="button">Escuchar</button><button data-close type="button">Salir</button>'
      +'</div><label>Volumen <input type="range" min="0" max="1" step=".05" value=".8"></label>';
    document.body.append(widget);
    const ptt=widget.querySelector("[data-ptt]");
    bindPushToTalk(ptt);
    widget.querySelector("[data-mute]").onclick=({currentTarget:button})=>{muted=!muted;button.textContent=muted?"Quitar silencio":"Silenciar";sound();};
    widget.querySelector("[data-listen]").onclick=()=>{(privateRoom||room)?.startAudio();audio?.resume();sound();};
    widget.querySelector("[data-close]").onclick=close;
    widget.querySelector("input").oninput=({target})=>{tuning=Number(target.value);sound();};
    widget.querySelector("[data-peer]").onchange=async({target})=>{
      const peer=target.value;
      stop();
      switching=true;target.disabled=true;ptt.disabled=true;
      try{
        await privateRoom?.disconnect();privateRoom=null;
        if(peer){
          privateRoom=await connect(peer);
          await room.localParticipant.publishData(new TextEncoder().encode("sg10-private-invite"),{reliable:true,destinationIdentities:[peer]});
        }
        sound();state(peer?"Canal privado":"Canal general");
      }catch(error){state(error.message);target.value="";}
      finally{switching=false;target.disabled=false;ptt.disabled=false;}
    };
    const handle=widget.querySelector(".sg10-walkie-drag");
    handle.onpointerdown=(event)=>{
      if(event.button!==0)return;
      handle.setPointerCapture(event.pointerId);
      const bounds=widget.getBoundingClientRect();
      const x=event.clientX-bounds.left,y=event.clientY-bounds.top;
      handle.onpointermove=(next)=>{
        widget.style.left=Math.max(4,Math.min(innerWidth-widget.offsetWidth-4,next.clientX-x))+"px";
        widget.style.top=Math.max(4,Math.min(innerHeight-widget.offsetHeight-4,next.clientY-y))+"px";
        widget.style.right=widget.style.bottom="auto";
      };
      handle.onlostpointercapture=()=>{handle.onpointermove=null;};
    };
  }
  document.addEventListener("visibilitychange",()=>{if(document.hidden)stop();});
  window.addEventListener("pagehide",stop);
  function ensureRoom(){
    if(room)return Promise.resolve(room);
    if(!opening){
      const generation=roomGeneration;
      opening=(async()=>{
        const Context=window.AudioContext||window.webkitAudioContext;
        if(Context&&!audio){audio=new Context();await audio.resume().catch(()=>{});}
        const joined=await connect();
        if(generation!==roomGeneration){
          await joined.disconnect();
          throw Error("Se cerró el walkie-talkie.");
        }
        room=joined;
        state("Canal general");online();
        if(widget)widget.querySelector("[data-ptt]").disabled=false;
        return room;
      })().finally(()=>{opening=null;});
    }
    return opening;
  }
  return {
    close,
    showShortcut(visible){shortcut.hidden=!visible;},
    async open(){
      if(!widget)makeWidget();
      try{
        await ensureRoom();
        if(widget){widget.querySelector("[data-ptt]").disabled=false;online();}
      }catch(error){state(error.message);}
    },
  };
}
