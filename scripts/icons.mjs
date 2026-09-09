#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = path.join(root, 'web/src/styles.css')
const PUBLIC = path.join(root, 'web/public')
const MANIFEST = path.join(PUBLIC, 'manifest.webmanifest')
const INDEX = path.join(root, 'web/index.html')

const css = fs.readFileSync(CSS, 'utf8')

const pickFromCss = (re, what) => {
  const m = css.match(re)
  if (!m) throw new Error(`icons: could not find ${what} in web/src/styles.css`)
  return m[1].trim()
}

const INK = pickFromCss(/--color-ink:\s*(#[0-9a-fA-F]{3,8})/, '--color-ink')
const BEAD = pickFromCss(
  /\.orbit-track::before\s*\{[^}]*?background:\s*(linear-gradient\([^;]+?\))\s*;/s,
  '.orbit-track::before background',
)
const TRAIL = pickFromCss(
  /\.orbit-track::after\s*\{[^}]*?background:\s*(conic-gradient\([^;]+?\))\s*;/s,
  '.orbit-track::after background',
)

const MARK_REFERENCE_PX = 28
const RING_W = 1.5 / MARK_REFERENCE_PX
const BEAD_INSET = 0.28
const BAND = 2.5 / MARK_REFERENCE_PX
const OVERHANG = 1.5 / MARK_REFERENCE_PX

const GLOW_RADIUS = 0.78
const GLOW_SPREAD = -0.28
const BEAD_HIGHLIGHT = 0.018
const BEAD_HIGHLIGHT_MIN_PX = 0.5
const BEAD_GLOW_RADIUS = 0.42
const BEAD_GLOW_SPREAD = -0.11

const satelliteMask = (d) =>
  `radial-gradient(closest-side, transparent calc(100% - ${d * BAND}px), #000 calc(100% - ${d * BAND}px))`

const satellite = (d) => `<i class="sat" style="
      inset:${-d * OVERHANG}px;
      -webkit-mask:${satelliteMask(d)};
      mask:${satelliteMask(d)};"></i>`

const mark = ({ d, canvas, satellite: withSatellite, ring, glow }) => `
<div class="stage" style="width:${canvas}px;height:${canvas}px">
  <div class="mark" style="
    width:${d}px;height:${d}px;
    border-width:${d * RING_W}px;
    border-color:${ring};
    box-shadow:0 0 ${d * GLOW_RADIUS}px ${d * GLOW_SPREAD}px rgb(255 255 255 / ${glow});
  ">
    <i class="bead" style="inset:${BEAD_INSET * 100}%;
      box-shadow:inset 0 ${Math.max(BEAD_HIGHLIGHT_MIN_PX, d * BEAD_HIGHLIGHT)}px 0 rgb(255 255 255 / 0.7),
                 0 0 ${d * BEAD_GLOW_RADIUS}px ${d * BEAD_GLOW_SPREAD}px rgb(255 255 255 / 0.55);"></i>
    ${withSatellite ? satellite(d) : ''}
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
    transform:rotate(0deg)}
</style>${body}`

const RIM = 'rgb(255 255 255 / 0.17)'
const GLOW = 0.34
const LAUNCHER_FILL = 0.78
const APPLE_FILL = 0.76
const MASKABLE_FILL = 0.58

const RECIPES = [
  { file: 'icon-192.png', size: 192, d: 192 * LAUNCHER_FILL, satellite: true, ring: RIM, glow: GLOW },
  { file: 'icon-512.png', size: 512, d: 512 * LAUNCHER_FILL, satellite: true, ring: RIM, glow: GLOW },
  { file: 'apple-touch-icon.png', size: 180, d: 180 * APPLE_FILL, satellite: true, ring: RIM, glow: GLOW },
  { file: 'icon-maskable-512.png', size: 512, d: 512 * MASKABLE_FILL, satellite: true, ring: RIM, glow: GLOW },
]

const FILE_COLUMN = 24

async function renderRecipe(browser, recipe) {
  const ctx = await browser.newContext({
    viewport: { width: recipe.size, height: recipe.size },
    deviceScaleFactor: 1,
  })
  const p = await ctx.newPage()
  await p.setContent(page(mark({ d: recipe.d, canvas: recipe.size, satellite: recipe.satellite, ring: recipe.ring, glow: recipe.glow })))
  await p.screenshot({ path: path.join(PUBLIC, recipe.file), type: 'png' })
  await ctx.close()
  console.log(`  ${recipe.file.padEnd(FILE_COLUMN)} ${recipe.size}×${recipe.size}`)
}

async function renderPngs() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    for (const recipe of RECIPES) await renderRecipe(browser, recipe)
  } finally {
    await browser.close()
  }
}

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

function writeFavicon() {
  fs.writeFileSync(path.join(PUBLIC, 'icon.svg'), favicon())
  console.log(`  ${'icon.svg'.padEnd(FILE_COLUMN)} scalable (ring + bead)`)
}

function syncManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  manifest.background_color = INK
  manifest.theme_color = INK
  manifest.icons = [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
}

function syncThemeColor() {
  const html = fs.readFileSync(INDEX, 'utf8')
  const next = html.replace(
    /(<meta name="theme-color" content=")[^"]*(")/,
    `$1${INK}$2`,
  )
  if (next === html && !html.includes(`content="${INK}"`)) {
    throw new Error('icons: no theme-color meta to update in web/index.html')
  }
  fs.writeFileSync(INDEX, next)
}

function syncColours() {
  syncManifest()
  syncThemeColor()
  console.log(`  colours synced to --color-ink ${INK}`)
}

async function main() {
  await renderPngs()
  writeFavicon()
  syncColours()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
