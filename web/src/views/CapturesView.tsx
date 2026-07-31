import { useEffect, useState } from 'react'
import {
  captureScreenshot,
  deleteScreenshot,
  fetchScreenshots,
  screenshotUrl,
  type Screenshot,
} from '../api'
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  IconInsert,
  IconTrash,
  timeAgo,
} from '../components/ui'

const URL_KEY = 'orbit.screenshotUrl'

interface Props {
  active: boolean
  onInsertPath: (path: string) => void
  onToast: (message: string) => void
}

export default function CapturesView({ active, onInsertPath, onToast }: Props) {
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? 'http://localhost:3000')
  const [fullPage, setFullPage] = useState(false)
  const [shots, setShots] = useState<Screenshot[]>([])
  const [viewing, setViewing] = useState<Screenshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (active) fetchScreenshots().then(setShots).catch(() => {})
  }, [active])

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
    <div className="flex h-full flex-col">
      <header className="shrink-0 px-5 pt-4 pb-3">
        <h1 className="font-display text-lg font-semibold tracking-wide">Captures</h1>
        <p className="mt-0.5 text-xs text-mut">
          Render your running app headless and hand the screenshot to an agent
        </p>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
        <Field
          className="min-w-44 flex-1 font-mono text-[13px]"
          type="url"
          placeholder="http://localhost:3000"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && capture()}
        />
        <label className="flex items-center gap-1.5 text-xs whitespace-nowrap text-mut">
          <input
            type="checkbox"
            className="accent-accent-strong"
            checked={fullPage}
            onChange={(e) => setFullPage(e.target.checked)}
          />
          Full page
        </label>
        <Button disabled={busy} onClick={capture}>
          {busy ? 'Capturing…' : 'Capture'}
        </Button>
      </div>

      {error && <div className="px-5 pb-2 text-sm text-danger">{error}</div>}

      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto px-4 pb-24 sm:grid-cols-3">
        {shots.length === 0 && (
          <div className="col-span-full">
            <EmptyState
              title="No captures yet"
              hint="After an agent changes your app, capture it here to verify the result — then insert the image path back into the terminal."
            />
          </div>
        )}
        {shots.map((s) => (
          <figure
            key={s.file}
            className="overflow-hidden rounded-(--radius-card) border border-line-subtle bg-surface"
          >
            <img
              src={screenshotUrl(s.file)}
              alt={`Capture from ${timeAgo(s.createdAt)} ago`}
              loading="lazy"
              className="aspect-[9/16] w-full cursor-zoom-in object-cover object-top"
              onClick={() => setViewing(s)}
            />
            <figcaption className="flex items-center px-1.5 py-0.5">
              <span className="flex-1 pl-1.5 text-[11px] text-faint">{timeAgo(s.createdAt)}</span>
              <IconButton
                label="Insert path into terminal"
                className="size-8 hover:text-accent"
                onClick={() => {
                  onInsertPath(s.path)
                  onToast('Path inserted into the terminal')
                }}
              >
                <IconInsert size={15} />
              </IconButton>
              <IconButton
                label="Delete capture"
                className="size-8 hover:text-danger"
                onClick={() => remove(s.file)}
              >
                <IconTrash size={15} />
              </IconButton>
            </figcaption>
          </figure>
        ))}
      </div>

      {viewing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setViewing(null)}
        >
          <img
            src={screenshotUrl(viewing.file)}
            alt="Capture full view"
            className="max-h-full max-w-full rounded-(--radius-card)"
          />
        </div>
      )}
    </div>
  )
}
