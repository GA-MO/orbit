# Agent Integration

This page is for anyone who wants the coding agent inside an Orbit session to see its own work and to reach the person holding the phone. Normally Orbit is the phone driving the Mac: you tap capture, you paste a path for the agent. This is the other direction. Through the MCP server that ships with Orbit, the agent can render the app it is building, look at the Mac's screen, send a notice, ask a question and wait for the answer, or open a live preview on the phone. Two Claude Code hooks complete the picture by forwarding "waiting for you" moments and by routing the agent's own dangerous commands to the phone for approval. Installation from scratch is covered in `SETUP.md`.

## Contents

- [The tools](#the-tools)
- [Install](#install)
- [Try it](#try-it)
- [orbit_preview: the real thing, not a picture](#orbit_preview-the-real-thing-not-a-picture)
- [The notify hook: when Claude is waiting](#the-notify-hook-when-claude-is-waiting)
- [The approve hook: dangerous commands](#the-approve-hook-dangerous-commands)
- [Session identity and the HTTP API](#session-identity-and-the-http-api)
- [Good to know](#good-to-know)
- [Screen Recording for orbit_screen](#screen-recording-for-orbit_screen)

## The tools

| Tool | What it does |
| --- | --- |
| `orbit_capture` | Renders a URL headless in the system Chrome and returns the image itself, not a path. The same image appears in the Preview tab on the phone. |
| `orbit_screen` | Captures the Mac's real screen: the Simulator, Xcode, native apps, anything headless Chrome cannot see. |
| `orbit_notify` | Sends a short line to the phone, such as "done". Pass `kind: "waiting"` when the agent has stopped and needs an answer: the notice stays attached to that session until someone reads it, and the session counts as one that wants attention. Without it the kind is `done`, which only informs. |
| `orbit_ask` | Puts a question with up to four options on the phone and blocks until one is tapped or the question times out. |
| `orbit_preview` | Opens the running app itself on the phone, at the page you name. Not a picture: it can be tapped, scrolled and filled in, in a frame over the terminal, without leaving the session. |

Every tool talks to the Orbit server on port 3001 using the token in `~/.orbit/config.json`. The server has to be running; otherwise the tool reports that it cannot connect, and the session carries on.

## Install

```sh
orbit setup                    # installed binary
make install && make setup     # from a checkout
```

Setting up a machine from scratch, from the requirements to the first run, is in `SETUP.md`.

`orbit setup` registers the MCP server and installs every hook described on this page. Every path is resolved from whatever is running the command; nothing is replaced by hand. From a checkout, `make setup` builds first and then runs the same code.

It is safe to run again. It removes every Orbit hook before writing the current set back, so running it twice never leaves duplicates, and moving the checkout or the binary and running it again is how you repair paths. Hooks belonging to other tools in `~/.claude/settings.json` are not touched, and the file is backed up to `settings.json.orbit.bak` before every write.

Check the result with `claude mcp list` or by typing `/mcp` inside Claude Code. A session that was already open has to be restarted, because the MCP server is spawned when a session starts.

To remove it: `orbit setup --uninstall`, or `make unsetup` from a checkout. Neither touches the checkout or `~/.orbit`.

The registration uses `claude mcp add -s user orbit -- <orbit> mcp`. The `-s user` scope makes the server available in every project, not only inside this repository, because the agent may well be running in some other directory (for example a session opened in `orbit-demo`).

## Try it

```
capture http://localhost:5173 at desktop size and tell me where the layout breaks
```

The agent calls `orbit_capture` on its own and sees the image; you see the same image in the Preview tab.

## orbit_preview: the real thing, not a picture

`orbit_capture` answers the question of whether the agent can see its own work. `orbit_preview` answers a different one: the person holding the phone gets the real app, to tap, scroll and fill in. A still image cannot stand in for that.

```
orbit_preview({ port: 5173, path: "/orders?status=open" })
```

Orbit publishes that port over the tailnet with `tailscale serve`, as https on a public port from 8443 upward, and tells the phone to open it in a frame over the terminal. The session is not lost; closing the frame returns to where you were.

`path` is the reason this tool exists. A plain published preview always lands on `/`, while the page that was just changed sits deeper in, and asking someone to type a path on a touch keyboard is the very problem the port chip in the Preview tab was made to avoid. The phone has no field for typing a path and will not get one; the path comes from the agent, and only from the agent.

### Before you use it

- Something has to be answering HTTP on that port already. Otherwise the request is refused before `tailscale serve` is touched at all. This keeps `orbit_preview(5432)` from putting Postgres on the tailnet because of a typo; the message the agent gets back says to start the dev server first.
- `path` must be a real path, not a full URL, and it must stay on our own host. `//evil.com/x` is refused.
- With no phone connected, nothing opens. A frame cannot be shown after the fact. What remains is a notice with the port and the path, so it can be opened later from the Preview tab, and the tool tells the agent plainly that nobody saw it.
- The mapping disappears on its own when Orbit stops. While it exists it is visible only inside your tailnet. To unpublish earlier, use the Preview tab or `DELETE /api/previews/<public port>`. Note that the argument is the public port (for example 8443), not the local one. Passing the local port yields `nothing is published on …` even though `GET /api/previews` still lists it.

### It does not have to be an app

The tool does not care what is on the other end as long as it answers HTTP. A static server that renders `docs/*.md` as web pages can be sent to the phone to read. PDF files open inside the frame as well, tested on iOS on September 9, 2026 with a plain `<iframe>` and no pdf.js. Documents, reports, charts: anything that can be served as a web page can be sent over.

## The notify hook: when Claude is waiting

Claude Code's question boxes (`AskUserQuestion`), permission prompts and waits for input are drawn only in the terminal. From a phone lying face down on the desk, a question with four options looks exactly like a session that is thinking, and it will wait all night. This hook forwards those moments to Orbit.

`orbit setup` installs it, so there is no JSON to edit. The hook is `orbit hook notify`, attached to `PreToolUse` with matcher `AskUserQuestion`, to `Notification`, and to `Stop`. This section only explains what it does.

| Event | What is sent |
| --- | --- |
| `AskUserQuestion` | The actual question and its options, for example "Claude is asking: keep the current schema? Keep / Rewrite". |
| `Notification` of a waiting type (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `elicitation_dialog`) | "Claude is waiting for you". Other types, such as `auth_success`, are not sent. |
| `Stop` | "Finished: …", only for sessions started from Orbit (recognized by the `ORBIT_SESSION=1` the PTY sets). If you are sitting at the Mac you can already see it. |

Every notice is sent as `quiet`. When that session is on screen on the phone, nothing is shown, because you are already looking at the terminal. You are notified only when you are not looking: a toast when you come back, or a push when the phone is locked.

This hook never blocks. It fires and returns at once, and if it cannot reach Orbit it goes quiet. The approve hook below is different: it stops the agent and waits.

## The approve hook: dangerous commands

Orbit already screens dangerous commands that you type or paste into the terminal. Commands the agent runs itself through the Bash tool never pass that gate, because they run inside the agent's process and are never typed into the PTY. This hook closes the gap with the same pattern list: `rm -rf`, `sudo`, `mkfs` and `diskutil erase`, `dd` to `/dev`, `shutdown` and `reboot`, `git push --force`, a fork bomb, `chmod 777 /`, writes to raw devices, `launchctl unload`.

This one is opt-in: `orbit setup --approval` installs it as `PreToolUse` with matcher `Bash` pointing at `orbit hook approve`, with `"timeout": 190`. A plain `orbit setup` installs only the notify hooks, because a gate that stops the agent to wait for a tap is an interruption on any Mac where Claude Code runs in auto mode.

The `timeout` is the main reason not to copy the JSON by hand. The hook waits up to 180 seconds for the phone, but Claude Code's default cuts a hook off at 60 seconds. With the timeout shorter than the wait, a dangerous command passes silently before you have had a chance to tap.

Behavior:

| Situation | Result |
| --- | --- |
| Ordinary command | Silent. Claude Code's normal permission system applies. |
| Dangerous command | A question on the phone with the options Block and Run it. The agent stops and waits for up to 180 seconds. |
| Block is tapped | The command is denied and the reason goes back to the agent. Block is the prominent button; the first option is always the safe one. |
| Nobody answers while Orbit is running | Denied (fails closed). When no phone is connected and no push subscription exists, the server answers within about 5 seconds instead of waiting out the full timeout. |
| Orbit is not running, or returns an error | Allowed through (fails open), so that Claude Code keeps working normally. |

## Session identity and the HTTP API

Sessions that Orbit starts carry `ORBIT_SESSION=1` and `ORBIT_SESSION_ID` in the PTY environment. The tools and hooks use them to attach notices and questions to the right session.

The hooks and the MCP server talk to the server over a small HTTP API, which is also available to anything else on the Mac:

| Route | Purpose |
| --- | --- |
| `POST /api/notify` | Send a notice to the phone. |
| `POST /api/ask` | Ask a question and wait. Returns `answer`, `timedOut` and `phonesConnected`. |
| `POST /api/ask/answer` | Answer a question from a push notification. Uses a capability carried by the notification; together with `POST /api/auth/pair` it is the only route that needs no bearer token. |

Every other `/api/*` route needs `Authorization: Bearer <token>`.

## Good to know

- `orbit_ask` has a timer, 120 seconds by default. When it runs out the agent is told that nobody answered, and is told not to read that as approval.
- Images wider than 1568 px are scaled down before they reach the agent. The file on disk keeps its full size.
- A question that is still open is sent again to a phone that has just connected. Lock the phone and unlock it later, and the question is still there.

## Screen Recording for orbit_screen

macOS has to grant permission before application windows appear in a capture, and the trap is that without permission there is no error. You get an image of the desktop and the menu bar with no windows on it at all.

If the capture has no application windows: System Settings, Privacy & Security, Screen & System Audio Recording, and enable the application that runs the Orbit server (Terminal, iTerm, VS Code, whichever you started `orbit` from). Then restart that application. `orbit doctor` cannot check this permission for you.

When it works, it sees everything on the screen. The first test capture included a terminal with Orbit's access token still printed on it, and that image went into the agent's context and into the gallery on the phone. Close or minimize anything you do not want seen before asking for `orbit_screen`.
