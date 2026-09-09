const CACHE = 'orbit-__BUILD__'
const APP_SHELL = '/'
const ICON = '/icon-192.png'
const ASK_TAG = 'orbit-ask'
const NOTICE_TAG = 'orbit-notice'
const ANSWER_ACTION_PREFIX = 'answer:'
const BANNER_ACTION_LIMIT = 2
const UNCACHED_PATHS = ['/ws', '/healthz']
const API_PREFIX = '/api/'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(APP_SHELL)))
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

const readPushPayload = (data) => {
  let payload = { title: 'Orbit', body: '', sessionId: null, ask: null }
  try {
    payload = { ...payload, ...data.json() }
  } catch {
    payload.body = data ? data.text() : ''
  }
  return payload
}

const answerableAsk = (ask) => (ask && ask.id && ask.token ? ask : null)

const bannerActionsFor = (ask) =>
  (ask?.options ?? []).slice(0, BANNER_ACTION_LIMIT).map((option) => ({
    action: `${ANSWER_ACTION_PREFIX}${option}`,
    title: option,
  }))

self.addEventListener('push', (event) => {
  const payload = readPushPayload(event.data)
  const ask = answerableAsk(payload.ask)
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: ICON,
      badge: ICON,
      tag: ask ? ASK_TAG : NOTICE_TAG,
      renotify: true,
      actions: bannerActionsFor(ask),
      data: { sessionId: payload.sessionId ?? null, ask },
    }),
  )
})

const postAnswer = (ask, choice) =>
  fetch('/api/ask/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ask.id, token: ask.token, choice }),
  })

const showAnswerFailed = (sessionId, ask) =>
  self.registration.showNotification('Orbit could not answer', {
    body: 'The Mac did not take it. Open Orbit to answer.',
    icon: ICON,
    badge: ICON,
    tag: ASK_TAG,
    data: { sessionId, ask },
  })

const sessionUrl = (sessionId) =>
  sessionId ? `/?session=${encodeURIComponent(sessionId)}` : APP_SHELL

const postSessionInsteadOfNavigateForWebKit = (openWindow, sessionId) => {
  if (sessionId) openWindow.postMessage({ type: 'orbit-open-session', sessionId })
  return openWindow.focus()
}

const openOrFocusSession = (sessionId) =>
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const openWindow = windows.find((w) => 'focus' in w)
    if (!openWindow) return self.clients.openWindow(sessionUrl(sessionId))
    return postSessionInsteadOfNavigateForWebKit(openWindow, sessionId)
  })

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = event.notification.data?.sessionId ?? null
  const ask = event.notification.data?.ask ?? null

  if (ask && event.action?.startsWith(ANSWER_ACTION_PREFIX)) {
    const choice = event.action.slice(ANSWER_ACTION_PREFIX.length)
    event.waitUntil(postAnswer(ask, choice).catch(() => showAnswerFailed(sessionId, ask)))
    return
  }

  event.waitUntil(openOrFocusSession(sessionId))
})

const isUncacheable = (url) =>
  url.pathname.startsWith(API_PREFIX) || UNCACHED_PATHS.includes(url.pathname)

const isCacheableResponse = (response) => response.ok && response.type === 'basic'

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  if (isUncacheable(new URL(request.url))) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (isCacheableResponse(response)) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(() => caches.match(request).then((match) => match ?? caches.match(APP_SHELL))),
  )
})
