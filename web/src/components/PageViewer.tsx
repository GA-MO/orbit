import { useState } from 'react'
import { captureScreenshot } from '../api'
import { writeToClipboard } from '../clipboard'
import { IconButton, IconCapture, IconClose, IconLink, IconRestart, Sheet } from './ui'

const SCHEME_PREFIX = /^https?:\/\//

export default function PageViewer({
  uri,
  label,
  onClose,
  onInsertPath,
  onToast,
}: {
  uri: string
  label?: string
  onClose: () => void
  onInsertPath?: (path: string) => void
  onToast?: (message: string) => void
}) {
  const [iframeGeneration, setIframeGeneration] = useState(0)
  const [busy, setBusy] = useState(false)

  const reloadByRemountingIframe = () => setIframeGeneration((n) => n + 1)

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
          {uri.replace(SCHEME_PREFIX, '')}
        </span>
        <IconButton label="Reload the page" onClick={reloadByRemountingIframe}>
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
        key={iframeGeneration}
        src={uri}
        title="Page"
        className="min-h-0 w-full flex-1 border-0 bg-ink"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </Sheet>
  )
}
