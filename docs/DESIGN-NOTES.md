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
- [Implementation notes](#implementation-notes)

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
`http://<mac-ip>:7788` (or the tailnet https address `orbit phone` publishes).

### An installable PWA

Manifest, icons and a service worker make the app installable to the home
screen. The service worker is registered in production builds only.

### Building the executable (scripts/dist-compile.ts, scripts/dist.sh)

- The compile goes through `Bun.build` rather than `bun build --compile` because one dependency needs a bundle-time patch. A bundler bakes `__dirname` in as the absolute path on the machine that built it; `playwright-core` derives its package root from `__dirname` and `require()`s `package.json` and `browsers.json` from there at module load. The 0.2.0 release, built on a GitHub runner, died on first start looking for `/Users/runner/work/orbit/…` — and every local build had passed, because on the machine that built it that path exists.
- `inlinePlaywrightJson` replaces those two requires with the files' contents at bundle time. The build refuses to produce an executable if fewer than `MINIMUM_INLINED` were replaced, or if any bundled `playwright-core` file still matches `STILL_READS_JSON_FROM_ITS_PACKAGE_ROOT`: an upgrade that changes the shape must be a build error, not a release that starts on one machine.
- `FIREFOX_ONLY_PLAYWRIGHT_REQUIRE` (`chromium-bidi`) is external — an optional require the bundler cannot resolve and the binary never needs.
- `--asset` keeps a path's own last segment and drops what is above it: `web/dist` lands at `/$bunfs/root/dist` and `server/package.json` at `/$bunfs/root/package.json`. A local `make dist` can never reproduce the 0.2.0 failure; to test it, build from a copy of the tree at a throwaway path, delete that path, then `ORBIT_BIN=<binary> bash scripts/test.sh smoke`. `release.yml` does the same thing by moving `node_modules`, `web/dist` and `server/dist` aside and starting the executable from `/tmp` before it publishes anything.
- `stampServiceWorker` in `web/vite.config.ts` rewrites `__BUILD__` in the copied `sw.js` after the bundle: the worker is a public file copied through untouched, so its cache name was a constant, and a constant cannot say which build it belongs to.

## Implementation notes

The source carries no comments; names carry the intent, and what a name
cannot carry is here — platform quirks, chosen constants, rejected
alternatives — keyed by the function or constant it belongs to.

### PTY sessions (pty-manager.ts)

- `ptyEnv` deletes `NO_COLOR` and `NODE_DISABLE_COLORS` before spawning: the server process often inherits them from the IDE that launched it, and they would turn every agent's UI monochrome.
- `keepTailEndingOnLineBoundary` (`SCROLLBACK_LIMIT` = 200,000 chars) cuts at the next `\n` rather than the exact offset, because an exact cut lands mid-escape-sequence and the replay then starts with garbage.
- `resize` drops a size the PTY already has. SIGWINCH is the only way into a full-screen app's screen, and the kernel raises it only when the size actually changes, so re-sending an identical size is not a redraw request — it is nothing. On reattach `index.ts` still calls it with the phone's current size, because the replay is the screen drawn for the size the agent *had*.
- `kill` sends the default signal and then `SIGKILL` after `SIGKILL_AFTER_MS` = 3000: a hung agent or a child that traps the first signal would otherwise leave a live PTY behind a row marked ended. The empty catch covers the window between the liveness check and the signal.
- `onQuiet` is a callback into `index.ts` rather than a call into `attention`: who should be interrupted for a settled session is a question about phones and pushes, which the thing that owns PTYs should not know about.
- `restart` with `resume` splices the conversation id into a shell command line (`claude --resume <id>`), so the id is checked against `PLAIN_UUID` first; anything else is refused rather than quoted.
- A resume replaces the old row only once the new launch has succeeded — a launch that failed must leave the old row intact, or the conversation drops out of the list.
- `hide`/`unhide`/`hiddenCount` check against the rows the last scan produced rather than the disk: what the phone can hide is what it was just shown, so an unknown id is a 404 and an Orbit-owned ended session (which has `forget`) is refused. Unhide-all takes effect on the *next* scan, not immediately, because the rows were dropped from that scan's output.

### Store (store.ts)

- `LEGACY_MOUSE_REPORT_RESIDUE` strips `<n;n;nM` prefixes from persisted `firstCommand`: labels captured before the CSI stripper handled SGR mouse reports kept the body of the report, and this repairs them on read rather than requiring a migration.
- `hidden.json` is its own file rather than a field in `sessions.json`, because `sessions.json` is rewritten from the live session maps on every change and an id with no session behind it has nowhere to live there.
- A missing or truncated `hidden.json` reads as "nothing hidden": the user can fix that by hiding the row again; a crash on startup they cannot fix.

### Terminal input screening (approval.ts)

- `KEYSTROKE_MAX_LENGTH` = 3: a chunk at or below this passes unscreened, since interactive keys and their escape sequences (`\x1b[A`) arrive as one to three bytes. `screenWhole` exists for the hook path, where the command is known to be complete and there is no length below which it is "only typing".

### Attention and notices (attention.ts, idle.ts, notify.ts)

- `attention` is in memory on purpose: every live session dies with the server, so a persisted "waiting" record would outlive the thing it describes.
- `QUIET_MS` = 10,000 is generous on purpose: the cost of waiting is a badge ten seconds late on a phone nobody has picked up; the cost of haste is calling a session "waiting" mid-tool-call and teaching the user to distrust the badge. `watch` takes `quietMs` as a parameter only so tests can shorten it.
- `MIN_OUTPUT_SINCE_KEYSTROKE` = 200 bytes: the terminal echoes keystrokes as output, so without a floor a session opened and left alone would settle and announce itself off its own echo.
- `MIN_STATEMENT_LENGTH` = 8: the last bytes on the wire are often a single cell repainted in place (spinner, elapsed clock, status-bar indicator) that arrive cursor-addressed and look like a short line. The floor throws them away so "Went quiet" speaks instead. Lines ending in `?` are exempt — "Retry?" is the whole point.
- `AGENT_CHROME` lists lines an agent leaves on screen whatever it is doing (`? for shortcuts`, `esc to interrupt`, `⏵⏵`, `bypassing permissions`); they are the last thing drawn and would otherwise be the message every time.
- `MISSED_KEPT` = 10 and `MISSED_MAX_AGE_MS` = 6h bound the replay-on-connect list; a missed notice carries `at` only because it is read late.
- `broadcastPreview` returns a count and never throws on zero receivers: the fallback (a notice naming port and path) belongs to the route, which knows about push and the missed queue. Previews are never queued for a later phone — a frame opened onto work that has moved on is a confusing picture, not a stale one.
- `answerWith`: `ANSWER_TOKEN_BYTES` = 24; a wrong nonce returns false and the route turns it into the same paced 401 a wrong token gets, so a nonce cannot be brute-forced faster than a token.

### Push (push.ts)

- Every send carries a `Shelf` (`ttlSeconds`, `topic`) because a push is a message handed to Apple, not a delivery: web-push's default TTL is four weeks, and a Mac shut down all evening would otherwise land a stack of stale banners.
- `topicIsValid` rejects lengths where `len % 4 === 1`. RFC 8030's "up to 32 URL-safe base64 characters" reads like a character rule but Apple *decodes* the header, so an undecodable length is a 400 `BadWebPushTopic`. This cost five weeks: `orbit-notice` (12) went through by accident, `orbit-waiting` (13) and `orbit-ask` (9) were dropped at Apple every time, into a `console.error` nobody read. Hence `orbit-idle` and `orbit-question`, and `assertTopicsAcceptable()` at module load rather than at send time.
- Topics are per kind (`NOTICE`, `WAITING`, `question`) so a session going quiet never collapses away an agent's own words or a question; two sessions settling in the same minute collapse to the later one, which is the right summary of "something wants you".
- `THIRTY_MINUTES_S` for notices and idle: half an hour later the terminal has moved on; the in-app missed list keeps the message, expiring the push only loses the interruption. A question's TTL equals its timeout — it stops waiting on timeout.
- `DEFAULT_CONTACT` / `vapidContact`: the VAPID subject must be a `mailto:` or `https:` URL (`CONTACT_SCHEME`) because Apple validates it.
- `agent` and `ipv4Agent` both set `autoSelectFamily: false`: Apple's push host resolves to both families and Node's happy-eyeballs racer produced spurious failures. `send` retries once over IPv4 only when the request never reached the push service; a 4xx from the service is not retried.
- `SEND_TIMEOUT_MS` = 10,000 guards a push service that accepts the connection and then says nothing, which would otherwise hold the notice path open indefinitely.
- `subscribe` refuses non-https endpoints and caps at `MAX_SUBSCRIPTIONS` = 32, because the endpoint is a URL this server POSTs to on every notice. Re-subscribing replaces the same endpoint rather than duplicating it.
- `ENDPOINT_GONE_STATUSES` = 404, 410 prune a subscription: a reinstalled app leaves a dead endpoint that fails every send otherwise.

### Auth, pairing and the HTTP layer (index.ts, auth.ts, pairing.ts)

- `storedToken` re-chmods `config.json` to `0o600` on every read: files written before that mode existed were world-readable. `loadKeys` in push.ts does the same for the VAPID private key.
- `sessionValue` is `sha256("orbit-session:" + token)`, derived rather than a random id in memory, so a phone survives the frequent restarts of a personal server. `COOKIE_MAX_AGE` is one year.
- `expiredSessionCookie` must reproduce the identical name, `Path` and `Secure` attributes with `Max-Age=0`; a mismatch makes the browser store a second cookie beside the live one and change nothing. It un-pairs a phone without rotating the token, because rotation would sign out every device and cost a restart that kills the running agent.
- `isSecureRequest` reads `x-forwarded-proto`: behind `tailscale serve` TLS terminates upstream and the socket itself is plain http.
- `originIsThisHost` accepts a request with no `Origin` (non-browser clients) and checks a browser's Origin against both `Host` and `X-Forwarded-Host`, because through the proxy `Host` is the loopback address.
- `slowDownCredentialGuessing`: `FREE_ATTEMPTS` = 10, then 250 ms per extra attempt capped at `MAX_DELAY_MS` = 2000, forgotten after 60 s. A delay rather than a block because `tailscale serve` proxies every remote client from 127.0.0.1 — a block would lock the owner out. `WARN_EVERY_N_ATTEMPTS` = 10 logs past the free tries, the only place a guess is visible. `forgetFailures` on success so a logged-in phone never waits.
- `readBody` pauses the request on a `BODY_LIMIT` (1 MiB) overflow rather than destroying it: destroying closed the socket before the 413 could be written, so the client saw a reset instead of an answer. The router closes the connection behind the response since the unread body is still on the wire.
- `route` matches patterns by segment count, so `/api/sessions` and `/api/sessions/:id` cannot collide; only same-shape patterns (`/api/previews/live` vs `/api/previews/:port`) depend on registration order, and those are written adjacent.
- `RUNNING_FROM_COMPILED_BINARY` is detected by `import.meta.url` starting with `file:///$bunfs/`; the embedded web app lives at `/$bunfs/root/dist`.
- `wss` sets `maxPayload` to 1 MiB because a frame is a keystroke or a paste and the default (100 MiB) is a memory hole; `perMessageDeflate` at level 3 with `threshold` 1024 compresses agent output without spending CPU on keystrokes.
- `MAX_BUFFERED` = 4 MiB on `ws.bufferedAmount`: a phone on a slow link reading a fast agent would otherwise have output queued in memory without bound; frames are dropped rather than queued, and the scrollback replay on reconnect fills the gap.
- `shutdown` closes warm Chrome and every preview serve (8443+) but leaves the 443 front door alone; a 2 s `setTimeout(...).unref()` guarantees exit if either hangs.
- `unhandledRejection` and `uncaughtException` are logged, not fatal: Node's default is to exit, and here exiting kills every PTY.
- `pairBase` prefers the published tailnet address, then `pairing.lanAddress()` (first non-internal IPv4), then `localhost` — the order a phone could actually reach. `pairing`: `USES` = 10 per code, `CODE_BYTES` = 9.

### Startup banner and QR (banner.ts, qr.ts)

- `ACCENT` is cyan because it is the only basic colour legible on both light and dark terminal backgrounds.
- `WIDE` = 64 columns is where the two-column layout starts wrapping values; below it the banner switches to one fact per line. No box is drawn because it would have to be laid out for a width the server cannot know.
- `plainBanner`'s token line keeps its historical wording verbatim: it is what users copy and what `grep` in the troubleshooting docs matches.
- `PACKAGE_JSON_CANDIDATES` reads `package.json` from disk (checkout) or `/$bunfs/root/package.json` (compiled) rather than importing it, avoiding `resolveJsonModule` and a bundled copy.
- `renderBanner` takes the tailnet address as an argument because only `index.ts` knows whether it already paid for the `tailscale status` process; a self-fetching banner would spawn one per start and be untestable without Tailscale.
- `qr.ts` uses a default import of `qrcode-terminal`: it assigns a whole object to `module.exports`, which the ESM loader cannot split into named exports. The `generate` callback is synchronous and is the only way to get the string instead of stdout.
- `qrBlock` paints with `INK` = white-on-black pinned explicitly (kept even under `NO_COLOR`): small mode draws light modules with the terminal's default background, which on a dark terminal inverts the code. `QUIET` = 4 modules of margin is the spec's requirement, minus the library's own `OWN_MARGIN_MODULES` = 1.

### Git (git.ts)

- `DIFF_LIMIT` = 200,000 chars truncates a diff nobody will read on a phone; lockfiles routinely exceed it and the summary still counts them. `MAX_UNTRACKED_FILES_SIZED` = 50 caps per-file sizing of untracked files, because a stray `node_modules` is thousands of them.
- `NEVER_PROMPT_ENV` also sets `GIT_OPTIONAL_LOCKS=0` so a status read never contends with an agent's own git commands for `index.lock`. `NO_ASKPASS_ENV` blanks `GIT_ASKPASS`/`SSH_ASKPASS` on push so a credential helper cannot pop a GUI on the Mac.
- `TIMEOUT_MS` = 20 s; `PUSH_TIMEOUT_MS` = 60 s — long enough for a slow remote, short enough that a hung push ends.
- `runNoIndexDiff`: `git diff --no-index` exits 1 when files differ, which is its success case, so exit 1 is not an error there.
- `safeRelative` rejects anything climbing out of the repo or starting with `-`, which git would read as an option.
- `applyHunk` rebuilds the patch header from the already-checked path and accepts only `HUNK_BODY_LINE` lines from the client, so a hunk can only ever be applied to the file it was read from; `--- a/other` lines in the body are rejected because they would pass the line-shape test and retarget the patch.
- `unstagePaths` falls back from `restore --staged` to `rm --cached` when the error mentions `HEAD`: on a repository with no commits there is nothing to restore from.
- `commit` reports counts via `show --numstat --format= HEAD` and `sumNumstat` rather than parsing git's "2 files changed" sentence, which is localised and changes shape with zero insertions.

### Previews and ports (preview.ts, ports.ts)

- `FIRST_PORT` = 8443 because `npm run preview:on` always used it; `MAX_PREVIEWS` = 12 bounds the scan.
- `CLI_CANDIDATES` puts `ORBIT_TAILSCALE` first: every path ends at that binary, so it is how tests exercise publishing on a machine with no Tailscale, and the escape hatch for an install in neither of the two known places (`PATH`, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`).
- `findCli` and `tailnetHost` cache their answer and, on failure, refuse to retry for `RETRY_AFTER_FAILURE_MS` = 30,000 — a logged-out or not-yet-up Tailscale is worth asking again later, not on every request.
- `run` surfaces the first stderr line as the error: the CLI puts the useful sentence there ("HTTPS must be enabled in the admin console").
- `previewUrl` strips every leading slash and backslash and puts one back, so `//evil.com/x` cannot become a host; `..` is clamped by `new URL` against the origin, and the result is verified to share the origin. A full `http://` argument is refused as a plain `Error` so the module does not import `index.ts`'s `bad()`.
- `ports.ts`: `EPHEMERAL_FROM` = 32,768 and `RESERVED_BELOW` = 1024 filter by number alone. `MACOS_SERVICE_BY_LSOF_NAME_PREFIX` keys are prefixes because `lsof -F` truncates command names to nine characters (`ControlCe`, `IPNExten`, `Tailscal`).
- `listeners` runs `lsof -F pcn` (field format) because command names contain spaces (`Google Chrome H`) and the default table splits on whitespace; `runLsofKeepingPartialOutput` keeps stdout when lsof exits non-zero, which it does whenever some sockets are unreadable after printing the rest.
- `respondsToHttp` (`HTTP_PROBE_TIMEOUT_MS` = 600) reads only enough bytes to see `HTTP/`; a database answers a `HEAD /` with its own protocol or silence. It is the only safety filter — the number and name filters just keep the list short — which is why it is exported and reused as the guard on publishing a port unattended.
- `LOOPBACK_REACHABLE` lists the bind addresses the proxy can reach from the Mac; a server bound to a specific LAN IP is excluded.
- `projectName` walks up to the nearest `.git` and stops at home: a dev server's cwd is often `repo/web`, and every monorepo answers `web`. `package.json`'s `name` was rejected (a file read per process, and a published name that is often not the folder). A cwd of `/`, `/Users` or home itself yields no label rather than the username.

### Captures (screenshot.ts)

- `launching` holds the in-flight Chrome launch so two captures asked at once (an agent issues them in parallel) share one browser instead of racing two.
- `closeBrowserWhenIdle` (`BROWSER_IDLE_MS` = 60,000) is armed only when `inFlight` reaches zero — a capture that finishes while another runs must not schedule a close under it.
- `navigateOrSettleForLoad` waits for `networkidle` and, on a plain timeout, falls back to `load` with `LOAD_FALLBACK_TIMEOUT_MS` = 5000; but a `net::*` error is thrown because Chrome renders its own "can't be reached" page, and saving that would report a picture instead of a failure.
- `MAX_VIEWPORT_PX` = 4000 because Chrome allocates whatever viewport it is asked for; `scaleFactorFor` uses retina (2×) below `DESKTOP_WIDTH_PX` = 1200 and 1× above, where it only doubles an already large image.
- The filename is `<timestamp>-<kind>-<label>.png` and `sanitize` keeps `:` (host:port is the point of the label); files without a kind segment predate `orbit_screen` and are URL renders.

### The default port (port.ts)

- `DEFAULT_PORT` = 7788. 3001 was the default until it proved too popular — a Node dev server, a second Node dev server, half the tutorials — so a fresh Orbit collided with whatever was already there. 7788 is in no `/etc/services`, sits clear of the 3000/5000/8000 clusters everything reaches for, and clear of Orbit's own bands: previews from 8443 up, tests from 3099 up.
- `resolvePort` falls back on an *empty* `ORBIT_PORT`, not only an absent one. `Number(process.env.ORBIT_PORT ?? 3001)` shipped in 0.2.1: `??` does not fall back on `''`, so `ORBIT_PORT=` made the port 0, the server bound whatever the kernel handed out, and the hooks, the MCP server and `doctor` all looked on `:0` and reported nothing there. A value that is not a port throws rather than becoming one, because the alternative is a server nobody can reach and no message saying why.
- The number is written down in five places that cannot import each other — `Makefile`, `scripts/test.sh`, `scripts/shots.sh`, `web/vite.config.ts`, `package.json` — so `smoke.mjs` reads them back and compares. Drift is otherwise silent: `make stop` stops a port nothing is on, the dev proxy talks to nobody, and the suites stop protecting the live server.

### MCP server (mcp.ts)

- `SERVER_INFO.version` comes from `packageVersion()`, not a literal. It was hardcoded `0.1.0` and stayed there through 0.2.1, so a client asking the binary what it was got the wrong answer.
- `MAX_IMAGE_WIDTH` = 1568: Claude resizes anything wider anyway, so a `sips -Z` downscale to a copy costs the agent fewer tokens while the original stays on disk.
- `orbit_notify` defaults `kind` to `done`; before the field existed every message counted as done, which buried questions.
- `initialize` echoes the client's `protocolVersion` to avoid a needless renegotiation; tool failures are returned as `isError` content, not JSON-RPC errors, so they land in the conversation.

### Hooks, setup and launch (hooks.ts, setup.ts, launcher.ts, home.ts)

- `readStdin` in both hooks resolves after `APPROVE_STDIN_LIMIT_MS` = 5000 / `NOTIFY_STDIN_LIMIT_MS` = 3000 regardless of EOF, so a hook never hangs Claude Code if stdin is not closed.
- `describeStop` fires only when `ORBIT_SESSION === '1'`: at a desk a turn ending is not news, and the variable is inherited from the PTY the agent was launched in.
- `APPROVE_OPTIONS` puts `Block` first because the phone emphasises the first option; exit 0 with empty stdout means "allow" and lets Claude Code's own permission flow continue.
- `APPROVE_HOOK_TIMEOUT_S` = 190 in settings because the hook itself waits `APPROVE_TIMEOUT_SECONDS` = 180; Claude Code's default 60 would cut the hook off and let the command run while nobody had tapped.
- `OUR_MARKS` includes the old script names (`orbit-approve.mjs`, `orbit-notify-hook.mjs`) so `setup` removes hooks installed by the pre-Bun scripts too. `Stop` and `Notification` hooks carry no matcher: a matcher on a non-tool event matches nothing.
- `setup` refuses to overwrite a settings file it cannot parse, and backs up to `settings.json.orbit.bak` once. The MCP server is removed before `add` because `claude mcp add` on an existing name errors; on uninstall, an unrecognised failure of `remove` is reported rather than claimed as done.
- `launcher.ts` spells out `bun` and `server/dist/main.js` as absolute paths: hooks and the MCP server run under Claude Code, not a shell with this user's PATH, and `~/.bun/bin` is on nobody else's.
- `home.ts`: `ORBIT_HOME` relocates `~/.orbit` without moving `HOME`, because a scratch `HOME` also relocates shell rc files and agent credentials, leaving `claude` logged out. Read at call time, not import time, so modules loaded before the variable is set still land in the right place.

### Transcripts (transcripts.ts)

- `SCAN_LIMIT` = 25 transcripts are opened per scan (newest by mtime), `KEEP` = 10 reach the phone; behind those lie years of files, and each scan stats all of them (cheap) but parses only the window.
- `HEAD_BYTES` = 256 KiB is read looking for `cwd` and the opening prompt, which sit within the first few entries (line 5 in practice); a read that fills the buffer discards its last line as half an entry.
- `headsByFileIdentity` caches parsed heads keyed on `file:mtime:size`, since a transcript's head never changes; a conversation being written gets a fresh key and is re-parsed.
- `isBoilerplateUserMessage` drops user entries starting with `<` (system reminders, slash commands) or `Caveat:` (the resume caveat), which all arrive typed as user messages.
- `stillPresent` answers from every transcript on disk, not the scan window, and returns null when the scan found nothing at all: an empty projects directory and an unreadable one look identical, and concluding "every hidden id is gone" from a failed read would discard the hidden list.

### The terminal component (Terminal.tsx)

- `appOwnsScreen`: with mouse tracking on, xterm disables its own touch scrolling (`coreMouseService.areMouseEventsActive` gates `handleTouchStart`/`handleTouchMove`) and forwards the touch as a mouse event, which iOS never synthesises from a drag — so a swipe went nowhere until Orbit sent the wheel itself. Claude Code sets alternate screen and mouse tracking only once its UI takes over, not at startup; either flag alone hands the scroll to the app.
- `wheelReport`: swipes go out as SGR wheel notches (`\x1b[<64/65;col;rowM`), not PageUp/PageDown — measured against `claude`, one wheel report moves the transcript exactly one line, PageDown a full page, and a page jump under a finger reads as a jump. The cell under the finger is included because a split-pane app would read it even though Claude Code does not.
- `notchesFrom` / `wheelAnchorY`: one line of finger travel is one notch and the remainder carries into the next `touchmove`, so the pane follows the finger. `MAX_NOTCHES_PER_MOVE = 12` keeps a flick from firing a screenful in one frame.
- `onTouchMove` sends no wheel for a read-only session even when xterm is on the alternate screen with mouse tracking on: an ended session's replay can leave it there with no program to take the wheel, and sending it ate the swipe so history could not scroll at all.
- Fling constants: `FLING_SAMPLE_MS = 90` measures velocity over the tail of the drag so a swipe that stopped before lifting does not throw; `FLING_MIN_VELOCITY = 0.35` px/ms separates placed from thrown; `FLING_MAX_VELOCITY = 4` clamps because two samples a millisecond apart read as any speed and the glide is ~280x the velocity; `FLING_FRICTION = 0.94` per 60fps frame lands around two thirds of a second, about how long a thrown list keeps moving; `FLING_STOP_VELOCITY = 0.04` is where another notch would be a twitch. `tailVelocity` is shared between "cancel the press" and "glide" so both use one scale.
- `startFling` runs on rAF so it stops dead when the tab is backgrounded, clamps `dt` to 64ms so a tab away for a second does not resume by firing that second's friction and travel in one frame, and aborts if `appOwnsScreen` flips false mid-glide.
- `LONG_PRESS_MS = 420` arms rather than opens: the haptic tick (`navigator.vibrate(8)`) is the whole feedback, and the panel opens on `touchend` only if the finger never left `TOUCH_SLOP_PX = 8`. Every rule tried for separating press from scroll mid-gesture (distance, speed, direction, stillness) either misread a scroll or broke a selection, because they are the same movement until the finger stops. A `touchcancel` clears `armed` without opening, since iOS cancels when something else owns the gesture.
- `onTouchEnd` calls `e.preventDefault()` before opening the select panel or the link sheet to swallow the click the browser emulates from the touch, which would land on the thing about to open. The link sheet's backdrop is armed 350ms late (`setLinkArmed`) for the same click.
- Link activation via xterm's provider is deduplicated with an 800ms same-URI window (`lastLink`): a tap runs Orbit's hit test and Safari's synthesised click, which would answer one tap twice.
- `.xterm-rows` gets `pointer-events: none` for touch only: a touch is delivered for its whole life to the node it started on, xterm's DOM renderer replaces a row's spans on every repaint, so a finger on a glyph held a detached node within a frame and the swipe died (measured: 2 notches vs 28 from a blank row). Landing on `.xterm-screen`, which `open()` builds once, fixes it; every gesture resolves its cell from coordinates, never from the target. A mouse keeps the rows for xterm's own hover and click. `touchmove` is registered non-passive so a drag can hold off the scroll.
- `selectionInactiveBackground` equals `selectionBackground` (`#2c3654`): a long-press selection never focuses the terminal and xterm dims an unfocused selection to almost nothing, which on a phone reads as "the long press did nothing".
- `decomposeSaraAm`: iOS Safari draws a lone ำ (U+0E33) as a dotted circle with a floating mark. xterm gives ำ its own cell and the shaper splits it into nikhahit + า with no base. Writing the canonical decomposition (ำ → ํา, Lao ຳ → ໍາ) puts the nikhahit in the consonant's cell; widths are untouched since the nikhahit is zero-width, so box drawing stays aligned. Applied to replay and output alike.
- `gridRef`: a fresh XTerm is 80x24 until `fit()`, so a session switch showed one frame at a size the phone never has and the fit was then a real resize. The last fitted grid seeds the next terminal's constructor because the box has not moved.
- `connect()` clears the pending resize queue and sets `sentSize` to the handshake size: `/ws?cols=&rows=` already tells the server the size, and without this the resize `fit()` raised moments earlier went out again 180ms later as news, which the server answered by walking the agent one row down and back — the jump on every session switch.
- `redrawLocally` (`term.refresh(0, rows-1)`) is the only redraw. A size that did not move is never re-sent: re-announcing a known size produced two frames for two heights, which was the jump on every attach, keyboard and foreground. The one case it truly fixed — a half-drawn frame from an agent mid-write — fixes itself with the next output chunk.
- `onResize` handler: xterm is refitted immediately (a reflow is ~3ms and keeps the composer row on screen) but the PTY is told once after `RESIZE_SETTLE_MS = 180` of quiet, because every size the agent hears is a SIGWINCH plus a full redraw, and a dozen chasing a sliding keyboard leave frames drawn for one height on a screen that is another. A settled size equal to `sentSize` (keyboard came and went inside one window) only redraws locally.
- `fit()` is skipped when the container measures 0x0: a `display:none` container would collapse the grid and garble the buffer via reflow. The `try/catch` is because `fit()` can race with dispose during unmount.
- `resync` on `visibilitychange`/`pageshow`: iOS suspends a backgrounded tab and the socket can die on the network with no `onclose`, so a returning phone finds a socket that looks open and carries nothing. It pings and closes the socket itself after `PROBE_TIMEOUT_MS = 3000` if nothing arrives; any frame clears the probe. An already-closed socket reconnects at once instead of waiting out `RECONNECT_DELAY_MS = 1500`.
- The tab-return effect is purely local: another tab never sleeps the socket, so the buffer is current and only the picture went stale (xterm stops rendering an unseen box). The agent hears nothing unless the layout actually changed.
- `painted` / `PAINT_TIMEOUT_MS = 700`: a switched-to terminal is held invisible (laid out, measured, fitted, not shown) until the replay is written, then revealed one rAF later so what appears is the finished screen rather than an empty frame and a scrolling write. The timeout is so a server that never answers cannot leave the box hidden.
- On `ready` the terminal is `reset()` rather than cleared — a dropped connection can leave it mid-escape-sequence or on the alternate screen with mouse tracking on — and `viewing` is re-sent because the server assumes the session is on screen when the socket opens, which is wrong when the app was left on another tab.
- `paste` handle uses `term.paste()` rather than `write()`: the agent's composer reads a bare newline as "send", so a written multi-line message arrives as several half-messages. xterm applies bracketed paste when the app asked for it and folds CRLF to CR otherwise. App.tsx sends every whole message this way.
- xterm is opened one frame after mount via rAF so React StrictMode's throwaway first mount never starts xterm's internal timers, which fire after dispose and crash.
- `term.textarea.readOnly = true` on mobile except during a deliberate focus: iOS otherwise pops the keyboard on scroll. A tap on a live session makes it writable and focuses; a read-only session never focuses since there is no PTY.
- The terminal box uses `overflow: clip`, not `hidden`: xterm's screen is positioned and would paint over the key bar and tabs, and `hidden` would make it something iOS can scroll out from under the focused textarea.

### Touch, selection and links (touch.ts, terminal-snapshot.ts, terminal-links.ts)

- `isTouchDevice` checks the UA for iPhone/iPad/iPod as well as `(hover: none) and (pointer: coarse)`, because the media query alone misses phones that need touch handling.
- `snapshot`: the in-place selection over the live terminal was abandoned because every repaint scrolls the buffer, `term.onScroll` had to drop the selection, and selecting while Claude Code was working was impossible; and "hold then drag" is the same movement for extend-selection and scroll, so one had to lose. A frozen copy moves nothing and hands selection to the platform. (DESIGN-NOTES still describes the grips; this replaced them.)
- `MAX_ROWS = 3000` is counted in rows, not logical lines, so wrapping only shortens the panel; the cut is moved back to a logical-line boundary so the first line shown is not a tail. Trailing blank lines are popped (never past the pressed line) so the last line of the session sits at the bottom of the panel rather than twenty rows above it.
- `logicalCells` is a `getCell` per column per row and runs only for the pressed line and the link scanner; the rest of the snapshot uses `translateToString`, because three thousand rows of `getCell` on a phone feels like the panel refusing to open. Cells rather than string offsets because a Thai cell can hold several characters and a wide glyph spans two columns.
- `terminal-links.ts` scans cells, not string offsets, for the same reason; `URL_CHAR` is ASCII-only rather than "anything but a space", which keeps an adjacent Thai word out of the address.
- `HOST` requires dot-separated labels that begin and end alphanumeric, or a bracketed IPv6 literal: `https://...:8443/` (a program eliding its hostname, Orbit's own docs included) used to be offered as a link and could only open a blank frame. Userinfo (`token@github.com`) is allowed because git remotes print it and stopping at `@` returned an address with no host.
- `continues` accepts a continuation indent of at most `MAX_INDENT = 4` (Claude Code writes two spaces) and drops that indent, not the text after it.

### App shell and boot (App.tsx, api.ts)

- `openedWith` and `pairCode` are read at module load and cleared from the address bar immediately, but `openedWith` is spent only by the boot run that acts on it, after the `cancelled` check. Clearing on read handed it to the boot that `setLocked` immediately cancels, and the next boot fell back to the stored session — the one the notification was not about.
- Boot deliberately starts no shell when there is nothing to reattach to: opening a tab used to put a program on someone's Mac, and a home-directory shell was rarely the session wanted.
- `showNotice` queues toasts (3s each) because a reconnect delivers everything the phone slept through in a batch, and the last one winning would drop the rest. `alreadyPushed` notices skip `systemNotice` because a banner is already on screen.
- `onAuthFail` calls `checkAuth()` for a fresh cookie and bumps `socketNonce` to remount the terminal: the stored token is usually still good when only the cookie expired, so nobody should retype it. An unreachable server is treated as locked.
- Un-pairing lives in App rather than SessionsView because flipping `locked` is what tears down the socket and session; the push endpoint is read before the server request and cancelled after it succeeds, because the server must be told which endpoint is this phone while the subscription still exists.
- `status` is shown as `connected` when there is no session and boot finished; otherwise the header sits on "Connecting…" forever with no socket to report on.
- An uploaded image path goes into the draft (or the voice transcript via `setTranscript`, which makes it the baseline a restarted run appends after), never straight to the PTY; the sheet that opened the picker is read before the upload so the path lands where it is being looked at.
- `preview` (agent `orbit_preview`) is framed from App, not the Preview tab, because the tab in front is nearly always the terminal. It renders only with no approval and no asks: a blocked question outranks it, and it is kept rather than dropped so it appears once answered. A second preview replaces the first; a frame already open from another component stays underneath.
- On preview close the route is saved to `orbit.previewRoute.<localPort>` — keyed by local port because `tailscale serve` reassigns public ones — so the Preview tab reopens where the agent left it (`CapturesView` writes the same key).
- Toasts with a `sessionId` for a session not on screen render as a button that navigates there; plain toasts stay a div because a button that does nothing reads as broken. Long toasts switch from `rounded-full` to `rounded-[22px]` because a four-line pill is a blob.
- `api.ts` writes throw on non-2xx rather than returning the Response: a rename once "succeeded" on a 4xx and showed the old name with nothing said.
- `unpair`: server call first, local storage cleared only on success — clearing on failure leaves a phone with no token but a live cookie, logged out yet able to open a socket, unrecoverable without retyping. Only `TOKEN_KEY`, `SESSION_KEY`, `RECENTS_KEY` go; dictation language, mic-primed flag, key-row and viewport preferences describe the phone, not the Mac, and survive.

### Login and pairing (Login.tsx, QrScanner.tsx)

- `busyRef` is a ref, not a dependency of the memoised `onResult`: the scanner's callback must not change between renders or its effect tears the camera down and restarts it.
- `QrScanner` decodes with jsQR (Safari has no `BarcodeDetector`), dynamically imported from the tap that opens the sheet so the 47KB decoder stays out of the boot bundle for the paste-a-token majority. `getUserMedia` and the import start together in `Promise.all`: the download is the slow half, and asking for the camera first keeps the prompt inside the tap.
- Frames are decoded at `min(1, 480 / videoWidth)` scale: jsQR is per-pixel and a 1080p frame at 60fps heats the phone, while a QR filling a third of the view is still tens of modules across at 480px. `inversionAttempts: 'attemptBoth'` because the QR is printed into a terminal, light-on-dark on a dark theme.
- `playsInline muted autoPlay` are all required: without them iOS takes the video fullscreen the moment it plays, hiding the sheet and its cancel button. All camera state lives in one effect so there is exactly one place that can leak a stream (which keeps the iOS recording indicator lit with nothing on screen saying so). WebKit reports refusal as a DOMException name only, so `cameraDenied` translates it into the setting to change.

### Voice (speech.ts, VoiceSheet.tsx)

- `prime`: iOS does not reliably raise the microphone prompt for `SpeechRecognition.start` — it just refuses — so the first attempt calls `getUserMedia` inside the same gesture and starts the recogniser from its callback, which iOS accepts because the grant just happened. `MIC_GRANTED_KEY` skips priming thereafter.
- `onerror` sets `listening = false` itself: iOS does not always fire `onend` after a refused start, and the sheet would otherwise show "Listening…" over an error.
- `setLang` while listening aborts and restarts — safe only because the sole caller is a tap on the language chip, the gesture iOS wants. While still `preparing`, the pending `getUserMedia` callback picks up the new language on its own.
- `errorMessage` names all three iOS switches because iOS reports all of them as `service-not-allowed`; the raw `code` is kept for diagnostics because phones have no devtools.
- `VoiceSheet`'s "Continue listening" is full width at 44px because on iOS it is the most-pressed control in the sheet, more than Send.

### Clipboard and links (clipboard.ts, local-url.ts)

- `copyText` fallback for insecure contexts: iOS `execCommand('copy')` copies nothing from a readonly or offscreen field, so the proxy textarea is `contentEditable`, `readOnly = false`, on screen at 1px x 1px with `opacity: 0`.
- `openExternal` clicks a real `target="_blank"` anchor rather than `window.open`: WebKit treats the synthetic click on a real link as navigation, while `window.open` from a standalone web app is what it has historically swallowed.
- `localUrl`: when the rewritten port is Orbit's own it returns `location.origin + rest` to stay on the scheme and proxy already in use; a bare `www.` gets `https://`.

### Sheets and views

- `ComposeSheet` is a sheet, not a docked bar, so the terminal keeps its stripe; it is also the only surface iOS offers its own Paste menu over, which the old header paste button stood in for badly. It focuses on open with the caret at the end because a surviving draft is being returned to. The mic is not inside it: opening voice from inside put one sheet over another with the first one's keyboard still up eating the first tap.
- `SelectSheet` renders the snapshot as one text node so a DOM offset equals a string offset — pre-selection and the Line button need no second index. `white-space: pre` with sideways scroll so a copied line matches the terminal and diffs keep their shape. The pressed word is scrolled to a third of the way down (the lines after it are usually what is wanted next). `copied` stores the text copied, not a boolean, so "Copied" cannot stand over a different selection. The panel must re-enable `user-select`, which the app turns off over the terminal.
- `AskModal` has no dismiss (something on the Mac is blocked); two options render `flex-row-reverse` so the first, emphasised option sits under the thumb; empty options fall back to `Allow`/`Deny`. The title never wraps and the path truncates from the head with `min-w-0`, because a long path used to push the title onto two lines.
- `TerminalKeys`: both rows are permanently up because folding them was a resize, and a mid-draw agent answering it left a half-written frame on screen — three client-side rounds did not close it. Keys are 40px tall, not 44, because three arrows plus a five-key row must clear 375px. `HOLD_MS = 400` / `REPEAT_MS = 80` for auto-repeat; `TAP_SLOP_PX = 10` cancels a moved tap. The keyboard toggle is handled on `touchend` with `preventDefault` because the click that follows blurs the textarea and closes the keyboard before the toggle can open it. The bar is `z-10` because xterm's positioned screen paints over a static bar. Arming Ctrl opens the keyboard because the letter must come from it.
- `useArrival` fills its `seen` set in an effect, not during render: under StrictMode React renders twice before committing, and marking ids seen on the first pass leaves the committed pass believing everything already arrived, animating nothing ever. The stagger index counts only new ids; headers get synthetic ids so they take their turn.
- `Sheet`: the scrim carries `backdrop-filter`, the panel does not — a second filter would have WebKit re-sampling two full-screen layers over a canvas that never stops repainting; the panel slides on transform alone.
- `IconButton` sm/md are drawn small and use `hit-xy` to reach 44px without moving layout; lg is 44 and gets none. `Button` has no `disabled:opacity-*` because fading drags labels under 3:1 contrast; `.pill:disabled` draws the state. `Segmented` uses `max-w-full` and `min-w-0` children so four long labels (40 characters) truncate proportionally at 390px instead of running off the phone.
- `CaptureSheet`: Full page is a modifier, not a fourth size, because the server only lets height run past the fold at a preset's width. Nothing is remembered; the old `orbit.screenshotPreset` key is deliberately never read again. Captions flip from `390 × 844` to `390 wide` because only the width holds on a full-page shot. The sheet closes before the shot, not after, since rendering takes seconds.
- `CapturesView`: `busy` is a per-target string (two captures can run at once in the shared Chrome). Published list and dev ports are fetched on mount and on wake only (a process launch and a socket per candidate); liveness polls every 10s while active, with `ports` joined to a string so a same-set re-render does not restart the interval, and a failed poll leaves the last answer standing. A 30s `tick` re-renders tiles so `timeAgo` stops saying "now" forever.
- `CapturesView` keeps `previews` whole (not reduced to its list) so `reason` can explain a machine that cannot publish. A row's ⧉ is disabled when not listening because Chrome returns a raw `net::` error with no picture, whereas ✕ stays live to stop an abandoned mapping. The escape-hatch URL field sits at the foot of the list because a top field spent a year looking like the page's subject. `MAX_TILE_RATIO = 16/9`: taller shots get a 9/16 frame with `object-cover` top-aligned rather than a metres-long tile.
- `ChangesView`: `NOISE` drops only `diff --git`, `index`, `---`, `+++`; mode changes and rename sources stay. `marksByHunk` is memoised because the LCS per line pair re-ran on every app re-render (a toast, a status change). Arrival ids are hunk headers, not positions, so staging one hunk (which refetches the diff) does not replay the others' entrance. `canStage` requires `!diff.truncated` because a cut hunk may be half a hunk and git might accept the half; only `M` files are splittable. Status refetches on activation and `visibilitychange`, never on a timer, since `git status` walks the working tree. A failed diff fetch sets an error rather than leaving `diff` null, which the sheet read as loading.
- `SessionsView`: the Mac-conversations group is collapsed by default and its hidden count fetched only when opened. `commitRename` guards `renamingId !== id` because Enter unmounts the input whose blur commits again. Un-pair lives behind a header icon rather than a list-end button because a scroll to the bottom used to land on it. The empty state counts Mac rows too so it never contradicts a group of ten below it. A guessed (idle) note uses the quiet colour and a non-pulsing dot.

### Notices and push (notice.ts)

- `registerPush` re-subscribes on every launch because subscriptions expire and endpoints rotate; failure is silent since no push is a degraded phone, not a broken app.
- `pushEndpoint` is read separately from `dropPush` so the endpoint is handed to the server first and cancelled only after that succeeds; a failed un-pair leaves a phone that still gets notifications rather than one silently cut off.
- `dropPush` cancels the browser-side subscription too, because it survives the app closing and would be handed straight back to the next `registerPush`. Its own failure does not stop sign-out: the server has forgotten the endpoint and the next push 410s and prunes.
- `systemNotice` checks `getNotifications({ tag: 'orbit-notice' })` for the same body before showing, because the shared tag is supposed to replace the push banner and on iOS it does not always.

### Service worker (sw.js)

- `CACHE = 'orbit-__BUILD__'` is stamped per build by vite.config.ts and `activate` deletes other caches; otherwise every deploy's hashed bundle stayed cached for the life of the install.
- Fetch is network-first with the cached shell as offline fallback, skipping `/api/`, `/ws` and `/healthz`. Only `response.ok && response.type === 'basic'` is cached: a 502 from the proxy during a restart, or the server's plain-text "web build not found", would otherwise replace the shell and be what the next offline launch shows.
- Push: the first two `ask.options` become notification actions (a banner shows at most two; the rest are in the modal). Tag is `orbit-ask` for questions and `orbit-notice` otherwise, because replacing one with the other would drop whichever arrived first while only one is still waiting; `renotify: true` so each replacing notice still announces itself.
- `notificationclick` on an `answer:` action posts `{id, token, choice}` to `/api/ask/answer` and opens nothing; on fetch failure it re-shows the question as a notification because the Mac is unreachable and the question is still waiting.

### Viewport and entry (viewport.ts, main.tsx)

- `watchViewport`: iOS never shrinks the layout viewport for the soft keyboard, so `inset: 0` leaves the composer, key bar and tabs behind the keys; Safari pans the visual viewport only far enough to reveal the focused element, and xterm's textarea rides the cursor near the top of a fresh session, so nothing moves. `--app-height` is `visualViewport.height`, `--app-top` is `offsetTop` (how far Safari already panned) which the shell adds back. Writes coalesce to one rAF per frame; `window.scrollTo(0,0)` undoes the document shift focusing an input can still cause. It runs before the first render so the shell is sized before first paint.
- The service worker registers only under `import.meta.env.PROD` so HMR is never cached.

### Diff highlighting (diff-words.ts)

- `MIN_SIMILARITY = 0.3` (shared characters over the longer line): below it two lines are a delete and a write, and marking every token is true and useless. `MAX_TOKENS = 400` per line because the LCS is O(n x m) and lines that long are minified or generated.
- `pair` pairs only equal-length runs of removed/added lines line-for-line; three-becoming-one has no line-to-line answer and guessing puts the highlight on whichever line lined up. A pair whose tokens all match (whitespace-only) returns null so the view falls back to whole-line colour.

### Dev gallery (dev/*)

- The gallery renders every state open with no controls, routing or clicks because `orbit_capture` screenshots are how agents review it and a click is a state a screenshot never reaches. The scaffold uses raw Tailwind rather than Orbit primitives so a broken Button cannot break the page auditing it. `Field` takes real `focused` because a document has one focused element and a faked ring would be a second definition of focus. Tokens are read from the live stylesheet so they cannot drift.

### Test harness and scripts

- `scripts/test.sh` picks the port itself from 3099 up and names the scratch HOME after it: asking the caller for one used to die on "port in use", so a second session invented its own port and HOME, which is how six `/tmp/orbit-smoke-31xx` directories outlived their runs. `LIVE_PORTS` (7788 and 3001) are refused because the suites kill sessions and a real Orbit answers there; 3001 is on the list because it was the default until 0.2.2 and an instance started before that is still on it until restarted. `smoke.mjs` (`SMOKE_FORCE` overrides), `changes-smoke.mjs`, `shots.mjs` and `shots.sh` each refuse them independently.
- `test.sh` exports `REAL_PATH` from `/bin/zsh -lic`: the scratch HOME has no rc files, so the server's login shell rebuilt PATH without `~/.local/bin` or version-manager shims and provider detection (`zsh -lic 'command -v claude'`) reported every agent "not installed" — a false negative nobody investigates.
- `test.sh` sets `ORBIT_TAILSCALE` to `fake-tailscale.mjs`: the real CLI either skipped the preview tests or published real mappings, and `:8443 → 127.0.0.1:3099` once outlived the throwaway server and confused a debugging session weeks later. The fake keeps mappings in a JSON file under the test HOME, seeds `443 → 7788` (the front door `orbit phone` created) so Orbit must leave it alone untold, prints the CLI's words on stderr (which `preview.ts` reads), and keeps the trailing dot on `DNSName` because `preview.ts` strips it.
- `test.sh` deletes the scratch HOME only when suites pass (a failed run's server log is what someone wants to read) and retries `rm -rf` five times at 0.3s because the server's shells write `.zsh_history` a moment after the server has gone.
- `ORBIT_BIN` points the suites at a built executable instead of the checkout's server, absolute or relative to the checkout — a binary downloaded from a release is the thing most worth pointing them at, and it does not live in the tree.
- `smoke.mjs` attaches the `gone` message listener before any `await`: under Bun the socket opens, is told `gone` and closes within ~3ms, before a fetch returns, so a listener attached after waits forever.
- `smoke.mjs` asks resumability of the provider list, not the new session: a live session is never resumable by design (resuming would put a second agent into a held conversation), so gating on it skipped the test on every machine while claiming Claude was not installed.
- `smoke.mjs` conversation bookkeeping runs in a child process with its own data directory because a second `PtyManager` on the same `~/.orbit` would be two writers of one `sessions.json`; every session it makes is killed immediately so a machine with Claude Code does not get real agents in a scratch folder.
- `smoke.mjs` WINCH test: `trap 'echo W""INCH-HIT' WINCH` in the shell, the marker split so the command echo cannot be mistaken for the trap firing; a same-size reattach must not fire it, a different size must. This is the guard on "nothing forces a redraw".
- `smoke.mjs` treats macOS's "could not create image from display" as a skip: it means the process lacks Screen Recording permission (normal for a server launched from an editor, CI or an agent shell), and failing on it teaches people to ignore red lines.
- `smoke.mjs` dev-port test listens with an HTTP server on 3097 and a mute TCP server on 3096 because the HEAD probe, not a bare connect, is what separates a dev server from a database. The `POST /api/preview` non-HTTP stub uses `c.destroy()` because the probe half-closes and two half-closed ends leave a socket `close()` waits on forever.
- `smoke.mjs` sends malformed frames (`null`, `garbage`, `[]`, resize with string or zero cols) because each once threw past the switch and exited the process with every session in it.
- `smoke.mjs` Mac-transcript cap: twelve valid fixtures, ten reach the phone — the cap, not an age cutoff, keeps the list about Orbit's own sessions since a used machine has hundreds all touched this week. The MCP tool check is by name, not count, because a count was wrong about `orbit_preview` after a rename.
- `smoke.mjs` sign-out asserts the `Set-Cookie` has the same name and `Path=/`, or the browser keeps the live cookie beside the expired one; the token is deliberately untouched (rotating would sign out every device and cost a restart).
- `ask-smoke.mjs` tests `notify.ts` directly rather than over HTTP because the answer token would otherwise have to be recovered from an encrypted push payload. `topicIsValid`: proven against Apple's endpoint on 9 Sep 2026 — 12- and 10-character topics returned 201, 13-character and the 9-character `orbit-ask` returned 400 BadWebPushTopic; the rule is length (the header is decoded as base64url), not the characters, and both shipped topics were wrong for five weeks.
- `idle-smoke.mjs` uses `QUIET = 120`ms against a fake session; the echo case matters because typed input is echoed as output and restarts the clock, so what stops a report is the turn's output count resetting, not a cancelled timer.
- `touch-smoke.mjs` taps via Playwright's touchscreen so the emulated click follows (the reason tap handling swallows clicks); press-and-hold is dispatched in-page because Playwright has no API for it. The `hold` selector keeps dispatching to the original node even once detached, because a real finger does and resolving the target afresh had silently repaired the dead-glyph swipe bug. WebKit cannot construct `Touch` but has `createTouch`; Chromium is the reverse. `spanAt` finds a word by column because xterm draws a whole unstyled row as one span. The alt-screen app is written to a file because quoting through `node -e` over a pty breaks silently, and it repaints continuously because a draw-once app cannot reproduce the detached-node case.
- `changes-smoke.mjs` scopes the "Stage" click to the sheet with an exact match because "Stage all" sits in the list behind it and a substring match clicks through. Both browser suites reset `errors` after login because the 401 that raised the login screen is the app working; touch-smoke also ignores `40[14]` for the login probe and example.com's missing `/a/b`.
- `setup-smoke.mjs` makes its own HOME regardless of the script's because it edits `~/.claude/settings.json`; it asserts the approval hook carries `timeout: 190` (the one that fails open when wrong) and that legacy `scripts/orbit-approve.mjs` hooks are taken over rather than doubled, since double hooks buzz the phone twice per question.
- `shots.sh` moves only `ORBIT_HOME`, keeping the real `HOME`, so a photographed session has the user's shell, PATH and agent credentials; the demo project lives under the real home because Orbit refuses sessions outside it. It unsets every `CLAUDE*` env var so an agent started from inside a Claude Code session does not print "transcript saving is off" in a published picture.
- `shots.mjs` types `export PS1='storefront $ '; exec zsh -f` first because the machine's themed prompt carries a username, hostname and path into a published page; uses `git --no-pager` because `less` fills the scrollback with tildes; clicks `.xterm-screen` before typing because xterm only takes keystrokes once touched; stubs `SpeechRecognition` and skips `getUserMedia` priming because headless Chrome has no mic; intercepts `/api/dirs` and `/api/ports` so the folder picker and Preview tab show the demo rather than client names; saves JPEG q88 because ten 2x dark-grain PNGs were 7MB per re-run in git history; kills every session at the end because a dev server holding :5199 meets the next run as a busy port.

### Installer and release scripts

- `install.sh`: while the repo is private, assets come via `gh` when logged in, else via the API by asset id with `GITHUB_TOKEN` (private assets are only reachable by id). `ORBIT_LOCAL_DIR` replaces every fetch with a `cp` so `install-smoke.mjs` runs with no network or real binary. A missing or mismatched `.sha256` aborts before install. `xattr -d com.apple.quarantine` runs although nothing went through a browser — harmless when absent. The PATH line is appended to `~/.zshrc` only if the dir is not already on PATH and not already in the file (`ORBIT_NO_MODIFY_PATH` skips it).
- `dist.sh` passes `--external chromium-bidi` because it is an optional require inside playwright-core (for Firefox) that the bundler cannot resolve and the binary never needs; `web/dist` and `server/package.json` go in as `--asset` because the server reads them from disk (`WEB_DIST`). A `.sha256` sits beside each binary because the Homebrew formula names it and `tap.sh` reads it from the release rather than this machine.
- `release.sh` runs `bun install --silent` after bumping both package.json files because the lockfile carries workspace versions, and tolerates an empty commit for a version the files already carry.
- `icons.mjs` reads colours out of `web/src/styles.css` and fails loudly if a token is missing; renders each size at exact pixels in system Chrome, since scaling down a bigger PNG is what turned the old favicon to mush. Sizes below 192 drop the satellite (~5% of width, a smudge at small sizes). `RIM = rgb(255 255 255 / 0.17)` keeps the ring dark under a satellite so the sweep is the bright thing; the satellite-less favicon opens the rim up. All PNGs are full-bleed ink (iOS will not round-trip transparency; Android's legacy path drops a white plate); apple-touch-icon is 180 unrounded since iOS applies its own squircle; maskable artwork sits inside the 80% safe circle. `syncColours` rewrites manifest and theme-color from `--color-ink` because three files once disagreed.

### Site builder (docs/site/build.mjs)

- Everything is embedded (fonts, screenshots as data URIs) so `index.html` opens off disk or by mail; `sips` does the image pass because macOS is the only platform anyway. Anuphan (Thai subset only) is embedded because Space Grotesk has no Thai and the fallback, Thonburi, is looped and reads like a government form beside a geometric sans.
- `SHOT_WIDTH = 780`: the hero phone is 300 CSS px, retina asks for 600, and a 520px source upscaled looked soft. `make shots` already writes 780px JPEGs, so anything at or under that width is embedded verbatim with no second lossy pass; only PNGs or larger images go through sips at `SHOT_QUALITY = 82`.
