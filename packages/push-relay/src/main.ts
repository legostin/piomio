// The relay as a service: `node src/main.ts` (Node ≥ 24), or `npm run build -w @piomio/push-relay` for one file that
// runs on older Node. Settings come from the environment (README.md).

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { ApnsClient, type ApnsSend } from "./apns.ts";
import { relayHandler } from "./relay.ts";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[relay] ${name} is not set`);
    process.exit(1);
  }
  return v;
}

const file = (name: string) => readFileSync(need(name), "utf8").trim();

/** Without Apple's key yet the relay still registers phones; their pushes wait for the key (a restart picks it up). */
function apnsClient(): ApnsClient | undefined {
  const path = need("RELAY_APNS_KEY_FILE");
  if (!existsSync(path)) {
    console.error(`[relay] no APNs key at ${path}: phones register, pushes fail until it is there`);
    return undefined;
  }
  return new ApnsClient({
    key: readFileSync(path, "utf8"),
    keyId: need("RELAY_APNS_KEY_ID"),
    teamId: need("RELAY_APNS_TEAM_ID"),
    topic: process.env.RELAY_APNS_TOPIC?.trim() || "app.piomio.ios",
  });
}

const apns = apnsClient();
const send: ApnsSend = apns ? apns.send : async () => ({ status: 503, reason: "NoApnsKey" });
const secret = file("RELAY_SECRET_FILE");
if (secret.length < 32) {
  console.error("[relay] the secret is shorter than 32 characters");
  process.exit(1);
}
const host = process.env.RELAY_HOST || "127.0.0.1";
const port = Number(process.env.RELAY_PORT || 8795);
const server = createServer(relayHandler({ secret, send, trustProxy: process.env.RELAY_TRUST_PROXY !== "0" }));
server.listen(port, host, () => console.log(`[relay] listening on ${host}:${port}`));

const stop = () => {
  apns?.close();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
