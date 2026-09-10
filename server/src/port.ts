const DEFAULT_PORT = 7788
const LOWEST_PORT = 1
const HIGHEST_PORT = 65_535

export const UNUSABLE_PORT = 'ORBIT_UNUSABLE_PORT'

export const resolvePort = (raw: string | undefined): number => {
  const asked = (raw ?? '').trim()
  if (!asked) return DEFAULT_PORT
  const port = Number(asked)
  if (!Number.isInteger(port) || port < LOWEST_PORT || port > HIGHEST_PORT) {
    const unusable: NodeJS.ErrnoException = new Error(
      `ORBIT_PORT must be a whole number between ${LOWEST_PORT} and ${HIGHEST_PORT}, not ${JSON.stringify(raw)}`,
    )
    unusable.code = UNUSABLE_PORT
    throw unusable
  }
  return port
}

export { DEFAULT_PORT }
export const PORT = resolvePort(process.env.ORBIT_PORT)
