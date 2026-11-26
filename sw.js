const CACHE = "sg10-shell-10.0.0-rc.10";
const base = self.registration.scope;
const url = (path) => new URL(path,base).href;
const shell = [
  "Index.html","index.html","version.json","sg10/purchase-work.js","portal.html","portal.webmanifest","manifest.webmanifest","sg10/common.js","sg10/staff.js","sg10/operations.js","sg10/walkie.js","sg10/walkie-realtime.js","sg10/walkie-audio.js","sg10/walkie-worklet.js","sg10/portal.js","sg10/portal-carousel.js","sg10/portal-aguacatin.js","sg10/aguacatin-controls.js","sg10/order-voice.js",
  "sg10/ui.css","sg10/portal.css","sg10/logotipo.png","sg10/portada-clientes.webp","sg10/aguacatin.png","sg10/palet-madera.jpg","icon-192.png","icon-512.png",
];
const allowed = new Set(shell.map(path => new URL(path,base).pathname));
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(shell.map(path => new Request(url(path),{cache:"reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SG_SKIP_WAITING") event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key.startsWith("sg10-shell-")) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const target = new URL(request.url);
  if (request.method === "POST" && target.href === url("share-receive")) {
    event.respondWith((async () => {
      const data = await request.formData();
      const inbox = await caches.open("sg-share-inbox");
      await inbox.put(url("share-inbox"),new Response(data));
      return Response.redirect(url("Index.html?shared=1"),303);
    })());
    return;
  }
  if (request.method !== "GET" || target.origin !== new URL(base).origin || !allowed.has(target.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request, {cache:"no-cache"});
      if (response.ok) return response;
    } catch {}
    const cache = await caches.open(CACHE);
    return await cache.match(target.origin + target.pathname) ?? Response.error();
  })());
});
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = {body:event.data?.text()}; }
  const target = new URL(data.portal === true ? "portal.html" : "Index.html",base);
  if (Number.isSafeInteger(data.event) && data.event > 0) target.searchParams.set("sg_event",String(data.event));
  event.waitUntil(self.registration.showNotification(
    typeof data.title === "string" ? data.title : "SG Corredores",
    { body:typeof data.body === "string" ? data.body : "Tienes un aviso nuevo.", icon:url("icon-192.png"),
      badge:url("icon-192.png"), tag:typeof data.tag === "string" ? data.tag : undefined, data:{url:target.href} },
  ));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? url("Index.html"),base);
  if (target.origin !== new URL(base).origin || ![url("Index.html"),url("portal.html")].includes(target.origin + target.pathname)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const active = windows.find(client => new URL(client.url).pathname === target.pathname);
    if (active) {
      await active.navigate(target.href);
      await active.focus();
    } else await self.clients.openWindow(target.href);
  })());
});
