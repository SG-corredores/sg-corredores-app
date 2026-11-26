import { createClient } from "npm:@supabase/supabase-js@2.89.0";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function newPin() {
  // Rejection sampling keeps every ten-digit code equally likely.
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map(byte => {
    while (byte >= 250) byte = crypto.getRandomValues(new Uint8Array(1))[0];
    return byte % 10;
  }).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return reply({ error: "Método no permitido." }, 405);
  try {
    if (Number(request.headers.get("content-length")) > 1024) return reply({ error: "Solicitud inválida." }, 400);
    const raw = await request.text();
    if (raw.length > 1024) return reply({ error: "Solicitud inválida." }, 400);
    let body;
    try { body = JSON.parse(raw); } catch { return reply({ error: "Solicitud inválida." }, 400); }
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, serviceKey, { auth });
    const hmac = await crypto.subtle.importKey("raw", encoder.encode(serviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    async function digest(purpose: string, value: string) {
      const data = await crypto.subtle.sign("HMAC", hmac, encoder.encode("sg10-pin-v1:" + purpose + ":" + value));
      return [...new Uint8Array(data)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    const passwordFor = async (email: string) => "SG!a8-" + await digest("account", email);
    if (body?.action === "create") {
      const token = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!token) return reply({ error: "Inicia sesión como administrador." }, 401);
      const { data: { user }, error } = await admin.auth.getUser(token);
      if (error || !user || user.is_anonymous) return reply({ error: "Inicia sesión como administrador." }, 401);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (typeof body.workspace !== "string" || !uuid.test(body.workspace) || !name || name.length > 60) {
        return reply({ error: "Introduce un nombre válido de empleado." }, 400);
      }
      const owner = await admin.from("sg_members").select("user_id").eq("workspace_id", body.workspace)
        .eq("user_id", user.id).eq("role", "owner").maybeSingle();
      if (owner.error) throw owner.error;
      if (!owner.data) return reply({ error: "Hace falta acceso de administrador." }, 403);
      const email = crypto.randomUUID() + "@sg-pin.invalid";
      const { data: created, error: creationError } = await admin.auth.admin.createUser({
        email, password: await passwordFor(email), email_confirm: true, app_metadata: { sg10_pin_account: true },
      });
      if (creationError || !created.user) throw creationError || Error("Missing user");
      const pin = newPin();
      const result = await admin.rpc("sg10_register_employee_pin", {
        space: body.workspace, owner_id: user.id, employee_id: created.user.id, employee_name: name, p_digest: await digest("code", pin),
      });
      if (result.error) {
        // Never remove a previously existing account. A network error can leave the result unknown.
        if (result.error.code && /^[0-9A-Z]{5}$/.test(result.error.code)) {
          const cleanup = await admin.auth.admin.deleteUser(created.user.id);
          if (cleanup.error) console.error("sg10-employee-pin cleanup failed");
        }
        throw result.error;
      }
      return reply({ ok: true, pin });
    }
    if (body?.action !== "login" || typeof body.pin !== "string" || !/^\d{10}$/.test(body.pin)) {
      return reply({ error: "Introduce el PIN individual de diez cifras." }, 400);
    }
    const attempts = await admin.rpc("sg10_employee_pin_attempt", { p_bucket: "all-pin", p_limit: 45 });
    if (attempts.error) throw attempts.error;
    if (!attempts.data) return reply({ error: "Demasiados intentos. Vuelve a probar en unos minutos." }, 429);
    const lookup = await admin.rpc("sg10_find_employee_pin", { p_digest: await digest("code", body.pin) });
    if (lookup.error) throw lookup.error;
    if (!lookup.data) return reply({ error: "PIN no válido o acceso retirado." }, 403);
    const profile = await admin.auth.admin.getUserById(lookup.data);
    const email = profile.data.user?.email;
    if (profile.error || !email?.endsWith("@sg-pin.invalid") || profile.data.user?.app_metadata.sg10_pin_account !== true) {
      return reply({ error: "PIN no válido o acceso retirado." }, 403);
    }
    const client = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth });
    const { data, error } = await client.auth.signInWithPassword({ email, password: await passwordFor(email) });
    if (error || !data.session) throw error || Error("Missing session");
    return reply({ ok: true, access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch (error) {
    console.error("sg10-employee-pin", error instanceof Error ? error.name : "error");
    return reply({ error: "No se pudo completar el acceso con PIN." }, 502);
  }
});
