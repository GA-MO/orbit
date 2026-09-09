#!/usr/bin/env node
/**
 * A `tailscale` that publishes nothing.
 *
 * The preview section of the smoke suite used to run against the real CLI, or
 * not at all: skipped on any machine where Tailscale was missing or logged out
 * (so, in practice, never proving anything on a fresh checkout), and on the
 * machines where it *did* run it published real mappings on the real tailnet —
 * one of which, `:8443 → 127.0.0.1:3099`, outlived the throwaway server it
 * pointed at and confused a debugging session weeks later. A test that reaches
 * outside the scratch HOME is a test that can leave something behind.
 *
 * So: `ORBIT_TAILSCALE` points `preview.ts` here instead. This answers the four
 * invocations that module makes, keeps its mappings in a JSON file under the
 * test's own HOME, and touches no network at all. It is a stand-in for the CLI,
 * not for Tailscale — what it proves is that Orbit reads `serve status --json`,
 * picks a free public port, spots the front door and takes a mapping down
 * again. Whether the tailnet then carries the traffic is not a question a test
 * on one machine can answer.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOST = 'smoke-mac.example-tailnet.ts.net'
const STATE =
  process.env.ORBIT_FAKE_TAILSCALE_STATE ??
  path.join(process.env.HOME ?? os.homedir(), '.orbit', 'fake-tailscale.json')

/* The front door is seeded rather than published, because that is what it is on
   a real machine: `make phone-on` put it there long before any of this ran, and
   Orbit has to leave it alone without ever having been told about it. */
const SEED = [{ publicPort: 443, port: 3001 }]

const read = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    return Array.isArray(saved) ? saved : SEED
  } catch {
    return SEED
  }
}

const write = (mappings) => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  fs.writeFileSync(STATE, JSON.stringify(mappings))
}

const fail = (message) => {
  // The CLI's useful words come out on stderr, and `preview.ts` reads them.
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const [command, ...rest] = args

if (command === 'version') {
  process.stdout.write('1.0.0-fake\n')
} else if (command === 'status' && rest[0] === '--json') {
  // Trailing dot included: a real DNSName has one, and `preview.ts` strips it.
  process.stdout.write(JSON.stringify({ Self: { DNSName: `${HOST}.` } }))
} else if (command === 'serve' && rest[0] === 'status') {
  const web = {}
  for (const m of read()) {
    web[`${HOST}:${m.publicPort}`] = {
      Handlers: { '/': { Proxy: `http://127.0.0.1:${m.port}` } },
    }
  }
  process.stdout.write(JSON.stringify({ Web: web }))
} else if (command === 'serve' && rest.at(-1) === 'off') {
  const publicPort = Number(rest.find((a) => a.startsWith('--https='))?.split('=')[1])
  const mappings = read()
  if (!mappings.some((m) => m.publicPort === publicPort)) fail(`nothing is serving on ${publicPort}`)
  write(mappings.filter((m) => m.publicPort !== publicPort))
} else if (command === 'serve' && rest.includes('--bg')) {
  const publicPort = Number(rest.find((a) => a.startsWith('--https='))?.split('=')[1])
  const port = Number(rest.at(-1))
  if (!publicPort || !port) fail('serve: expected --https=<port> <target>')
  const mappings = read().filter((m) => m.publicPort !== publicPort)
  write([...mappings, { publicPort, port }])
  process.stdout.write(`Available within your tailnet:\nhttps://${HOST}:${publicPort}/\n`)
} else {
  fail(`fake-tailscale: nothing here answers \`tailscale ${args.join(' ')}\``)
}
