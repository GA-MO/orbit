import { fileURLToPath } from 'node:url'

export const COMPILED = import.meta.url.startsWith('file:///$bunfs/')

const WHITESPACE = /\s/

const quote = (word: string) => (WHITESPACE.test(word) ? JSON.stringify(word) : word)

const entryScript = () => fileURLToPath(new URL('./main.js', import.meta.url))

export const launcherArgv = (): string[] => (COMPILED ? [process.execPath] : [process.execPath, entryScript()])

export const launcher = (): string => launcherArgv().map(quote).join(' ')
