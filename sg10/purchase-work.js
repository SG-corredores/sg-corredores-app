(() => {
  const cancelled = new Set(["Cancelado", "Anulado"]);
  const completed = new Set(["Comprado", "Cargado", "Preparado", "Completado", "Entregado"]);
  const scope = () => user && workspace ? workspace + ":" + user.id : "";
  const unit = row => d(row).quantityUnit || "cajas";
  const amountLabel = (row, amount) => (unit(row) === "pales" && window.sg10PalletText
    ? window.sg10PalletText(amount) : qty(amount)) + " " + sgUnitLabel({ quantityUnit: unit(row) }, amount);
  const productName = row => [d(row).product, d(row).variety].filter(Boolean).join(" · ");
  const orderDate = row => d(row).date;
  const clientName = row => name(d(row).clientId);
  const normalize = value => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const commonPlural = {
    tomates:"tomate", aguacates:"aguacate", mangos:"mango", kiwis:"kiwi", limones:"limon", fresones:"freson",
    melones:"melon", pimientos:"pimiento", brocolis:"brocoli", coliflores:"coliflor",
  };
  const canonical = value => normalize(value).split(" ").map(word =>
    Object.hasOwn(commonPlural,word) ? commonPlural[word] : /[ao]s$/.test(word) ? word.slice(0,-1) : word).join(" ");
  const key = row => JSON.stringify([canonical(d(row).product), normalize(d(row).variety), unit(row)]);
  let purchaseSource;
  let purchasesByOrder = new Map();
  function linked(row) {
    if (purchaseSource !== records.purchases) {
      purchaseSource = records.purchases;
      purchasesByOrder = new Map();
      for (const purchase of purchaseSource) {
        const { orderId, status } = d(purchase);
        if (!orderId || cancelled.has(status)) continue;
        if (!purchasesByOrder.has(orderId)) purchasesByOrder.set(orderId, []);
        purchasesByOrder.get(orderId).push(purchase);
      }
    }
    return purchasesByOrder.get(row.id) || [];
  }
  const remaining = row => {
    if (completed.has(d(row).status)) return 0;
    const purchased = linked(row).filter(p => completed.has(d(p).status) && unit(p) === unit(row))
      .reduce((sum, p) => sum + Math.max(0, Number(d(p)[unit(row) === "pales" ? "sgBoughtPallets" : "boxes"]) || 0), 0);
    return Math.max(0, Math.round(((Number(d(row).boxes) || 0) - purchased) * 1000) / 1000);
  };
  let workspaceScope = "";
  let members = new Map();
  let buyers = new Map();
  let buyerByAccount = new Map();
  let assignments = new Map();
  let selected = new Set();
  let loaded = false;
  let loading;
  let assignmentBusy = false;
  let buyerChecks = null;
  let productFilter = "";
  let grouped = true;
  let live;
  let liveApi;
  let refreshTimer;
  let teamError = "";
  const opened = new Set();

  function currentAssignee(id) {
    const uid = assignments.get(id)?.assignee;
    return members.has(uid) || buyers.has(uid) ? uid : null;
  }
  const buyerKey = uid => buyerByAccount.get(uid) || uid || "";
  const ownBuyer = () => buyerKey(user?.id);
  const person = uid => buyers.get(buyerKey(uid))?.name || members.get(uid)?.name || "Sin asignar";
  function workVisible(orderId) {
    if (!loaded) return false;
    const key = buyerKey(currentAssignee(orderId));
    if (role !== "owner" || !buyerChecks) return key === ownBuyer();
    return buyerChecks.has(key);
  }
  function colour(uid) {
    const index = [...new Set([...members.keys(),...buyers.keys()])].sort().indexOf(uid);
    const hue = Math.round((index * 137.508 + 225) % 360);
    return "hsl(" + hue + " 64% 33%)";
  }
  function badge(uid) {
    return uid ? '<span class="sg-work-person" style="--employee-colour:' + colour(uid) + '">' + esc(person(uid)) + "</span>" :
      '<span class="sg-work-unassigned">Sin asignar</span>';
  }
  const canEdit = id => role === "owner" || !currentAssignee(id) || buyers.has(currentAssignee(id)) || currentAssignee(id) === user?.id;
  const byName = (a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id);
  const membersSorted = () => [...members.values()].sort(byName);
  const buyersSorted = () => [...buyers.values()].sort(byName);
  const assigneesSorted = () => [...members.values(),...buyers.values()].sort(byName);
  const memberOptions = (value, list = assigneesSorted()) => list.map(m =>
    '<option value="' + esc(m.id) + '"' + (m.id === value ? " selected" : "") + ">" + esc(m.name) + "</option>").join("");

  async function allRows(connection, table, columns, order, space) {
    const rows = [];
    for (let start = 0; ; start += 500) {
      const result = await connection.from(table).select(columns).eq("workspace_id", space).order(order).range(start, start + 499);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < 500) return rows;
    }
  }

  function refreshView() {
    if (page === "micompra") {
      if (!$("content").contains(document.activeElement) || !document.activeElement.matches("input:not([type=checkbox]),select,textarea")) draw();
    } else if (page === "resumenpedidos") render();
    else if (page === "hoja") decorateOrders();
  }

  function load() {
    const account = scope();
    if (!account) return Promise.resolve();
    if (loading?.account === account) return loading.promise;
    const connection = api, space = workspace;
    const promise = Promise.all([
      allRows(connection, "sg_members", "user_id,role", "user_id", space),
      allRows(connection, "sg10_staff_names", "user_id,display_name", "user_id", space),
      allRows(connection, "sg10_purchase_assignments", "order_id,assignee,revision", "order_id", space),
      allRows(connection, "sg10_buyers", "id,display_name,employee_id", "id", space),
    ]).then(([staff, names, assigned, directory]) => {
      if (scope() !== account) return;
      const displayNames = new Map(names.map(row => [row.user_id, row.display_name]));
      members = new Map(staff.map((row) => [row.user_id, {
        id: row.user_id,
        name: displayNames.get(row.user_id) || (row.user_id === user.id && String(user.user_metadata?.full_name || user.user_metadata?.username || "").trim()) || (row.role === "owner" ? "Administrador" : "Empleado " + row.user_id.slice(0, 6)),
      }]));
      buyers = new Map(directory.map(row => [row.id,{id:row.id,name:row.display_name,employeeId:row.employee_id}]));
      buyerByAccount = new Map(directory.filter(row => row.employee_id).map(row => [row.employee_id,row.id]));
      if (buyerChecks) buyerChecks = new Set([...buyerChecks].map(buyerKey));
      assignments = new Map(assigned.map(row => [row.order_id, row]));
      loaded = true;
      teamError = "";
    }).catch(error => {
      if (scope() === account) {
        loaded = false;
        teamError = err(error);
      }
    }).finally(() => {
      if (loading?.promise === promise) loading = null;
      if (scope() === account) refreshView();
    });
    loading = { account, promise };
    return promise;
  }

  function connect() {
    const account = scope();
    if (account === workspaceScope) return;
    if (live) liveApi.removeChannel(live);
    clearTimeout(refreshTimer);
    live = null;
    workspaceScope = account;
    members.clear();
    buyers.clear();
    buyerByAccount.clear();
    buyerChecks = null;
    assignments.clear();
    selected.clear();
    opened.clear();
    productFilter = "";
    grouped = true;
    loaded = false;
    teamError = "";
    if (!account) return;
    liveApi = api;
    live = api.channel("sg-purchase-work-" + crypto.randomUUID());
    for (const table of ["sg10_purchase_assignments", "sg10_staff_names", "sg10_buyers"]) {
      live.on("postgres_changes", { event: "*", schema: "public", table, filter: "workspace_id=eq." + workspace }, schedule);
    }
    live.subscribe((state) => { if (state === "SUBSCRIBED" && scope() === account) load(); });
    load();
  }
  function schedule() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, 140);
  }
  setInterval(connect, 700);
  window.addEventListener("online", load);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && scope()) load();
  });

  async function assign(ids, target) {
    if (assignmentBusy) throw Error("Hay un cambio de asignación en curso.");
    if (!loaded) throw Error("La lista de empleados aún no está sincronizada.");
    const account = scope();
    assignmentBusy = true;
    try {
      const changes = [...new Set(ids)].map(id => ({ id, revision: assignments.get(id)?.revision || 0 }));
      if (!changes.length) throw Error("Selecciona mercancía primero.");
      const result = await api.rpc("sg10_change_purchase_assignments", { space: workspace, changes, target });
      if (result.error) throw result.error;
      if (scope() !== account) return null;
      for (const { id } of changes) selected.delete(id);
      return result.data;
    } finally {
      assignmentBusy = false;
      if (scope() === account) {
        if (loading?.account === account) await loading.promise;
        await load();
      }
    }
  }

  function actions(root, ids) {
    const bar = document.createElement("div");
    bar.className = "sg-work-actions actions";
    const summary = page === "resumenpedidos";
    if (summary) bar.classList.add("sg-work-actions-grid");
    bar.innerHTML = '<label class="sg-work-select"><input type="checkbox" data-all> Seleccionar todo</label>'
      + (!summary ? '<button type="button" class="secondary" data-self>Asignarme</button>' : "")
      + (summary || role === "owner" ? '<select aria-label="' + (summary ? 'Comprador' : 'Empleado responsable') + '" data-employee>'
        + (summary ? '<option value="">Elegir comprador</option>' : '') + memberOptions(summary ? '' : user.id, summary ? buyersSorted() : assigneesSorted())
        + '</select><button type="button" class="secondary" data-assign>Asignar</button>' : "")
      + (!summary || role === "owner" ? '<button type="button" class="secondary" data-release>Retirar asignación</button>' : "")
      + '<span data-count role="status"></span>';
    root.append(bar);
    const all = bar.querySelector("[data-all]");
    const controls = [...bar.querySelectorAll("button,select")];
    const buyer = bar.querySelector("[data-employee]");
    const assignButton = bar.querySelector("[data-assign]");
    const activeIds = () => [...new Set(ids())];
    function update() {
      const possible = activeIds();
      const count = possible.filter(id => selected.has(id)).length;
      all.checked = count > 0 && count === possible.length;
      all.indeterminate = count > 0 && !all.checked;
      all.disabled = !loaded || !possible.length;
      controls.forEach(button => { button.disabled = !loaded || !count; });
      if (assignButton && !buyer.value) assignButton.disabled = true;
      if (summary) for (const control of controls) control.hidden = count === 0;
      bar.querySelector("[data-count]").textContent = count ? count + " seleccionadas" : "";
    }
    const checks = [...root.querySelectorAll("[data-work-check]")];
    all.onchange = () => {
      for (const id of activeIds()) all.checked ? selected.add(id) : selected.delete(id);
      for (const input of checks) input.checked = selected.has(input.dataset.workCheck);
      update();
    };
    for (const input of checks) {
      input.onchange = () => {
        input.checked ? selected.add(input.dataset.workCheck) : selected.delete(input.dataset.workCheck);
        update();
      };
    }
    const run = async target => {
      try {
        const result = await assign(activeIds().filter(id => selected.has(id)), target);
        if (result != null) toast(result ? result + (target ? " asignadas." : " liberadas.") : "La selección ya tenía ese estado.");
      } catch (error) { toast(err(error)); }
    };
    const self = bar.querySelector("[data-self]"), release = bar.querySelector("[data-release]");
    if (self) self.onclick = () => run(user.id);
    if (release) release.onclick = () => run(null);
    if (assignButton) {
      buyer.onchange = update;
      assignButton.onclick = () => { if (buyer.value) run(buyer.value); };
    }
    update();
  }

  function check(row) {
    return '<input type="checkbox" data-work-check="' + esc(row.id) + '" aria-label="Seleccionar '
      + esc(productName(row) + " · " + clientName(row)) + '"' + (selected.has(row.id) ? " checked" : "")
      + (!loaded || !canEdit(row.id) || (!remaining(row) && !currentAssignee(row.id)) ? " disabled" : "") + ">";
  }
  function matchesProduct(row, text) {
    const term = normalize(text);
    if (!term) return true;
    if (normalize(productName(row)).includes(term)) return true;
    const words = canonical(productName(row)).split(" ");
    return canonical(term).split(" ").every(word => words.includes(word));
  }
  const ordersOn = (day, client = "") => records.orders.filter(row => orderDate(row) === day
    && (!client || d(row).clientId === client) && !cancelled.has(d(row).status));
  function listRows(day, assignee = "", filter = "") {
    return ordersOn(day).filter(row => remaining(row) > 0 && matchesProduct(row, filter)
      && (assignee ? buyerKey(currentAssignee(row.id)) === buyerKey(assignee) && (role === "owner" || workVisible(row.id))
        : workVisible(row.id)))
      .sort((a, b) => productName(a).localeCompare(productName(b), "es") || clientName(a).localeCompare(clientName(b), "es"));
  }
  function groupsFor(rows) {
    const groups = new Map();
    for (const row of rows) {
      const groupKey = key(row);
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(row);
    }
    return groups;
  }
  const groupTotal = rows => Math.round(rows.reduce((total, row) => total + remaining(row), 0) * 1000) / 1000;
  const groupMemberIds = rows => [...new Set(rows.map(row => currentAssignee(row.id)))];
  function show(day, filter = "", onlyMine = false) {
    productFilter = filter;
    if (onlyMine && role === "owner") buyerChecks = new Set([ownBuyer()]);
    if (day) sgNavDate = day;
    go("micompra");
  }
  function configureNames() {
    const dialog = document.createElement("dialog");
    dialog.className = "sg-work-team";
    dialog.innerHTML = '<h2>Nombres de empleados</h2><form><label>Empleado<select name="employee">'
      + memberOptions(user.id,membersSorted()) + '</select></label><label>Nombre visible<input name="displayName" required maxlength="60"></label>'
      + '<div class="actions"><button class="primary" type="submit">Guardar nombre</button><button type="button" data-close>Cerrar</button>'
      + '</div><p role="status"></p></form>';
    const form = dialog.querySelector("form");
    form.elements.employee.onchange = () => { form.elements.displayName.value = person(form.elements.employee.value); };
    form.elements.employee.onchange();
    form.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    const account = scope();
    form.onsubmit = async event => {
      event.preventDefault();
      if (scope() !== account) return dialog.close();
      const value = form.elements.displayName.value.trim();
      if (!value) return;
      event.submitter.disabled = true;
      try {
        const result = await api.from("sg10_staff_names").upsert({
          workspace_id: workspace, user_id: form.elements.employee.value, display_name: value,
        });
        if (result.error) throw result.error;
        await load();
        form.querySelector("[role=status]").textContent = "Nombre guardado.";
      } catch (error) { form.querySelector("[role=status]").textContent = err(error); }
      finally { event.submitter.disabled = false; }
    };
    document.body.append(dialog);
    dialog.showModal();
  }

  function manageBuyers() {
    if (role !== "owner" || user?.is_anonymous) return;
    if (!loaded) return toast("Espera a que se sincronicen los compradores.");
    const account = scope();
    const dialog = document.createElement("dialog");
    dialog.className = "sg-work-team";
    dialog.innerHTML = '<h2>Gestionar compradores</h2><form><label>Comprador<select name="buyer"></select></label>'
      + '<label>Nombre<input name="name" required maxlength="60"></label>'
      + '<label>Cuenta del empleado<select name="accountLink"></select></label>'
      + '<div class="actions"><button type="submit" class="primary">Guardar comprador</button>'
      + '<button type="button" data-close>Cerrar</button></div><p role="status"></p></form>';
    const form = dialog.querySelector("form");
    const {buyer,name,accountLink} = form.elements;
    const status = form.querySelector("[role=status]");
    function options(value = "") {
      buyer.innerHTML = '<option value="">Añadir comprador</option>' + memberOptions(value,buyersSorted());
      buyer.value = value;
      const entry = buyers.get(value);
      name.value = entry?.name || "";
      const candidates = membersSorted().filter(member =>
        !buyerByAccount.has(member.id) || buyerByAccount.get(member.id) === value);
      accountLink.innerHTML = '<option value="">Sin cuenta vinculada</option>' + memberOptions(entry?.employeeId,candidates);
      accountLink.value = entry?.employeeId || "";
    }
    options();
    buyer.onchange = () => options(buyer.value);
    form.querySelector("[data-close]").onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    form.onsubmit = async event => {
      event.preventDefault();
      if (scope() !== account || role !== "owner" || user?.is_anonymous) return dialog.close();
      const displayName = name.value.trim(), id = buyer.value;
      const payload = {display_name:displayName,employee_id:accountLink.value || null};
      if (!displayName) return;
      event.submitter.disabled = true;
      try {
        const table = api.from("sg10_buyers");
        const response = id
          ? await table.update(payload).eq("workspace_id",workspace).eq("id",id).select("id").single()
          : await table.insert({workspace_id:workspace,...payload}).select("id").single();
        if (response.error) throw response.error;
        if (loading?.account === account) await loading.promise;
        await load();
        if (scope() !== account || !dialog.open) return;
        options(response.data.id);
        status.textContent = "Comprador guardado.";
      } catch (error) {
        status.textContent = error.code === "23505" ? "El nombre o la cuenta ya están vinculados a otro comprador." : err(error);
      } finally { event.submitter.disabled = false; }
    };
    document.body.append(dialog);
    dialog.showModal();
  }

  function createEmployeePin() {
    if (role !== "owner" || !scope() || user.is_anonymous) return;
    const account = scope();
    const dialog = document.createElement("dialog");
    dialog.className = "sg-work-team";
    dialog.innerHTML = '<h2>Añadir empleado con PIN</h2><form><label>Nombre<input name="name" required maxlength="60"></label>'
      + '<div class="actions"><button class="primary" type="submit">Crear PIN</button><button type="button">Cerrar</button></div>'
      + '<p role="status" aria-live="polite"></p></form>';
    const form = dialog.querySelector("form");
    const status = form.querySelector("[role=status]");
    form.querySelector('button[type="button"]').onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    form.onsubmit = async event => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      if (account !== scope() || !name) return;
      event.submitter.disabled = true;
      try {
        const result = await api.functions.invoke("sg10-employee-pin", { body: { action: "create", workspace, name } });
        if (result.error) {
          const detail = await result.error.context?.json?.().catch(() => null);
          throw Error(detail?.error || result.error.message);
        }
        if (!result.data?.ok || !/^\d{10}$/.test(result.data.pin)) throw Error("No se pudo confirmar la creación del PIN.");
        if (account !== scope() || !dialog.open) return;
        status.textContent = "PIN de " + name + " · " + result.data.pin + ". Cópialo y compártelo en privado con el empleado. Se muestra una vez.";
        form.elements.name.readOnly = true;
        await load();
      } catch (error) {
        status.textContent = err(error);
        event.submitter.disabled = false;
      }
    };
    document.body.append(dialog);
    dialog.showModal();
  }

  function buyerFilter() {
    const panel = document.createElement("fieldset");
    panel.className = "sg-work-buyer-filter";
    const legend = '<legend>Ver pedidos de</legend>';
    if (!loaded) {
      panel.innerHTML = legend + '<p role="status">' + esc(teamError || "Cargando compradores…") + '</p>';
      if (teamError) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Reintentar";
        retry.onclick = load;
        panel.append(retry);
      }
      return panel;
    }
    const self = ownBuyer();
    const own = {id:self,name:person(self)+" (yo)"};
    const others = [...buyersSorted(),...membersSorted().filter(row => !buyerByAccount.has(row.id))]
      .filter(row => row.id !== self).sort(byName);
    const owner = role === "owner";
    const entries = owner ? [own,...others,{id:"",name:"Sin asignar"}] : [own];
    panel.innerHTML = legend + entries.map(({id,name}) =>
      '<label><input type="checkbox" data-buyer-view value="' + esc(id) + '"'
      + ((buyerChecks ? buyerChecks.has(id) : id === self) || !owner ? " checked" : "")
      + (owner ? "" : " disabled") + '>' + esc(name) + '</label>').join("");
    if (owner) panel.onchange = ({target}) => {
      if (!target.matches("[data-buyer-view]")) return;
      buyerChecks ??= new Set([self]);
      if (target.checked) buyerChecks.add(target.value);
      else buyerChecks.delete(target.value);
      render();
      $('content').querySelector('[data-buyer-view][value="'+CSS.escape(target.value)+'"]')?.focus({preventScroll:true});
    };
    return panel;
  }

  function draw() {
    const content = $("content");
    const day = sgClientDate();
    const rows = listRows(day, "", productFilter);
    const line = row => '<div class="sg-work-line pending"><label class="sg-work-select">' + check(row)
      + "<span><b>" + esc(clientName(row)) + "</b> · " + esc(productName(row)) + " · " + esc(amountLabel(row, remaining(row))) + "</span></label>"
      + badge(currentAssignee(row.id)) + (canEdit(row.id) && loaded ? '<button type="button" data-confirm-buy="' + esc(row.id)
        + '">Comprar</button>' : "") + "</div>";
    content.innerHTML = '<section class="card sg-work-list"><h2>Listas de compra</h2><div class="actions sg-work-toolbar">'
      + '<label>Fecha<input type="date" id="sgWorkDate" value="' + esc(day) + '"></label>'
      + '<label>Producto<input id="sgWorkFilter" type="search" value="' + esc(productFilter) + '"></label>'
      + '</div><div class="actions"><button type="button" id="sgWorkGroup">' + (grouped ? "Ver por cliente y línea" : "Agrupar productos")
      + '</button><button type="button" id="sgWorkPrint">Imprimir / PDF</button>'
      + (role === "owner" && loaded ? '<button type="button" id="sgWorkNames">Nombres de empleados</button>' : "")
      + "</div>"
      + (rows.length ? (grouped ? [...groupsFor(rows)].map(([groupKey, lines]) =>
        '<details class="sg-work-group pending" data-group="' + esc(groupKey) + '"' + (opened.has(groupKey) ? " open" : "") + "><summary>"
        + esc(productName(lines[0])) + " · " + esc(amountLabel(lines[0], groupTotal(lines))) + ' <span class="sg-work-badges">'
        + groupMemberIds(lines).map(badge).join("") + "</span></summary>" + lines.map(line).join("") + "</details>").join("") : rows.map(line).join(""))
        : loaded ? "<p>No hay mercancía pendiente para esta selección.</p>" : "") + "</section>";
    const panel = content.firstElementChild;
    $("sgWorkDate").onchange = event => { if (event.target.value) { sgNavDate = event.target.value; draw(); } };
    $("sgWorkFilter").onchange = event => { productFilter = event.target.value; draw(); };
    $("sgWorkFilter").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); event.target.blur(); } };
    $("sgWorkGroup").onclick = () => { grouped = !grouped; draw(); };
    $("sgWorkPrint").onclick = () => printList(day, "", productFilter, grouped);
    if ($("sgWorkNames")) $("sgWorkNames").onclick = () => configureNames();
    for (const details of panel.querySelectorAll("details")) details.ontoggle = () => {
      if (!details.isConnected) return;
      details.open ? opened.add(details.dataset.group) : opened.delete(details.dataset.group);
    };
    for (const button of panel.querySelectorAll("[data-confirm-buy]")) button.onclick = () => window.sg10OpenPurchaseForm?.(button.dataset.confirmBuy, "pSupplier", true);
    const header = document.createElement("div");
    panel.querySelector(".sg-work-toolbar").after(header);
    actions(panel, () => rows.filter(row => canEdit(row.id)).map(row => row.id));
    header.append(buyerFilter(),panel.querySelector(".sg-work-actions"));
  }

  function decorateSummaryAssignments(sheet, table, heading) {
    if (!heading.querySelector(".sg-work-heading")) {
      const th = document.createElement("th");
      th.textContent = "Comprador";
      th.className = "sg-work-heading";
      heading.prepend(th);
    }
    table.classList.add("sg-work-orders");
    const ids = [];
    for (const tr of table.querySelectorAll("[data-order-id]")) {
      const id = tr.dataset.orderId;
      const row = get("orders", id);
      if (!row) continue;
      const td = tr.querySelector(".sg-work-order-cell") || tr.insertCell(0);
      td.className = "sg-work-order-cell";
      td.innerHTML = check(row) + badge(currentAssignee(id));
      if ((remaining(row) || currentAssignee(id)) && canEdit(id)) ids.push(id);
    }
    sheet.querySelector(".sg-work-actions")?.remove();
    if (ids.length) {
      actions(sheet, () => ids);
      table.before(sheet.querySelector(".sg-work-actions"));
    }
  }

  function decorateOrders() {
    const sheet = $("dailySheet");
    if (!sheet) return;
    const table = sheet.querySelector("table");
    const heading = table?.querySelector("thead tr");
    if (!heading) return;
    const summary = page === "resumenpedidos";
    if (summary) {
      sheet.querySelector(".sg-work-buyer-filter")?.remove();
      table.before(buyerFilter());
      decorateSummaryAssignments(sheet, table, heading);
    }
    if (!sheet.querySelector("[data-print-orders]")) {
      const section = document.createElement("div");
      section.className = "actions";
      section.innerHTML = '<button type="button" data-print-orders>Imprimir este cliente</button>'
        + '<button type="button" data-print-all>Imprimir todos los clientes</button>';
      table.after(section);
      section.querySelector("[data-print-orders]").onclick = () => printOrders($("dailyClient").value, sgClientDate(), summary);
      section.querySelector("[data-print-all]").onclick = () => printOrders("", sgClientDate(), summary);
    }
  }

  function loads(day, purchases) {
    const orders = records.orders.filter(row => d(row).date === day && !cancelled.has(d(row).status));
    const purchasesByOrder = new Map();
    for (const purchase of purchases) {
      const orderId = d(purchase).orderId;
      if (!purchasesByOrder.has(orderId)) purchasesByOrder.set(orderId, []);
      purchasesByOrder.get(orderId).push(purchase);
    }
    const shown = new Set();
    const lines = [];
    for (const order of orders) {
      const customer = d(order).clientId;
      const linked = (purchasesByOrder.get(order.id) || []).filter(purchase => d(purchase).clientId === customer);
      for (const purchase of linked) {
        lines.push({ row: purchase, purchase: true });
        shown.add(purchase.id);
      }
      const key = unit(order) === "pales" ? "sgBoughtPallets" : "boxes";
      const matching = linked.filter(purchase => unit(purchase) === unit(order) && Number(d(purchase)[key]) > 0);
      const allocated = matching.reduce((total, purchase) => total + Number(d(purchase)[key]), 0);
      const outstanding = Math.round((Number(d(order).boxes) - allocated) * 1000) / 1000;
      if (!linked.length || (matching.length === linked.length && outstanding > 0)) lines.push({ row: order, outstanding });
    }
    for (const purchase of purchases) if (!shown.has(purchase.id)) lines.push({ row: purchase, purchase: true });

    const visibleClients = records.clients.filter(row => lines.some(line => d(line.row).clientId === row.id));
    const client = visibleClients.some(row => row.id === sgNavClient) ? sgNavClient : "";
    const customerOptions = '<option value="">Todos los clientes</option>' + visibleClients.map(row =>
      '<option value="' + esc(row.id) + '"' + (row.id === client ? " selected" : "") + ">" + esc(name(row.id)) + "</option>").join("");
    const rows = lines.filter(line => !client || d(line.row).clientId === client);
    const kg = purchases.filter(row => !client || d(row).clientId === client)
      .reduce((total, row) => total + kilos(d(row)), 0);
    return '<section class="card" id="sgReception" data-loads data-client="' + esc(client) + '"><h2>Cargas</h2>'
      + '<div class="sg-reception-filters"><button type="button" data-reception-step="-1" aria-label="Cliente anterior">‹</button>'
      + '<select aria-label="Cliente" id="sg10LoadCompany">' + customerOptions + '</select>'
      + '<button type="button" data-reception-step="1" aria-label="Cliente siguiente">›</button>'
      + '<input type="date" aria-label="Fecha de carga" id="sg10LoadDate" value="' + esc(day) + '"></div>'
      + '<p class="muted">Kilos registrados en la fecha: <strong>' + esc(qty(kg)) + ' kg</strong></p>'
      + '<details><summary>Más opciones</summary><div class="sg10-tools">'
      + '<button type="button" onclick="sg10PrintLoad()">Imprimir hoja A4</button>'
      + '<button type="button" onclick="sgGo(\'pales\')">Palets por cliente</button>'
      + '<button type="button" onclick="sg10Ops(\'camera\')">Recuento con cámara</button></div></details>'
      + (rows.length ? '<table><thead><tr><th scope="col">Producto</th><th scope="col">Puesto</th><th scope="col">Recepción</th></tr></thead><tbody>'
        + rows.map(line => loadRow(line, !client)).join("") + '</tbody></table>'
        : '<p>Sin mercancía para esta selección.</p>') + '</section>';
  }

  function loadRow({ row, purchase, outstanding }, showClient) {
    const x = d(row);
    const product = productName(row) || "Producto";
    const amount = purchase ? Number(x.boxes) : outstanding;
    const pallets = purchase && unit(row) === "pales";
    let quantity = amount > 0 ? amountLabel(row, amount) : "";
    if (pallets && Number(x.sgBoughtPallets) > 0) quantity = amountLabel(row, Number(x.sgBoughtPallets));
    else if (pallets && amount > 0) quantity = qty(amount) + " " + sgUnitLabel({ quantityUnit: "cajas" }, amount);
    const received = purchase && Boolean(x.receivedAt);
    const label = received ? "Recepción confirmada de " : "Confirmar recepción de ";
    const control = purchase
      ? '<button type="button" data-receipt="' + esc(row.id) + '" aria-label="' + esc(label + product) + '"'
        + (received ? ' class="secondary" disabled>✓ OK' : ' class="primary">OK') + '</button>'
      : '<small>Pendiente</small>';
    return '<tr class="' + (received ? "done" : "pending") + '"><td><span class="sg-load-cell">'
      + (showClient ? '<small>' + esc(clientName(row)) + '</small>' : '')
      + '<b>' + esc([quantity, product].filter(Boolean).join(" ")) + '</b></span></td><td><span class="sg-load-cell">'
      + esc(x.supplier || "—") + '</span></td><td>' + control + '</td></tr>';
  }

  function reception(showLoads = false) {
    const day = sgClientDate();
    const purchases = records.purchases.filter(row => d(row).date === day && !cancelled.has(d(row).status));
    if (showLoads) return loads(day, purchases);
    const visibleClients = records.clients.filter(row => purchases.some(purchase => d(purchase).clientId === row.id));
    const client = visibleClients.some(row => row.id === sgNavClient) ? sgNavClient : visibleClients[0]?.id || "";
    const clientOptions = visibleClients.map(row => '<option value="' + esc(row.id) + '"' + (row.id === client ? " selected" : "") + ">" + esc(d(row).name) + "</option>").join("");
    const rows = purchases.filter(row => d(row).clientId === client).sort((a,b) =>
      Boolean(d(a).receivedAt) - Boolean(d(b).receivedAt) || productName(a).localeCompare(productName(b),"es"));
    return '<section class="card" id="sgReception" data-client="' + esc(client) + '"><h2>Recepción</h2>'
      + '<div class="sg-reception-filters"><button type="button" data-reception-step="-1" aria-label="Cliente anterior">‹</button>'
      + '<select aria-label="Cliente de recepción" id="sgReceptionClient">' + clientOptions + '</select>'
      + '<button type="button" data-reception-step="1" aria-label="Cliente siguiente">›</button>'
      + '<input type="date" aria-label="Fecha de recepción" id="sgReceptionDate" value="' + esc(day) + '"></div>'
      + '<table><thead><tr><th>Producto</th><th>Puesto</th><th>Recepción</th></tr></thead><tbody>'
      + rows.map(row => '<tr class="' + (d(row).receivedAt ? "done" : "pending") + '"><td><b>' + esc(productName(row)) + '</b></td><td>'
        + esc(d(row).supplier || "—") + '</td><td><button type="button" data-receipt="' + esc(row.id) + '"'
        + (d(row).receivedAt ? ' disabled>Confirmado' : ' class="primary">Confirmar') + "</button></td></tr>").join("")
      + '</tbody></table>' + (rows.length ? '<p class="muted">Desliza para cambiar de cliente.</p>' : '<p>Sin compras registradas para esta fecha.</p>') + "</section>";
  }
  function decorateReception() {
    const panel = $("sgReception");
    if (!panel) return;
    const picker = $("sgReceptionClient") || $("sg10LoadCompany");
    const datePicker = $("sgReceptionDate") || $("sg10LoadDate");
    const clients = [...picker.options].map(option => option.value);
    const step = direction => {
      if (clients.length < 2) return;
      sgNavClient = clients[(clients.indexOf(panel.dataset.client) + direction + clients.length) % clients.length];
      render();
    };
    datePicker.onchange = event => { if (event.target.value) { sgNavDate = event.target.value; render(); } };
    picker.onchange = () => { sgNavClient = picker.value; render(); };
    for (const button of panel.querySelectorAll("[data-reception-step]")) {
      button.disabled = clients.length < 2;
      button.onclick = () => step(Number(button.dataset.receptionStep));
    }
    let start;
    panel.addEventListener("touchstart", event => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && !event.target.closest("input,select,button") ? [touch.clientX,touch.clientY] : null;
    }, { passive: true });
    panel.addEventListener("touchcancel", () => { start = null; }, { passive: true });
    panel.addEventListener("touchend", event => {
      if (!start || !event.changedTouches.length) return;
      const touch = event.changedTouches[0], dx = touch.clientX - start[0], dy = touch.clientY - start[1];
      start = null;
      if (Math.abs(dx) > 65 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    }, { passive: true });
    for (const button of panel.querySelectorAll("[data-receipt]:not(:disabled)")) button.onclick = async () => {
      const account = scope();
      button.disabled = true;
      try {
        const { data, error } = await api.rpc("sg10_confirm_reception", { space: workspace, purchase_id: button.dataset.receipt });
        if (error) throw error;
        if (scope() !== account) return;
        if (data?.id) {
          records.purchases = [data,...records.purchases.filter(row => row.id !== data.id)];
          toast("Recepción confirmada.");
        } else {
          await sync(true);
          toast("La línea ya se confirmó o cambió en otro dispositivo.");
        }
        if (page === "recepcion" || page === "cargas") render();
      } catch (error) { button.disabled = false; toast(err(error)); }
    };
  }

  function moneyLabel(line) {
    const value = price(line);
    return line.price == null && line.priceCents == null ? "" : fmt(value) + "/" + (line.priceUnit === "pale" ? "palet" : line.priceUnit || "kg");
  }
  function printLine(row, amount, prefix = "", details = false) {
    const data = d(row);
    const purchases = linked(row);
    const prices = [...new Set(purchases.map(p => moneyLabel(d(p))).filter(Boolean))];
    const suppliers = [...new Set(purchases.map(p => d(p).supplier).filter(Boolean))];
    if (!prices.length && moneyLabel(data)) prices.push(moneyLabel(data));
    if (!suppliers.length && data.supplier) suppliers.push(data.supplier);
    const activeBuyer = currentAssignee(row.id);
    const creditedBuyers = [...new Set([activeBuyer, ...purchases.map(p => d(p).buyerId)].filter(uid => members.has(uid) || buyers.has(uid)))];
    return { quantity: amountLabel(row, amount), product: prefix + (details ? productName(row) : [productName(row), data.notes].filter(Boolean).join(" · ")),
      price: prices.join(" · "), supplier: suppliers.join(" · "), buyers: creditedBuyers.map(person).join(" · ") };
  }
  function printOrders(client, day, summary = false) {
    if (!loaded) { toast("Sincroniza la lista de empleados para imprimir."); return false; }
    const groups = new Map();
    for (const row of ordersOn(day, client)) {
      if (summary && (!workVisible(row.id) || !window.sg10OrderNeedsPriceOrSupplier(row))) continue;
      const company = clientName(row);
      if (!groups.has(company)) groups.set(company, []);
      groups.get(company).push(printLine(row, Number(d(row).boxes) || 0));
    }
    const lines = [...groups].sort(([a], [b]) => a.localeCompare(b, "es"))
      .flatMap(([company, rows]) => [{ heading: company }, ...rows]);
    return printSheet((summary ? "Resumen de pedidos · " : "Pedidos · ") + (client ? name(client) : "Todos los clientes"), day, lines);
  }
  function printList(day, assignee, filter, compact) {
    if (!loaded) { toast("Sincroniza la lista de empleados para imprimir."); return false; }
    const rows = listRows(day, assignee, filter);
    const lines = compact ? [...groupsFor(rows).values()].flatMap(group => {
      const child = group.map(row => ({ ...printLine(row, remaining(row), "", true), product: "↳ " + clientName(row) }));
      const same = field => new Set(child.map(item => item[field])).size === 1 ? child[0][field] : "";
      return [{
        quantity: amountLabel(group[0], groupTotal(group)), product: productName(group[0]), price: same("price"),
        supplier: same("supplier"), buyers: groupMemberIds(group).filter(Boolean).map(person).join(" · "), subtotal: true,
      }, ...child];
    }) : rows.map(row => printLine(row, remaining(row), clientName(row) + " · ", true));
    return printSheet(assignee ? "Compra · " + person(assignee) : "Compra general", day, lines);
  }
  function printSheet(title, day, lines) {
    if (!lines.length) { toast("No hay mercancía para imprimir."); return false; }
    let place = $("sg-work-print");
    if (!place) {
      place = document.createElement("main");
      place.id = "sg-work-print";
      document.body.append(place);
    }
    const columns = [];
    let current = [];
    let previousHeader = "";
    let weight = 0;
    for (const [index, item] of lines.entries()) {
      const cost = item.heading ? 1 : Math.max(1, Math.ceil(item.product.length / 25), Math.ceil(item.buyers.length / 17),
        Math.ceil(item.price.length / 14), Math.ceil(item.supplier.length / 13));
      if (current.length && (weight + cost > 19 || (item.heading && weight + cost === 19 && lines[index + 1]))) {
        columns.push(current);
        current = item.heading || !previousHeader ? [] : [{ heading: previousHeader + " (cont.)" }];
        weight = current.length;
      }
      if (item.heading) previousHeader = item.heading;
      current.push(item);
      weight += cost;
    }
    if (current.length) columns.push(current);
    const renderColumn = column => column ? `<section><h2>${esc(title)}</h2><p>${esc(day)}</p><table>
      <colgroup><col style="width:17mm"><col style="width:49mm"><col style="width:19mm"><col style="width:23mm"><col style="width:22mm"></colgroup>
      <thead><tr><th>Cant.</th><th>Mercancía</th><th>Precio</th><th>Puesto</th><th>Empleado</th></tr></thead>
      <tbody>${column.map(item => item.heading ? '<tr class="sg-work-print-heading"><th colspan="5">' + esc(item.heading) + "</th></tr>"
        : '<tr' + (item.subtotal ? ' class="sg-work-print-group"' : "") + ">" + ["quantity","product","price","supplier","buyers"]
        .map(field => "<td>" + esc(item[field]) + "</td>").join("") + "</tr>").join("")}</tbody></table></section>` : "<section></section>";
    let html = "";
    for (let index = 0; index < columns.length; index += 2) {
      html += "<article>" + renderColumn(columns[index]) + renderColumn(columns[index + 1]) + "</article>";
    }
    place.innerHTML = html;
    document.body.classList.add("sg-work-print-active");
    window.print();
    return true;
  }
  window.addEventListener("afterprint", () => document.body.classList.remove("sg-work-print-active"));

  function dateFrom(text, fallback) {
    const query = normalize(text);
    const explicit = text.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
    if (explicit) return explicit;
    const offset = /\bpasado manana\b/.test(query) ? 2 : /\bmanana\b/.test(query) ? 1 : /\bayer\b/.test(query) ? -1 : /\bhoy\b/.test(query) ? 0 : null;
    if (offset == null) return fallback;
    const day = new Date(today() + "T12:00:00Z");
    day.setUTCDate(day.getUTCDate() + offset);
    return day.toISOString().slice(0, 10);
  }
  function entity(text, candidates) {
    const query = " " + normalize(text) + " ";
    const matches = candidates.map(item => ({ ...item, label: normalize(item.name) }))
      .filter(item => item.label && query.includes(" " + item.label + " "))
      .sort((a, b) => b.label.length - a.label.length);
    if (matches.length && (matches.length === 1 || matches[0].label.length > matches[1].label.length)) return matches[0].id;
    const partial = candidates.filter(item => normalize(item.name).split(" ").some(word =>
      word.length >= 4 && !["frutas","verduras","empleado","administrador"].includes(word) && query.includes(" " + word + " ")));
    return partial.length === 1 ? partial[0].id : "";
  }
  let pendingVoice;
  let pendingEmployee;
  function confirmAssignment(day, filter, target, answer) {
    if (role !== "owner" && target !== user.id && !buyers.has(target)) { answer("Elige un comprador de la lista."); return; }
    const rows = listRows(day, "", filter).filter(row => canEdit(row.id) && currentAssignee(row.id) !== target);
    if (!rows.length) { answer("No encuentro líneas pendientes de " + filter + " que puedas asignar."); return; }
    pendingVoice = { scope: scope(), expires: Date.now() + 120000, target,
      ids: rows.map(row => ({ id: row.id, revision: assignments.get(row.id)?.revision || 0 })) };
    answer("He encontrado " + rows.length + " líneas de " + filter + ". ¿Confirmas la asignación a " + person(target) + "?");
  }
  async function voice(text, answer) {
    if (!scope()) return false;
    const query = normalize(text).replace(/^(?:(?:oye )?aguacatin|oye santi)[ ]+/, "");
    const day = dateFrom(text, today());
    if (pendingEmployee) {
      const pending = pendingEmployee;
      pendingEmployee = null;
      if (pending.scope === scope() && pending.expires > Date.now()) {
        const target = /^(mi|yo|a mi|para mi)$/.test(query) ? user.id : entity(query, assigneesSorted());
        if (target) { confirmAssignment(pending.day, pending.filter, target, answer); return true; }
        if (/^(no|cancela)$/.test(query)) { answer("Asignación cancelada."); return true; }
      }
    }
    if (pendingVoice && /^(si|confirmo|confirmar|adelante|vale|no|cancela)$/.test(query)) {
      const pending = pendingVoice;
      pendingVoice = null;
      if (pending.scope !== scope() || pending.expires < Date.now()) { answer("La confirmación ha caducado. Pídeme la asignación otra vez."); return true; }
      if (/^(no|cancela)$/.test(query)) { answer("Asignación cancelada."); return true; }
      try {
        if (pending.ids.some(({ id, revision }) => (assignments.get(id)?.revision || 0) !== revision)) throw Error("Las asignaciones han cambiado. Dímelo otra vez.");
        const count = await assign(pending.ids.map(({ id }) => id), pending.target);
        if (count != null) answer(count ? count + " líneas asignadas a " + person(pending.target) + "." : "Las líneas ya estaban asignadas a " + person(pending.target) + ".");
      } catch (error) { answer(err(error)); }
      return true;
    }
    if (/^(?:(?:puedes|podrias) )?(?:imprime|imprimir|imprimeme|saca en papel)\b/.test(query)) {
      if (/\bmi lista|\bmis compras|\bmi compra/.test(query)) {
        if (printList(day, user.id, "", true)) answer("He abierto la impresión de tu lista de compra.");
      } else if (/\bcompra|\bcompras\b/.test(query)) {
        const target = entity(query, assigneesSorted());
        if (printList(day, target, "", !/\b(?:detallada|desglosada)\b/.test(query))) answer("He abierto la impresión de la lista de compra.");
      } else {
        const customer = entity(query, records.clients.map(row => ({ id: row.id, name: d(row).name })));
        if (!customer && /\b(?:de|para)\b/.test(query.replace(/\b(?:de|para) (?:hoy|ayer|manana|pasado manana)\b/, "")) && !/\btodos\b/.test(query)) {
          answer("¿De qué cliente quieres imprimir los pedidos?");
        } else if (printOrders(/\btodos\b/.test(query) ? "" : customer || sgSelectedClient(), day)) answer("He abierto la impresión de los pedidos.");
      }
      return true;
    }
    if (/\b(?:me queda|me falta|pendiente)\b.*\bcomprar\b|\b(?:mi lista de compra|mis compras pendientes)\b/.test(query)) {
      if (!loaded) { answer("Espera a que se sincronice la lista de empleados."); return true; }
      const lines = [...groupsFor(listRows(day, user.id)).values()];
      show(day, "", true);
      answer(lines.length ? "Te queda " + lines.slice(0, 8).map(group => amountLabel(group[0], groupTotal(group)) + " de " + productName(group[0])).join(", ")
        + (lines.length > 8 ? ". El resto está en tu lista." : ".") : "No tienes mercancía pendiente asignada para ese día.");
      return true;
    }
    const groupCommand = query.match(/^(?:agrupa|agrupar|agrupame)\s+(?:(?:todos?|todas?)\s+)?(?:(?:los|las)\s+)?(?:(?:pedidos|compras)\s+de\s+)?(.+)$/);
    if (groupCommand) {
      const filter = groupCommand[1].replace(/\s+(?:(?:de|para)\s+)?(?:hoy|ayer|manana|pasado manana|20\d{2} \d{2} \d{2})$/, "");
      grouped = true;
      const lines = listRows(day, "", filter);
      show(day, filter);
      answer(lines.length ? "He agrupado " + lines.length + " líneas pendientes de " + filter + " en la lista general." : "No encuentro mercancía pendiente de " + filter + " para ese día.");
      return true;
    }
    const command = query.match(/^(?:asigna(?:le|me)?|reparte)\s+(.+?)(?:\s+(?:al|a)\s+(.+))?$/);
    if (command) {
      if (!loaded) { answer("Espera a que se sincronice la lista de empleados."); return true; }
      const target = query.startsWith("asigname ") || /^(mi|yo)$/.test(command[2] || "") ? user.id : entity(command[2] || "", assigneesSorted());
      const filter = command[1].replace(/^(?:(?:todos?|todas?)\s+)?(?:(?:los|las)\s+)?(?:pedidos de\s+)?/, "")
        .replace(/\s+(?:(?:de|para)\s+)?(?:hoy|ayer|manana|pasado manana|20\d{2} \d{2} \d{2})$/, "");
      if (!target) {
        pendingEmployee = { scope: scope(), expires: Date.now() + 120000, day, filter };
        answer("¿A qué empleado se lo asigno?");
      } else confirmAssignment(day, filter, target, answer);
      return true;
    }
    return false;
  }

  window.sg10WorkVisible = workVisible;
  window.sg10Reception = reception;
  window.sg10CreateEmployeePin = createEmployeePin;
  window.sg10PendingQuantity = remaining;
  window.sg10DecorateOrderAssignments = decorateOrders;
  window.sg10ManageBuyers = manageBuyers;
  window.sgPrint82 = () => printOrders($("dailyClient")?.value || sgSelectedClient(), sgClientDate(), page === "resumenpedidos");
  window.sg10WorkVoice = voice;
  window.sg10WorkDate = dateFrom;
  const ask = window.askAgu;
  window.askAgu = async () => {
    const input = $("aguQuestion");
    if (input?.value && await voice(input.value, text => { $("aguBubble").textContent = text; window.aguSay?.(text); })) { input.value = ""; return; }
    return ask?.();
  };
  const baseRender = render;
  render = function (...args) {
    connect();
    if (page !== "micompra") {
      const result = baseRender.apply(this,args);
      if (page === "recepcion" || page === "cargas") decorateReception();
      return result;
    }
    if ($("app").style.display === "none") return;
    draw();
  };
})();
