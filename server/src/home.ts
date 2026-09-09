import os from 'node:os'
import path from 'node:path'

const ORBIT_DATA_DIRNAME = '.orbit'

const homeHoldingOrbitData = (): string => process.env.ORBIT_HOME || os.homedir()

export const orbitDir = (...parts: string[]): string =>
  path.join(homeHoldingOrbitData(), ORBIT_DATA_DIRNAME, ...parts)
