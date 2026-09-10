<p align="center">
  <img src="web/public/icon.svg" width="88" alt="Orbit">
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  Your MacBook as a personal AI dev server — driven from your phone.<br>
  A real terminal for Claude Code and Codex CLI, in an installable web app.
</p>

<p align="center">
  <a href="https://github.com/GA-MO/orbit/actions/workflows/ci.yml"><img src="https://github.com/GA-MO/orbit/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/GA-MO/orbit/releases/latest"><img src="https://img.shields.io/github/v/release/GA-MO/orbit?label=release" alt="release"></a>
  <img src="https://img.shields.io/badge/platform-macOS-111" alt="macOS">
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1" alt="Bun">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://ga-mo.github.io/orbit/">Website</a> ·
  <a href="docs/USER-GUIDE.md">User guide</a> ·
  <a href="docs/SETUP.md">Setup</a> ·
  <a href="docs/MCP.md">Agent integration</a> ·
  <a href="docs/TAILSCALE.md">Remote access</a> ·
  <a href="docs/DESIGN-NOTES.md">Design notes</a>
</p>

<p align="center">
  <img src="docs/images/02-terminal.jpg" width="230" alt="The terminal on a phone">
  <img src="docs/images/11-changes.jpg" width="230" alt="Reviewing the agent's diff">
  <img src="docs/images/08-approval.jpg" width="230" alt="Approving a dangerous command">
</p>

## What it is

Coding agents live in a terminal on your Mac. Orbit puts that terminal on
your phone — over your own tailnet, never the public internet — and adds the
things a phone needs to actually drive one: a key bar with Ctrl and arrows,
voice input, a diff you can stage and commit with a thumb, screenshots of the
app under development, and a way for the agent to reach *you* when it stops
and waits.

It is a single-user, local-first tool. The Mac is the source of truth; the
phone is a window onto it. Nothing runs in a cloud.

## Features

- **A real terminal.** xterm.js over a WebSocket to a PTY: colours, cursor
  movement, interactive prompts, Ctrl+C, resize. Sessions outlive the phone
  disconnecting and the server restarting; reconnecting replays the screen.
- **Agents as providers.** Claude Code, Codex CLI or a plain
  shell, started through your login shell so your PATH applies. Ended
  sessions resume as the same conversation; conversations you started at the
  desk show up on the phone too.
- **Words and pictures in.** Voice dictation (Thai and English), a photo
  dropped into the prompt as a path, press-and-hold to copy from the
  terminal, tap a URL to open it in a frame over the session.
- **Review what the agent wrote.** A Changes tab: status, per-file diffs with
  word-level marks, stage a hunk, commit, push.
- **Look at the running app.** Headless captures at phone, tablet and desktop
  sizes; the Mac's own screen; a dev server published over the tailnet as
  https so it opens *inside* the app.
- **The agent's side.** An MCP server (`orbit_capture`, `orbit_screen`,
  `orbit_notify`, `orbit_ask`, `orbit_preview`) and Claude Code hooks that
  forward "waiting for you" moments — and, if you opt in, hold the agent's
  own dangerous commands until you tap Block or Run it on the phone.
- **Know which session wants you.** Per-session attention with a badge, a
  settled-agent detector for agents that cannot say so themselves, Web Push
  that reaches a locked phone, and answer buttons on the notification itself.
- **Installable.** A PWA with an offline shell; add it to the home screen.

## Install

One executable, no runtime to install:

```sh
curl -fsSL https://raw.githubusercontent.com/GA-MO/orbit/main/install.sh | bash
```

Then, on the Mac:

```sh
orbit doctor    # what this Mac has and what it is missing
orbit setup     # wire the hooks and the MCP server into Claude Code
orbit start     # run it, published over your tailnet as https
```

`orbit stop` stops it again: it signals whatever holds the port, insists only
if it has to, and takes the tailnet front door down with it, so nothing is
left proxying to a port with nothing behind it.

`orbit start` prints the tailnet address and a QR code of it. Scan that with
your phone's camera, with Tailscale on, or open the address by hand. That is
the whole setup — nothing to pair, nothing to type, nothing that expires, and
the code never stops working. Tailscale puts a verified `Tailscale-User-Login` on
every request it proxies, and a request carrying your Mac's own login is
served without a token at all. A different login is refused. Add it to the
home screen and it is the same walk-in from there.

That works because the server listens on `127.0.0.1` alone, so `tailscale
serve` is the only way in from another device. If you have no Tailscale —
not installed, not logged in, or HTTPS turned off in its admin console —
`orbit start` says which of those it is, starts the server anyway, and tells
you to re-run it as `orbit start --lan`. That binds every interface again and
prints the Mac's Wi-Fi address, so a phone on the same network can open it.
On that path the login header is ignored entirely and the access token is the
only credential: scan the QR code the banner prints, or type the token beside
it. `orbit pair` prints a fresh code when the one on screen has expired.
Voice input and Add to Home Screen need real https, so Tailscale is still
worth setting up.

**Upgrading from 0.2.x?** The Wi-Fi address stops answering. `orbit start`
now listens on the Mac itself and reaches your phone over Tailscale; pass
`--lan` (or set `ORBIT_LAN=1`) to get the old behaviour back.

Later on, `orbit update` replaces that executable with the latest release —
`orbit update --check` says what is out without touching anything, and `orbit
doctor` mentions a newer release when it sees one. From a checkout it is `git
pull && make setup` instead, and `orbit update` says so rather than
overwriting anything.

**Requirements**

| | |
|---|---|
| macOS | Apple silicon or Intel |
| [Tailscale](https://tailscale.com) | how a phone reaches the Mac at all, and who it says you are — with real https (voice and Add to Home Screen need it). Without it, `orbit start --lan` and the access token |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Codex CLI | whichever you use — Orbit finds what is on your PATH |
| Google Chrome | optional, for captures of the app under development |

The installer takes `ORBIT_VERSION=v0.2.0`, `ORBIT_INSTALL_DIR` and
`ORBIT_NO_MODIFY_PATH`. It verifies the release's checksum and refuses a
download that does not match.

## How it works

```
  phone (PWA)  ──https, tailnet only──▶  orbit  ──bun-pty──▶  zsh -l  ──▶  claude / codex
       ▲                                  │                                       │
       │   notices, questions, push       │◀────── MCP tools + hooks ─────────────┘
       └──────────────────────────────────┘
```

- **Server:** Bun + TypeScript. HTTP, WebSocket, PTY sessions, git, headless
  Chrome, push notifications. One executable with the web app inside it.
- **Web:** React, Vite, xterm.js, Tailwind. Mobile first; the touch handling
  is tested on both Chromium and WebKit.
- **Security:** the server binds `127.0.0.1`, so the only way in from another
  device is `tailscale serve` — which is what makes the login header it adds
  worth trusting, and Tailscale's own documentation names that as the
  condition. A request whose `Tailscale-User-Login` is the Mac's own login is
  let in; a foreign login, or a foreign `Origin`, is not. The bearer token is
  still there for the MCP server, the hooks and `orbit pair` over loopback,
  and it is the only credential under `--lan`, where the header is ignored.
  An `HttpOnly` hashed cookie covers what a header cannot reach (the socket,
  images); nothing in URLs; slow rejection of guesses; commands matching
  dangerous patterns held for approval whether you typed them or the agent
  did. `tailscale serve` is tailnet-only — Orbit never uses `funnel`.

The reasoning behind each piece — what was tried first, which failure each
decision prevents — is in [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).

## From source

Needs [Bun](https://bun.sh) 1.4 or newer.

```sh
git clone https://github.com/GA-MO/orbit && cd orbit
make install    # bun install
make setup      # build, register the MCP server, install the hooks
make start      # run on :7788, published over the tailnet
```

```sh
make dev        # Vite on :5173 with HMR, server on :7788
make dist       # one executable → dist/orbit  (TARGETS=all for arm64 + x64)
make doctor     # the same check the installed binary offers
make stop       # stop the server and the tailnet front door
```

`orbit setup` resolves every path from whatever is running it, so nothing is
copied by hand; it replaces its own hooks rather than adding a second copy,
backs up `~/.claude/settings.json` first, and `make unsetup` takes it all
back out.

## Testing

```sh
make test               # every suite, against a throwaway server
make test-smoke         # API, MCP, hooks (no browser)
make test-touch         # touch behaviour in Chromium (ENGINE=webkit for WebKit)
make test-changes       # the Changes tab in a real browser
make test-install       # the installer, against a stand-in release
```

`scripts/test.sh` builds, starts an Orbit of its own on the first free port
from `:3099` under a scratch `HOME`, runs the suites and takes it down — a
run can neither be coloured by the last one nor reach the `~/.orbit` you use.
`ORBIT_BIN=dist/orbit` runs the suites against the compiled executable.
`tailscale` is a stand-in in the tests (`scripts/fake-tailscale.mjs`).

CI runs the typecheck, the build, `bun audit` and the headless suites on
every push. A tag `v<version>` (`scripts/release.sh 0.2.0`) builds both Mac
executables and publishes them as a release with checksums — see
[Releasing](docs/SETUP.md#releasing) in the setup guide.

## Documentation

- [User guide](docs/USER-GUIDE.md) — every tab, gesture and feature, with screenshots
- [Setup](docs/SETUP.md) — a machine from scratch, what `orbit setup` writes, troubleshooting
- [Agent integration](docs/MCP.md) — the MCP tools and the hooks, from the agent's side
- [Remote access](docs/TAILSCALE.md) — Tailscale, https, running at login, security
- [Design notes](docs/DESIGN-NOTES.md) — why each piece is shaped the way it is
- [Website](https://ga-mo.github.io/orbit/) — the product page

## Status

Everything above is built and tested. Still open: a file browser, a session
timeline, a tablet layout, and tying captures to the session that asked for
them. The original brief is kept in [docs/archive/original-brief.md](docs/archive/original-brief.md).

## License

[MIT](LICENSE).
