import { darwin } from './darwin.js'
import { win32 } from './win32.js'
import type { Platform } from './contract.js'

export type { Command, ListeningSocket, Platform } from './contract.js'

const UNSUPPORTED = `Orbit runs on macOS and Windows — this is ${process.platform}`

export const platform: Platform =
  process.platform === 'win32' ? win32 : process.platform === 'darwin' ? darwin : darwin

export const isSupportedPlatform = (): boolean =>
  process.platform === 'darwin' || process.platform === 'win32'

export const unsupportedPlatformMessage = UNSUPPORTED
