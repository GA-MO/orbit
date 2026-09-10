# Setting Up Orbit

This guide is for anyone setting up Orbit on a Mac for the first time, whether from the one-line installer or from a checkout of the repository. It covers what has to be on the machine, what `orbit setup` writes into Claude Code, how to verify the result, and how to take it all back out. For the agent-side tools and hooks in depth, see `MCP.md`; for reaching the Mac from anywhere, see `TAILSCALE.md`.

Orbit is not a shared service. Each person runs their own Orbit on their own Mac and talks to their own agents with their own token. Nothing crosses from one machine to another; the only thing a team shares is this repository.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Wire it into Claude Code](#wire-it-into-claude-code)
- [Verify](#verify)
- [First run and pairing](#first-run-and-pairing)
- [What gets installed](#what-gets-installed)
- [Where Orbit keeps its data](#where-orbit-keeps-its-data)
- [Command reference](#command-reference)
- [Without the approval hook](#without-the-approval-hook)
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
| Google Chrome (optional) | Used by `orbit_capture` through `playwright-core`. No extra browser is downloaded. |
| Tailscale (can come later) | Needed to use Orbit away from the Mac, and for https. Voice input and Add to Home Screen require a secure context. See `TAILSCALE.md`. |
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
orbit phone     # run it, published over your tailnet as https
```

### For developers

Working from a checkout needs Bun 1.4 or newer.

```sh
git clone https://github.com/GA-MO/orbit && cd orbit
make install    # bun install
make setup      # build, then bun server/dist/main.js setup
make phone      # run on :3001, published over the tailnet
```

`make setup` and `make phone` run the same code as the installed binary. The build step comes first because the MCP server has to exist on disk before it can be registered.

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

`orbit doctor` checks that Claude Code is on the PATH, that Google Chrome is present, that Tailscale is logged in, that an access token exists, that the hooks and the MCP registration are in place, and whether the server is running. It cannot check Screen Recording permission; macOS offers no way to ask.

A Claude Code session that was already open does not see the new server. MCP servers are spawned when a session starts, so open a new one. The same applies every time you change `server/src/mcp.ts` in a checkout: `bun run build`, then start a new session.

## First run and pairing

```sh
orbit phone      # publish :3001 over the tailnet as https, print a QR code, run the server
```

`orbit phone` runs `tailscale serve --bg 3001`, prints a QR code, and then starts the server. The QR code encodes `https://<mac>.<tailnet>.ts.net/#pair=<code>`. Point the phone's camera at it and Orbit opens already paired. The code lives for 10 minutes and is good for a handful of uses; `orbit pair` prints a fresh one.

Next to the QR code the console prints `[orbit] access token: …` for typing the token by hand.

To install Orbit on the phone, use Add to Home Screen, open the home-screen app, tap "Scan QR code", and scan the same code again. iOS gives a home-screen app storage of its own, so the pairing from the browser does not carry over.

The token is stored in `~/.orbit/config.json`. To rotate it, delete only the `token` key from that file, never the whole file. The same file holds the Web Push keypair, and deleting it silently disconnects every phone from push.

Without Tailscale, `make mobile` from a checkout serves the dev build on the same Wi-Fi network. Voice input and Add to Home Screen need https, so you will want Tailscale in the end.

To stop:

```sh
orbit phone off    # remove the tailnet front door
make stop          # from a checkout: stop the server and the front door
```

To run the server without publishing it, use plain `orbit`. It listens on `:3001`; set `ORBIT_PORT` to change that.

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

Every tool talks to the Orbit server on `127.0.0.1:3001`, so the server has to be running. If it is not, the tool reports that it cannot connect; the session itself is not affected.

### The notify hook: know when Claude is waiting

Claude Code draws its question boxes only in the terminal. From a phone lying face down on a desk, a session waiting on a question looks exactly like a session that is thinking, and it will wait all night. This hook forwards those moments to the phone.

`orbit setup` installs it as `orbit hook notify` on three events: `PreToolUse` with matcher `AskUserQuestion`, `Notification`, and `Stop`. Notices are sent as `quiet`, meaning they are dropped when that session is on screen on the phone.

### The approve hook: dangerous commands the agent runs itself

`orbit setup` installs `PreToolUse` with matcher `Bash` pointing at `orbit hook approve`, with `"timeout": 190`.

Orbit already screens dangerous commands that you type into the terminal. Commands the agent runs through the Bash tool never pass that gate. This hook closes the gap. When a command matches a dangerous pattern (`rm -rf`, `sudo`, `git push --force`, writes to raw devices, a fork bomb, and others), the phone gets a question with the options Block and Run it, and the agent waits for up to 180 seconds. If Orbit is running and nobody answers, the command is denied. If Orbit is not running, the command is allowed through so that Claude Code keeps working normally.

`"timeout": 190` is the line that must not be forgotten. Claude Code's default cuts a hook off at 60 seconds, shorter than the hook's own wait, and a command cut off that way passes silently before you have had a chance to tap. `orbit setup` always writes it.

If you do not want this hook, it can be removed without affecting the others: delete the group whose matcher is `Bash` from `~/.claude/settings.json`, and do not run `orbit setup` again, because it will put the group back. The proper way to remove it permanently is to add a flag to `orbit setup` in `server/src/setup.ts`.

## Where Orbit keeps its data

Everything lives in `~/.orbit`. Set `ORBIT_HOME` to move that directory without moving `HOME`.

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
| `orbit` | Run the server on `:3001`. `ORBIT_PORT` changes the port. |
| `orbit phone` | Publish `:3001` over the tailnet as https (`tailscale serve --bg 3001`), print a pairing QR code, then run the server. |
| `orbit phone off` | Remove the tailnet front door. |
| `orbit setup` | Write the hooks into `~/.claude/settings.json` (backup at `settings.json.orbit.bak`) and register the MCP server. |
| `orbit setup --uninstall` | Remove the hooks and the MCP registration. |
| `orbit doctor` | Report what this Mac has and what it is missing. |
| `orbit pair` | Print a fresh pairing QR code. |
| `orbit mcp` | Run the MCP server on stdio. Claude Code starts this; you do not. |
| `orbit hook approve` | The approval hook. Claude Code runs this. |
| `orbit hook notify` | The notification hook. Claude Code runs this. |
| `orbit version` | Print the version. |
| `orbit help` | Print usage. |

### Make targets (from a checkout)

| Target | What it does |
| --- | --- |
| `make install` | `bun install`. |
| `make setup` | Build, then `bun server/dist/main.js setup`. |
| `make unsetup` | Remove the hooks and the MCP registration. |
| `make doctor` | The same check the installed binary offers. |
| `make dev` | Vite on `:5173` with HMR and the server on `:3001`. |
| `make start` | Build and run production on `:3001` without Tailscale. |
| `make phone` | Build, then run on `:3001` published over the tailnet. |
| `make phone-off` | Remove the tailnet front door. |
| `make mobile` | Print the LAN URL and start the dev build for a phone on the same Wi-Fi. |
| `make stop` | Stop the server and the tailnet front door. |
| `make dist` | Build one executable at `dist/orbit`. `TARGETS=all` builds arm64 and x64. |
| `make test` | Every suite against a throwaway server. |
| `make test-smoke`, `test-touch`, `test-changes`, `test-preview-url`, `test-idle`, `test-ask`, `test-setup`, `test-install` | One suite each. |
| `make test-clean` | Reap a server or scratch `HOME` that a killed run left behind. |
| `make shots` | Regenerate `docs/images/*.jpg` by walking the real app on a throwaway server. |
| `make clean` | Remove build output. |

## Without the approval hook

The Bash hook stops the agent and waits for a tap on the phone. On a Mac
where Claude Code runs in auto mode that is an interruption rather than a
safeguard. Install only the notify hooks instead:

```sh
orbit setup --no-approval
```

Running `orbit setup` again without the flag adds the approval hook back;
`orbit doctor` says which of the two is installed.

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
| A tool answers "not reachable on 127.0.0.1:3001" | The server is not running. Run `orbit phone`, `orbit`, or `make phone` / `make start` from a checkout. |
| The phone never notifies | Orbit is open on the phone, so notices are quiet by design. Close the app and try again. |
| `orbit_screen` returns an image with no application windows | Screen Recording permission has not been granted. See the last section of `MCP.md`. |
| `orbit setup` cannot register the MCP server | `claude` is not on the PATH. |
| `orbit phone` reports that port 3001 is busy | An Orbit is already running. Stop it first (`make stop` from a checkout). |

## Testing

```sh
make test           # every suite, on a throwaway server with its own port and HOME
make test-setup     # only the installer wiring
bash scripts/test.sh <suite>    # smoke, touch, changes, preview-url, idle, ask, setup, install, all
```

`scripts/test.sh` builds, starts an Orbit of its own on the first free port from `:3099` under a scratch `HOME`, runs the suites and takes it down. A run never touches `:3001` or the real `~/.orbit`. `ORBIT_BIN=dist/orbit` runs the suites against the compiled executable. If a run is killed part way and leaves a server or scratch directory behind, `make test-clean` reaps it.

The documentation images can be regenerated the same way. `make shots` walks the real app on a throwaway server and rewrites `docs/images/*.jpg`; `bun docs/site/build.mjs` then rebuilds the website from them.

## Releasing

```sh
scripts/release.sh 0.2.0    # set the version in both package.json files, commit, tag v0.2.0, push
```

The tag runs `.github/workflows/release.yml`, which builds the executable for arm64 and x64 and attaches both to a GitHub Release with a `.sha256` file beside each. From then on `install.sh` on any Mac installs that version as the latest.

Homebrew is optional. If the repository variable `TAP_REPO` (`<owner>/homebrew-tap`) and a secret `TAP_TOKEN` that can push to that tap are set, the `tap` job writes `Formula/orbit.rb` from `packaging/homebrew/orbit.rb.tmpl`. Without them, `scripts/tap.sh v0.2.0 ../homebrew-tap` does the same by hand.
