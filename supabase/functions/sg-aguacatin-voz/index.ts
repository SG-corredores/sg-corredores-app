import { createClient } from "npm:@supabase/supabase-js@2.89.0";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const delivery = {
  cheerful: "Alegre, expresivo y un poco teatral, con calidez y sentido del humor.",
  natural: "Cercano y conversacional, con entonación natural y buen ritmo.",
};

Deno.serve(async (request) => {
  const reply = (body: string, status: number) => new Response(body, { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return reply("Método no permitido", 405);

  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return reply("Inicia sesión", 401);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const speechKey = Deno.env.get("OPENAI_API_KEY");
  if (!url || !key || !speechKey) return reply("Voz no configurada", 503);

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return reply("Sesión no válida", 401);

    const body = await request.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 1800) return reply("Texto no válido", 400);
    const style = body.style === "natural" ? delivery.natural : delivery.cheerful;
    const instructions = "Habla en español de España con un acento andaluz perceptible y natural. "
      + "Usa una voz masculina adulta de registro medio, clara y con ritmo vivo. "
      + style + " Lee el texto tal como está escrito.";

    const audio = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + speechKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts-2025-12-15", voice: "cedar", input: text, instructions, response_format: "mp3",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!audio.ok || !audio.body) {
      console.error("Aguacatín speech status", audio.status);
      return reply("Voz temporalmente no disponible", 502);
    }
    return new Response(audio.body, { headers: { ...headers, "Content-Type": "audio/mpeg" } });
  } catch (error) {
    console.error("Aguacatín speech", error instanceof Error ? error.name : "Unknown error");
    return reply("No se pudo generar la voz", 502);
  }
});
