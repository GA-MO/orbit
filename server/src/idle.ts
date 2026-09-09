/**
 * Noticing, without being told, that a session has stopped and wants you.
 *
 * Everything else in the Mac→phone channel is an agent choosing to speak:
 * `orbit_notify` through the MCP server, or a Claude Code hook on the Stop
 * event. Both work, and both depend on the agent having been set up to do it.
 * Codex, Gemini and a plain shell have neither, and Claude without the hook
 * registered has neither either — so the phone showed nothing at all while the
 * terminal sat on "Do you want to proceed?", which is the one moment the whole
 * app exists for.
 *
 * The stream itself already says it. An agent working is an agent drawing: a
 * spinner, an elapsed counter, a tool's output. Every one of them repaints
 * several times a second, so silence on the PTY does not mean "busy and quiet",
 * it means the frame on screen is finished and the cursor is sitting in the
 * composer. That is the signal — no parsing of any agent's UI required to find
 * it, and nothing to keep in step when one of them redesigns its screen.
 *
 * What it is *not* is a replacement for the agent speaking. An agent that says
 * "I need you to choose a name" has told the phone something this can never
 * work out, so anything raised from here yields to a message that was actually
 * sent (see `attention.raiseIdle`).
 */
import type { Session } from './pty-manager.js'

/**
 * How long the stream must stay silent before the session counts as settled.
 *
 * Generous on purpose. The cost of waiting is a badge that appears ten seconds
 * later than it could have, which nobody can perceive on a phone they have not
 * picked up yet; the cost of being hasty is calling a session "waiting" in the
 * middle of a tool call that happened to draw nothing, which teaches the user
 * to distrust the badge.
 */
const QUIET_MS = 10_000

/**
 * Output since the last keystroke before silence means anything.
 *
 * A terminal echoes what is typed into it, so every keystroke is itself a few
 * bytes of output — without a floor, opening a session and touching nothing
 * would settle ten seconds later and announce that it was waiting.
 */
const MIN_OUTPUT = 200

/** How much of the tail is kept to look for something to say. */
const TAIL = 8_000

/** How many trailing lines are considered when picking that line. */
const TAIL_LINES = 12

const MAX_MESSAGE = 120

/* CSI, OSC and the two-character escapes, same shape as the label stripper in
   pty-manager — an OSC (window title, hyperlink) runs until BEL or ST and would
   otherwise leave its payload in the message as text. */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const ESCAPE_SEQUENCE = /\x1b(\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[A-Za-z]|.)?/g
const CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g
/** Box drawing, prompt markers and bullets — frame, not words. */
const FRAME_EDGE = /^[\s─-╿|>❯▶●•*]+|[\s─-╿|]+$/g

/* Lines an agent leaves on screen whatever it is doing. They are the last thing
   drawn more often than not, so without this the message is nearly always the
   keyboard hint rather than the question above it. */
const CHROME = [
  /^\? for shortcuts/i,
  /^esc to interrupt/i,
  /to interrupt\)?$/i,
  /^⏵{1,2}\s/, // ⏵⏵ accept edits on
  /^bypassing permissions/i,
  /^\d+ lines? (selected|hidden)/i,
  /^ctrl\+/i,
]

const meaningful = (line: string): boolean =>
  line.length > 1 && /[\p{L}\p{N}]/u.test(line) && !CHROME.some((re) => re.test(line))

/**
 * Shortest line worth putting under a badge when it is not a question.
 *
 * A terminal is a screen with coordinates, not a stream of lines, and the last
 * bytes on the wire are very often a single cell being repainted in place — a
 * spinner, an elapsed clock, `/rc` going green in the status bar. Those arrive
 * cursor-addressed, so nothing about them looks like the bottom of the screen;
 * they are simply short. A floor throws them away and lets the honest fallback
 * ("Went quiet") speak instead, which is the right trade: the part that has to
 * be true is *which* session wants you.
 *
 * Questions are exempt — "Retry?" is nine characters and is the whole point.
 */
const MIN_LINE = 8

/**
 * The best one-line account of what is on screen, or null when there is none.
 *
 * Best effort, and deliberately treated as such by everything downstream: the
 * badge saying *which* session wants you is the part that has to be right, and
 * this is the sentence under it. A question is preferred over the last line
 * because the last line of a settled agent is usually its composer, while the
 * thing it stopped for is a line or two above.
 */
export function lastWord(raw: string): string | null {
  const text = raw
    .replace(OSC_SEQUENCE, '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(/\r/g, '\n')
    .replace(CONTROL_CHAR, '')
  const lines = text
    .split('\n')
    .map((line) => line.replace(FRAME_EDGE, '').trim())
    .filter(meaningful)
    .slice(-TAIL_LINES)
  const question = [...lines].reverse().find((line) => line.endsWith('?'))
  const picked = question ?? [...lines].reverse().find((line) => line.length >= MIN_LINE)
  return picked ? picked.slice(0, MAX_MESSAGE) : null
}

/**
 * Report each time this session finishes drawing and goes quiet.
 *
 * Once per turn: the next keystroke arms it again. Without that, a session left
 * untouched overnight would report itself every ten seconds — and the one thing
 * a notification channel must never do is repeat itself while nothing changes.
 */
export function watch(
  session: Session,
  onQuiet: (message: string | null) => void,
  /* How long the silence has to last. The app always takes the default; the
     tests turn it down, because the alternative is a suite that spends ten
     seconds per assertion proving something about a `setTimeout`. */
  quietMs: number = QUIET_MS,
): void {
  let timer: NodeJS.Timeout | null = null
  let produced = 0
  let armed = true
  let tail = ''

  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const settle = () => {
    timer = null
    if (!armed || produced < MIN_OUTPUT) return
    armed = false
    onQuiet(lastWord(tail))
  }

  session.onData((data) => {
    tail = (tail + data).slice(-TAIL)
    produced += data.length
    stop()
    timer = setTimeout(settle, quietMs)
    timer.unref?.()
  })

  /* A keystroke is the user answering whatever this last settled on, so the
     screen it settled on is spent: the count, the tail and the one report all
     start again from here. */
  session.onInput(() => {
    produced = 0
    armed = true
    tail = ''
    stop()
  })

  session.onExit(stop)
}
