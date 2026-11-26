import { captureWalkie, playWalkie } from "./walkie-audio.js";
import { openWalkieChannel } from "./walkie-realtime.js?v=2";

const holdMs = 250;

export function installWalkie({connection,dialog}) {
  let room, privateRoom, widget, speaker, muted=false, audio, speakerTimer;
  let holding=false, tuning=0.8, opening, transmission, roomGeneration=0, switching=false;
  const playing = new Set();
  const nextAudio = new Map();
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
  function channelName(){return privateRoom?"Canal privado":"Canal general";}
  function prepareAudio(){
    const Context=window.AudioContext||window.webkitAudioContext;
    if(!Context)throw Error("Este navegador no permite reproducir el audio del walkie.");
    if(!audio){
      const context=new Context();
      audio=context;
      context.addEventListener("statechange",()=>{
        if(audio===context&&context.state==="running"&&room?.ready&&!holding)
          state(channelName()+" · Mantén pulsado para hablar");
      });
    }
    // On touchscreens, the browser may wait until the first tap is released.
    if(audio.state!=="running")void audio.resume().catch(()=>{});
    return audio;
  }
  function silence(){
    clearTimeout(speakerTimer);
    speaker=null;
    for(const {source} of playing)source.stop();
    playing.clear();
    nextAudio.clear();
  }
  function sound(){
    if(muted)silence();
    else for(const {gain} of playing)gain.gain.value=tuning;
  }
  function online(){
    const select=widget?.querySelector("[data-peer]");
    if(!select||!room)return;
    const current=select.value;
    select.replaceChildren(new Option("Canal general",""),...room.online().map(person=>new Option(person.name,person.id)));
    if([...select.options].some(option=>option.value===current))select.value=current;
  }
  function receive(joined,payload){
    if(!payload||typeof payload.sender!=="string"||(privateRoom||room)!==joined||holding||muted||document.hidden||audio?.state!=="running")return;
    const now=audio.currentTime;
    const time=Math.max(now+.055,nextAudio.get(payload.sender)||0);
    if(time-now>1.25)return;
    const sample=playWalkie(audio,payload.samples,time,tuning);
    if(!sample)return;
    if(speaker!==payload.sender){
      speaker=payload.sender;
      beep();
      state("Habla "+(room?.online().find(person=>person.id===speaker)?.name||"un empleado"));
    }
    clearTimeout(speakerTimer);
    speakerTimer=setTimeout(()=>{speaker=null;state(channelName());},(sample.end-now+.35)*1000);
    playing.add(sample);
    nextAudio.set(payload.sender,sample.end);
    sample.source.onended=()=>{
      playing.delete(sample);
      if(nextAudio.get(payload.sender)===sample.end)nextAudio.delete(payload.sender);
    };
  }
  function invite(sender){
    const person=room?.online().find(peer=>peer.id===sender);
    if(!person||privateRoom||switching||document.hidden)return;
    beep();
    const box=dialog("Walkie-talkie");
    const content=box.querySelector("[data-content]");
    const line=document.createElement("p"),button=document.createElement("button");
    line.textContent=person.name+" quiere abrir un canal privado.";
    button.type="button";button.textContent="Entrar al canal privado";
    button.onclick=async()=>{
      button.disabled=true;
      const generation=roomGeneration;
      try{
        prepareAudio();
        const joined=await connect(sender);
        if(generation!==roomGeneration||privateRoom){await joined.disconnect();return;}
        stop();silence();privateRoom=joined;box.close();state(channelName());
      }catch(error){line.textContent=error.message;button.disabled=false;}
    };
    content.append(line,button);
  }
  async function connect(peer){
    const {api,workspace,user}=connection();
    if(!workspace||!user)throw Error("Inicia sesión como empleado.");
    return openWalkieChannel(api,workspace,user,peer,{
      audio:receive,
      online,
      invite,
      reconnected(joined){
        if(joined===(privateRoom||room))state(channelName());
      },
      disconnected(joined,status){
        if(joined!==room&&joined!==privateRoom)return;
        stop();silence();
        if(status==="CLOSED"){
          if(joined===room)room=null;
          if(joined===privateRoom){
            privateRoom=null;
            const select=widget?.querySelector("[data-peer]");
            if(select)select.value="";
          }
        }
        report("Se perdió la conexión del walkie.");
      },
    });
  }
  function report(message){
    state(message);
    showFeedback(message,5000);
  }
  async function start(){
    if(holding||switching)return;
    const attempt={};
    holding=true;
    silence();
    transmission=attempt;
    showFeedback(room?.ready ? "Abriendo micrófono…" : "Conectando al walkie…");
    try{
      const context=prepareAudio();
      if(!context.audioWorklet||!navigator.mediaDevices?.getUserMedia)
        throw Error("Abre SG Corredores en Chrome o Safari y permite el micrófono.");
      const microphone=(async()=>{
        await new Promise(resolve=>setTimeout(resolve,holdMs));
        if(transmission!==attempt)return null;
        const stream=await navigator.mediaDevices.getUserMedia({
          audio:{echoCancellation:true,noiseSuppression:true},video:false,
        });
        if(transmission===attempt)attempt.stream=stream;
        else stream.getTracks().forEach(track=>track.stop());
        return stream;
      })();
      const [current,stream]=await Promise.all([ensureRoom(),microphone]);
      if(transmission!==attempt)return;
      attempt.room=privateRoom||current;
      if(!attempt.room.ready)throw Error("El canal se está reconectando. Vuelve a pulsar cuando esté listo.");
      await context.resume();
      if(transmission!==attempt)return;
      const flush=await captureWalkie(context,stream,async samples=>{
        try{
          if(await attempt.room.send("audio",{samples})==="ok")return;
        }catch{}
        if(transmission===attempt){
          stop();
          report("No se ha enviado el audio. Comprueba la conexión y vuelve a intentarlo.");
        }
      });
      if(transmission!==attempt){flush?.();return;}
      attempt.flush=flush;
      shortcut.setAttribute("aria-pressed","true");
      beep();state("Estás hablando");showFeedback("Estás hablando");
    }catch(error){
      if(transmission===attempt){
        stop();
        const message=error.name==="NotAllowedError" ? "Permite el micrófono para hablar por el walkie."
          : error.name==="NotFoundError" ? "No se encuentra un micrófono disponible."
          : error.name==="NotReadableError" ? "El micrófono no está disponible. Comprueba si lo está usando otra aplicación."
          : error.message||"No se pudo abrir el micrófono.";
        report(message);
      }
    }
  }
  function stop(){
    if(!holding)return;
    const attempt=transmission;
    holding=false;
    transmission=null;
    attempt?.flush?.();
    attempt?.stream?.getTracks().forEach(track=>track.stop());
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
  let pressedAt;
  shortcut.addEventListener("pointerdown",event=>{
    if(event.isPrimary&&event.button===0)pressedAt=performance.now();
  });
  shortcut.addEventListener("click",()=>{
    const tap=pressedAt===undefined||performance.now()-pressedAt<holdMs;
    pressedAt=undefined;
    if(tap||audio?.state!=="running")void open();
  });
  async function close(){
    roomGeneration++;
    stop();
    const channels=[privateRoom,room], context=audio;
    privateRoom=room=opening=null;
    silence();widget?.remove();widget=null;audio=null;
    await Promise.allSettled([...channels.map(channel=>channel?.disconnect()),context?.close()]);
  }
  function makeWidget(){
    widget=document.createElement("section");
    widget.className="sg10-walkie";
    widget.innerHTML='<div class="sg10-walkie-drag">Walkie-talkie</div><p data-live role="status">Conectando…</p>'
      +'<select data-peer aria-label="Canal"><option value="">Canal general</option></select><div class="sg10-tools">'
      +'<button data-ptt type="button">Mantén para hablar</button><button data-mute type="button">Silenciar</button>'
      +'<button data-listen type="button">Escuchar</button><button data-close type="button">Salir</button>'
      +'</div><label>Volumen <input type="range" min="0" max="1" step=".05" value=".8"></label>';
    document.body.append(widget);
    const ptt=widget.querySelector("[data-ptt]");
    bindPushToTalk(ptt);
    widget.querySelector("[data-mute]").onclick=({currentTarget:button})=>{muted=!muted;button.textContent=muted?"Quitar silencio":"Silenciar";sound();};
    widget.querySelector("[data-listen]").onclick=()=>{void open();};
    widget.querySelector("[data-close]").onclick=close;
    widget.querySelector("input").oninput=({target})=>{tuning=Number(target.value);sound();};
    widget.querySelector("[data-peer]").onchange=async({target})=>{
      const peer=target.value;
      stop();silence();
      const generation=roomGeneration;
      switching=true;target.disabled=true;ptt.disabled=true;
      try{
        const previous=privateRoom;
        privateRoom=null;
        await previous?.disconnect();
        if(generation!==roomGeneration)return;
        if(peer){
          const joined=await connect(peer);
          if(generation!==roomGeneration){await joined.disconnect();return;}
          privateRoom=joined;
          const sent=await room?.send("invite",{to:peer});
          if(sent!=="ok"){
            await privateRoom.disconnect();privateRoom=null;
            throw Error("No se pudo enviar la invitación privada.");
          }
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
  document.addEventListener("visibilitychange",()=>{if(document.hidden){stop();silence();}});
  window.addEventListener("pagehide",stop);
  function ensureRoom(){
    if(room?.ready)return Promise.resolve(room);
    if(room)return Promise.reject(Error("El canal se está reconectando. Vuelve a pulsar cuando esté listo."));
    if(!opening){
      const generation=roomGeneration;
      const attempt=(async()=>{
        const joined=await connect();
        if(generation!==roomGeneration){
          await joined.disconnect();
          throw Error("Se cerró el walkie-talkie.");
        }
        room=joined;
        state("Canal general");online();
        if(widget)widget.querySelector("[data-ptt]").disabled=false;
        return room;
      })().finally(()=>{if(opening===attempt)opening=null;});
      opening=attempt;
    }
    return opening;
  }
  async function open(){
    if(!widget)makeWidget();
    try{
      prepareAudio();
      await ensureRoom();
      if(widget&&!holding){
        online();
        state(audio?.state==="running"?channelName()+" · Mantén pulsado para hablar":"Toca Escuchar para activar el audio.");
      }
    }catch(error){state(error.message);}
  }
  return {close,open,showShortcut(visible){shortcut.hidden=!visible;}};
}
