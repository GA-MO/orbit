import { useEffect, useState } from 'react'
import {
  captureScreenshot,
  deleteScreenshot,
  fetchDevPorts,
  fetchLiveness,
  fetchPreviews,
  fetchScreenshots,
  screenshotUrl,
  startPreview,
  stopPreview,
  type DevPort,
  type Preview,
  type PreviewState,
  type PresetId,
  type Screenshot,
} from '../api'
import PageViewer from '../components/PageViewer'
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  IconCapture,
  IconChevronDown,
  IconClose,
  IconDisplay,
  IconInsert,
  IconTrash,
  OrbitMark,
  timeAgo,
  useArrival,
} from '../components/ui'
import CaptureSheet from '../sheets/CaptureSheet'

const OTHER_URL_KEY = 'orbit.screenshotUrl'
const DEFAULT_OTHER_URL = 'http://localhost:3000'

const LIVENESS_POLL_MS = 10_000
const TIME_AGO_REFRESH_MS = 30_000

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0']

const routeKey = (localPort: number) => `orbit.previewRoute.${localPort}`

const withScheme = (raw: string) => (raw.includes('://') ? raw : `http://${raw}`)

const captureLabel = (port: number, path: string) => `localhost:${port}${path === '/' ? '' : path}`

const captureTarget = (raw: string, shared: Preview | null): { url: string; label?: string } => {
  if (!shared) return { url: raw }
  try {
    const requested = new URL(withScheme(raw))
    const overTailnet = new URL(shared.url)
    overTailnet.pathname = requested.pathname
    overTailnet.search = requested.search
    overTailnet.hash = requested.hash
    return { url: overTailnet.toString(), label: captureLabel(shared.port, requested.pathname) }
  } catch {
    return { url: raw }
  }
}

const localPortOf = (raw: string): number | null => {
  try {
    const u = new URL(withScheme(raw))
    if (!LOOPBACK_HOSTS.includes(u.hostname)) return null
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return null
  }
}

const routeOf = (url: string): string => {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return '/'
  }
}

const rememberedFrameUrl = (p: Preview): string => {
  const savedRoute = localStorage.getItem(routeKey(p.port))
  if (!savedRoute || savedRoute === '/') return p.url
  try {
    return new URL(savedRoute, p.url).toString()
  } catch {
    return p.url
  }
}

const rememberFrameRoute = (port: number, url: string) =>
  localStorage.setItem(routeKey(port), routeOf(url))

const MAX_TILE_RATIO = 16 / 9
const TALL_TILE_RATIO = '9 / 16'
const isTallerThanTile = (s: Screenshot) =>
  !!(s.width && s.height && s.height / s.width > MAX_TILE_RATIO)
const tileRatio = (s: Screenshot) =>
  !s.width || !s.height || isTallerThanTile(s) ? TALL_TILE_RATIO : `${s.width} / ${s.height}`

interface PortRow {
  port: number
  command: string | null
  project: string | null
  preview: Preview | null
}

const mergePortRows = (listening: DevPort[], published: Preview[]): PortRow[] => {
  const byPort = new Map<number, PortRow>()
  for (const d of listening)
    byPort.set(d.port, {
      port: d.port,
      command: d.command,
      project: d.project ?? null,
      preview: null,
    })
  for (const p of published) {
    const alreadyListening = byPort.get(p.port)
    if (alreadyListening) alreadyListening.preview = p
    else byPort.set(p.port, { port: p.port, command: null, project: null, preview: p })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

const useRefreshOnWake = (active: boolean, refresh: () => void) => {
  useEffect(() => {
    if (!active) return
    const onWake = () => {
      if (document.visibilityState !== 'visible') return
      refresh()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}

const useTimeAgoRefresh = (active: boolean) => {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => tick((n) => n + 1), TIME_AGO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [active])
}

type CaptureRun = (preset: PresetId, fullPage: boolean) => void

interface PendingCapture {
  subject: string
  run: CaptureRun
}

interface Props {
  active: boolean
  onInsertPath: (path: string) => void
  onToast: (message: string) => void
}

export default function CapturesView({ active, onInsertPath, onToast }: Props) {
  const [devPorts, setDevPorts] = useState<DevPort[]>([])
  const [previews, setPreviews] = useState<PreviewState | null>(null)
  const [shots, setShots] = useState<Screenshot[]>([])
  const [viewing, setViewing] = useState<Screenshot | null>(null)
  const [capturing, setCapturing] = useState<string | null>(null)
  const [publishing, setPublishing] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [framed, setFramed] = useState<{ url: string; port: number } | null>(null)
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherUrl, setOtherUrl] = useState(
    () => localStorage.getItem(OTHER_URL_KEY) ?? DEFAULT_OTHER_URL,
  )
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | null>(null)

  const refreshPreviews = () => fetchPreviews().then(setPreviews).catch(() => {})
  const refreshDevPorts = () => fetchDevPorts().then(setDevPorts).catch(() => {})
  const refreshPorts = () => {
    refreshPreviews()
    refreshDevPorts()
  }

  useEffect(() => {
    if (!active) return
    fetchScreenshots().then(setShots).catch(() => {})
    refreshPorts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useRefreshOnWake(active, refreshPorts)

  const publishedPortsKey = (previews?.previews ?? []).map((p) => p.port).join(',')
  useEffect(() => {
    if (!active || !publishedPortsKey) return
    const publishedPorts = publishedPortsKey.split(',').map(Number)
    const pollLiveness = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const live = await fetchLiveness(publishedPorts)
        setPreviews((cur) =>
          cur
            ? {
                ...cur,
                previews: cur.previews.map((p) => ({ ...p, listening: live[p.port] ?? p.listening })),
              }
            : cur,
        )
      } catch {
        return
      }
    }
    const timer = setInterval(pollLiveness, LIVENESS_POLL_MS)
    return () => clearInterval(timer)
  }, [active, publishedPortsKey])

  useTimeAgoRefresh(active)

  const published = previews?.previews ?? []
  const rows = mergePortRows(devPorts, published)

  const arriveRow = useArrival([...rows.map((r) => `port:${r.port}`), 'other'])
  const arriveTile = useArrival(shots.map((s) => s.file))

  const openFrame = (p: Preview) => setFramed({ url: rememberedFrameUrl(p), port: p.port })

  const openRow = async (row: PortRow) => {
    if (row.preview) {
      if (row.preview.listening) openFrame(row.preview)
      return
    }
    if (publishing.includes(row.port)) return
    setPublishing((cur) => [...cur, row.port])
    setError(null)
    try {
      const preview = await startPreview(row.port)
      await refreshPreviews()
      openFrame(preview)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishing((cur) => cur.filter((p) => p !== row.port))
    }
  }

  const unpublish = async (p: Preview) => {
    setError(null)
    try {
      await stopPreview(p.publicPort)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refreshPreviews()
  }

  const rowCaptureKey = (port: number) => `row:${port}`

  const captureRow = async (p: Preview, preset: PresetId, fullPage: boolean) => {
    const key = rowCaptureKey(p.port)
    if (capturing === key) return
    setCapturing(key)
    setError(null)
    try {
      await captureScreenshot({
        ...captureTarget(`http://localhost:${p.port}`, p),
        preset,
        fullPage,
      })
      setShots(await fetchScreenshots())
      onToast(`Captured localhost:${p.port}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCapturing(null)
    }
  }

  const captureOther = async (raw: string, preset: PresetId, fullPage: boolean) => {
    if (capturing === 'other' || !raw) return
    setCapturing('other')
    setError(null)
    try {
      localStorage.setItem(OTHER_URL_KEY, raw)
      const port = localPortOf(raw)
      const sharedOverTailnet = published.find((p) => p.port === port) ?? null
      await captureScreenshot({ ...captureTarget(raw, sharedOverTailnet), preset, fullPage })
      setShots(await fetchScreenshots())
      onToast('Captured')
      setOtherOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCapturing(null)
    }
  }

  const askViewport = (subject: string, run: CaptureRun) => setPendingCapture({ subject, run })

  const askViewportForOther = () => {
    const raw = otherUrl.trim()
    if (raw) askViewport(raw, (preset, fullPage) => captureOther(raw, preset, fullPage))
  }

  const askViewportForRow = (row: PortRow, p: Preview) =>
    askViewport(
      row.project ? `${row.project} · localhost:${p.port}` : `localhost:${p.port}`,
      (preset, fullPage) => captureRow(p, preset, fullPage),
    )

  const deleteShot = async (file: string) => {
    await deleteScreenshot(file)
    setShots((cur) => cur.filter((s) => s.file !== file))
    setViewing((cur) => (cur?.file === file ? null : cur))
  }

  const closeFrame = () => {
    if (!framed) return
    rememberFrameRoute(framed.port, framed.url)
    setFramed(null)
  }

  const cannotPublishReason = previews && !previews.available ? previews.reason : null

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 px-5 pt-4 pb-3">
        <h1 className="font-display text-lg font-semibold tracking-wide">Preview</h1>
        <p className="mt-0.5 text-xs text-mut">
          Your running app — live in a frame, or as a screenshot
        </p>
      </header>

      <div className="flex shrink-0 flex-col gap-1.5 px-4 pb-3">
        {rows.map((row) => {
          const p = row.preview
          const isPublishing = publishing.includes(row.port)
          const publishedButDead = !!(p && !p.listening)
          const rowIsCapturing = !!p && capturing === rowCaptureKey(p.port)
          return (
            <div
              key={row.port}
              className={`${arriveRow(`port:${row.port}`).className} flex items-center rounded-(--radius-field) border border-line-subtle bg-ink pr-0.5 ${
                p ? 'lift' : ''
              }`}
              style={arriveRow(`port:${row.port}`).style}
            >
              <button
                type="button"
                onClick={() => openRow(row)}
                disabled={isPublishing || publishedButDead}
                aria-label={
                  p
                    ? `Open ${row.project ?? ''} :${row.port}`.trim()
                    : `Share ${row.project ?? ''} :${row.port} over https and open it`.trim()
                }
                className="press flex h-[52px] min-w-0 flex-1 items-center gap-2 px-3 text-left disabled:cursor-default"
              >
                {row.project ? (
                  <>
                    <span className="truncate text-[13px] font-medium text-fore">
                      {row.project}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">:{row.port}</span>
                  </>
                ) : (
                  <>
                    <span className="shrink-0 font-mono text-[13px] text-accent">:{row.port}</span>
                    {row.command && (
                      <span className="shrink-0 text-[11px] text-faint">{row.command}</span>
                    )}
                  </>
                )}
                <span className="ml-auto min-w-0 truncate pl-2 text-right">
                  {isPublishing ? (
                    <OrbitMark size={15} />
                  ) : p?.listening ? (
                    <span className="font-mono text-xs text-faint">→ :{p.publicPort}</span>
                  ) : p ? (
                    <span className="text-[11px] text-mut">nothing there yet</span>
                  ) : null}
                </span>
              </button>
              {p && (
                <>
                  <IconButton
                    label={`Capture :${p.port}…`}
                    size="lg"
                    className="hover:text-accent"
                    disabled={rowIsCapturing || !p.listening}
                    onClick={() => askViewportForRow(row, p)}
                  >
                    {rowIsCapturing ? (
                      <OrbitMark size={16} />
                    ) : (
                      <span className="relative inline-flex">
                        <IconCapture size={16} />
                        <IconChevronDown
                          size={9}
                          className="absolute -right-1 -bottom-0.5 text-faint"
                        />
                      </span>
                    )}
                  </IconButton>
                  <IconButton
                    label={`Stop sharing :${p.port}`}
                    size="lg"
                    onClick={() => unpublish(p)}
                  >
                    <IconClose size={16} />
                  </IconButton>
                </>
              )}
            </div>
          )
        })}

        {cannotPublishReason && (
          <p className="px-1 text-[11px] text-faint">{cannotPublishReason}</p>
        )}
        {previews?.available && rows.length === 0 && (
          <p className="px-1 text-[11px] text-faint">Nothing is serving a web page on this machine.</p>
        )}

        <div
          className={arriveRow('other').className}
          style={arriveRow('other').style}
        >
          {otherOpen ? (
            <div className="flex items-center gap-2">
              <Field
                className="min-w-0 flex-1 font-mono text-[13px]"
                type="url"
                autoFocus
                placeholder="https://staging.example.com"
                value={otherUrl}
                onChange={(e) => setOtherUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && askViewportForOther()}
              />
              <Button disabled={capturing === 'other'} onClick={askViewportForOther}>
                {capturing === 'other' ? 'Capturing…' : 'Capture…'}
              </Button>
              <IconButton label="Cancel" size="lg" onClick={() => setOtherOpen(false)}>
                <IconClose size={16} />
              </IconButton>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOtherOpen(true)}
              className="press flex h-[52px] w-full items-center rounded-(--radius-field) border border-dashed border-line-subtle px-3 text-left text-xs text-faint hover:text-mut"
            >
              Other URL…
            </button>
          )}
        </div>

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
        {shots.map((s) => {
          const subjectName = s.label ?? 'Screen'
          const isScreenCapture = s.kind === 'screen'
          return (
            <figure
              key={s.file}
              className={`${arriveTile(s.file).className} self-start overflow-hidden rounded-(--radius-card) border border-line-subtle bg-surface`}
              style={arriveTile(s.file).style}
            >
              <img
                src={screenshotUrl(s.file)}
                alt={`${isScreenCapture ? 'Screen' : 'App'} capture from ${timeAgo(s.createdAt)} ago`}
                loading="lazy"
                style={{ aspectRatio: tileRatio(s) }}
                className={`w-full cursor-zoom-in bg-ink object-top ${
                  isTallerThanTile(s) ? 'object-cover' : 'object-contain'
                }`}
                onClick={() => setViewing(s)}
              />
              <div
                className="flex items-center gap-1 px-2.5 pt-1 text-[11px] text-faint"
                title={`${subjectName} · ${timeAgo(s.createdAt)} ago${
                  s.width ? ` · ${s.width}×${s.height}` : ''
                }`}
              >
                {isScreenCapture && <IconDisplay size={12} className="shrink-0" />}
                <span className="truncate font-mono">{subjectName}</span>
              </div>
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
                  onClick={() => deleteShot(s.file)}
                >
                  <IconTrash size={15} />
                </IconButton>
              </figcaption>
            </figure>
          )
        })}
      </div>

      {framed && (
        <PageViewer
          uri={framed.url}
          label={captureLabel(framed.port, routeOf(framed.url))}
          onClose={closeFrame}
          onInsertPath={onInsertPath}
          onToast={onToast}
        />
      )}

      {pendingCapture && (
        <CaptureSheet
          subject={pendingCapture.subject}
          onChoose={(preset, fullPage) => {
            setPendingCapture(null)
            pendingCapture.run(preset, fullPage)
          }}
          onClose={() => setPendingCapture(null)}
        />
      )}

      {viewing && (
        <div
          className="app-fill scrim z-50 flex items-center justify-center p-4"
          onClick={() => setViewing(null)}
        >
          <img
            src={screenshotUrl(viewing.file)}
            alt="Capture full view"
            className="pop-in max-h-full max-w-full rounded-(--radius-card)"
          />
        </div>
      )}
    </div>
  )
}
