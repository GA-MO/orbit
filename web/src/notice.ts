/**
 * Notices from the Mac, shown where they can actually be seen.
 *
 * The in-app toast only helps if the phone is awake and Orbit is on screen —
 * which is exactly when you did not need telling. When it is not, fall back to
 * a system notification. iOS only allows those from an installed PWA and only
 * through the service worker registration, so that path is tried first.
 */

let asked = false

export function requestNoticePermission(): void {
  if (asked || !('Notification' in window) || Notification.permission !== 'default') return
  asked = true
  Notification.requestPermission().catch(() => {})
}

export async function systemNotice(message: string): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const options = { body: message, icon: '/icon-192.png', tag: 'orbit-notice' }
  try {
    const registration = await navigator.serviceWorker?.ready
    if (registration) {
      await registration.showNotification('Orbit', options)
      return
    }
  } catch {
    // fall through to the plain constructor
  }
  try {
    new Notification('Orbit', options)
  } catch {
    // notifications are a courtesy; the toast already fired
  }
}
