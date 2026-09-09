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
 *
 * A push is a message handed to Apple, not a delivery: it is queued for a phone
 * that is off or out of range and handed over whenever it comes back. Everything
 * Orbit says is about *now* — "Claude is waiting", "the long thing finished" —
 * so every send says how long it stays true and what it supersedes. Without
 * that, the queue is four weeks deep (web-push's default TTL) and a Mac that has
 * been shut down all evening still lands a stack of banners on the phone.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'

import { orbitDir } from './home.js'
import webpush from 'web-push'

const DATA_DIR = orbitDir()
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

/** How long this message is worth delivering, and what it makes obsolete. */
export interface Shelf {
  /**
   * Seconds the push service may hold it for a phone it cannot reach. After
   * that it is dropped undelivered, which is the right outcome: a banner that
   * arrives tomorrow is not news, it is a puzzle.
   */
  ttlSeconds: number
  /**
   * Queued messages sharing a topic collapse to the most recent — the phone
   * that was away for an hour gets the last "Claude is waiting", not six of
   * them. Kept per kind so a question is never dropped by a notice: they are
   * different waits. See `topicIsValid` for what may go in one.
   */
  topic: string
}

/**
 * Whether a push service will accept this as a Topic.
 *
 * RFC 8030 calls a topic "up to 32 characters from the URL-safe base64
 * alphabet", which reads like a character rule and is not one: Apple decodes
 * the header, so a length that base64 could never have produced (`len % 4 === 1`)
 * comes back 400 BadWebPushTopic no matter what the characters are. It cost
 * five weeks to find, because `orbit-notice` is twelve characters by accident
 * and so every notice went through, while `orbit-waiting` (13) and `orbit-ask`
 * (9) were dropped at Apple every single time — into a `console.error` in a log
 * nobody opens.
 */
export const topicIsValid = (topic: string): boolean =>
  topic.length > 0 && topic.length <= 32 && topic.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(topic)

/**
 * A notice is Orbit reporting on this moment; half an hour later the terminal
 * it came from has almost certainly moved on. The in-app list (see `notify.ts`)
 * keeps it around far longer for anyone catching up on purpose — expiring the
 * push loses the interruption, not the message.
 */
export const NOTICE: Shelf = { ttlSeconds: 30 * 60, topic: 'orbit-notice' }

/**
 * "This session stopped and nobody told you." True for as long as the session
 * is still sitting there, which is indefinitely — but a banner about a pause
 * that started an hour ago is history, not news, so it keeps a notice's shelf.
 * Its own topic: a session going quiet must not drop an agent's own words, and
 * two sessions settling in the same minute collapse to the later one, which is
 * the correct summary of "something wants you".
 */
export const WAITING: Shelf = { ttlSeconds: 30 * 60, topic: 'orbit-idle' }

/** A question outlives its own banner by nothing: it stops waiting on timeout. */
export const question = (timeoutSeconds: number): Shelf => ({
  ttlSeconds: timeoutSeconds,
  topic: 'orbit-question',
})

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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, vapid: keys }, null, 2), { mode: 0o600 })
  // The file may predate the mode above; a private key next to the token deserves it either way.
  fs.chmodSync(CONFIG_FILE, 0o600)
  return keys
}

/* Checked here rather than at send time: the moment a topic matters is the
   moment the phone is away and nobody is watching the log. */
for (const shelf of [NOTICE, WAITING, question(60)]) {
  if (!topicIsValid(shelf.topic)) {
    throw new Error(`[orbit] push topic a push service will reject: ${shelf.topic}`)
  }
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
    .writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2), { mode: 0o600 })
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
  /* The endpoint is a URL this server will POST to on every notice. Push
     services are https, and one phone owns a handful of them at most; a list
     that grows past that is something other than phones. */
  if (!/^https:\/\//.test(subscription.endpoint)) throw new Error('endpoint must be https')
  if (subscriptions.length >= 32 && !subscriptions.some((s) => s.endpoint === subscription.endpoint)) {
    throw new Error('too many push subscriptions')
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
export async function send(
  title: string,
  body: string,
  /* Which session it came out of, so tapping the banner lands on that one
     rather than on whatever was last open — which, for a phone woken by this
     very notification, is almost never the session that sent it. */
  sessionId: string | null = null,
  shelf: Shelf = NOTICE,
  /* Anything the notification itself needs to act rather than merely announce
     — for a question, which one it is and the one-shot capability to answer it.
     Kept out of the signature's shape on purpose: a notice has nothing to add,
     and the worker treats what it does not recognise as absent. */
  extra: Record<string, unknown> = {},
): Promise<number> {
  if (subscriptions.length === 0) return 0
  const payload = JSON.stringify({ title, body, sessionId, ...extra })
  const options = { TTL: Math.max(0, Math.round(shelf.ttlSeconds)), topic: shelf.topic }

  /* A push service that accepts the connection and then says nothing would
     otherwise hold `/api/notify` — and the MCP tool call behind it — open
     for as long as the socket lived. */
  const timeout = 10_000
  const deliver = async (subscription: Subscription): Promise<boolean> => {
    try {
      await webpush.sendNotification(subscription, payload, { ...options, agent, timeout })
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
        await webpush.sendNotification(subscription, payload, { ...options, agent: ipv4Agent, timeout })
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
