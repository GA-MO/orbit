import type { ReactNode } from 'react'

const PHONE_WIDTH = 390

const anchorId = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: ReactNode
}) {
  return (
    <section id={anchorId(title)} className="scroll-mt-4 border-t border-line/60 px-6 py-9">
      <h2 className="font-display text-lg font-semibold tracking-wide text-fore">{title}</h2>
      {note && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-mut">{note}</p>}
      <div className="mt-5 flex flex-wrap items-start gap-6">{children}</div>
    </section>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[11px] tracking-wide text-faint uppercase">{children}</div>
  )
}

export function Screen({
  label,
  ground = 'dark',
  width = PHONE_WIDTH,
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

export function Pad({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-3 p-4 ${className}`}>{children}</div>
}

export function Cell({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-line/50 px-2 py-3">
      <div className="flex min-h-11 items-center justify-center">{children}</div>
      <div className="font-mono text-[10px] leading-tight text-faint">{name}</div>
    </div>
  )
}

export function Aside({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-2xl rounded-(--radius-field) border border-live/30 bg-live/5 px-3.5 py-2.5 text-[13px] leading-relaxed text-live/90">
      {children}
    </p>
  )
}
