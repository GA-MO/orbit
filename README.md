# Orbit

Local AI coding hub — turn your MacBook into a personal AI development server you control from your phone's browser. See `AGENTS.md` for the full product spec.

## Status

**Phase 1 complete** — real interactive terminal (xterm.js ↔ WebSocket ↔ node-pty ↔ zsh) with:

- ANSI colors, cursor movement, interactive prompts
- Keyboard input incl. Ctrl+C, resize, scrollback
- Persistent sessions: the PTY survives mobile disconnect; reconnecting replays scrollback
- Auto-reconnect with connection status indicator
- Mobile-friendly layout (safe areas, visual-viewport-aware resize for on-screen keyboard)

**Phase 2 complete** — agent provider system:

- Providers: Claude Code, Codex CLI, Gemini CLI, plain shell — availability auto-detected through the user's login shell (`GET /api/providers`)
- Session drawer (☰): list/switch/kill sessions, start a new session with a provider + project folder picker (recent folders as one-tap quick-picks, folder filter)
- Smart folder defaults: browser opens at the last-used project, git repos marked with ⎇, home shortcut, and a non-blocking hint when starting an agent in a broad non-repo folder

**Phase 3 complete** — persistent session management:

- Session metadata + terminal history persisted to `~/.orbit/` (`sessions.json` + `scrollback/<id>.txt`, debounced writes, sync flush on shutdown)
- Sessions survive server restarts as "Ended" entries. Tapping one opens its history read-only; **Resume** and **＋** (fresh session, same agent and folder) live in that view's header, and the row itself carries only ✕ (forget, deletes history). Both of those buttons start an agent, which costs tokens and takes a minute — a list you scroll with a thumb is the wrong place for them, and reading the history first is also the only way to tell two ended rows of one folder apart
- **A session that named its own conversation is reachable as itself.** Where the agent lets Orbit choose the name, one is minted at launch (`claude --session-id <uuid>`) and ↻ asks for it back by name (`claude --resume <uuid>`) — so a folder's third-newest ended session reopens exactly the conversation that was tapped, however many have been opened since. What a row claims is then the conversation rather than the folder, which still stops one being opened twice and stops a resumed-then-ended session offering the same conversation from two rows
- For agents that only offer "the newest conversation in this folder" (`codex resume --last`), the old rule still holds: ↻ appears on the most recently ended session of a folder+agent and only while nothing is live there — anywhere else it would either reopen a different conversation than the one tapped, or put a second agent into one already in use
- A session id the phone remembers but the Mac no longer has is reported as gone, rather than silently opening a shell in the home directory under the old id
- Ended sessions capped at 20 (oldest pruned)
- **Conversations from the Mac's own terminal are on the phone too.** `claude` run at the desk leaves a transcript in `~/.claude/projects/<folder>/<id>.jsonl`, and that id is what `--resume` takes — so those appear alongside Orbit's own ended sessions, interleaved by when each was last touched, and resume on the same terms. Everything about them is read: the files belong to Claude Code, are never written or pruned, and carry no ✕, because deleting the record of a session you ran at your desk is not a tap to offer from a list you scroll with a thumb. There is no scrollback behind one — nothing drew it on Orbit's screen — so opening it rebuilds the conversation from what was said, one line per tool call. A transcript with nothing the user typed, one from outside the home directory, and one whose folder has been deleted are all left out: the first has no history to read and nothing to call the row, and the other two cannot be resumed into. Claude only — it is the one agent that names a conversation, and `codex resume --last` still reaches no further than a folder's newest

**Phase 4 + security + PWA complete:**

- **Auth**: access token generated to `~/.orbit/config.json` and printed in the server console; required for all `/api/*` and WebSocket traffic as `Authorization: Bearer`; login screen on the phone, invalid/expired token drops back to login. A WebSocket handshake and an `<img src>` cannot carry that header, so those two authenticate with an `HttpOnly; SameSite=Strict` cookie minted by `GET /api/auth/check` — it holds a hash of the token rather than the token, and authorises reads and the socket only, never a write. Nothing puts the token in a URL, where it would end up in proxy logs and history
- **Voice input**: 🎤 opens a Web Speech overlay (browser speech recognition, gated on a recogniser *and* a secure context); transcript is editable, then Insert (type only) or Send (type + Enter) into the terminal. Recognition language is a ไทย/EN toggle in the sheet (remembered; dictation matches one language per run, so it cannot be inferred). iOS Safari is the constrained target — recognition is started inside the tap itself (a start one tick later is refused), `continuous` is off there because WebKit ignores it, and each pause ends a run that a **Continue listening** button resumes onto the existing transcript. Refusals from Apple's dictation service (`service-not-allowed`, `not-allowed`, …) are translated into the setting the user has to change; note it never works from a home-screen PWA — that is a WebKit limitation, not a bug here
- **Image input**: 📷 uploads a photo/screenshot to `~/.orbit/uploads/` and inserts its file path into the terminal, ready to reference in an agent prompt
- **PWA**: manifest + icons + service worker (registered in production builds only) — installable to the home screen
- **Production mode**: the Node server serves `web/dist`, so production is a single port: `npm run build && npm start -w server`, open `http://<mac-ip>:3001`

**Phase 5 + command approval complete:**

- **Screenshot validation**: 📸 panel — enter your dev app's URL, capture renders it headless in system Chrome (`playwright-core`, `channel: 'chrome'`, no browser download) at a Phone / Tablet / Desktop viewport (or full page), plus a **Mac screen** source for what Chrome cannot render (simulators, native apps, Xcode); gallery lays every shot out at its real aspect ratio with tap-to-zoom, ⇥ inserts the PNG path into the terminal for the agent to inspect; stored in `~/.orbit/screenshots/` (last 50 kept). Chrome stays warm between captures, and a dev server that is down is reported as an error instead of quietly saving a picture of Chrome's error page. Each capture is labelled with what it was of (`localhost:5173`). The **Mac screen** source later moved out of this panel and became the agent's alone (`orbit_screen`), and the list of URLs that had rendered before became a list of ports that are serving now
- **Command approval**: multi-character input chunks (paste / voice / automation) are screened server-side for dangerous patterns (`rm -rf`, `sudo`, disk writes, force-push, fork bombs, …). Matches are held and a red approval modal shows the exact command — Run anyway or Deny. Hand-typed single keystrokes pass through (they cannot be reconstructed reliably and are the user's own deliberate input).
- Named sessions: optional name at creation, rename via ✎, created-time shown per session; the active session's name is the header title. A session nobody named is labelled with the first line typed into it (command for a shell, opening prompt for an agent) — captured server-side from the input stream, escape sequences and control codes stripped, backspace applied, so three unnamed shells are told apart by what they are doing
- Agent CLIs launch via `zsh -lic 'exec <cmd>'` so the user's real PATH applies; exiting the agent ends the session
- REST API: `GET/POST /api/sessions`, `DELETE /api/sessions/:id`, `GET /api/dirs` (home-restricted directory browsing)

**Phase 7 — the agent's side of the app:**

- **MCP server** (`server/src/mcp.ts`, stdio JSON-RPC, no framework): `orbit_capture` renders a URL and returns the *image* so the agent can look at its own UI work, `orbit_screen` hands it the Mac's screen, `orbit_notify` puts a line on the phone, `orbit_ask` puts a question on the phone and blocks until it is tapped. Installed by `make setup`
- **Mac → phone channel**: `POST /api/notify` and `POST /api/ask` broadcast over the existing WebSocket; questions outlive a reconnect (a phone that joins mid-question is caught up) and time out rather than hanging forever
- **Reaching a phone that is asleep**: iOS freezes the page and drops its socket on lock, so a notice sent then reaches nobody at all. Two things cover that gap — the notice is held and replayed to whoever connects next (once, and only if it was never delivered live), and a Web Push wakes the service worker with the app closed. Push fires only when the live channel found nobody, so an open app never gets a banner and a toast for the same event. VAPID keys live in `~/.orbit/config.json`, subscriptions in `~/.orbit/push-subscriptions.json`, and retired endpoints prune themselves. iOS grants notification permission only from a tap inside an installed PWA, hence the opt-in row at the top of Sessions
- **Knowing Claude is waiting**: its own question boxes and permission prompts live in the terminal, which is invisible to a phone in a pocket. `scripts/orbit-notify-hook.mjs` forwards `AskUserQuestion` (with the question and its options), the notifications that mean "waiting for you", and turn-end for sessions started from Orbit. All of it is sent `quiet`: the server drops it while Orbit is open, since a toast repeating what is on screen is noise. Nothing blocks — the hook fires a request and exits
- **Approval for what the agent runs itself**: terminal screening only ever saw what *you* typed — a command from the agent's Bash tool never crosses that boundary. `scripts/orbit-approve.mjs` is a Claude Code `PreToolUse` hook that screens tool calls with the same patterns and routes matches to the phone. Fails open when Orbit is not running, fails closed when it is and nobody answers
- Setup and caveats: [docs/MCP.md](docs/MCP.md)

**Getting things out of the terminal (and into a browser):**

- **Tap a URL and choose what happens to it**: links are found in the buffer cell by cell, so a URL wrapped across two rows is still one link and a trailing comma is not part of it. That includes the rows a *program* wrapped itself (Claude Code writes `\r`, cursor-right two columns, cursor-down): there is no `isWrapped` flag on those, so the join is inferred from a row that ends on a URL character and a next row whose first non-space character is punctuation a URL can continue with — `.html`, `/path`, `?q=1`. A line of prose below a URL starts with a letter and is left alone, because an address that resolves to the wrong page is worse than one that stopped short. Each row's blank padding is dropped before the join, or the space would end the match exactly where the wrap was. Half a URL is worse than none — it opens a real page that is the wrong one. The tap is matched by Orbit itself — xterm resolves a click against whatever the mouse last moved over, and a finger never moves over anything. A tap opens a sheet with **Open here** and **Copy** — and nothing that navigates the app away. Leaving costs the session its screen: iOS drops a backgrounded page, and an installed web app has no second tab to hand a same-origin URL to, so WebKit walks the whole app over to it and the way back is a cold start. **Open here** puts the page in a frame over the terminal, which the session survives; anything that has to leave goes out as text on the clipboard. Plain http inside the https app cannot be framed (mixed content), so that case offers **Copy** alone and says why. The sheet arms its backdrop late, because the click the browser emulates after the tap would otherwise dismiss it before it was seen. A mouse click, which costs nothing, still opens a tab
- **No SPA fallback for paths that miss**: the app has no client-side routes, so only `/` gets `index.html`. `/site` — the tail of a truncated link — answers 404 in words rather than serving the app, which had made a wrong address look like the app bouncing back to the terminal (**needs a server restart to take effect**)
- **`localhost` is rewritten to the host the phone came in on**: `http://localhost:5173` on the Mac is the phone itself on the phone, so the tap goes to `http://<same-host>:5173` instead — the dev server is reachable there because Vite binds every interface. Preview has the same thing as a button next to Capture: a screenshot answers "how does it look", some questions only the running app answers
- **Press and hold to copy**: the terminal draws its own text, so iOS never offers selection handles over it. Holding selects the **word** under the finger — split on whitespace only, because what gets copied out of a terminal is paths, URLs, hashes and flags, and those are ruined by a split on `/` or `-`. Grips at either end adjust it cell by cell (dragging past the end of a row carries on to the next), dragging the initial press grows it from the word, and **Line** in the copy bar takes the whole logical line, wrapped rows included. Blank rows cannot be selected at all — holding on the empty field below the output does nothing, and a drag into it stops at the last row that has text, because a highlight with nothing inside it is a selection you cannot copy and cannot explain. The selection is Orbit's own: the browser follows every touch with an emulated mousedown, and xterm answers that by collapsing whatever was selected to the cell under it
- **A redraw whenever the phone comes back**: what is on screen is the last frame the agent drew, and a full-screen app only draws again when its size changes. The server asks for one on reattach, but an agent busy running a tool can let that pass — and the composer stays missing until something else moves, which is why toggling the key bar appeared to fix it. The client now asks too, on every foregrounding and once the layout has settled after a reconnect, by arriving at the size it already has by way of one row less
- **Publishing a dev server, from the phone**: the reason "Open here" never worked for the thing you most want to open. A dev server is plain http on a port only the Mac can see, and http cannot load inside an https app — so the link sheet could only offer Copy, and following it walks the installed app off its own page. **Share :3000 over https** in Preview hands the port to `tailscale serve`, which gives it an https address on the tailnet (8443 upwards, one per dev server, `tailscale serve` being tailnet-only — never `funnel`). That address frames, so tapping the row opens the app over the terminal with the session still connected behind it. It also reaches dev servers bound to `127.0.0.1` alone — `vite` and `python -m http.server` bind loopback unless told otherwise, and the proxy connects from the Mac itself — and it hands the app under test a secure context, which is the only way to try its own service worker or camera from a phone. The module keeps no state of its own: `tailscale serve status` already knows what is mapped, and a file beside it could only ever disagree. A published port outlives the dev server behind it, so each row says when there is nothing there rather than opening an empty frame — and keeps saying it truthfully, because an agent restarting a dev server is the normal case and the answer was otherwise only as fresh as the moment the tab was opened. What is *published* and what is *running* are two different questions asked at two different rates: the first costs two `tailscale` processes and changes only when someone publishes something, so it is asked on arrival and on waking; the second is a TCP connect to loopback, so it is polled every ten seconds while the tab is actually on screen. Polling them together would have spawned processes all day to watch something that never moves. The mapping Orbit itself is reached through is filtered out of every list and refused by the API — by target port *and* by 443, because a second instance on a spare port does not recognise the first one's by target
- **What the framed page can do besides sit there**: a dev server changes under you, so the frame has **↻** — the page is a different origin, so there is no `contentWindow.location.reload()` to call and re-assigning the same `src` is not reliably a navigation; the iframe is remounted instead, which always fetches. Beside it, **⧉** hands the page to the agent: rendered whole, headless from the Mac, at this phone's width, so it gets everything below the fold. The path lands in the prompt and the frame closes, because the next thing to do is describe it. What it *cannot* carry is the state on screen — a cross-origin frame will not report its scroll position, let alone an open menu, and the shot is the URL fetched again from nothing. The frame briefly carried a second button for that, a picker for the phone's own screenshot, and it earned its place back: side button + volume up already puts the shot in Photos, and the composer's image button already sends it. All the header button saved was closing the frame first, and it cost a slot on a 390px row where nothing on screen could explain the hardware gesture it depended on
- **The Mac is asked what it is serving, rather than the person**: typing `http://localhost:5173` on a touch keyboard was the slowest part of looking at a change, and the answer was already in the kernel — so `lsof` is asked what is listening and each port arrives as a chip with the program holding it (`:5173 node`). A row of thirteen chips would be a text field with extra steps, so three filters cut it down in rising order of cost: the port number throws out the ephemeral range the OS assigns and the reserved range no `npm run dev` can bind; the program's name throws out the handful of macOS services that squat on round numbers (ControlCenter holds 5000 and 7000, the two most-claimed dev ports on a Mac); and then one `HEAD /` per survivor throws out everything that is listening but is not a web server, which is what separates a dev server from a Postgres. On the machine this was written on that is thirteen listeners down to one. It replaced a list of URLs that had rendered before — which existed only because typing was the way in, and whose whole failure mode was offering a dev server that had since died
- **A capture is taken through the address the phone would use**: a published port is rendered via its tailnet https URL rather than `localhost`, since those are not the same app — secure context, `Secure` cookies, a registered service worker, scheme-dependent redirects. Something that only breaks under https used to photograph perfectly. The file is still labelled with the port, or the gallery would file every shot under one `ts.net:8443` and lose which app it was; each published row also captures straight from its ⧉, with no URL to type
- Checked on both engines by `scripts/touch-smoke.mjs` (`ENGINE=webkit` for the one iOS runs), against a throwaway instance

**Knowing which session wants you, and reviewing what it wrote:**

- **A notice belongs to a session now, and outlives its toast.** The message was a three-second toast and nothing else: miss it — pocket, another tab, a phone face-down — and there was no trace anywhere that Claude had stopped and was waiting. The last thing each session said is now held until it is read, and it says which kind it is: `waiting` blocks work over there, `done` is only worth knowing. A finished turn deliberately cannot bury an unanswered question, because Claude asks and *then* ends its turn, and letting the later one win would replace "answer me" with "done" — the exact case the feature exists for. The Sessions tab carries the count, filled when any of them is waiting; the row carries the message itself, two lines, because a question truncated at forty characters is a question you have to open the session to understand. Reading it is what clears it — being on that session, not opening the app and not tapping the toast, either of which would clear a badge before it was understood
- **A session that goes quiet is noticed without being told.** Everything above is an agent *choosing* to speak — the MCP server, or a hook that has to be registered first. Codex, Gemini and a plain shell have neither, and neither does Claude before the hook is installed, so the phone showed nothing at all while the terminal sat on "Do you want to proceed?" — the one moment the app exists for. The stream already says it: an agent working is an agent drawing, and a spinner or an elapsed counter repaints several times a second, so ten seconds of silence on the PTY means the frame is finished and the cursor is in the composer. No agent's UI is parsed to find that, and nothing has to be kept in step when one of them redesigns its screen. Agents only — a shell at its prompt has been quiet since it started, and a badge on every shell means nothing by it. Only once per turn, since the one thing a notification channel may never do is repeat itself while nothing has changed, and only above a floor of output, or a session opened and left alone would announce itself ten seconds later off the echo of its own keystrokes. What is said under the badge is a line read off the tail of the screen, frame and keyboard hints dropped, a line ending in `?` preferred over the last one — because the last line of a settled agent is its composer and the thing it stopped for is above that. It is a guess and is treated as one everywhere: anything the agent said for itself wins, and a guessed note is drawn in the quieter colour with a dot that does not pulse. Nobody is interrupted who is already looking at that session; a connected phone gets a silent badge rather than a toast, because a toast per turn per session is an unusable app; and only with no phone connected at all is it worth a push
- **Which session, without guessing.** `ORBIT_SESSION_ID` joins `ORBIT_SESSION` in the PTY environment, so the agent, its MCP servers and its hooks all inherit it and say where a message came from. The folder is the fallback for anything that predates it, and only where the answer is not a guess: two live sessions in one folder make it no answer at all, because filing a message against the wrong session is worse than filing it against none
- **`quiet` now means "they can see *this*", not "Orbit is open somewhere".** The hook sends turn-ends and waiting-prompts quiet, and the server dropped them whenever any phone held a socket — so a second session's "Claude is waiting" vanished while you were reading the first one. The phone reports which session it has on screen (`{type:'viewing'}`, re-sent on tab change and on every foreground/background), and only that one is suppressed. A phone in a pocket holds its socket open right up to the moment iOS freezes it, which is why "connected" was never the right question
- **A tapped notification lands on the session that raised it.** The push payload carries the id; the service worker opens `/?session=<id>` when there is no window, and postMessages an existing one, since WebKit ignores `navigate` on a standalone PWA client. The parameter is read at module load and spent by the boot pass that acts on it — read-and-clear handed it to the boot that `setLocked` immediately cancels, and the one that followed fell back to the stored session, which is precisely the one the notification was not about
- **A question can be answered from the notification itself.** A push wakes the service worker with the app shut, and that worker holds no token — deliberately: a background script with standing rights to the whole API is a worse thing to own than four taps. So the push carries a capability instead of a credential: one question, by name, answered with one of the options that question declared, once. The first two options become buttons on the banner, `POST /api/ask/answer` is the only route the access token does not guard, and the nonce is compared in constant time, spent on use, dead when the question times out, and unable to say anything the modal in the app could not have said. Where a platform ignores notification actions — iOS shows none — it degrades to exactly what it was before: a banner that opens the question in the app
- **A Changes tab: what the agent wrote, not just what it is doing.** `git diff` in a pager on a 390px screen was the only way to review an agent's work from a phone, and it is not one. `server/src/git.ts` asks the same questions through porcelain meant to be parsed — status with per-file line counts (untracked files counted against `/dev/null`, since they are in no diff), the unified patch per file for either side of the index, stage/unstage, commit, push — every call `git -C <cwd>` with an argument array, so a branch with a space in it is not a command, and every path checked against the home directory and against climbing out of the repository. The four lines git wraps each hunk in are dropped: they repeat the sheet's own title and cost a fifth of the first screenful. Long lines scroll sideways rather than wrap, because a wrapped diff loses which column the `+` was in. What gets committed is exactly what the Staged group showed — no `-a` sweeping up what was not chosen. Push appears only where it would do something (commits the remote has not seen, or a branch never pushed, which is given its upstream since there is nobody here to answer git's question) and never on a repository with no remote, where the alternative is a button that only fails. git is told not to prompt at all (`GIT_TERMINAL_PROMPT=0`), so a remote wanting a password reports git's own sentence instead of hanging until the timeout

## Structure

```
server/   Node.js + TypeScript — HTTP + WebSocket server, PTY session manager
web/      React + Vite + TypeScript + Tailwind v4 — xterm.js terminal UI
```

## Design system

Deep-space graphite palette with an indigo→cyan orbital accent (amber is reserved for the
"live session" state), Space Grotesk for display type (bundled locally — the PWA never
touches a CDN), and the signature **orbit ring** mark: a satellite tracing a slow orbit,
used as the app mark and connection indicator. Tokens live in `web/src/styles.css`
(`@theme`); primitives (buttons, fields, sheets, icons) in `web/src/components/ui.tsx`.
Navigation is a four-tab shell — Terminal / Changes / Sessions / Preview — with sheets for
focused flows (new session, voice) and modals only for interrupts (command approval).

## Run

First time on a machine:

```sh
make install    # dependencies
make setup      # build, register the MCP server, install the Claude Code hooks
```

Full walkthrough for someone setting up a machine from scratch:
[docs/SETUP.md](docs/SETUP.md).

`make setup` resolves every path from this checkout, so nothing has to be
substituted by hand — which is what made the old copy-this-JSON instructions in
[docs/MCP.md](docs/MCP.md) fail silently. It is safe to re-run (it replaces its
own hooks rather than adding a second copy, and backs up
`~/.claude/settings.json` first) and `make unsetup` takes it all back out.
Sessions already open keep the previous build: the MCP server is spawned when a
session starts.

Development (two ports, HMR):

```sh
npm install
npm run dev
```

- Web UI: http://localhost:5173 (Vite binds all interfaces — open `http://<mac-ip>:5173` from your phone on the same network or via Tailscale)
- Server: http://localhost:3001 (`/healthz`, `/api/*`, WS at `/ws`)
- The Vite dev server proxies `/ws` and `/api` to the backend, so the phone only needs to reach port 5173.

Production (single port, installable PWA):

```sh
npm run build
npm start -w server
```

Then open `http://<mac-ip>:3001` from your phone. That is enough for the terminal, but voice input and Add to Home Screen need a secure context — for those, put it behind HTTPS with `npm run remote:on` (see [docs/TAILSCALE.md](docs/TAILSCALE.md)) and open `https://<machine>.<tailnet>.ts.net` instead.

On first launch the server prints `[orbit] access token: …` — enter that on the login screen (stored in `~/.orbit/config.json`; delete the file to rotate it).

## Testing

```sh
make test             # every suite
make test-smoke       # API / MCP / hooks only (no browser)
make test-touch       # touch behaviour only (needs system Chrome)
make test-setup       # wiring a checkout into Claude Code (no server needed)
```

Screenshots and the product page are generated, not hand-taken:

```sh
make shots            # retake docs/images from the current UI
node docs/site/build.mjs   # rebuild docs/site/index.html from those images
make test-changes     # the Changes tab only (needs system Chrome)
make test-preview-url # how an agent's path becomes a URL (no server)
make test-idle        # noticing a session went quiet (no server)
make test-ask         # answering from a notification (no server)
```

`scripts/test.sh` builds, starts an Orbit of its own on `:3099` under a scratch `HOME`, runs the suites and takes it down again — so a run can neither be coloured by the last one nor reach the `~/.orbit` you actually use, and the server on `:3001` is never touched.

- `scripts/smoke.mjs` — captures, previews, the Mac→phone channel, sessions, attention, git, auth, MCP, the approval hook
- `scripts/touch-smoke.mjs` — tapping a link, holding to select, dragging to extend, copying out of the terminal (`ENGINE=webkit` for the engine iOS runs)
- `scripts/changes-smoke.mjs` — the Changes tab in a real browser: two hunks shown as two, the words that changed marked where they changed, and one hunk staged without the other
- `scripts/idle-smoke.mjs` — which line a settled session is described by, and when it counts as settled at all, against a stand-in session and a clock (`watch` takes the quiet window as an argument so the suite does not spend ten seconds per assertion)
- `scripts/ask-smoke.mjs` — the capability a notification carries: a wrong token, an option the question never offered, a second use, an answer after the timeout
- **`tailscale` is a stand-in in the tests** (`scripts/fake-tailscale.mjs`, pointed at by `ORBIT_TAILSCALE`). The preview suite used to skip on any machine without Tailscale logged in, and on the machines where it did run it published real mappings on the real tailnet — one of which outlived the throwaway server it pointed at. The stand-in answers the four commands `preview.ts` issues, keeps its mappings under the test's own `HOME`, and touches no network. Set `ORBIT_TAILSCALE` yourself to aim at the real CLI

A check reports as **skip** rather than fail when the machine cannot answer it: the Mac screen capture without Screen Recording permission for whatever launched the server, and the agent-resume section when Claude Code is not on the server's PATH. The runner hands the throwaway server the login shell's real PATH, so an agent installed in `~/.local/bin` is found even under the scratch `HOME` that has no shell rc files of its own.

**User guide (Thai, with screenshots)**: [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — a full walkthrough of every feature, captured from a real end-to-end session.

**Using Orbit away from home**: see [docs/TAILSCALE.md](docs/TAILSCALE.md) — WireGuard tunnel to your Mac with real HTTPS (full PWA), no ports exposed to the internet.

## Notes

- npm strips the execute bit from node-pty's prebuilt `spawn-helper`, which causes `posix_spawnp failed` at PTY spawn. The root `postinstall` script fixes the permission automatically after every install.
- Session ids are stored in `localStorage`; a page reload reattaches to the same shell.
- **Stop / clean:** `make stop` kills the server on `:3001` and Tailscale HTTPS (443). `make clean` prunes `~/.orbit/screenshots` and `uploads` (keeps newest 50 each; leaves auth and sessions alone). Published preview serves (8443+) are dropped when the server exits; the front door (443) is only cleared by `make stop` / `make phone-off`.
- **Agent GUI browsers** (Chrome/Safari tabs an agent opens itself) are not Orbit's process and are not killed by stop/clean or Preview → “Close capture browser”. Prefer `orbit_capture` / headless Playwright for UI checks; session-scoped browser kill is deferred.

## Roadmap (from AGENTS.md)

1. ~~Terminal (xterm.js + node-pty)~~ ✅
2. ~~Claude Code / Codex / Gemini CLI provider integration~~ ✅
3. ~~Session management (persist metadata + history across server restarts)~~ ✅
4. ~~Voice + image input~~ ✅
5. ~~Playwright screenshot validation~~ ✅
6. ~~Mobile UX polish (PWA install, auth, command approval)~~ ✅

All phases from `AGENTS.md` are implemented. Beyond the original spec: Tailscale HTTPS docs ✅, viewport presets + Mac screen capture ✅, MCP server and phone-side approval for the agent's own commands ✅, the Diff half of the Files/Diff tab as **Changes** (status, per-file diff, stage, commit, push) ✅, per-session attention state with a tab badge and notification deep-links ✅. Still open: a Files browser, session timeline, multi-window layout on tablets, tying captures to the session that prompted them.
