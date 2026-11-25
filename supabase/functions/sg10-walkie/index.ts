import { createClient } from "npm:@supabase/supabase-js@2.89.0";
import { AccessToken, TrackSource } from "npm:livekit-server-sdk@2.20.1";

const cors = {
  "Access-Control-Allow-Origin":"https://sg-corredores.github.io",
  "Access-Control-Allow-Headers":"authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Cache-Control":"no-store",
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  const reply=(body: unknown,status=200)=>Response.json(body,{status,headers:cors});
  if(request.method==="OPTIONS")return new Response(null,{headers:cors});
  if(request.method!=="POST")return reply({error:"Método no permitido."},405);
  try{
    const jwt=request.headers.get("Authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if(!jwt)return reply({error:"Inicia sesión."},401);
    const {workspace,peer}=await request.json();
    if(!uuid.test(workspace)||(peer&&!uuid.test(peer)))return reply({error:"Canal incorrecto."},400);
    const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
    const {data:{user},error}=await sb.auth.getUser(jwt);
    if(error||!user||user.is_anonymous||peer===user.id)return reply({error:"Usa una cuenta individual de empleado."},403);
    const users=peer?[user.id,peer]:[user.id];
    const members=await sb.from("sg_members").select("user_id").eq("workspace_id",workspace).in("user_id",users);
    if(members.error || members.data.length!==users.length)return reply({error:"Canal reservado a empleados de la empresa."},403);
    const server=Deno.env.get("LIVEKIT_URL"), key=Deno.env.get("LIVEKIT_API_KEY"), secret=Deno.env.get("LIVEKIT_API_SECRET");
    if(!server?.startsWith("wss://")||!key||!secret)return reply({error:"El servidor de voz aún no está configurado."},503);
    const room=peer?"sg-private-"+workspace+"-"+users.sort().join("-"):"sg-general-"+workspace;
    const name=String(user.user_metadata?.full_name||user.email?.split("@")[0]||"Empleado").slice(0,70);
    const token=new AccessToken(key,secret,{identity:user.id,name,ttl:"4m"});
    token.addGrant({room,roomJoin:true,canSubscribe:true,canPublish:true,canPublishSources:[TrackSource.MICROPHONE],canPublishData:!peer});
    return reply({url:server,token:await token.toJwt(),identity:user.id});
  }catch(error){
    console.error("sg10-walkie",error instanceof Error?error.name:"database");
    return reply({error:"No se pudo acceder al canal de voz."},502);
  }
});
