import { createOrderVoice } from "./order-voice.js?v=10.0.0-rc.13";

export const version = "10.0.0-rc.13";
export const publicConfig = {
  url: "https://zyzcnosaavvcijsmcowq.supabase.co",
  key: "sb_publishable_Kg1dzS7_ajGn_CfRxyFyeA_ZYlXQot7",
};
const vapidKey = "BI2tLf6uDRRincuxMX_YAucWgSziV2i90ZsVzcHX7QLGQwAy_PauEn1lof_HIddrg0k0DIn0r3tUk5bxRY_Fswo";
export const names = {
  pedido_cliente: "Pedido de cliente", mensaje_cliente: "Mensaje de cliente", nuevo_pedido: "Nuevo pedido", nuevo_articulo: "Artículo añadido", articulo_comprado: "Artículo comprado",
  precio: "Cambio de precio", puesto: "Cambio de puesto", pedido_modificado: "Pedido modificado",
  pedido_eliminado: "Pedido eliminado", mercancia_cargada: "Mercancía cargada", factura_recibida: "Factura recibida",
  factura_discrepancia: "Diferencia en factura", factura_sin_pedido: "Factura sin pedido", incidencia: "Reclamación o incidencia", comision_revision: "Comisión para revisión",
  nueva_foto: "Nueva fotografía", actualizacion: "Nueva actualización",
};
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
export const madridDate = () => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
export const normalized = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
export const validNumber = (value) => /^\d+(?:[.,]\d{1,3})?$/.test(value.trim()) ? Number(value.trim().replace(",", ".")) : NaN;

export function matchCompany(text, companies) {
  const query = " " + normalized(text) + " ";
  const ranked = companies.map(({ id, name }) => {
    const full = normalized(name);
    const words = full.split(" ").filter(word => word.length >= 4 && !["fruta","frutas","verduras","fruteria"].includes(word));
    return { id, score: full && query.includes(" " + full + " ") ? 100 + full.length : words.filter(word => query.includes(" " + word + " ")).length };
  }).filter(({score}) => score > 0).sort((a, b) => b.score-a.score);
  return ranked[0]?.score !== ranked[1]?.score ? ranked[0]?.id : undefined;
}

export const orderUnits = {cajas:["caja","cajas"], pales:["palet","palets"], sacos:["saco","sacos"], kg:["kg","kg"]};
export function orderUnitLabel(unit, amount) {
  return (Object.hasOwn(orderUnits,unit) ? orderUnits[unit] : orderUnits.cajas)[Number(amount) === 1 ? 0 : 1];
}

export function isOrderRequest(text) {
  const query = normalized(text).replace(/^[¡¿\s]*/, "").replace(/^(?:oye )?aguacatin[,:\s]+/, "").replace(/^por favor[,:\s]+/, "");
  if (/^(?:quiero saber|quisiera saber|me puedes decir|dime|consulta|consultar|busca|mira|que|cuant[oa]s?|quien(?:es)?|hay|tiene[n]?|llevan?|se ha[n]?)\b/.test(query)) return false;
  if (/^(?:crea|prepara|anota|anotame|anotale|apunta|apuntame|apuntale|anade|agrega|registra|registrame|haz(?:me)?|pon(?:le|me)?|pide|nuevo pedido|interpreta|necesito|quiero|quisiera|querria|pedimos|pedir|te pido|pedirte|me pones|por favor)\b/.test(query)) return true;
  return /^(?:\d+(?:[.,]\d+)?|medio|media|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:cajas?|pales?|palets?|pallets?|sacos?|kg|kilos?)\b/.test(query);
}

export async function invoke(api, fn, body) {
  const { data, error } = await api.functions.invoke(fn, { body });
  if (error) {
    const response = await error.context?.json?.().catch(() => null);
    throw Error(response?.error ?? error.message);
  }
  if (data?.error) throw Error(data.error);
  return data;
}

export async function subscribePush(api, workspace, user) {
  if (!("PushManager" in window) || !("Notification" in window)) throw Error("Este navegador no ofrece avisos push. En iPhone abre la app desde el icono de inicio.");
  if (Notification.permission !== "granted" && await Notification.requestPermission() !== "granted") throw Error("Activa las notificaciones en los ajustes del dispositivo.");
  await navigator.serviceWorker.register("./sw.js");
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(vapidKey.replace(/-/g,"+").replace(/_/g,"/") + "="), b => b.charCodeAt(0));
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && String(new Uint8Array(subscription.options.applicationServerKey)) !== String(key)) {
    const deletion = await api.from("sg_push_subscriptions").delete().eq("endpoint",subscription.endpoint).eq("user_id",user);
    if (deletion.error) throw deletion.error;
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:key });
  const { endpoint, keys } = subscription.toJSON();
  const { error } = await api.from("sg_push_subscriptions").upsert({
    workspace_id:workspace, user_id:user, endpoint, p256dh:keys.p256dh, auth:keys.auth,
  }, { onConflict:"endpoint" });
  if (error) throw error;
}

export async function detachPush(api, user) {
  const registration = await navigator.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  const {error} = await api.from("sg_push_subscriptions").delete().eq("endpoint",subscription.endpoint).eq("user_id",user);
  if (error) throw error;
  await subscription.unsubscribe();
}

export function attachInbox({ api, space, user, button, panel, onOpen, onChange, onNew, portal }) {
  const voice = portal ? null : createOrderVoice(space,user);
  let eventRows = [];
  let readThrough = 0;
  let unreadCount = 0;
  let latestEvent;
  let muted = [];
  let active = true;
  let expanded = false;
  let pushReady = false;
  const pushPreference = "sg10-push:" + space + ":" + user;
  function currentPushPreference(value) {
    try {
      if (value) localStorage.setItem(pushPreference,value);
      return localStorage.getItem(pushPreference);
    } catch { return null; }
  }
  async function restorePush() {
    if (portal || !("Notification" in window) || Notification.permission !== "granted" || currentPushPreference() === "off") return;
    const registration = await navigator.serviceWorker?.getRegistration();
    const previous = await registration?.pushManager?.getSubscription();
    if (!previous && currentPushPreference() !== "on") return;
    if (!active) return;
    await subscribePush(api,space,user);
    if (!active) return;
    pushReady = true;
    currentPushPreference("on");
    draw();
  }
  function draw() {
    button.textContent = "🔔 Avisos" + (unreadCount ? " (" + unreadCount + ")" : "");
    if (!expanded) return;
    panel.innerHTML = '<div class="sg10-tools"><button data-mark>Marcar como leídos</button><button data-push>' + (pushReady ? "Avisos del dispositivo activos" : "Activar avisos en este dispositivo") + '</button><button data-unpush>Desactivar push</button><button data-close>Cerrar avisos</button></div>'
      + (voice ? '<label class="sg10-check"><input type="checkbox" data-order-voice' + (voice.enabled() ? ' checked' : '') + '> Avisos por voz</label><button type="button" data-test-voice>Probar sonido</button>' : '')
      + '<details><summary>Preferencias de avisos push</summary>' + Object.entries(names).map(([kind,label]) =>
        '<label class="sg10-check"><input type="checkbox" data-kind="' + kind + '"' + (muted.includes(kind) ? '' : ' checked') + '> ' + esc(label) + '</label>').join('') + '</details>'
      + '<p data-message role="status"></p><ul class="sg10-notices">'
      + eventRows.map(row => '<li><button data-id="' + row.id + '"><strong>' + esc(names[row.kind] ?? row.kind) + '</strong> '
        + esc([row.client_name,row.kind === "mensaje_cliente" ? String(row.article).slice(0,100) : row.article,row.actor_name].filter(Boolean).join(" · ")) + '<small>'
        + esc(new Date(row.created_at).toLocaleString("es-ES",{ timeZone:"Europe/Madrid" })) + '</small></button></li>').join('')
      + (eventRows.length ? '' : '<li>No hay avisos.</li>') + '</ul>';
  }
  const fromInbox = () => api.from("sg10_events");
  async function refresh() {
    const [events, preferences] = await Promise.all([
      fromInbox().select("id,kind,client_name,article,actor_name,target,record_id,client_id,created_at").eq("workspace_id",space).eq("visible_to_clients", Boolean(portal))
        .order("id",{ascending:false}).limit(100),
      api.from("sg10_notice_settings").select("muted,read_through").eq("workspace_id",space).eq("user_id",user).maybeSingle(),
    ]);
    if (!active) return;
    if (events.error || preferences.error) throw events.error ?? preferences.error;
    eventRows = events.data;
    const previous = latestEvent;
    latestEvent = Math.max(previous ?? 0, Number(eventRows[0]?.id) || 0);
    if (previous !== undefined && !document.hidden) {
      for (const event of [...eventRows].reverse()) if (Number(event.id) > previous) onNew?.(event);
    }
    voice?.update(eventRows);
    muted = preferences.data?.muted ?? [];
    readThrough = preferences.data?.read_through ?? 0;
    const unread = await fromInbox().select("id",{count:"exact",head:true}).eq("workspace_id",space).eq("visible_to_clients", Boolean(portal)).gt("id",readThrough);
    if (!active) return;
    if (unread.error) throw unread.error;
    unreadCount = unread.count ?? 0;
    draw();
  }
  function errorMessage(error) {
    const message = panel.querySelector("[data-message]");
    if (message) message.textContent = error.message;
  }
  function open(expand) {
    expanded = expand;
    panel.hidden = !expanded;
    button.setAttribute("aria-expanded",String(expanded));
    if (expanded) {
      draw();
      refresh().catch(errorMessage);
    }
  }
  async function update(values) {
    const { error } = await api.from("sg10_notice_settings").upsert({ workspace_id:space,user_id:user,...values });
    if (error) throw error;
    await refresh();
  }
  panel.onclick = async ({target}) => {
    const control = target.closest("button");
    if (!control) return;
    try {
      if (control.hasAttribute("data-close")) open(false);
      if (control.hasAttribute("data-test-voice") && !voice?.test()) errorMessage(Error("Activa los avisos por voz para probar el sonido."));
      if (control.hasAttribute("data-mark")) await update({read_through:Math.max(readThrough,eventRows[0]?.id ?? 0)});
      if (control.hasAttribute("data-push")) {
        await subscribePush(api,space,user);
        currentPushPreference("on");
        pushReady = true;
        draw();
        errorMessage(Error("Dispositivo registrado para recibir avisos."));
      }
      if (control.hasAttribute("data-unpush")) {
        await detachPush(api,user);
        currentPushPreference("off");
        pushReady = false;
        draw();
        errorMessage(Error("Avisos push desactivados en este dispositivo."));
      }
      if (control.dataset.id) {
        const row = eventRows.find(row => String(row.id) === control.dataset.id);
        if (row) { open(false); onOpen(row); }
      }
    } catch (error) { errorMessage(error); }
  };
  panel.onchange = ({target}) => {
    if (target.hasAttribute("data-order-voice")) {
      voice?.setEnabled(target.checked);
      return;
    }
    if (!target.dataset.kind) return;
    const next = new Set(muted);
    if (target.checked) next.delete(target.dataset.kind); else next.add(target.dataset.kind);
    update({ muted:[...next] }).catch(errorMessage);
  };
  button.onclick = () => open(!expanded);
  const channel = api.channel("sg10-events-" + crypto.randomUUID()).on("postgres_changes",{
    schema:"public",table:"sg10_events",event:"INSERT",filter:"workspace_id=eq."+space,
  }, () => { refresh().catch(errorMessage); onChange?.(); }).subscribe();
  const timer = setInterval(() => { if (!document.hidden) refresh().catch(errorMessage); }, 30_000);
  restorePush().catch(errorMessage);
  refresh().then(async () => {
    if (!active) return;
    const id = Number(new URL(location.href).searchParams.get("sg_event"));
    if (!id) return;
    let row = eventRows.find(event => event.id === id);
    if (!row) {
      const result = await fromInbox().select("id,kind,client_name,article,actor_name,target,record_id,client_id,created_at")
        .eq("workspace_id",space).eq("visible_to_clients", Boolean(portal)).eq("id",id).maybeSingle();
      row = result.data;
    }
    if (active && row) onOpen(row);
    else if (active && !portal) open(true);
  }).catch(errorMessage);
  return { refresh, close() {
    active = false; voice?.stop(); clearInterval(timer); api.removeChannel(channel); open(false);
    button.onclick = null; panel.onclick = null; panel.onchange = null;
  } };
}

export async function readRelease() {
  const response = await fetch("./version.json", {cache:"no-store"});
  if (!response.ok) throw Error("No se pudo consultar la versión publicada.");
  const release = await response.json();
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(release.version) || !Array.isArray(release.news)) throw Error("Versión publicada incorrecta.");
  return release;
}

export function formatPallets(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total < 0) return "—";
  if (total % 1 === 0.5) return (Math.floor(total) || "") + "½";
  return new Intl.NumberFormat("es-ES",{maximumFractionDigits:3}).format(total);
}

export function readPallets(value) {
  const text = value.trim();
  const half = /^(?:(\d+)\s+1\/2|(?:(\d+)\s*)?½|1\/2)$/.exec(text);
  if (half) return Number(half[1] || half[2] || 0) + 0.5;
  const number = validNumber(text);
  return number > 0 && Number.isInteger(number * 2) ? number : NaN;
}

export function openInvitation(surface) {
  const key = "sg10-" + surface + "-invite";
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("sg-invitacion");
  if (/^[a-f0-9]{64}$/.test(token ?? "")) {
    localStorage.setItem(key, token);
    window.history.replaceState(null, "", location.pathname + location.search);
  }
  return { key, token: localStorage.getItem(key) };
}

export function directInviteToken(fragment = new URLSearchParams(location.hash.slice(1))) {
  const token = fragment.get("sg-acceso");
  return /^[a-f0-9]{64}$/.test(token ?? "") ? token : null;
}

export async function redeemDirectInvite(api, token, customer) {
  const existing = await api.auth.getSession();
  if (existing.error) throw existing.error;
  let session = existing.data.session;
  if (session && !session.user.is_anonymous) {
    throw Error("Ya hay una cuenta con correo abierta aquí. Abre la invitación en otro navegador.");
  }
  if (!session) {
    const login = await api.auth.signInAnonymously();
    if (login.error) throw login.error;
    session = login.data.session;
    if (!session) throw Error("No se pudo activar el acceso. Inténtalo de nuevo.");
  }
  const {error} = await api.rpc("sg10_redeem_direct_whatsapp_invite", {p_token:token,p_customer:customer});
  if (error) throw error;
  return session.user;
}

export async function prepareWhatsAppInvite(api, workspace, email, company, target) {
  target.textContent = "Preparando invitación…";
  // Open during the tap, before waiting for the invitation token.
  let popup;
  try {
    popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.title = "SG Corredores";
      popup.document.body.textContent = "Preparando invitación para WhatsApp…";
    }
  } catch {
    popup?.close();
    popup = null;
  }

  let opened = false;
  try {
    const direct = email === null;
    const {data: token, error} = await (direct
      ? api.rpc("sg10_create_direct_whatsapp_invite", {p_workspace:workspace,p_client:company})
      : api.rpc("sg10_create_whatsapp_invite", {p_workspace:workspace,p_email:email,p_client:company}));
    if (error) throw error;
    if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw Error("No se pudo generar la invitación.");
    if (!target.isConnected) return;

    const invitation = new URL(company === null ? "./Index.html" : "./portal.html", location.href);
    invitation.hash = (direct ? "sg-acceso=" : "sg-invitacion=") + token;
    const instructions = direct
      ? "Abre el enlace en tu móvil y pulsa Activar acceso. El enlace caduca en 7 días y solo se puede usar una vez."
      : "Abre el enlace y confirma tu correo electrónico. La invitación es válida durante 7 días.";
    const text = "SG Corredores te invita a " + (company === null ? "la app de empleados" : "la Zona Clientes")
      + ". " + instructions + "\n" + invitation.href;

    const share = document.createElement("a");
    share.href = "https://wa.me/?text=" + encodeURIComponent(text);
    share.target = "_blank";
    share.rel = "noopener noreferrer";
    share.textContent = "Abrir WhatsApp";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "Copiar invitación";
    const status = document.createElement("span");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = " Invitación copiada.";
      } catch {
        status.textContent = " Puedes compartirla con «Abrir WhatsApp».";
      }
    };
    target.replaceChildren(share, " · ", copy, status);

    if (popup && !popup.closed) {
      try {
        popup.location.replace(share.href);
        opened = true;
      } catch {
        // The visible link also works when this browser blocks the automatic handoff.
      }
    }
  } finally {
    if (!opened && popup && !popup.closed) popup.close();
  }
}
