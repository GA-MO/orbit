import { useEffect, useRef, useState } from 'react'
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
  /* The Mac's own screen is no longer something this page can ask for — only
     the agent can, through `orbit_screen`. The shots still land in this
     gallery, so the tile that marks one still needs its icon. */
  IconDisplay,
  IconInsert,
  IconTrash,
  OrbitMark,
  timeAgo,
  useArrival,
} from '../components/ui'
import CaptureSheet from '../sheets/CaptureSheet'

/*
 * One subject: a port on this Mac.
 *
 * This tab used to carry two intentions in one column — "let me look at the
 * running app" (a row of port chips, a Share pill, a list of published rows)
 * and "take a picture and hand it to the agent" (a URL field, a viewport
 * preset, a gallery). The same port appeared twice in two vocabularies, `:5173
 * node` as a chip and `:5173 → :8443` as a row, and nothing on the screen said
 * they were the same thing. Worse, the URL field at the top was not the subject
 * it looked like: it was a state machine, and blanking it made a whole section
 * of the page disappear with no explanation.
 *
 * So there is one list now. A row is a port, it carries every state that port
 * can be in and every action it can take, and tapping its body is the one
 * gesture — publish if it needs publishing, then open it in a frame. The
 * capture settings that used to sit below the list are gone the same way: they
 * governed exactly one control, the ⧉ on a row, so the ⧉ asks now. See
 * `sheets/CaptureSheet`.
 */

const OTHER_URL_KEY = 'orbit.screenshotUrl'
/* `orbit.screenshotPreset` was here and is deliberately not replaced. It stored
   the last viewport so the settings row could come back preselected; with the
   choice made per shot there is no row to preselect, and reviving the value as
   a hidden default would restore the one property of the old control worth
   losing. Any key already in a phone's localStorage is simply never read. */

/** Where a port's frame was last left. Keyed by the local port, not the public
    one: the public port is handed out by `tailscale serve` at publish time and
    a port republished tomorrow may well get a different one. */
const routeKey = (port: number) => `orbit.previewRoute.${port}`

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
   loopback, and a URL pointing anywhere else is already reachable as it is.
   Still needed with the URL field gone, because the escape hatch at the foot of
   the list may well be pointed at a local port that already has a row. */
const localPortOf = (raw: string): number | null => {
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (!['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return null
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return null
  }
}

/** The part of a URL worth remembering per port — the whole address would pin
    a tailnet name and a public port that both outlive their usefulness. */
const routeOf = (url: string): string => {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return '/'
  }
}

/** Re-base a remembered route onto the address this port answers on today. */
const frameUrl = (p: Preview): string => {
  const saved = localStorage.getItem(routeKey(p.port))
  if (!saved || saved === '/') return p.url
  try {
    return new URL(saved, p.url).toString()
  } catch {
    return p.url
  }
}

/** Taller than this and the tile stops being a thumbnail and becomes a column. */
const MAX_TILE_RATIO = 16 / 9
const isLong = (s: Screenshot) => !!(s.width && s.height && s.height / s.width > MAX_TILE_RATIO)
const tileRatio = (s: Screenshot) =>
  !s.width || !s.height || isLong(s) ? '9 / 16' : `${s.width} / ${s.height}`

/** One line of the list: a port, what is holding it, and how it is published. */
interface PortRow {
  port: number
  /** The program `lsof` names, when the port is listening right now. */
  command: string | null
  /** The folder that program was started in, when the Mac will say. */
  project: string | null
  /** The tailnet mapping, when the port has one. Outlives the dev server. */
  preview: Preview | null
}

/* Entrances come from `useArrival` in the primitives rather than from a second
   copy here. Both lists on this page are polled — liveness every ten seconds,
   everything again on wake — and that hook is what makes "animate once, on
   arrival" a guarantee instead of an argument about React keys. */

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
  /* What is running, not whether anything is: two captures can be in flight at
     once (each gets its own page in the shared Chrome), and one of them
     greying out the others said they were related when they are not. */
  const [busy, setBusy] = useState<string | null>(null)
  /* Publishing is per port for the same reason, and it is the one thing on a
     row that takes long enough to need saying so. */
  const [publishing, setPublishing] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [framed, setFramed] = useState<{ url: string; port: number } | null>(null)
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherUrl, setOtherUrl] = useState(
    () => localStorage.getItem(OTHER_URL_KEY) ?? 'http://localhost:3000',
  )
  /* The pending capture, holding what it is of and what to do once the viewport
     is known. Keeping the closure here rather than a row id keeps the sheet
     ignorant of the difference between a row and the Other URL field — both are
     "a thing to photograph", and both ask the same question. */
  const [choosing, setChoosing] = useState<{
    subject: string
    run: (preset: PresetId, fullPage: boolean) => void
  } | null>(null)

  /* Left null until the first answer, and kept whole rather than reduced to its
     list: when tailscale is missing or logged out the reason is the only useful
     thing this page can say, and without it a row that refuses to publish looks
     like a bug rather than a machine that cannot publish anything. */
  const refreshPreviews = () => fetchPreviews().then(setPreviews).catch(() => {})

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
     row only told the truth about the moment the tab was opened. Merging the
     chips and the published rows into one list did not merge their polls, and
     must not: only the liveness half is cheap enough to ask every ten seconds
     — see `preview.liveness` for what the other half costs. `ports` is a string
     so a re-render with the same set does not restart the interval. */
  const ports = (previews?.previews ?? []).map((p) => p.port).join(',')
  useEffect(() => {
    if (!active || !ports) return
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const live = await fetchLiveness(ports.split(',').map(Number))
        setPreviews((cur) =>
          cur
            ? {
                ...cur,
                previews: cur.previews.map((p) => ({ ...p, listening: live[p.port] ?? p.listening })),
              }
            : cur,
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

  /* The union, keyed by port, lowest first. A port can be listening without
     being published (nothing has shared it yet) or published without listening
     (the dev server behind it died); the two facts are independent and the row
     is where they finally meet. */
  const published = previews?.previews ?? []
  const rows: PortRow[] = (() => {
    const byPort = new Map<number, PortRow>()
    for (const d of devPorts)
      byPort.set(d.port, {
        port: d.port,
        command: d.command,
        project: d.project ?? null,
        preview: null,
      })
    /* The published half is a `tailscale serve` mapping — port to port — and
       knows nothing about whose repo is behind it. It is folded into the row
       the listening half already built, so a port that is both keeps the
       project name; only a mapping whose dev server has since died falls back
       to being nothing but an address, which is all it is. */
    for (const p of published) {
      const found = byPort.get(p.port)
      if (found) found.preview = p
      else byPort.set(p.port, { port: p.port, command: null, project: null, preview: p })
    }
    return [...byPort.values()].sort((a, b) => a.port - b.port)
  })()

  const arriveRow = useArrival([...rows.map((r) => `port:${r.port}`), 'other'])
  const arriveTile = useArrival(shots.map((s) => s.file))

  const openFrame = (p: Preview) => setFramed({ url: frameUrl(p), port: p.port })

  /**
   * The one gesture. A published port opens where it was last left; a port that
   * is merely listening is published first, because "share it, then look at it"
   * was always the sequence and making it two taps only ever meant finding the
   * pill that did the first one.
   *
   * `startPreview` is idempotent — a double-tap gets the same mapping back
   * rather than a second one — so nothing guards against the second tap beyond
   * the spinner that explains the wait.
   */
  const openRow = async (row: PortRow) => {
    if (row.preview) {
      /* A published port outlives the dev server behind it, and an empty frame
         does not say which of the two is wrong. The row says it instead. */
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

  /**
   * Capture a port straight from its row — no URL to type at all.
   *
   * Says so when it lands: the new tile goes to the top of a gallery that is
   * often below the fold, so from up here a capture that worked and one that
   * quietly did nothing looked identical.
   */
  const captureRow = async (p: Preview, preset: PresetId, fullPage: boolean) => {
    const key = `row:${p.port}`
    if (busy === key) return
    setBusy(key)
    setError(null)
    try {
      await captureScreenshot({ ...captureVia(`http://localhost:${p.port}`, p), preset, fullPage })
      setShots(await fetchScreenshots())
      onToast(`Captured localhost:${p.port}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /* The escape hatch, for the one thing a list of local ports cannot hold: a
     staging URL, or a port on some other machine. It is a row at the foot of
     the list rather than a field at the top, because the field at the top spent
     a year looking like the subject of the page. Typing a local port here still
     goes out over the tailnet if that port is published — that is `captureVia`,
     and it is the difference between photographing the https app and the http
     one. */
  const captureOther = async (raw: string, preset: PresetId, fullPage: boolean) => {
    if (busy === 'other' || !raw) return
    setBusy('other')
    setError(null)
    try {
      localStorage.setItem(OTHER_URL_KEY, raw)
      const port = localPortOf(raw)
      const shared = published.find((p) => p.port === port) ?? null
      await captureScreenshot({ ...captureVia(raw, shared), preset, fullPage })
      setShots(await fetchScreenshots())
      onToast('Captured')
      setOtherOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /* Every capture this page can start goes through the sheet — there is no
     default viewport left to fall back on, and that is the point. */
  const ask = (subject: string, run: (preset: PresetId, fullPage: boolean) => void) =>
    setChoosing({ subject, run })

  const askOther = () => {
    const raw = otherUrl.trim()
    if (raw) ask(raw, (preset, fullPage) => captureOther(raw, preset, fullPage))
  }

  const remove = async (file: string) => {
    await deleteScreenshot(file)
    setShots((cur) => cur.filter((s) => s.file !== file))
    setViewing((cur) => (cur?.file === file ? null : cur))
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

      <div className="flex shrink-0 flex-col gap-1.5 px-4 pb-3">
        {rows.map((row) => {
          const p = row.preview
          const waiting = publishing.includes(row.port)
          return (
            <div
              key={row.port}
              /* The animation is on the row, whose key is the port, so the DOM
                 node survives every poll and the entrance cannot replay. */
              className={`${arriveRow(`port:${row.port}`).className} flex items-center rounded-(--radius-field) border border-line-subtle bg-ink pr-0.5 ${
                p ? 'lift' : ''
              }`}
              style={arriveRow(`port:${row.port}`).style}
            >
              <button
                type="button"
                /* Nothing here navigates the app anywhere: leaving costs an
                   installed web app its session screen and the way back is a
                   cold start, which is the whole reason the frame exists. */
                onClick={() => openRow(row)}
                disabled={waiting || !!(p && !p.listening)}
                aria-label={
                  p
                    ? `Open ${row.project ?? ''} :${row.port}`.trim()
                    : `Share ${row.project ?? ''} :${row.port} over https and open it`.trim()
                }
                className="press flex h-[52px] min-w-0 flex-1 items-center gap-2 px-3 text-left disabled:cursor-default"
              >
                {/* Whichever of the two names the row is the title, and takes
                    the accent and the size for it. `:5173 node` never said
                    which of six checkouts that was, so the folder leads when
                    the Mac can name it — but the port stays on the line in
                    every case, dropped to mono and faint. It is the half that
                    is unique (two repos can be `web`, two servers cannot hold
                    5173) and the half `orbit_preview` says out loud, so a row
                    that showed only a project would be unusable the moment an
                    agent named a port back at you.

                    The command goes when the project arrives: `node` was only
                    ever a weak stand-in for "which of my things is this", and
                    the folder answers that properly. On a 390px row the space
                    it frees is the space the folder needs. */}
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
                {/* The tailnet host is deliberately not here. It is identical on
                    every row and long enough to push the port that does differ
                    into the ellipsis; the whole address is on the frame's Copy
                    button for the once a month it is wanted. */}
                <span className="ml-auto min-w-0 truncate pl-2 text-right">
                  {waiting ? (
                    <OrbitMark size={15} />
                  ) : p?.listening ? (
                    <span className="font-mono text-xs text-faint">→ :{p.publicPort}</span>
                  ) : p ? (
                    <span className="text-[11px] text-mut">nothing there yet</span>
                  ) : null}
                </span>
              </button>
              {/* 44px, both of them: a miss on ✕ lands on the row, and a wrong
                  action is worse than the nothing a small button usually gives.
                  They stay live on a row whose body does not, because a shot of
                  a dead port is still an answer and stopping one is the whole
                  point of ✕. */}
              {p && (
                <>
                  <IconButton
                    /* The ellipsis is load-bearing. The frame has a ⧉ of its
                       own that shoots immediately, full page at the phone's
                       real width, and two identical glyphs that behave
                       differently is worse than either behaviour alone. This
                       one carries the chevron that means "asks first" and a
                       name that ends in a "…"; the frame's stays bare. */
                    label={`Capture :${p.port}…`}
                    size="lg"
                    className="hover:text-accent"
                    disabled={busy === `row:${p.port}`}
                    onClick={() =>
                      ask(
                        row.project ? `${row.project} · localhost:${p.port}` : `localhost:${p.port}`,
                        (preset, fullPage) => captureRow(p, preset, fullPage),
                      )
                    }
                  >
                    {busy === `row:${p.port}` ? (
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

        {/* A machine that cannot publish anything gets one sentence saying why,
            rather than rows that fail when they are tapped. */}
        {previews && !previews.available && previews.reason && (
          <p className="px-1 text-[11px] text-faint">{previews.reason}</p>
        )}
        {previews?.available && rows.length === 0 && (
          <p className="px-1 text-[11px] text-faint">Nothing is serving a web page on this Mac.</p>
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
                onKeyDown={(e) => e.key === 'Enter' && askOther()}
              />
              <Button disabled={busy === 'other'} onClick={askOther}>
                {busy === 'other' ? 'Capturing…' : 'Capture…'}
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
        {shots.map((s) => (
          <figure
            key={s.file}
            /* self-start: tiles keep their own height instead of stretching to
               the tallest one in the row. Keyed by the file, so the thirty
               tiles already on screen sit still while a new capture arrives. */
            className={`${arriveTile(s.file).className} self-start overflow-hidden rounded-(--radius-card) border border-line-subtle bg-surface`}
            style={arriveTile(s.file).style}
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

      {framed && (
        <PageViewer
          uri={framed.url}
          /* Same shape a row files a capture under, path included: two shots of
             one port taken at different routes should not share a name. */
          label={`localhost:${framed.port}${routeOf(framed.url) === '/' ? '' : routeOf(framed.url)}`}
          onClose={() => {
            /* Where you left it. An agent's `orbit_preview` opens a frame at a
               route it chose, and coming back to this tab afterwards used to
               land on `/` every time — the one page nobody was looking at. */
            localStorage.setItem(routeKey(framed.port), routeOf(framed.url))
            setFramed(null)
          }}
          onInsertPath={onInsertPath}
          onToast={onToast}
        />
      )}

      {choosing && (
        <CaptureSheet
          subject={choosing.subject}
          /* Closed before the shot, not after it: rendering takes seconds, and
             a sheet held open over them would say the choice was still being
             made. The row's ⧉ spins meanwhile, and the toast lands when the
             tile does. */
          onChoose={(preset, fullPage) => {
            setChoosing(null)
            choosing.run(preset, fullPage)
          }}
          onClose={() => setChoosing(null)}
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
