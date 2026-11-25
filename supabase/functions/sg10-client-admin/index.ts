import { createClient } from "npm:@supabase/supabase-js@2.89.0";

const origin = "https://sg-corredores.github.io";
const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

Deno.serve(async (request) => {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: cors });
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ error: "Método no permitido." }, 405);
  try {
    const jwt = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!jwt) return json({ error: "Inicia sesión." }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !user || user.is_anonymous) return json({ error: "Acceso denegado." }, 401);
    const { workspace_id, client_id, email, action, user_id } = await request.json();
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (!uuid.test(workspace_id) || typeof client_id !== "string" || !client_id || client_id.length > 120) {
      return json({ error: "Empresa incorrecta." }, 400);
    }
    const owner = await admin.from("sg_members").select("role").eq("workspace_id", workspace_id)
      .eq("user_id", user.id).eq("role", "owner").maybeSingle();
    if (!owner.data) return json({ error: "Se requiere una cuenta de propietario." }, 403);
    const company = await admin.from("sg_clients").select("id").eq("workspace_id", workspace_id)
      .eq("id", client_id).maybeSingle();
    if (!company.data) return json({ error: "Empresa inexistente." }, 404);
    if (action === "list") {
      const { data, error } = await admin.from("sg10_company_users").select("user_id,created_at")
        .eq("workspace_id", workspace_id).eq("client_id", client_id);
      if (error) throw error;
      const users = await Promise.all(data.map(async ({ user_id, created_at }) => {
        const { data } = await admin.auth.admin.getUserById(user_id);
        return { user_id, created_at, email: data.user?.email ?? null };
      }));
      return json({ users });
    }
    if (action === "remove" && uuid.test(user_id)) {
      const { error } = await admin.from("sg10_company_users").delete()
        .eq("workspace_id", workspace_id).eq("client_id", client_id).eq("user_id", user_id);
      if (error) throw error;
      return json({ ok: true });
    }
    if (action !== "invite" || typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "Indica un correo válido." }, 400);
    }
    const existing = await admin.rpc("sg10_customer_by_email", { p_email: email.trim() });
    if (existing.error) throw existing.error;
    let id = existing.data;
    let invited = false;
    if (!id) {
      const result = await admin.auth.admin.inviteUserByEmail(email.trim(), {
        redirectTo: origin + "/sg-corredores-app/portal.html",
      });
      if (result.error || !result.data.user) return json({ error: "No se pudo enviar la invitación." }, 409);
      id = result.data.user.id;
      invited = true;
    }
    const staff = await admin.from("sg_members").select("user_id").eq("user_id", id).limit(1);
    if (staff.error) throw staff.error;
    if (staff.data.length) return json({ error: "Usa una cuenta distinta de la de empleado." }, 409);
    const link = await admin.from("sg10_company_users").upsert({ workspace_id, client_id, user_id: id },
      { onConflict: "workspace_id,client_id,user_id", ignoreDuplicates: true });
    if (link.error) throw link.error;
    return json({ ok: true, invited });
  } catch (error) {
    console.error("sg10-client-admin", error instanceof Error ? error.name : "database");
    return json({ error: "No se pudo completar la gestión de acceso." }, 500);
  }
});
