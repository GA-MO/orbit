import { useState } from 'react'
import { captureScreenshot } from '../api'
import { writeToClipboard } from '../clipboard'
import { IconButton, IconCapture, IconClose, IconLink, IconRestart, Sheet } from './ui'

/**
 * A web page shown over Orbit rather than instead of it.
 *
 * Leaving costs the session its screen: iOS drops a backgrounded page, and an
 * installed web app has no second tab to hand a URL to, so WebKit walks the
 * whole app over to it and the way back is a cold start. A frame keeps the
 * socket, the PTY and the scrollback exactly where they were.
 *
 * Only https pages can be framed from the https app — see `canFrame`. Callers
 * check that before offering this.
 */
export default function PageViewer({
  uri,
  label,
  onClose,
  onInsertPath,
  onToast,
}: {
  uri: string
  /** What a capture of this should be filed under, when the URL is a proxy. */
  label?: string
  onClose: () => void
  /** Given, the header offers handing what is on screen to the agent. */
  onInsertPath?: (path: string) => void
  onToast?: (message: string) => void
}) {
  /* Remounting the iframe is the only reload available: the page is a different
     origin (Orbit is :443, a published dev server is :8443), so there is no
     `contentWindow.location.reload()` to call, and re-assigning the same `src`
     is not reliably a navigation. A new element always fetches. */
  const [generation, setGeneration] = useState(0)
  const [busy, setBusy] = useState(false)

  /* Headless, from the Mac, at this phone's width — so it is the whole page and
     not just the part above the fold. What it cannot carry is the state you are
     looking at: a cross-origin frame will not tell us its scroll position, let
     alone an open menu, and this renders the URL again from nothing. When that
     matters, an iOS screenshot taken over this frame goes to the agent through
     the composer's image button, once the frame is closed. */
  const captureWholePage = async () => {
    if (busy) return
    setBusy(true)
    try {
      const shot = await captureScreenshot({
        url: uri,
        label,
        fullPage: true,
        width: Math.round(window.innerWidth),
      })
      onInsertPath?.(shot.path)
      onToast?.('Full page captured — path inserted into the terminal')
      /* Closing is the point: the path is now sitting in a terminal behind this
         frame, waiting for the sentence that explains it. */
      onClose()
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Capture failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet side="full" onClose={onClose}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line-subtle px-2 py-2">
        <IconButton label="Close" onClick={onClose}>
          <IconClose size={18} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-xs text-mut">
          {uri.replace(/^https?:\/\//, '')}
        </span>
        <IconButton label="Reload the page" onClick={() => setGeneration((n) => n + 1)}>
          <IconRestart size={17} />
        </IconButton>
        {onInsertPath && (
          <IconButton
            label="Capture the whole page and send it to the agent"
            disabled={busy}
            onClick={captureWholePage}
          >
            <IconCapture size={17} />
          </IconButton>
        )}
        <IconButton label="Copy link" onClick={() => writeToClipboard(uri)}>
          <IconLink size={17} />
        </IconButton>
      </div>
      <iframe
        key={generation}
        src={uri}
        title="Page"
        className="min-h-0 w-full flex-1 border-0 bg-ink"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </Sheet>
  )
}
