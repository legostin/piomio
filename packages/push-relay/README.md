# Piomio push relay

Apple delivers pushes to iPhones only from the holder of the app's APNs key, so hubs, which run anywhere, ask this
relay to wake a phone. Nothing personal passes through it:

- A hub registers a phone's APNs token once (`POST /v1/register {token, environment}`) and gets back a **handle**: the
  token sealed with the relay's secret (AES-256-GCM). The hub keeps only the handle, the relay keeps nothing.
- To wake the phone the hub sends `POST /v1/push {handle, id?, kind?, badge?, silent?}`. The relay sends Apple an
  alert with a fixed text key ("New message" or "Waiting for your answer", looked up on the phone in its language),
  `mutable-content` and the opaque `id`. The app's notification extension asks its own hub for that id and shows the
  words. Any other field a hub sends is ignored.
- `410 {gone: true}` means Apple says the app is no longer on that phone: the hub drops the handle.
- Nothing about a push is logged; Apple's error reasons are.

Limits: 30 registrations an hour per address, 1200 pushes an hour per address and 300 per phone.

## Running it

Node ≥ 24 runs `src/main.ts` as is; `npm run build -w @piomio/push-relay` makes `dist/relay.mjs`, one file for older
Node (20 and up).

| Variable | |
|---|---|
| `RELAY_SECRET_FILE` | a file with the secret that seals handles (32+ characters; changing it voids every handle, phones register again at their next launch) |
| `RELAY_APNS_KEY_FILE` | the APNs auth key (`AuthKey_XXXXXXXXXX.p8`) from developer.apple.com → Keys |
| `RELAY_APNS_KEY_ID` | its Key ID |
| `RELAY_APNS_TEAM_ID` | the Apple developer team |
| `RELAY_APNS_TOPIC` | the app's bundle id, `app.piomio.ios` |
| `RELAY_HOST`, `RELAY_PORT` | where it listens, `127.0.0.1:8795` |
| `RELAY_TRUST_PROXY` | `0` when it faces the internet itself (otherwise it takes the client's address from `X-Forwarded-For`) |

`deploy/` has the systemd unit and the nginx location Piomio's own relay runs with (`https://legost.in/piomio-push`,
the hubs' default `PIOMIO_PUSH_RELAY`):

```sh
npm run build -w @piomio/push-relay
scp packages/push-relay/dist/relay.mjs root@legost.in:/opt/piomio-push-relay/relay.mjs
ssh root@legost.in systemctl restart piomio-push-relay
```
