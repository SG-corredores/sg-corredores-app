self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method === 'POST' &&
      u.href === new URL('share-receive', self.registration.scope).href) {
    e.respondWith((async () => {
      const data = await e.request.formData();
      const c = await caches.open('sg-share-inbox');
      await c.put(
        new URL('share-inbox', self.registration.scope),
        new Response(data)
      );
      return Response.redirect(
        new URL('Index.html?shared=1', self.registration.scope),
        303
      );
    })());
  }
});

self.addEventListener('push', e => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { body: e.data.text() };
  }

  e.waitUntil(self.registration.showNotification(
    data.title || 'SG Corredores',
    {
      body: data.body || 'Hay una nueva actualización',
      vibrate: [200, 100, 200],
      data: {
        url: new URL('Index.html', self.registration.scope).href
      }
    }
  ));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.openWindow(
      new URL('Index.html', self.registration.scope).href
    )
  );
});
