import { authenticateWorker } from "../_shared/sg10-worker.ts";
import webpush from "npm:web-push@3.6.7";

type Job = { job_id: number; token: string; endpoint: string | null; p256dh: string; auth_key: string; kind: string; event_id: number; portal: boolean; client_name: string | null; article: string | null; actor_name: string | null; occurred_at: string };
const titles: Record<string, string> = {
  nuevo_pedido: "Nuevo pedido", nuevo_articulo: "Artículo añadido", articulo_comprado: "Artículo comprado",
  precio: "Precio actualizado", puesto: "Puesto actualizado", pedido_modificado: "Pedido modificado",
  pedido_eliminado: "Pedido eliminado", mercancia_cargada: "Mercancía cargada", factura_recibida: "Factura recibida",
  factura_discrepancia: "Diferencia en factura", factura_sin_pedido: "Factura sin pedido", incidencia: "Reclamación o incidencia", comision_revision: "Comisión para revisar",
  nueva_foto: "Nueva fotografía", actualizacion: "Nueva actualización",
};

function allowedEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && (["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com",
        "android.googleapis.com", "notify.windows.com"].includes(url.hostname)
        || url.hostname.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const worker = await authenticateWorker(request);
  if (!worker) return new Response(null, { status: 401 });
  const vapid = {
    subject: Deno.env.get("VAPID_SUBJECT") ?? "",
    publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
    privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
  };
  if (!vapid.subject || !vapid.publicKey || !vapid.privateKey) return Response.json({ error: "Faltan secretos VAPID." }, { status: 503 });
  const { db, checkOnly } = worker;
  if (checkOnly) {
    try {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
      return Response.json({ ready: true, public_key: vapid.publicKey });
    } catch {
      return Response.json({ error: "Configuración VAPID no válida." }, { status: 503 });
    }
  }
  const { data, error } = await db.rpc("sg10_claim_push", { p_limit: 24 });
  if (error) return Response.json({ error: error.code }, { status: 500 });
  const timestamp=new Intl.DateTimeFormat("es-ES",{dateStyle:"short",timeStyle:"short",timeZone:"Europe/Madrid"});
  let sent = 0, failed = 0;
  const jobs: Job[] = data;
  for (let offset = 0; offset < jobs.length; offset += 8) {
    await Promise.all(jobs.slice(offset, offset + 8).map(async (job) => {
      let result = "done";
      if (job.endpoint && allowedEndpoint(job.endpoint)) {
        try {
          await webpush.sendNotification({ endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth_key } },
            JSON.stringify({ title: titles[job.kind] ?? "SG Corredores", body: [job.client_name,job.article,job.actor_name,timestamp.format(new Date(job.occurred_at))].filter(Boolean).join(" · ").slice(0,240),
              tag: "sg-event-" + job.event_id, event: job.event_id, portal: job.portal }),
            { TTL: 21600, urgency: "high", timeout: 7500, vapidDetails: vapid });
          sent++;
        } catch (error) {
          failed++;
          const status = (error as { statusCode?: number }).statusCode;
          result = status === 404 || status === 410 ? "gone" : "retry";
        }
      }
      const finish = await db.rpc("sg10_finish_push", { p_id: job.job_id, p_token: job.token, p_result: result });
      if (finish.error) console.error("sg10-push completion", finish.error.code);
    }));
  }
  return Response.json({ claimed: jobs.length, sent, failed });
});
