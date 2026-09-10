import fs from 'node:fs'
import path from 'node:path'

const [target, outfile] = process.argv.slice(2)
if (!target || !outfile) {
  console.error('usage: dist-compile.ts <host|bun-darwin-arm64|…> <outfile>')
  process.exit(2)
}

const repo = path.resolve(import.meta.dir, '..')
const ENTRY_POINT = path.join(repo, 'server/dist/main.js')
const FIREFOX_ONLY_PLAYWRIGHT_REQUIRE = 'chromium-bidi'
const ASSETS_THE_SERVER_READS_FROM_DISK = [
  path.join(repo, 'web/dist'),
  path.join(repo, 'server/package.json'),
]

const playwrightRoot = path.dirname(
  Bun.resolveSync('playwright-core/package.json', path.join(repo, 'server')),
)
const PLAYWRIGHT_JSON_READ_AT_LOAD = ['package.json', 'browsers.json']
const contentsOf = Object.fromEntries(
  PLAYWRIGHT_JSON_READ_AT_LOAD.map((name) => [
    name,
    fs.readFileSync(path.join(playwrightRoot, name), 'utf8'),
  ]),
)

const READS_JSON_FROM_ITS_PACKAGE_ROOT =
  /require\(import_path\d*\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g
const STILL_READS_JSON_FROM_ITS_PACKAGE_ROOT = /join\(packageRoot, "[^"]+\.json"\)/
const MINIMUM_INLINED = 2

let inlined = 0
const filesLeftReadingJson: string[] = []

const inlinePlaywrightJson = {
  name: 'orbit-inline-playwright-json',
  setup(build: Bun.PluginBuilder) {
    build.onLoad(
      { filter: /playwright-core[\\/]lib[\\/](package|serverRegistry|coreBundle)\.js$/ },
      async (args) => {
        const source = await Bun.file(args.path).text()
        const contents = source.replace(READS_JSON_FROM_ITS_PACKAGE_ROOT, (_, file: string) => {
          inlined++
          return `(${contentsOf[`${file}.json`]})`
        })
        if (STILL_READS_JSON_FROM_ITS_PACKAGE_ROOT.test(contents)) {
          filesLeftReadingJson.push(path.basename(args.path))
        }
        return { contents, loader: 'js' }
      },
    )
  },
}

const result = await Bun.build({
  entrypoints: [ENTRY_POINT],
  target: 'bun',
  external: [FIREFOX_ONLY_PLAYWRIGHT_REQUIRE],
  plugins: [inlinePlaywrightJson],
  compile: {
    outfile: path.resolve(outfile),
    ...(target === 'host' ? {} : { target: target as Bun.Build.CompileTarget }),
    assets: ASSETS_THE_SERVER_READS_FROM_DISK,
  },
})

for (const log of result.logs) console.error(String(log))
if (!result.success) process.exit(1)

if (inlined < MINIMUM_INLINED || filesLeftReadingJson.length) {
  console.error(
    `dist-compile: inlined ${inlined} playwright-core JSON require(s)` +
      (filesLeftReadingJson.length
        ? `, and ${filesLeftReadingJson.join(', ')} still reads JSON off its package root`
        : '') +
      ' — playwright-core changed shape; see docs/DESIGN-NOTES.md, "Building the executable"',
  )
  fs.rmSync(outfile, { force: true })
  process.exit(1)
}
