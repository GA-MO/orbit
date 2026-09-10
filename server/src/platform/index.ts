import { darwin } from './darwin.js'
import { win32 } from './win32.js'
import type { Platform } from './contract.js'

export type { Command, ListeningSocket, Platform } from './contract.js'

const BY_PLATFORM: Partial<Record<NodeJS.Platform, Platform>> = {
  darwin,
  win32,
}

export const supportedPlatform = (): Platform | null => BY_PLATFORM[process.platform] ?? null

export const unsupportedPlatformMessage = (): string =>
  `orbit: runs on macOS and Windows, and this is ${process.platform}`

export const platform: Platform = supportedPlatform() ?? darwin
