#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { previewUrl } = await import(path.join(REPO, 'server/dist/preview.js'))

const BASE = 'https://mb-test.tailnet.ts.net:8443/'
const REFUSED_PREFIX = 'refused: '
const at = (pathname) => `https://mb-test.tailnet.ts.net:8443${pathname}`

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

const urlFor = (input) => {
  try {
    return previewUrl(BASE, input)
  } catch (err) {
    return `${REFUSED_PREFIX}${err.message}`
  }
}

const wasRefused = (output) => output.startsWith(REFUSED_PREFIX)
const describe = (input) => `${JSON.stringify(input)} → ${urlFor(input)}`

const gives = (label, input, expected) => check(label, urlFor(input) === expected, describe(input))

const refuses = (label, input) => check(label, wasRefused(urlFor(input)), describe(input))

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

const PREVIEW_ORIGIN = new URL(BASE).origin
const SAMPLE_INPUTS = [
  undefined, '', '/', 'orders', '/orders?status=open#top', '//evil.com/x', '\\\\evil.com/x',
  '/\\evil.com/x', '../../../etc/passwd', 'http://evil.com', 'javascript:alert(1)',
]
const leftPreviewHost = (input) => {
  const output = urlFor(input)
  return !wasRefused(output) && new URL(output).origin !== PREVIEW_ORIGIN
}
const escaped = SAMPLE_INPUTS.filter(leftPreviewHost)
check('nothing above produced a URL off the preview host', escaped.length === 0, escaped.join(', '))

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
