/**
 * Notices from the Mac, shown where they can actually be seen.
 *
 * The in-app toast only helps while Orbit is on screen — which is exactly when
 * you did not need telling. A locked phone is worse than hidden: iOS freezes the
 * page and drops its WebSocket, so the notice reaches nothing at all. Web Push
 * is the only channel that survives that, because the push service wakes the
 * service worker with the app closed.
 *
 * So this module's real job is getting a push subscription registered, and iOS
 * only grants one from a real tap inside an installed PWA — never on page load.
 */
import { pushKey, subscribeToPush } from './api'

export type NoticePermission = 'unsupported' | 'default' | 'granted' | 'denied'

export const noticePermission = (): NoticePermission => {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported'
  }
  return Notification.permission as NoticePermission
}

/** Must be called from a user gesture: iOS refuses the prompt otherwise. */
export async function enableNotices(): Promise<NoticePermission> {
  if (noticePermission() === 'unsupported') return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission === 'granted') await registerPush()
  return permission as NoticePermission
}

/** Re-register on every launch: subscriptions expire and endpoints rotate. */
export async function registerPush(): Promise<boolean> {
  if (noticePermission() !== 'granted') return false
  try {
    const registration = await navigator.serviceWorker.ready
    const { publicKey } = await pushKey()
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      }))
    await subscribeToPush(subscription.toJSON())
    return true
  } catch {
    // No push is a degraded phone, not a broken app — the toast still works.
    return false
  }
}

/**
 * This browser's push endpoint, if it has one — the id the Mac knows it by.
 *
 * The server stores a flat list of endpoints and cannot tell which of them is
 * the phone making a request, so un-pairing has to say. Read separately from
 * {@link dropPush} on purpose: the endpoint is handed to the server first and
 * only cancelled here once that succeeded, so a failed un-pair leaves a phone
 * that still gets its notifications rather than one silently cut off from them.
 */
export async function pushEndpoint(): Promise<string | null> {
  try {
    const registration = await navigator.serviceWorker?.ready
    const subscription = await registration?.pushManager.getSubscription()
    return subscription?.endpoint ?? null
  } catch {
    return null
  }
}

/**
 * Cancel this browser's subscription with the push service.
 *
 * Dropping the server's copy is not enough on its own: the subscription belongs
 * to the browser, survives the app being closed and would be handed straight
 * back the next time anything called `registerPush` — including the very next
 * pairing, which is fine, but also a stale one nobody asked for. Cancelling
 * both ends means a phone that has been signed out is a phone Apple has nothing
 * to deliver to.
 */
export async function dropPush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.ready
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  } catch {
    // The server has already forgotten the endpoint; a push to it now 410s and
    // is pruned there. Failing here is not worth stopping the sign-out for.
  }
}

/** VAPID keys travel as base64url; PushManager wants the raw bytes. */
function decodeKey(base64url: string): ArrayBuffer {
  const padded = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=')
  const raw = atob(padded)
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return buffer
}

/**
 * Shown while the app is merely hidden — switched away from but not yet frozen.
 * Anything deeper asleep than that is the push channel's job.
 */
export async function systemNotice(message: string): Promise<void> {
  if (noticePermission() !== 'granted') return
  try {
    const registration = await navigator.serviceWorker?.ready
    if (!registration) return
    /* The push channel may have put this very message on the screen already —
       the shared tag is supposed to make the second one replace the first, and
       on iOS it does not always. Ask what is up there and say nothing twice. */
    const showing = await registration.getNotifications({ tag: 'orbit-notice' })
    if (showing.some((n) => n.body === message)) return
    await registration.showNotification('Orbit', {
      body: message,
      icon: '/icon-192.png',
      tag: 'orbit-notice',
    })
  } catch {
    // notifications are a courtesy; the toast already fired
  }
}
