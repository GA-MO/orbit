import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { packageVersion } from './version.js'
import { PORT } from './port.js'

const execFileAsync = promisify(execFile)

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'orbit', version: packageVersion() }
const BASE = `http://127.0.0.1:${PORT}`
const SESSION_ID = process.env.ORBIT_SESSION_ID || null
const MAX_IMAGE_WIDTH = 1568
const CONFIG_PATH = path.join(process.env.ORBIT_HOME || os.homedir(), '.orbit', 'config.json')
const ERROR_BODY_PREVIEW_CHARS = 200

const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602
const JSON_RPC_INTERNAL_ERROR = -32603

const readToken = (): string => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (typeof config.token === 'string') return config.token
  } catch {}
  return ''
}

const api = async (route: string, body: unknown): Promise<any> => {
  let res: Response
  try {
    res = await fetch(BASE + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readToken()}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(`the Orbit server is not reachable on ${BASE} — start it with \`npm start -w server\``)
  }
  const text = await res.text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { error: text.slice(0, ERROR_BODY_PREVIEW_CHARS) }
  }
  if (!res.ok) throw new Error(parsed.error ?? `${route} failed (${res.status})`)
  return parsed
}

const downscaledCopy = async (filePath: string): Promise<string | null> => {
  const scaled = path.join(os.tmpdir(), `orbit-mcp-${path.basename(filePath)}`)
  const ok = await execFileAsync('/usr/bin/sips', ['-Z', String(MAX_IMAGE_WIDTH), filePath, '--out', scaled])
    .then(() => true)
    .catch(() => false)
  return ok ? scaled : null
}

const imageContent = async (filePath: string, width: number | null) => {
  const needsDownscale = !!width && width > MAX_IMAGE_WIDTH
  const source = (needsDownscale && (await downscaledCopy(filePath))) || filePath
  const data = await fsp.readFile(source, 'base64')
  if (source !== filePath) await fsp.rm(source, { force: true })
  return { type: 'image', data, mimeType: 'image/png' }
}

const text = (value: string) => ({ type: 'text', text: value })

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, any>): Promise<{ content: unknown[] }>
}

const TOOLS: Tool[] = [
  {
    name: 'orbit_capture',
    description:
      'Render a running web app in headless Chrome and return the screenshot as an image. Use it to check your own UI work instead of asking the user to look. The capture also appears in the Preview tab on their phone.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL of the running app, e.g. http://localhost:5173' },
        preset: {
          type: 'string',
          enum: ['phone', 'tablet', 'desktop'],
          description: 'Viewport to render at. Defaults to phone (390x844).',
        },
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of one viewport.' },
      },
      required: ['url'],
    },
    async run(args) {
      const shot = await api('/api/screenshot', {
        url: args.url,
        preset: args.preset,
        fullPage: !!args.fullPage,
      })
      return {
        content: [
          await imageContent(shot.path, shot.width),
          text(`${args.preset ?? 'phone'} capture of ${args.url} — saved to ${shot.path}`),
        ],
      }
    },
  },
  {
    name: 'orbit_screen',
    description:
      "Capture the Mac's own screen and return it as an image — for anything headless Chrome cannot render: an iOS Simulator, a native app, Xcode, a desktop tool. Requires Screen Recording permission for the process running the Orbit server.",
    inputSchema: {
      type: 'object',
      properties: {
        display: { type: 'number', description: 'Display number for a multi-monitor setup (1 is the main display).' },
      },
    },
    async run(args) {
      const shot = await api('/api/screenshot', { source: 'screen', display: args.display })
      return {
        content: [await imageContent(shot.path, shot.width), text(`Mac screen — saved to ${shot.path}`)],
      }
    },
  },
  {
    name: 'orbit_notify',
    description:
      'Send a short message to the phone running Orbit. Use it when a long task finishes or you are about to need the user, so they do not have to watch the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'One line, e.g. "Migration finished — 42 files changed".' },
        kind: {
          type: 'string',
          enum: ['done', 'waiting'],
          description:
            'done (default) — worth knowing, nothing is held up. waiting — you have stopped and cannot go on until the user answers; the phone keeps this one until it is read and counts it as a session needing attention.',
        },
      },
      required: ['message'],
    },
    async run(args) {
      const kind = args.kind === 'waiting' ? 'waiting' : 'done'
      const { delivered } = await api('/api/notify', {
        message: args.message,
        kind,
        source: process.cwd(),
        sessionId: SESSION_ID,
      })
      const nobodySawIt =
        kind === 'waiting'
          ? 'No phone is connected right now — it is held against this session until someone reads it.'
          : 'No phone is connected right now — the message was not shown.'
      return {
        content: [text(delivered > 0 ? `Delivered to ${delivered} connected phone(s).` : nobodySawIt)],
      }
    },
  },
  {
    name: 'orbit_preview',
    description:
      "Open a running dev server on the user's phone, on a route you choose. Use it when they asked to see something, or when you changed a page and want them to look at it rather than at a screenshot. Needs a dev server already running on that port; Orbit publishes it over the tailnet and the phone opens it in a frame over the terminal, so they do not lose the session. Prefer orbit_capture when you want to check the work yourself.",
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: "The dev server's port on the Mac, e.g. 5173." },
        path: {
          type: 'string',
          description: 'Route to land on, e.g. /settings or /orders?status=open. Defaults to /.',
        },
      },
      required: ['port'],
    },
    async run(args) {
      const opened = await api('/api/preview', {
        port: args.port,
        path: args.path,
        source: process.cwd(),
        sessionId: SESSION_ID,
      })
      const reached =
        opened.delivered > 0
          ? `Opened on ${opened.delivered} connected phone(s).`
          : 'No phone is connected right now — a notice was left saying where to look, but nobody has seen the page.'
      return { content: [text(`${opened.url} — ${reached}`)] }
    },
  },
  {
    name: 'orbit_ask',
    description:
      'Ask the user a question on their phone and wait for them to tap an answer. Use it for decisions you genuinely cannot make alone. Returns the chosen option, or reports that nobody answered in time.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, short enough to read on a phone.' },
        detail: { type: 'string', description: 'Optional context shown under the question — a command, a diff, a path.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 4 choices. Defaults to Allow / Deny.',
        },
        timeoutSeconds: { type: 'number', description: 'How long to wait (5-600, default 120).' },
      },
      required: ['question'],
    },
    async run(args) {
      const result = await api('/api/ask', {
        question: args.question,
        detail: args.detail,
        options: args.options,
        timeoutSeconds: args.timeoutSeconds,
        source: process.cwd(),
        sessionId: SESSION_ID,
      })
      if (result.timedOut) {
        return {
          content: [
            text(
              result.phonesConnected === 0
                ? 'Nobody answered — no phone was connected to Orbit. Decide without them or stop and explain.'
                : 'Nobody answered in time. Do not assume approval.',
            ),
          ],
        }
      }
      return { content: [text(`The user answered: ${result.answer}`)] }
    },
  },
]

const write = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}
const reply = (id: unknown, result: unknown): void => write({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, code: number, message: string): void =>
  write({ jsonrpc: '2.0', id, error: { code, message } })

const isNotification = (msg: any): boolean => msg.id === undefined

const callTool = async (id: unknown, params: any): Promise<void> => {
  const tool = TOOLS.find((t) => t.name === params?.name)
  if (!tool) return fail(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${params?.name}`)
  try {
    return reply(id, await tool.run(params.arguments ?? {}))
  } catch (err) {
    return reply(id, { content: [text(`${tool.name} failed: ${(err as Error).message}`)], isError: true })
  }
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg
  if (isNotification(msg)) return

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })
    case 'tools/call':
      return callTool(id, params)
    default:
      return fail(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`)
  }
}

const handleLine = (line: string): void => {
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  handle(msg).catch((err) => fail(msg.id, JSON_RPC_INTERNAL_ERROR, (err as Error).message))
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline: number
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handleLine(line)
  }
})
process.stdin.on('end', () => process.exit(0))
