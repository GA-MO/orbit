import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/* ----------------------------- Orbit mark ----------------------------- */

export function OrbitMark({ size = 28, idle = false }: { size?: number; idle?: boolean }) {
  return (
    <span
      className={`orbit-track inline-block shrink-0 ${idle ? 'orbit-track--idle' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}

/* ------------------------------- Icons -------------------------------- */

const icon = (path: ReactNode) =>
  function Icon({ size = 20, className = '' }: { size?: number; className?: string }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden
      >
        {path}
      </svg>
    )
  }

export const IconTerminal = icon(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
  </>,
)

export const IconSessions = icon(
  <>
    <circle cx="12" cy="12" r="3.2" />
    <ellipse cx="12" cy="12" rx="9" ry="4.4" transform="rotate(-18 12 12)" />
  </>,
)

export const IconCapture = icon(
  <>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <circle cx="12" cy="12.5" r="3.2" />
    <path d="M8 6l1.2-2h5.6L16 6" />
  </>,
)

export const IconMic = icon(
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </>,
)

export const IconImage = icon(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m3.5 17.5 5-4.5 3.5 3 4-4 4.5 4.5" />
  </>,
)

export const IconPlus = icon(<path d="M12 5v14M5 12h14" />)
export const IconBack = icon(<path d="m14 6-6 6 6 6" />)
export const IconHome = icon(<path d="m4 11 8-7 8 7M6.5 9.5V20h11V9.5" />)
export const IconFolder = icon(
  <path d="M3.5 7.5v11A1.5 1.5 0 0 0 5 20h14a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 19 9h-7.2L9.6 6.6A1.5 1.5 0 0 0 8.5 6H5a1.5 1.5 0 0 0-1.5 1.5Z" />,
)
export const IconBranch = icon(
  <>
    <circle cx="7" cy="6" r="2.2" />
    <circle cx="7" cy="18" r="2.2" />
    <circle cx="17" cy="9" r="2.2" />
    <path d="M7 8.2v7.6M17 11.2c0 3.3-4 3.3-7.5 3.6" />
  </>,
)
/** Resume: an arrow coming back round to where it was. */
export const IconRestart = icon(
  <path d="M4.5 9a8 8 0 1 1-1 6.5M4.5 9V4.5M4.5 9H9" />,
)
export const IconTrash = icon(
  <path d="M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13M10 11v5M14 11v5" />,
)
export const IconEdit = icon(
  <path d="M14.5 5.5 18.5 9.5 9 19H5v-4L14.5 5.5ZM12.5 7.5l4 4" />,
)
export const IconInsert = icon(<path d="M4 12h12m0 0-4-4m4 4-4 4M20 5v14" />)
export const IconDisplay = icon(
  <>
    <rect x="2.5" y="4.5" width="19" height="12.5" rx="2" />
    <path d="M9 20.5h6M12 17v3.5" />
  </>,
)
export const IconClose = icon(<path d="m6 6 12 12M18 6 6 18" />)
export const IconChevronDown = icon(<path d="m6 10 6 6 6-6" />)
export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>,
)

/* ------------------------------ Buttons -------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'outline'
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary:
      'bg-accent-strong text-white hover:bg-accent active:bg-accent-strong disabled:opacity-40',
    outline:
      'border border-line text-fore hover:bg-raised active:bg-overlay disabled:opacity-40',
    ghost: 'text-mut hover:bg-raised hover:text-fore active:bg-overlay disabled:opacity-40',
    danger: 'bg-danger/90 text-ink font-semibold hover:bg-danger disabled:opacity-40',
  }[variant]
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-(--radius-field) px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  )
}

export function IconButton({
  label,
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' | 'lg' }) {
  // lg = 44px, the minimum comfortable touch target.
  const box = { sm: 'size-7', md: 'size-9', lg: 'size-11' }[size]
  return (
    <button
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-(--radius-field) text-mut transition-colors hover:bg-raised hover:text-fore active:bg-overlay disabled:opacity-40 ${box} ${className}`}
      {...props}
    />
  )
}

/** A row of mutually exclusive choices, sized for a thumb. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (id: T) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={`inline-flex shrink-0 gap-0.5 rounded-(--radius-field) border border-line bg-ink p-0.5 ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-[calc(var(--radius-field)-3px)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
            value === o.id ? 'bg-accent-strong text-white' : 'text-mut hover:text-fore'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------- Fields -------------------------------- */

export function Field({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 text-sm text-fore outline-none transition-colors placeholder:text-faint focus:border-accent ${className}`}
      {...props}
    />
  )
}

/* ------------------------------- Sheets -------------------------------- */

export function Sheet({
  children,
  onClose,
  title,
  side = 'bottom',
}: {
  children: ReactNode
  onClose: () => void
  title?: string
  side?: 'bottom' | 'full'
}) {
  return (
    <div
      className={`fixed inset-0 z-40 flex justify-center bg-black/60 backdrop-blur-[2px] ${
        side === 'bottom' ? 'items-end' : 'items-stretch'
      }`}
      onClick={onClose}
    >
      <div
        className={`flex w-full flex-col bg-surface ${
          side === 'bottom'
            ? 'max-h-[92dvh] max-w-lg rounded-t-2xl border-t border-line pb-[env(safe-area-inset-bottom)]'
            : 'h-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-1">
            <h2 className="font-display text-base font-semibold tracking-wide">{title}</h2>
            <IconButton label="Close" onClick={onClose}>
              <IconClose size={18} />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/* ------------------------------ Empty state ----------------------------- */

export function EmptyState({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-14 text-center">
      <OrbitMark size={44} idle />
      <div className="font-display text-base font-semibold">{title}</div>
      {hint && <p className="max-w-xs text-sm text-mut">{hint}</p>}
      {children}
    </div>
  )
}

/* ------------------------------ Utilities ------------------------------- */

export const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p
export const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

export const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** What to call a session: its given name, else what was first typed in it,
    else the agent — "Shell" tells three shells apart from each other not at all. */
export const sessionLabel = (s: {
  name: string | null
  firstCommand: string | null
  providerName: string
}) => s.name ?? s.firstCommand ?? s.providerName

export const PROVIDER_GLYPH: Record<string, string> = {
  shell: '❯',
  claude: '✳',
  codex: '◎',
  gemini: '✦',
}
