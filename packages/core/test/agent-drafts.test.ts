// New agents are put together in the chat: the default agent starts a draft card, rewrites it when the user corrects
// it, the user picks the look and proactivity in the card, and the agent joins the team on a button or on the
// user's word. Uses the scripted fake brain (test/fixtures/plugins/fakebrain): "CALL <tool> <json>".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

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

describe("new agents through the conversation", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";
  let draftId = "";

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
  /** Send a message and wait for the fake brain's finished reply to it. */
  const say = async (text: string, reply: RegExp) => {
    const sent = await ok("POST", `/api/conversations/${conv}/messages`, { text });
    return until(async () => {
      const msgs = await messages();
      const after = msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1);
      return after.find((m) => m.role === "assistant" && m.status !== "streaming" && m.parts.some((p: any) => p.type === "text" && reply.test(p.text)));
    }, `reply matching ${reply}`);
  };
  const call = (args: Record<string, unknown>, reply: RegExp) => say(`CALL hub_agent_draft ${JSON.stringify(args)}`, reply);
  const cards = (m: any) => m.parts.filter((p: any) => p.type === "agent_draft");

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-drafts-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local"), "fake brain");
    await ok("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await ok("GET", "/api/bootstrap");
    csrf = boot.csrf;
    conv = boot.mainConversationId;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("needs a name before anything is shown", async () => {
    await call({ description: "Does things" }, /tool said: A new agent needs a name/);
  });

  it("starts a draft from the conversation and shows it as a card", async () => {
    const reply = await call({ name: "СЕО", description: "Руководит компанией", prompt: "You run the company." }, /tool said: Draft ad_/);
    expect(cards(reply)).toHaveLength(1);
    draftId = cards(reply)[0].draftId;
    const d = await ok("GET", `/api/agent-drafts/${draftId}`);
    expect(d).toMatchObject({ name: "СЕО", description: "Руководит компанией", status: "draft", brains: ["fake@local", "fake2@local"], conversationId: conv });
    expect(d.initiative).toBeUndefined();
    expect(d.avatar).toEqual({ color: expect.any(String), shape: expect.any(String) });
    // Nothing joins the team before it is created.
    expect(hub.agents.list().map((a) => a.id)).toEqual(["assistant"]);
  });

  it("rewrites the draft when the user corrects what it is for", async () => {
    const reply = await call(
      { draft: draftId, name: "SEO-оптимизатор", description: "Поисковая оптимизация сайта", prompt: "You do search engine optimisation." },
      /tool said: Draft .* for “SEO-оптимизатор”[\s\S]*Поисковая оптимизация/,
    );
    expect(cards(reply)).toEqual([{ type: "agent_draft", draftId }]);
    expect(await ok("GET", `/api/agent-drafts/${draftId}`)).toMatchObject({ name: "SEO-оптимизатор", description: "Поисковая оптимизация сайта", prompt: "You do search engine optimisation." });
    // Both replies carry the card; the web UI folds the older one.
    expect((await messages()).filter((m) => cards(m).length).length).toBe(2);
  });

  it("lets the card change only the look and the proactivity", async () => {
    const d = await ok("PATCH", `/api/agent-drafts/${draftId}`, { avatar: { color: "blue", shape: "star" }, initiative: 2, name: "Ignored", prompt: "Ignored" });
    expect(d).toMatchObject({ name: "SEO-оптимизатор", prompt: "You do search engine optimisation.", avatar: { color: "blue", shape: "star" }, initiative: 2 });
    expect((await req("PATCH", `/api/agent-drafts/${draftId}`, { avatar: { color: "plaid", shape: "star" } })).status).toBe(400);
    expect((await req("PATCH", `/api/agent-drafts/${draftId}`, { initiative: 5 })).status).toBe(400);
    expect((await req("GET", "/api/agent-drafts/ad_nope")).status).toBe(404);
    // The model sees what the user picked.
    await call({ draft: draftId }, /tool said: [\s\S]*Avatar: blue star\. Proactivity: 2\./);
  });

  it("creates the agent from the card once and lets the default agent say so", async () => {
    const r = await ok("POST", `/api/agent-drafts/${draftId}/create`, {});
    expect(r.agent).toMatchObject({ id: "seo-optimizator", name: "SEO-оптимизатор", source: "user", initiative: 2, avatar: { color: "blue", shape: "star" }, brains: ["fake@local", "fake2@local"] });
    expect(r.draft).toMatchObject({ status: "created", agentId: "seo-optimizator" });
    expect(hub.agents.get("seo-optimizator")?.prompt).toBe("You do search engine optimisation.");
    await until(async () => (await messages()).some((m) => m.role === "assistant" && JSON.stringify(m.parts).includes("pressed Create in the card")), "the agent's follow-up");
    // The new member has its own dialog.
    await until(async () => ((await ok("GET", "/api/team")) as any[]).some((m) => m.agentId === "seo-optimizator"), "team entry");

    expect((await req("POST", `/api/agent-drafts/${draftId}/create`, {})).status).toBe(409);
    expect((await req("PATCH", `/api/agent-drafts/${draftId}`, { initiative: 0 })).status).toBe(409);
    await call({ draft: draftId, description: "x" }, /tool said: That draft is already the agent seo-optimizator/);
  });

  it("creates on the user's word too, never over an existing agent", async () => {
    const reply = await call({ name: "Assistant", description: "Second one", prompt: "Hi." }, /tool said: Draft ad_/);
    const id = cards(reply)[0].draftId;
    const before = hub.agents.get("assistant")!.prompt;
    await call({ draft: id, create: true }, /tool said: Agent assistant-2 “Assistant” created/);
    expect(hub.agents.get("assistant")!.prompt).toBe(before);
    expect(hub.agents.get("assistant-2")).toMatchObject({ name: "Assistant", initiative: 1 });
  });

  it("only shows the card after outside content was read: creating then takes the user's button", async () => {
    const reply = await call({ name: "Researcher", description: "Finds things", prompt: "Research." }, /tool said: Draft ad_/);
    const id = cards(reply)[0].draftId;
    for (const s of hub.db.prepare("select id from sessions where conversation_id = ?").all(conv) as Array<{ id: string }>) hub.store.updateSession(s.id, { tainted: true });
    await call({ draft: id, description: "Finds things fast" }, /tool said: Draft/);
    await call({ draft: id, create: true }, /tool said: Not created: this conversation has read outside content/);
    expect(hub.agents.get("researcher")).toBeUndefined();
    expect((await ok("POST", `/api/agent-drafts/${id}/create`, {})).agent.id).toBe("researcher");
  });
});
