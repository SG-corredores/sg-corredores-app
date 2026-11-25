import { installAguacatin } from "./portal-aguacatin.js?v=cierre";
import { installCarousel } from "./portal-carousel.js";
import { openInvitation, directInviteToken, redeemDirectInvite, publicConfig, esc, madridDate, validNumber, isOrderRequest, orderUnits, orderUnitLabel, invoke, attachInbox, detachPush, version } from "./common.js?v=sacos";

const element = (id) => document.getElementById(id);
const status = (message) => { element("status").textContent = message; };
const orderStatus = (message) => { element("order-status").textContent = message; };
const sections = [...document.querySelectorAll("[data-portal-section]")];
function showSection(moveFocus = false) {
  const section = sections.find(item => "#"+item.id === location.hash);
  for (const item of sections) item.hidden = item !== section;
  element("portal-home").hidden = Boolean(section);
  element("portal-back").hidden = !section;
  if (!moveFocus || element("portal").hidden) return;
  const heading = section ? section.querySelector("h2") : element("company-name");
  heading.tabIndex = -1;
  heading.focus({preventScroll:true});
  window.scrollTo(0,0);
}
window.addEventListener("hashchange",() => showSection(true));
showSection();
function goToSection(id) {
  const hash = "#" + id;
  if (location.hash === hash) showSection(true);
  else { location.hash = hash; showSection(); }
}
const refreshCarousel = installCarousel(element("gallery-list"),element("gallery-track"),element("gallery-items"),element("gallery-motion"));
const params = new URLSearchParams(location.search);
const previewMode = params.has("vista") || params.has("empresa");
const previewMembership = previewMode ? {client_id:params.get("vista"),workspace_id:params.get("empresa")} : null;
const directToken = previewMode ? null : directInviteToken();
const invitation = previewMode || directToken ? null : openInvitation("portal");
let config = publicConfig;
if (previewMode) {
  try { config = { ...publicConfig, ...JSON.parse(localStorage.getItem("sg_config_v7")) }; } catch {}
  element("login").hidden = true;
  element("admin-preview").hidden = false;
}
const api = window.supabase?.createClient(config.url, config.key, {
  auth: { ...(previewMode ? {} : {storageKey:"sg10-customer-session"}), persistSession:true,
    detectSessionInUrl:!previewMode, autoRefreshToken:true },
});
if (invitation?.token) status("Invitación de cliente. Introduce el correo al que va dirigida.");
let user, membership, memberships = [], inbox, request, gallery = [], galleryVersion = 0, refreshVersion = 0;
let gallerySignature = "";
let lineCounter = 0;
let assistantContext = {history:[], busy:false};
const selected = () => membership ? { workspace: membership.workspace_id, company: membership.client_id } : null;
const priorDate = (days) => {
  const date = new Date(madridDate() + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0,10);
};

function addLine(draft = {}) {
  const fieldset = document.createElement("fieldset");
  fieldset.innerHTML = '<legend>Artículo ' + ++lineCounter + '</legend><div class="line-grid">'
    + '<label>Producto <input name="product" required maxlength="120" value="' + esc(draft.product) + '"></label>'
    + '<label>Variedad (opcional) <input name="variety" maxlength="120" value="' + esc(draft.variety) + '"></label>'
    + '<label>Cantidad <input name="quantity" inputmode="decimal" required value="' + esc(draft.quantity) + '"></label>'
    + '<label>Unidad <select name="unit" required><option value="">Seleccionar</option><option value="cajas">Cajas</option><option value="pales">Palés</option><option value="sacos">Sacos</option></select></label>'
    + '<label class="line-note">Observaciones <textarea name="notes" rows="2" maxlength="750">' + esc(draft.notes) + '</textarea></label></div>'
    + '<button type="button">Quitar artículo</button>';
  fieldset.querySelector("select").value = draft.unit ?? "";
  fieldset.querySelector("button").onclick = () => { fieldset.remove(); request = null; };
  element("lines").append(fieldset);
  request = null;
}

if (!previewMode) {
  element("order-date").min = madridDate();
  element("order-date").max = priorDate(30);
  element("order-date").value = madridDate();
  element("add-line").onclick = () => addLine();
  element("order-form").oninput = () => { request = null; };
  element("order-date").oninput = () => { request = null; };
  addLine();
}
element("from-date").value = priorDate(-14);
element("to-date").value = madridDate();
element("version").textContent = version;

async function refresh() {
  if (!membership) return;
  const number = ++refreshVersion;
  const from_date = element("from-date").value;
  const to_date = element("to-date").value;
  const { workspace:space, company } = selected();
  const period = { space, company, from_date, to_date };
  const { data, error } = await api.rpc(previewMembership ? "sg10_admin_portal_snapshot" : "sg10_portal_snapshot",period);
  if (number !== refreshVersion) return;
  if (error || !data) throw error ?? Error("Esta empresa no está disponible.");
  element("company-name").textContent = data.company;
  element("history-list").innerHTML = '<h3>Pedidos</h3>'
    + (data.orders.map(row => record(row, row.quantity, orderUnitLabel(row.unit,row.quantity))).join("") || "<p>Sin pedidos en este periodo.</p>")
    + '<h3>Compras y cargas</h3>'
    + (data.purchases.map(row => record(row,row.quantity ?? row.boxes,orderUnitLabel(row.unit,row.quantity ?? row.boxes))).join("") || "<p>Sin compras en este periodo.</p>");
  element("invoice-list").innerHTML = data.invoices.map(row =>
    '<div class="row"><b>' + esc(row.number) + '</b> · ' + esc(row.supplier) + ' <small>' + esc(row.date)
    + ' · ' + esc(row.total == null ? "Importe pendiente" : row.total + " €") + '</small></div>').join("") || "<p>Sin facturas autorizadas en este periodo.</p>";
  void loadCommissions(period,number);
}
const euro = new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR"});
const kg = new Intl.NumberFormat("es-ES",{maximumFractionDigits:3});
const shortDate = (date) => date.split("-").reverse().join("/");
async function loadCommissions(period,revision) {
  const section = element("commission-list");
  try {
    const {data,error} = await api.rpc("sg10_portal_commissions",period);
    if (revision !== refreshVersion) return;
    if (error) throw error;
    section.innerHTML = data.map(row => {
      const dates = shortDate(row.date_from) + (row.date_to === row.date_from ? "" : " – " + shortDate(row.date_to));
      return '<div class="portal-commission"><div><b>' + esc(dates) + '</b><small>'
        + (row.weight == null ? 'Informe enviado' : esc(kg.format(row.weight)) + ' kg cargados')
        + '</small></div>' + (row.total == null ? '' : '<strong>' + esc(euro.format(row.total)) + '</strong>') + '</div>';
    }).join("") || "<p>No hay comisiones publicadas en el periodo seleccionado en Historial.</p>";
  } catch {
    if (revision === refreshVersion) section.textContent = "No se pudieron cargar las comisiones.";
  }
}
function record(row, quantity, unit) {
  return '<div class="row ' + (row.status === "Pendiente" ? "sg10-pending" : /Comprado|Cargado|Preparado/.test(row.status) ? "sg10-done" : "")
    + '" data-record="' + esc(row.id) + '"><b>' + esc(row.product) + '</b> ' + esc(row.variety)
    + '<small>' + esc(row.date) + ' · ' + esc(quantity) + ' ' + esc(unit) + ' · ' + esc(row.status) + '</small></div>';
}
element("filter").onsubmit = (event) => { event.preventDefault(); refresh().catch(error => status(error.message)); };

async function loadGallery() {
  if (!membership) return;
  const revision = ++galleryVersion;
  const { workspace, company } = selected();
  const { data,error } = await api.from("sg10_gallery").select("id,client_id,product,description,image_path,price,unit")
    .eq("workspace_id",workspace).or("client_id.is.null,client_id.eq." + '"' + company.replace(/["\\]/g,"\\$&") + '"')
    .order("updated_at",{ascending:false}).limit(40);
  if (revision !== galleryVersion) return;
  if (error) throw error;
  const paths = [...new Set(data.map(row => row.image_path))];
  const signed = paths.length ? await api.storage.from("sg10-productos").createSignedUrls(paths,180) : {data:[]};
  if (revision !== galleryVersion) return;
  if (signed.error) throw signed.error;
  const urls = new Map(signed.data.map(item => [item.path,item.signedUrl]));
  gallery = data.flatMap(row => urls.get(row.image_path) ? [{...row,url:urls.get(row.image_path)}] : []);
  element("gallery-message").textContent = gallery.length ? "" : data.length ? "No se pudieron cargar las fotografías." : "Aún no hay fotografías publicadas.";
  element("gallery-list").hidden = !gallery.length;
  const signature = JSON.stringify(gallery.map(({url,...row}) => row));
  if (signature === gallerySignature) {
    const galleryUrls = new Map(gallery.map(row => [row.id,row.url]));
    for (const item of element("gallery-track").querySelectorAll("[data-photo] img")) {
      const url = galleryUrls.get(item.closest("[data-photo]").dataset.photo);
      if (url) item.src = url;
    }
    return;
  }
  gallerySignature = signature;
  element("gallery-items").innerHTML = gallery.map(row => {
    const name = row.product?.trim();
    return '<article><button type="button" data-photo="' + esc(row.id) + '" aria-label="' + esc(name || "Ver fotografía")
      + '"><img alt="" decoding="async" src="' + esc(row.url) + '">'
      + (name ? '<strong>' + esc(name) + '</strong>' : '')
      + (row.price == null ? '' : '<small>' + esc(euro.format(row.price) + "/" + row.unit) + '</small>') + '</button></article>';
  }).join("");
  refreshCarousel();
}
element("gallery-list").onclick = ({target}) => {
  const row = gallery.find(row => row.id === target.closest("button")?.dataset.photo);
  if (!row) return;
  const name = row.product?.trim();
  const dialog = element("photo");
  dialog.setAttribute("aria-label",name || "Fotografía");
  element("photo-content").innerHTML = (row.url ? '<img src="' + esc(row.url) + '" alt="' + esc(name || "Fotografía") + '">' : '')
    + (name ? '<h2>' + esc(name) + '</h2>' : '')
    + (row.description ? '<p>' + esc(row.description) + '</p>' : '')
    + (row.price == null ? '' : '<p>' + esc(row.price + " €/" + row.unit) + '</p>')
    + (!previewMode && name ? '<button type="button">Pedir este producto</button>' : '');
  const orderButton = element("photo-content").querySelector("button");
  if (orderButton) orderButton.onclick = () => {
    const blank = [...element("lines").querySelectorAll("fieldset")].find(row => !row.querySelector('[name="product"]').value);
    if (blank) blank.querySelector('[name="product"]').value = row.product;
    else addLine({product:row.product});
    request = null;
    element("photo").close();
    goToSection("pedidos");
  };
  element("photo").showModal();
};
let preparingOrder = false;
async function prepareOrder(text) {
  const scope = selected();
  const context = assistantContext;
  if (!scope || !text) throw Error("Escribe o dicta el pedido.");
  if (preparingOrder) throw Error("Espera a que se prepare el pedido en curso.");
  const button = element("interpret");
  preparingOrder = true;
  button.disabled = true;
  orderStatus("Interpretando el pedido…");
  try {
    const result = await invoke(api,"sg10-aguacatin",{...scope,mode:"pedido",text});
    if (context !== assistantContext) return;
    if (!Array.isArray(result.articulos) || !result.articulos.length) throw Error(result.respuesta || "No he identificado artículos.");
    const rows = [...element("lines").querySelectorAll("fieldset")];
    const unused = rows.filter(row => [...row.querySelectorAll("input,textarea,select")].every(input => !input.value));
    if (rows.length - unused.length + result.articulos.length > 30) throw Error("Puedes confirmar hasta 30 artículos por pedido. Guarda el borrador antes de añadir más.");
    for (const row of unused) row.remove();
    const date = element("order-date");
    if (typeof result.fecha === "string" && result.fecha >= date.min && result.fecha <= date.max && /^20\d{2}-\d{2}-\d{2}$/.test(result.fecha)) {
      date.value = result.fecha;
      request = null;
    }
    result.articulos.forEach(addLine);
    const message = result.articulos.length === 1 ? "He preparado un artículo. Revísalo y confirma para guardarlo."
      : "He preparado " + result.articulos.length + " artículos. Revísalos y confirma para guardarlos.";
    orderStatus(message);
    return message;
  } catch (error) {
    if (context === assistantContext) throw error;
  } finally {
    if (context === assistantContext) {
      preparingOrder = false;
      button.disabled = false;
    }
  }
}
if (!previewMode) element("interpret").onclick = () => {
  prepareOrder(element("source").value.trim()).catch(error => orderStatus(error.message));
};
if (!previewMode) element("dictate").onclick = () => {
  const Recognizer = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognizer) return orderStatus("Usa el micrófono del teclado para dictar en este dispositivo.");
  const recognizer = new Recognizer();
  recognizer.lang = "es-ES";
  recognizer.onresult = ({results}) => { element("source").value += (element("source").value ? "\n" : "") + results[0][0].transcript; };
  recognizer.onerror = () => orderStatus("No se pudo iniciar el dictado. Revisa el permiso del micrófono.");
  try { recognizer.start(); } catch (error) { orderStatus(error.message); }
};
if (!previewMode) element("order-form").onsubmit = async (event) => {
  event.preventDefault();
  const scope = selected();
  const date = element("order-date");
  if (!scope || !date.reportValidity()) return;
  const lines = [...element("lines").querySelectorAll("fieldset")].map(row => {
    const value = (name) => row.querySelector('[name="' + name + '"]').value.trim();
    return { product:value("product"), variety:value("variety"), quantity:validNumber(value("quantity")), unit:value("unit"), notes:value("notes") };
  });
  if (!lines.length || lines.length > 30 || lines.some(row => !row.product || !Number.isFinite(row.quantity) || row.quantity <= 0 || !Object.hasOwn(orderUnits,row.unit))) {
    return orderStatus("Introduce de 1 a 30 artículos con nombre, cantidad positiva y unidad.");
  }
  const duplicate = new Set(lines.map(row => JSON.stringify([row.product.toLowerCase(),row.variety.toLowerCase(),row.unit,row.quantity])));
  if (duplicate.size !== lines.length) return orderStatus("Hay líneas repetidas. Revísalas y confirma una vez corregidas.");
  const submit = event.submitter;
  submit.disabled = true;
  const key = request ??= crypto.randomUUID();
  try {
    const { error } = await api.rpc("sg10_portal_order",{space:scope.workspace,company:scope.company,request:key,day:date.value,lines});
    if (error) throw error;
    if (selected()?.company !== scope.company || selected()?.workspace !== scope.workspace) return;
    orderStatus("Pedido confirmado en SG Corredores.");
    element("source").value = "";
    element("lines").replaceChildren();
    lineCounter = 0;
    addLine();
    refresh().catch(error => status(error.message));
  } catch (error) { orderStatus(error.message); }
  finally { submit.disabled = false; }
};
async function askAguacatin(text) {
  const scope = selected();
  const context = assistantContext;
  if (previewMode || !scope) return;
  if (context.busy) throw Error("Espera a que termine la consulta en curso.");
  context.busy = true;
  try {
    const result = await invoke(api,"sg10-aguacatin",{...scope,mode:"consulta",text,history:context.history});
    if (context !== assistantContext) return;
    context.history = [...context.history,{role:"user",content:text},{role:"assistant",content:result.respuesta}].slice(-6);
    return result.respuesta;
  } finally { context.busy = false; }
}
const resetFloatingAguacatin = installAguacatin(previewMode,async text => {
  if (!isOrderRequest(text)) return askAguacatin(text);
  const message = await prepareOrder(text);
  if (message) goToSection("pedidos");
  return message;
});
if (!previewMode) element("assistant-form").onsubmit = async (event) => {
  event.preventDefault();
  const context = assistantContext;
  const text = element("question").value.trim();
  if (!text) return;
  const button = event.currentTarget.querySelector("button");
  const answer = element("assistant-answer");
  button.disabled = true;
  answer.textContent = "Consultando…";
  try {
    const response = await askAguacatin(text);
    if (context === assistantContext) answer.textContent = response;
  } catch (error) {
    if (context === assistantContext) answer.textContent = error.message;
  } finally {
    if (context === assistantContext) button.disabled = false;
  }
};
if (previewMode) {
  element("pedidos").innerHTML = '<h2>Pedidos</h2><p>Desde aquí, el cliente puede escribir o dictar un pedido.</p><a href="#history">Consultar pedidos existentes</a>';
  element("assistant-section").innerHTML = '<h2>Consultar producto</h2><p>Desde aquí, el cliente puede preguntar a Aguacatín por sus pedidos y compras.</p>';
}
async function openCompany(index) {
  inbox?.close();
  membership = memberships[index];
  assistantContext = {history:[], busy:false};
  resetFloatingAguacatin();
  preparingOrder = false;
  element("interpret").disabled = false;
  element("question").value = "";
  element("assistant-form").querySelector("button").disabled = false;
  request = null;
  element("company-name").textContent = "Mi empresa";
  element("history-list").replaceChildren();
  element("invoice-list").replaceChildren();
  element("commission-list").replaceChildren();
  gallerySignature = "";
  element("gallery-items").replaceChildren();
  refreshCarousel();
  element("assistant-answer").replaceChildren();
  inbox = attachInbox({
    api,space:membership.workspace_id,user:user.id,button:element("open-inbox"),panel:element("inbox"),portal:true,
    onOpen:async row => {
      if (row.target === "galeria") return goToSection("inicio");
      goToSection(row.target === "comisiones" ? "comisiones" : row.target === "facturas" ? "facturas" : "history");
      const recordElement = [...document.querySelectorAll("[data-record]")].find(item => item.dataset.record === row.record_id);
      if (recordElement && !element("history").hidden) requestAnimationFrame(() => {
        recordElement.classList.add("sg10-highlight");
        recordElement.scrollIntoView({block:"center"});
      });
    },
    onChange:() => Promise.all([refresh(),loadGallery()]).catch(error => status(error.message)),
  });
  await Promise.all([refresh(),loadGallery()]);
}
async function connect() {
  if (!api) throw Error("No se pudo cargar la conexión. Comprueba Internet.");
  const result = await api.auth.getSession();
  if (result.error) throw result.error;
  user = result.data.session?.user;
  if (previewMode) {
    if (!user || user.is_anonymous) throw Error("Vuelve a SG Corredores y entra con tu correo de administrador.");
    const { client_id, workspace_id } = previewMembership;
    if (!client_id || !/^[0-9a-f-]{36}$/i.test(workspace_id ?? "")) throw Error("Vuelve a SG Corredores y elige una empresa.");
    membership = previewMembership;
    try {
      await refresh();
    } catch (error) {
      membership = null;
      if (error.code === "42501") throw Error("Esta vista está reservada a la cuenta de administrador.");
      throw error;
    }
    element("portal").hidden = false;
    document.querySelector(".portal-entry").hidden = true;
    try { await loadGallery(); } catch {
      element("gallery-message").textContent = "No se pudieron cargar las fotografías.";
    }
    return;
  }
  if (!user) return;
  if(invitation?.token){
    const { error }=await api.rpc("sg10_redeem_whatsapp_invite",{p_token:invitation.token,p_customer:true});
    if(error){
      await api.auth.signOut({scope:"local"});
      throw error;
    }
    localStorage.removeItem(invitation.key);
    status("");
  }
  const links = await api.from("sg10_company_users").select("workspace_id,client_id").eq("user_id",user.id);
  if (links.error) throw links.error;
  memberships = links.data;
  if (!memberships.length) {
    await api.auth.signOut({scope:"local"});
    throw Error("Esta cuenta aún no está vinculada a una empresa.");
  }
  element("login").hidden = true;
  element("session-tools").hidden = false;
  element("portal").hidden = false;
  document.querySelector(".portal-entry").hidden = true;
  element("spaces-label").hidden = memberships.length < 2;
  element("spaces").replaceChildren(...memberships.map((row,index) => new Option("Empresa " + (index + 1),index)));
  for (let index = 0; index < memberships.length; index++) {
    const row = memberships[index];
    api.rpc("sg10_portal_snapshot",{space:row.workspace_id,company:row.client_id,from_date:madridDate(),to_date:madridDate()}).then(result => {
      if (result.data?.company) element("spaces").options[index].textContent = result.data.company;
    });
  }
  await openCompany(0);
}
element("spaces").onchange = ({target}) => openCompany(Number(target.value)).catch(error => status(error.message));
element("login-form").onsubmit = async (event) => {
  event.preventDefault();
  if (previewMode) return;
  if (!api) return status("No se pudo cargar la conexión.");
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const { error } = await api.auth.signInWithOtp({email:element("email").value.trim(),options:{
      shouldCreateUser:Boolean(invitation?.token),emailRedirectTo:new URL(invitation?.token?"./Index.html":"./portal.html",location.href).href,
    }});
    if (error) throw error;
    status("Abre el enlace recibido en el correo de tu empresa.");
  } catch (error) { status(error.message); }
  finally { submit.disabled = false; }
};
element("sign-out").onclick = async () => {
  if (previewMode) return;
  try {
    await detachPush(api,user.id);
    const result = await api.auth.signOut({scope:"local"});
    if (result.error) throw result.error;
    location.replace("./portal.html");
  } catch (error) { status(error.message); }
};
setInterval(() => {
  if (!document.hidden && membership) Promise.all([refresh(),loadGallery()]).catch(error => status(error.message));
},45_000);
navigator.serviceWorker?.register("./sw.js").catch(() => {});
if (directToken) {
  const button = element("activate-client");
  element("login").hidden = true;
  element("client-invitation").hidden = false;
  button.onclick = async () => {
    if (button.disabled) return;
    if (!api) return status("No se pudo cargar la conexión.");
    button.disabled = true;
    status("Activando acceso…");
    try {
      await redeemDirectInvite(api,directToken,true);
      localStorage.removeItem("sg10-portal-invite");
      await connect();
      window.history.replaceState(null,"",location.pathname + location.search);
      status("");
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = false;
    }
  };
} else {
  connect().catch(error => status(error.message));
}
