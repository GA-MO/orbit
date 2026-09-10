import { useEffect, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
} from "react";

const icon = (path: ReactNode) =>
  function Icon({
    size = 20,
    className = "",
  }: {
    size?: number;
    className?: string;
  }) {
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
    );
  };

export const IconTerminal = icon(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
  </>,
);

export const IconSessions = icon(
  <>
    <circle cx="12" cy="12" r="3.2" />
    <ellipse cx="12" cy="12" rx="9" ry="4.4" transform="rotate(-18 12 12)" />
  </>,
);

export const IconCapture = icon(
  <>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <circle cx="12" cy="12.5" r="3.2" />
    <path d="M8 6l1.2-2h5.6L16 6" />
  </>,
);

export const IconMic = icon(
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </>,
);

export const IconImage = icon(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m3.5 17.5 5-4.5 3.5 3 4-4 4.5 4.5" />
  </>,
);

export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);
export const IconBack = icon(<path d="m14 6-6 6 6 6" />);
export const IconHome = icon(<path d="m4 11 8-7 8 7M6.5 9.5V20h11V9.5" />);
export const IconFolder = icon(
  <path d="M3.5 7.5v11A1.5 1.5 0 0 0 5 20h14a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 19 9h-7.2L9.6 6.6A1.5 1.5 0 0 0 8.5 6H5a1.5 1.5 0 0 0-1.5 1.5Z" />,
);
export const IconBranch = icon(
  <>
    <circle cx="7" cy="6" r="2.2" />
    <circle cx="7" cy="18" r="2.2" />
    <circle cx="17" cy="9" r="2.2" />
    <path d="M7 8.2v7.6M17 11.2c0 3.3-4 3.3-7.5 3.6" />
  </>,
);
export const IconRestart = icon(
  <path d="M4.5 9a8 8 0 1 1-1 6.5M4.5 9V4.5M4.5 9H9" />,
);
export const IconTrash = icon(
  <path d="M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13M10 11v5M14 11v5" />,
);
export const IconEdit = icon(
  <path d="M14.5 5.5 18.5 9.5 9 19H5v-4L14.5 5.5ZM12.5 7.5l4 4" />,
);
export const IconInsert = icon(<path d="M4 12h12m0 0-4-4m4 4-4 4M20 5v14" />);
export const IconPaste = icon(
  <>
    <path d="M9 4.5H7A1.5 1.5 0 0 0 5.5 6v13A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 17 4.5h-2" />
    <rect x="9" y="3" width="6" height="3.5" rx="1" />
    <path d="M9 12h6M9 15.5h4" />
  </>,
);
export const IconDisplay = icon(
  <>
    <rect x="2.5" y="4.5" width="19" height="12.5" rx="2" />
    <path d="M9 20.5h6M12 17v3.5" />
  </>,
);
export const IconClose = icon(<path d="m6 6 12 12M18 6 6 18" />);
export const IconLink = icon(
  <>
    <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.8 6.5" />
    <path d="M13.5 10.5a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.4-1.4" />
  </>,
);
export const IconExternal = icon(
  <>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
  </>,
);
export const IconChevronDown = icon(<path d="m6 10 6 6 6-6" />);
export const IconPhone = icon(
  <>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10.5 18.5h3" />
  </>,
);
export const IconBell = icon(
  <>
    <path d="M6.5 15.5V10a5.5 5.5 0 0 1 11 0v5.5L19 18H5l1.5-2.5Z" />
    <path d="M10 18.5a2 2 0 0 0 4 0" />
  </>,
);
export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>,
);

export function OrbitMark({
  size = 28,
  idle = false,
  halo = false,
}: {
  size?: number;
  idle?: boolean;
  halo?: boolean;
}) {
  return (
    <span
      className={`orbit-track inline-block shrink-0 ${idle ? "orbit-track--idle" : ""} ${
        halo ? "halo" : ""
      }`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

type ButtonVariant = "primary" | "ghost" | "danger" | "outline";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const BUTTON_FACE: Record<ButtonVariant, string> = {
  primary: "pill pill-key font-semibold",
  outline: "pill text-mut hover:text-fore",
  ghost: "pill-quiet",
  danger: "pill pill-danger font-semibold",
};

const BUTTON_PADDING: Record<ButtonVariant, string> = {
  primary: "px-6",
  outline: "px-5",
  ghost: "px-5",
  danger: "px-5",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`press relative inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-sm font-medium disabled:cursor-not-allowed ${BUTTON_PADDING[variant]} ${BUTTON_FACE[variant]} ${className}`}
      {...props}
    />
  );
}

type IconButtonSize = "sm" | "md" | "lg";

const ICON_BUTTON_BOX: Record<IconButtonSize, string> = {
  sm: "size-7",
  md: "size-9",
  lg: "size-11",
};

const TOUCH_TARGET_SIZE: IconButtonSize = "lg";

export function IconButton({
  label,
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: IconButtonSize;
}) {
  const growHitAreaToTouchTarget = size === TOUCH_TARGET_SIZE ? "" : "hit-xy";
  return (
    <button
      aria-label={label}
      title={label}
      className={`press ${growHitAreaToTouchTarget} inline-flex shrink-0 items-center justify-center rounded-(--radius-field) text-mut hover:bg-raised hover:text-fore active:bg-overlay disabled:text-faint disabled:hover:bg-transparent ${ICON_BUTTON_BOX[size]} ${className}`}
      {...props}
    />
  );
}

export function TogglePill({
  pressed,
  onChange,
  children,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  pressed: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={`press pill inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm ${
        pressed
          ? "pill-on font-semibold"
          : "text-mut hover:text-fore font-medium"
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`seg inline-flex max-w-full gap-0.5 rounded-full p-1 ${className}`}
    >
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          title={option.label}
          className={`press hit-y min-w-0 truncate rounded-full px-3 py-1.5 text-[13px] font-medium ${
            value === option.id ? "seg-on font-semibold" : "text-mut hover:text-fore"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-h-11 w-full rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 text-sm text-fore shadow-[inset_0_1px_3px_rgb(0_0_0/0.4)] transition-[border-color] duration-200 placeholder:text-faint focus:border-overlay ${className}`}
      {...props}
    />
  );
}

type SheetSide = "bottom" | "full";

const SCRIM_ALIGN: Record<SheetSide, string> = {
  bottom: "items-end",
  full: "items-stretch",
};

const PANEL_SHAPE: Record<SheetSide, string> = {
  bottom: "max-h-[92dvh] max-w-lg rounded-t-(--radius-sheet) pb-[env(safe-area-inset-bottom)]",
  full: "h-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
};

export function Sheet({
  children,
  onClose,
  title,
  side = "bottom",
}: {
  children: ReactNode;
  onClose: () => void;
  title?: string;
  side?: SheetSide;
}) {
  return (
    <div
      className={`app-fill scrim z-40 flex justify-center ${SCRIM_ALIGN[side]}`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`sheet-panel glass flex w-full flex-col ${PANEL_SHAPE[side]}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-1">
            <h2 className="font-display text-[19px] font-light tracking-tight text-fore">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose}>
              <IconClose size={18} />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="fade-in flex flex-col items-center gap-3 px-8 py-14 text-center">
      <OrbitMark size={44} halo />
      <div className="font-display text-[19px] font-light tracking-tight">
        {title}
      </div>
      {hint && (
        <p className="max-w-xs text-[13px] leading-relaxed text-mut">{hint}</p>
      )}
      {children}
    </div>
  );
}

export interface Arrival {
  className: string;
  style?: CSSProperties;
}

export function useArrival(ids: string[]): (id: string) => Arrival {
  const alreadyOnScreen = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const id of ids) alreadyOnScreen.current.add(id);
  });

  const staggerIndexOfNew = new Map<string, number>();
  let nextIndex = 0;
  for (const id of ids) {
    if (!alreadyOnScreen.current.has(id)) staggerIndexOfNew.set(id, nextIndex++);
  }

  return (id: string) => {
    const index = staggerIndexOfNew.get(id);
    if (index === undefined) return { className: "" };
    return { className: "arrive", style: { "--arrive-i": index } as CSSProperties };
  };
}

const HOME_DIR_PREFIX = /^\/Users\/[^/]+/;

export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
export const shortPath = (path: string) => path.replace(HOME_DIR_PREFIX, "~");

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

export const timeAgo = (iso: string) => {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < SECONDS_PER_MINUTE) return "now";
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds < SECONDS_PER_DAY) return `${Math.floor(seconds / SECONDS_PER_HOUR)}h`;
  return `${Math.floor(seconds / SECONDS_PER_DAY)}d`;
};

export const sessionLabel = (session: {
  name: string | null;
  firstCommand: string | null;
  providerName: string;
}) => session.name ?? session.firstCommand ?? session.providerName;

const GlyphShell = icon(<path d="m10 8 4 4-4 4" />);
const GlyphClaude = icon(
  <path d="M12 4.5v15M5.5 8.25l13 7.5M18.5 8.25l-13 7.5" />,
);
const GlyphCodex = icon(
  <>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
const PROVIDER_GLYPHS: Record<string, typeof GlyphShell> = {
  shell: GlyphShell,
  claude: GlyphClaude,
  codex: GlyphCodex,
};

export function ProviderGlyph({
  providerId,
  size = 20,
  className = "",
}: {
  providerId: string;
  size?: number;
  className?: string;
}) {
  const Glyph = PROVIDER_GLYPHS[providerId] ?? GlyphShell;
  return <Glyph size={size} className={className} />;
}
