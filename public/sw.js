/* CozyTally service worker: push notifications + PWA install */

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
