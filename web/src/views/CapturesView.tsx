import { useEffect, useState } from 'react'
import {
  PRESETS,
  captureScreenshot,
  closeCaptureBrowser,
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
  IconClose,
  /* The Mac's own screen is no longer something this page can ask for — only
     the agent can, through `orbit_screen`. The shots still land in this
     gallery, so the tile that marks one still needs its icon. */
  IconDisplay,
  IconExternal,
  IconInsert,
  IconLink,
  IconTrash,
  OrbitMark,
  Segmented,
  timeAgo,
} from '../components/ui'
import { openExternal, resolveUri } from '../local-url'

const URL_KEY = 'orbit.screenshotUrl'
const PRESET_KEY = 'orbit.screenshotPreset'

/**
 * Where to render a shot from, and what to file it under.
 *
 * A published port is captured through its tailnet address rather than
 * `localhost`, because that is the one the phone gets: https, a secure context,
 * `Secure` cookies, a registered service worker. An app that only misbehaves
 * under https would otherwise photograph perfectly. The label stays the port,
 * or the gallery would file every shot under the same `ts.net:8443`.
 */
const captureVia = (raw: string, shared: Preview | null): { url: string; label?: string } => {
  if (!shared) return { url: raw }
  try {
    const typed = new URL(raw.includes('://') ? raw : `http://${raw}`)
    const via = new URL(shared.url)
    via.pathname = typed.pathname
    via.search = typed.search
    via.hash = typed.hash
    const path = typed.pathname === '/' ? '' : typed.pathname
    return { url: via.toString(), label: `localhost:${shared.port}${path}` }
  } catch {
    return { url: raw }
  }
}

/* Only a port on this Mac can be published — `tailscale serve` proxies to
   loopback, and a URL pointing anywhere else is already reachable as it is. */
const localPortOf = (raw: string): number | null => {
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (!['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return null
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return null
  }
}

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
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) ?? 'http://localhost:3000')
  const [preset, setPreset] = useState<PresetId>(
    () => (localStorage.getItem(PRESET_KEY) as PresetId | null) ?? 'phone',
  )
  const [devPorts, setDevPorts] = useState<DevPort[]>([])
  const [fullPage, setFullPage] = useState(false)
  const [shots, setShots] = useState<Screenshot[]>([])
  const [viewing, setViewing] = useState<Screenshot | null>(null)
  /* What is running, not whether anything is: two captures can be in flight at
     once (each gets its own page in the shared Chrome), and one of them
     greying out the others said they were related when they are not. */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Preview[] | null>(null)
  const [sharing, setSharing] = useState(false)
  const [framed, setFramed] = useState<Preview | null>(null)
  const [closingChrome, setClosingChrome] = useState(false)

  /* Null until the first answer, and left null when tailscale is missing or
     logged out — there is no useful thing to say about a machine that cannot
     publish anything, so the row simply is not there. */
  const refreshPreviews = () =>
    fetchPreviews()
      .then((s) => setPreviews(s.available ? s.previews : null))
      .catch(() => {})

  /* Same cost profile as the published list — a process launch and a socket per
     candidate — so it is asked at the same two moments and never polled. An
     agent that starts a dev server while this is on screen is the case a poll
     would catch, and switching away and back is cheaper than paying for it all
     day. */
  const refreshDevPorts = () => fetchDevPorts().then(setDevPorts).catch(() => {})

  useEffect(() => {
    if (!active) return
    fetchScreenshots().then(setShots).catch(() => {})
    refreshPreviews()
    refreshDevPorts()
    /* Coming back from the lock screen or another app: what was published, and
       what is still running behind it, both had every chance to change while
       the page was frozen. */
    const onWake = () => {
      if (document.visibilityState !== 'visible') return
      refreshPreviews()
      refreshDevPorts()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [active])

  /* An agent restarting a dev server is the normal case, and until this ran the
     row only told the truth about the moment the tab was opened. Only the
     liveness half is polled; see `preview.liveness` for why the other half is
     not. `ports` is a string so a re-render with the same set does not restart
     the interval. */
  const ports = (previews ?? []).map((p) => p.port).join(',')
  useEffect(() => {
    if (!active || !ports) return
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const live = await fetchLiveness(ports.split(',').map(Number))
        setPreviews((cur) =>
          cur ? cur.map((p) => ({ ...p, listening: live[p.port] ?? p.listening })) : cur,
        )
      } catch {
        // a poll that fails leaves the last answer standing
      }
    }
    const timer = setInterval(poll, 10_000)
    return () => clearInterval(timer)
  }, [active, ports])

  /* `timeAgo` reads the clock when it renders, and a tile only re-renders when
     the list changes — so every capture sat there saying "now" indefinitely. */
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [active])

  const port = localPortOf(url)
  const shared = previews?.find((p) => p.port === port) ?? null

  const share = async () => {
    if (!port || sharing) return
    setSharing(true)
    setError(null)
    try {
      await startPreview(port)
      await refreshPreviews()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSharing(false)
    }
  }

  const unshare = async (p: Preview) => {
    setError(null)
    try {
      await stopPreview(p.publicPort)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refreshPreviews()
  }

  const capture = async () => {
    if (busy === 'main' || !url.trim()) return
    setBusy('main')
    setError(null)
    try {
      localStorage.setItem(URL_KEY, url.trim())
      localStorage.setItem(PRESET_KEY, preset)
      await captureScreenshot({ ...captureVia(url.trim(), shared), preset, fullPage })
      setShots(await fetchScreenshots())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Capture a published port straight from its row — no URL to type at all.
   *
   * Says so when it lands: the new tile goes to the top of a gallery that is
   * often below the fold, so from up here a capture that worked and one that
   * quietly did nothing looked identical.
   */
  const captureRow = async (p: Preview) => {
    const key = `row:${p.publicPort}`
    if (busy === key) return
    setBusy(key)
    setError(null)
    try {
      await captureScreenshot({ url: p.url, label: `localhost:${p.port}`, preset, fullPage })
      setShots(await fetchScreenshots())
      onToast(`Captured localhost:${p.port}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (file: string) => {
    await deleteScreenshot(file)
    setShots((cur) => cur.filter((s) => s.file !== file))
    setViewing((cur) => (cur?.file === file ? null : cur))
  }

  const closeChrome = async () => {
    if (closingChrome) return
    setClosingChrome(true)
    setError(null)
    try {
      await closeCaptureBrowser()
      onToast('Capture browser closed')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setClosingChrome(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* One line. The long version of this sat here and again in the empty
          state below it, and on a 390px screen two of them is most of the
          fold. The empty state keeps the full sentence — it has the room. */}
      <header className="shrink-0 px-5 pt-4 pb-3">
        <h1 className="font-display text-lg font-semibold tracking-wide">Preview</h1>
        <p className="mt-0.5 text-xs text-mut">
          Your running app — live in a frame, or as a screenshot
        </p>
      </header>

      {/* Deliberate rows: on a phone every control fits without stealing the gallery's height. */}
      <div className="flex shrink-0 flex-col gap-2 px-4 pb-3">
        <div className="flex items-center gap-2">
          <Field
            className="min-w-32 flex-1 font-mono text-[13px]"
            type="url"
            placeholder="http://localhost:3000"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && capture()}
          />
          {/* A screenshot answers "how does it look"; some questions only the
              running app answers. localhost is rewritten to whichever host this
              phone reached Orbit on, so the tap lands on the Mac.

              Gone once the port is published, because then it is the worse of
              two doors sitting side by side: it hands the phone plain http on a
              port a loopback-bound dev server never answers, and leaving costs
              an installed app its session screen. The row below opens the same
              app over the terminal instead. */}
          {!shared && (
            <IconButton
              size="lg"
              label="Open live in the browser"
              disabled={!url.trim()}
              onClick={() => openExternal(resolveUri(url.trim()))}
            >
              <IconExternal size={18} />
            </IconButton>
          )}
          <Button disabled={busy === 'main'} onClick={capture}>
            {busy === 'main' ? 'Capturing…' : 'Capture'}
          </Button>
        </div>

        {/* What the Mac is actually serving, so the port does not have to be
            typed on a touch keyboard or remembered at all. This replaced a list
            of URLs that had rendered before, which existed only because typing
            was the way in: a port that is up right now is both more useful and
            never stale, and a chip for a dev server that has since died is
            precisely the wrong thing to offer. The field still remembers the
            last URL, so a path typed after the port survives coming back. */}
        {devPorts.length > 0 && (
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {devPorts.map((d) => (
              <button
                key={d.port}
                onClick={() => setUrl(`http://localhost:${d.port}`)}
                className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] transition-colors ${
                  d.port === port
                    ? 'border-accent/50 text-accent'
                    : 'border-line-subtle text-faint hover:text-mut'
                }`}
              >
                <span className="font-mono">:{d.port}</span>
                <span className="opacity-70">{d.command}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Segmented
            value={preset}
            onChange={setPreset}
            options={PRESETS.map((p) => ({ id: p.id, label: p.label }))}
          />
          {/* The label is the target, not the box — but it was only as tall as
              the text, which on a phone is the same miss the Share button was
              making. */}
          <label className="flex min-h-11 items-center gap-1.5 text-xs whitespace-nowrap text-mut">
            <input
              type="checkbox"
              className="size-4 accent-accent-strong"
              checked={fullPage}
              onChange={(e) => setFullPage(e.target.checked)}
            />
            Full page
          </label>
          {/* Orbit keeps one headless Chrome warm between captures. This only
              closes that process — not Safari/Chrome tabs an agent opened. */}
          <button
            type="button"
            disabled={closingChrome}
            onClick={closeChrome}
            className="ml-auto min-h-11 shrink-0 px-1 text-[11px] text-faint transition-colors hover:text-mut disabled:opacity-40"
          >
            {closingChrome ? 'Closing…' : 'Close capture browser'}
          </button>
        </div>

        {/* A dev server is http on a port only the Mac can see; published over
            the tailnet it becomes https, which means it opens over the terminal
            instead of walking the app off its own page. */}
        {previews && (previews.length > 0 || port !== null) && (
          <div className="flex flex-col gap-1.5">
            {/* 44px tall, not the 26 a pill this size comes out at: a tap
                landing a few px low hit the gap instead, and missing looked
                exactly like a press that did nothing — no row, no error, and
                the same button still sitting there to press again. */}
            {port !== null && !shared && (
              <button
                onClick={share}
                disabled={sharing}
                className="flex min-h-11 items-center gap-1.5 self-start rounded-full border border-line-subtle px-3.5 text-xs text-mut transition-colors hover:text-fore disabled:opacity-40"
              >
                <IconLink size={14} />
                {sharing ? `Sharing :${port}…` : `Share :${port} over https`}
              </button>
            )}
            {/* Tapping a row is the point of the row, and nothing else on the
                screen says so once the Share button has done its job. */}
            {previews.length > 0 && (
              <span className="px-0.5 text-[11px] text-faint">
                Shared over https — tap to open here
              </span>
            )}
            {previews.map((p) => (
              <div
                key={p.publicPort}
                className="flex items-center gap-1 rounded-(--radius-field) border border-line-subtle bg-ink px-1"
              >
                {/* The tailnet host used to be spelled out here and it was the
                    one part of the row carrying no information: the same name
                    on every row, and long enough that what does differ — the
                    port it answers on — was inside the ellipsis. The two ports
                    say it all; the whole address is on the frame's Copy
                    button when it is wanted. */}
                <button
                  onClick={() => setFramed(p)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1.5 text-left"
                >
                  <span className="shrink-0 font-mono text-xs text-accent">:{p.port}</span>
                  <span className="shrink-0 font-mono text-xs text-faint">→ :{p.publicPort}</span>
                  {/* A published port outlives the dev server behind it, and an
                      empty frame does not say which of the two is wrong. */}
                  {!p.listening && (
                    <span className="min-w-0 flex-1 truncate text-right text-[11px] text-mut">
                      nothing there yet
                    </span>
                  )}
                </button>
                {/* 44px, like the Share button above them: a miss on ✕ lands on
                    the row, which opens the frame — a wrong action is worse
                    than the nothing a small button usually gives. */}
                <IconButton
                  label={`Capture :${p.port}`}
                  size="lg"
                  className="hover:text-accent"
                  disabled={busy === `row:${p.publicPort}` || !p.listening}
                  onClick={() => captureRow(p)}
                >
                  {busy === `row:${p.publicPort}` ? (
                    <OrbitMark size={16} />
                  ) : (
                    <IconCapture size={16} />
                  )}
                </IconButton>
                <IconButton label={`Stop sharing :${p.port}`} size="lg" onClick={() => unshare(p)}>
                  <IconClose size={16} />
                </IconButton>
              </div>
            ))}
          </div>
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
            {/* What it was of, on its own line: a tile this narrow truncates
                host:port down to the host, which is the half that never varies. */}
            <div
              className="flex items-center gap-1 px-2.5 pt-1 text-[11px] text-faint"
              title={`${s.label ?? 'Mac screen'} · ${timeAgo(s.createdAt)} ago${
                s.width ? ` · ${s.width}×${s.height}` : ''
              }`}
            >
              {s.kind === 'screen' && <IconDisplay size={12} className="shrink-0" />}
              <span className="truncate font-mono">{s.label ?? 'Mac screen'}</span>
            </div>
            <figcaption className="flex items-center px-1.5 py-0.5">
              <span className="flex-1 pl-1.5 text-[11px] text-faint">
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

      {framed && (
        <PageViewer
          uri={framed.url}
          label={`localhost:${framed.port}`}
          onClose={() => setFramed(null)}
          onInsertPath={onInsertPath}
          onToast={onToast}
        />
      )}

      {viewing && (
        <div
          className="app-fill z-50 flex items-center justify-center bg-black/85 p-4"
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
