import { prepareWhatsAppInvite, attachInbox, detachPush, esc as html, formatPallets, invoke, isOrderRequest, matchCompany, orderUnitLabel, normalized, readPallets, readRelease, validNumber, version } from "./common.js?v=aviso-voz";
import { installWalkie } from "./walkie.js";
import { installOperations } from "./operations.js?v=whatsapp-directo";

window.sg10PalletText = formatPallets;
window.sg10ReadPallets = readPallets;
window.sgDemoPedido ??= () => false;
const header = document.querySelector("#app header");
const notices = document.createElement("button");
notices.type = "button";
notices.className = "secondary sg10-bell";
notices.textContent = "🔔 Avisos";
notices.setAttribute("aria-expanded","false");
const noticePanel = document.createElement("section");
noticePanel.className = "sg10-inbox";
noticePanel.hidden = true;
noticePanel.setAttribute("aria-label","Avisos");
header.append(notices,noticePanel);

const primaryRoutes = [
  ["Inicio","inicio"], ["Pedidos","hoja"], ["Compras","compras"], ["Cargas","cargas"], ["Más","more"],
];
const nav = $("nav");
nav.replaceChildren(...primaryRoutes.map(([label,route]) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.route = route;
  button.textContent = label;
  button.onclick = () => route === "more" ? openMore() : go(route);
  return button;
}));
function openMore() {
  const dialog = operations.dialog("Más");
  const menu = document.createElement("div");
  menu.className = "sg10-more-menu";
  const sections = [["Clientes","clientes"],["Comisiones","comisiones"],["Facturas","facturas"],["Mi compra","micompra"],
    ["Buscar producto","consultar"],["Fotos de productos","galeria"],["Walkie-talkie","walkie"],["Zona Clientes","portal"],["Ajustes","ajustes"]];
  for (const [label,target] of sections) {
    if (target === "portal" && (role !== "owner" || user?.is_anonymous)) continue;
    const button=document.createElement("button");
    button.type="button";
    button.className="secondary";
    button.textContent=label;
    button.onclick=()=>{
      dialog.close();
      if(target==="portal") operations.previewClients();
      else if(target==="walkie") walkie.open();
      else go(target);
    };
    menu.append(button);
  }
  dialog.querySelector("[data-content]").append(menu);
}
function updateNav() {
  const current = ["hoja","pedidos"].includes(page) ? "hoja"
    : ["cargas","pales","recepcion"].includes(page) ? "cargas"
    : ["inicio","compras"].includes(page) ? page : "more";
  for (const button of nav.querySelectorAll("button")) {
    button.classList.remove("active");
    if (button.dataset.route === current) button.setAttribute("aria-current","page");
    else button.removeAttribute("aria-current");
  }
  $("sgBackBar")?.classList.toggle("sg10-back",Boolean(editing) || !["inicio","hoja","pedidos","compras","cargas"].includes(page));
}

function orderToolbar(element) {
  const bar = document.createElement("div");
  bar.className = "sg10-page-tools";
  bar.innerHTML = '<button type="button" class="primary" data-new>+ Nuevo pedido</button>'
    + '<details><summary>Más opciones</summary><div class="sg10-tools"><button type="button" data-import>Importar de WhatsApp</button>'
    + '<button type="button" data-print>Imprimir pedidos / PDF</button></div></details>';
  const keepDailySelection = () => {
    sgNavDate = val("dailyDate") || today();
    sgNavClient = val("dailyClient");
  };
  bar.querySelector("[data-new]").onclick = () => {
    keepDailySelection();
    go("pedidos");
    requestAnimationFrame(()=>$("oProduct")?.focus());
  };
  bar.querySelector("[data-import]").onclick = () => { keepDailySelection();window.sgImportOpen(); };
  bar.querySelector("[data-print]").onclick = () => { keepDailySelection();window.sgPrint82(); };
  element.prepend(bar);
}
function decorateDaily() {
  const sheet=$("dailySheet");
  if(!sheet||sheet.querySelector(".sg10-page-tools"))return;
  const filters=document.createElement("div");
  filters.className="sg10-sheet-filters";
  const day=sheet.querySelector("#dailyDate"),company=sheet.querySelector("#dailyClient"),reverse=sheet.querySelector("#dailyAll");
  day.setAttribute("aria-label","Fecha de consulta");
  day.before(filters);
  filters.append(company,day);
  for(const button of sheet.querySelectorAll("#dailyPrev,#dailyNext"))button.hidden=true;
  const instruction=[...sheet.children].find(node=>node.classList.contains("muted")&&node.textContent.includes("Desliza"));
  if(instruction)instruction.hidden=true;
  if(reverse) {
    const holder=reverse.closest("label");
    holder.hidden=true;
    holder.classList.add("sg10-sheet-extra");
  }
  orderToolbar(sheet);
  const dailyOptions=sheet.querySelector(".sg10-page-tools .sg10-tools");
  const previous=document.createElement("button");
  const next=document.createElement("button");
  previous.type=next.type="button";
  previous.textContent="Cliente anterior";next.textContent="Cliente siguiente";
  previous.onclick=()=>sheet.querySelector("#dailyPrev")?.click();
  next.onclick=()=>sheet.querySelector("#dailyNext")?.click();
  const refresh = sheet.querySelector("#dailyRefresh");
  dailyOptions.append(previous,next,refresh);
  if(reverse) {
    const label=reverse.closest("label");
    label.hidden=false;
    dailyOptions.append(label);
  }
  for (const cell of sheet.querySelectorAll('[data-order-id] [data-field="supplier"]')) {
    bindSplitHold(cell,cell.closest("[data-order-id]").dataset.orderId);
  }
}
function bindSplitHold(cell,orderId) {
  if (d(get("orders",orderId)).quantityUnit !== "pales") return;
  cell.title = "Toca para editar. Mantén pulsado para repartir entre puestos.";
  let timer,x,y;
  cell.addEventListener("pointerdown",event=>{
    if (event.button!==0) return;
    cell.dataset.sg10Held="0";
    x=event.clientX;y=event.clientY;clearTimeout(timer);
    timer=setTimeout(()=>{
      cell.dataset.sg10Held="1";
      window.sg10Ops("splitPurchase",orderId);
      setTimeout(()=>{cell.dataset.sg10Held="0";},1400);
    },620);
  });
  cell.addEventListener("pointermove",event=>{
    if (Math.hypot(event.clientX-x,event.clientY-y)>12) clearTimeout(timer);
  });
  for (const name of ["pointercancel","pointerleave","pointerup"]) cell.addEventListener(name,()=>clearTimeout(timer));
  cell.addEventListener("contextmenu",event=>event.preventDefault());
}
new MutationObserver(decorateDaily).observe($("content"),{childList:true});
function simpleOrderForm() {
  if(page!=="pedidos")return;
  const form=$("oProduct")?.closest(".card");
  if(!form)return;
  if(form.querySelector(".sg10-advanced"))return;
  const advanced=document.createElement("details");
  advanced.className="sg10-advanced";
  advanced.innerHTML="<summary>Variedad, observaciones, precio y estado</summary>";
  const fields=["oVariety","oPrice","oPriceUnit","oStatus"].map(id=>$(id)?.parentElement).filter(Boolean);
  for(const field of fields) advanced.append(field);
  const notes=$("oNotes"),label=notes?.previousElementSibling;
  if(label)advanced.append(label);
  if(notes)advanced.append(notes);
  form.querySelector(".actions")?.before(advanced);
}

const signOut = logout;
logout = async () => {
  if (api && user) {
    try { await detachPush(api,user.id); }
    catch (error) { toast(error.message);return; }
  }
  await walkie.close();
  return signOut();
};

let scope = "";
let inbox;
let liveChannel;
let liveApi;
let syncTimer;
let history = [];
let orderDraft;
let busy = false;
const currentScope = () => user?.id && workspace ? user.id + ":" + workspace : "";
const operations = installOperations({
  connection: () => ({api,workspace,user,role,records}),
  refresh: () => render(),
  date: () => sgClientDate(),
  formatPallets,
});

const walkie=installWalkie({connection:()=>({api,workspace,user}),dialog:operations.dialog});

function goToNotice(row) {
  const targets = { pedidos:"orders", compras:"purchases" };
  if (!["pedidos","compras","facturas","comisiones","galeria"].includes(row.target)) return go("ajustes");
  const collection = targets[row.target];
  if (collection && get(collection,row.record_id)) {
    const item = d(get(collection,row.record_id));
    sgNavDate = item.date || today();
    sgNavClient = item.clientId;
    go(collection === "orders" ? "hoja" : row.target);
    if (editing) return;
    const card = [...document.querySelectorAll("[data-sg10-record],[data-order-id]")].find(node => (node.dataset.sg10Record ?? node.dataset.orderId) === row.record_id);
    if (card) {
      card.classList.add("sg10-highlight");
      card.scrollIntoView({block:"center"});
    } else if(collection === "orders"){go("pedidos");edit(collection,row.record_id);}
    else edit(collection,row.record_id);
    return;
  }
  if (row.target === "comisiones") sgComClient = row.client_id;
  operations.setTarget(row.record_id);
  go(row.target);
  if (row.kind === "pedido_eliminado") toast("Este pedido fue eliminado.");
}

function connectScope() {
  const key = currentScope();
  if (key === scope) return;
  scope = key;
  inbox?.close();
  inbox = null;
  clearTimeout(syncTimer);
  if (liveChannel) liveApi.removeChannel(liveChannel);
  liveChannel = null;
  liveApi = null;
  history = [];
  orderDraft = null;
  walkie.showShortcut(Boolean(key));
  if (!key) { walkie.close(); return; }
  inbox = attachInbox({api,space:workspace,user:user.id,button:notices,panel:noticePanel,onOpen:goToNotice});
  liveApi = api;
  liveChannel = api.channel("sg10-staff-" + crypto.randomUUID());
  for (const table of ["sg_orders","sg_purchases","sg_clients","sg_pallets"]) {
    liveChannel.on("postgres_changes",{event:"*",schema:"public",table,filter:"workspace_id=eq."+workspace},() => {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(async () => {
        if (key !== scope || document.hidden) return;
        await sync(true);
        const active = document.activeElement;
        if (!editing && !document.querySelector("dialog[open], #dailyDialog:not([hidden])") &&
            !active?.matches("input,select,textarea") && ["inicio","pedidos","hoja","compras","cargas","consultar"].includes(page) &&
            !hasDraft()) render();
      },380);
    });
  }
  liveChannel.subscribe();
}
function hasDraft() {
  if (page === "pedidos") return Boolean(val("oProduct") || val("oBoxes") || val("oNotes"));
  if (page === "compras") return Boolean(val("pOrder") || val("pSupplier") || val("pNotes"));
  return false;
}
setInterval(connectScope,700);
document.addEventListener("visibilitychange",() => {
  if (!document.hidden && currentScope()) sync(true);
});

const activeLine = row => !["Cancelado","Anulado"].includes(row.data.status);
const donePurchase = data => ["Comprado","Cargado","Preparado","Completado","Entregado"].includes(data.status);
let newPurchase = false;
const purchaseForm = purchases;
function remainingOrder(order) {
  const data = order.data;
  const key = data.quantityUnit === "pales" ? "sgBoughtPallets" : "boxes";
  const reserved = records.purchases.filter(row=>activeLine(row)&&row.data.orderId===order.id)
    .reduce((sum,row)=>sum+(Number(row.data[key])||0),0);
  return Math.max(0,(Number(data.boxes)||0)-reserved);
}
function purchaseQuantity(data,isPurchase,amount) {
  const pallets = data.quantityUnit === "pales";
  const value = isPurchase ? (pallets ? data.sgBoughtPallets : data.boxes) : amount;
  if (Number(value)>0) return (pallets ? formatPallets(value) : qty(value)) + " " + (pallets && Number(value)<=1 ? "palé" : orderUnitLabel(data.quantityUnit,value));
  return isPurchase && kilos(data)>0 ? qty(kilos(data))+" kg" : "";
}
purchases = () => {
  if (newPurchase || editing?.t==="purchases") return purchaseForm();
  const chosen = sgSelectedClient();
  const groups = new Map();
  function add(row,kind,amount) {
    const data = row.data;
    const isPurchase = kind === "purchase";
    const status = isPurchase && donePurchase(data) ? "done" : "pending";
    const quantity = purchaseQuantity(data,isPurchase,amount);
    const unit = data.priceUnit === "caja" ? "caja" : data.priceUnit === "pale" ? "palé" : "kg";
    const cost = data.priceCents==null&&data.price==null ? "—" : fmt(price(data))+"/"+unit;
    const label = [quantity,data.product,data.variety].filter(Boolean).join(" ");
    const line = '<tr class="'+status+'" data-kind="'+kind+'" data-purchase-line="'+html(row.id)+'"'
      + (isPurchase?' data-sg10-record="'+html(row.id)+'"':'') + '>'
      + '<td><button type="button" class="dailyCell" data-focus="pProduct">'+html(label)+'</button></td>'
      + '<td><button type="button" class="dailyCell" data-focus="pPrice">'+html(cost)+'</button></td>'
      + '<td><button type="button" class="dailyCell" data-focus="pSupplier">'+html(data.supplier||"—")+'</button></td></tr>';
    if (!groups.has(data.clientId)) groups.set(data.clientId,[]);
    groups.get(data.clientId).push(line);
  }
  for (const row of records.orders.filter(row=>sgClientMatch(row)&&activeLine(row)&&!donePurchase(row.data))) {
    const amount = remainingOrder(row);
    if (amount>0) add(row,"order",amount);
  }
  for (const row of records.purchases.filter(row=>sgClientMatch(row)&&activeLine(row))) add(row,"purchase");
  const body = [...groups].sort(([a],[b])=>name(a).localeCompare(name(b),"es")).map(([id,rows])=>
    (chosen ? "" : '<tr class="purchase-company"><th colspan="3" scope="rowgroup">'+html(name(id))+'</th></tr>')+rows.join("")).join("");
  return '<div class="card" id="purchaseSheet"><div class="sg10-page-tools"><button type="button" class="primary" data-new-purchase>+ Nueva compra</button></div>'
    + '<table><thead><tr><th>Producto</th><th>Precio</th><th>Puesto</th></tr></thead><tbody>'+body+'</tbody></table>'
    + (body?"":"<p>No hay compras ni pedidos pendientes para esta selección.</p>")+'</div>';
};

function fillPurchaseOrder(order) {
  const countLabel = document.querySelector('label[for="pBoxes"]');
  countLabel.textContent = order?.data.quantityUnit === "sacos" ? "Sacos" : "Cajas";
  if (!order) return;
  const data = order.data;
  $("pClient").value=data.clientId;
  $("pDate").value=data.date;
  $("pOrder").value=order.id;
  $("pProduct").value=data.product;
  $("pVariety").value=data.variety||"";
  $("pBoxes").value=data.quantityUnit==="pales"?0:remainingOrder(order);
  const pallets=$("sg10PurchasePallets");
  if (pallets) pallets.value=data.quantityUnit==="pales"?formatPallets(remainingOrder(order)):"";
}
function focusPurchase(field) {
  const input = $(field);
  if (!input) return;
  const details = input.closest("details");
  if (details) details.open=true;
  input.focus();
}
window.sg10OpenPurchaseForm = (orderId,field) => {
  const order=get("orders",orderId);
  if (order) {
    sgNavDate=order.data.date;
    sgNavClient=order.data.clientId;
  }
  newPurchase=true;
  originalGo("compras");
  if (!$("pOrder")) return;
  sgRefreshOrderChoices();
  fillPurchaseOrder(order);
  $("pOrder").dispatchEvent(new Event("change"));
  focusPurchase(field || (order ? "pSupplier" : "pProduct"));
};

function decoratePurchaseSheet() {
  const sheet=$("purchaseSheet");
  if (!sheet) return;
  sheet.querySelector("[data-new-purchase]").onclick=()=>window.sg10OpenPurchaseForm();
  for (const button of sheet.querySelectorAll("[data-focus]")) {
    const {kind,purchaseLine}=button.closest("tr").dataset;
    const existing=kind==="purchase";
    const orderId=existing?d(get("purchases",purchaseLine)).orderId:purchaseLine;
    if (button.dataset.focus==="pSupplier") bindSplitHold(button,orderId);
    button.onclick=()=>{
      if (button.dataset.sg10Held==="1") { button.dataset.sg10Held="0"; return; }
      if (existing) { edit("purchases",purchaseLine); focusPurchase(button.dataset.focus); }
      else window.sg10OpenPurchaseForm(purchaseLine,button.dataset.focus==="pProduct"?"pSupplier":button.dataset.focus);
    };
  }
}
function decoratePurchaseForm() {
  const picker=$("pOrder");
  if (!picker) return;
  const original=get("purchases",editing?.id);
  const card=picker.closest(".card");
  card.querySelector("h2").textContent=original?"Editar compra":"Nueva compra";
  operations.decoratePurchase();
  picker.addEventListener("change",()=>{
    if (!original) fillPurchaseOrder(get("orders",picker.value));
  });
  if (original?.data.orderId) {
    $("pProduct").readOnly=true;
    $("pVariety").readOnly=true;
  }
  const extra=document.createElement("details");
  extra.className="sg10-advanced";
  extra.innerHTML="<summary>Carga, peso, IVA y observaciones</summary>";
  extra.append($("pMode").parentElement,$("realWeight"),$("fixedWeight"),
    $("sg10Tara").parentElement,$("sg10Vat").parentElement,$("sg10FixedWeightButton"));
  const notes=$("pNotes");
  extra.append(notes.previousElementSibling,notes);
  card.querySelector(".actions").before(extra);
  const exit=document.createElement("button");
  exit.type="button";exit.className="secondary";exit.textContent="Volver a compras";
  exit.onclick=()=>go("compras");
  const actions=card.querySelector(".actions");
  actions.querySelector('button[onclick="cancel()"]')?.remove();
  actions.append(exit);
  if (original) {
    const load=document.createElement("button");
    load.type="button";load.textContent="Registrar carga";
    load.onclick=()=>{extra.open=true;$("pStatus").value="Cargado";focusPurchase(val("pMode")==="fixed"?"pKgBox":"pKg");};
    const removeButton=document.createElement("button");
    removeButton.type="button";removeButton.className="danger";removeButton.textContent="Eliminar compra";
    removeButton.onclick=()=>remove("purchases",original.id);
    actions.append(load,removeButton);
  }
}

function decorate() {
  if (page === "compras") {
    decoratePurchaseSheet();
    decoratePurchaseForm();
    return;
  }
  if (page !== "pedidos" || !$("oUnit")) return;
  const half = document.createElement("button");
  half.type = "button";
  half.className = "secondary";
  half.textContent = "½ palé";
  half.onclick = () => { $("oBoxes").value = "½"; $("oUnit").value = "pales"; $("oUnit").dataset.manual = "1"; };
  $("oUnit").after(half);
  const date = $("oDate");
  const tomorrow = document.createElement("button");
  tomorrow.type = "button";
  tomorrow.textContent = "Mañana";
  tomorrow.onclick = () => {
    const next = new Date(today()+"T12:00:00Z");
    next.setUTCDate(next.getUTCDate()+1);
    date.value=next.toISOString().slice(0,10);
  };
  date.after(tomorrow);
}

function loadSheet() {
  const day = val("sg10LoadDate");
  const client = val("sg10LoadCompany");
  const orders = records.orders.filter(row => {
    const x = d(row);
    return x.date === day && (!client || client === x.clientId) && !["Cancelado","Anulado"].includes(x.status);
  });
  const purchases = records.purchases.filter(row => {
    const x = d(row);
    return x.date === day && (!client || client === x.clientId) && !["Cancelado","Anulado"].includes(x.status);
  });
  const companies = new Map();
  function add(data, n, unit) {
    const groups = companies.get(data.clientId) ?? new Map();
    const supplier = data.supplier || "Sin puesto";
    const list = groups.get(supplier) ?? [];
    list.push([(unit === "pales" ? formatPallets(n) : qty(n)) + " " + orderUnitLabel(unit,n),
      [data.product,data.variety].filter(Boolean).join(" "),supplier]);
    groups.set(supplier,list);
    companies.set(data.clientId,groups);
  }
  for (const row of purchases) {
    const x = d(row);
    if (Number(x.boxes) > 0) add(x,Number(x.boxes),x.quantityUnit === "sacos" ? "sacos" : "cajas");
    else if (x.quantityUnit === "pales" && Number(x.sgBoughtPallets) > 0) add(x,Number(x.sgBoughtPallets),"pales");
  }
  for (const row of orders) {
    const x = d(row);
    const linked = purchases.filter(p => d(p).orderId === row.id).map(d);
    if (x.quantityUnit === "pales") {
      if (!linked.length) add(x,Number(x.boxes),"pales");
      continue;
    }
    const remaining = Number(x.boxes) - linked.reduce((n,p) => n + (Number(p.boxes) || 0),0);
    if (remaining > 0) add(x,remaining,x.quantityUnit);
  }
  if (!companies.size) return toast("No hay mercancía en esa selección.");
  const windowPrint = window.open("","_blank");
  if (!windowPrint) return toast("Permite ventanas emergentes para imprimir.");
  const sections = [...companies].map(([id, groups]) => '<section><h2>' + html(name(id)) + '</h2><div class="columns">'
    + [...groups].sort(([a],[b]) => a.localeCompare(b,"es")).map(([supplier,rows]) => '<div class="group"><h3>' + html(supplier)
    + '</h3><table><thead><tr><th>Cantidad</th><th>Producto</th><th>Puesto</th><th aria-label="Verificado"></th></tr></thead><tbody>'
    + rows.map(cells => '<tr>' + cells.map(cell => '<td>' + html(cell) + '</td>').join("") + '<td><span class="box"></span></td></tr>').join("")
    + '</tbody></table></div>').join("") + '</div></section>').join("");
  windowPrint.document.write('<!doctype html><html lang="es"><meta charset="utf-8"><title>SG · Hoja de carga</title><style>'
    + '@page{size:A4 landscape;margin:10mm}body{font:10pt Arial;margin:0}header{background:#123b27;color:white;padding:9px;print-color-adjust:exact}'
    + 'h2,h3{break-after:avoid;margin:.5em 0}.columns{columns:2;column-gap:8mm}.group{break-inside:avoid-column;margin-bottom:12px}'
    + 'table{width:100%;border-collapse:collapse}th,td{border:1px solid #aaa;padding:4px;text-align:left}tr{break-inside:avoid}'
    + '.box{display:block;width:12px;height:12px;border:1px solid #222}</style><header><b>SG Corredores · Hoja de carga</b> · '
    + html(day) + '</header>' + sections + '</html>');
  windowPrint.document.close();
  windowPrint.focus();
  setTimeout(() => windowPrint.print(),300);
}
window.sg10PrintLoad = loadSheet;

const originalExtra = window.sgExtra;
window.sgExtra = function (target) {
  if (target === "facturas") return operations.invoiceView();
  if (target === "cargas") return '<div class="card"><h2>Cargas y paletizaje</h2><div class="grid"><label>Fecha <input id="sg10LoadDate" type="date" value="'
    + html(sgClientDate()) + '"></label><label>Cliente <select id="sg10LoadCompany"><option value="">Todos</option>'
    + options(sgSelectedClient()) + '</select></label></div><div class="sg10-tools"><button onclick="sg10PrintLoad()">Imprimir hoja A4</button>'
    + '<button onclick="sgGo(\'pales\')">Palés por cliente</button><button onclick="sg10Ops(\'camera\')">Recuento con cámara</button></div></div>' + originalExtra(target);
  return originalExtra(target);
};

window.sg10InviteStaffWhatsApp = async (button) => {
  if (role !== "owner" || !user || user.is_anonymous) return;
  const result = $("sgWhatsAppInviteStatus");
  button.disabled = true;
  try {
    await prepareWhatsAppInvite(api,workspace,null,null,result);
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

let availableVersion;
const originalSettings = settings;
settings = () => originalSettings() + '<div class="card"><h2>Voz de Aguacatín</h2><div id="sgAguVoiceSettings"></div></div>' + '<div class="card"><h2>Actualizaciones</h2><p>Instalada: <strong>' + version
  + '</strong></p><button onclick="sg10CheckRelease(this)">Buscar actualizaciones</button><p id="sg10ReleaseStatus" role="status"></p>'
  + '<ul id="sg10ReleaseNews"></ul><button id="sg10Update" onclick="sg10ApplyRelease(this)" hidden>Actualizar aplicación</button></div>'
  + operations.settingsView();
window.sg10CheckRelease = async (button) => {
  button.disabled = true;
  const result = $("sg10ReleaseStatus");
  try {
    const release = await readRelease();
    availableVersion = release.version;
    result.textContent = "Publicada: " + release.version;
    $("sg10ReleaseNews").replaceChildren(...release.news.map(text => {
      const line = document.createElement("li"); line.textContent = text; return line;
    }));
    $("sg10Update").hidden = availableVersion === version;
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
};
window.sg10ApplyRelease = async (button) => {
  if (!availableVersion || availableVersion === version) return;
  button.disabled = true;
  if (!confirm("¿Actualizar ahora? Las ediciones sin guardar en esta ventana se perderán.")) {
    button.disabled = false;
    return;
  }
  try {
    const registration = await navigator.serviceWorker?.register("./sw.js");
    await registration?.update();
    const worker = registration?.waiting || registration?.installing;
    if (worker && worker.state === "installing") await Promise.race([
      new Promise(resolve => worker.addEventListener("statechange",() => { if (worker.state !== "installing") resolve(); })),
      new Promise(resolve => setTimeout(resolve,6000)),
    ]);
    registration?.waiting?.postMessage({type:"SG_SKIP_WAITING"});
    const next = new URL("./Index.html",location.href);
    next.searchParams.set("v",availableVersion);
    location.replace(next.href);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
};

const builtInRate = rate;
rate = (client,product) => operations.configureRate(client,product) ?? builtInRate(client,product);
const originalCommissions = commissions;
commissions = () => originalCommissions() + operations.commissionView({
  client:sgComClient === null ? sgSelectedClient() : sgComClient,
  start:sgComDate || sgClientDate(),
  end:window.sgComEnd || sgComDate || sgClientDate(),
});
const originalRender = render;
render = function (...args) {
  const result = originalRender.apply(this,args);
  decorate();
  decorateDaily();
  simpleOrderForm();
  updateNav();
  operations.afterRender(page);
  return result;
};
const originalGo = go;
const originalSection = sgGo;
sgGo = function (target) { newPurchase = false; return originalSection(target); };
go = function (target) {
  newPurchase = false;
  if (target === "galeria" || target === "facturas" || target === "cargas" || target === "pales") {
    page = target;
    editing = null;
    $("content").innerHTML = target === "galeria" ? operations.galleryView() : window.sgExtra(target);
    updateNav();
    operations.afterRender(page);
    return;
  }
  return originalGo(target);
};

function answer(text, voice = true) {
  $("aguBubble").textContent = text;
  if (voice && typeof window.aguSay === "function") window.aguSay(text);
}
function assistantDraft(rows, selectedClient, date) {
  const dialog = operations.dialog("Revisar pedido de Aguacatín");
  const form = document.createElement("form");
  form.innerHTML = '<label>Cliente <select name="client" required><option value="">Seleccionar</option>' + options(selectedClient)
    + '</select></label><label>Fecha <input name="date" type="date" value="' + html(date) + '" required></label>'
    + rows.map((row,index) => '<fieldset><legend>Artículo ' + (index+1) + '</legend><label>Producto <input name="product" maxlength="120" required value="'
      + html(row.product) + '"></label><label>Variedad (opcional) <input name="variety" maxlength="120" value="' + html(row.variety)
      + '"></label><label>Cantidad <input name="quantity" required inputmode="decimal" value="' + html(row.quantity)
      + '"></label><label>Unidad <select name="unit" required>'
      + sgUnitOptions(row.unit) + '</select></label></fieldset>').join("")
    + '<button type="submit">Confirmar y guardar</button><p role="status"></p>';
  dialog.querySelector("[data-content]").append(form);
  const context = currentScope();
  let requestId = crypto.randomUUID();
  form.oninput = () => { requestId = crypto.randomUUID(); };
  orderDraft = {dialog, form};
  dialog.onclose = () => { orderDraft = null; dialog.remove(); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (context !== currentScope()) return dialog.close();
    const clientId = form.elements.client.value;
    const date = form.elements.date.value;
    const lines = [...form.querySelectorAll("fieldset")].map(row => ({
      clientId,date,product:row.querySelector('[name="product"]').value.trim(),variety:row.querySelector('[name="variety"]').value.trim(),
      boxes:validNumber(row.querySelector('[name="quantity"]').value),quantityUnit:row.querySelector('[name="unit"]').value,status:"Pendiente",
    }));
    const output = form.querySelector("[role=status]");
    if (lines.some(row => !row.product || !Number.isFinite(row.boxes) || row.boxes <= 0)) return output.textContent = "Revisa los artículos.";
    if (new Set(lines.map(row => [normalized(row.product), normalized(row.variety),row.boxes,row.quantityUnit].join("|"))).size !== lines.length)
      return output.textContent = "Hay artículos repetidos. Revísalos.";
    event.submitter.disabled = true;
    try {
      const { error } = await api.rpc("sg10_staff_order", {space:workspace,request:requestId,lines});
      if (error) throw error;
      await sync(true);
      dialog.close();
      answer(lines.length === 1 ? "Pedido guardado en Supabase." : lines.length + " artículos guardados en Supabase.");
      toast("Pedido guardado.");
    } catch (error) { output.textContent = error.message; }
    finally { event.submitter.disabled = false; }
  };
}

const legacySend = window.aguSend;
window.aguSend = async function () {
  const input = $("aguFloatInput");
  const text = input?.value.trim();
  if (!text || !workspace || !user) return legacySend?.();
  const query = normalized(text);
  if (/^(imprime|imprimir|saca en papel|modifica|cambia|confirma|anula|elimina|carga)\b/.test(query)) return legacySend?.();
  if (busy) return;
  busy = true;
  input.value = "";
  const account = currentScope();
  const mode = isOrderRequest(text) ? "pedido" : "consulta";
  const date = text.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0] ?? sgClientDate();
  $("aguBubble").textContent = mode === "pedido" ? "Preparando el borrador…" : "Consultando los datos…";
  try {
    const result = await invoke(api,"sg10-aguacatin",{
      workspace,mode,text,date,history,deep:/\b(analiza|compara|incoherencia|discrepancia|explica|a fondo|detallado|resumen complejo)\b/.test(query),
    });
    if (account !== currentScope() || $("aguControls").hidden) return;
    if (mode === "pedido" && Array.isArray(result.articulos) && result.articulos.length) {
      const company = matchCompany(text,records.clients.map(row => ({id:row.id,name:d(row).name})));
      if (result.articulos.length > 30) throw Error("Puedes confirmar hasta 30 artículos por pedido. Dicta el pedido en dos partes.");
      assistantDraft(result.articulos,company,/^20\d{2}-\d{2}-\d{2}$/.test(result.fecha) ? result.fecha : date);
      answer("He preparado " + result.articulos.length + (result.articulos.length === 1 ? " artículo." : " artículos.") + " Revisa el borrador y confirma para guardarlo.");
    } else {
      answer(result.respuesta);
      history = [...history,{role:"user",content:text},{role:"assistant",content:result.respuesta}].slice(-6);
    }
  } catch (error) { if (account === currentScope()) answer(error.message); }
  finally { busy = false; }
};

window.sg10AssistantBusy = () => busy;
window.sg10FormPurchase = (data) => {
  if ($("sg10Tara") && $("sg10Vat") && page === "compras") {
    for (const [id,key,max] of [["sg10Tara","tara",10000],["sg10Vat","vatRate",100]]) {
      const raw = val(id);
      const value = raw ? validNumber(raw) : null;
      if (value !== null && (!Number.isFinite(value) || value > max)) throw Error("Revisa los valores de tara e IVA.");
      data[key] = value;
    }
    delete data.ivaRate;
  }
  const raw = val("sg10PurchasePallets");
  if (data.quantityUnit === "pales" && $("sg10PurchasePallets") && !$("sg10PurchasePallets").closest("label").hidden) {
    const amount = readPallets(raw);
    if (!Number.isFinite(amount)) throw Error("Introduce palés completos o medios, por ejemplo 1, ½ o 2½.");
    data.sgBoughtPallets = amount;
  }
  return data;
};
window.sg10ValidatePurchase = (data) => {
  if (data.status !== "Cargado") return;
  if (!(kilos(data) > 0)) throw Error("Para confirmar la carga faltan los kilos netos o el peso fijo por caja.");
};
