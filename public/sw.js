/*
 * UNO Adda service worker — Web Push only (no offline cache: the game
 * is live-online by design, and a stale cached client would be worse
 * than none). A push arrives as { title, body, url } (see src/push.js
 * fan-out in the AccountsDO notify route) and shows a system
 * notification even when the app is closed; tapping it focuses the
 * game tab or opens a fresh one.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'UNO Adda';
  const options = {
    body: data.body || '',
    icon: 'art/coin.webp',
    badge: 'art/coin.webp',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of wins) {
      if ('focus' in client) {
        try { await client.navigate(url); } catch { /* already there */ }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});
