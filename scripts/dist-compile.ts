import path from 'node:path'

const [target, outfile] = process.argv.slice(2)
if (!target || !outfile) {
  console.error('usage: dist-compile.ts <host|bun-darwin-arm64|…> <outfile>')
  process.exit(2)
}

const repo = path.resolve(import.meta.dir, '..')
const ENTRY_POINT = path.join(repo, 'server/dist/main.js')
const ASSETS_THE_SERVER_READS_FROM_DISK = [
  path.join(repo, 'web/dist'),
  path.join(repo, 'server/package.json'),
]

const result = await Bun.build({
  entrypoints: [ENTRY_POINT],
  target: 'bun',
  compile: {
    outfile: path.resolve(outfile),
    ...(target === 'host' ? {} : { target: target as Bun.Build.CompileTarget }),
    assets: ASSETS_THE_SERVER_READS_FROM_DISK,
  },
})

for (const log of result.logs) console.error(String(log))
if (!result.success) process.exit(1)
