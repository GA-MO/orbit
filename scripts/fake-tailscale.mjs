#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOST = 'smoke-mac.example-tailnet.ts.net'
const OWNER_USER_ID = 1001
const OWNER_LOGIN = 'smoke-owner@example.com'
const ORBIT_HOME = process.env.ORBIT_HOME ?? path.join(process.env.HOME ?? os.homedir(), '.orbit')
const STATE_FILE = process.env.ORBIT_FAKE_TAILSCALE_STATE ?? path.join(ORBIT_HOME, 'fake-tailscale.json')
const FRONT_DOOR_PUBLIC_PORT = 443
const FRONT_DOOR = [{ publicPort: FRONT_DOOR_PUBLIC_PORT, port: 7788 }]

const readMappings = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return Array.isArray(saved) ? saved : FRONT_DOOR
  } catch {
    return FRONT_DOOR
  }
}

const writeMappings = (mappings) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(mappings))
}

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const httpsPortFlag = (flags) => Number(flags.find((flag) => flag.startsWith('--https='))?.split('=')[1])

const printVersion = () => process.stdout.write('1.0.0-fake\n')

const printStatus = () =>
  process.stdout.write(
    JSON.stringify({
      Self: { DNSName: `${HOST}.`, UserID: OWNER_USER_ID },
      User: {
        [OWNER_USER_ID]: { ID: OWNER_USER_ID, LoginName: OWNER_LOGIN, DisplayName: 'Smoke Owner' },
      },
    }),
  )

const printServeStatus = () => {
  const web = {}
  for (const mapping of readMappings()) {
    web[`${HOST}:${mapping.publicPort}`] = {
      Handlers: { '/': { Proxy: `http://127.0.0.1:${mapping.port}` } },
    }
  }
  process.stdout.write(JSON.stringify({ Web: web }))
}

const serveOff = (flags) => {
  const publicPort = httpsPortFlag(flags)
  const mappings = readMappings()
  if (!mappings.some((mapping) => mapping.publicPort === publicPort)) fail(`nothing is serving on ${publicPort}`)
  writeMappings(mappings.filter((mapping) => mapping.publicPort !== publicPort))
}

const serveInBackground = (flags) => {
  const publicPort = httpsPortFlag(flags) || FRONT_DOOR_PUBLIC_PORT
  const port = Number(flags.at(-1))
  if (!port) fail('serve: expected [--https=<port>] <target>')
  const others = readMappings().filter((mapping) => mapping.publicPort !== publicPort)
  writeMappings([...others, { publicPort, port }])
  process.stdout.write(`Available within your tailnet:\nhttps://${HOST}:${publicPort}/\n`)
}

const args = process.argv.slice(2)
const [command, ...rest] = args

if (command === 'version') {
  printVersion()
} else if (command === 'status' && rest[0] === '--json') {
  printStatus()
} else if (command === 'serve' && rest[0] === 'status') {
  printServeStatus()
} else if (command === 'serve' && rest.at(-1) === 'off') {
  serveOff(rest)
} else if (command === 'serve' && rest.includes('--bg')) {
  serveInBackground(rest)
} else {
  fail(`fake-tailscale: nothing here answers \`tailscale ${args.join(' ')}\``)
}
