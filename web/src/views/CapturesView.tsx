import { useEffect, useState } from 'react'
import {
  PRESETS,
  captureScreen,
  captureScreenshot,
  deleteScreenshot,
  fetchScreenshots,
  screenshotUrl,
  type PresetId,
  type Screenshot,
} from '../api'
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  IconDisplay,
  IconInsert,
  IconTrash,
  Segmented,
  timeAgo,
} from '../components/ui'

const URL_KEY = 'orbit.screenshotUrl'
const PRESET_KEY = 'orbit.screenshotPreset'

type Source = 'url' | 'screen'

/** Taller than this and the tile stops being a thumbnail and becomes a column. */
const MAX_TILE_RATIO = 16 / 9
const isLong = (s: Screenshot) => !!(s.width && s.height && s.height / s.width > MAX_TILE_RATIO)
const tileRatio = (s: Screenshot) =>
  !s.width || !s.height || isLong(s) ? '9 / 16' : `${s.width} / ${s.height}`

interface Props {
  active: boolean
  onInsertPath: (path: string) => void
  onToast: (message: string) => void
}

export default function CapturesView({ active, onInsertPath, onToast }: Props) {
  const [source, setSource] = useState<Source>('url')
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? 'http://localhost:3000')
  const [preset, setPreset] = useState<PresetId>(
    () => (localStorage.getItem(PRESET_KEY) as PresetId | null) ?? 'phone',
  )
  const [fullPage, setFullPage] = useState(false)
  const [shots, setShots] = useState<Screenshot[]>([])
  const [viewing, setViewing] = useState<Screenshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (active) fetchScreenshots().then(setShots).catch(() => {})
  }, [active])

  const capture = async () => {
    if (busy || (source === 'url' && !url.trim())) return
    setBusy(true)
    setError(null)
    try {
      if (source === 'screen') {
        await captureScreen()
      } else {
        localStorage.setItem(URL_KEY, url.trim())
        localStorage.setItem(PRESET_KEY, preset)
        await captureScreenshot({ url: url.trim(), preset, fullPage })
      }
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
          {source === 'url'
            ? 'Render your running app headless and hand the screenshot to an agent'
            : "Grab the Mac's own screen — simulators, native apps, anything Chrome cannot render"}
        </p>
      </header>

      {/* Deliberate rows: on a phone every control fits without stealing the gallery's height. */}
      <div className="flex shrink-0 flex-col gap-2 px-4 pb-3">
        <div className="flex items-center gap-2">
          <Segmented
            value={source}
            onChange={(id) => {
              setSource(id)
              setError(null)
            }}
            options={[
              { id: 'url', label: 'App URL' },
              { id: 'screen', label: 'Mac screen' },
            ]}
          />
          {source === 'screen' && (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-faint">
                <IconDisplay size={15} className="shrink-0" />
                <span className="truncate">Needs Screen Recording permission</span>
              </span>
              <Button disabled={busy} onClick={capture}>
                {busy ? 'Capturing…' : 'Capture'}
              </Button>
            </>
          )}
        </div>

        {source === 'url' && (
          <>
            <div className="flex items-center gap-2">
              <Field
                className="min-w-32 flex-1 font-mono text-[13px]"
                type="url"
                placeholder="http://localhost:3000"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && capture()}
              />
              <Button disabled={busy} onClick={capture}>
                {busy ? 'Capturing…' : 'Capture'}
              </Button>
            </div>
            <div className="flex items-center gap-3">
              <Segmented
                value={preset}
                onChange={setPreset}
                options={PRESETS.map((p) => ({ id: p.id, label: p.label }))}
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
            </div>
          </>
        )}
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
            /* self-start: tiles keep their own height instead of stretching to
               the tallest one in the row. */
            className="self-start overflow-hidden rounded-(--radius-card) border border-line-subtle bg-surface"
          >
            <img
              src={screenshotUrl(s.file)}
              alt={`${s.kind === 'screen' ? 'Mac screen' : 'App'} capture from ${timeAgo(s.createdAt)} ago`}
              loading="lazy"
              /* Real aspect ratio, so a desktop shot is not cropped to a phone
                 frame — except a full-page capture, which would otherwise make
                 a tile metres long: those get a tall frame and their top edge. */
              style={{ aspectRatio: tileRatio(s) }}
              className={`w-full cursor-zoom-in bg-ink object-top ${
                isLong(s) ? 'object-cover' : 'object-contain'
              }`}
              onClick={() => setViewing(s)}
            />
            <figcaption className="flex items-center px-1.5 py-0.5">
              <span
                className="flex min-w-0 flex-1 items-center gap-1 truncate pl-1.5 text-[11px] text-faint"
                title={s.width ? `${s.width}×${s.height}` : undefined}
              >
                {s.kind === 'screen' && <IconDisplay size={12} className="shrink-0" />}
                {timeAgo(s.createdAt)}
              </span>
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
