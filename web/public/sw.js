const CACHE = 'orbit-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/')))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/* A push wakes this worker with the app closed and the phone locked — the one
   path that survives iOS freezing the page and dropping its WebSocket. */
self.addEventListener('push', (event) => {
  let payload = { title: 'Orbit', body: '', sessionId: null }
  try {
    payload = { ...payload, ...event.data.json() }
  } catch {
    payload.body = event.data ? event.data.text() : ''
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'orbit-notice',
      // Each notice replaces the last, but should still announce itself.
      renotify: true,
      // Carried through to the tap — see below.
      data: { sessionId: payload.sessionId ?? null },
    }),
  )
})

/* Tapping it should land in Orbit, reusing the open window if there is one —
   and on the session that raised it. A phone woken by this notification is by
   definition not on that session already, and dropping it wherever it was last
   left turns "Claude is waiting" into a hunt through the Sessions tab.
   A window that already exists cannot be navigated from here (WebKit ignores
   `navigate` on a standalone PWA client), so it is told instead. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = event.notification.data?.sessionId ?? null
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w)
      if (!open) {
        return self.clients.openWindow(sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/')
      }
      if (sessionId) open.postMessage({ type: 'orbit-open-session', sessionId })
      return open.focus()
    }),
  )
})

// Network-first for everything; cached shell only as an offline fallback.
// API and WebSocket traffic is never cached.
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/healthz') return

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone()
        caches.open(CACHE).then((cache) => cache.put(request, copy))
        return response
      })
      .catch(() =>
        caches.match(request).then((match) => match ?? caches.match('/')),
      ),
  )
})
