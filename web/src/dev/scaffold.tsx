import type { ReactNode } from 'react'

/* ---------------------------------------------------------------------------
   The furniture the gallery is hung on. Deliberately plain — every pixel of
   personality on this page should belong to the thing being reviewed, so the
   labels are grey text on a flat surface and nothing here is animated.

   These use raw Tailwind utilities rather than Orbit's own primitives on
   purpose: a gallery that renders its own chrome with the components it is
   auditing cannot show you a broken Button without breaking itself.
--------------------------------------------------------------------------- */

/** A titled band of the page. The `note` is where a state earns its place. */
export function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: ReactNode
}) {
  /* Anchored by its own title so one section can be looked at on its own.
     The whole page is ten thousand pixels tall, and a capture of all of it is
     too small to judge a hairline by — `#button` is how the next agent gets a
     readable screenshot of the thing it just changed. */
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return (
    <section id={id} className="scroll-mt-4 border-t border-line/60 px-6 py-9">
      <h2 className="font-display text-lg font-semibold tracking-wide text-fore">{title}</h2>
      {note && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-mut">{note}</p>}
      <div className="mt-5 flex flex-wrap items-start gap-6">{children}</div>
    </section>
  )
}

/** A caption for one specimen, so a screenshot can be talked about. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[11px] tracking-wide text-faint uppercase">{children}</div>
  )
}

/**
 * One phone-shaped specimen.
 *
 * 390px is the real target and so the default; `width` opens it out for the
 * few things that have to survive a tablet or a landscape phone. `height`
 * turns it into a fixed viewport, which is what anything `position: fixed`
 * needs in order to be trapped inside the frame instead of covering the page.
 */
export function Screen({
  label,
  ground = 'dark',
  width = 390,
  height,
  showHits = false,
  children,
}: {
  label: ReactNode
  ground?: 'dark' | 'light'
  width?: number
  height?: number
  showHits?: boolean
  children: ReactNode
}) {
  return (
    <div style={{ width }}>
      <Label>{label}</Label>
      <div
        className={`screen rounded-(--radius-card) border border-line ${
          ground === 'dark' ? 'ground-dark' : 'ground-light'
        } ${showHits ? 'show-hits' : ''}`}
        style={{ height }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The same specimen on both grounds, which is the whole argument for this page
 * existing in a dark-native app: the dark frame is what ships, and the pale one
 * beside it is the control. Anything that reads identically in both is drawing
 * its own background; anything that disappears was borrowing the app's.
 */
export function Both({
  label,
  width,
  height,
  showHits,
  children,
}: {
  label: ReactNode
  width?: number
  height?: number
  showHits?: boolean
  children: ReactNode
}) {
  return (
    <>
      <Screen label={label} ground="dark" width={width} height={height} showHits={showHits}>
        {children}
      </Screen>
      <Screen
        label={<>{label} · pale ground</>}
        ground="light"
        width={width}
        height={height}
        showHits={showHits}
      >
        {children}
      </Screen>
    </>
  )
}

/** Padding for specimens that would otherwise sit flush against the frame. */
export function Pad({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-3 p-4 ${className}`}>{children}</div>
}

/** A labelled cell inside a grid of variants. */
export function Cell({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-line/50 px-2 py-3">
      <div className="flex min-h-11 items-center justify-center">{children}</div>
      <div className="font-mono text-[10px] leading-tight text-faint">{name}</div>
    </div>
  )
}

/** Something the page needs to say in its own voice, not a component's. */
export function Aside({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-2xl rounded-(--radius-field) border border-live/30 bg-live/5 px-3.5 py-2.5 text-[13px] leading-relaxed text-live/90">
      {children}
    </p>
  )
}
