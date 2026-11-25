import { createClient } from "npm:@supabase/supabase-js@2.89.0";

export async function authenticateWorker(request: Request) {
  const token = request.headers.get("x-sg-worker") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await db.rpc("sg10_worker_context", { p_token: token });
  if (error || !data) return null;
  return { db, context: data, checkOnly: request.headers.get("x-sg-worker-check") === "1" };
}
