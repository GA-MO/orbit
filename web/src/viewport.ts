/**
 * Keep the app inside the part of the screen the keyboard has not taken.
 *
 * iOS never shrinks the layout viewport for the soft keyboard, and a fixed box
 * is measured against that — so `inset: 0` leaves the bottom of the app, which
 * is the composer, the key bar and the tabs, sitting behind the keys. Safari's
 * answer is to pan the *visual* viewport, but only far enough to reveal the
 * focused element: xterm's textarea rides the cursor, which on a fresh session
 * is near the top, so nothing moves and the prompt stays buried until the page
 * is dragged up by hand.
 *
 * So measure the visible box ourselves and publish it. `--app-height` is what
 * is left of the screen; `--app-top` is how far Safari has already panned,
 * which the shell has to add back to stay glued to the visible area rather than
 * to the layout viewport it is positioned against.
 */
export function trackVisualViewport() {
  const vv = window.visualViewport
  // Without it the layout viewport is the whole story; the CSS falls back to it.
  if (!vv) return

  const root = document.documentElement
  let frame = 0

  const apply = () => {
    frame = 0
    root.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
    root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`)
    /* The document is not scrollable, but focusing an input can still shift it —
       and a shell pinned to the layout viewport goes with it. */
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
  }

  /* The keyboard slides in over many frames and fires for every one of them.
     One write per frame is enough, and it keeps the shell in step with the
     animation instead of a burst behind it. */
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(apply)
  }

  apply()
  vv.addEventListener('resize', schedule)
  vv.addEventListener('scroll', schedule)
}
