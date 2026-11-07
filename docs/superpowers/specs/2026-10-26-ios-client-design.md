# iOS client: devices, pairing and the phone app

Approved 2026-10-26. The phone has no brains of its own: it connects to an existing hub. The iOS app lives in its own
repository (`piomio-ios`); this repository gets the hub side: devices, pairing, the device API.

## Decisions

| Question | Choice |
|---|---|
| Reach | Home Wi-Fi, and Tailscale outside home. No relay. |
| Push | Not in v1. Telegram stays the push channel; the device row keeps room for a push token later. |
| Client | Native SwiftUI, iOS 26+, Liquid Glass, monochrome with one accent, the owl `0_0`. |
| Navigation | Floating tab bar: Team, Tasks, Inbox, Hub. |
| v1 scope | Pairing (QR, link), team, agent chat with streaming and every chat card, approvals with Face ID, tasks, notifications, voice input. |
| Not in v1 | Attachments, share extension, push, widgets, the plugins' own web UI (opened in the hub web instead). |

## Hub side

### Devices (`packages/core/src/devices.ts`)

Like machines: table `devices(id, name, platform, model, token_hash, public_key, created_at, last_seen_at, revoked)`
and one-time `device_pairing_codes(code, expires_at, used)` (10 minutes). Every pairing, revocation and approval from a
device goes to the audit log. A device token is 32 random bytes; the hub keeps only its SHA-256.

`public_key` is the device's P-256 key from the Secure Enclave (X9.63 uncompressed point, base64). The private key never
leaves the phone and signs only with Face ID (or the passcode).

### Device port

A second Fastify server, `PIOMIO_DEVICE_PORT` (default web port + 2: 8082), for phones only:

- HTTPS with the hub's own self-signed ECDSA P-256 certificate in `<data>/devices/` (generated on first use, DER built
  by the hub, no dependency). The phone pins SHA-256 of the certificate (DER), which the QR carries, so no CA is
  involved and nobody on the Wi-Fi can read or change the traffic.
- Bearer tokens only (`Authorization: Bearer <device token>`): no cookies, no CSRF, no setup or login endpoints, no
  `/mcp`, no SPA, no UI plugin assets. Host and Origin checks do not apply (no browser, addresses vary).
- Listens on `0.0.0.0` (home network and Tailscale), while the web UI (8080) and the security console (8081) keep
  their own host (`127.0.0.1` by default). It runs while the "devices on the network" switch is on (core setting
  `devicesLan`, toggled from the web UI without a restart) or when `PIOMIO_DEVICES=1`.

The authenticated web API moves from `main-app.ts` into `server/api.ts` and is registered by both servers, so the phone
sees exactly what the web UI sees (chat, team, tasks, cards, notifications, settings). Device-only routes:

| Route | What |
|---|---|
| `GET /api/device/hello` | Public: `{ piomio, name, version }`, for the phone's reachability probe |
| `POST /api/devices/pair` | Public, rate limited: `{ code, name, platform, model, publicKey }` → `{ deviceId, token, hub }` |
| `GET /api/devices/me`, `DELETE /api/devices/me` | This device; unpair itself |
| `GET /api/approvals` | Pending approvals with agent name and full input |
| `POST /api/approvals/:id/challenge` | One-time nonce (2 minutes) for this device and approval |
| `POST /api/approvals/:id/resolve` | `{ decision, nonce, signature }`: approve needs an ECDSA signature over `piomio-approval\n<id>\napprove\n<nonce>`; deny needs none |

A stolen token therefore cannot approve anything without the phone's Face ID. "Always allow" rules, the vault's items and
the audit stay in the security console.

### Pairing from the web UI and the chat

- `POST /api/devices/pairing` (web session) → `{ code, expiresAt, link, qrSvg, urls, fingerprint, network }`.
- The link: `piomio://pair?v=1&c=<code>&n=<hub name>&fp=<base64url sha256>&u=<url>&u=<url>…`, one `u` per address:
  every private IPv4 interface and the Tailscale address (100.64.0.0/10), as `https://<ip>:<device port>`.
- Settings panel section "Devices": the network switch, "Connect a phone" (QR, link with Copy, the code), the paired
  devices with last seen and Revoke. Realtime `device.updated` closes the QR once the phone is in.
- Chat card `device_pairing` (hub tool `hub_device_pairing`) with the same QR, so "connect my phone" works in the chat.
- CLI: `piomio devices pair` prints the QR and the link in the terminal (Docker, headless).

## The app (`piomio-ios`)

- `PiomioKit` (Swift package, tested with `swift test`): models (`Message` parts decoded by `type`, unknown parts kept),
  pairing link parsing, the pinned `URLSession` delegate, endpoint selection (probe every address, take the first that
  answers, re-probe on network changes), the REST client, the realtime WebSocket with backoff, credential storage.
- App target: SwiftUI views per the approved mockups; Secure Enclave key and `LocalAuthentication`; on-device speech
  recognition for the hold-to-talk mic; String Catalog with English (source) and Russian.
- The phone sends `x-piomio-locale` so the hub answers in the phone's language.

## Errors

- No address answers: "offline" banner, retries with backoff; the Hub tab shows which addresses were tried.
- Fingerprint mismatch: hard failure, never falls back to another certificate.
- 401 with a revoked device: credentials are wiped, back to onboarding.
- Expired or used code: the pairing sheet says so and asks for a new QR.
- Approval already answered elsewhere: the list refreshes, a short note.
- Face ID cancelled: nothing is sent.

## Testing

- Hub (vitest): pairing (single use, expiry, rate limit), token auth and revocation, the certificate (parses as X.509,
  fingerprint stable across restarts), the device server serves the API over TLS with a bearer token and refuses without,
  approval signatures (valid, wrong key, replayed nonce, deny without signature), the switch starts and stops the server,
  catalog parity for the new strings.
- App: `swift test` for PiomioKit (link parsing, decoding recorded hub JSON, event reducer, catalog parity); the app on the
  simulator against a dev hub, then on a real iPhone.

## Chat in a WebView (revised 2026-10-27)

Plugins extend the chat with React modules (message and tool-result renderers, composer overrides and actions, their own
setup UI in cards). A native chat cannot run them, so the conversation screen of the app is the web UI's own chat in a
WKWebView, served by the hub; everything around it stays native (pairing, tabs, team, inbox, Hub tab, the chat's header).

### Hub (device port)

- `POST /api/devices/web-ticket` (bearer) → `{ ticket, expiresAt }`: one-time, 60 seconds.
- `GET /m/session?ticket=…&to=/m/chat/<id>`: spends the ticket, sets `piomio_device` (HttpOnly, Secure, SameSite=Strict,
  path /) and redirects to `to` (must start with `/m/`). The session belongs to the device and ends with it (revocation,
  hub restart: the page asks the app to sign in again).
- The device port serves the SPA under `/m/*` (same index, import map and CSP as the web UI, `connect-src 'self' wss://<host>`),
  its static files (`/assets/*`, `/shared/*`, icons) and, to signed-in pages, `/plugins-ui/:id/*`.
- Every API route accepts either the bearer token (the app) or the cookie session (the page). Cookie requests that change
  something need `x-csrf` and an `Origin` equal to the page's own origin; `/api/bootstrap` returns `csrf` to cookie sessions.

### Web: the mobile route

- `/m/chat/:conversationId` shows only that conversation: messages, cards, plugin slots and the composer, full height,
  no sidebar, no settings panel, no page header (the app draws it). It skips `/api/auth/state` and starts at
  `/api/bootstrap`; a 401 calls the bridge's `reauth` instead of showing a sign-in screen.
- iOS look: system font, safe areas, no zoom, momentum scrolling, the composer docked at the bottom above the keyboard.

### The bridge

The app adds a `WKScriptMessageHandlerWithReply` named `piomio`; the page is in native mode when
`window.webkit?.messageHandlers?.piomio` exists. A call is `window.webkit.messageHandlers.piomio.postMessage({ type, ... })`,
a Promise of the reply object (rejected with a message string on failure).

| type | payload | reply |
|---|---|---|
| `ready` | `{ conversationId, show }` | `{ ok }`: the page has rendered (the app hides its spinner). `show: true`: the page switches chats on the app's `show` event; at `/m/` (no chat) `conversationId` is empty |
| `approve` | `{ approvalId }` | `{ ok: true }` or `{ ok: false, cancelled: true }`: the app loads the approval from the hub (never trusts the page's text), asks for Face ID with its summary, signs with the device key |
| `deny` | `{ approvalId }` | `{ ok: true }` |
| `dictation.start` | `{}` | `{ ok: true }` (rejects with a reason when the mic or speech recognition is not allowed) |
| `dictation.stop` | `{}` | `{ text }`: the final words |
| `openURL` | `{ url }` | `{ ok: true }`: opens in Safari (sign-in pages) |
| `open` | `{ path }`: the web UI's path of another chat (`/`, `/agent/:id`, `/chat/:id`, `/tasks/:id`) or of a channel (`/channels/:id`) | `{ ok: true }`: the app opens that chat as its own screen (a new agent's card, a task line, a link in a message); rejects when the hub has no such chat |
| `fullscreen` | `{ on }`: the page shows something full screen (a map, the media viewer) or stopped | `{ ok: true }`: the app hides its header while `on` (the page hides its own composer) |
| `save` | `{ url, name }`: a hub file with `download=1` (the media viewer's download button, a file in a message) | `{ ok: true }`: the app downloads it through the page's session (its cookie, the pinned certificate) and offers it in the share sheet (Save Image, Save to Files…); rejects with the reason |
| `haptic` | `{ kind: "light" \| "success" \| "warning" }` | `{ ok: true }` |
| `reauth` | `{}` | none: the app gets a new ticket and reloads the page |

App → page: `window.dispatchEvent(new CustomEvent("piomio-native", { detail }))`, with `detail` one of:

| detail | when |
|---|---|
| `{ type: "dictation", text }` | live words while the mic is held |
| `{ type: "details", on }` | after `ready`, and when the header's "Show steps" switch changes: the page's detailed mode (tool calls, notes for the model, the brain of each reply) |
| `{ type: "online" }` | the app reaches the hub again after it was away: the page reconnects now and re-reads `/api/bootstrap` (a restarted hub forgot the page's session; the 401 leads to `reauth`) |
| `{ type: "show", conversationId }` | the person opened a chat and the app hands it a warm page: one it loaded at `/m/` (signed in, scripts and lists loaded, no chat) and kept off screen. The page switches to `/m/chat/:conversationId` in place and says `ready` with that id |

The app keeps one such warm page per hub address, made after it is online and only from a page that said `show: true`
in its `ready`; a page that was shown is never handed out again, and a warm page goes on a memory warning.

The composer keeps unsent text in `sessionStorage`, so a `reauth` reload does not lose it. On the phone Return inserts a
new line; the send button sends.

In native mode the approval card shows Approve / Deny (calling the bridge), and the composer's mic is hold-to-talk through
`dictation.start` / `dictation.stop` (words appear in the field while held; letting go sends them). `@piomio/ui` exports
`native`, the same bridge for plugins (`undefined` in a browser). Links that leave the hub open in Safari.
