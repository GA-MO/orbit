#!/usr/bin/env node
/**
 * Regenerate Orbit's app icons from the mark and the palette.
 *
 * The icon is not a drawing that happens to sit next to OrbitMark — it is the
 * same object: a ring, a satellite parked where the reduced-motion rule parks
 * it (top-left, the corner everything in this app is lit from), and a lit bead
 * at the centre. The geometry is the mark's own proportions, expressed as
 * fractions of the mark's size so it holds at 16px and at 512px; the colours
 * are read out of web/src/styles.css so the next palette change has one place
 * to look.
 *
 * Rasterising is done by rendering the artwork at each exact size in system
 * Chrome (playwright-core, `channel: 'chrome'`, no browser download — same
 * approach as server/src/screenshot.ts). Nothing is scaled down from a bigger
 * PNG: that is how the old favicon turned to mush.
 *
 *   node scripts/icons.mjs            # write the icons + sync the colours
 *   node scripts/icons.mjs --preview  # also write a contact sheet to inspect
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = path.join(root, 'web/src/styles.css')
const PUBLIC = path.join(root, 'web/public')
const MANIFEST = path.join(PUBLIC, 'manifest.webmanifest')
const INDEX = path.join(root, 'web/index.html')

/* ---------------------------------------------------------------- palette --
   Read, never retyped. If a value stops being findable the script fails loudly
   rather than quietly baking last year's colour into a PNG. */
const css = fs.readFileSync(CSS, 'utf8')

const pick = (re, what) => {
  const m = css.match(re)
  if (!m) throw new Error(`icons: could not find ${what} in web/src/styles.css`)
  return m[1].trim()
}

const INK = pick(/--color-ink:\s*(#[0-9a-fA-F]{3,8})/, '--color-ink')
/* The bead's face, lifted verbatim from .orbit-track::before. */
const BEAD = pick(
  /\.orbit-track::before\s*\{[^}]*?background:\s*(linear-gradient\([^;]+?\))\s*;/s,
  '.orbit-track::before background',
)
/* The satellite and its trail, from .orbit-track::after. */
const TRAIL = pick(
  /\.orbit-track::after\s*\{[^}]*?background:\s*(conic-gradient\([^;]+?\))\s*;/s,
  '.orbit-track::after background',
)

/* ---------------------------------------------------------------- geometry --
   Fractions of the mark's diameter, taken from .orbit-track at its 28px
   reference size, so the icon is the mark rather than a lookalike.

   The one thing that is tuned rather than copied is the ring's alpha, and it
   is tuned in two directions at once. The satellite only exists as a contrast:
   a near-white arc riding a dark rim. Brighten the rim to make it legible on
   its own and the satellite dissolves into it — which is exactly what the
   first pass did. So where the satellite is present the rim stays close to
   --color-line's weight over ink and the sweep does the reading; where it is
   absent (the tab favicon) the rim is opened up, because then it is the only
   shape left. Both alphas are the same white-over-ink family as --edge-lit. */
const RING_W = 1.5 / 28 // .orbit-track border-width
const BEAD_INSET = 0.28 // .orbit-track::before inset
const BAND = 2.5 / 28 // .orbit-track::after mask band
const OVERHANG = 1.5 / 28 // .orbit-track::after inset: -1.5px

/**
 * The mark, at diameter `d` px, centred in a `canvas` px square.
 * `satellite` false is the small-size mark: ring and bead only.
 */
const mark = ({ d, canvas, satellite, ring, glow }) => `
<div class="stage" style="width:${canvas}px;height:${canvas}px">
  <div class="mark" style="
    width:${d}px;height:${d}px;
    border-width:${d * RING_W}px;
    border-color:${ring};
    box-shadow:0 0 ${d * 0.78}px ${-d * 0.28}px rgb(255 255 255 / ${glow});
  ">
    <i class="bead" style="inset:${BEAD_INSET * 100}%;
      box-shadow:inset 0 ${Math.max(0.5, d * 0.018)}px 0 rgb(255 255 255 / 0.7),
                 0 0 ${d * 0.42}px ${-d * 0.11}px rgb(255 255 255 / 0.55);"></i>
    ${
      satellite
        ? `<i class="sat" style="
      inset:${-d * OVERHANG}px;
      -webkit-mask:radial-gradient(closest-side, transparent calc(100% - ${d * BAND}px), #000 calc(100% - ${d * BAND}px));
      mask:radial-gradient(closest-side, transparent calc(100% - ${d * BAND}px), #000 calc(100% - ${d * BAND}px));"></i>`
        : ''
    }
  </div>
</div>`

const page = (body) => `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:${INK}}
  .stage{position:relative;display:grid;place-items:center;background:${INK};overflow:hidden}
  .stage.bare{background:transparent}
  .mark{position:relative;border-radius:9999px;border-style:solid;
    background:radial-gradient(closest-side, transparent 52%, rgb(255 255 255 / 0.07))}
  .bead{position:absolute;border-radius:9999px;background:${BEAD}}
  .sat{position:absolute;border-radius:9999px;background:${TRAIL};
    /* Parked where prefers-reduced-motion parks it: the arc of a conic that
       starts at twelve o'clock peaks at 97%, i.e. just left of the top. */
    transform:rotate(0deg)}
</style>${body}`

/* ------------------------------------------------------------------ recipe --
   Ground: every PNG is full-bleed ink. iOS will not round-trip transparency on
   a home screen, Android's legacy path drops a white plate behind a
   transparent icon and a white ring on white is nothing, and the ground *is*
   the app. The tab favicon is an SVG for the same reason it exists at all:
   16px of a downscaled 192px PNG is mush. */
/** The rim under a satellite: dark enough that the sweep is the bright thing. */
const RIM = 'rgb(255 255 255 / 0.17)'

const RECIPES = [
  // The satellite is ~5% of the icon's width. At 192 and above it is a
  // legible stroke of light; below that it is a smudge on the rim, so the
  // small sizes are ring and bead alone — the two shapes that survive.
  { file: 'icon-192.png', size: 192, d: 192 * 0.78, satellite: true, ring: RIM, glow: 0.34 },
  { file: 'icon-512.png', size: 512, d: 512 * 0.78, satellite: true, ring: RIM, glow: 0.34 },
  // apple-touch-icon: 180×180, full bleed, no transparency, no rounding —
  // iOS applies its own squircle.
  { file: 'apple-touch-icon.png', size: 180, d: 180 * 0.76, satellite: true, ring: RIM, glow: 0.34 },
  // Maskable: a launcher may crop 20% off each side, so the artwork lives
  // inside the 80%-diameter safe circle with the glow allowed room.
  { file: 'icon-maskable-512.png', size: 512, d: 512 * 0.58, satellite: true, ring: RIM, glow: 0.34 },
]

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    for (const r of RECIPES) {
      const ctx = await browser.newContext({
        viewport: { width: r.size, height: r.size },
        deviceScaleFactor: 1,
      })
      const p = await ctx.newPage()
      await p.setContent(page(mark({ d: r.d, canvas: r.size, satellite: r.satellite, ring: r.ring, glow: r.glow })))
      await p.screenshot({ path: path.join(PUBLIC, r.file), type: 'png' })
      await ctx.close()
      console.log(`  ${r.file.padEnd(24)} ${r.size}×${r.size}`)
    }
  } finally {
    await browser.close()
  }

  fs.writeFileSync(path.join(PUBLIC, 'icon.svg'), favicon())
  console.log(`  ${'icon.svg'.padEnd(24)} scalable (ring + bead)`)

  syncColours()
}

/* --------------------------------------------------------------- favicon --
   16px is where a browser tab renders this. At that size the ring is 1px of
   grey and the satellite is a sub-pixel: it cannot survive, and trying to keep
   it only muddies the ring. So the tab mark is the ring and the bead — the two
   shapes that are still shapes at 16px — on a rounded ink plate so it reads on
   a light tab strip as well as a dark one. */
const favicon = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="bead" x1="0" y1="0" x2="0.75" y2="1">
      <stop offset="0" stop-color="#f4f3f0"/>
      <stop offset="0.78" stop-color="#9c968c"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="7" fill="${INK}"/>
  <circle cx="16" cy="16" r="10.5" fill="none" stroke="#fff" stroke-opacity="0.72" stroke-width="2.5"/>
  <circle cx="16" cy="16" r="5" fill="url(#bead)"/>
</svg>
`

/* --------------------------------------------------------------- colours --
   Three files used to disagree about Orbit's ground: the manifest was two
   palettes behind and theme-color was one. Both are rewritten from
   --color-ink, here, every time the icons are made. */
function syncColours() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  manifest.background_color = INK
  manifest.theme_color = INK
  manifest.icons = [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')

  const html = fs.readFileSync(INDEX, 'utf8')
  const next = html.replace(
    /(<meta name="theme-color" content=")[^"]*(")/,
    `$1${INK}$2`,
  )
  if (next === html && !html.includes(`content="${INK}"`)) {
    throw new Error('icons: no theme-color meta to update in web/index.html')
  }
  fs.writeFileSync(INDEX, next)
  console.log(`  colours synced to --color-ink ${INK}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
