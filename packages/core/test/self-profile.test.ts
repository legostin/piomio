// Every agent changes its own profile when the user asks in its dialog (profile_update): the edit lands in its
// definition, its next reply runs on the new instructions, and after outside content the user approves it first.
// Uses the scripted fake brain (test/fixtures/plugins/fakebrain): "CALL <tool> <json>", "PROMPT?".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown, patchAgent } from "../src/agents.ts";

const fixtures = join(import.meta.dirname, "fixtures");

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("an agent edits its own profile", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";

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
  /** Send a message and wait for the fake brain's finished reply to it; returns the reply's text. */
  const say = async (text: string, reply: RegExp): Promise<string> => {
    const sent = await ok("POST", `/api/conversations/${conv}/messages`, { text });
    const m = await until(async () => {
      const msgs = await messages();
      const after = msgs.slice(msgs.findIndex((x) => x.id === sent.id) + 1);
      return after.find((x) => x.role === "assistant" && x.status !== "streaming" && x.parts.some((p: any) => p.type === "text" && reply.test(p.text)));
    }, `reply matching ${reply}`);
    return m.parts.find((p: any) => p.type === "text" && reply.test(p.text)).text;
  };
  const sessions = () => hub.db.prepare("select id from sessions where conversation_id = ?").all(conv) as Array<{ id: string }>;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-self-profile-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local"), "fake brain");
    await ok("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    csrf = (await ok("GET", "/api/bootstrap")).csrf;
    // A team member, not the default agent.
    hub.saveAgent(agentFromMarkdown("lyapa", "---\nname: Ляпа\ndescription: Она помогает с текстами\nbrains: [fake@local]\n---\nТы Ляпа, она пишет тексты.", "user"), "user");
    conv = hub.store.agentConversation("lyapa").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("reads its own profile with the exact instructions", async () => {
    const r = await say("CALL profile_update {}", /^tool said: \{/);
    expect(JSON.parse(r.slice("tool said: ".length))).toMatchObject({ id: "lyapa", name: "Ляпа", description: "Она помогает с текстами", prompt: "Ты Ляпа, она пишет тексты." });
    expect(await say("PROMPT?", /prompt:/)).toBe("fake prompt: Ты Ляпа, она пишет тексты. | in system prompt: true");
  });

  it("does not get the hub administration tools", async () => {
    expect(await say('CALL hub_agent_save {"id":"lyapa","description":"x"}', /^tool said:/)).toMatch(/not available/);
    expect(hub.agents.get("lyapa")?.description).toBe("Она помогает с текстами");
  });

  it("changes its description and instructions; the next reply runs on them in the same session", async () => {
    const r = await say('CALL profile_update {"description":"Он помогает с текстами","prompt":"Ты Ляпа, он пишет тексты."}', /^tool said:/);
    expect(r).toMatch(/Saved: description, prompt/);
    expect(hub.agents.get("lyapa")).toMatchObject({ description: "Он помогает с текстами", prompt: "Ты Ляпа, он пишет тексты.", source: "user" });
    expect(await say("PROMPT?", /prompt:/)).toBe("fake prompt: Ты Ляпа, он пишет тексты. | in system prompt: true");
    // Reopened on the same brain: the same session row, so the brain resumes the conversation.
    expect(sessions()).toHaveLength(1);
  });

  it("rejects an empty name and a bad avatar", async () => {
    expect(await say('CALL profile_update {"name":"  "}', /^tool said:/)).toMatch(/name cannot be empty/);
    expect(await say('CALL profile_update {"avatar":{"color":"plaid","shape":"blob"}}', /^tool said:/)).toMatch(/Invalid avatar/);
    expect(hub.agents.get("lyapa")?.name).toBe("Ляпа");
  });

  it("after outside content, reads freely but changes only with the user's approval", async () => {
    for (const s of sessions()) hub.store.updateSession(s.id, { tainted: true });
    expect(await say("CALL profile_update {}", /^tool said: \{/)).toContain("Ляпа");
    expect(hub.approvals.list(["pending"])).toHaveLength(0);

    await ok("POST", `/api/conversations/${conv}/messages`, { text: 'CALL profile_update {"name":"Ляп"}' });
    const pending = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "profile_update"), "approval");
    expect(pending).toMatchObject({ agentId: "lyapa", tainted: true, input: { name: "Ляп" } });
    expect(pending.summary).toMatch(/profile|профиль/);
    expect(hub.agents.get("lyapa")?.name).toBe("Ляпа");

    hub.approvals.resolve(pending.id, "approve", { via: "console" });
    await until(() => hub.agents.get("lyapa")?.name === "Ляп", "approved rename");
  });

  it("a translated agent keeps its other language", () => {
    const a = agentFromMarkdown("x", "---\nname: Writer\ndescription: Writes\ni18n:\n  ru:\n    name: Писатель\n    description: Пишет\n---\nHi", "user");
    const ru = patchAgent(a, { description: "Пишет тексты", prompt: "Hello" }, "ru");
    expect(ru).toMatchObject({ name: "Writer", description: "Writes", prompt: "Hello", i18n: { ru: { name: "Писатель", description: "Пишет тексты" } } });
    expect(patchAgent(a, { description: "Writes texts" }, "en")).toMatchObject({ description: "Writes texts", i18n: { ru: { description: "Пишет" } } });
  });
});
