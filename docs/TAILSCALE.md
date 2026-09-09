# Remote access with Tailscale

This guide is for anyone who wants to open Orbit on a phone from anywhere: on 4G/5G, on a cafe's Wi-Fi, away from the desk. It covers installing Tailscale on the Mac and the phone, publishing Orbit over the tailnet as https, publishing a dev server the same way, running the server at login, and what to check when something does not connect. Nothing here opens a port on your router, sets up dynamic DNS, or exposes anything to the public internet: Tailscale builds a private network (a tailnet) between your own devices over WireGuard, and its personal plan is free.

```
iPhone/Android ──(WireGuard tunnel)── MacBook
   Tailscale app                        Tailscale + Orbit server
```

## Contents

- [1. Install Tailscale on the Mac](#1-install-tailscale-on-the-mac)
- [2. Install Tailscale on the phone](#2-install-tailscale-on-the-phone)
- [3. Enable https for the tailnet](#3-enable-https-for-the-tailnet)
- [4. Publish Orbit with `orbit phone`](#4-publish-orbit-with-orbit-phone)
- [5. Publish a dev server over the tailnet](#5-publish-a-dev-server-over-the-tailnet)
- [6. Run Orbit at login](#6-run-orbit-at-login)
- [7. How access is protected](#7-how-access-is-protected)
- [Troubleshooting](#troubleshooting)

## 1. Install Tailscale on the Mac

Any one of these:

- Download from <https://tailscale.com/download> (recommended)
- `brew install --cask tailscale-app`
- The Mac App Store

Open the app and choose **Log in**. Any Google, Apple, or GitHub account works; the account you pick becomes the owner of the tailnet. Once connected, the Tailscale icon appears in the menu bar.

The `tailscale` command line tool is used throughout this guide. Orbit looks for it on `PATH` first and falls back to `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. The App Store and direct-download installs do not put the CLI on `PATH`, so if `tailscale` is not found in your shell, call it from the bundle:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

## 2. Install Tailscale on the phone

Install **Tailscale** from the App Store or Play Store, log in with the **same account**, and turn the VPN switch on.

The two devices can now see each other. Confirm from the Mac:

```sh
tailscale status        # lists every device with its 100.x.y.z address
```

## 3. Enable https for the tailnet

Orbit works over plain http, but only as a terminal. Everything a phone needs beyond that requires a secure context in the browser: voice input (Web Speech), Add to Home Screen, the service worker behind the offline shell, and Web Push. Over `http://<mac-ip>:3001` on the LAN, or the Vite dev server on `:5173` from `make dev`, none of those register.

`tailscale serve` solves this. It gives the Mac a real https address with a real certificate, reachable only from inside your tailnet. It needs a one-time change in the [Tailscale admin console](https://login.tailscale.com/admin/dns): on the DNS tab, turn on **MagicDNS** and click **Enable HTTPS**. Without both, `tailscale serve` refuses to start.

## 4. Publish Orbit with `orbit phone`

With Orbit installed (see `SETUP.md`; the one-line installer places the executable at `~/.orbit/bin/orbit`), run:

```sh
orbit phone
```

This runs `tailscale serve --bg 3001` and then starts the server. It prints the address, `https://<machine>.<tailnet>.ts.net`, and a pairing QR code. On the phone, with the Tailscale VPN on, point the camera at the code: Orbit opens already paired. Add it to the home screen and scan the code once more from the app's login screen, because iOS gives a home-screen app storage of its own. The token is printed beside the code for typing, and `orbit pair` prints a fresh code when the one on screen has expired.

No port is needed in the address. The terminal's WebSocket runs over `wss://` automatically, and Add to Home Screen produces a full PWA.

The first request can take ten seconds or more while Tailscale obtains the certificate. After that it is as fast as any local page.

If something is already listening on `:3001`, `orbit phone` points the https address at it and returns, leaving that server alone.

From a checkout of the repository, the same commands are:

```sh
make phone        # build, then orbit phone
make phone-off    # take the 443 front door down
make stop         # stop the server on :3001 and the 443 front door
```

### Plain http, without a certificate

Before enabling https, or as a fallback, the server is reachable over the tailnet without `tailscale serve`:

```sh
orbit             # the server alone, on :3001 (ORBIT_PORT to change it)
```

Then open `http://<tailscale-ip-of-the-mac>:3001` (for example `http://100.101.102.103:3001`) or the MagicDNS name, `http://<machine>.<tailnet>.ts.net:3001`, and enter the access token once. You get the terminal, and nothing that needs a secure context.

### Turning the front door off

```sh
orbit phone off   # tailscale serve --https=443 off; the server keeps running
```

The 443 mapping is only cleared by `orbit phone off` or `make stop`. It survives the server exiting, so an address that answers with a connection error usually means the server is down, not Tailscale.

### The `bun run` scripts

The older scripts still exist and call `tailscale` the same way, from `PATH` or the app bundle:

```sh
bun run remote:on         # tailscale serve --bg 3001
bun run remote:status     # tailscale serve status
bun run remote:off        # tailscale serve --https=443 off
```

`orbit phone` is the normal way; these are for scripting or for when you want the proxy without the server.

> **Never use `tailscale funnel` with Orbit.** Funnel publishes a service to the real public internet, whereas `serve` stays inside your tailnet. Orbit can control the entire Mac. Even behind a token, it does not belong out in the open. Orbit itself never calls `funnel`.

## 5. Publish a dev server over the tailnet

A dev server is plain http on a port only the Mac can see. Even where it is reachable, http content cannot be shown inside Orbit's https page (mixed content), so a tapped link would only offer **Copy**, and following it means leaving the app, which on a PWA means losing the session's screen.

The **Preview** tab handles this. Type the dev server's URL into the usual field (`http://localhost:3000`) and press **Share :3000 over https**. Orbit calls `tailscale serve` itself, reserves a port from 8443 upward for each dev server, and shows each one as a row. Tap the row to open it in a frame over the terminal (the session stays connected behind it); tap the ✕ to unpublish. The published address is tailnet-only, and never `funnel`.

Agents can do the same through the `orbit_preview` MCP tool; see `MCP.md`.

Why this beats opening `http://<machine>.<tailnet>.ts.net:3000` directly:

- **The proxy runs on the Mac itself.** A dev server bound to `127.0.0.1` only (a bare `vite`, `python -m http.server`) works as is, with no change to the project's configuration.
- **You get https.** The page opens in the frame, and the app under development gets a secure context of its own, so you can test its service worker, camera access, or PWA install from the phone.

Two limits to know about:

- Orbit never touches the mapping that is its own front door (port 443, or any mapping that points at the server's port). It cannot be closed from the UI or the API, because that would cut the connection you are using.
- Published previews are dropped when the Orbit server exits. The 443 front door is not; see [Turning the front door off](#turning-the-front-door-off).

### "Blocked request. This host is not allowed"

This is the project's own dev server refusing the request, not Orbit or Tailscale failing. Vite (and recent webpack dev servers) check the `Host` header and answer with a block page when the hostname is not one they know. When `tailscale serve` proxies the request in under the tailnet name, that name does not pass. Both the frame and Capture are affected, because both deliberately go through the tailnet address: real https, real secure context, real `Secure` cookies.

Fix it in the project, not in Orbit:

```js
// vite.config.js
export default defineConfig({
  server: {
    host: true,
    // A leading dot matches the host and every subdomain, so this
    // covers any tailnet without naming a machine that may change.
    allowedHosts: ['.ts.net'],
  },
})
```

Restart the dev server for it to take effect. The setting applies to development only; `vite build` never reads it. Orbit's own `web/vite.config.ts` already sets it.

> Next.js 15.2 and later warn when the dev server is reached from an origin other than localhost. Add the tailnet hostname to `allowedDevOrigins` in `next.config.js` if you see it.

### What the frame offers

| Button | What it does |
| --- | --- |
| **↻** | Reloads the page. After the agent has changed the code, see the new version without closing the frame. |
| **⧉** | Renders the **whole page** again, headless, from the Mac. Includes what is below the fold, but carries no state. |
| **🔗** | Copies the URL of the open page. |

**⧉** finishes by inserting the capture's path into the prompt and closing the frame, since the next step is to type what you want changed.

**What ⧉ cannot give you.** The frame is an iframe on a different origin (Orbit on `:443`, the preview on `:8443`), so JavaScript cannot read anything inside it: not the scroll position, not the DOM, not the pixels. All ⧉ can do is send the URL to be rendered again from scratch. The state you are actually looking at (the scroll position, a modal left open, a form half filled in, real WebKit instead of Chrome) is captured only by the phone's own screenshot: press the side button and volume up while the frame is open, close the frame, and send the image with the picture button in the prompt field as usual.

### Captures go through the published https address

Once a port is shared, pressing Capture renders it through the tailnet https address rather than `localhost`. The two are not the same app: secure context, `Secure` cookies, a service worker that can register, redirects tied to the scheme. Apps that break only on https used to capture perfectly. The file name keeps the original port (`localhost:3000`); otherwise every entry in the gallery would read `ts.net:8443` and nothing would tell the apps apart. Each published row has a camera button of its own, so a capture is one tap.

### From the command line

For when the Orbit server is not running, the `bun run` scripts publish a single port on 8443:

```sh
PREVIEW_PORT=3000 bun run preview:on    # → https://<machine>.<tailnet>.ts.net:8443
bun run preview:off
```

`PREVIEW_PORT` defaults to 5173, the Vite dev server.

## 6. Run Orbit at login

Optional. Create `~/Library/LaunchAgents/com.orbit.server.plist`, replacing `YOUR_USER` with your account name:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.orbit.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOUR_USER/.orbit/bin/orbit</string>
    <string>phone</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/orbit-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/orbit-server.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.orbit.server.plist
tail -f /tmp/orbit-server.log      # the address, the token and the pairing QR are printed here
```

A server started by launchd has a minimal `PATH` and no `ORBIT_HOME`, which is why the plist names the installed executable by its full path rather than `orbit`. The agents are unaffected: Orbit starts them through your login shell, which rebuilds whatever `PATH` they need. Drop the `phone` argument to run the server without the https front door.

## 7. How access is protected

| Mechanism | What it does |
| --- | --- |
| Bearer token | Every request carries the token in the `Authorization` header. It is entered once per origin and stored by the app. |
| Cookie | An `HttpOnly`, `SameSite=Strict` cookie, marked `Secure` over https, holds a hash of the token. It is used only where a header cannot go: the WebSocket and images. |
| Origin check | The WebSocket handshake also checks the `Origin` header against the `Host`. |
| Nothing in URLs | The token never appears in a URL. The pairing QR carries a pairing code in the URL fragment, valid for 10 minutes, never the token itself. |
| Slow rejection | Failed guesses are slowed down. |
| Tailnet only | `tailscale serve` is reachable from your own devices only. Orbit never uses `funnel`. |

The reasoning behind these choices is in `DESIGN-NOTES.md`.

### Rotating the token

Remove only the `token` key from `~/.orbit/config.json`, then restart the server. A new token is printed in the console. Do not delete the whole file: it also holds the Web Push keypair, and losing that silently unsubscribes every phone.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `orbit phone` says `not logged in` | Open the Tailscale app on the Mac and log in. `tailscale status` should list your devices. |
| `orbit phone` says `HTTPS must be enabled` | Turn on **Enable HTTPS** (and MagicDNS) on the DNS tab of the admin console, then run it again. |
| The `.ts.net` name is unknown on the phone | MagicDNS is off, or the phone's VPN is not connected. Turn on MagicDNS in the admin console and check the Tailscale switch on the phone. Until then the `100.x.y.z` address still works. |
| The phone cannot reach the Mac at all | The Tailscale VPN switch must be on in the app on both devices. From the Mac, `tailscale ping <phone-ip>`. |
| The first https request hangs for a long time | Tailscale is issuing the certificate. Wait ten to twenty seconds and reload; later requests are fast. |
| The page loads but the terminal does not connect | The WebSocket is blocked. With `serve` in use, open the `https://` address, not `http://…:3001`; do not mix the two. |
| The login screen appears even though the token was entered | The token is stored per origin. `http://100.x…:3001` and `https://….ts.net` are different origins; enter it once more. |
| `Port 3001 already in use` | Another Orbit (or something else) is listening. `orbit phone` points the https address at it and exits. Run `make stop` to stop the server on `:3001` and the front door, or set `ORBIT_PORT` to run on another port. |
| The connection drops when the Mac sleeps | In System Settings, keep the Mac on power and turn off "Put hard disks to sleep", or use `caffeinate` or Amphetamine. |
| `orbit_screen` returns a black or empty image | macOS needs Screen Recording permission for the process running Orbit. Grant it in System Settings > Privacy & Security > Screen Recording. |
| The access token needs to change | See [Rotating the token](#rotating-the-token). |
