const greetings = [
  "¡Hola! Soy Aguacatín. Pregúntame por los pedidos y compras de tu empresa.",
  "¡Aguacatín al habla! Hoy no se nos escapa ni un tomate. ¿Qué quieres consultar?",
  "¡Buenas! Dime qué quieres saber sobre tus pedidos o tus compras.",
];
const positionKey = "sg10_portal_aguacatin_position";

export function installAguacatin(preview, ask) {
  const widget = document.getElementById("portal-aguacatin");
  const avatar = document.getElementById("portal-agu-avatar");
  const controls = document.getElementById("portal-agu-controls");
  const answer = document.getElementById("portal-agu-answer");
  const form = document.getElementById("portal-agu-form");
  const input = document.getElementById("portal-agu-question");
  const mic = document.getElementById("portal-agu-mic");
  const submit = form.querySelector('button[type="submit"]');
  const isOpen = () => !controls.hidden;

  let recognition, speech, press, timer, position;
  let suppressClick = false;
  let revision = 0;
  let greeting = Math.floor(Math.random() * greetings.length);

  function stopListening() {
    const active = recognition;
    recognition = null;
    active?.abort();
    widget.classList.remove("is-listening");
    mic.setAttribute("aria-pressed", "false");
    mic.setAttribute("aria-label", "Activar micrófono");
  }

  function stopSpeaking() {
    if (speech) window.speechSynthesis.cancel();
    speech = null;
  }

  function place() {
    if (!position || isOpen()) return;
    const clamp = (value, ceiling) => Math.max(8, Math.min(value, ceiling - 8));
    widget.style.left = clamp(position.x, document.documentElement.clientWidth - 83) + "px";
    widget.style.top = clamp(position.y, document.documentElement.clientHeight - 114) + "px";
    widget.style.right = "auto";
    widget.style.bottom = "auto";
  }

  function close(restoreFocus = false) {
    revision++;
    stopListening();
    stopSpeaking();
    controls.hidden = true;
    widget.classList.remove("is-open");
    avatar.setAttribute("aria-expanded", "false");
    avatar.setAttribute("aria-label", "Abrir Aguacatín");
    submit.disabled = false;
    mic.disabled = false;
    input.value = "";
    answer.textContent = "";
    place();
    if (restoreFocus) avatar.focus({preventScroll:true});
  }

  function open() {
    [widget.style.left, widget.style.top, widget.style.right, widget.style.bottom] = ["", "", "", ""];
    controls.hidden = false;
    widget.classList.add("is-open");
    avatar.setAttribute("aria-expanded", "true");
    avatar.setAttribute("aria-label", "Cerrar Aguacatín");
    form.hidden = preview;
    answer.textContent = preview ? "Aquí tus clientes pueden consultar sus pedidos y compras con Aguacatín." : greetings[greeting++ % greetings.length];
  }

  async function send(text, spoken = false) {
    if (!text || preview || !isOpen() || submit.disabled) return;
    const current = revision;
    stopListening();
    stopSpeaking();
    submit.disabled = true;
    mic.disabled = true;
    input.value = "";
    answer.textContent = "Consultando…";
    try {
      const response = await ask(text);
      if (current !== revision) return;
      answer.textContent = response;
      if (spoken && response && "speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance(response);
        speech = utterance;
        utterance.lang = "es-ES";
        utterance.onend = utterance.onerror = () => { if (speech === utterance) speech = null; };
        window.speechSynthesis.speak(utterance);
      }
    } catch (error) {
      if (current === revision) {
        input.value = text;
        answer.textContent = error.message;
      }
    } finally {
      if (current === revision) {
        submit.disabled = false;
        mic.disabled = false;
      }
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    send(input.value.trim());
  });

  mic.addEventListener("click", () => {
    if (recognition) {
      stopListening();
      answer.textContent = "Micrófono desactivado.";
      return;
    }
    const Recognizer = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognizer) {
      answer.textContent = "El micrófono no está disponible en este navegador. Puedes escribirme.";
      return;
    }
    stopSpeaking();
    const active = new Recognizer();
    recognition = active;
    active.lang = "es-ES";
    active.onresult = event => {
      if (recognition === active) send(event.results[0][0].transcript.trim().slice(0,500), true);
    };
    active.onerror = () => {
      if (recognition === active) {
        stopListening();
        answer.textContent = "No pude escucharte. Prueba otra vez o escríbeme.";
      }
    };
    active.onend = () => {
      if (recognition === active) {
        recognition = null;
        stopListening();
        answer.textContent = "No he oído ninguna consulta. Puedes volver a intentarlo.";
      }
    };
    try {
      active.start();
      widget.classList.add("is-listening");
      mic.setAttribute("aria-pressed", "true");
      mic.setAttribute("aria-label", "Desactivar micrófono");
      answer.textContent = "Te escucho…";
    } catch {
      recognition = null;
      stopListening();
      answer.textContent = "No pude activar el micrófono. Puedes escribirme.";
    }
  });

  avatar.addEventListener("contextmenu", event => event.preventDefault());
  avatar.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    const bounds = avatar.getBoundingClientRect();
    const expanded = isOpen();
    press = {id:event.pointerId,x:event.clientX,y:event.clientY,left:bounds.left,top:bounds.top,dragging:false};
    avatar.setPointerCapture(event.pointerId);
    timer = setTimeout(() => {
      suppressClick = true;
      if (expanded) close(true);
      else press.dragging = true;
    }, expanded ? 2000 : 450);
  });
  avatar.addEventListener("pointermove", event => {
    if (press?.id !== event.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.dragging) {
      if (Math.hypot(dx,dy) > 8) {
        clearTimeout(timer);
        suppressClick = true;
      }
      return;
    }
    position = {x:press.left + dx,y:press.top + dy};
    place();
  });
  function release(event) {
    if (press?.id !== event.pointerId) return;
    clearTimeout(timer);
    if (press.dragging && position) {
      try { localStorage.setItem(positionKey,JSON.stringify(position)); } catch {}
    }
    press = null;
  }
  avatar.addEventListener("pointerup",release);
  avatar.addEventListener("pointercancel",release);
  avatar.addEventListener("lostpointercapture",release);
  avatar.addEventListener("click", event => {
    if (event.detail && suppressClick) return;
    if (isOpen()) close(true);
    else open();
  });
  document.addEventListener("keydown",event => {
    if (event.key === "Escape" && !event.defaultPrevented && isOpen()) close(true);
  });

  try {
    const saved = JSON.parse(localStorage.getItem(positionKey));
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) position = saved;
  } catch {}
  place();
  window.addEventListener("resize",place);
  return close;
}
