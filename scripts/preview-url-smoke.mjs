#!/usr/bin/env node
/**
 * The one barrier between a path an agent chose and a URL the phone opens.
 *
 * Every other suite here drives a live Orbit, because what they check only
 * exists once a server, a browser or a session is running. This one checks a
 * function of two strings, and a running server would add nothing to it — the
 * tailnet host `previewUrl` builds on is an argument, so the interesting cases
 * can be written down instead of arranged, and the whole file runs on a
 * machine with no tailscale on it at all. It imports the built module for the
 * same reason the others hit a built server: `scripts/test.sh` builds first, so
 * what is tested is what would ship.
 *
 *   scripts/test.sh preview-url     # or `make test-preview-url`
 *
* By hand: bun run build && bun scripts/preview-url-smoke.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { previewUrl } = await import(path.join(REPO, 'server/dist/preview.js'))

const BASE = 'https://mb-test.tailnet.ts.net:8443/'
/** The same host, so an expectation reads as the path it is really about. */
const at = (path) => `https://mb-test.tailnet.ts.net:8443${path}`

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** What came back, or the word the refusal used — either way, one string. */
const url = (input) => {
  try {
    return previewUrl(BASE, input)
  } catch (err) {
    return `refused: ${err.message}`
  }
}

const gives = (label, input, expected) =>
  check(label, url(input) === expected, `${JSON.stringify(input)} → ${url(input)}`)

const refuses = (label, input) =>
  check(label, url(input).startsWith('refused: '), `${JSON.stringify(input)} → ${url(input)}`)

// ---- the ordinary cases, which are most of them -------------------------

gives('no path at all is the published address itself', undefined, BASE)
gives('an empty string is the same as no path', '', BASE)
gives('so is whitespace, which is what a sloppy argument looks like', '  ', BASE)
gives('a bare slash is the root', '/', BASE)
gives('a plain route', '/orders', at('/orders'))
gives(
  'a route with no leading slash, which an agent will write',
  'orders',
  at('/orders'),
)
gives(
  'a query string and a fragment both survive',
  '/orders?status=open#top',
  at('/orders?status=open#top'),
)

// ---- the cases the function exists for ----------------------------------

// Two leading slashes is a URL with no scheme: `new URL` alone would read
// `evil.com` as the host and hand the phone somebody else's page.
gives(
  'a protocol-relative path is flattened onto our own host',
  '//evil.com/x',
  at('/evil.com/x'),
)
gives('and so is the backslash spelling of it', '\\\\evil.com/x', at('/evil.com/x'))
gives('a mixed slash-backslash pair too', '/\\evil.com/x', at('/evil.com/x'))
gives('climbing above the root lands on the root', '../../../etc/passwd', at('/etc/passwd'))
gives('climbing part-way up is resolved, not refused', '/a/b/../c', at('/a/c'))
refuses('a full http URL is refused rather than mangled into a path', 'http://evil.com')
refuses('an https one likewise, even though ours is https', 'https://evil.com/x')
refuses('javascript: never becomes a link', 'javascript:alert(1)')
refuses('nor does data:', 'data:text/html,<script>alert(1)</script>')

// Whatever it returns, it is on the published origin. The assertions above say
// that one case at a time; this says it about all of them at once, which is
// the property that actually matters.
const origin = new URL(BASE).origin
const escaped = [
  undefined, '', '/', 'orders', '/orders?status=open#top', '//evil.com/x', '\\\\evil.com/x',
  '/\\evil.com/x', '../../../etc/passwd', 'http://evil.com', 'javascript:alert(1)',
].filter((input) => {
  const out = url(input)
  return !out.startsWith('refused: ') && new URL(out).origin !== origin
})
check('nothing above produced a URL off the preview host', escaped.length === 0, escaped.join(', '))

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
