const batchOrder = /^(?:portal|agu):[a-f0-9-]{36}:[a-f0-9-]{36}:\d+$/i;

const phrases = {
  nuevo_pedido: "Pedido nuevo", pedido_cliente: "Pedido nuevo", nuevo_articulo: "Artículo añadido",
  pedido_modificado: "Pedido modificado", pedido_eliminado: "Pedido eliminado",
  precio: "Precio actualizado", puesto: "Puesto actualizado",
  mensaje_cliente: "Mensaje de cliente", articulo_comprado: "Artículo comprado",
  mercancia_cargada: "Mercancía cargada", nueva_foto: "Nueva foto",
};

export function createOrderVoice(space, user) {
  const speech = window.speechSynthesis;
  if (!speech || !window.SpeechSynthesisUtterance) return null;

  const key = "sg10_order_voice:" + space + ":" + user;
  let enabled = true;
  try { enabled = localStorage.getItem(key) !== "off"; } catch {}

  let latestId;
  let current;
  const heard = new Set();
  const queue = [];
  const canSpeak = () => enabled && !document.hidden && document.hasFocus()
    && navigator.userActivation?.hasBeenActive !== false;

  function play() {
    if (current || !queue.length) return;
    if (!canSpeak()) {
      queue.length = 0;
      return;
    }
    const utterance = new SpeechSynthesisUtterance(queue.shift());
    utterance.lang = "es-ES";
    current = utterance;
    utterance.onend = utterance.onerror = () => {
      if (current !== utterance) return;
      current = null;
      play();
    };
    speech.speak(utterance);
  }

  function stop() {
    queue.length = 0;
    if (!current) return;
    current = null;
    speech.cancel();
  }

  return {
    enabled: () => enabled,
    setEnabled(value) {
      enabled = value;
      try { localStorage.setItem(key,value ? "on" : "off"); } catch {}
      if (!value) stop();
    },
    stop,
    test() {
      if (!canSpeak()) return false;
      queue.push("Avisos de SG Corredores.");
      play();
      return true;
    },
    update(rows) {
      const previous = latestId;
      latestId = Math.max(previous ?? 0,Number(rows[0]?.id) || 0);
      if (previous === undefined || !canSpeak()) return;

      for (const row of [...rows].reverse()) {
        if (Number(row.id) <= previous || !Object.hasOwn(phrases,row.kind)) continue;
        const record = row.record_id ?? String(row.id);
        const order = row.kind === "nuevo_pedido" || row.kind === "pedido_cliente";
        const key = order
          ? "order:" + (batchOrder.test(record) ? record.slice(0,record.lastIndexOf(":")) : record)
          : "event:" + row.id;
        if (row.kind === "nuevo_articulo" && rows.some(event => event.record_id === row.record_id && event.kind === "nuevo_pedido")) continue;
        if (heard.has(key)) continue;
        heard.add(key);
        if (heard.size > 200) heard.delete(heard.values().next().value);
        const name = row.client_name?.trim();
        queue.push(name ? phrases[row.kind] + ". " + name : phrases[row.kind] + ".");
      }
      play();
    },
  };
}
