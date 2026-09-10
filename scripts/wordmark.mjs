#!/usr/bin/env bun
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PEARL, stitchLetters } from '../server/dist/ui.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'docs/images/wordmark.svg')

const CELL = 16
const GAP = 3
const PAD = CELL * 2
const SURFACE = '#171614'
const CARD_RADIUS = 14

const rgb = ({ r, g, b }) => `rgb(${r},${g},${b})`

const pixels = stitchLetters()
const columns = pixels[0].length
const rows = pixels.length

const width = columns * CELL + PAD * 2
const height = rows * CELL + PAD * 2

const lit = []
pixels.forEach((row, y) => {
  ;[...row].forEach((pixel, x) => {
    if (pixel === '1') lit.push(`    <rect x="${PAD + x * CELL}" y="${PAD + y * CELL}" width="${CELL - GAP}" height="${CELL - GAP}"/>`)
  })
})

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Orbit">
  <defs>
    <linearGradient id="ramp" gradientUnits="userSpaceOnUse" x1="${PAD}" y1="0" x2="${width - PAD}" y2="0">
${PEARL.map((stop, at) => `      <stop offset="${at / (PEARL.length - 1)}" stop-color="${rgb(stop)}"/>`).join('\n')}
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" rx="${CARD_RADIUS}" fill="${SURFACE}"/>
  <g fill="url(#ramp)">
${lit.join('\n')}
  </g>
</svg>
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, svg)
console.log(`  ${path.relative(root, OUT)}  ${columns}×${rows} pixels, ${lit.length} lit`)
