/**
 * Web Push — the only way to reach a phone that is asleep.
 *
 * The notice channel rides the WebSocket, which iOS drops the moment the screen
 * locks: the message is broadcast to nobody and the page that would have raised
 * a notification is frozen. A push instead goes to Apple, which wakes the
 * service worker with the app closed. That is the whole point of "tell me when
 * the long thing finishes".
 *
 * Push only fires when the live channel found nobody — a phone with Orbit open
 * gets a toast and should not also get a system banner for the same event.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import webpush from 'web-push'

const DATA_DIR = path.join(os.homedir(), '.orbit')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json')
/** Apple wants a contact for the pushing application; nothing is sent to it. */
const CONTACT = 'mailto:orbit@localhost'

export interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

const readConfig = (): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

/* The keypair identifies this server to the push service for the life of a
   subscription — regenerating it would silently invalidate every phone, so it
   lives beside the access token rather than in memory. */
const loadKeys = (): { publicKey: string; privateKey: string } => {
  const config = readConfig()
  const existing = config.vapid as { publicKey?: string; privateKey?: string } | undefined
  if (existing?.publicKey && existing?.privateKey) {
    return { publicKey: existing.publicKey, privateKey: existing.privateKey }
  }
  const keys = webpush.generateVAPIDKeys()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, vapid: keys }, null, 2))
  return keys
}

const keys = loadKeys()
webpush.setVapidDetails(CONTACT, keys.publicKey, keys.privateKey)

export const publicKey = (): string => keys.publicKey

// ---- Subscriptions ----

let subscriptions: Subscription[] = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
})()

const persist = () => {
  fsp
    .writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2))
    .catch((err) => console.error('[orbit] failed to persist push subscriptions:', err))
}

export const count = () => subscriptions.length

export function subscribe(subscription: Subscription): void {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error('malformed subscription')
  }
  // Re-subscribing renews the same endpoint rather than piling up duplicates.
  subscriptions = [
    ...subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
    { endpoint: subscription.endpoint, keys: subscription.keys },
  ]
  persist()
}

export function unsubscribe(endpoint: string): void {
  const before = subscriptions.length
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint)
  if (subscriptions.length !== before) persist()
}

/**
 * Push to every registered device. Returns how many accepted it.
 * Endpoints the push service has retired are dropped — a phone that reinstalls
 * the app leaves one behind, and a dead endpoint fails every time otherwise.
 */
export async function send(title: string, body: string): Promise<number> {
  if (subscriptions.length === 0) return 0
  const payload = JSON.stringify({ title, body })
  const results = await Promise.all(
    subscriptions.map((s) =>
      webpush
        .sendNotification(s, payload)
        .then(() => true)
        .catch((err: { statusCode?: number }) => {
          if (err.statusCode === 404 || err.statusCode === 410) unsubscribe(s.endpoint)
          else console.error('[orbit] push failed:', err.statusCode ?? err)
          return false
        }),
    ),
  )
  return results.filter(Boolean).length
}
