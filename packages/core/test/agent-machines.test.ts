// Agents bound to computers (docs/superpowers/specs/2026-11-01-agent-machines-design.md): a bound agent thinks only
// with the brains of its computers, says so in the chat when none of them is online (the person's message stays in the
// conversation), and refuses work placed elsewhere. A paired machine is simulated by the fake brain plugin's peer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Computer, Message } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

class Client {
  cookie = "";
  csrf = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { "x-csrf": this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    const json = text ? JSON.parse(text) : undefined;
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${text}`);
    return json;
  }
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const errorOf = (m: Message) => m.parts.flatMap((p) => (p.type === "error" ? [p.message] : [])).join("");

describe("agents bound to computers (integration)", () => {
  let hub: Hub;
  let web: Client;

  const messages = async (conversationId: string): Promise<Message[]> => web.req("GET", `/api/conversations/${conversationId}/messages`);
  const say = (conversationId: string, text: string) => web.req("POST", `/api/conversations/${conversationId}/messages`, { text });
  const idle = (conversationId: string) => until(async () => !hub.runner.isRunning(conversationId) && (await messages(conversationId)).every((m) => m.status !== "streaming"), "the turn to end");
  const dialogOf = async (agentId: string): Promise<string> => ((await web.req("GET", "/api/team")) as Array<{ agentId: string; conversationId: string }>).find((m) => m.agentId === agentId)!.conversationId;
  const lastAssistant = async (c: string) => textOf((await messages(c)).filter((m) => m.role === "assistant").at(-1)!);

  /** The machine "box" comes online: its brain `fake` runs on the fake plugin's process. */
  const connect = () => {
    const peer = (hub.brains as any).pluginBrains.get("fake").peer;
    (hub.machines as any).peers.set("mach_box", peer);
    hub.brains.registerMachine("mach_box", "box", peer, [{ id: "fake", label: "Fake" }]);
  };
  const disconnect = () => {
    (hub.machines as any).peers.delete("mach_box");
    hub.brains.unregisterMachine("mach_box");
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-machines-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    const now = new Date().toISOString();
    hub.db.prepare("insert into machines(id, name, public_key, created_at) values (?,?,?,?)").run("mach_box", "box", "x", now);
    // Another replica of the hub (the Mac while the VPS leads): never "here" in this hub.
    hub.db.prepare("insert into replicas(id, name, public_key, priority, created_at) values (?,?,?,?,?)").run("rep_mac", "Mac", "x", 1, now);
    connect();
    await web.req("PUT", "/api/agents/coder", { name: "Coder", description: "Writes code", brains: ["fake@local"], machines: ["box"], prompt: "Code." });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("keeps the binding by machine id", () => {
    expect(hub.agents.get("coder")!.machines).toEqual(["mach_box"]);
  });

  it("thinks with the brains of its computer, not the hub's", async () => {
    const c = await dialogOf("coder");
    await say(c, "hello");
    await idle(c);
    expect(await lastAssistant(c)).toBe("fake heard: hello");
    expect(hub.store.activeSession(c, "coder")!.brainRef).toBe("fake@mach_box");
  });

  it("says its computer is off and keeps the message, without moving to another brain", async () => {
    disconnect();
    try {
      const c = await dialogOf("coder");
      const before = (await messages(c)).filter((m) => m.role === "assistant").length;
      await say(c, "are you there");
      await idle(c);
      const all = await messages(c);
      expect(all.some((m) => m.role === "user" && textOf(m) === "are you there")).toBe(true);
      expect(errorOf(all.at(-1)!)).toMatch(/Coder.+box/);
      expect(all.filter((m) => m.role === "assistant").length).toBe(before);
      expect(hub.store.activeSession(c, "coder")!.brainRef).toBe("fake@mach_box");
    } finally {
      connect();
    }
  });

  it("counts another replica of the hub as off: nothing runs there while this one leads", async () => {
    await web.req("PUT", "/api/agents/coder", { machines: ["Mac"] });
    try {
      expect(hub.agents.get("coder")!.machines).toEqual(["rep_mac"]);
      const c = await dialogOf("coder");
      await say(c, "and now");
      await idle(c);
      expect(errorOf((await messages(c)).at(-1)!)).toMatch(/Coder.+Mac/);
    } finally {
      await web.req("PUT", "/api/agents/coder", { machines: ["mach_box"] });
    }
  });

  it("takes the hub's own computer as local or by its name", async () => {
    await web.req("PUT", "/api/agents/coder", { machines: ["local"] });
    try {
      expect(hub.agents.get("coder")!.machines).toEqual(["local"]);
      const c = await dialogOf("coder");
      await say(c, "here");
      await idle(c);
      expect(await lastAssistant(c)).toBe("fake heard: here");
      expect(hub.store.activeSession(c, "coder")!.brainRef).toBe("fake@local");
    } finally {
      await web.req("PUT", "/api/agents/coder", { machines: ["mach_box"] });
    }
  });

  it("refuses a task placed on a computer outside the binding", async () => {
    const c = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    await idle(c);
    await say(c, `CALL task_delegate {"title":"Elsewhere","goal":"hi","agent":"coder","machine":"local"}`);
    await idle(c);
    expect(await lastAssistant(c)).toMatch(/Coder works only on box/);
  });

  it("is set up from the chat: agent_save takes computers by name, refuses unknown ones, and [] unbinds", async () => {
    const c = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    await say(c, `CALL hub_agent_save {"id":"coder","machines":["atlantis"]}`);
    await idle(c);
    expect(await lastAssistant(c)).toMatch(/No computer "atlantis"\. Computers: .*box/);
    expect(hub.agents.get("coder")!.machines).toEqual(["mach_box"]);

    await say(c, `CALL hub_agents_list {}`);
    await idle(c);
    expect(await lastAssistant(c)).toMatch(/"machines": \[\s*"box"\s*\]/);

    await say(c, `CALL hub_agent_save {"id":"coder","machines":[]}`);
    await idle(c);
    expect(hub.agents.get("coder")!.machines).toBeUndefined();

    await say(c, `CALL hub_agent_save {"id":"coder","machines":["box"]}`);
    await idle(c);
    expect(hub.agents.get("coder")!.machines).toEqual(["mach_box"]);
  });

  it("lists the computers an agent may be bound to: the hub's own first, the machines, other replicas on standby", async () => {
    const list = (await web.req("GET", "/api/computers")) as Computer[];
    expect(list[0]).toMatchObject({ id: "local", online: true });
    expect(list.find((x) => x.id === "mach_box")).toMatchObject({ name: "box", online: true });
    expect(list.find((x) => x.id === "rep_mac")).toMatchObject({ name: "Mac", online: false, standby: true });
  });
});
