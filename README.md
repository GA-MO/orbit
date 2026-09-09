# Orbit

Local AI coding hub — turn your MacBook into a personal AI development server you control from your phone's browser. `AGENTS.md` is the original brief this was built from; the design as it stands is in [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).

## What it does

Everything below is in and tested; the reasoning behind each piece — the
failure it prevents, what was tried first — is in
[docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).

- **A real terminal on the phone.** xterm.js over a WebSocket to node-pty: colours, cursor movement, interactive prompts, Ctrl+C, resize, scrollback. Sessions survive the phone disconnecting and the server restarting; reconnecting replays the screen.
- **Agents as providers.** Claude Code, Codex CLI, Gemini CLI or a plain shell, launched through the login shell so the real PATH applies. Ended sessions can be resumed as the same conversation, and conversations started at the Mac's own terminal appear on the phone too.
- **Getting words and pictures in.** Voice input (Web Speech, Thai/English), photo upload with the path dropped into the prompt, press-and-hold to copy out of the terminal, tap a URL to open it in a frame over the session.
- **Reviewing what the agent wrote.** A Changes tab: status, per-file diff with word-level marks, stage a hunk, commit, push — all through porcelain git with argument arrays, never a shell.
- **Looking at the running app.** Headless captures of any URL at phone/tablet/desktop sizes, the Mac's own screen, and a dev server published over the tailnet as https so it can be framed inside the app.
- **The agent's side.** An MCP server (`orbit_capture`, `orbit_screen`, `orbit_notify`, `orbit_ask`, `orbit_preview`) and Claude Code hooks that forward "waiting for you" moments and route the agent's own dangerous commands to the phone for approval.
- **Knowing which session wants you.** Per-session attention with a tab badge, a settled-agent detector for agents that cannot say so themselves, Web Push that wakes a locked phone, and answer buttons on the notification itself.
- **Auth.** A bearer token for everything, an HttpOnly hashed cookie only for what a header cannot carry (the socket, images), nothing in URLs, slow rejection of guesses.

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

On first launch the server prints `[orbit] access token: …` — enter that on the login screen (stored in `~/.orbit/config.json`; to rotate it, remove the `token` key from that file rather than the file itself — the same file holds the push keypair, and losing that silently unsubscribes every phone).

## Testing

```sh
make test             # every suite
make test-smoke       # API / MCP / hooks only (no browser)
make test-touch       # touch behaviour only (needs system Chrome)
make test-setup       # wiring a checkout into Claude Code (no server needed)
make test-changes     # the Changes tab only (needs system Chrome)
make test-preview-url # how an agent's path becomes a URL (no server)
make test-idle        # noticing a session went quiet (no server)
make test-ask         # answering from a notification (no server)
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the build, `npm audit` and
the suites that need neither Chrome nor the Claude CLI.

Screenshots and the product page are generated, not hand-taken:

```sh
make shots            # retake docs/images from the current UI
node docs/site/build.mjs   # rebuild docs/site/index.html from those images
```

`scripts/test.sh` builds, starts an Orbit of its own on the first free port from `:3099` under a scratch `HOME`, runs the suites and takes it down again — so a run can neither be coloured by the last one nor reach the `~/.orbit` you actually use, and the server on `:3001` is never touched.

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

## Roadmap

The phases of the original brief (`AGENTS.md`):

1. ~~Terminal (xterm.js + node-pty)~~ ✅
2. ~~Claude Code / Codex / Gemini CLI provider integration~~ ✅
3. ~~Session management (persist metadata + history across server restarts)~~ ✅
4. ~~Voice + image input~~ ✅
5. ~~Playwright screenshot validation~~ ✅
6. ~~Mobile UX polish (PWA install, auth, command approval)~~ ✅

All phases from `AGENTS.md` are implemented. Beyond the original spec: Tailscale HTTPS docs ✅, viewport presets + Mac screen capture ✅, MCP server and phone-side approval for the agent's own commands ✅, the Diff half of the Files/Diff tab as **Changes** (status, per-file diff, stage, commit, push) ✅, per-session attention state with a tab badge and notification deep-links ✅. Still open: a Files browser, session timeline, multi-window layout on tablets, tying captures to the session that prompted them.
