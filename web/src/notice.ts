import { pushKey, subscribeToPush } from './api'

export type NoticePermission = 'unsupported' | 'default' | 'granted' | 'denied'

const NOTICE_TAG = 'orbit-notice'
const NOTICE_ICON = '/icon-192.png'

export const noticePermission = (): NoticePermission => {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported'
  }
  return Notification.permission as NoticePermission
}

export async function enableNotices(): Promise<NoticePermission> {
  if (noticePermission() === 'unsupported') return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission === 'granted') await registerPush()
  return permission as NoticePermission
}

export async function registerPush(): Promise<boolean> {
  if (noticePermission() !== 'granted') return false
  try {
    const registration = await navigator.serviceWorker.ready
    const { publicKey } = await pushKey()
    const existing = await registration.pushManager.getSubscription()
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64urlToBytes(publicKey),
      }))
    await subscribeToPush(subscription.toJSON())
    return true
  } catch {
    return false
  }
}

const currentSubscription = async (): Promise<PushSubscription | null> => {
  const registration = await navigator.serviceWorker?.ready
  return (await registration?.pushManager.getSubscription()) ?? null
}

export async function pushEndpoint(): Promise<string | null> {
  try {
    const subscription = await currentSubscription()
    return subscription?.endpoint ?? null
  } catch {
    return null
  }
}

export async function dropPush(): Promise<void> {
  try {
    const subscription = await currentSubscription()
    await subscription?.unsubscribe()
  } catch {
    return
  }
}

function base64urlToBytes(base64url: string): ArrayBuffer {
  const padding = (4 - (base64url.length % 4)) % 4
  const base64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(base64url.length + padding, '=')
  const raw = atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return buffer
}

export async function systemNotice(message: string): Promise<void> {
  if (noticePermission() !== 'granted') return
  try {
    const registration = await navigator.serviceWorker?.ready
    if (!registration) return
    const onScreen = await registration.getNotifications({ tag: NOTICE_TAG })
    const alreadyShowingThisMessage = onScreen.some((n) => n.body === message)
    if (alreadyShowingThisMessage) return
    await registration.showNotification('Orbit', {
      body: message,
      icon: NOTICE_ICON,
      tag: NOTICE_TAG,
    })
  } catch {
    return
  }
}
