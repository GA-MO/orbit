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
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import webpush from 'web-push'

const DATA_DIR = path.join(os.homedir(), '.orbit')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json')
/* The VAPID subject identifies whoever is pushing, and Apple validates it:
   `mailto:orbit@localhost` — the obvious choice for a machine that only talks to
   itself — comes back 403 BadJwtToken, because localhost is not a real mail
   domain. A reserved example domain is syntactically valid and goes nowhere.
   Override with `vapidContact` in ~/.orbit/config.json to be reachable. */
const DEFAULT_CONTACT = 'mailto:orbit@example.com'

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
const contact = (() => {
  const configured = readConfig().vapidContact
  return typeof configured === 'string' && /^(mailto:|https:)/.test(configured)
    ? configured
    : DEFAULT_CONTACT
})()
webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey)

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

/* Apple's push host resolves to both families, and Node's happy-eyeballs racer
   times out against every address of both on this network while curl connects
   in under a second. Turning the race off is enough; if the machine ever does
   prefer a broken IPv6 answer, {@link send} falls back to forcing IPv4. A
   loopback mock cannot reproduce any of this — it only showed up against the
   real service. */
const agent = new https.Agent({ autoSelectFamily: false })
const ipv4Agent = new https.Agent({ autoSelectFamily: false, family: 4 })

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

  const deliver = async (subscription: Subscription): Promise<boolean> => {
    try {
      await webpush.sendNotification(subscription, payload, { agent })
      return true
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      // The push service answered — it just said no.
      if (status === 404 || status === 410) {
        unsubscribe(subscription.endpoint)
        return false
      }
      if (status !== undefined) {
        console.error(`[orbit] push rejected (${status}):`, (err as { body?: string }).body ?? '')
        return false
      }
      // Never got that far: retry once on IPv4 before giving up on the network.
      try {
        await webpush.sendNotification(subscription, payload, { agent: ipv4Agent })
        return true
      } catch (retry) {
        console.error('[orbit] push unreachable:', (retry as { code?: string }).code ?? retry)
        return false
      }
    }
  }

  const results = await Promise.all(subscriptions.map(deliver))
  return results.filter(Boolean).length
}
