/**
 * The compile step of scripts/dist.sh, through Bun's API rather than its CLI,
 * because one thing needs a plugin.
 *
 * A bundler bakes `__dirname` into the executable as the absolute path the
 * source had on the machine that built it. playwright-core derives its
 * package root from `__dirname` and `require()`s two JSON files from there
 * at module load — `package.json` and `browsers.json` — so an executable
 * built on a CI runner looked, on the first Mac it was run on, for
 * `/Users/runner/work/orbit/…/playwright-core/package.json` and died before
 * the server was up. A build on the developer's own Mac never showed it: the
 * path happened to exist. Those two requires are replaced with the files'
 * contents at bundle time, and the build fails if it finds fewer of them
 * than it expects, so a playwright upgrade that changes the shape is a build
 * error and not a release that starts on one machine.
 *
 *   bun scripts/dist-compile.ts <host|bun-darwin-arm64|bun-darwin-x64> <outfile>
 */
import fs from 'node:fs'
import path from 'node:path'

const [target, outfile] = process.argv.slice(2)
if (!target || !outfile) {
  console.error('usage: dist-compile.ts <host|bun-darwin-arm64|…> <outfile>')
  process.exit(2)
}

const repo = path.resolve(import.meta.dir, '..')
const playwrightRoot = path.dirname(Bun.resolveSync('playwright-core/package.json', path.join(repo, 'server')))
const inline: Record<string, string> = {
  'package.json': fs.readFileSync(path.join(playwrightRoot, 'package.json'), 'utf8'),
  'browsers.json': fs.readFileSync(path.join(playwrightRoot, 'browsers.json'), 'utf8'),
}
let replaced = 0
const leftBehind: string[] = []

const inlinePlaywrightJson = {
  name: 'orbit-inline-playwright-json',
  setup(build: Bun.PluginBuilder) {
    build.onLoad({ filter: /playwright-core[\\/]lib[\\/](package|serverRegistry|coreBundle)\.js$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const contents = source.replace(
        /require\(import_path\d*\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g,
        (_, file: string) => {
          replaced++
          return `(${inline[`${file}.json`]})`
        },
      )
      /* Whatever the bundler pulls in — today only lib/coreBundle.js — must
         leave with no JSON read off the package root at all. */
      if (/join\(packageRoot, "[^"]+\.json"\)/.test(contents)) leftBehind.push(path.basename(args.path))
      return { contents, loader: 'js' }
    })
  },
}

const result = await Bun.build({
  entrypoints: [path.join(repo, 'server/dist/main.js')],
  target: 'bun',
  // An optional require inside playwright-core, for Firefox; never resolved, never needed.
  external: ['chromium-bidi'],
  plugins: [inlinePlaywrightJson],
  compile: {
    outfile: path.resolve(outfile),
    ...(target === 'host' ? {} : { target: target as Bun.Build.CompileTarget }),
    /* What the server reads from disk — embedded under the directory's own
       name: web/dist → /$bunfs/root/dist, server/package.json → /$bunfs/root/package.json. */
    assets: [path.join(repo, 'web/dist'), path.join(repo, 'server/package.json')],
  },
})

for (const log of result.logs) console.error(String(log))
if (!result.success) process.exit(1)
if (replaced < 2 || leftBehind.length) {
  console.error(
    `dist-compile: inlined ${replaced} playwright-core JSON require(s)` +
      (leftBehind.length ? `, and ${leftBehind.join(', ')} still reads JSON off its package root` : '') +
      ' — playwright-core changed shape; fix the pattern before shipping this',
  )
  fs.rmSync(outfile, { force: true })
  process.exit(1)
}
