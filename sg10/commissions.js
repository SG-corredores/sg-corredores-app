import { esc } from "./common.js?v=10.0.0-rc.24";

const money = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const price = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 4 });
const quantity = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 3 });
const euro = value => value == null ? "—" : money.format(value);
const amount = value => value == null ? "—" : quantity.format(value);
const spanishDate = value => value?.split("-").reverse().join("/") ?? "";
const unit = { kg: "kg", caja: "caja", bulto: "bulto", pale: "palet" };

const printCss = `
.sg-liquidation{padding:14px;color:#172720;background:#fff;font:14px system-ui,Arial,sans-serif}
.sg-liquidation header{display:flex;gap:12px;align-items:center;background:#fff;color:#123b27;padding:0;margin:0 0 14px}
.sg-liquidation header img{width:50px;height:50px;object-fit:contain}
.sg-liquidation header h2{margin:2px 0;color:#123b27;font-size:20px}
.sg-liquidation table{width:100%;border-collapse:collapse;font-size:13px}
.sg-liquidation th,.sg-liquidation td{padding:5px 4px;border:1px solid #729181;text-align:right}
.sg-liquidation th{background:#123b27;color:#fff}
.sg-liquidation td:nth-child(4),.sg-liquidation td:nth-child(5){text-align:left}
.sg-liquidation .subtotal{background:#e4efe7;font-weight:700}
.sg-liquidation .unconfirmed{background:#fff4d8;color:#493a11}
.sg-liquidation .totals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:12px}
.sg-liquidation .status{font-weight:700}
@media print{
  @page{size:A4 portrait;margin:10mm}
  body{margin:0}
  .sg-liquidation{padding:0;print-color-adjust:exact;-webkit-print-color-adjust:exact}
  .sg-liquidation+.sg-liquidation{break-before:page;page-break-before:always}
  .sg-liquidation table{font-size:10pt}
  .sg-liquidation thead{display:table-header-group}
  .sg-liquidation tr,.sg-liquidation header,.sg-liquidation .totals{break-inside:avoid}
}
`;
const headings = ["Bultos", "Tara", "Kg", "Mercancía", "Asentador", "Precio", "Importe", "Importe + IVA", "Comisión"];
const row = (cells, css = "") => '<tr class="' + css + '">' + cells.map(value => "<td>" + esc(value) + "</td>").join("") + "</tr>";
const sum = (rows, key) => rows.reduce((total, entry) => total + Number(entry[key] ?? 0), 0);
const incomplete = group => Number(group.pending_invoices) + Number(group.pending_orders) + Number(group.pending_purchases) > 0;

function sheet(group, range, logo) {
  const suppliers = new Map();
  for (const line of group.lines) {
    const supplier = line.supplier || "Asentador sin identificar";
    if (!suppliers.has(supplier)) suppliers.set(supplier, []);
    suppliers.get(supplier).push(line);
  }
  let details = "";
  for (const [supplier, lines] of suppliers) {
    for (const line of lines) {
      const product = [line.item, line.variety].filter(Boolean).join(" ");
      const description = [product, line.kind === "abono" ? "Abono" : "", line.commission == null ? "Pendiente" : "",
        line.invoice_number ? "N.º " + line.invoice_number : "", range.start !== range.end ? spanishDate(line.day) : ""].filter(Boolean).join(" · ");
      const cost = line.price == null ? "—" : price.format(line.price) + " €" + (unit[line.unit] ? "/" + unit[line.unit] : "");
      details += row([amount(line.boxes), amount(line.tare), amount(line.kg), description, supplier, cost, euro(line.net), euro(line.gross), euro(line.commission)],
        line.commission == null ? "unconfirmed" : "");
    }
    const confirmed = lines.filter(line => line.commission != null);
    details += row(["", "", amount(sum(confirmed,"kg")), "", "Subtotal " + supplier, "", euro(sum(confirmed,"net")),
      euro(sum(confirmed,"gross")), euro(sum(confirmed,"commission"))], "subtotal");
  }
  const dates = spanishDate(range.start) + (range.start === range.end ? "" : " – " + spanishDate(range.end));
  const reasons = [group.pending_invoices ? group.pending_invoices + " facturas o abonos por conciliar" : "",
    group.pending_orders ? group.pending_orders + " pedidos sin compra asociada" : "",
    group.pending_purchases ? group.pending_purchases + " compras sin conciliar" : ""].filter(Boolean);
  return '<section class="sg-liquidation"><header><img src="' + esc(logo) + '" alt="Serrano Gago"><div><b>SERRANO GAGO</b><h2>'
    + esc(group.name) + '</h2><b>' + dates + '</b></div></header><p class="status">'
    + (incomplete(group) ? "Liquidación pendiente · totales parciales" : "Liquidación conciliada") + '</p>'
    + (reasons.length ? '<p>' + esc(reasons.join(" · ")) + '</p>' : "")
    + (details ? '<table><thead><tr>' + headings.map(label => "<th>" + esc(label) + "</th>").join("") + '</tr></thead><tbody>'
      + details + '</tbody></table>' : '<p>Sin facturas conciliadas para este cliente en el periodo.</p>')
    + '<div class="totals"><b>Kilos confirmados: ' + amount(group.kg) + '</b><b>Comisión confirmada: ' + euro(group.commission)
    + '</b><b>Compras conciliadas: ' + euro(group.net) + '</b><b>Compras con IVA: ' + euro(group.gross) + '</b></div></section>';
}

function periodStart(day, kind) {
  if (kind === "year") return day.slice(0,4) + "-01-01";
  if (kind === "month") return day.slice(0,7) + "-01";
  if (kind !== "week") return day;
  const monday = new Date(day + "T00:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0,10);
}

function printSheets(sections) {
  const preview = window.open("", "_blank");
  if (!preview) throw Error("Permite las ventanas emergentes para imprimir o guardar en PDF.");
  preview.document.open();
  preview.document.write('<!doctype html><html lang="es"><head><meta charset="utf-8"><title>SG Corredores · Liquidaciones</title>'
    + '<style>' + printCss + '</style></head><body>' + sections.map(section => section.outerHTML).join("") + '</body></html>');
  preview.document.close();
  const print = () => { if (!preview.closed) { preview.focus(); preview.print(); } };
  if (preview.document.readyState === "complete") print();
  else preview.addEventListener("load", print, { once: true });
}

export function installCommissions({ connection, today, selected, changeSelection, redraw, portalControls }) {
  let start = "", end = "", currentScope = "", manual = "";
  const logo = new URL("./logotipo.png", import.meta.url).href;
  function view() {
    const { user, workspace, role } = connection();
    const account = workspace + ":" + user?.id;
    if (account !== currentScope) {
      currentScope = account;
      start = end = manual = "";
    }
    const startDay = start || today();
    const endDay = end || startDay;
    return '<section class="card" id="sgDailyCommissions"><style>' + printCss + '</style><h2>Comisiones</h2>'
      + '<div class="sg10-tools">' + [["day","Diario"],["week","Semanal"],["month","Mensual"],["year","Anual"]]
        .map(([key,label]) => '<button type="button" data-period="' + key + '">' + label + '</button>').join("")
      + '<button type="button" data-refresh>Actualizar liquidaciones</button>'
      + (role === "owner" && !user?.is_anonymous ? '<button type="button" data-gmail>Buscar nuevas facturas en Gmail</button>' : "")
      + '</div><div class="grid"><label>Desde<input type="date" data-start value="' + esc(startDay) + '"></label>'
      + '<label>Hasta<input type="date" data-end min="' + esc(startDay) + '" value="' + esc(endDay) + '"></label>'
      + '<label>Cliente<select data-client><option value="">Todos</option></select></label></div>'
      + '<p data-manual role="status">' + esc(manual) + '</p><p data-status role="status">Calculando liquidaciones…</p>'
      + '<div data-output></div></section>';
  }
  async function load() {
    const panel = document.getElementById("sgDailyCommissions");
    if (!panel || panel.dataset.loading) return;
    panel.dataset.loading = "1";
    const status = panel.querySelector("[data-status]");
    const first = panel.querySelector("[data-start]");
    const last = panel.querySelector("[data-end]");
    const picker = panel.querySelector("[data-client]");
    const output = panel.querySelector("[data-output]");
    const { api, workspace } = connection();
    first.onchange = () => { if (first.value) { start = end = first.value; redraw(); } };
    last.onchange = () => { if (last.value && last.reportValidity()) { start = first.value; end = last.value; redraw(); } };
    picker.onchange = () => { changeSelection(picker.value); redraw(); };
    panel.querySelector("[data-refresh]").onclick = redraw;
    for (const button of panel.querySelectorAll("[data-period]")) button.onclick = () => {
      const anchor = button.dataset.period === "day" ? today() : last.value;
      start = periodStart(anchor, button.dataset.period);
      end = anchor;
      redraw();
    };
    if (panel.querySelector("[data-gmail]")) panel.querySelector("[data-gmail]").onclick = async event => {
      event.currentTarget.disabled = true;
      const notice = panel.querySelector("[data-manual]");
      notice.textContent = "Solicitando sincronización…";
      let result;
      try { result = await api.rpc("sg10_request_gmail_sync", { space: workspace }); }
      catch (error) { result = { error }; }
      if (!panel.isConnected) return;
      manual = result.error ? result.error.message : "Sincronización de Gmail solicitada. Los resultados aparecerán tras importar los adjuntos.";
      notice.textContent = manual;
      panel.querySelector("[data-gmail]").disabled = false;
    };
    try {
      const range = { start: first.value, end: last.value };
      const { data, error } = await api.rpc("sg10_commission_report", { space: workspace, from_day: range.start, to_day: range.end });
      if (error) throw error;
      if (!panel.isConnected) return;
      const clients = data.clients;
      const wantedClient = selected();
      const clientId = clients.some(group => group.id === wantedClient) ? wantedClient : "";
      for (const group of clients) picker.add(new Option(group.name, group.id, false, clientId === group.id));
      const groups = clientId && clients.some(group => group.id === clientId) ? clients.filter(group => group.id === clientId) : clients;
      const totals = [
        ["Comisión confirmada", euro(sum(groups,"commission"))], ["Kilos confirmados", amount(sum(groups,"kg"))],
        ["Compras conciliadas", euro(sum(groups,"net"))], ["Compras con IVA", euro(sum(groups,"gross"))],
        ["Clientes", groups.length], ["Facturas procesadas", clientId ? sum(groups,"processed_invoices") : data.processed],
        ["Facturas pendientes", clientId ? sum(groups,"pending_invoices") : Number(data.pending) + Number(data.unread)],
        ["Liquidaciones pendientes", groups.filter(incomplete).length],
      ];
      status.textContent = [
        data.last_import ? "Última lectura de Gmail: " + new Date(data.last_import).toLocaleString("es-ES", { timeZone:"Europe/Madrid" }) : "Sin lecturas de Gmail registradas",
        data.unassigned ? data.unassigned + " facturas por identificar en este periodo" : "",
        data.unread ? data.unread + " adjuntos pendientes de lectura en el periodo" : "",
        data.undated ? data.undated + " documentos sin fecha verificable en el historial" : "",
      ].filter(Boolean).join(" · ");
      output.innerHTML = '<div class="grid">' + totals.map(([label,value]) => '<div class="item"><b>' + label
        + '</b><div class="big">' + esc(value) + '</div></div>').join("") + '</div>'
        + (clients.length ? '<div class="actions"><button type="button" class="primary" data-print-all>Imprimir todos los clientes / PDF</button></div>' : "")
        + (groups.length ? groups.map(group => '<article class="card"><div style="overflow:auto">' + sheet(group,range,logo)
          + '</div><button type="button" data-print-one>Imprimir cliente / PDF</button></article>').join("") : '<p>Sin actividad conciliable en el periodo.</p>');
      const onPrint = sections => { try { printSheets(sections); } catch (error) { status.textContent = error.message; } };
      for (const button of output.querySelectorAll("[data-print-one]")) button.onclick = () =>
        onPrint([button.closest("article").querySelector(".sg-liquidation")]);
      if (clients.length) output.querySelector("[data-print-all]").onclick = () => {
        const template = document.createElement("template");
        template.innerHTML = clients.map(group => sheet(group,range,logo)).join("");
        onPrint([...template.content.children]);
      };
      if (clientId && groups.length === 1 && groups[0].id === clientId && !incomplete(groups[0])) {
        void portalControls(panel, groups[0], range).catch(error => { status.textContent = error.message; });
      }
    } catch (error) {
      if (panel.isConnected) status.textContent = "No se pudieron cargar las liquidaciones. " + error.message;
    }
  }
  return { view, load };
}
