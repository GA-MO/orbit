# Setting Up Orbit

This guide is for anyone setting up Orbit on a Mac for the first time, whether from the one-line installer or from a checkout of the repository. It covers what has to be on the machine, what `orbit setup` writes into Claude Code, how to verify the result, and how to take it all back out. For the agent-side tools and hooks in depth, see `MCP.md`; for reaching the Mac from anywhere, see `TAILSCALE.md`.

Orbit is not a shared service. Each person runs their own Orbit on their own Mac and talks to their own agents with their own token. Nothing crosses from one machine to another; the only thing a team shares is this repository.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Wire it into Claude Code](#wire-it-into-claude-code)
- [Verify](#verify)
- [First run](#first-run)
- [What gets installed](#what-gets-installed)
- [Where Orbit keeps its data](#where-orbit-keeps-its-data)
- [Command reference](#command-reference)
- [The approval hook, if you want it](#the-approval-hook-if-you-want-it)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Releasing](#releasing)

## Requirements

Orbit runs on Bun only. Node, npm and npx are not needed anywhere, and the installed executable brings its own runtime.

| Requirement | Why |
| --- | --- |
| macOS (Apple silicon or Intel) | Orbit drives a real PTY and captures the Mac's screen. |
| Claude Code, Codex CLI or Gemini CLI on the login-shell PATH | Orbit finds whichever you use with `zsh -lic`. `orbit setup` calls `claude mcp add`, and the hooks belong to Claude Code. |
| Google Chrome (optional) | Driven headless by `orbit_capture` over the DevTools protocol. No extra browser is downloaded. |
| Tailscale (can come later) | How a phone reaches the Mac at all: the server binds `127.0.0.1`, and `tailscale serve` is the way in from another device — and the thing that tells Orbit the caller is you, so no token is typed. Also where https comes from; voice input and Add to Home Screen require a secure context. Without it, `orbit start --lan` and the access token. See `TAILSCALE.md`. |
| Screen Recording permission (optional) | For the terminal that starts Orbit, if `orbit_screen` should see application windows. See `MCP.md`. |
| Bun 1.4 or newer (developers only) | Only when working from a checkout. Install with `curl -fsSL https://bun.sh/install \| bash` and check with `bun -v`. |

## Install

### For users

One executable, no runtime to install.

```sh
curl -fsSL https://raw.githubusercontent.com/GA-MO/orbit/main/install.sh | bash
```

The installer places a single executable at `~/.orbit/bin/orbit` and adds that directory to `PATH` in `~/.zshrc`. It verifies the release checksum and refuses a download that does not match.

| Variable | Effect |
| --- | --- |
| `ORBIT_VERSION=v0.2.0` | Install a specific release instead of the latest. |
| `ORBIT_INSTALL_DIR` | Install somewhere other than `~/.orbit/bin`. |
| `ORBIT_NO_MODIFY_PATH` | Leave `~/.zshrc` alone. |

Then, on the Mac:

```sh
orbit doctor    # what this Mac has and what it is missing
orbit setup     # wire the hooks and the MCP server into Claude Code
orbit start     # run it, published over your tailnet as https
```

### For developers

Working from a checkout needs Bun 1.4 or newer.

```sh
git clone https://github.com/GA-MO/orbit && cd orbit
make install    # bun install
make setup      # build, then bun server/dist/main.js setup
make start      # run on :7788, published over the tailnet
```

`make setup` and `make start` run the same code as the installed binary. The build step comes first because the MCP server has to exist on disk before it can be registered.

## Wire it into Claude Code

`orbit setup` (or `make setup` from a checkout) does two things and reports what it touched:

1. Registers the MCP server with `claude mcp add -s user orbit -- <orbit> mcp`, where `<orbit>` is the full path of the executable running the command.
2. Writes the Claude Code hooks into `~/.claude/settings.json`.

Every path is resolved from whatever is running `setup`. Nothing is copied or edited by hand. That is the whole reason the command exists: an earlier version of these docs asked you to paste JSON and replace `/Users/<you>/` yourself, and a mistake there produced no error, only features that silently went quiet.

It is safe to run again at any time:

- It removes every Orbit hook before writing the current set back, so running it twice never leaves duplicates. (Duplicate hooks mean two notifications on the phone for one question.)
- Moving the checkout or the binary and running `setup` again is how you repair paths. Do not edit the JSON.
- Hooks that belong to other tools in the same file are left alone.
- `~/.claude/settings.json` is backed up to `~/.claude/settings.json.orbit.bak` before every write.
- If the settings file is not valid JSON, `setup` stops and says why. It never overwrites a broken file.
- Hooks installed by the older scripts (`scripts/orbit-approve.mjs`, `scripts/orbit-notify-hook.mjs`, `scripts/setup.mjs`) are recognized and replaced. Those scripts no longer exist.

## Verify

```sh
orbit doctor
claude mcp list          # expect: orbit: <path to orbit> mcp - ✔ Connected
```

Or type `/mcp` inside Claude Code.

`orbit doctor` checks which version is installed and whether a newer release exists (a Mac with no network gets a neutral line, not a failure), that Claude Code is on the PATH, that Google Chrome is present, that Tailscale is logged in, that an access token exists, that the hooks and the MCP registration are in place, and whether the server is running. It cannot check Screen Recording permission; macOS offers no way to ask.

A Claude Code session that was already open does not see the new server. MCP servers are spawned when a session starts, so open a new one. The same applies every time you change `server/src/mcp.ts` in a checkout: `bun run build`, then start a new session.

## First run

```sh
orbit start      # publish :7788 over the tailnet as https, run the server
```

`orbit start` runs `tailscale serve --bg 7788`, then starts the server, and prints `https://<mac>.<tailnet>.ts.net`. Open that on the phone with the Tailscale VPN on. That is the whole first run: no pairing, no QR to scan, nothing to type, nothing that expires.

It works because the server listens on `127.0.0.1` and nowhere else, which leaves `tailscale serve` as the only way in from another device. `serve` strips any `Tailscale-User-Login` header a caller sent and stamps on the verified one, so a request carrying the Mac's own tailnet login is served with no token at all — reads, writes and the WebSocket. A different login is refused, and so is a Mac whose own login cannot be read (the token is then the only credential).

Add to Home Screen works the same way. The home-screen app has storage of its own, but there is nothing in it to carry over any more, so it simply opens.

### Without Tailscale

If the front door cannot be published — Tailscale is not installed, not logged in, or has HTTPS turned off in the admin console — `orbit start` says which of those it is in one line, notes that voice input and Add to Home Screen need https so Tailscale is worth setting up later, and runs the server anyway. With no front door and nothing listening on the wi-fi, it also tells you to re-run it as:

```sh
orbit start --lan      # or: orbit --lan, or ORBIT_LAN=1 orbit
```

That binds every interface and prints the Mac's wi-fi address, so a phone on the same network can open `http://<mac-ip>:7788`.

On this path the login header is ignored completely and the access token is the only credential. Tailscale strips that header when a caller sets it, but its own documentation is explicit that the guarantee holds only while the program behind the proxy listens on localhost alone — with the wi-fi door open, anyone who can reach the port can write the header themselves. Orbit will not trust the header and the back door at once.

So the login screen, the pairing QR and `orbit pair` belong to `--lan`. The banner prints the QR (`https://…/#pair=<code>`, ten minutes, a handful of uses) and `[orbit] access token: …` beside it for typing by hand; `orbit pair` prints a fresh code. On the home-screen app, tap "Scan QR code" and scan it again, since iOS gives that app storage of its own.

The token is stored in `~/.orbit/config.json`. To rotate it, delete only the `token` key from that file, never the whole file. The same file holds the Web Push keypair, and deleting it silently disconnects every phone from push.

**Upgrading from 0.2.x?** The wi-fi address stops answering until you pass `--lan`. Everything else is unchanged.

From a checkout, `make mobile` serves the dev build on the same Wi-Fi network. Voice input and Add to Home Screen need https, so you will want Tailscale in the end.

To stop:

```sh
orbit stop         # stop the server on its port and remove the tailnet front door
make stop          # from a checkout: the same as `orbit stop`
```

To run the server without publishing it, use plain `orbit`. It listens on `127.0.0.1:7788` — the Mac and nothing else, unless `--lan` — and `ORBIT_PORT` changes the port.

## What gets installed

### MCP tools: the agent sees its own work and can reach you

| Tool | What it does |
| --- | --- |
| `orbit_capture` | Renders a URL headless in the system Chrome and returns the image. |
| `orbit_screen` | Captures the Mac's screen. |
| `orbit_notify` | Sends a line to the phone (kinds `waiting` and `done`). |
| `orbit_ask` | Asks a question with up to four options and blocks until one is tapped or the question times out. |
| `orbit_preview` | Publishes a dev-server port over the tailnet as https (from 8443 upward) and opens it on the phone. |

Details and caveats are in `MCP.md`.

Every tool talks to the Orbit server on `127.0.0.1:7788`, so the server has to be running. If it is not, the tool reports that it cannot connect; the session itself is not affected.

### The notify hook: know when Claude is waiting

Claude Code draws its question boxes only in the terminal. From a phone lying face down on a desk, a session waiting on a question looks exactly like a session that is thinking, and it will wait all night. This hook forwards those moments to the phone.

`orbit setup` installs it as `orbit hook notify` on three events: `PreToolUse` with matcher `AskUserQuestion`, `Notification`, and `Stop`. Notices are sent as `quiet`, meaning they are dropped when that session is on screen on the phone.

### The approve hook: dangerous commands the agent runs itself

`orbit setup` installs `PreToolUse` with matcher `Bash` pointing at `orbit hook approve`, with `"timeout": 190`.

Orbit already screens dangerous commands that you type into the terminal. Commands the agent runs through the Bash tool never pass that gate. This hook closes the gap. When a command matches a dangerous pattern (`rm -rf`, `sudo`, `git push --force`, writes to raw devices, a fork bomb, and others), the phone gets a question with the options Block and Run it, and the agent waits for up to 180 seconds. If Orbit is running and nobody answers, the command is denied. If Orbit is not running, the command is allowed through so that Claude Code keeps working normally.

`"timeout": 190` is the line that must not be forgotten. Claude Code's default cuts a hook off at 60 seconds, shorter than the hook's own wait, and a command cut off that way passes silently before you have had a chance to tap. `orbit setup` always writes it.

If you do not want this hook, it can be removed without affecting the others: delete the group whose matcher is `Bash` from `~/.claude/settings.json`, and do not run `orbit setup` again, because it will put the group back. The proper way to remove it permanently is to add a flag to `orbit setup` in `server/src/setup.ts`.

## Where Orbit keeps its data

Everything lives in `~/.orbit`. `ORBIT_HOME` names the directory that *holds* the `.orbit` directory, not the data directory itself: setting `ORBIT_HOME=/tmp/x` puts the data in `/tmp/x/.orbit`. Unset, it falls back to `HOME`, so the data directory moves without moving `HOME`.

| Path | Contents |
| --- | --- |
| `config.json` | The access token and the VAPID push keypair. Rotate the token by removing only the `token` key. |
| `sessions.json` | Known sessions. |
| `scrollback/` | Terminal scrollback per session. |
| `screenshots/` | Captures, the last 50. |
| `uploads/` | Files sent from the phone, the last 50. |
| `push-subscriptions.json` | Web Push subscriptions. |
| `bin/orbit` | The installed executable. |

## Command reference

### The `orbit` executable

| Command | What it does |
| --- | --- |
| `orbit` | Run the server on `127.0.0.1:7788`. `ORBIT_PORT` changes the port; `--lan` (or `ORBIT_LAN=1`) binds every interface instead. |
| `orbit start` | Publish `:7788` over the tailnet as https (`tailscale serve --bg 7788`), then run the server. If it cannot publish, it says why, suggests `--lan`, and runs the server anyway. Takes no arguments but `--lan`. |
| `orbit stop` | Stop whatever is listening on `:7788` (`ORBIT_PORT` changes the port) — `SIGTERM`, then `SIGKILL` if it is still there — and remove the tailnet front door. Nothing listening is not an error. |
| `orbit setup` | Write the hooks into `~/.claude/settings.json` (backup at `settings.json.orbit.bak`) and register the MCP server. |
| `orbit setup --uninstall` | Remove the hooks and the MCP registration. |
| `orbit doctor` | Report what this Mac has and what it is missing. |
| `orbit update` | Replace the running executable with the latest release, after checking its published checksum. |
| `orbit update --check` | Say which version is installed and which is available, and write nothing. |
| `orbit start --lan` | The same, but bind every interface so a phone on the same wi-fi can reach it. The tailnet login header is ignored in this mode and the access token is the only credential. |
| `orbit pair` | Print a fresh pairing QR code. Only meaningful on the `--lan` path. |
| `orbit mcp` | Run the MCP server on stdio. Claude Code starts this; you do not. |
| `orbit hook approve` | The approval hook. Claude Code runs this. |
| `orbit hook notify` | The notification hook. Claude Code runs this. |
| `orbit version` | Print the version. |
| `orbit help` | Print usage. |

`orbit start` was called `orbit phone` before. The old name still runs, and says it has been renamed.

### Make targets (from a checkout)

| Target | What it does |
| --- | --- |
| `make install` | `bun install`. |
| `make setup` | Build, then `bun server/dist/main.js setup`. |
| `make unsetup` | Remove the hooks and the MCP registration. |
| `make doctor` | The same check the installed binary offers. |
| `make dev` | Vite on `:5173` with HMR and the server on `:7788`. |
| `make start` | Build, then `orbit start`: run on `:7788`, published over the tailnet. |
| `make mobile` | Print the LAN URL and start the dev build for a phone on the same Wi-Fi. |
| `make stop` | Stop the server and the tailnet front door. |
| `make dist` | Build one executable at `dist/orbit`. `TARGETS=all` builds arm64 and x64. |
| `make test` | Every suite against a throwaway server. |
| `make test-smoke`, `test-touch`, `test-changes`, `test-preview-url`, `test-idle`, `test-ask`, `test-setup`, `test-install` | One suite each. |
| `make test-clean` | Reap a server or scratch `HOME` that a killed run left behind. |
| `make shots` | Regenerate `docs/images/*.jpg` by walking the real app on a throwaway server. |
| `make clean` | Prune `~/.orbit/screenshots` and `~/.orbit/uploads` down to the newest 50 each. Leaves `config.json`, sessions, push subscriptions and build output alone. |

## The approval hook, if you want it

By default `orbit setup` installs only the notify hooks. The approval
hook — a `PreToolUse` hook on Bash that holds the agent's dangerous
commands until you tap Block or Run it on the phone — is opt-in:

```sh
orbit setup --approval
```

Running `orbit setup` again without the flag takes it out; `orbit doctor`
says which shape is installed.

## Uninstall

```sh
orbit setup --uninstall    # remove the hooks and the MCP registration
make unsetup               # the same, from a checkout
```

Neither touches the checkout or `~/.orbit`; sessions, the token and screenshots stay. To wipe the data as well, delete `~/.orbit` yourself.

## Troubleshooting

| Symptom | Usual cause |
| --- | --- |
| `/mcp` does not list `orbit` | The session was open before setup ran. Start a new session. |
| A tool answers "not reachable on 127.0.0.1:7788" | The server is not running. Run `orbit start`, plain `orbit`, or `make start` from a checkout. |
| The phone never notifies | Orbit is open on the phone, so notices are quiet by design. Close the app and try again. |
| `orbit_screen` returns an image with no application windows | Screen Recording permission has not been granted. See the last section of `MCP.md`. |
| `orbit setup` cannot register the MCP server | `claude` is not on the PATH. |
| `orbit start` reports that port 7788 is busy | An Orbit is already running. Stop it first with `orbit stop` (`make stop` from a checkout). |
| The phone cannot open the Mac's wi-fi address any more | Expected since the server started binding `127.0.0.1`. Reach it over the tailnet, or run `orbit start --lan`. |
| A login screen appears on the tailnet address | Orbit could not read the Mac's own tailnet login, so it fell back to the token. Check the Tailscale app is logged in (`orbit doctor` says). |

## Testing

```sh
make test           # every suite, on a throwaway server with its own port and HOME
make test-setup     # only the installer wiring
bash scripts/test.sh <suite>    # smoke, touch, changes, preview-url, idle, ask, setup, install, all
```

`scripts/test.sh` builds, starts an Orbit of its own on the first free port from `:3099` under a scratch `HOME`, runs the suites and takes it down. A run never touches `:7788` or the real `~/.orbit`. `ORBIT_BIN=dist/orbit` runs the suites against the compiled executable. If a run is killed part way and leaves a server or scratch directory behind, `make test-clean` reaps it.

The documentation images can be regenerated the same way. `make shots` walks the real app on a throwaway server and rewrites `docs/images/*.jpg`; `bun docs/site/build.mjs` then rebuilds the website from them.

## Releasing

```sh
scripts/release.sh 0.2.0    # set the version in both package.json files, commit, tag v0.2.0, push
```

The tag runs `.github/workflows/release.yml`, which builds the executable for arm64 and x64 and attaches both to a GitHub Release with a `.sha256` file beside each. From then on `install.sh` on any Mac installs that version as the latest.

Homebrew is optional. If the repository variable `TAP_REPO` (`<owner>/homebrew-tap`) and a secret `TAP_TOKEN` that can push to that tap are set, the `tap` job writes `Formula/orbit.rb` from `packaging/homebrew/orbit.rb.tmpl`. Without them, `scripts/tap.sh v0.2.0 ../homebrew-tap` does the same by hand.
