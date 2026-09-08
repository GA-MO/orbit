import { Label } from './scaffold'

/* ---------------------------------------------------------------------------
   The palette, read back out of the running stylesheet.

   Every value on this page is resolved from the document rather than typed in
   beside a swatch. A hardcoded hex would be right the day it was written and a
   lie a week later, and a token list that lies is worse than none: it is the
   thing a reviewer trusts instead of looking.
--------------------------------------------------------------------------- */

const read = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const SURFACES = ['ink', 'surface', 'raised', 'overlay', 'line-subtle', 'line']
const INKS = ['fore', 'mut', 'faint']
const SIGNALS = ['accent', 'accent-strong', 'glow', 'live', 'ok', 'danger']

function Swatch({ name }: { name: string }) {
  const value = read(`--color-${name}`)
  return (
    <div className="w-[168px]">
      <div
        className="h-14 rounded-(--radius-field) border border-line"
        style={{ background: value }}
      />
      <div className="mt-1.5 font-mono text-[11px] text-fore">--color-{name}</div>
      <div className="font-mono text-[11px] text-faint">{value || '—'}</div>
    </div>
  )
}

function Group({ title, names }: { title: string; names: string[] }) {
  return (
    <div>
      <Label>{title}</Label>
      <div className="flex flex-wrap gap-3">
        {names.map((n) => (
          <Swatch key={n} name={n} />
        ))}
      </div>
    </div>
  )
}

/* The three radii are only meaningful against each other, so they are drawn at
   one size and side by side; a card corner shown alone tells you nothing. */
function Radii() {
  return (
    <div>
      <Label>Radii</Label>
      <div className="flex flex-wrap gap-3">
        {['field', 'card', 'sheet'].map((name) => (
          <div key={name} className="w-[168px]">
            <div
              className="flex h-14 items-center justify-center border border-line bg-raised text-xs text-mut"
              style={{ borderRadius: `var(--radius-${name})` }}
            >
              {read(`--radius-${name}`) || '—'}
            </div>
            <div className="mt-1.5 font-mono text-[11px] text-fore">--radius-{name}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* Depth in Orbit is light on a top edge plus occlusion underneath, never a
   grey card shadow — which is exactly the sort of claim that is impossible to
   check in prose and obvious in a row of three tiles. `.lift` and `.key-lit`
   are shown as the classes a component would actually reach for; the raw
   shadow variables are shown too, because one of them (`--shadow-sheet`)
   throws its light upward and no class exposes it on its own. */
function Depth() {
  return (
    <div>
      <Label>Elevation</Label>
      <div className="flex flex-wrap gap-4 pt-2 pb-6">
        <div className="lift flex h-16 w-[168px] items-center justify-center rounded-(--radius-card) bg-raised font-mono text-[11px] text-mut">
          .lift
        </div>
        <div className="key-lit flex h-16 w-[168px] items-center justify-center rounded-(--radius-card) bg-accent-strong font-mono text-[11px] text-white">
          .key-lit
        </div>
        <div
          className="flex h-16 w-[168px] items-center justify-center rounded-(--radius-card) bg-surface font-mono text-[11px] text-mut"
          style={{ boxShadow: 'inset 0 1px 0 var(--edge-lit), var(--shadow-sheet)' }}
        >
          --shadow-sheet
        </div>
        <div
          className="flex h-16 w-[168px] items-center justify-center rounded-(--radius-card) border border-line bg-surface font-mono text-[11px] text-mut"
          style={{ boxShadow: 'inset 0 1px 0 var(--edge-lit-strong)' }}
        >
          --edge-lit-strong
        </div>
      </div>
    </div>
  )
}

export function Tokens() {
  return (
    <div className="flex flex-col gap-7">
      <Group title="Surfaces — each one rises from the last" names={SURFACES} />
      <Group title="Ink" names={INKS} />
      <Group title="Signal — amber is reserved for live, and nothing else" names={SIGNALS} />
      <Radii />
      <Depth />
    </div>
  )
}
