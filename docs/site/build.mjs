#!/usr/bin/env node
/**
 * Build docs/site/index.html — one self-contained file, no network at open time.
 *
 * The page is meant to be opened straight off disk, mailed, or published as a
 * hosted artifact, so every asset is embedded: the Space Grotesk face the app
 * itself bundles, a Thai face to go with it, and the ten real screenshots from
 * docs/images (downscaled to phone size and re-encoded as JPEG, or the file
 * would be several megabytes).
 *
 *   node docs/site/build.mjs
 *
 * Needs macOS `sips` for the image pass, which is the only platform Orbit runs
 * on anyway.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const FONT = path.join(
  root,
  'node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2',
)
/* Space Grotesk has no Thai. Without a Thai face of our own the page falls
   back to whatever the device ships — Thonburi on Apple, which is looped and
   reads like a government form next to a geometric Latin sans. Anuphan is
   loopless and built for exactly this pairing. Thai subset only: the Latin
   in it would never be reached. */
const FONT_THAI = path.join(
  root,
  'node_modules/@fontsource-variable/anuphan/files/anuphan-thai-wght-normal.woff2',
)
const SHOT_DIR = path.join(root, 'docs/images')
const SHOT_WIDTH = 520 // twice the frame it renders in, so it stays crisp on retina
const SHOT_QUALITY = 72

function fontDataUri(file) {
  if (!fs.existsSync(file)) {
    console.warn(`[site] ${path.relative(root, file)} missing — run npm install first`)
    return "''"
  }
  return `'data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}'`
}

function shots() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-site-'))
  const out = {}
  for (const file of fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png')).sort()) {
    const name = path.basename(file, '.png')
    const jpg = path.join(tmp, `${name}.jpg`)
    execFileSync('sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(SHOT_QUALITY),
      '-Z', String(SHOT_WIDTH),
      path.join(SHOT_DIR, file),
      '--out', jpg,
    ], { stdio: 'ignore' })
    out[name] = `data:image/jpeg;base64,${fs.readFileSync(jpg).toString('base64')}`
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  return out
}

const template = fs.readFileSync(path.join(here, 'template.html'), 'utf8')
const images = shots()

const html = template
  .replace('{{FONT}}', () => fontDataUri(FONT))
  .replace('{{FONT_THAI}}', () => fontDataUri(FONT_THAI))
  .replace('{{SHOTS_JSON}}', () => JSON.stringify(images))
  .replace(/\{\{SHOT:([\w-]+)\}\}/g, (_, name) => {
    if (!images[name]) throw new Error(`no screenshot named ${name} in docs/images`)
    return images[name]
  })

if (html.includes('{{')) throw new Error('unsubstituted placeholder left in the page')

const dest = path.join(here, 'index.html')
fs.writeFileSync(dest, html)

console.log(
  `[site] ${path.relative(root, dest)} — ${(html.length / 1024).toFixed(0)}KB, ` +
    `${Object.keys(images).length} screenshots embedded`,
)
