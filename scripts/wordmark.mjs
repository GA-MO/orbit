#!/usr/bin/env bun
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HORIZON, NEBULA, stitchLetters } from '../server/dist/ui.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'docs/images/wordmark.svg')

const CELL = 16
const GAP = 3
const PAD = CELL

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
      <stop offset="0" stop-color="${rgb(HORIZON)}"/>
      <stop offset="1" stop-color="${rgb(NEBULA)}"/>
    </linearGradient>
  </defs>
  <g fill="url(#ramp)">
${lit.join('\n')}
  </g>
</svg>
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, svg)
console.log(`  ${path.relative(root, OUT)}  ${columns}×${rows} pixels, ${lit.length} lit`)
