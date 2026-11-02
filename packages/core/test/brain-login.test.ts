// Signing CLI brains in from the chat: the hub runs the real Codex brain on a fake CLI (fixtures/plugins/fakecodex,
// packages/brains-cli/test/fixtures/fake-codex.mjs) that prints a device page and code, then signs in and exits 0.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const CODEX = "codex@local";

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("signing CLI brains in from the chat", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";
  let agentHome = "";

  const req = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(base + path, {
      method,
      headers: { origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    try {
      return { status: r.status, json: JSON.parse(text) };
    } catch {
      return { status: r.status, json: text };
    }
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await req(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const messages = async (): Promise<any[]> => ok("GET", `/api/conversations/${conv}/messages`);
  const say = async (text: string, reply: RegExp) => {
    const sent = await ok("POST", `/api/conversations/${conv}/messages`, { text });
    return until(async () => {
      const msgs = await messages();
      const after = msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1);
      return after.find((m) => m.role === "assistant" && m.status !== "streaming" && m.parts.some((p: any) => p.type === "text" && reply.test(p.text)));
    }, `reply matching ${reply}`);
  };
  /** How the fake CLI behaves on the next `codex login --device-auth`. */
  const mode = (m: "ok" | "fail" | "hang") => writeFileSync(join(agentHome, ".fake-codex-login"), m);
  const state = () => hub.brainLogins.get(CODEX);
  const loginGrants = () => [...((hub.egress as any).grants as Map<string, { owner: string }>).values()].filter((g) => g.owner.startsWith("brain:login:"));

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-brainlogin-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    agentHome = join(dataDir, "home", "agent");
    mkdirSync(agentHome, { recursive: true });
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local") && hub.brains.has(CODEX), "brains");
    await ok("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await ok("GET", "/api/bootstrap");
    csrf = boot.csrf;
    conv = boot.mainConversationId;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("lists Codex as a brain that signs in here", async () => {
    const brains: any[] = await ok("GET", "/api/brains");
    expect(brains.find((b) => b.ref === CODEX)).toMatchObject({ login: true, connected: true, probe: { available: true, authenticated: false } });
    expect(brains.find((b) => b.ref === "fake@local").login).toBe(false);
    const view = await ok("GET", `/api/brains/login?ref=${encodeURIComponent(CODEX)}`);
    expect(view).toMatchObject({ ref: CODEX, supported: true, connected: true, probe: { authenticated: false } });
    expect(view.login).toBeUndefined();
  });

  it("refuses brains that cannot sign in here", async () => {
    expect((await req("POST", "/api/brains/login", { ref: "fake@local" })).json.error).toMatch(/cannot sign in from the chat/);
    expect((await req("POST", "/api/brains/login", { ref: "nope@local" })).status).toBe(400);
    expect((await req("GET", `/api/brains/login?ref=${encodeURIComponent("a b")}`)).status).toBe(400);
    await say('CALL hub_brain_login {"ref":"fake@local"}', /tool said: fake@local cannot sign in from the chat/);
  });

  it("cancels a sign-in and gives its network grant back", async () => {
    mode("hang");
    await ok("POST", "/api/brains/login", { ref: CODEX });
    const waiting = await until(() => state()?.status === "waiting" && state(), "the page and the code");
    expect(waiting).toMatchObject({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGHI" });
    expect(loginGrants()).toHaveLength(1);
    // Starting again shows the same sign-in; a device flow takes no pasted code.
    expect((await ok("POST", "/api/brains/login", { ref: CODEX })).login.id).toBe(waiting.id);
    expect((await req("POST", "/api/brains/login/code", { ref: CODEX, code: "x" })).status).toBe(409);
    await ok("POST", "/api/brains/login/cancel", { ref: CODEX });
    await until(() => state()?.status === "cancelled", "cancelled");
    expect(loginGrants()).toEqual([]);
  });

  it("shows why a sign-in failed", async () => {
    mode("fail");
    await ok("POST", "/api/brains/login", { ref: CODEX });
    const failed = await until(() => state()?.status === "failed" && state(), "failure");
    expect(failed.error).toMatch(/device code was declined/);
    expect(failed.finishedAt).toBeTruthy();
  });

  it("the assistant shows the card; the code never reaches the model; signing in turns the brain green and the assistant carries on", async () => {
    mode("ok");
    const statuses: string[] = [];
    let brainsUpdated = 0;
    hub.bus.on("brain.login", (s) => statuses.push(s.status));
    hub.bus.on("brains.updated", () => brainsUpdated++);

    const reply = await say(`CALL hub_brain_login {"ref":"${CODEX}"}`, /tool said: A sign-in card for codex@local is shown/);
    expect(JSON.stringify(reply)).toMatch(/enters the one-time code shown on the card/);
    expect((await messages()).flatMap((m) => m.parts).some((p: any) => p.type === "brain_login" && p.ref === CODEX)).toBe(true);

    await until(() => state()?.status === "succeeded", "signed in");
    expect(statuses).toEqual(["starting", "waiting", "verifying", "succeeded"]);
    expect(brainsUpdated).toBeGreaterThan(0);
    expect(loginGrants()).toEqual([]);
    expect((await ok("GET", `/api/brains/login?ref=${encodeURIComponent(CODEX)}`)).probe.authenticated).toBe(true);
    expect((await ok("GET", "/api/brains")).find((b: any) => b.ref === CODEX).probe.authenticated).toBe(true);

    await until(
      async () => (await messages()).some((m) => m.role === "assistant" && JSON.stringify(m.parts).includes("The user signed Codex (ChatGPT) (codex@local) in from the chat card")),
      "the assistant to hear it",
    );
    // The page and the code live on the card only.
    expect(JSON.stringify(await messages())).not.toContain("ABCD-EFGHI");
  });

  it("says when the brain is already signed in", async () => {
    await say(`CALL hub_brain_login {"ref":"${CODEX}"}`, /tool said: codex@local is already signed in/);
  });
});
