import { createClient } from "npm:@supabase/supabase-js@2.89.0";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const selectedVoice = "Pz2XmH0nqQgutakUVLmx";

Deno.serve(async (request) => {
  const reply = (body: string, status: number) => new Response(body, { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return reply("Método no permitido", 405);

  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return reply("Inicia sesión", 401);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const speechKey = Deno.env.get("ELEVENLABS_API_KEY");
  if (!url || !key || !speechKey) return reply("Voz no configurada", 503);

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return reply("Sesión no válida", 401);

    const body = await request.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 1800) return reply("Texto no válido", 400);
    const audio = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + selectedVoice + "/stream?output_format=mp3_44100_64", {
      method: "POST",
      headers: { "xi-api-key": speechKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        language_code: "es",
        voice_settings: { stability: body.style === "natural" ? 0.6 : 0.45, similarity_boost: 0.85, speed: 1.1 },
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
