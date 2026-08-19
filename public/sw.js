/* CozyTally service worker: the offline shell, push notifications, install.

   BUILD is substituted by the server the same way index.html's ?v=dev is, so
   every deploy gets its own cache and the old one is thrown away whole. That
   matters more than it sounds: a half-updated cache — new app.js against old
   games.js — is a bug you cannot reproduce and the user cannot clear. */
const BUILD = 'dev';
const SHELL = `ct-shell-${BUILD}`;
const MEDIA = 'ct-media'; // photos: user content, kept across builds
const FONTS = 'ct-fonts';
const MEDIA_MAX = 60;

/* Everything the app needs to draw itself with no network at all. Asked for
   with the build stamp, because that is how they are asked for on the page —
   a cache keyed on a different URL would never be hit. */
const SHELL_FILES = [
  '/',
  `/style.css?v=${BUILD}`,
  `/i18n.js?v=${BUILD}`,
  `/app.js?v=${BUILD}`,
  `/games.js?v=${BUILD}`,
  `/pet.js?v=${BUILD}`,
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith('ct-shell-') && n !== SHELL)
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

/** Keep the photo cache from growing without end. Oldest out, roughly. */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  /* Never the live parts. The socket is not a fetch, but the API is, and a
     cached answer about who is in a room or how much is in the pot would be a
     lie told confidently. */
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/ws')) {
    return;
  }

  /* The shell. Network first so a new deploy is picked up the moment it is
     there, cache second so a tunnel or a dead server still opens the app —
     every route (/, /r/..., /j/...) is the same page, so the cached '/' is
     the right answer for all of them. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/', { cacheName: SHELL }).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // Anything stamped with a build is immutable: that is what the stamp means.
  if (url.origin === location.origin && url.searchParams.has('v')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            if (res.ok) caches.open(SHELL).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  // Photos people uploaded. They never change under the same name, and they
  // are the part of a board most worth having on a train.
  if (url.origin === location.origin && url.pathname.startsWith('/u/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(MEDIA).then(async (c) => {
                await c.put(req, copy);
                await trim(MEDIA, MEDIA_MAX);
              });
            }
            return res;
          })
      )
    );
    return;
  }

  // Google Fonts, the one thing loaded from elsewhere. Cached so the app does
  // not change shape offline; if it never arrives, the fallback stack is fine.
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const live = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(FONTS).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || live;
      })
    );
    return;
  }

  // everything else: try the network, fall back to whatever was kept
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data.json();
  } catch {
    data = { title: 'CozyTally 🌙', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'CozyTally 🌙', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'cozytally',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).pathname === url && 'focus' in w) return w.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
