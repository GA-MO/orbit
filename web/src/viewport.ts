const APP_HEIGHT_VAR = '--app-height'
const APP_TOP_VAR = '--app-top'

export function trackVisualViewport() {
  const visualViewport = window.visualViewport
  if (!visualViewport) return

  const root = document.documentElement
  let pendingFrame = 0

  const publishVisibleBox = () => {
    pendingFrame = 0
    root.style.setProperty(APP_HEIGHT_VAR, `${Math.round(visualViewport.height)}px`)
    root.style.setProperty(APP_TOP_VAR, `${Math.round(visualViewport.offsetTop)}px`)
    undoFocusScroll()
  }

  const publishOncePerFrame = () => {
    if (pendingFrame) return
    pendingFrame = requestAnimationFrame(publishVisibleBox)
  }

  publishVisibleBox()
  visualViewport.addEventListener('resize', publishOncePerFrame)
  visualViewport.addEventListener('scroll', publishOncePerFrame)
}

function undoFocusScroll() {
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
}
