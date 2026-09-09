import { useEffect, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
} from "react";

/* ----------------------------- Orbit mark ----------------------------- */

export function OrbitMark({
  size = 28,
  idle = false,
  halo = false,
}: {
  size?: number;
  /**
   * Park the satellite. Moving is the mark's resting state — it sweeps
   * wherever it appears — so a stopped one is a statement, and the statement
   * is "the connection is gone". Only the terminal header sets it.
   */
  idle?: boolean;
  /** A soft field of light behind the mark. For the one place it is shown large. */
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

/* ------------------------------- Icons -------------------------------- */

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
/** Resume: an arrow coming back round to where it was. */
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
/* This phone, as the thing being paired — the sheet behind it is about the
   handset in your hand and not about the app's settings, so it is a handset and
   not a gear. */
export const IconPhone = icon(
  <>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10.5 18.5h3" />
  </>,
);
export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>,
);

/* ------------------------------ Buttons -------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "outline";
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  /* Every button is the same pill; what separates them is the face.

     `primary` is the key, and with the bead gone it has to say "press me" with
     material alone. It does: it is the only *filled* object in the app — a
     horizontal pearl, cool grey to warm cream to cool blue, iridescent along
     its length rather than shaded down its height — and the only one whose
     label is ink on light while every other label in Orbit is light on dark.
     That polarity flip is what the eye finds first. See .pill-key for the rest.

     `outline` and `ghost` are 5% white over whatever is behind them, with the
     shared diagonal rim; the difference between them is that ghost has no face
     until you touch it. `danger` stays dark and keeps its hue, because
     destruction should look like a warning and not like an invitation.

     No `disabled:opacity-*` on any of them. Fading a control leaves the
     brightest thing on the screen still the brightest and drags its label
     under 3:1; .pill:disabled draws the state instead. */
  const styles = {
    primary: "pill pill-key font-semibold",
    outline: "pill text-mut hover:text-fore",
    ghost: "pill-quiet",
    danger: "pill pill-danger font-semibold",
  }[variant];
  /* The bead is gone, and its 40px of right padding with it, so a primary is
     symmetrical again. It keeps one extra step of width over its neighbours —
     the last of the four cues, and the cheapest: the control that commits your
     intent is physically the largest thing in the row. Height is `min-h-11`
     for all of them, which is the 44px floor and is not negotiable. */
  const pad = variant === "primary" ? "px-6" : "px-5";
  return (
    <button
      className={`press relative inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-sm font-medium disabled:cursor-not-allowed ${pad} ${styles} ${className}`}
      {...props}
    />
  );
}

export function IconButton({
  label,
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: "sm" | "md" | "lg";
}) {
  // lg = 44px, the minimum comfortable touch target. The smaller two are drawn
  // small and *tapped* at 44px: `hit-xy` grows the hit area around them without
  // moving a pixel of layout, so a 28px glyph in a dense row still takes a
  // thumb. lg needs none of it and is left alone rather than made greedy.
  const box = { sm: "size-7", md: "size-9", lg: "size-11" }[size];
  const reach = size === "lg" ? "" : "hit-xy";
  return (
    <button
      aria-label={label}
      title={label}
      className={`press ${reach} inline-flex shrink-0 items-center justify-center rounded-(--radius-field) text-mut hover:bg-raised hover:text-fore active:bg-overlay disabled:text-faint disabled:hover:bg-transparent ${box} ${className}`}
      {...props}
    />
  );
}

/**
 * A switch that looks like the rest of the app: a pill that is brighter when
 * it is on.
 *
 * It exists because a checkbox had become the only checkbox in a family of
 * pills and glass, and read as what it was — a leftover from a settings row.
 * A modifier still has to look different from a trigger, so this is not a
 * Button: it does nothing on its own, it changes what the control next to it
 * will do, and it stays on screen saying so.
 *
 * "On" is `pill-on`, which is the selected segmented chip: silver with ink on
 * it. That inversion is the point. The first version of this made "on" a
 * brighter translucent face, and it failed the only test that matters — with
 * no sibling beside it to compare against, a few percent more white on a
 * near-black ground is not a state anyone can see. Off is glass, on is metal,
 * and the difference is legible at arm's length and in a screenshot.
 *
 * There is still no tick and no knob; the words do the confirming. In
 * CaptureSheet the three captions below flip from `390 × 844` to `390 wide`,
 * which says what the flag *did* rather than repeating that you set it.
 * `aria-pressed` carries the state for anyone not reading the light.
 */
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

/** A row of mutually exclusive choices, sized for a thumb. */
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
    /* `max-w-full` and shrinkable children, because four long labels — Staged,
       Unstaged, Untracked, Conflicted — are 40 characters, and at 390px the
       old `shrink-0` track simply ran off the side of the phone with the last
       label clipped by the screen edge rather than by anything in the design.

       Each tab keeps its natural width and gains `min-w-0`, which is the flag
       that lets a flex item shrink past its own text. So the control is
       exactly as wide as its labels until it hits the edge of the phone, and
       only then do the labels give ground — proportionally, longest first,
       truncating rather than wrapping or spilling. Nothing is forced to equal
       width, because equal width would clip "M" and "Live" to make room for
       space they do not need. */
    <div
      role="tablist"
      className={`seg inline-flex max-w-full gap-0.5 rounded-full p-1 ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          title={o.label}
          className={`press hit-y min-w-0 truncate rounded-full px-3 py-1.5 text-[13px] font-medium ${
            value === o.id ? "seg-on font-semibold" : "text-mut hover:text-fore"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- Fields -------------------------------- */

export function Field({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  /* The field used to draw its own focus treatment — an accent border plus a
     3px accent halo — on top of the global 2px accent outline at 2px offset.
     Two concentric blue rings with a gap between them is the shape every design
     system uses for "this input is invalid", which is a bad thing for a field
     to say the moment you tab into it. Both of the field's rings are gone; the
     one in styles.css is the only ring in the app.

     `outline-none` had to go with them, since that was what suppressed the
     real one on mouse focus. What is left on focus is the border warming to
     --color-line's brighter neighbour, which is a surface responding rather
     than a second ring.

     min-h-11: a text field is tappable, and 44px is the floor. */
  return (
    <input
      className={`min-h-11 w-full rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 text-sm text-fore shadow-[inset_0_1px_3px_rgb(0_0_0/0.4)] transition-[border-color] duration-200 placeholder:text-faint focus:border-overlay ${className}`}
      {...props}
    />
  );
}

/* ------------------------------- Sheets -------------------------------- */

export function Sheet({
  children,
  onClose,
  title,
  side = "bottom",
}: {
  children: ReactNode;
  onClose: () => void;
  title?: string;
  side?: "bottom" | "full";
}) {
  return (
    /* The scrim carries the blur and the panel does not — deliberately, and it
       is what makes the panel glass for free. `.glass` is a translucent face
       and a rim; the frost you see through it is the scrim's, already sampled
       once. Giving the panel its own backdrop-filter would have WebKit
       re-sampling two full-screen layers over a canvas that never stops
       repainting, which is the one thing that makes this app feel slow.
       The panel rises on transform alone, so its slide is a finished texture
       moving on the compositor. */
    <div
      className={`app-fill scrim z-40 flex justify-center ${
        side === "bottom" ? "items-end" : "items-stretch"
      }`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`sheet-panel glass flex w-full flex-col ${
          side === "bottom"
            ? "max-h-[92dvh] max-w-lg rounded-t-(--radius-sheet) pb-[env(safe-area-inset-bottom)]"
            : "h-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-1">
            {/* Lighter and larger than it was. Hierarchy in this app is
                carried by size, weight and dimness — never by colour — so the
                heading has to be doing that work visibly. */}
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

/* ------------------------------ Empty state ----------------------------- */

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
      {/* Not `idle`. A parked satellite is the one thing in this app that says
          "you are not connected" without words, and it is spent in exactly one
          place — the terminal header. An empty list is not a broken
          connection, so the mark here does what it does everywhere else: it
          runs. Motion is all the mark has left to say anything with, now that
          it is greyscale. */}
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

/* ------------------------------- Arrival -------------------------------- */

/** What a row needs to arrive: the class, and its place in the sequence. */
export interface Arrival {
  className: string;
  style?: CSSProperties;
}

/**
 * Decides which items in a list are allowed to animate in, and in what order.
 *
 * The problem this exists for: every list here polls, and an entrance that
 * replays on each poll is the jank the first visual pass avoided lists to
 * escape. Keyed rows already survive a poll without being remounted, so CSS
 * would mostly do the right thing on its own — but "mostly, as long as nobody
 * upstream changes a branch" is not a guarantee, and this is cheap enough to
 * make it one. Ids that have already been committed to the screen get no
 * animation class at all, so there is nothing left for a re-render to fire.
 *
 * Pass the ids in the order they are drawn, headers included — a header is part
 * of the sequence it introduces, and giving it a synthetic id lets it take its
 * turn. The stagger index counts only the *new* items, so adding one file to a
 * list of thirty gives that one file an entrance instead of restaging all
 * thirty.
 *
 * The set is filled in an effect rather than during render on purpose: under
 * StrictMode React renders twice before committing, and marking ids seen on the
 * way past would leave the second pass — the one that actually reaches the DOM
 * — believing everything had already arrived, which animates nothing, ever.
 */
export function useArrival(ids: string[]): (id: string) => Arrival {
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const id of ids) seen.current.add(id);
  });

  const order = new Map<string, number>();
  let next = 0;
  for (const id of ids) if (!seen.current.has(id)) order.set(id, next++);

  return (id: string) => {
    const i = order.get(id);
    if (i === undefined) return { className: "" };
    return { className: "arrive", style: { "--arrive-i": i } as CSSProperties };
  };
}

/* ------------------------------ Utilities ------------------------------- */

export const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

export const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

/** What to call a session: its given name, else what was first typed in it,
    else the agent — "Shell" tells three shells apart from each other not at all. */
export const sessionLabel = (s: {
  name: string | null;
  firstCommand: string | null;
  providerName: string;
}) => s.name ?? s.firstCommand ?? s.providerName;

export const PROVIDER_GLYPH: Record<string, string> = {
  shell: "❯",
  claude: "✳",
  codex: "◎",
  gemini: "✦",
};
