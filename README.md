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
- Sessions survive server restarts as "Ended" entries: history opens read-only in the terminal, ↻ resumes the agent's conversation in that folder (`claude --continue`, `codex resume --last`). Those commands address a folder, not an Orbit session, so ↻ appears only on the most recently ended session of a folder+agent and only while nothing is live there — anywhere else it would either reopen a different conversation than the one tapped, or put a second agent into one already in use, ＋ starts a fresh session with the same provider/folder/name, ✕ forgets (deletes history)
- A session id the phone remembers but the Mac no longer has is reported as gone, rather than silently opening a shell in the home directory under the old id
- Ended sessions capped at 20 (oldest pruned)

**Phase 4 + security + PWA complete:**

- **Auth**: access token generated to `~/.orbit/config.json` and printed in the server console; required for all `/api/*` and WebSocket traffic as `Authorization: Bearer`; login screen on the phone, invalid/expired token drops back to login. A WebSocket handshake and an `<img src>` cannot carry that header, so those two authenticate with an `HttpOnly; SameSite=Strict` cookie minted by `GET /api/auth/check` — it holds a hash of the token rather than the token, and authorises reads and the socket only, never a write. Nothing puts the token in a URL, where it would end up in proxy logs and history
- **Voice input**: 🎤 opens a Web Speech overlay (browser speech recognition, gated on a recogniser *and* a secure context); transcript is editable, then Insert (type only) or Send (type + Enter) into the terminal. Recognition language is a ไทย/EN toggle in the sheet (remembered; dictation matches one language per run, so it cannot be inferred). iOS Safari is the constrained target — recognition is started inside the tap itself (a start one tick later is refused), `continuous` is off there because WebKit ignores it, and each pause ends a run that a **Continue listening** button resumes onto the existing transcript. Refusals from Apple's dictation service (`service-not-allowed`, `not-allowed`, …) are translated into the setting the user has to change; note it never works from a home-screen PWA — that is a WebKit limitation, not a bug here
- **Image input**: 📷 uploads a photo/screenshot to `~/.orbit/uploads/` and inserts its file path into the terminal, ready to reference in an agent prompt
- **PWA**: manifest + icons + service worker (registered in production builds only) — installable to the home screen
- **Production mode**: the Node server serves `web/dist`, so production is a single port: `npm run build && npm start -w server`, open `http://<mac-ip>:3001`

**Phase 5 + command approval complete:**

- **Screenshot validation**: 📸 panel — enter your dev app's URL, capture renders it headless in system Chrome (`playwright-core`, `channel: 'chrome'`, no browser download) at a Phone / Tablet / Desktop viewport (or full page), plus a **Mac screen** source for what Chrome cannot render (simulators, native apps, Xcode); gallery lays every shot out at its real aspect ratio with tap-to-zoom, ⇥ inserts the PNG path into the terminal for the agent to inspect; stored in `~/.orbit/screenshots/` (last 50 kept). Chrome stays warm between captures, and a dev server that is down is reported as an error instead of quietly saving a picture of Chrome's error page. Each capture is labelled with what it was of (`localhost:5173`) and the last four URLs that rendered come back as one-tap chips
- **Command approval**: multi-character input chunks (paste / voice / automation) are screened server-side for dangerous patterns (`rm -rf`, `sudo`, disk writes, force-push, fork bombs, …). Matches are held and a red approval modal shows the exact command — Run anyway or Deny. Hand-typed single keystrokes pass through (they cannot be reconstructed reliably and are the user's own deliberate input).
- Named sessions: optional name at creation, rename via ✎, created-time shown per session; the active session's name is the header title. A session nobody named is labelled with the first line typed into it (command for a shell, opening prompt for an agent) — captured server-side from the input stream, escape sequences and control codes stripped, backspace applied, so three unnamed shells are told apart by what they are doing
- Agent CLIs launch via `zsh -lic 'exec <cmd>'` so the user's real PATH applies; exiting the agent ends the session
- REST API: `GET/POST /api/sessions`, `DELETE /api/sessions/:id`, `GET /api/dirs` (home-restricted directory browsing)

**Phase 7 — the agent's side of the app:**

- **MCP server** (`server/src/mcp.ts`, stdio JSON-RPC, no framework): `orbit_capture` renders a URL and returns the *image* so the agent can look at its own UI work, `orbit_screen` hands it the Mac's screen, `orbit_notify` puts a line on the phone, `orbit_ask` puts a question on the phone and blocks until it is tapped. Register with `claude mcp add -s user orbit -- node <repo>/server/dist/mcp.js`
- **Mac → phone channel**: `POST /api/notify` and `POST /api/ask` broadcast over the existing WebSocket; questions outlive a reconnect (a phone that joins mid-question is caught up) and time out rather than hanging forever
- **Reaching a phone that is asleep**: iOS freezes the page and drops its socket on lock, so a notice sent then reaches nobody at all. Two things cover that gap — the notice is held and replayed to whoever connects next (once, and only if it was never delivered live), and a Web Push wakes the service worker with the app closed. Push fires only when the live channel found nobody, so an open app never gets a banner and a toast for the same event. VAPID keys live in `~/.orbit/config.json`, subscriptions in `~/.orbit/push-subscriptions.json`, and retired endpoints prune themselves. iOS grants notification permission only from a tap inside an installed PWA, hence the opt-in row at the top of Sessions
- **Knowing Claude is waiting**: its own question boxes and permission prompts live in the terminal, which is invisible to a phone in a pocket. `scripts/orbit-notify-hook.mjs` forwards `AskUserQuestion` (with the question and its options), the notifications that mean "waiting for you", and turn-end for sessions started from Orbit. All of it is sent `quiet`: the server drops it while Orbit is open, since a toast repeating what is on screen is noise. Nothing blocks — the hook fires a request and exits
- **Approval for what the agent runs itself**: terminal screening only ever saw what *you* typed — a command from the agent's Bash tool never crosses that boundary. `scripts/orbit-approve.mjs` is a Claude Code `PreToolUse` hook that screens tool calls with the same patterns and routes matches to the phone. Fails open when Orbit is not running, fails closed when it is and nobody answers
- Setup and caveats: [docs/MCP.md](docs/MCP.md)

**Getting things out of the terminal (and into a browser):**

- **Tap a URL and choose what happens to it**: links are found in the buffer cell by cell, so a URL wrapped across two rows is still one link and a trailing comma is not part of it. That includes the rows a *program* wrapped itself (Claude Code writes `\r`, cursor-right two columns, cursor-down): there is no `isWrapped` flag on those, so the join is inferred from a row that ends on a URL character and a next row whose first non-space character is punctuation a URL can continue with — `.html`, `/path`, `?q=1`. A line of prose below a URL starts with a letter and is left alone, because an address that resolves to the wrong page is worse than one that stopped short. Each row's blank padding is dropped before the join, or the space would end the match exactly where the wrap was. Half a URL is worse than none — it opens a real page that is the wrong one. The tap is matched by Orbit itself — xterm resolves a click against whatever the mouse last moved over, and a finger never moves over anything. A tap opens a sheet with **Open here** and **Copy** — and nothing that navigates the app away. Leaving costs the session its screen: iOS drops a backgrounded page, and an installed web app has no second tab to hand a same-origin URL to, so WebKit walks the whole app over to it and the way back is a cold start. **Open here** puts the page in a frame over the terminal, which the session survives; anything that has to leave goes out as text on the clipboard. Plain http inside the https app cannot be framed (mixed content), so that case offers **Copy** alone and says why. The sheet arms its backdrop late, because the click the browser emulates after the tap would otherwise dismiss it before it was seen. A mouse click, which costs nothing, still opens a tab
- **No SPA fallback for paths that miss**: the app has no client-side routes, so only `/` gets `index.html`. `/site` — the tail of a truncated link — answers 404 in words rather than serving the app, which had made a wrong address look like the app bouncing back to the terminal (**needs a server restart to take effect**)
- **`localhost` is rewritten to the host the phone came in on**: `http://localhost:5173` on the Mac is the phone itself on the phone, so the tap goes to `http://<same-host>:5173` instead — the dev server is reachable there because Vite binds every interface. Captures has the same thing as a button next to Capture: a screenshot answers "how does it look", some questions only the running app answers
- **Press and hold to copy**: the terminal draws its own text, so iOS never offers selection handles over it. Holding selects the **word** under the finger — split on whitespace only, because what gets copied out of a terminal is paths, URLs, hashes and flags, and those are ruined by a split on `/` or `-`. Grips at either end adjust it cell by cell (dragging past the end of a row carries on to the next), dragging the initial press grows it from the word, and **Line** in the copy bar takes the whole logical line, wrapped rows included. Blank rows cannot be selected at all — holding on the empty field below the output does nothing, and a drag into it stops at the last row that has text, because a highlight with nothing inside it is a selection you cannot copy and cannot explain. The selection is Orbit's own: the browser follows every touch with an emulated mousedown, and xterm answers that by collapsing whatever was selected to the cell under it
- **A redraw whenever the phone comes back**: what is on screen is the last frame the agent drew, and a full-screen app only draws again when its size changes. The server asks for one on reattach, but an agent busy running a tool can let that pass — and the composer stays missing until something else moves, which is why toggling the key bar appeared to fix it. The client now asks too, on every foregrounding and once the layout has settled after a reconnect, by arriving at the size it already has by way of one row less
- **Publishing a dev server, from the phone**: the reason "Open here" never worked for the thing you most want to open. A dev server is plain http on a port only the Mac can see, and http cannot load inside an https app — so the link sheet could only offer Copy, and following it walks the installed app off its own page. **Share :3000 over https** in Captures hands the port to `tailscale serve`, which gives it an https address on the tailnet (8443 upwards, one per dev server, `tailscale serve` being tailnet-only — never `funnel`). That address frames, so tapping the row opens the app over the terminal with the session still connected behind it. It also reaches dev servers bound to `127.0.0.1` alone — `vite` and `python -m http.server` bind loopback unless told otherwise, and the proxy connects from the Mac itself — and it hands the app under test a secure context, which is the only way to try its own service worker or camera from a phone. The module keeps no state of its own: `tailscale serve status` already knows what is mapped, and a file beside it could only ever disagree. A published port outlives the dev server behind it, so each row says when there is nothing there rather than opening an empty frame — and keeps saying it truthfully, because an agent restarting a dev server is the normal case and the answer was otherwise only as fresh as the moment the tab was opened. What is *published* and what is *running* are two different questions asked at two different rates: the first costs two `tailscale` processes and changes only when someone publishes something, so it is asked on arrival and on waking; the second is a TCP connect to loopback, so it is polled every ten seconds while the tab is actually on screen. Polling them together would have spawned processes all day to watch something that never moves. The mapping Orbit itself is reached through is filtered out of every list and refused by the API — by target port *and* by 443, because a second instance on a spare port does not recognise the first one's by target
- **What the framed page can do besides sit there**: a dev server changes under you, so the frame has **↻** — the page is a different origin, so there is no `contentWindow.location.reload()` to call and re-assigning the same `src` is not reliably a navigation; the iframe is remounted instead, which always fetches. Beside it, **⧉** hands the page to the agent: rendered whole, headless from the Mac, at this phone's width, so it gets everything below the fold. The path lands in the prompt and the frame closes, because the next thing to do is describe it. What it *cannot* carry is the state on screen — a cross-origin frame will not report its scroll position, let alone an open menu, and the shot is the URL fetched again from nothing. The frame briefly carried a second button for that, a picker for the phone's own screenshot, and it earned its place back: side button + volume up already puts the shot in Photos, and the composer's image button already sends it. All the header button saved was closing the frame first, and it cost a slot on a 390px row where nothing on screen could explain the hardware gesture it depended on
- **A capture is taken through the address the phone would use**: a published port is rendered via its tailnet https URL rather than `localhost`, since those are not the same app — secure context, `Secure` cookies, a registered service worker, scheme-dependent redirects. Something that only breaks under https used to photograph perfectly. The file is still labelled with the port, or the gallery would file every shot under one `ts.net:8443` and lose which app it was; each published row also captures straight from its ⧉, with no URL to type
- Checked on both engines by `scripts/touch-smoke.mjs` (`ENGINE=webkit` for the one iOS runs), against a throwaway instance

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
Navigation is a three-tab shell — Terminal / Sessions / Captures — with sheets for
focused flows (new session, voice) and modals only for interrupts (command approval).

## Run

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

Smoke test (captures, previews, the Mac→phone channel, MCP, the approval hook, auth) — against a throwaway instance, never the running one:

```sh
HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node server/dist/index.js &
HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node scripts/smoke.mjs
```

**User guide (Thai, with screenshots)**: [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — a full walkthrough of every feature, captured from a real end-to-end session.

**Using Orbit away from home**: see [docs/TAILSCALE.md](docs/TAILSCALE.md) — WireGuard tunnel to your Mac with real HTTPS (full PWA), no ports exposed to the internet.

## Notes

- npm strips the execute bit from node-pty's prebuilt `spawn-helper`, which causes `posix_spawnp failed` at PTY spawn. The root `postinstall` script fixes the permission automatically after every install.
- Session ids are stored in `localStorage`; a page reload reattaches to the same shell.

## Roadmap (from AGENTS.md)

1. ~~Terminal (xterm.js + node-pty)~~ ✅
2. ~~Claude Code / Codex / Gemini CLI provider integration~~ ✅
3. ~~Session management (persist metadata + history across server restarts)~~ ✅
4. ~~Voice + image input~~ ✅
5. ~~Playwright screenshot validation~~ ✅
6. ~~Mobile UX polish (PWA install, auth, command approval)~~ ✅

All phases from `AGENTS.md` are implemented. Beyond the original spec: Tailscale HTTPS docs ✅, viewport presets + Mac screen capture ✅, MCP server and phone-side approval for the agent's own commands ✅. Still open: Files/Diff tabs, session timeline, multi-window layout on tablets, tying captures to the session that prompted them.
