import { openInvitation, publicConfig, esc, madridDate, validNumber, invoke, attachInbox, detachPush, version } from "./common.js";

const element = (id) => document.getElementById(id);
const status = (message) => { element("status").textContent = message; };
const orderStatus = (message) => { element("order-status").textContent = message; };
const params = new URLSearchParams(location.search);
const previewMembership = params.has("vista") && params.has("empresa")
  ? {client_id:params.get("vista"),workspace_id:params.get("empresa")} : null;
const invitation = previewMembership ? null : openInvitation("portal");
const api = window.supabase?.createClient(publicConfig.url, publicConfig.key, {
  auth: { ...(previewMembership ? {} : {storageKey:"sg10-customer-session"}), persistSession:true,
    detectSessionInUrl:!previewMembership, autoRefreshToken:true },
});
if (invitation?.token) status("Invitación de cliente. Introduce el correo al que va dirigida.");
let user, membership, memberships = [], inbox, request, gallery = [], galleryVersion = 0, refreshVersion = 0;
let lineCounter = 0;
let history = [];
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
    + '<label>Variedad <input name="variety" maxlength="120" value="' + esc(draft.variety) + '"></label>'
    + '<label>Cantidad <input name="quantity" inputmode="decimal" required value="' + esc(draft.quantity) + '"></label>'
    + '<label>Unidad <select name="unit" required><option value="">Seleccionar</option><option value="cajas">Cajas</option><option value="pales">Palés</option></select></label>'
    + '<label class="line-note">Observaciones <textarea name="notes" rows="2" maxlength="750">' + esc(draft.notes) + '</textarea></label></div>'
    + '<button type="button">Quitar artículo</button>';
  fieldset.querySelector("select").value = draft.unit ?? "";
  fieldset.querySelector("button").onclick = () => { fieldset.remove(); request = null; };
  element("lines").append(fieldset);
  request = null;
}

element("order-date").min = madridDate();
element("order-date").max = priorDate(30);
element("order-date").value = madridDate();
element("from-date").value = priorDate(-14);
element("to-date").value = madridDate();
element("version").textContent = version;
element("add-line").onclick = () => addLine();
element("order-form").oninput = () => { request = null; };
element("order-date").oninput = () => { request = null; };
addLine();

async function refresh() {
  if (!membership) return;
  const number = ++refreshVersion;
  const from_date = element("from-date").value;
  const to_date = element("to-date").value;
  const { workspace:space, company } = selected();
  const { data, error } = await api.rpc(previewMembership ? "sg10_admin_portal_snapshot" : "sg10_portal_snapshot", { space, company, from_date, to_date });
  if (number !== refreshVersion) return;
  if (error || !data) throw error ?? Error("Esta empresa no está disponible.");
  element("company-name").textContent = data.company;
  element("history-list").innerHTML = '<h3>Pedidos</h3>'
    + (data.orders.map(row => record(row, row.quantity, row.unit === "pales" ? "palés" : "cajas")).join("") || "<p>Sin pedidos en este periodo.</p>")
    + '<h3>Compras y cargas</h3>'
    + (data.purchases.map(row => record(row,row.boxes,"cajas")).join("") || "<p>Sin compras en este periodo.</p>");
  element("invoice-list").innerHTML = data.invoices.map(row =>
    '<div class="row"><b>' + esc(row.number) + '</b> · ' + esc(row.supplier) + ' <small>' + esc(row.date)
    + ' · ' + esc(row.total == null ? "Importe pendiente" : row.total + " €") + '</small></div>').join("") || "<p>Sin facturas autorizadas en este periodo.</p>";
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
  const loaded = await Promise.all(data.map(async row => {
    const result = await api.storage.from("sg10-productos").createSignedUrl(row.image_path,120);
    return { ...row, url: result.data?.signedUrl };
  }));
  if (revision !== galleryVersion) return;
  gallery = loaded;
  element("gallery-list").innerHTML = gallery.map(row => '<article><button type="button" data-photo="' + esc(row.id)
      + '">' + (row.url ? '<img alt="" loading="lazy" src="' + esc(row.url) + '">' : '') + '<strong>' + esc(row.product)
      + '</strong>' + esc(row.price == null ? "" : row.price + " €/" + row.unit) + '</button></article>').join("") || "<p>Sin fotografías publicadas.</p>";
}
element("gallery-list").onclick = ({target}) => {
  const row = gallery.find(row => row.id === target.closest("button")?.dataset.photo);
  if (!row) return;
  element("photo-content").innerHTML = (row.url ? '<img src="' + esc(row.url) + '" alt="' + esc(row.product) + '">' : '')
    + '<h2>' + esc(row.product) + '</h2><p>' + esc(row.description) + '</p><p>' + esc(row.price == null ? "" : row.price + " €/" + row.unit)
    + (previewMembership ? "</p>" : '</p><button type="button">Pedir este producto</button>');
  const orderButton = element("photo-content").querySelector("button");
  if (orderButton) orderButton.onclick = () => {
    const blank = [...element("lines").querySelectorAll("fieldset")].find(row => !row.querySelector('[name="product"]').value);
    if (blank) blank.querySelector('[name="product"]').value = row.product;
    else addLine({product:row.product});
    request = null;
    element("photo").close();
    element("pedidos").scrollIntoView({behavior:"smooth"});
  };
  element("photo").showModal();
};
const galleryRow = element("gallery-list");
setInterval(() => {
  if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches || galleryRow.matches(":hover,:focus-within")) return;
  if (galleryRow.scrollWidth <= galleryRow.clientWidth) return;
  const next = galleryRow.scrollLeft + 180;
  galleryRow.scrollTo({left:next >= galleryRow.scrollWidth ? 0 : next,behavior:"smooth"});
  if (galleryRow.scrollLeft + galleryRow.clientWidth >= galleryRow.scrollWidth - 5) galleryRow.scrollTo({left:0,behavior:"smooth"});
},3800);

element("interpret").onclick = async ({currentTarget:button}) => {
  const scope = selected();
  const text = element("source").value.trim();
  if (!scope || !text) return orderStatus("Escribe o dicta el pedido.");
  button.disabled = true;
  orderStatus("Interpretando el pedido…");
  try {
    const result = await invoke(api,"sg10-aguacatin",{...scope,mode:"pedido",text});
    if (selected()?.company !== scope.company || selected()?.workspace !== scope.workspace) return;
    if (!Array.isArray(result.articulos) || !result.articulos.length) throw Error(result.respuesta || "No he identificado artículos.");
    const rows = [...element("lines").querySelectorAll("fieldset")];
    for (const row of rows) {
      if ([...row.querySelectorAll("input,textarea,select")].every(input => !input.value)) row.remove();
    }
    result.articulos.slice(0,30).forEach(addLine);
    orderStatus("Revisa los artículos y confirma para guardarlos.");
  } catch (error) { orderStatus(error.message); }
  finally { button.disabled = false; }
};
element("dictate").onclick = () => {
  const Recognizer = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognizer) return orderStatus("Usa el micrófono del teclado para dictar en este dispositivo.");
  const recognizer = new Recognizer();
  recognizer.lang = "es-ES";
  recognizer.onresult = ({results}) => { element("source").value += (element("source").value ? "\n" : "") + results[0][0].transcript; };
  recognizer.onerror = () => orderStatus("No se pudo iniciar el dictado. Revisa el permiso del micrófono.");
  try { recognizer.start(); } catch (error) { orderStatus(error.message); }
};
element("order-form").onsubmit = async (event) => {
  event.preventDefault();
  const scope = selected();
  const date = element("order-date");
  if (!scope || !date.reportValidity()) return;
  const lines = [...element("lines").querySelectorAll("fieldset")].map(row => {
    const value = (name) => row.querySelector('[name="' + name + '"]').value.trim();
    return { product:value("product"), variety:value("variety"), quantity:validNumber(value("quantity")), unit:value("unit"), notes:value("notes") };
  });
  if (!lines.length || lines.length > 30 || lines.some(row => !row.product || !Number.isFinite(row.quantity) || row.quantity <= 0 || !row.unit)) {
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
element("assistant-form").onsubmit = async (event) => {
  event.preventDefault();
  const scope = selected();
  if (!scope) return;
  const field = element("question");
  const answer = element("assistant-answer");
  const text = field.value.trim();
  const button = event.submitter;
  if (!text) return;
  button.disabled = true;
  answer.textContent = "Consultando…";
  try {
    const result = await invoke(api,"sg10-aguacatin",{...scope,mode:"consulta",text,history});
    if (selected()?.company !== scope.company || selected()?.workspace !== scope.workspace) return;
    answer.textContent = result.respuesta;
    history = [...history,{role:"user",content:text},{role:"assistant",content:result.respuesta}].slice(-6);
  } catch (error) { answer.textContent = error.message; }
  finally { button.disabled = false; }
};
async function openCompany(index) {
  inbox?.close();
  membership = memberships[index];
  history = [];
  request = null;
  element("company-name").textContent = "Mi empresa";
  element("history-list").replaceChildren();
  element("invoice-list").replaceChildren();
  element("gallery-list").replaceChildren();
  element("assistant-answer").replaceChildren();
  inbox = attachInbox({
    api,space:membership.workspace_id,user:user.id,button:element("open-inbox"),panel:element("inbox"),portal:true,
    onOpen:async row => {
      if (row.target === "galeria") return element("galeria").scrollIntoView();
      element("history").scrollIntoView();
      const recordElement = [...document.querySelectorAll("[data-record]")].find(item => item.dataset.record === row.record_id);
      if (recordElement) {
        recordElement.classList.add("sg10-highlight");
        recordElement.scrollIntoView({block:"center"});
      }
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
  if(previewMembership){
    element("login").hidden=true;
    element("admin-preview").hidden=false;
    if(!user)throw Error("Abre la vista desde tu sesión de administrador.");
    membership=previewMembership;
    try{
      await refresh();
      await loadGallery();
      element("pedidos").hidden=true;
      element("assistant-section").hidden=true;
      element("portal").hidden=false;
    }catch(error){
      membership=null;
      throw error;
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
connect().catch(error => status(error.message));
