import { prepareWhatsAppInvite, esc, invoke, normalized, readPallets, validNumber } from "./common.js";

const formatting = new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR"});
const number = (value) => typeof value === "number" && Number.isFinite(value);
const renderOptions = (clients, selected = "") => clients.map(row => '<option value="' + esc(row.id) + '"'
  + (selected === row.id ? " selected" : "") + '>' + esc(row.data.name) + '</option>').join("");
const todayMatch = (value) => /^20\d{2}-\d{2}-\d{2}$/.test(value ?? "");
const canonicalProduct = (value) => normalized(value).replace(/\bpat\b/g,"patata").replace(/\bceb\b/g,"cebolla")
  .split(" ").map(word => word.length > 4 ? word.replace(/s$/,"") : word).join(" ");
const bytesHex = (array) => [...new Uint8Array(array)].map(value => value.toString(16).padStart(2,"0")).join("");
async function digest(value) {
  const buffer = typeof value === "string" ? new TextEncoder().encode(value) : await value.arrayBuffer();
  return bytesHex(await crypto.subtle.digest("SHA-256",buffer));
}

function openDialog(title) {
  document.querySelector("dialog.sg10-dialog[open]")?.close();
  const dialog = document.createElement("dialog");
  dialog.className = "sg10-dialog";
  dialog.setAttribute("aria-label",title);
  dialog.innerHTML = '<h2>' + esc(title) + '</h2><div data-content></div><form method="dialog"><button class="secondary">Cerrar</button></form>';
  dialog.addEventListener("close",() => dialog.remove(),{once:true});
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function invoiceKey(doc) {
  const supplier = normalized(doc.cif_proveedor).replace(/ /g,"");
  const invoice = normalized(doc.numero).replace(/ /g,"");
  return supplier && invoice && todayMatch(doc.fecha) ? supplier + "|" + doc.fecha.slice(0,4) + "|" + invoice : null;
}

function findCompany(doc, clients) {
  const name = normalized(doc.cliente);
  const code = normalized(doc.cif_cliente).replace(/ /g,"");
  const same = clients.filter(({data}) => (code && code === normalized(data.cif || data.nif).replace(/ /g,""))
    || (name && name === normalized(data.name)));
  return same.length === 1 ? same[0].id : null;
}

function compareInvoice(invoice, purchases, orders) {
  const doc = invoice.invoice_data;
  if (doc.tipo === "abono") return invoice.sg10_original_id ? [] : ["Vincula el abono a la factura original antes de aprobarlo."];
  const matchesOrder = orders.some(({data}) => doc.client_id && data.clientId === doc.client_id && data.date === doc.fecha
    && !["Cancelado","Anulado"].includes(data.status));
  const findings = [];
  if (!matchesOrder) findings.push("No hay pedido del día asociado a esa empresa.");
  if (!invoiceKey(doc)) findings.push("Faltan número, fecha o CIF del asentador.");
  if (!Array.isArray(doc.lineas) || !doc.lineas.length) findings.push("El documento no tiene líneas extraídas.");
  for (const line of Array.isArray(doc.lineas) ? doc.lineas : []) {
    const select = purchases.filter(({data:x}) => (doc.client_id && x.clientId === doc.client_id && x.date === doc.fecha
      && !["Anulado","Cancelado"].includes(x.status) && canonicalProduct(x.product) === canonicalProduct(line.producto)));
    if (!select.length) { findings.push((line.producto || "Artículo sin nombre") + " · Sin compra coincidente."); continue; }
    const forSupplier = select.filter(({data:x}) => normalized(x.supplier) === normalized(doc.proveedor));
    const rows = forSupplier.length ? forSupplier : select;
    if (!forSupplier.length) findings.push(line.producto + " · Revisa la correspondencia del asentador.");
    const sumBoxes = rows.reduce((n,{data:x}) => n + (Number(x.boxes)||0),0);
    if (number(line.cajas) && Math.abs(line.cajas-sumBoxes) > 0.001) findings.push(line.producto + " · Bultos distintos ("+line.cajas+" / "+sumBoxes+").");
    const weights = rows.map(({data:x}) => x.weightMode === "fixed" ? Number(x.boxes)*Number(x.kgPerBox) : Number(x.kg));
    const kilos = weights.reduce((n,x) => n+x,0);
    if (number(line.kilos_netos) && weights.every(x => x>0) && Math.abs(line.kilos_netos-kilos)>0.01)
      findings.push(line.producto + " · Kilos distintos ("+line.kilos_netos+" / "+kilos+").");
    if (number(line.precio) && !rows.some(({data:x}) => (x.priceCents != null || x.price != null)
      && Math.abs(line.precio-(x.priceCents != null ? x.priceCents/100 : Number(x.price)))<0.00001)) {
      findings.push(line.producto + " · Precio distinto o pendiente.");
    }
  }
  return findings;
}

export function installOperations({ connection, refresh, date, formatPallets }) {
  let galleryRows = [];
  let invoiceRows = [];
  let invoicePage = null;
  let invoiceOwner = "";
  let target = "";
  let fetching = false;
  let importing = false;
  let invoiceError = "";
  let commissionKey = "";
  const state = connection;
  const roleOwner = () => state().role === "owner" && !state().user?.is_anonymous;
  const scope = () => (state().workspace ?? "") + ":" + (state().user?.id ?? "");
  function setTarget(id) { target = id; }

  async function loadGallery() {
    const context = scope();
    const {api,workspace} = state();
    if (!workspace) return;
    const result = await api.from("sg10_gallery").select("*").eq("workspace_id",workspace).order("updated_at",{ascending:false}).limit(200);
    if (context !== scope()) return;
    if (result.error) {
      const status = document.getElementById("sg10GalleryStatus");
      if (status) status.textContent = result.error.message;
      return;
    }
    galleryRows = result.data;
    const list = document.getElementById("sg10GalleryList");
    if (!list) return;
    list.innerHTML = galleryRows.map(row => '<div class="item" data-item="' + esc(row.id) + '"><b>' + esc(row.product)
      + '</b><p>' + esc(row.description) + ' · ' + esc(row.price == null ? "Sin precio" : formatting.format(row.price) + "/" + row.unit)
      + '</p><p>' + esc(row.client_id ? state().records.clients.find(c => c.id === row.client_id)?.data.name : "Todos los clientes")
      + '</p><button onclick="sg10Ops(\'editPhoto\',this.closest(\'[data-item]\').dataset.item)">Editar</button> '
      + '<button class="danger" onclick="sg10Ops(\'removePhoto\',this.closest(\'[data-item]\').dataset.item)">Eliminar</button></div>').join("")
      || "<p>Sin publicaciones.</p>";
    if (target) list.querySelector('[data-item="' + CSS.escape(target) + '"]')?.classList.add("sg10-highlight");
  }

  function galleryView() {
    return '<div class="card"><h2>Galería de productos</h2><button onclick="sg10Ops(\'editPhoto\')">Publicar fotografía</button>'
      + '<p id="sg10GalleryStatus" role="status"></p><div id="sg10GalleryList"></div></div>';
  }

  function photoForm(id) {
    const existing = galleryRows.find(row => row.id === id);
    const dialog = openDialog(existing ? "Editar publicación" : "Publicar fotografía");
    const content = dialog.querySelector("[data-content]");
    const clientOptions = renderOptions(state().records.clients,existing?.client_id);
    content.innerHTML = '<form><label>Producto <input name="product" required maxlength="120" value="' + esc(existing?.product)
      + '"></label><label>Descripción y observaciones <textarea name="description" maxlength="1000">' + esc(existing?.description)
      + '</textarea></label><label>Precio opcional <input name="price" inputmode="decimal" value="' + esc(existing?.price)
      + '"></label><label>Unidad <select name="unit"><option value="">Seleccionar</option><option>kg</option><option>caja</option><option>palé</option><option>unidad</option></select></label>'
      + '<label>Visibilidad <select name="clients"' + (existing ? '' : ' multiple size="4"') + '><option value=""'
      + (!existing?.client_id ? ' selected' : '') + '>Todos los clientes</option>' + clientOptions
      + '</select></label><label>Foto JPEG, PNG o WebP <input name="image" type="file" accept="image/jpeg,image/png,image/webp" '
      + (!existing ? "required" : "") + '></label><button>Guardar publicación</button><p role="status"></p></form>';
    const form = content.querySelector("form");
    form.elements.unit.value = existing?.unit ?? "";
    const started = scope();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (started !== scope()) return;
      const {api,workspace} = state();
      const get = (key) => form.elements[key].value.trim();
      const raw = get("price");
      const price = raw ? validNumber(raw) : null;
      const unit = price == null ? null : get("unit");
      const file = form.elements.image.files[0];
      const selected = [...form.elements.clients.selectedOptions].map(option => option.value);
      const companyIds = selected.includes("") || !selected.length ? [null] : selected;
      const feedback = form.querySelector("[role=status]");
      if ((raw && (!Number.isFinite(price) || !unit || !/^\d+(?:[.,]\d{1,2})?$/.test(raw))) || !get("product")) {
        return feedback.textContent = "Revisa nombre, precio y unidad.";
      }
      if (file && (file.size>5_242_880 || !["image/webp","image/jpeg","image/png"].includes(file.type))) {
        return feedback.textContent = "Selecciona una fotografía JPEG, PNG o WebP de hasta 5 MB.";
      }
      let path = existing?.image_path;
      let uploaded = false;
      event.submitter.disabled = true;
      try {
        if (file) {
          path = workspace + "/" + crypto.randomUUID() + "." + file.type.split("/")[1];
          const upload = await api.storage.from("sg10-productos").upload(path,file,{contentType:file.type,upsert:false});
          if (upload.error) throw upload.error;
          uploaded = true;
        }
        const fields = {workspace_id:workspace,product:get("product"),description:get("description"),image_path:path,
          price,unit,updated_at:new Date().toISOString()};
        const response = existing
          ? await api.from("sg10_gallery").update({...fields,client_id:companyIds[0]}).eq("workspace_id",workspace).eq("id",existing.id)
            .eq("updated_at",existing.updated_at).select("id")
          : await api.from("sg10_gallery").insert(companyIds.map(client_id => ({...fields,client_id}))).select("id");
        if (response.error || !response.data?.length) throw response.error ?? Error("La publicación ha cambiado. Recarga y revisa.");
        uploaded = false;
        if (existing && path !== existing.image_path) await removeOrphan(api,workspace,existing.image_path);
        dialog.close();
        await loadGallery();
      } catch (error) {
        if (uploaded) await removeOrphan(api,workspace,path);
        feedback.textContent = error.message;
      } finally { event.submitter.disabled = false; }
    };
  }

  async function removeOrphan(api,workspace,path) {
    const references = await api.from("sg10_gallery").select("id",{count:"exact",head:true}).eq("workspace_id",workspace).eq("image_path",path);
    if (!references.error && references.count === 0) await api.storage.from("sg10-productos").remove([path]);
  }
  async function removePhoto(id) {
    const row = galleryRows.find(row => row.id === id);
    if (!row || !confirm("¿Eliminar esta publicación?")) return;
    const {api,workspace} = state();
    const result = await api.from("sg10_gallery").delete().eq("workspace_id",workspace).eq("id",id).eq("updated_at",row.updated_at).select("id");
    if (result.error || !result.data?.length) throw result.error ?? Error("La publicación cambió.");
    await removeOrphan(api,workspace,row.image_path);
    await loadGallery();
  }

  function cameraForm() {
    const dialog = openDialog("Recuento de mercancía con cámara");
    const {records} = state();
    const context = scope();
    const content = dialog.querySelector("[data-content]");
    content.innerHTML = '<form><label>Cliente <select name="company" required><option value="">Seleccionar</option>'
      + renderOptions(records.clients) + '</select></label><label>Fecha <input name="date" type="date" required value="' + esc(date())
      + '"></label><label>Material a contar <select name="kind"><option>cajas</option><option>bultos</option><option value="pales">palés</option></select></label>'
      + '<label>Foto <input name="photo" type="file" accept="image/*" capture="environment" required></label>'
      + '<button type="button" data-analyze>Analizar foto</button><p data-vision role="status"></p>'
      + '<label>Etiqueta o código <input name="labels" maxlength="300"></label>'
      + '<label>Esperado (confirmable) <input name="expected" inputmode="decimal"></label>'
      + '<label>Recuento verificado <input name="counted" inputmode="decimal" required></label>'
      + '<p data-difference></p><button>Confirmar y guardar recuento</button><p data-save role="status"></p></form>';
    const form = content.querySelector("form");
    let hash, analyzedFile;
    const values = form.elements;
    async function expectedCount() {
      const client = values.company.value, day = values.date.value, kind = values.kind.value;
      if (kind === "pales") {
        const {api,workspace} = state();
        const result = await api.from("sg_pallets").select("data").eq("workspace_id",workspace).eq("data->>clientId",client).eq("data->>date",day);
        if (result.error) throw result.error;
        return result.data.reduce((n,{data}) => n + (data.size === "half" ? .5 : 1),0);
      }
      return state().records.orders.filter(({data}) => data.clientId === client && data.date === day
        && data.quantityUnit !== "pales" && !["Cancelado","Anulado"].includes(data.status))
        .reduce((n,{data}) => n+(Number(data.boxes)||0),0);
    }
    function compare() {
      const a=validNumber(values.expected.value), b=validNumber(values.counted.value);
      const difference=form.querySelector("[data-difference]");
      difference.textContent = Number.isFinite(a) && Number.isFinite(b)
        ? a===b ? "Coincide con el esperado." : Math.abs(a-b) + (a>b ? " faltantes." : " sobrantes.") : "";
    }
    form.oninput=compare;
    values.photo.onchange=() => { hash=null; analyzedFile=null; values.labels.value=""; values.counted.value=""; compare(); };
    form.querySelector("[data-analyze]").onclick=async ({currentTarget:button}) => {
      const photo=values.photo.files[0];
      const feedback=form.querySelector("[data-vision]");
      if (!photo || photo.size>16_000_000) return feedback.textContent="Elige una foto de hasta 16 MB.";
      button.disabled=true;
      feedback.textContent="Analizando…";
      try {
        const bitmap=await createImageBitmap(photo);
        try {
          const canvas=document.createElement("canvas");
          const factor=Math.min(1,1280/Math.max(bitmap.width,bitmap.height));
          canvas.width=Math.max(1,Math.round(bitmap.width*factor)); canvas.height=Math.max(1,Math.round(bitmap.height*factor));
          canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);
          const {api,workspace}=state();
          const barcode = "BarcodeDetector" in window
            ? new BarcodeDetector().detect(bitmap).catch(() => []) : Promise.resolve([]);
          const result = await invoke(api,"sg10-aguacatin",{workspace,mode:"imagen",text:values.kind.value,image:canvas.toDataURL("image/jpeg",.8)});
          if (photo !== values.photo.files[0] || context!==scope()) return;
          const labels=await barcode;
          hash=await digest(photo);
          analyzedFile=photo;
          values.labels.value=[...new Set([...labels.map(label=>label.rawValue),...(Array.isArray(result.etiquetas)?result.etiquetas:[])])]
            .join(", ").slice(0,300);
          feedback.textContent=result.respuesta+" Comprueba la imagen e introduce el recuento verificado.";
          if (values.company.value && !values.expected.value) values.expected.value=await expectedCount();
          compare();
        } finally { bitmap.close(); }
      } catch(error) { feedback.textContent=error.message+" Puedes introducir el recuento manualmente."; }
      finally { button.disabled=false; }
    };
    form.onsubmit=async(event)=>{
      event.preventDefault();
      if (context!==scope()) return;
      const photo=values.photo.files[0];
      const measured=validNumber(values.counted.value);
      const expected=validNumber(values.expected.value);
      const message=form.querySelector("[data-save]");
      if (!photo || photo.size>16_000_000 || !Number.isFinite(measured)) return message.textContent="Revisa la foto y la cantidad verificada.";
      event.submitter.disabled=true;
      try {
        const {api,workspace}=state();
        hash=analyzedFile===photo&&hash?hash:await digest(photo);
        const {error}=await api.from("sg10_camera_counts").insert({workspace_id:workspace,client_id:values.company.value,day:values.date.value,kind:values.kind.value,
          measured,expected:Number.isFinite(expected)?expected:null,image_hash:hash,barcode_labels:[...new Set(values.labels.value.split(",").map(x=>x.trim()).filter(Boolean))]});
        if (error?.code==="23505") throw Error("Esta misma fotografía ya tiene un recuento confirmado para este cliente y fecha.");
        if (error) throw error;
        message.textContent="Recuento verificado y registrado.";
      } catch(error) { message.textContent=error.message; }
      finally { event.submitter.disabled=false; }
    };
  }

  function invoiceView() {
    return '<div class="card"><h2>Facturas de Gmail</h2><div class="sg10-tools">'
      + (roleOwner() ? '<button onclick="sg10Ops(\'importInvoices\',this)">Leer siguiente lote de Gmail</button>' : '')
      + '<button onclick="sg10Ops(\'loadInvoices\')">Actualizar historial</button></div><p id="sg10InvoiceStatus" role="status">'
      + esc(invoiceError) + '</p><div id="sg10InvoiceBalances"></div><div id="sg10InvoiceList"></div></div>';
  }
  async function loadInvoices() {
    const context=scope();
    if (invoiceOwner!==context) { invoiceOwner=context; invoiceRows=[]; invoicePage=null; invoiceError=""; }
    const {api,workspace,records}=state();
    const [documents,balances]=await Promise.all([
      api.from("sg_invoices").select("*").eq("workspace_id",workspace).order("created_at",{ascending:false}).limit(250),
      api.from("sg10_invoice_balances").select("id,invoice_number,customer_name,day,gross,credit,net").eq("workspace_id",workspace)
        .gt("credit",0).order("day",{ascending:false}).limit(50),
    ]);
    if (context!==scope()) return;
    if (documents.error || balances.error) throw documents.error ?? balances.error;
    invoiceRows=documents.data;
    const summary=document.getElementById("sg10InvoiceBalances");
    if(summary)summary.innerHTML=balances.data.length?'<h3>Facturas con abonos descontados</h3>'+balances.data.map(row=>
      '<p>'+esc(row.customer_name)+' · '+esc(row.invoice_number)+' · '+esc(formatting.format(row.gross))
      +' − '+esc(formatting.format(row.credit))+' = <strong>'+esc(formatting.format(row.net))+'</strong></p>').join(""):"";
    const list=document.getElementById("sg10InvoiceList");
    if (!list) return;
    list.innerHTML=invoiceRows.map(row=>{
      const findings=compareInvoice(row,records.purchases,records.orders);
      const x=row.invoice_data;
      return '<div class="item" data-invoice="' + esc(row.id) + '"><b>' + (x.tipo==="abono" ? "Abono · " : "")+esc(row.invoice_number || "Sin número")
        + '</b> · ' + esc(row.customer_name || "Cliente por identificar") + '<p>' + esc(x.fecha) + ' · ' + esc(x.proveedor)
        + ' · ' + esc(row.approved_at ? "Aprobada" : "Pendiente de revisión") + '</p><p>' + esc(x.total==null ? "Sin importe" : formatting.format(x.total))
        + '</p>' + (findings.length ? '<ul>' + findings.map(item=>'<li>'+esc(item)+'</li>').join("")+'</ul>' : '<p>Sin discrepancias en los datos comparables.</p>')
        + '<button onclick="sg10Ops(\'reviewInvoice\',this.closest(\'[data-invoice]\').dataset.invoice)">Ver'
        + (roleOwner() ? ' y revisar' : '') + '</button></div>';
    }).join("") || "<p>Sin facturas guardadas.</p>";
    const open=target&&list.querySelector('[data-invoice="'+CSS.escape(target)+'"]');
    if(open) { open.classList.add("sg10-highlight");open.scrollIntoView({block:"center"});target=""; }
  }

  async function importInvoices(button) {
    if (!roleOwner() || importing) return;
    importing=true;
    button.disabled=true;
    const context=scope();
    const feedback=document.getElementById("sg10InvoiceStatus");
    const {api,workspace,records}=state();
    feedback.textContent="Leyendo y extrayendo el siguiente lote de Gmail…";
    try {
      const response=await invoke(api,"sg-gmail-facturas",{pageToken:invoicePage});
      if (context!==scope()) return;
      let inserted=0, duplicates=0;
      const errors=[];
      for(const item of response.documentos??[]) {
        if(!/^[a-f0-9]{64}$/.test(item.hash)||!item.documento||typeof item.documento!=="object") continue;
        const doc=item.documento;
        if(!["factura","abono"].includes(doc.tipo)) continue;
        const {error}=await api.from("sg_invoices").insert({workspace_id:workspace,invoice_number:doc.numero||null,customer_name:doc.cliente||"",
          invoice_data:{...doc,archivo:String(item.archivo??"").slice(0,180),client_id:findCompany(doc,records.clients),visible_cliente:false},
          sg10_pdf_hash:item.hash,sg10_fiscal_key:invoiceKey(doc)});
        if(error?.code==="23505") duplicates++;
        else if(error) errors.push(error.message);
        else inserted++;
      }
      if(!errors.length) invoicePage=response.siguiente??null;
      const extraction=(response.errores??[]).map(item=>String(item.archivo??"")+" "+String(item.error??"")).slice(0,5);
      invoiceError=inserted+" guardadas · "+duplicates+" duplicadas"+(invoicePage ? " · Quedan correos por revisar." : "")
        + (errors.length+extraction.length ? " · "+[...errors,...extraction].join(" · ") : "");
      feedback.textContent=invoiceError;
      await loadInvoices();
    }catch(error){feedback.textContent=invoiceError=error.message;}
    finally{importing=false;button.disabled=false;}
  }

  async function showInvoicePdf(row, section, dialog) {
    const notice = section.querySelector("[data-original-status]");
    if (!/^[0-9a-f]{64}$/.test(row.sg10_pdf_hash ?? "")) {
      notice.textContent = "El PDF original no está disponible para esta factura.";
      return;
    }
    const { api, workspace } = state();
    const storage = api.storage.from("sg10-facturas-originales");
    const { data, error } = await storage.createSignedUrl(workspace + "/" + row.sg10_pdf_hash + ".pdf", 300);
    if (!dialog.open) return;
    if (error || !data?.signedUrl) {
      notice.textContent = "El PDF original de esta factura todavía no está disponible.";
      return;
    }
    const source = document.createElement("a");
    source.href = data.signedUrl;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "Abrir PDF original";
    section.append(source);
    let documentTask;
    dialog.addEventListener("close", () => { documentTask?.destroy().catch(() => {}); }, {once:true});
    try {
      const cdn = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
      const pdfjs = await import(cdn + "pdf.mjs");
      if (!dialog.open) return;
      pdfjs.GlobalWorkerOptions.workerSrc = cdn + "pdf.worker.mjs";
      documentTask = pdfjs.getDocument({ url:data.signedUrl, isEvalSupported:false, enableXfa:false });
      const pdf = await documentTask.promise;
      if (!dialog.open) return;
      const canvas = section.querySelector("canvas");
      const controls = section.querySelector("[data-pdf-controls]");
      const previous = controls.querySelector("[data-prev]");
      const next = controls.querySelector("[data-next]");
      let current = 1;
      async function renderPage(number) {
        previous.disabled = next.disabled = true;
        try {
          const page = await pdf.getPage(number);
          if (!dialog.open) return;
          const width = Math.max(200, section.clientWidth - 4);
          const resolution = Math.min(devicePixelRatio || 1, 2);
          const viewport = page.getViewport({scale: Math.min(width / page.getViewport({scale:1}).width, 1.6) * resolution});
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
          current = number;
          notice.textContent = "Página " + number + " de " + pdf.numPages;
          canvas.hidden = false;
        } finally {
          previous.disabled = current <= 1;
          next.disabled = current >= pdf.numPages;
        }
      }
      const show = (number) => renderPage(number).catch(() => {
        if(dialog.open) notice.textContent = "No se pudo mostrar la página. Abre el PDF original.";
      });
      previous.onclick = () => show(current - 1);
      next.onclick = () => show(current + 1);
      controls.hidden = pdf.numPages < 2;
      await show(1);
    } catch {
      if (dialog.open) notice.textContent = "La vista previa no está disponible. Puedes abrir el PDF original.";
    }
  }

  function invoiceObservationBox(row, editable) {
    const box = document.createElement("section");
    box.className = "sg10-invoice-observations";
    box.innerHTML = '<h3>Observaciones</h3><textarea aria-label="Observaciones" rows="3" maxlength="2000" placeholder="Añadir observaciones…"></textarea>';
    const field = box.querySelector("textarea");
    field.value = row.invoice_data.observaciones ?? "";
    field.readOnly = !editable;
    const findings = compareInvoice(row, state().records.purchases, state().records.orders);
    if (findings.length) {
      const list = document.createElement("ul");
      for (const finding of findings) {
        const item = document.createElement("li");
        item.textContent = finding;
        list.append(item);
      }
      box.append(list);
    }
    if(editable){
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Guardar observaciones";
      const feedback = document.createElement("p");
      feedback.setAttribute("role","status");
      save.onclick=async()=>{
        const notes = field.value.trim();
        save.disabled=true;
        try {
          const {api,workspace}=state();
          const {data,error}=await api.rpc("sg10_save_invoice_observations",{
            p_workspace:workspace,p_invoice:row.id,p_notes:notes,p_previous:row.invoice_data.observaciones??"",
          });
          if(error||!data)throw error??Error("Las observaciones cambiaron. Vuelve a abrir la factura.");
          row.invoice_data.observaciones=notes;
          feedback.textContent="Observaciones guardadas.";
        }catch(error){feedback.textContent=error.message;}
        finally{save.disabled=false;}
      };
      box.append(save,feedback);
    }
    return box;
  }

  function reviewInvoice(id) {
    const row=invoiceRows.find(item=>item.id===id);
    if(!row)return;
    const x=row.invoice_data;
    const editable=roleOwner(), context=scope();
    const dialog=openDialog("Revisión de factura");
    const form=document.createElement("form");
    const lines=Array.isArray(x.lineas)?x.lineas:[];
    const candidates=invoiceRows.filter(item=>item.id!==id&&item.approved_at&&item.invoice_data.tipo==="factura");
    const suggested=candidates.filter(item=>normalized(item.invoice_number)===normalized(x.numero_original)
      && normalized(item.invoice_data.cif_proveedor)===normalized(x.cif_proveedor)&&item.invoice_data.client_id===x.client_id);
    const original=row.sg10_original_id??(suggested.length===1?suggested[0].id:null);
    const selector=x.tipo==="abono"?'<label>Factura original <select name="original"><option value="">Seleccionar factura aprobada</option>'
      +candidates.map(item=>'<option value="'+esc(item.id)+'"'+(item.id===original?' selected':'')+'>'
      +esc([item.invoice_number,item.customer_name,item.invoice_data.fecha,item.invoice_data.proveedor].join(" · "))+'</option>').join("")
      +'</select></label>':"";
    form.innerHTML='<label>Empresa <select name="company"><option value="">Seleccionar</option>'+renderOptions(state().records.clients,x.client_id)+'</select></label>'
      + selector + '<div class="grid"><label>Número <input name="invoice" value="'+esc(row.invoice_number)+'"></label>'
      + '<label>Fecha <input name="day" type="date" value="'+esc(x.fecha)+'"></label>'
      + '<label>Asentador <input name="supplier" value="'+esc(x.proveedor)+'"></label>'
      + '<label>CIF del asentador <input name="tax" value="'+esc(x.cif_proveedor)+'"></label>'
      + '<label>Importe <input name="total" inputmode="decimal" value="'+esc(x.total)+'"></label></div>'
      + lines.map(line=>'<fieldset><label>Producto <input name="product" value="'+esc(line.producto)+'"></label>'
        + '<div class="grid"><label>Bultos <input name="boxes" inputmode="decimal" value="'+esc(line.cajas)+'"></label>'
        + '<label>Kilos <input name="kg" inputmode="decimal" value="'+esc(line.kilos_netos)+'"></label>'
        + '<label>Precio <input name="price" inputmode="decimal" value="'+esc(line.precio)+'"></label></div></fieldset>').join("")
      + (editable?'<label class="sg10-check"><input type="checkbox" name="visible"'+(x.visible_cliente?" checked":"")+'> Publicar para la empresa al aprobar</label>'
        + '<button name="mode" value="save">Guardar correcciones</button> <button name="mode" value="approve">Aprobar</button>'
        + '<p data-review role="status"></p>':'');
    const content = dialog.querySelector("[data-content]");
    const originalPdf = document.createElement("section");
    originalPdf.className = "sg10-invoice-pdf";
    originalPdf.innerHTML = '<div role="status" data-original-status>Cargando PDF original…</div>'
      + '<canvas aria-label="Imagen de la factura original" hidden></canvas>'
      + '<div data-pdf-controls class="sg10-tools" hidden><button type="button" data-prev>Página anterior</button>'
      + '<button type="button" data-next>Página siguiente</button></div>';
    const fields = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = editable ? "Revisar o corregir los datos extraídos" : "Ver los datos extraídos";
    fields.append(summary,form);
    content.append(originalPdf,invoiceObservationBox(row,editable),fields);
    void showInvoicePdf(row,originalPdf,dialog).catch(() => {
      originalPdf.querySelector("[data-original-status]").textContent = "No se pudo cargar el PDF original.";
    });
    if(!editable) { for(const field of form.elements)field.disabled=true;return; }
    form.onsubmit=async(event)=>{
      event.preventDefault();
      if(context!==scope()||!roleOwner())return;
      const feedback=form.querySelector("[data-review]");
      const value=(key)=>form.elements[key].value.trim();
      let total;
      const decimal=(input)=>{
        const raw=input.trim();
        if(!raw)return null;
        const result=Number(raw.replace(",","."));
        if(!/^-?\d+(?:[,.]\d{1,4})?$/.test(raw)||!Number.isFinite(result))throw Error("Usa números válidos en las líneas y el importe.");
        return result;
      };
      let edited;
      try {
        total=decimal(value("total"));
        edited=[...form.querySelectorAll("fieldset")].map(field=>{
          const get=(name)=>field.querySelector('[name="'+name+'"]').value;
          return {producto:get("product").trim(),cajas:decimal(get("boxes")),kilos_netos:decimal(get("kg")),precio:decimal(get("price"))};
        });
      }catch(error){return feedback.textContent=error.message;}
      const company=state().records.clients.find(c=>c.id===value("company"));
      const doc={...x,client_id:company?.id??null,cliente:company?.data.name??x.cliente,
        proveedor:value("supplier"),cif_proveedor:value("tax"),numero:value("invoice"),fecha:value("day"),total,lineas:edited};
      const approve=event.submitter.value==="approve";
      if(approve&&(!company||!invoiceKey(doc)||!edited.length||edited.some(line=>!line.producto)||!number(total)))
        return feedback.textContent="Antes de aprobar verifica empresa, número, fecha, CIF, importe y líneas.";
      const originalId=form.elements.original?.value||null;
      if(approve&&doc.tipo==="abono"&&!originalId)return feedback.textContent="Selecciona primero la factura original.";
      const findings=compareInvoice({...row,sg10_original_id:originalId,invoice_data:doc},state().records.purchases,state().records.orders);
      if(approve&&!confirm((findings.length ? findings.join("\n")+"\n\n":"")+"¿Confirmas la aprobación tras revisar los datos?"))return;
      const fields={invoice_number:doc.numero||null,customer_name:doc.cliente||"",sg10_fiscal_key:invoiceKey(doc),
        invoice_data:{...doc,visible_cliente:approve&&form.elements.visible.checked},original_id:originalId,
        status:approve?"approved":"pending",approved_by:approve?state().user.id:null,approved_at:approve?new Date().toISOString():null};
      event.submitter.disabled=true;
      try {
        const {data,error}=await state().api.rpc("sg10_invoice_review",{space:state().workspace,invoice_id:id,
          old_data:row.invoice_data,old_status:row.status,fields});
        if(error||!data)throw error??Error("La factura cambió. Abre la versión actual antes de revisar.");
        dialog.close();
        await loadInvoices();
      }catch(error){feedback.textContent=error.message;}
      finally{event.submitter.disabled=false;}
    };
  }

  function settingsView() {
    return '<div class="card"><h2>Zona Clientes</h2><div class="sg10-tools"><a class="secondary" href="./portal.html">Abrir Zona Clientes</a>'
      + '<button onclick="go(\'galeria\')">Gestionar fotografías</button>'
      + (roleOwner()?'<button onclick="sg10Ops(\'clients\')">Gestionar accesos por empresa</button><button onclick="sg10Ops(\'rules\')">Tarifas y pesos fijos</button>':'')
      + '</div></div>';
  }
  function clientForm() {
    if(!roleOwner())return;
    const dialog=openDialog("Accesos de la empresa");
    const content=dialog.querySelector("[data-content]");
    content.innerHTML='<form><label>Empresa <select name="company" required><option value="">Seleccionar</option>'+renderOptions(state().records.clients)
      + '</select></label><label>Correo individual <input name="email" type="email" required></label><button>Invitar por correo</button> '
      + '<button type="button" data-whatsapp>Invitar por WhatsApp</button> <button type="button" data-preview>Ver como cliente</button></form>'
      + '<p data-status role="status"></p><div data-members></div>';
    const form=content.querySelector("form");
    const message=content.querySelector("[data-status]");
    const members=content.querySelector("[data-members]");
    const access=(action,additional={})=>invoke(state().api,"sg10-client-admin",{workspace_id:state().workspace,
      client_id:form.elements.company.value,action,...additional});
    async function membersList(){
      const company=form.elements.company.value;
      members.replaceChildren();
      if(!company)return;
      try{
        const {users}=await access("list");
        if(form.elements.company.value!==company)return;
        for(const record of users){
          const line=document.createElement("p");
          line.textContent=(record.email??"Cuenta sin correo")+" ";
          const remove=document.createElement("button");
          remove.type="button";remove.textContent="Quitar acceso";remove.className="danger";
          remove.onclick=async()=>{
            if(form.elements.company.value!==company||!confirm("¿Quitar a esta persona el acceso a la empresa?"))return;
            try{await access("remove",{user_id:record.user_id});await membersList();}catch(error){message.textContent=error.message;}
          };
          line.append(remove);members.append(line);
        }
      }catch(error){message.textContent=error.message;}
    }
    form.elements.company.onchange=()=>{
      message.textContent="";
      void membersList();
    };
    form.querySelector("[data-whatsapp]").onclick=async ({currentTarget:button})=>{
      if(!form.reportValidity())return;
      const {api,workspace}=state();
      const company=form.elements.company.value;
      button.disabled=true;
      try{await prepareWhatsAppInvite(api,workspace,form.elements.email.value.trim(),company,message);}
      catch(error){message.textContent=error.message;}
      finally{button.disabled=false;}
    };
    form.querySelector("[data-preview]").onclick=()=>{
      if(!form.elements.company.reportValidity())return;
      const target=new URL("./portal.html",location.href);
      target.searchParams.set("vista",form.elements.company.value);
      target.searchParams.set("empresa",state().workspace);
      window.open(target.href,"_blank","noopener");
    };

    form.onsubmit=async event=>{
      event.preventDefault();
      const email=form.elements.email.value.trim();
      if(!confirm("¿Autorizar el acceso de "+email+" a la empresa seleccionada?"))return;
      event.submitter.disabled=true;form.elements.company.disabled=true;
      try{
        const result=await access("invite",{email});
        message.textContent=result.invited?"Invitación enviada.":"Cuenta vinculada a esta empresa.";
        form.elements.email.value="";
        await membersList();
      }catch(error){message.textContent=error.message;}
      finally{event.submitter.disabled=false;form.elements.company.disabled=false;}
    };
  }

  function ruleForm() {
    if(!roleOwner())return;
    const {records}=state();
    const dialog=openDialog("Tarifas y pesos fijos por producto");
    const content=dialog.querySelector("[data-content]");
    content.innerHTML='<form><label>Cliente <select name="company" required><option value="">Seleccionar</option>'+renderOptions(records.clients)
      + '</select></label><div data-rules></div><button type="button" data-add>Añadir regla</button> <button>Guardar reglas</button><p role="status"></p></form>';
    const form=content.querySelector("form");
    const rules=form.querySelector("[data-rules]");
    const feedback=form.querySelector("[role=status]");
    let stamp;
    const add=(row={})=>{
      const element=document.createElement("fieldset");
      element.innerHTML='<label>Producto (nombre exacto)<input name="product" required maxlength="120" value="'+esc(row.product)
        + '"></label><label>Tarifa €/kg <input name="rate" inputmode="decimal" value="'+esc(row.rate)
        + '"></label><label>Kg fijos por caja <input name="weight" inputmode="decimal" value="'+esc(row.weight)
        + '"></label><button type="button">Quitar regla</button>';
      element.querySelector("button").onclick=()=>element.remove();rules.append(element);
    };
    form.querySelector("[data-add]").onclick=()=>add();
    form.elements.company.onchange=()=>{
      rules.replaceChildren();feedback.textContent="";
      const row=records.clients.find(row=>row.id===form.elements.company.value);
      stamp=row?.updated_at;
      (row?.data.sg10Rules??[]).forEach(add);
    };
    form.onsubmit=async event=>{
      event.preventDefault();
      const {api,workspace,records}=state();
      const id=form.elements.company.value;
      const row=records.clients.find(row=>row.id===id);
      if(!row||!stamp)return;
      const list=[...rules.querySelectorAll("fieldset")].map(field=>{
        const get=(key)=>field.querySelector('[name="'+key+'"]').value.trim();
        return {product:get("product"),rate:get("rate")?validNumber(get("rate")):null,weight:get("weight")?validNumber(get("weight")):null};
      });
      if(list.some(item=>!item.product||(item.rate===null&&item.weight===null)||(item.rate!==null&&(!number(item.rate)||item.rate>9))
        ||(item.weight!==null&&(!number(item.weight)||item.weight<=0)))||new Set(list.map(item=>canonicalProduct(item.product))).size!==list.length)
        return feedback.textContent="Revisa los valores y deja una sola regla por producto.";
      event.submitter.disabled=true;
      try{
        const {data,error}=await api.from("sg_clients").update({data:{...row.data,sg10Rules:list}}).eq("workspace_id",workspace).eq("id",id)
          .eq("updated_at",stamp).select("id,data,updated_at");
        if(error||!data?.length)throw error??Error("El cliente cambió. Vuelve a abrirlo.");
        Object.assign(row,data[0]);stamp=row.updated_at;
        feedback.textContent="Reglas sincronizadas.";
      }catch(error){feedback.textContent=error.message;}
      finally{event.submitter.disabled=false;}
    };
  }

  function configureRate(client,product) {
    const rows=state().records.clients.filter(({data})=>normalized(data.name)===normalized(client));
    if(rows.length!==1 || /\bcotelo\b/.test(normalized(client)))return null;
    return (rows[0].data.sg10Rules??[]).find(item=>canonicalProduct(item.product)===canonicalProduct(product))?.rate??null;
  }
  function splitPurchase(orderId) {
    const {records,api,workspace}=state();
    const order=records.orders.find(row=>row.id===orderId);
    if(!order||order.data.quantityUnit!=="pales"||["Cancelado","Anulado"].includes(order.data.status))
      return toast("Selecciona un pedido activo en palés.");
    const used=records.purchases.filter(row=>row.data.orderId===orderId&&!["Anulado","Cancelado"].includes(row.data.status))
      .reduce((total,row)=>total+(Number(row.data.sgBoughtPallets)||0),0);
    const pending=Math.max(0,Number(order.data.boxes)-used);
    if(pending<=0)return toast("Este pedido ya tiene todos sus palés asignados.");
    const dialog=openDialog("Repartir entre puestos");
    const root=dialog.querySelector("[data-content]");
    const context=scope();
    root.innerHTML='<p><b>'+esc([order.data.product,order.data.variety].filter(Boolean).join(" "))+'</b> · Pendientes: '
      +esc(formatPallets(pending))+' palés</p><form><div data-lines></div><button type="button" data-add>Añadir puesto</button> '
      +'<button>Guardar este reparto</button><p role="status"></p></form>';
    const form=root.querySelector("form");
    const lines=form.querySelector("[data-lines]");
    const feedback=form.querySelector("[role=status]");
    let request=crypto.randomUUID();
    form.oninput=()=>{request=crypto.randomUUID();};
    function add(){
      if(lines.children.length>=12)return;
      const row=document.createElement("fieldset");
      row.innerHTML='<legend>Puesto</legend><label>Nombre <input name="supplier" required maxlength="160"></label>'
        +'<div class="grid"><label>Palés <input name="amount" required placeholder="Ej. 1, ½, 2½"></label>'
        +'<label>Bultos reales <input name="boxes" inputmode="decimal"></label><label>Kilos netos <input name="kg" inputmode="decimal"></label>'
        +'<label>Precio <input name="price" inputmode="decimal"></label><label>Unidad del precio <select name="unit"><option value="kg">€/kg</option>'
        +'<option value="caja">€/caja</option><option value="pale">€/palé</option></select></label></div>'
        +'<button type="button" data-half>½ palé</button> <button type="button" data-remove>Quitar puesto</button>';
      row.querySelector("[data-half]").onclick=()=>{
        row.querySelector('[name="amount"]').value="½";request=crypto.randomUUID();
      };
      row.querySelector("[data-remove]").onclick=()=>{row.remove();request=crypto.randomUUID();};
      lines.append(row);request=crypto.randomUUID();
    }
    add();add();form.querySelector("[data-add]").onclick=add;
    form.onsubmit=async event=>{
      event.preventDefault();
      if(context!==scope())return;
      const payload=[...lines.children].map(row=>{
        const get=key=>row.querySelector('[name="'+key+'"]').value.trim();
        return {supplier:get("supplier"),amount:readPallets(get("amount")),boxes:get("boxes")?validNumber(get("boxes")):null,
          kg:get("kg")?validNumber(get("kg")):null,price:get("price")&&/^\d+(?:[.,]\d{1,2})?$/.test(get("price"))?validNumber(get("price")):get("price")?NaN:null,
          priceUnit:get("unit")};
      });
      if(payload.length<2||payload.some(row=>!row.supplier||!number(row.amount)||[row.boxes,row.kg,row.price].some(Number.isNaN)))
        return feedback.textContent="Introduce al menos dos puestos y cantidades válidas en palés completos o medios.";
      if(new Set(payload.map(row=>normalized(row.supplier))).size!==payload.length)
        return feedback.textContent="Agrupa en una sola línea las compras del mismo puesto.";
      if(payload.reduce((sum,row)=>sum+row.amount,0)>pending)return feedback.textContent="El reparto supera los palés pendientes.";
      event.submitter.disabled=true;
      try{
        const {error}=await api.rpc("sg10_split_purchase",{space:workspace,order_id:orderId,request,lines:payload});
        if(error)throw error;
        await sync(true);dialog.close();refresh();toast("Compras guardadas por puesto.");
      }catch(error){feedback.textContent=error.message;}
      finally{event.submitter.disabled=false;}
    };
  }

  function appendSplitControl(field) {
    if (!field) return;
    const action=()=>splitPurchase(document.getElementById("pOrder")?.value);
    const button=document.createElement("button");
    button.type="button";button.className="secondary";button.textContent="Repartir entre puestos";
    button.onclick=action;field.after(button);
    let timer,initialX,initialY;
    field.addEventListener("pointerdown",event=>{
      if(event.button!==0)return;
      clearTimeout(timer);initialX=event.clientX;initialY=event.clientY;
      timer=setTimeout(()=>{field.blur();action();},600);
    });
    field.addEventListener("pointermove",event=>{
      if(Math.hypot(event.clientX-initialX,event.clientY-initialY)>12)clearTimeout(timer);
    });
    for(const name of ["pointercancel","pointerleave","pointerup","blur"])field.addEventListener(name,()=>clearTimeout(timer));
  }
  function decoratePurchase() {
    const input=document.getElementById("pPrice");
    if (document.getElementById("sg10Tara")) return;
    appendSplitControl(document.getElementById("pSupplier"));
    const tara=document.createElement("label");
    const iva=document.createElement("label");
    const row=editing?.t==="purchases"?state().records.purchases.find(row=>row.id===editing.id):null;
    tara.innerHTML='Tara (kg) <input id="sg10Tara" inputmode="decimal" value="'+esc(row?.data.tara)+'">';
    iva.innerHTML='IVA registrado (%) <input id="sg10Vat" inputmode="decimal" value="'+esc(row?.data.vatRate??row?.data.ivaRate)+'">';
    input.parentElement.after(tara,iva);
    const label=document.createElement("label");
    label.innerHTML='Palés de este puesto <input id="sg10PurchasePallets" placeholder="Ej. ½ o 2½" value="'
      +esc(row?.data.sgBoughtPallets?formatPallets(row.data.sgBoughtPallets):"")+'">';
    label.hidden=true;
    input.parentElement.after(label);
    const picker=document.getElementById("pOrder");
    const showPallets=()=>{
      const order=state().records.orders.find(item=>item.id===picker?.value);
      label.hidden=(order?.data.quantityUnit??row?.data.quantityUnit)!=="pales";
    };
    picker?.addEventListener("change",showPallets);
    showPallets();
    const button=document.createElement("button");
    button.type="button";button.className="secondary";button.textContent="Usar el peso fijo configurado";
    button.onclick=()=>{
      const company=state().records.clients.find(row=>row.id===document.getElementById("pClient")?.value);
      const product=document.getElementById("pProduct")?.value;
      const weight=(company?.data.sg10Rules??[]).find(row=>canonicalProduct(row.product)===canonicalProduct(product))?.weight;
      if(!weight){toast("No hay un peso fijo para este producto y cliente.");return;}
      document.getElementById("pMode").value="fixed";document.getElementById("pKgBox").value=weight;toggleWeight();
    };
    iva.after(button);
  }

  function range(kind) {
    const day=date();
    const start=new Date(day+"T12:00:00Z");
    if(kind==="week")start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);
    if(kind==="month")start.setUTCDate(1);
    sgComDate=start.toISOString().slice(0,10);
    window.sgComEnd=day;
    refresh();
  }
  function commissionView({client,start,end}) {
    commissionKey=JSON.stringify([client,start,end]);
    return '<div class="card"><h2>Revisión de comisiones</h2><div class="sg10-tools"><button onclick="sg10Ops(\'range\',\'day\')">Diario</button>'
      + '<button onclick="sg10Ops(\'range\',\'week\')">Semanal</button><button onclick="sg10Ops(\'range\',\'month\')">Mensual</button></div>'
      + (client ? '<div id="sg10CommissionStatus" role="status">Consultando estado…</div>' : '<p>Selecciona un cliente para revisar su informe.</p>')+'</div>';
  }
  async function commissionStatus() {
    const panel=document.getElementById("sg10CommissionStatus");
    if(!panel)return;
    const key=commissionKey,[client,start,end]=JSON.parse(key);
    const {api,workspace,records}=state();
    const source=records.purchases.filter(row=>row.data.clientId===client&&row.data.date>=start&&row.data.date<=end&&row.data.status==="Cargado")
      .map(row=>[row.id,row.updated_at]).sort((a,b)=>a[0].localeCompare(b[0]));
    if(!source.length){panel.textContent="No hay cargas confirmadas para revisar.";return;}
    const basis=records.clients.find(row=>row.id===client)?.data.sg10Rules??[];
    const fingerprint=await digest(JSON.stringify([basis,source]));
    const {data,error}=await api.from("sg10_commission_reviews").select("status,fingerprint,updated_at").eq("workspace_id",workspace)
      .eq("client_id",client).eq("date_from",start).eq("date_to",end).maybeSingle();
    if(commissionKey!==key||!panel.isConnected)return;
    if(error){panel.textContent=error.message;return;}
    const status=data?.fingerprint===fingerprint?data.status:"pendiente";
    panel.textContent="Estado: "+status+(data&&data.fingerprint!==fingerprint?" · El informe cambió desde la última revisión.":"");
    if(!roleOwner())return;
    for(const next of (status==="revisada"?["pendiente","enviada"]:status==="enviada"?["pendiente"]:["pendiente","revisada"])){
      const button=document.createElement("button");
      button.textContent={pendiente:"Preparar para revisión",revisada:"Confirmar revisión",enviada:"Registrar como enviada"}[next];
      button.onclick=async()=>{
        if(next==="enviada"&&!confirm("¿Confirmas que ya has enviado el informe a este cliente?"))return;
        button.disabled=true;
        const row={workspace_id:workspace,client_id:client,date_from:start,date_to:end,fingerprint,status:next,
          updated_by:state().user.id,updated_at:new Date().toISOString()};
        const result=data
          ? await api.from("sg10_commission_reviews").update(row).eq("workspace_id",workspace).eq("client_id",client)
            .eq("date_from",start).eq("date_to",end).eq("updated_at",data.updated_at).select("status")
          : await api.from("sg10_commission_reviews").insert(row).select("status");
        if(result.error||!result.data?.length){panel.textContent=result.error?.message??"El estado cambió. Vuelve a abrir el informe.";return;}
        await commissionStatus();
      };
      panel.append(" ",button);
    }
  }

  function afterRender(page) {
    if(page==="galeria")loadGallery().catch(error=>toast(error.message));
    if(page==="facturas"&&!fetching){
      fetching=true;
      loadInvoices().catch(error=>{const box=document.getElementById("sg10InvoiceStatus");if(box)box.textContent=error.message;}).finally(()=>fetching=false);
    }
    if(page==="comisiones")commissionStatus().catch(error=>toast(error.message));
  }
  const actions={editPhoto:photoForm,removePhoto,camera:cameraForm,loadInvoices,importInvoices,reviewInvoice,clients:clientForm,rules:ruleForm,range,splitPurchase};
  window.sg10Ops=(action,...args)=>Promise.resolve().then(()=>actions[action]?.(...args)).catch(error=>toast(error.message));
  return {dialog:openDialog,settingsView,invoiceView,galleryView,commissionView,configureRate,decoratePurchase,afterRender,setTarget};
}
