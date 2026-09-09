# Design notes

This page records the reasoning behind each piece of Orbit: the failure each
decision prevents, the alternative that was tried first, and why it was
rejected. It began as the README's *Status* section and grew into a record of
decisions. It is organised by topic rather than by the order things were
built; what a feature *does* is in the [user guide](USER-GUIDE.md), and this
page is about *why* it is shaped the way it is.

## Contents

- [The terminal](#the-terminal)
- [Sessions and conversations](#sessions-and-conversations)
- [Getting text and pictures in and out](#getting-text-and-pictures-in-and-out)
- [Reviewing changes](#reviewing-changes)
- [Captures and previews](#captures-and-previews)
- [The agent's side (MCP, hooks, approval)](#the-agents-side-mcp-hooks-approval)
- [Attention and notifications](#attention-and-notifications)
- [Authentication and pairing](#authentication-and-pairing)
- [Runtime and distribution](#runtime-and-distribution)

## The terminal

### A real terminal, not a chat view

Orbit is an interactive terminal: xterm.js on the phone, a WebSocket to the
server, bun-pty on the Mac, `zsh` underneath. It carries:

- ANSI colours, cursor movement and interactive prompts
- Keyboard input including Ctrl+C, resize, and scrollback
- Persistent sessions: the PTY survives the phone disconnecting, and
  reconnecting replays the scrollback
- Auto-reconnect with a connection status indicator
- A mobile-friendly layout: safe areas, and a visual-viewport-aware resize so
  the on-screen keyboard does not hide the bottom of the screen

### Agents launch through the login shell

Agent CLIs launch via `zsh -lic 'exec <cmd>'` so the user's real PATH applies
— whatever `claude`, `codex` or `gemini` resolves to at the desk resolves to
the same thing here. Exiting the agent ends the session.

### A redraw whenever the phone comes back

What is on screen is the last frame the agent drew, and a full-screen program
only draws again when its size changes. The server asks for a redraw on
reattach, but an agent busy running a tool can let that request pass — and
the composer then stays missing until something else moves, which is why
toggling the key bar appeared to fix it.

The client now asks as well, on every foregrounding and once the layout has
settled after a reconnect. It does so by arriving at the size it already has
by way of one row less, which is the one thing a full-screen program cannot
ignore.

## Sessions and conversations

### Providers are detected, not configured

Providers are Claude Code, Codex CLI, Gemini CLI and a plain shell.
Availability is auto-detected through the user's login shell and reported by
`GET /api/providers`, so an agent installed at the desk is available on the
phone with nothing to declare.

### The session drawer and folder defaults

The session drawer (☰) lists, switches and kills sessions, and starts a new
one with a provider and a project-folder picker: recent folders as one-tap
quick-picks, plus a folder filter.

Folder defaults are chosen to save taps: the browser opens at the last-used
project, git repositories are marked with ⎇, there is a home shortcut, and
starting an agent in a broad non-repo folder shows a non-blocking hint rather
than a refusal.

### Sessions are persisted under `~/.orbit/`

Session metadata and terminal history are written to `~/.orbit/` —
`sessions.json` and `scrollback/<id>.txt` — with debounced writes and a
synchronous flush on shutdown. Sessions therefore survive a server restart as
"Ended" entries. Ended sessions are capped at 20; the oldest are pruned.

### Resume lives in the history view, not on the row

Tapping an ended session opens its history read-only. **Resume** and **＋**
(a fresh session with the same agent and folder) live in that view's header;
the row itself carries only ✕ (forget, which deletes the history).

Both of those buttons start an agent, which costs tokens and takes a minute —
a list you scroll with a thumb is the wrong place for them. Reading the
history first is also the only way to tell two ended rows of one folder
apart.

### A session that named its own conversation is reachable as itself

Where the agent lets Orbit choose the conversation name, one is minted at
launch (`claude --session-id <uuid>`) and ↻ asks for it back by name
(`claude --resume <uuid>`). A folder's third-newest ended session therefore
reopens exactly the conversation that was tapped, however many have been
opened since.

What a row claims is then the conversation rather than the folder. That still
stops one conversation being opened twice, and it stops a resumed-then-ended
session offering the same conversation from two rows.

### Agents that only offer "the newest in this folder"

For agents whose resume reaches no further than the newest conversation in a
folder (`codex resume --last`), the older rule holds: ↻ appears only on the
most recently ended session of a folder+agent, and only while nothing is live
there. Anywhere else it would either reopen a different conversation than the
one tapped, or put a second agent into a conversation already in use.

### A session the Mac has forgotten is reported as gone

A session id the phone remembers but the Mac no longer has is reported as
gone, rather than silently opening a shell in the home directory under the
old id.

### Conversations from the Mac's own terminal appear on the phone

`claude` run at the desk leaves a transcript in
`~/.claude/projects/<folder>/<id>.jsonl`, and that id is what `--resume`
takes. Those conversations therefore appear alongside Orbit's own ended
sessions, interleaved by when each was last touched, and resume on the same
terms.

Everything about them is read-only: the files belong to Claude Code, are
never written or pruned, and carry no ✕ — deleting the record of a session
you ran at your desk is not a tap to offer from a list you scroll with a
thumb. There is no scrollback behind one, since nothing drew it on Orbit's
screen, so opening it rebuilds the conversation from what was said, one line
per tool call.

Three kinds of transcript are left out: one with nothing the user typed, one
from outside the home directory, and one whose folder has been deleted. The
first has no history to read and nothing to call the row; the other two
cannot be resumed into.

This is Claude only. It is the one agent that names a conversation;
`codex resume --last` still reaches no further than a folder's newest.

### Sessions are named, or name themselves

A session can be given an optional name at creation and renamed via ✎; the
created time is shown per session, and the active session's name is the
header title.

A session nobody named is labelled with the first line typed into it — the
command for a shell, the opening prompt for an agent. That line is captured
server-side from the input stream, with escape sequences and control codes
stripped and backspace applied, so three unnamed shells are told apart by
what they are doing.

### The REST surface

`GET/POST /api/sessions`, `DELETE /api/sessions/:id`, and `GET /api/dirs` for
directory browsing, restricted to the home directory.

## Getting text and pictures in and out

### Voice input on iOS Safari

🎤 opens a Web Speech overlay — browser speech recognition, gated on a
recogniser *and* a secure context. The transcript is editable, then
**Insert** (type only) or **Send** (type and Enter) puts it into the
terminal. Recognition language is a ไทย/EN toggle in the sheet, remembered
between uses; dictation matches one language per run, so the language cannot
be inferred.

iOS Safari is the constrained target and shapes the implementation:
recognition is started inside the tap itself, because a start one tick later
is refused; `continuous` is off there, because WebKit ignores it; and each
pause ends a run, which a **Continue listening** button resumes onto the
existing transcript. Refusals from Apple's dictation service
(`service-not-allowed`, `not-allowed`, …) are translated into the setting the
user has to change.

Voice never works from a home-screen PWA. That is a WebKit limitation, not a
bug here.

### Image input

📷 uploads a photo or screenshot to `~/.orbit/uploads/` and inserts its file
path into the terminal, ready to reference in an agent prompt.

### Tap a URL and choose what happens to it

Links are found in the buffer cell by cell, so a URL wrapped across two rows
is still one link and a trailing comma is not part of it.

That includes the rows a *program* wrapped itself. Claude Code writes `\r`,
cursor-right two columns, cursor-down, and there is no `isWrapped` flag on
those rows, so the join is inferred: a row that ends on a URL character,
followed by a row whose first non-space character is punctuation a URL can
continue with — `.html`, `/path`, `?q=1`. A line of prose below a URL starts
with a letter and is left alone, because an address that resolves to the
wrong page is worse than one that stopped short. Each row's blank padding is
dropped before the join, or the space would end the match exactly where the
wrap was. Half a URL is worse than none: it opens a real page that is the
wrong one.

The tap is matched by Orbit itself. xterm resolves a click against whatever
the mouse last moved over, and a finger never moves over anything.

A tap opens a sheet with **Open here** and **Copy** — and nothing that
navigates the app away. Leaving costs the session its screen: iOS drops a
backgrounded page, and an installed web app has no second tab to hand a
same-origin URL to, so WebKit walks the whole app over to it and the way back
is a cold start. **Open here** puts the page in a frame over the terminal,
which the session survives; anything that has to leave goes out as text on
the clipboard. Plain http inside the https app cannot be framed (mixed
content), so that case offers **Copy** alone and says why.

The sheet arms its backdrop late, because the click the browser emulates
after the tap would otherwise dismiss it before it was seen. A mouse click,
which costs nothing, still opens a tab.

### No SPA fallback for paths that miss

The app has no client-side routes, so only `/` gets `index.html`. `/site` —
the tail of a truncated link — answers 404 in words rather than serving the
app. Serving the app there had made a wrong address look like the app
bouncing back to the terminal.

### `localhost` is rewritten to the host the phone came in on

`http://localhost:5173` on the Mac is the phone itself on the phone, so the
tap goes to `http://<same-host>:5173` instead. The dev server is reachable
there because Vite binds every interface. Preview has the same thing as a
button next to Capture: a screenshot answers "how does it look", but some
questions only the running app answers.

### Press and hold to copy

The terminal draws its own text, so iOS never offers selection handles over
it. Holding selects the **word** under the finger, split on whitespace only:
what gets copied out of a terminal is paths, URLs, hashes and flags, and
those are ruined by a split on `/` or `-`.

Grips at either end adjust the selection cell by cell (dragging past the end
of a row carries on to the next), dragging the initial press grows it from
the word, and **Line** in the copy bar takes the whole logical line, wrapped
rows included.

Blank rows cannot be selected at all. Holding on the empty field below the
output does nothing, and a drag into it stops at the last row that has text,
because a highlight with nothing inside it is a selection you cannot copy and
cannot explain.

The selection is Orbit's own. The browser follows every touch with an
emulated mousedown, and xterm answers that by collapsing whatever was
selected to the cell under it.

### Touch behaviour is tested on both engines

The touch behaviour above is checked by `scripts/touch-smoke.mjs`
(`make test-touch`; `ENGINE=webkit` for the engine iOS runs) against a
throwaway instance.

## Reviewing changes

### A Changes tab: what the agent wrote, not just what it is doing

`git diff` in a pager on a 390px screen was the only way to review an agent's
work from a phone, and it is not one. `server/src/git.ts` asks the same
questions through porcelain meant to be parsed: status with per-file line
counts (untracked files counted against `/dev/null`, since they are in no
diff), the unified patch per file for either side of the index, stage and
unstage, commit, push.

Every call is `git -C <cwd>` with an argument array, so a branch with a
space in it is not a command, and every path is checked against the home
directory and against climbing out of the repository.

The four lines git wraps each hunk in are dropped: they repeat the sheet's
own title and cost a fifth of the first screenful. Long lines scroll sideways
rather than wrap, because a wrapped diff loses which column the `+` was in.

What gets committed is exactly what the Staged group showed — no `-a`
sweeping up what was not chosen. Push appears only where it would do
something: commits the remote has not seen, or a branch never pushed, which
is given its upstream since there is nobody here to answer git's question. It
never appears on a repository with no remote, where the alternative is a
button that only fails. git is told not to prompt at all
(`GIT_TERMINAL_PROMPT=0`), so a remote wanting a password reports git's own
sentence instead of hanging until the timeout.

## Captures and previews

### Headless captures of the app under development

The 📸 panel captures a dev app's URL headless in system Chrome
(`playwright-core`, `channel: 'chrome'`, no browser download) at a Phone,
Tablet or Desktop viewport, or full page. The gallery lays every shot out at
its real aspect ratio with tap-to-zoom, and ⇥ inserts the PNG path into the
terminal for the agent to inspect. Shots are stored in `~/.orbit/screenshots/`
(the last 50 are kept).

Chrome stays warm between captures. A dev server that is down is reported as
an error instead of quietly saving a picture of Chrome's error page. Each
capture is labelled with what it was of (`localhost:5173`).

Two things have since moved out of this panel. The **Mac screen** source —
for what Chrome cannot render: simulators, native apps, Xcode — became the
agent's alone (`orbit_screen`). And the list of URLs that had rendered before
became a list of ports that are serving now (see below).

### Publishing a dev server, from the phone

This is why "Open here" never worked for the thing you most want to open. A
dev server is plain http on a port only the Mac can see, and http cannot load
inside an https app — so the link sheet could only offer Copy, and following
it walks the installed app off its own page.

**Share :3000 over https** in Preview hands the port to `tailscale serve`,
which gives it an https address on the tailnet — 8443 upwards, one per dev
server. `tailscale serve` is tailnet-only; `funnel` is never used. That
address frames, so tapping the row opens the app over the terminal with the
session still connected behind it.

Publishing also reaches dev servers bound to `127.0.0.1` alone — `vite` and
`python -m http.server` bind loopback unless told otherwise, and the proxy
connects from the Mac itself — and it hands the app under test a secure
context, which is the only way to try its own service worker or camera from a
phone.

The module keeps no state of its own: `tailscale serve status` already knows
what is mapped, and a file beside it could only ever disagree.

A published port outlives the dev server behind it, so each row says when
there is nothing there rather than opening an empty frame — and keeps saying
it truthfully, because an agent restarting a dev server is the normal case,
and the answer was otherwise only as fresh as the moment the tab was opened.
What is *published* and what is *running* are two different questions asked
at two different rates. The first costs two `tailscale` processes and changes
only when someone publishes something, so it is asked on arrival and on
waking. The second is a TCP connect to loopback, so it is polled every ten
seconds while the tab is actually on screen. Polling them together would have
spawned processes all day to watch something that never moves.

The mapping Orbit itself is reached through is filtered out of every list and
refused by the API — by target port *and* by 443, because a second instance
on a spare port does not recognise the first one's by target.

### What the framed page can do besides sit there

A dev server changes under you, so the frame has **↻**. The page is a
different origin, so there is no `contentWindow.location.reload()` to call,
and re-assigning the same `src` is not reliably a navigation; the iframe is
remounted instead, which always fetches.

Beside it, **⧉** hands the page to the agent: rendered whole, headless from
the Mac, at this phone's width, so it gets everything below the fold. The
path lands in the prompt and the frame closes, because the next thing to do
is describe it. What it *cannot* carry is the state on screen — a
cross-origin frame will not report its scroll position, let alone an open
menu, and the shot is the URL fetched again from nothing.

The frame briefly carried a second button for that: a picker for the phone's
own screenshot. It did not earn its place. Side button + volume up already
puts the shot in Photos, and the composer's image button already sends it.
All the header button saved was closing the frame first, and it cost a slot
on a 390px row where nothing on screen could explain the hardware gesture it
depended on.

### The Mac is asked what it is serving, rather than the person

Typing `http://localhost:5173` on a touch keyboard was the slowest part of
looking at a change, and the answer was already in the kernel — so `lsof` is
asked what is listening, and each port arrives as a chip with the program
holding it (`:5173 node`).

A row of thirteen chips would be a text field with extra steps, so three
filters cut it down, in rising order of cost. The port number throws out the
ephemeral range the OS assigns and the reserved range no `npm run dev` can
bind. The program's name throws out the handful of macOS services that squat
on round numbers — ControlCenter holds 5000 and 7000, the two most-claimed
dev ports on a Mac. Then one `HEAD /` per survivor throws out everything that
is listening but is not a web server, which is what separates a dev server
from a Postgres. On the machine this was written on, that is thirteen
listeners down to one.

This replaced a list of URLs that had rendered before, which existed only
because typing was the way in, and whose whole failure mode was offering a
dev server that had since died.

### A capture is taken through the address the phone would use

A published port is rendered via its tailnet https URL rather than
`localhost`, since those are not the same app: secure context, `Secure`
cookies, a registered service worker, scheme-dependent redirects. Something
that only breaks under https used to photograph perfectly.

The file is still labelled with the port, or the gallery would file every
shot under one `ts.net:8443` and lose which app it was. Each published row
also captures straight from its ⧉, with no URL to type.

## The agent's side (MCP, hooks, approval)

Setup and caveats for everything in this section are in [MCP.md](MCP.md).

### An MCP server the agent can see and speak through

The MCP server is `orbit mcp` (`server/src/mcp.ts`, stdio JSON-RPC, no
framework). `orbit_capture` renders a URL and returns the *image*, so the
agent can look at its own UI work; `orbit_screen` hands it the Mac's screen;
`orbit_notify` puts a line on the phone; `orbit_ask` puts a question on the
phone and blocks until it is tapped. It is registered by `orbit setup`.

### The Mac → phone channel

`POST /api/notify` and `POST /api/ask` broadcast over the existing WebSocket.
Questions outlive a reconnect — a phone that joins mid-question is caught up
— and time out rather than hanging forever.

### Knowing Claude is waiting

Claude's own question boxes and permission prompts live in the terminal,
which is invisible to a phone in a pocket. The notify hook
(`orbit hook notify`, formerly `scripts/orbit-notify-hook.mjs`) forwards
`AskUserQuestion` with the question and its options, the notifications that
mean "waiting for you", and turn-end for sessions started from Orbit.

All of it is sent `quiet`, so the server drops it while the session is on
screen; a toast repeating what is already visible is noise. Nothing blocks:
the hook fires a request and exits.

### Approval for what the agent runs itself

Terminal screening (below) only ever sees what *you* typed — a command from
the agent's Bash tool never crosses that boundary. The approve hook
(`orbit hook approve`, formerly `scripts/orbit-approve.mjs`) is a Claude Code
`PreToolUse` hook that screens tool calls with the same patterns and routes
matches to the phone. It fails open when Orbit is not running, and fails
closed when Orbit is running and nobody answers.

### Approval for what you paste

Multi-character input chunks — paste, voice, automation — are screened
server-side for dangerous patterns (`rm -rf`, `sudo`, disk writes,
force-push, fork bombs, …). Matches are held and a red approval modal shows
the exact command: Run anyway or Deny.

Hand-typed single keystrokes pass through. They cannot be reconstructed
reliably, and they are the user's own deliberate input.

### Which session, without guessing

`ORBIT_SESSION_ID` joins `ORBIT_SESSION` in the PTY environment, so the
agent, its MCP servers and its hooks all inherit it and say where a message
came from.

The folder is the fallback for anything that predates it, and only where the
answer is not a guess: two live sessions in one folder make it no answer at
all, because filing a message against the wrong session is worse than filing
it against none.

## Attention and notifications

### Reaching a phone that is asleep

iOS freezes the page and drops its socket on lock, so a notice sent then
reaches nobody at all. Two things cover that gap. The notice is held and
replayed to whoever connects next — once, and only if it was never delivered
live. And a Web Push wakes the service worker with the app closed.

Push fires only when the live channel found nobody, so an open app never gets
a banner and a toast for the same event. VAPID keys live in
`~/.orbit/config.json`, subscriptions in `~/.orbit/push-subscriptions.json`,
and retired endpoints prune themselves. iOS grants notification permission
only from a tap inside an installed PWA, hence the opt-in row at the top of
Sessions.

### An ask nobody can hear is answered quickly

An `orbit_ask` with no phone socket and no push subscription cannot reach
anyone. Rather than leaving the agent blocked for the hook's 180-second
timeout, it is answered within about five seconds, so the agent learns
promptly that nobody is there instead of waiting on a question that was never
delivered.

### A notice belongs to a session, and outlives its toast

The message was a three-second toast and nothing else. Miss it — pocket,
another tab, a phone face-down — and there was no trace anywhere that Claude
had stopped and was waiting.

The last thing each session said is now held until it is read, and it says
which kind it is: `waiting` blocks work over there, `done` is only worth
knowing. A finished turn deliberately cannot bury an unanswered question.
Claude asks and *then* ends its turn, and letting the later message win would
replace "answer me" with "done" — the exact case the feature exists for.

The Sessions tab carries the count, filled when any session is waiting. The
row carries the message itself, two lines, because a question truncated at
forty characters is a question you have to open the session to understand.

Reading it is what clears it — being on that session. Neither opening the app
nor tapping the toast clears it, since either would clear a badge before it
was understood.

### A session that goes quiet is noticed without being told

Everything above is an agent *choosing* to speak, through the MCP server or a
hook that has to be registered first. Codex, Gemini and a plain shell have
neither, and neither does Claude before the hook is installed — so the phone
showed nothing at all while the terminal sat on "Do you want to proceed?",
the one moment the app exists for.

The stream already says it. An agent working is an agent drawing: a spinner
or an elapsed counter repaints several times a second, so ten seconds of
silence on the PTY means the frame is finished and the cursor is in the
composer. No agent's UI is parsed to find that, and nothing has to be kept
in step when one of them redesigns its screen.

Three limits keep it honest. Agents only — a shell at its prompt has been
quiet since it started, and a badge on every shell means nothing by it. Only
once per turn, since the one thing a notification channel may never do is
repeat itself while nothing has changed. And only above a floor of output, or
a session opened and left alone would announce itself ten seconds later off
the echo of its own keystrokes.

What is said under the badge is a line read off the tail of the screen, frame
and keyboard hints dropped, with a line ending in `?` preferred over the last
one — because the last line of a settled agent is its composer, and the thing
it stopped for is above that. It is a guess and is treated as one everywhere:
anything the agent said for itself wins, and a guessed note is drawn in the
quieter colour with a dot that does not pulse.

Nobody is interrupted who is already looking at that session. A connected
phone gets a silent badge rather than a toast, because a toast per turn per
session is an unusable app. Only with no phone connected at all is it worth a
push.

### `quiet` means "they can see *this*", not "Orbit is open somewhere"

The hook sends turn-ends and waiting-prompts quiet, and the server used to
drop them whenever any phone held a socket — so a second session's "Claude
is waiting" vanished while you were reading the first one.

The phone now reports which session it has on screen (`{type:'viewing'}`,
re-sent on tab change and on every foreground/background), and only that one
is suppressed. A phone in a pocket holds its socket open right up to the
moment iOS freezes it, which is why "connected" was never the right question.

### A tapped notification lands on the session that raised it

The push payload carries the session id. The service worker opens
`/?session=<id>` when there is no window, and postMessages an existing one,
since WebKit ignores `navigate` on a standalone PWA client.

The parameter is read at module load and spent by the boot pass that acts on
it. A read-and-clear had handed it to the boot that `setLocked` immediately
cancels, and the boot that followed fell back to the stored session —
precisely the one the notification was not about.

### A question can be answered from the notification itself

A push wakes the service worker with the app shut, and that worker holds no
token — deliberately. A background script with standing rights to the whole
API is a worse thing to own than four taps.

So the push carries a capability instead of a credential: one question, by
name, answered with one of the options that question declared, once. The
first two options become buttons on the banner. `POST /api/ask/answer` is the
only route the access token does not guard; the nonce is compared in constant
time, spent on use, dead when the question times out, and unable to say
anything the modal in the app could not have said.

Where a platform ignores notification actions — iOS shows none — it degrades
to exactly what it was before: a banner that opens the question in the app.

## Authentication and pairing

### A bearer token for everything; a hashed cookie where a header cannot go

An access token is generated to `~/.orbit/config.json` and printed in the
server console. It is required for all `/api/*` and WebSocket traffic as
`Authorization: Bearer`; the phone has a login screen, and an invalid or
expired token drops back to it.

A WebSocket handshake and an `<img src>` cannot carry that header, so those
two authenticate with an `HttpOnly; SameSite=Strict` cookie minted by
`GET /api/auth/check`. The cookie holds a hash of the token rather than the
token, and it authorises reads and the socket only, never a write.

Nothing puts the token in a URL, where it would end up in proxy logs and
history.

### The pairing QR carries a code, never the token

The QR printed by `orbit phone` and `orbit pair` encodes
`https://<host>/#pair=<code>`: a pairing code that lives ten minutes and
allows a few uses, carried in the URL fragment and exchanged for the token via
`POST /api/auth/pair`. The token itself is never in the QR.

The fragment never reaches a proxy or a log, which is what makes it safe
where a query string would not be. A few uses rather than one because iOS
gives a home-screen app storage of its own: the same code is scanned again
from the installed app's login screen.

### The socket handshake checks Origin as well as the cookie

WebSocket handshakes carrying the cookie are also checked for a same-host
`Origin`. `SameSite=Strict` is not enough on its own: `SameSite` ignores the
port, and a published preview on 8443 is same-site with Orbit, so the browser
would attach the cookie to a socket opened from a page served there. The
Origin check is what tells the two apart.

## Runtime and distribution

### Bun, not Node

The server runs on Bun with TypeScript: HTTP, WebSocket, PTY sessions, git,
headless Chrome and push in one process. Build and run are `bun run build`
and `bun run start`.

### bun-pty, not node-pty and not `Bun.Terminal`

The PTY is bun-pty. node-pty under Bun cannot resize the pty, so the shell
never receives `SIGWINCH`. `Bun.Terminal` (1.4.2) leaves the pty with no
foreground process group, so neither `SIGWINCH` nor Ctrl+C reaches the job.
bun-pty is the one of the three under which resize and Ctrl+C both work.

### One executable

The whole thing compiles to one executable with `bun build --compile`, the
web app embedded as an asset, so there is no runtime to install and nothing
to copy by hand. Bun's virtual filesystem answers `stat` and `readFile` for
embedded files but not read streams, so embedded files are served whole
rather than streamed.

### The hooks and the MCP server are subcommands

The hooks are `orbit hook approve` and `orbit hook notify` (formerly
`scripts/orbit-approve.mjs` and `scripts/orbit-notify-hook.mjs`), and the
MCP server is `orbit mcp`. All three are installed by `orbit setup` (formerly
`scripts/setup.mjs` and `make setup`), which resolves every path from
whatever is running it, so nothing is copied by hand; it replaces its own
hooks rather than adding a second copy and backs up `~/.claude/settings.json`
first.

### Production is one port

In production the server serves the built web app itself, so production is a
single port: `bun run build && bun run start`, then open
`http://<mac-ip>:3001` (or the tailnet https address `orbit phone` publishes).

### An installable PWA

Manifest, icons and a service worker make the app installable to the home
screen. The service worker is registered in production builds only.
