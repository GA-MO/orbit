import fs from 'node:fs'

const UNKNOWN_VERSION = '?'

const PACKAGE_JSON_CANDIDATES = [new URL('../package.json', import.meta.url), '/$bunfs/root/package.json']

export function packageVersion(): string {
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')).version ?? UNKNOWN_VERSION
    } catch {}
  }
  return UNKNOWN_VERSION
}
