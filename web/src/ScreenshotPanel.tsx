import { useEffect, useState } from 'react'
import {
  captureScreenshot,
  deleteScreenshot,
  fetchScreenshots,
  screenshotUrl,
  type Screenshot,
} from './api'

const URL_KEY = 'orbit.screenshotUrl'

const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

interface Props {
  onInsertPath: (path: string) => void
  onClose: () => void
}

export default function ScreenshotPanel({ onInsertPath, onClose }: Props) {
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? 'http://localhost:3000')
  const [fullPage, setFullPage] = useState(false)
  const [shots, setShots] = useState<Screenshot[]>([])
  const [viewing, setViewing] = useState<Screenshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchScreenshots().then(setShots).catch(() => setShots([]))
  }, [])

  const capture = async () => {
    if (busy || !url.trim()) return
    setBusy(true)
    setError(null)
    localStorage.setItem(URL_KEY, url.trim())
    try {
      await captureScreenshot(url.trim(), fullPage)
      setShots(await fetchScreenshots())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (file: string) => {
    await deleteScreenshot(file)
    setShots((cur) => cur.filter((s) => s.file !== file))
    setViewing((cur) => (cur?.file === file ? null : cur))
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="shot-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-title">Screenshot validation</div>

        <div className="shot-form">
          <input
            className="shot-url"
            type="url"
            placeholder="http://localhost:3000"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && capture()}
          />
          <label className="shot-fullpage">
            <input
              type="checkbox"
              checked={fullPage}
              onChange={(e) => setFullPage(e.target.checked)}
            />
            Full page
          </label>
          <button className="start-button shot-capture" disabled={busy} onClick={capture}>
            {busy ? 'Capturing…' : '📸 Capture'}
          </button>
        </div>

        {error && <div className="drawer-error">{error}</div>}

        <div className="shot-grid">
          {shots.length === 0 && (
            <div className="drawer-empty">
              No screenshots yet — capture your running app to verify a change
            </div>
          )}
          {shots.map((s) => (
            <div key={s.file} className="shot-item">
              <img
                className="shot-thumb"
                src={screenshotUrl(s.file)}
                alt={s.file}
                loading="lazy"
                onClick={() => setViewing(s)}
              />
              <div className="shot-meta">
                <span className="shot-time">{timeAgo(s.createdAt)}</span>
                <button
                  className="session-action"
                  title="Insert file path into terminal"
                  onClick={() => {
                    onInsertPath(s.path)
                    onClose()
                  }}
                >
                  ⇥
                </button>
                <button
                  className="session-action session-action--kill"
                  title="Delete"
                  onClick={() => remove(s.file)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>

        {viewing && (
          <div className="shot-viewer" onClick={() => setViewing(null)}>
            <img src={screenshotUrl(viewing.file)} alt={viewing.file} />
          </div>
        )}
      </div>
    </div>
  )
}
