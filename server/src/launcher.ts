import { fileURLToPath } from 'node:url'

import { platform } from './platform/index.js'

export const COMPILED = import.meta.url.startsWith('file:///$bunfs/')

const quote = (word: string) => platform.quotedForHookCommand(word)

const entryScript = () => fileURLToPath(new URL('./main.js', import.meta.url))

export const launcherArgv = (): string[] => (COMPILED ? [process.execPath] : [process.execPath, entryScript()])

export const launcher = (): string => launcherArgv().map(quote).join(' ')
