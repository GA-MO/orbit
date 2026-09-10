#!/usr/bin/env node
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
const SHOT_DIR = path.join(root, 'docs/images')
const SHOT_WIDTH = 780
const SHOT_QUALITY = 82
const SHOT_FILE = /\.(png|jpg)$/
const KB = 1024

const PAGES = [
  { template: 'template.html', out: 'index.html' },
]

function fontDataUri(file) {
  if (!fs.existsSync(file)) {
    console.warn(`[site] ${path.relative(root, file)} missing — run npm install first`)
    return "''"
  }
  return `'data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}'`
}

function jpegDataUri(file) {
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
}

function pixelWidth(file) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', file], { encoding: 'utf8' })
  return Number(out.match(/pixelWidth:\s*(\d+)/)?.[1] ?? Infinity)
}

function alreadyPhoneSized(file) {
  return file.endsWith('.jpg') && pixelWidth(file) <= SHOT_WIDTH
}

function resampleToJpeg(source, dest) {
  execFileSync('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(SHOT_QUALITY),
    '-Z', String(SHOT_WIDTH),
    source,
    '--out', dest,
  ], { stdio: 'ignore' })
}

function embedShots() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-site-'))
  const shots = {}
  const files = fs.readdirSync(SHOT_DIR).filter((f) => SHOT_FILE.test(f)).sort()
  for (const file of files) {
    const name = path.basename(file).replace(SHOT_FILE, '')
    const source = path.join(SHOT_DIR, file)

    if (alreadyPhoneSized(source)) {
      shots[name] = jpegDataUri(source)
      continue
    }

    const resampled = path.join(tmp, `${name}.jpg`)
    resampleToJpeg(source, resampled)
    shots[name] = jpegDataUri(resampled)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  return shots
}

function renderPage(page, images) {
  const template = fs.readFileSync(path.join(here, page.template), 'utf8')
  const html = template
    .replace('{{FONT}}', () => fontDataUri(FONT))
    .replace('{{SHOTS_JSON}}', () => JSON.stringify(images))
    .replace(/\{\{SHOT:([\w-]+)\}\}/g, (_, name) => {
      if (!images[name]) throw new Error(`no screenshot named ${name} in docs/images`)
      return images[name]
    })

  if (html.includes('{{')) throw new Error(`unsubstituted placeholder left in ${page.out}`)

  const dest = path.join(here, page.out)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, html)

  console.log(
    `[site] ${path.relative(root, dest)} — ${(html.length / KB).toFixed(0)}KB, ` +
      `${Object.keys(images).length} screenshots embedded`,
  )
}

const images = embedShots()
for (const page of PAGES) renderPage(page, images)
