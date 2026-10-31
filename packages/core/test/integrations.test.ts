// The integrations library and the hub's Google sign-in, against a fake Google: start → consent → callback,
// tokens for the plugin, refresh, a revoked grant, disconnect, the cards' statuses, the chat card and the digest.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { callbackParams, pkce } from "../src/connections.ts";
import { listIntegrations } from "../src/integrations.ts";

const fixtures = join(import.meta.dirname, "fixtures");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Google's OAuth endpoints, enough for the flow: it checks the PKCE verifier and hands out tokens. */
function fakeGoogle() {
  const seen = { challenges: new Map<string, string>(), refreshes: 0, revoked: [] as string[], refreshToken: "rt-1", expiresIn: 3600 };
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (req.url === "/token" && body.get("grant_type") === "authorization_code") {
        const challenge = seen.challenges.get(body.get("code") ?? "");
        const verified = challenge && createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") === challenge;
        if (!verified || body.get("client_id") !== "test-client") return send(400, { error: "invalid_grant" });
        return send(200, { access_token: "at-1", refresh_token: seen.refreshToken, expires_in: seen.expiresIn, scope: "openid email https://www.googleapis.com/auth/calendar.events" });
      }
      if (req.url === "/token" && body.get("grant_type") === "refresh_token") {
        seen.refreshes++;
        if (body.get("refresh_token") === "revoked") return send(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return send(200, { access_token: `at-refreshed-${seen.refreshes}`, expires_in: 3600 });
      }
      if (req.url === "/userinfo") return send(req.headers.authorization === "Bearer at-1" ? 200 : 401, { email: "anna@example.com" });
      if (req.url === "/revoke") {
        seen.revoked.push(body.get("token") ?? "");
        return send(200, {});
      }
      send(404, {});
    });
  });
  return { server, seen };
}

describe("integrations and the Google sign-in", () => {
  let hub: Hub;
  let google: ReturnType<typeof fakeGoogle>;
  let base: string;

  /** What the user's browser does at Google: consent, then Google redirects to the hub with a code. */
  const consent = (authUrl: string, code: string) => {
    const u = new URL(authUrl);
    google.seen.challenges.set(code, u.searchParams.get("code_challenge")!);
    return `${u.searchParams.get("redirect_uri")}?state=${u.searchParams.get("state")}&code=${code}&scope=x`;
  };
  const integration = async (id: string) => (await listIntegrations(hub, "en")).find((i) => i.id === id)!;
  const tool = (name: string, input: unknown = {}, conversationId = hub.store.agentConversation("assistant").id) =>
    hub.tools.get(name)!.invoke(input, { conversationId, agentId: "assistant", sessionId: "s", machineId: "local", workspace: tmpdir(), tainted: false, background: false } as any);
  const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

  beforeAll(async () => {
    google = fakeGoogle();
    await new Promise<void>((r) => google.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(google.server.address() as any).port}`;
    const plugins = mkdtempSync(join(tmpdir(), "owl-int-plugins-"));
    for (const id of ["fakecal", "fakeset"]) cpSync(join(fixtures, "integration-plugins", id), join(plugins, id), { recursive: true });
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      {
        PIOMIO_PORT: String(port),
        PIOMIO_DEVICES: "0",
        PIOMIO_CONSOLE_PORT: String(consolePort),
        PIOMIO_EGRESS_PORT: String(egressPort),
        TZ: "UTC",
        PIOMIO_GOOGLE_CLIENT_ID: "test-client",
        PIOMIO_GOOGLE_CLIENT_SECRET: "test-secret",
        PIOMIO_GOOGLE_AUTH_URL: `${base}/auth`,
        PIOMIO_GOOGLE_TOKEN_URL: `${base}/token`,
        PIOMIO_GOOGLE_REVOKE_URL: `${base}/revoke`,
        PIOMIO_GOOGLE_USERINFO_URL: `${base}/userinfo`,
      },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-int-")), builtinPluginsDirs: [plugins], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.tools.get("fakecal_token"), "the fake calendar's tool");
  });

  afterAll(async () => {
    await hub?.stop();
    google?.server.close();
  });

  it("reads what the user pastes back", () => {
    expect(callbackParams("http://127.0.0.1:41780/oauth/callback?state=s1&code=c1#x").get("code")).toBe("c1");
    expect(callbackParams("state=s1&code=c2").get("code")).toBe("c2");
    const { verifier, challenge } = pkce();
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  });

  it("shows the cards: Google ones wait for the sign-in, setup ones for their secrets", async () => {
    expect(await integration("fakecal")).toMatchObject({ name: "Fake calendar", category: "work", icon: "calendar", connect: "google", status: "needs-setup" });
    expect(await integration("fakeset")).toMatchObject({ connect: "setup", status: "needs-setup", category: "communication" });
    expect(textOf(await tool("fakecal_token"))).toBe("no token: Google is not connected");
  });

  it("needs an open vault before the sign-in", () => {
    expect(() => hub.connections.start("google", [])).toThrow(/vault/);
    hub.vault.init("integration-test-passphrase");
  });

  it("signs in with PKCE, keeps the refresh token in the vault and gives the plugin access tokens", async () => {
    const { url } = hub.connections.start("google", ["https://www.googleapis.com/auth/calendar.events"], { integration: "fakecal" });
    const u = new URL(url);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "test-client",
      redirect_uri: `${hub.config.internalUrl}/oauth/callback`,
      response_type: "code",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
    });
    // The browser comes back to the hub's public callback page.
    const back = await fetch(consent(url, "code-1"));
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Google is connected");
    expect(hub.connections.get("google")).toMatchObject({ provider: "google", account: "anna@example.com" });
    expect(hub.vault.getMeta("google_refresh_token")).toBeTruthy();
    expect(await integration("fakecal")).toMatchObject({ status: "connected", account: "anna@example.com" });
    expect(textOf(await tool("fakecal_token"))).toBe("token at-1 for anna@example.com");
    // The same state cannot be used twice.
    expect((await fetch(consent(url, "code-1"))).status).toBe(400);
  });

  it("refreshes an access token that is about to expire, once for parallel callers", async () => {
    (hub.connections as any).cache.set("google", { accessToken: "old", expiresAt: Date.now() + 10_000 });
    const before = google.seen.refreshes;
    const [a, b] = await Promise.all([hub.connections.token("google"), hub.connections.token("google")]);
    expect(a.accessToken).toBe(`at-refreshed-${before + 1}`);
    expect(b.accessToken).toBe(a.accessToken);
    expect(google.seen.refreshes).toBe(before + 1);
  });

  it("marks the connection broken when Google refuses the refresh token", async () => {
    hub.vault.upsert({ id: "google_refresh_token", type: "secret", name: "Google", fields: { value: "revoked" } });
    (hub.connections as any).cache.delete("google");
    await expect(hub.connections.token("google")).rejects.toThrow(/connect Google again/);
    expect(await integration("fakecal")).toMatchObject({ status: "broken", account: "anna@example.com" });
  });

  it("takes the pasted return address, tells the agent, shows the card in the chat", async () => {
    const conv = hub.store.agentConversation("assistant");
    const r = await tool("hub_integration_connect", { id: "fakecal" }, conv.id);
    expect(textOf(r)).toMatch(/^The Fake calendar card is shown in the chat: its sign-in stopped working/);
    const { url } = hub.connections.start("google", ["https://www.googleapis.com/auth/calendar.events"], { integration: "fakecal", conversationId: conv.id });
    const done = await hub.connections.complete(consent(url, "code-2"));
    hub.connectionDone(done.account, done.origin);
    expect(await integration("fakecal")).toMatchObject({ status: "connected" });
    await until(() => hub.store.listMessages(conv.id).some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("[System] The user connected Google as anna@example.com (fakecal)"))), "the note to the agent");
    expect(textOf(await tool("hub_integrations_list"))).toContain("fakecal — Fake calendar [work]: connected (anna@example.com)");
  });

  it("puts the plugins' sections into the digest, even with nothing else waiting", async () => {
    expect(await hub.notifier.flushDigest()).toBe(1);
    // This hub has no brain to write it with: the card goes out once the writer fails.
    const dialog = hub.store.agentConversation(hub.settings.get().defaultAgent);
    const part = (await until(
      () => hub.store.listMessages(dialog.id).flatMap((m) => m.parts).find((p) => p.type === "notification" && p.kind === "digest"),
      "the digest card",
    )) as any;
    expect(part.title).toMatch(/digest · /);
    expect(part.body).toMatch(/^### Today\n\n09:00 Standup {2}\n11:00 Lunch \(\d{4}-\d\d-\d\d UTC\)$/);
  });

  it("disconnects: revokes at Google, forgets the token and the account", async () => {
    await hub.connections.disconnect("google");
    expect(google.seen.revoked.at(-1)).toBe("rt-1");
    expect(hub.connections.get("google")).toBeUndefined();
    expect(hub.vault.getMeta("google_refresh_token")).toBeUndefined();
    expect(await integration("fakecal")).toMatchObject({ status: "needs-setup" });
  });
});
