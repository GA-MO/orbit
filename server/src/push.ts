import fs from 'node:fs'
import fsp from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'

import { orbitDir } from './home.js'
import webpush from 'web-push'

const DATA_DIR = orbitDir()
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json')
const DEFAULT_CONTACT = 'mailto:orbit@example.com'
const OWNER_ONLY = 0o600

const MAX_TOPIC_LENGTH = 32
const TOPIC_ALPHABET = /^[A-Za-z0-9_-]+$/
const CONTACT_SCHEME = /^(mailto:|https:)/
const HTTPS_ENDPOINT = /^https:\/\//
const MAX_SUBSCRIPTIONS = 32
const SEND_TIMEOUT_MS = 10_000
const THIRTY_MINUTES_S = 30 * 60

export interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface Shelf {
  ttlSeconds: number
  topic: string
}

const isBase64DecodableLength = (length: number): boolean => length % 4 !== 1

export const topicIsValid = (topic: string): boolean =>
  topic.length > 0 &&
  topic.length <= MAX_TOPIC_LENGTH &&
  isBase64DecodableLength(topic.length) &&
  TOPIC_ALPHABET.test(topic)

export const NOTICE: Shelf = { ttlSeconds: THIRTY_MINUTES_S, topic: 'orbit-notice' }

export const WAITING: Shelf = { ttlSeconds: THIRTY_MINUTES_S, topic: 'orbit-idle' }

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

interface VapidKeys {
  publicKey: string
  privateKey: string
}

const storedVapidKeys = (config: Record<string, unknown>): VapidKeys | null => {
  const existing = config.vapid as Partial<VapidKeys> | undefined
  if (existing?.publicKey && existing?.privateKey) {
    return { publicKey: existing.publicKey, privateKey: existing.privateKey }
  }
  return null
}

const generateAndStoreVapidKeys = (config: Record<string, unknown>): VapidKeys => {
  const keys = webpush.generateVAPIDKeys()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, vapid: keys }, null, 2), { mode: OWNER_ONLY })
  fs.chmodSync(CONFIG_FILE, OWNER_ONLY)
  return keys
}

const loadKeys = (): VapidKeys => {
  const config = readConfig()
  return storedVapidKeys(config) ?? generateAndStoreVapidKeys(config)
}

const assertTopicsAcceptable = () => {
  for (const shelf of [NOTICE, WAITING, question(60)]) {
    if (!topicIsValid(shelf.topic)) {
      throw new Error(`[orbit] push topic a push service will reject: ${shelf.topic}`)
    }
  }
}

const vapidContact = (): string => {
  const configured = readConfig().vapidContact
  return typeof configured === 'string' && CONTACT_SCHEME.test(configured) ? configured : DEFAULT_CONTACT
}

assertTopicsAcceptable()

const keys = loadKeys()
webpush.setVapidDetails(vapidContact(), keys.publicKey, keys.privateKey)

export const publicKey = (): string => keys.publicKey

const loadSubscriptions = (): Subscription[] => {
  try {
    const list = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

let subscriptions: Subscription[] = loadSubscriptions()

const persist = () => {
  fsp
    .writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2), { mode: OWNER_ONLY })
    .catch((err) => console.error('[orbit] failed to persist push subscriptions:', err))
}

export const count = () => subscriptions.length

const agent = new https.Agent({ autoSelectFamily: false })
const ipv4Agent = new https.Agent({ autoSelectFamily: false, family: 4 })

const isWellFormed = (subscription: Subscription): boolean =>
  Boolean(subscription?.endpoint && subscription.keys?.p256dh && subscription.keys?.auth)

const isKnownEndpoint = (endpoint: string): boolean => subscriptions.some((s) => s.endpoint === endpoint)

export function subscribe(subscription: Subscription): void {
  if (!isWellFormed(subscription)) throw new Error('malformed subscription')
  if (!HTTPS_ENDPOINT.test(subscription.endpoint)) throw new Error('endpoint must be https')
  if (subscriptions.length >= MAX_SUBSCRIPTIONS && !isKnownEndpoint(subscription.endpoint)) {
    throw new Error('too many push subscriptions')
  }
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

const ENDPOINT_GONE_STATUSES = [404, 410]

const statusOf = (err: unknown): number | undefined => (err as { statusCode?: number }).statusCode

export async function send(
  title: string,
  body: string,
  sessionId: string | null = null,
  shelf: Shelf = NOTICE,
  extra: Record<string, unknown> = {},
): Promise<number> {
  if (subscriptions.length === 0) return 0
  const payload = JSON.stringify({ title, body, sessionId, ...extra })
  const options = {
    TTL: Math.max(0, Math.round(shelf.ttlSeconds)),
    topic: shelf.topic,
    timeout: SEND_TIMEOUT_MS,
  }

  const retryOverIpv4 = async (subscription: Subscription): Promise<boolean> => {
    try {
      await webpush.sendNotification(subscription, payload, { ...options, agent: ipv4Agent })
      return true
    } catch (retry) {
      console.error('[orbit] push unreachable:', (retry as { code?: string }).code ?? retry)
      return false
    }
  }

  const deliver = async (subscription: Subscription): Promise<boolean> => {
    try {
      await webpush.sendNotification(subscription, payload, { ...options, agent })
      return true
    } catch (err) {
      const status = statusOf(err)
      if (status !== undefined && ENDPOINT_GONE_STATUSES.includes(status)) {
        unsubscribe(subscription.endpoint)
        return false
      }
      if (status !== undefined) {
        console.error(`[orbit] push rejected (${status}):`, (err as { body?: string }).body ?? '')
        return false
      }
      return retryOverIpv4(subscription)
    }
  }

  const results = await Promise.all(subscriptions.map(deliver))
  return results.filter(Boolean).length
}
