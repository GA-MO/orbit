/*
 * `localhost` on the phone is the phone. A dev server the agent just started is
 * on the Mac — reachable at the very host the phone is already talking to, on
 * the same port. Over the tailnet that is a plain http URL on a non-443 port,
 * which is fine for a link opened in a tab of its own.
 */

const LOCAL_HOST = /^(?:(https?):\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?(.*)$/

/**
 * Opens a URL in the browser, from an installed PWA as much as from a tab.
 * An anchor click, not `window.open`: WebKit treats a synthetic click on a real
 * `target="_blank"` link as the navigation it is, while `window.open` from a
 * standalone web app is the thing it has historically swallowed.
 */
export function openExternal(uri: string): void {
  const a = document.createElement('a')
  a.href = uri
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Installed to the home screen — where WebKit has no tabs to open into. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * Same origin as Orbit itself. Those are the links a standalone web app refuses
 * to hand to Safari — it just navigates the app window there, and the way back
 * is a cold start. They are also the only ones certain to load in a frame, with
 * no mixed content and no framing policy in the way.
 */
export function isSameOrigin(uri: string): boolean {
  try {
    return new URL(uri, location.href).origin === location.origin
  } catch {
    return false
  }
}

/**
 * Whether a page can be shown inside Orbit at all. Same origin always can; so
 * can anything https, and anything at all when Orbit itself is on plain http.
 * What cannot is an http page inside the https app — the browser blocks that as
 * mixed content, and the frame would sit there blank.
 */
export function canFrame(uri: string): boolean {
  try {
    const target = new URL(uri, location.href)
    if (target.origin === location.origin) return true
    return target.protocol === 'https:' || location.protocol === 'http:'
  } catch {
    return false
  }
}

export function resolveUri(raw: string): string {
  const local = raw.match(LOCAL_HOST)
  if (!local) return raw.startsWith('www.') ? `https://${raw}` : raw
  const [, scheme, port, rest] = local
  const target = port ?? (scheme === 'https' ? '443' : '80')
  const own = location.port || (location.protocol === 'https:' ? '443' : '80')
  // Orbit's own port: stay on the scheme (and the proxy) the page already uses.
  if (target === own) return `${location.origin}${rest}`
  return `http://${location.hostname}:${target}${rest}`
}
