const LOOPBACK_URL = /^(?:(https?):\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?(.*)$/

const defaultPortFor = (isHttps: boolean): string => (isHttps ? '443' : '80')

export function openExternal(uri: string): void {
  const anchor = document.createElement('a')
  anchor.href = uri
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function isSameOrigin(uri: string): boolean {
  try {
    return new URL(uri, location.href).origin === location.origin
  } catch {
    return false
  }
}

export function canFrame(uri: string): boolean {
  try {
    const target = new URL(uri, location.href)
    if (target.origin === location.origin) return true
    const framedPageIsSecure = target.protocol === 'https:'
    const orbitIsPlainHttp = location.protocol === 'http:'
    return framedPageIsSecure || orbitIsPlainHttp
  } catch {
    return false
  }
}

export function resolveUri(raw: string): string {
  const loopback = raw.match(LOOPBACK_URL)
  if (!loopback) return raw.startsWith('www.') ? `https://${raw}` : raw

  const [, scheme, explicitPort, pathAndRest] = loopback
  const targetPort = explicitPort ?? defaultPortFor(scheme === 'https')
  const orbitPort = location.port || defaultPortFor(location.protocol === 'https:')
  if (targetPort === orbitPort) return `${location.origin}${pathAndRest}`
  return `http://${location.hostname}:${targetPort}${pathAndRest}`
}
