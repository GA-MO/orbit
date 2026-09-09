/**
 * Orbit as an MCP server — the agent's side of the app.
 *
 * Everything here already exists in the phone UI; this exposes it to the agent
 * running inside an Orbit session, so it can look at its own work and reach the
 * person holding the phone without them driving every step:
 *
 *   orbit_capture   render a URL and *see* the picture (not a file path)
 *   orbit_screen    look at the Mac's screen — simulators, native apps, Xcode
 *   orbit_notify    say "done" — or "waiting for you" — to the phone
 *   orbit_preview   open the running app on their phone, on a route you choose
 *   orbit_ask       ask a question and wait for the tap
 *
 * Speaks JSON-RPC over stdio directly: the protocol surface an MCP server needs
 * is four methods, which is less code than wiring up a framework for it.
 *
 * Register with:  claude mcp add orbit -- node <repo>/server/dist/mcp.js
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PROTOCOL_VERSION = '2025-06-18'
const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const BASE = `http://127.0.0.1:${PORT}`
/* Inherited from the PTY the agent was launched in — this process is its
   grandchild. It lets a message be filed against the session it came out of
   rather than guessed at from a folder two sessions may share. Empty when
   Claude Code is running at the desk instead of through Orbit. */
const SESSION_ID = process.env.ORBIT_SESSION_ID || null
/** Claude resizes anything larger anyway; sending less costs the agent less. */
const MAX_IMAGE_WIDTH = 1568

const token = (): string => {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.orbit', 'config.json'), 'utf8'),
    )
    if (typeof config.token === 'string') return config.token
  } catch {
    // reported per call — the server may simply not have run yet
  }
  return ''
}

const api = async (route: string, body: unknown): Promise<any> => {
  let res: Response
  try {
    res = await fetch(BASE + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
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
    parsed = { error: text.slice(0, 200) }
  }
  if (!res.ok) throw new Error(parsed.error ?? `${route} failed (${res.status})`)
  return parsed
}

/* A retina screen is ~3500px wide; downscaling a copy keeps the original on
   disk full size while the agent gets something proportionate. */
const imageContent = async (filePath: string, width: number | null) => {
  let source = filePath
  if (width && width > MAX_IMAGE_WIDTH) {
    const scaled = path.join(os.tmpdir(), `orbit-mcp-${path.basename(filePath)}`)
    const ok = await execFileAsync('/usr/bin/sips', ['-Z', String(MAX_IMAGE_WIDTH), filePath, '--out', scaled])
      .then(() => true)
      .catch(() => false)
    if (ok) source = scaled
  }
  const data = await fsp.readFile(source, 'base64')
  if (source !== filePath) await fsp.rm(source, { force: true })
  return { type: 'image', data, mimeType: 'image/png' }
}

const text = (value: string) => ({ type: 'text', text: value })

// ---- Tools ----

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
        /* Without this every message an agent sent counted as "done", so the
           one thing worth interrupting someone for — work stopped, waiting on
           them — was the one thing it could not say. The hook could; the agent
           itself could not. */
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
      /* A `waiting` message is kept against the session, so "nobody saw it" is
         not the same answer it used to be — it is still going to be there. */
      const missed =
        kind === 'waiting'
          ? 'No phone is connected right now — it is held against this session until someone reads it.'
          : 'No phone is connected right now — the message was not shown.'
      return {
        content: [text(delivered > 0 ? `Delivered to ${delivered} connected phone(s).` : missed)],
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
        /* The whole reason this tool exists: a published preview lands on `/`,
           and the route worth showing is the one just changed. Asking the user
           to type it on a phone keyboard is the problem the port chips in the
           Preview tab were invented to remove. */
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
      /* Say plainly that nobody saw it. The frame cannot be opened after the
         fact, so what the user gets instead is a notice naming the port and
         path — worth telling the agent, which may want to mention it. */
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

// ---- JSON-RPC over stdio ----

const write = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}
const reply = (id: unknown, result: unknown): void => write({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, code: number, message: string): void =>
  write({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg
  // Notifications carry no id and expect no response.
  if (id === undefined) return

  switch (method) {
    case 'initialize':
      return reply(id, {
        // Agreeing to the client's version avoids a needless renegotiation.
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'orbit', version: '0.1.0' },
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`)
      try {
        return reply(id, await tool.run(params.arguments ?? {}))
      } catch (err) {
        // Tool failures belong in the conversation, not in the transport.
        return reply(id, { content: [text(`${tool.name} failed: ${(err as Error).message}`)], isError: true })
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline: number
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg).catch((err) => fail(msg.id, -32603, (err as Error).message))
  }
})
process.stdin.on('end', () => process.exit(0))
