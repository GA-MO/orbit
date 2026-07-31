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
- Sessions survive server restarts as "Ended" entries: history opens read-only in the terminal, ↻ relaunches with the same provider/folder/name, ✕ forgets (deletes history)
- Ended sessions capped at 20 (oldest pruned)

**Phase 4 + security + PWA complete:**

- **Auth**: access token generated to `~/.orbit/config.json` and printed in the server console; required for all `/api/*` and WebSocket traffic (`Authorization: Bearer` / `?token=`); login screen on the phone, invalid/expired token drops back to login
- **Voice input**: 🎤 opens a Web Speech overlay (browser speech recognition, feature-detected); transcript is editable, then Insert (type only) or Send (type + Enter) into the terminal
- **Image input**: 📷 uploads a photo/screenshot to `~/.orbit/uploads/` and inserts its file path into the terminal, ready to reference in an agent prompt
- **PWA**: manifest + icons + service worker (registered in production builds only) — installable to the home screen
- **Production mode**: the Node server serves `web/dist`, so production is a single port: `npm run build && npm start -w server`, open `http://<mac-ip>:3001`

**Phase 5 + command approval complete:**

- **Screenshot validation**: 📸 panel — enter your dev app's URL, capture renders it headless in system Chrome (`playwright-core`, `channel: 'chrome'`, no browser download) at iPhone viewport (or full page), gallery with tap-to-zoom, ⇥ inserts the PNG path into the terminal for the agent to inspect; stored in `~/.orbit/screenshots/` (last 50 kept)
- **Command approval**: multi-character input chunks (paste / voice / automation) are screened server-side for dangerous patterns (`rm -rf`, `sudo`, disk writes, force-push, fork bombs, …). Matches are held and a red approval modal shows the exact command — Run anyway or Deny. Hand-typed single keystrokes pass through (they cannot be reconstructed reliably and are the user's own deliberate input).
- Named sessions: optional name at creation, rename via ✎, created-time shown per session; the active session's name is the header title
- Agent CLIs launch via `zsh -lic 'exec <cmd>'` so the user's real PATH applies; exiting the agent ends the session
- REST API: `GET/POST /api/sessions`, `DELETE /api/sessions/:id`, `GET /api/dirs` (home-restricted directory browsing)

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

Then open `http://<mac-ip>:3001` from your phone and add it to the home screen.

On first launch the server prints `[orbit] access token: …` — enter that on the login screen (stored in `~/.orbit/config.json`; delete the file to rotate it).

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

All phases from `AGENTS.md` are implemented. Ideas beyond the original spec: Files/Diff tabs, session timeline, Tailscale HTTPS docs, multi-window layout on tablets.
