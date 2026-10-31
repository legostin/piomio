// Group chats: the user with several agents. Who answers (mentions, the lead, @all, hand-offs), what each member's
// brain gets to read (the others' messages since its own last reply), Stop, channels, the sidebar view, and storage.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, MachineActivity, Message } from "@piomio/shared";
import { parseMentions } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";
import { Team } from "../src/team.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { firstSpeakers, groupTurn, groupTurnText, handOff } from "../src/group-chat.ts";

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

/** Minimal browser-like client: one cookie jar, Origin header, CSRF header when known. */
class Client {
  cookie = "";
  csrf = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async raw(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
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
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json };
  }
  async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("group chats (integration)", () => {
  let hub: Hub;
  let web: Client;
  let leadName: string;

  /** A fresh group: every test reads only its own messages. */
  const group = async (members = ["assistant", "scout"], title = "Launch"): Promise<string> =>
    (await web.req("POST", "/api/conversations", { kind: "group", title, members })).id;

  /** The finished replies once there are `n` of them, oldest first; then a moment to be sure no more follow. */
  const replies = async (conversationId: string, n: number): Promise<Message[]> => {
    const done = async () => ((await web.req("GET", `/api/conversations/${conversationId}/messages`)) as Message[]).filter((m) => m.role === "assistant" && m.status !== "streaming");
    await until(async () => (await done()).length >= n && !hub.runner.isRunning(conversationId), `${n} replies`);
    await sleep(300);
    return done();
  };

  const say = (conversationId: string, text: string) => web.req("POST", `/api/conversations/${conversationId}/messages`, { text });

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-group-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2@local"), "fake brains to register");
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    await web.req("PUT", "/api/agents/scout", { name: "Scout", description: "Looks around", brains: ["fake@local"], prompt: "Scout around." });
    leadName = ((await web.req("GET", "/api/agents")) as AgentDef[]).find((a) => a.id === "assistant")!.name;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("creates, lists and edits groups, with the lead first", async () => {
    const bad = async (body: unknown) => (await web.raw("POST", "/api/conversations", { kind: "group", title: "x", ...(body as object) })).json.error;
    expect(await bad({ members: ["assistant"] })).toBe("A group chat needs 2 to 8 agents");
    expect(await bad({ members: Array.from({ length: 9 }, (_, i) => `a${i}`) })).toBe("A group chat needs 2 to 8 agents");
    expect(await bad({ members: ["assistant", "assistant"] })).toBe("Each agent can be in a group chat only once");
    expect(await bad({ members: ["assistant", "nobody"] })).toBe("No such agent: nobody");
    expect(await bad({})).toBe("A group chat needs 2 to 8 agents");

    const g = await web.req("POST", "/api/conversations", { kind: "group", title: "  Launch plan ", members: ["assistant", "scout"] });
    expect(g).toMatchObject({ kind: "group", title: "Launch plan", agentId: "assistant", members: ["assistant", "scout"] });
    expect(((await web.req("GET", "/api/conversations")) as any[]).find((c) => c.id === g.id)).toMatchObject({ kind: "group", members: ["assistant", "scout"] });
    const listed = ((await web.req("GET", "/api/groups")) as any[]).find((x) => x.conversationId === g.id);
    expect(listed).toMatchObject({ title: "Launch plan", members: ["assistant", "scout"], running: false, unread: 0, speaking: [] });
    // Untitled: a default title.
    expect((await web.req("POST", "/api/conversations", { kind: "group", members: ["scout", "assistant"] })).title).toBe("New group");

    // The lead is the first member: new members or a new lead.
    expect(await web.req("PATCH", `/api/conversations/${g.id}`, { members: ["scout", "assistant"], title: "Renamed" })).toMatchObject({ agentId: "scout", members: ["scout", "assistant"], title: "Renamed" });
    expect(await web.req("PATCH", `/api/conversations/${g.id}`, { agentId: "assistant" })).toMatchObject({ agentId: "assistant", members: ["assistant", "scout"] });
    expect((await web.raw("PATCH", `/api/conversations/${g.id}`, { members: ["assistant"] })).status).toBe(400);
    const main = (await web.req("GET", "/api/bootstrap")).mainConversationId;
    expect((await web.raw("PATCH", `/api/conversations/${main}`, { members: ["assistant", "scout"] })).json.error).toBe("Only a group chat has members");
  });

  it("lets the lead answer when nobody is mentioned", async () => {
    const id = await group();
    await say(id, "hello team");
    const r = await replies(id, 1);
    expect(r.map((m) => [m.agentId, textOf(m)])).toEqual([["assistant", "fake heard: hello team"]]);
  });

  it("lets the mentioned member answer, by id or by name", async () => {
    const id = await group();
    await say(id, "@scout what do you see?");
    await replies(id, 1);
    await say(id, "and you, @SCOUT?");
    const r = await replies(id, 2);
    expect(r.map((m) => m.agentId)).toEqual(["scout", "scout"]);
    expect(textOf(r[0])).toBe("fake heard: @scout what do you see?");
  });

  it("lets everyone answer @all in member order, each reading what the others said", async () => {
    const id = await group();
    await say(id, "@all ECHO?");
    const r = await replies(id, 2);
    expect(r.map((m) => m.agentId)).toEqual(["assistant", "scout"]);
    // The lead got the message itself; the scout also read the lead's answer.
    expect(textOf(r[0])).toBe("fake saw: ");
    expect(textOf(r[1])).toContain(`[User]: @all ECHO? | [${leadName}]: fake saw:`);
    expect(textOf(r[1])).toContain("[System] It is your turn to reply to the user's message above.");
  });

  it("gives every member answering the files, copied into its own workspace", async () => {
    const id = await group();
    const r = await fetch(`${hub.config.publicUrl}/api/conversations/${id}/attachments?name=plan.png`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: hub.config.publicUrl, cookie: web.cookie, "x-csrf": web.csrf },
      body: Buffer.from("png"),
    });
    const part = await r.json();
    expect(part.path).toBe(`assistant/${id}/attachments/plan.png`);
    await web.req("POST", `/api/conversations/${id}/messages`, { text: "@all look", attachments: [part.path] });
    const replied = await replies(id, 2);
    expect(replied.map((m) => [m.agentId, textOf(m).split(" | ")[0]])).toEqual([
      ["assistant", "fake files: attachments/plan.png:here"],
      ["scout", "fake files: attachments/plan.png:here"],
    ]);
  });

  it("hands the floor to a member an agent mentions, who then knows what was said", async () => {
    const id = await group();
    await say(id, "@scout HANDOFF assistant");
    const r = await replies(id, 2);
    expect(r.map((m) => [m.agentId, textOf(m)])).toEqual([
      ["scout", "over to @assistant"],
      ["assistant", "fake heard: [System] Scout handed the floor to you. It is your turn to reply in the group."],
    ]);
    // The scout catches up on the lead's answer since its own reply; the user's message is the turn's own text.
    await say(id, "@scout ECHO?");
    const next = await replies(id, 3);
    expect(next[2].agentId).toBe("scout");
    expect(textOf(next[2])).toBe(`fake saw: [${leadName}]: fake heard: [System] Scout handed the floor to you. It is your turn to reply in the group.`);
  });

  it("stops the member answering and drops the ones waiting", async () => {
    const id = await group();
    await say(id, "@all SLOW");
    await until(async () => ((await web.req("GET", "/api/groups")) as any[]).find((g) => g.conversationId === id && g.running && g.speaking[0] === "assistant"), "the lead to take the floor");
    expect((await web.req("GET", "/api/groups")).find((g: any) => g.conversationId === id).speaking).toEqual(["assistant", "scout"]);
    await until(() => hub.runner.floor(id).length && (hub.runner as any).activeTurns.has(id), "the lead's turn");
    expect((await web.req("POST", `/api/conversations/${id}/interrupt`, {})).interrupted).toBe(true);
    const r = await replies(id, 1);
    expect(r.map((m) => m.agentId)).toEqual(["assistant"]);
    await sleep(500);
    expect(((await web.req("GET", `/api/conversations/${id}/messages`)) as Message[]).filter((m) => m.role === "assistant")).toHaveLength(1);
    expect((await web.req("GET", "/api/groups")).find((g: any) => g.conversationId === id)).toMatchObject({ running: false, speaking: [] });
    // The next message is answered as usual.
    await say(id, "@scout still there?");
    expect((await replies(id, 2))[1]).toMatchObject({ agentId: "scout" });
  });

  it("shows the member answering on the hub's computer, and what it does", async () => {
    const id = await group(["assistant", "scout"], "Standup");
    await say(id, "SLOW");
    const here = await until(
      async () => ((await web.req("GET", "/api/machines/activity")) as MachineActivity[]).find((m) => m.id === "local" && m.work.some((w) => w.conversationId === id && w.step === "writing")),
      "the lead's turn on the hub's computer",
    );
    expect(here.online).toBe(true);
    expect(here.work.find((w) => w.conversationId === id)).toMatchObject({ agentId: "assistant", title: "Standup", brainId: "fake" });
    await web.req("POST", `/api/conversations/${id}/interrupt`, {});
    await until(async () => !((await web.req("GET", "/api/machines/activity")) as MachineActivity[]).some((m) => m.work.some((w) => w.conversationId === id)), "the turn to end");
  });

  it("keeps group chats out of the channels and shows them in the sidebar", async () => {
    const sent: any[] = [];
    const peer = { closed: false, request: async (_m: string, p: any) => (sent.push(p), {}) } as any;
    hub.channels.register("grp", "Group mirror", "group-test", peer);
    const seen: any[] = [];
    const off = hub.bus.on("group.updated", (g) => seen.push(g));
    try {
      const id = await group();
      await say(id, "@scout private plans");
      await replies(id, 1);
      expect(sent).toEqual([]);
      const g = ((await web.req("GET", "/api/groups")) as any[]).find((x) => x.conversationId === id);
      expect(g).toMatchObject({ running: false, unread: 1, lastMessage: { role: "assistant", agentId: "scout", text: "fake heard: @scout private plans" } });
      expect(seen.some((x) => x.conversationId === id && x.running)).toBe(true);
      await web.req("POST", `/api/conversations/${id}/read`, {});
      expect(((await web.req("GET", "/api/groups")) as any[]).find((x) => x.conversationId === id).unread).toBe(0);
    } finally {
      off();
    }
  });
});

describe("group chats (routing)", () => {
  const members = [
    { id: "assistant", name: "Owl" },
    { id: "scout", name: "Scout" },
    { id: "research-lead", name: "Research Lead" },
  ];

  it("finds mentions by id or name, in order, and @all in member order", () => {
    expect(parseMentions("@scout and @OWL, look", members)).toEqual(["scout", "assistant"]);
    expect(parseMentions("@Research Lead? and @research", members)).toEqual(["research-lead"]);
    expect(parseMentions("@research-lead", members)).toEqual(["research-lead"]);
    expect(parseMentions("ask @scout, then @scout again", members)).toEqual(["scout"]);
    expect(parseMentions("@scout @all", members)).toEqual(["assistant", "scout", "research-lead"]);
    expect(parseMentions("@все сюда", members)).toEqual(["assistant", "scout", "research-lead"]);
    expect(parseMentions("@all of you", members, { all: false })).toEqual([]);
    // Not mentions: e-mail addresses, longer words, code.
    expect(parseMentions("mail bob@scout.io or @scouting", members)).toEqual([]);
    expect(parseMentions("run `@scout` or\n```\n@owl\n```", members)).toEqual([]);
  });

  it("starts with the mentioned members, or else the lead", () => {
    expect(firstSpeakers("hi there", members)).toEqual(["assistant"]);
    expect(firstSpeakers("@scout hi", members)).toEqual(["scout"]);
  });

  it("hands off to mentioned members within the budget, never to the speaker", () => {
    expect(handOff(["scout"], "assistant", "@research-lead please", members, 3)).toEqual({ queue: ["research-lead", "scout"], added: ["research-lead"] });
    // Someone already waiting just moves up, without using the budget.
    expect(handOff(["scout", "research-lead"], "assistant", "@research-lead first", members, 0)).toEqual({ queue: ["research-lead", "scout"], added: [] });
    expect(handOff([], "assistant", "@scout @research-lead", members, 1)).toEqual({ queue: ["scout"], added: ["scout"] });
    expect(handOff([], "scout", "@scout @all", members, 3)).toEqual({ queue: [], added: [] });
  });

  const msg = (id: string, role: Message["role"], text: string, agentId?: string, at = id): Message => ({
    id,
    conversationId: "g",
    role,
    parts: [{ type: "text", text }],
    status: "complete",
    agentId,
    createdAt: `2026-10-27T10:00:${at.padStart(2, "0")}.000Z`,
  });
  const name = (id: string | undefined) => members.find((m) => m.id === id)?.name ?? "?";

  it("shows a member what it has not seen since its last reply, the user's message last", () => {
    const messages = [
      msg("1", "user", "first question"),
      msg("2", "assistant", "first answer", "assistant"),
      msg("3", "system", "[System] a note for someone"),
      msg("4", "assistant", "scout's take", "scout"),
      msg("5", "user", "@all next"),
    ];
    const lead = groupTurn({ messages, agentId: "assistant", name, prompt: "@all next", triggerId: "5" });
    expect(lead.lines).toEqual(["[Scout]: scout's take"]);
    expect(groupTurnText(lead)).toBe("[Scout]: scout's take\n\n@all next");

    // Second in line: the user's message stays in its place, and a note says whose turn it is.
    const after = [...messages, msg("6", "assistant", "lead's take", "assistant")];
    const scout = groupTurn({ messages: after, agentId: "scout", name, prompt: "@all next", triggerId: "5" });
    expect(scout.lines).toEqual(["[User]: @all next", "[Owl]: lead's take"]);
    expect(scout.tail).toBe("[System] It is your turn to reply to the user's message above.");

    // Never answered yet: everything so far (system notes left out).
    expect(groupTurn({ messages, agentId: "research-lead", name, prompt: "x" }).lines).toEqual(["[User]: first question", "[Owl]: first answer", "[Scout]: scout's take", "[User]: @all next"]);
  });

  it("holds back the user's later messages for their own round, and shows them afterwards", () => {
    const messages = [msg("1", "user", "one"), msg("2", "user", "two")];
    const first = groupTurn({ messages, agentId: "assistant", name, prompt: "one", triggerId: "1" });
    expect(first).toMatchObject({ lines: [], tail: "one", seenUserUpTo: messages[0].createdAt });
    // The scout answered "two" meanwhile; the lead's next turn (for "two") reads it, with "two" itself last.
    const later = [...messages, msg("3", "assistant", "lead on one", "assistant"), msg("4", "assistant", "scout on two", "scout")];
    const second = groupTurn({ messages: later, agentId: "assistant", name, prompt: "two", triggerId: "2", seenUserUpTo: first.seenUserUpTo });
    expect(second.lines).toEqual(["[User]: two", "[Scout]: scout on two"]);
    expect(second.tail).toBe("[System] It is your turn to reply to the user's message above.");
  });

  it("tells the other members about pictures and maps a member showed", () => {
    const shown = msg("2", "assistant", "Here it is.", "scout");
    shown.parts.push({ type: "images", items: [{ src: "https://a.b/1.jpg", caption: "North side" }, { src: "https://a.b/2.jpg" }] });
    shown.parts.push({ type: "map", lat: 48.8584, lon: 2.2945, title: "Eiffel Tower" });
    const t = groupTurn({ messages: [msg("1", "user", "@scout show me"), shown], agentId: "assistant", name, prompt: "x", floorNote: "[System] Your turn." });
    expect(t.lines[1]).toBe("[Scout]: Here it is. [showed 2 images: North side] [showed a map of Eiffel Tower at 48.8584, 2.2945]");
  });

  it("tells the member who handed it the floor, and trims long messages", () => {
    const long = "x".repeat(5000);
    const messages = [msg("1", "user", "@scout go"), msg("2", "assistant", `${long} @assistant`, "scout")];
    const t = groupTurn({ messages, agentId: "assistant", name, prompt: "@scout go", triggerId: "1", floorNote: "[System] Scout handed the floor to you." });
    expect(t.lines[0]).toBe("[User]: @scout go");
    expect(t.lines[1].length).toBeLessThan(1600);
    expect(t.tail).toBe("[System] Scout handed the floor to you.");
  });

  it("explains the group in the system prompt; other dialogs keep their wording", () => {
    const agent = { id: "scout", name: "Scout", prompt: "Scout around.", initiative: 1 } as AgentDef;
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://c", background: false, skills: [], nativeSkills: false, appended: [] };
    const p = buildSystemPrompt({ ...base, group: { title: "Launch", members: [{ id: "assistant", name: "Owl" }, { id: "scout", name: "Scout" }] } });
    expect(p).toContain('group chat "Launch"');
    expect(p).toContain("Owl (@assistant, the lead), Scout (@scout, you)");
    expect(p).toContain("`[Name]: text`");
    expect(p).toContain("e.g. @assistant");
    expect(p).not.toContain("There are no separate chats");
    expect(buildSystemPrompt(base)).toContain("There are no separate chats");
  });
});

describe("group chats (storage)", () => {
  it("stores members with the lead as the agent, and lists groups for the sidebar", async () => {
    const bus = new EventBus();
    const store = new Store(openDb(":memory:"), bus);
    const team = new Team({ store, agents: { list: () => [] }, bus, isRunning: () => false });
    const g = store.createConversation({ kind: "group", title: "Plan", agentId: "ignored", members: ["scout", "assistant"] });
    expect(g).toMatchObject({ kind: "group", agentId: "scout", members: ["scout", "assistant"] });
    expect(store.getConversation(g.id)).toMatchObject({ agentId: "scout", members: ["scout", "assistant"] });
    const chat = store.createConversation({ kind: "chat", title: "x", agentId: "assistant" });
    expect("members" in store.getConversation(chat.id)!).toBe(false);
    expect(store.listGroups().map((c) => c.id)).toEqual([g.id]);
    expect(store.listConversations().map((c) => c.id).sort()).toEqual([g.id, chat.id].sort());

    const events: any[] = [];
    bus.on("group.updated", (x) => events.push(x));
    expect(store.updateConversation(g.id, { members: ["assistant", "scout", "writer"] })).toMatchObject({ agentId: "assistant", members: ["assistant", "scout", "writer"] });
    await new Promise((r) => setImmediate(r));
    expect(events.at(-1)).toMatchObject({ conversationId: g.id, members: ["assistant", "scout", "writer"], running: false, unread: 0 });
    expect(team.listGroups().map((x) => x.conversationId)).toEqual([g.id]);
  });

  it("adds the members column to an older database, keeping its conversations", () => {
    const file = join(mkdtempSync(join(tmpdir(), "owl-group-db-")), "piomio.db");
    const old = openDb(file);
    // Schema 6: phones' devices, before group chats.
    old.exec("alter table conversations drop column members; alter table tasks drop column question; alter table tasks drop column kind; alter table tasks drop column tainted; alter table tasks drop column from_agent; drop table invites; drop table feeds; drop table feed_posts; alter table tasks drop column feed_id; alter table conversations drop column purpose; alter table conversations drop column entity; drop table pages; alter table approvals drop column ask; alter table tasks drop column thinking; alter table messages drop column model; alter table messages drop column effort; drop table machine_settings; drop table machine_spend; drop table replicas; alter table secret_requests drop column login; alter table tasks drop column skill; drop index notifications_kind; alter table notifications drop column kind; alter table notifications drop column reason; alter table notifications drop column message_id; alter table notifications drop column read_at; alter table notifications drop column digest_id; alter table notifications drop column superseded_by; alter table tasks drop column deliver; drop table skill_agents; update schema_version set v = 6;");
    old.prepare("insert into conversations(id, kind, title, agent_id, created_at, updated_at) values ('c1', 'chat', 'Old', 'assistant', ?, ?)").run("2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z");
    old.close();

    const store = new Store(openDb(file), new EventBus());
    expect(store.getConversation("c1")).toMatchObject({ kind: "chat", title: "Old", agentId: "assistant" });
    const g = store.createConversation({ kind: "group", title: "New", agentId: "assistant", members: ["assistant", "scout"] });
    expect(store.getConversation(g.id)?.members).toEqual(["assistant", "scout"]);
    store.db.close();
  });

  it("repairs a database from the desktop builds that ran the group chats' migration before the phones' one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "owl-group-db-")), "piomio.db");
    const old = openDb(file);
    // What those builds left: version 6 with the members column, no phones' tables.
    old.exec("drop table devices; drop table device_pairing_codes; alter table tasks drop column question; alter table tasks drop column kind; alter table tasks drop column tainted; alter table tasks drop column from_agent; drop table invites; drop table feeds; drop table feed_posts; alter table tasks drop column feed_id; alter table conversations drop column purpose; alter table conversations drop column entity; drop table pages; alter table approvals drop column ask; alter table tasks drop column thinking; alter table messages drop column model; alter table messages drop column effort; drop table machine_settings; drop table machine_spend; drop table replicas; alter table secret_requests drop column login; alter table tasks drop column skill; drop index notifications_kind; alter table notifications drop column kind; alter table notifications drop column reason; alter table notifications drop column message_id; alter table notifications drop column read_at; alter table notifications drop column digest_id; alter table notifications drop column superseded_by; alter table tasks drop column deliver; drop table skill_agents; update schema_version set v = 6;");
    old.prepare("insert into conversations(id, kind, title, agent_id, members, created_at, updated_at) values ('g1', 'group', 'Trip', 'assistant', ?, ?, ?)").run('["assistant","scout"]', "2026-10-27T01:00:00.000Z", "2026-10-27T01:00:00.000Z");
    old.close();

    const db = openDb(file);
    expect(db.prepare("select v from schema_version").get()).toEqual({ v: 21 });
    expect(db.prepare("select count(*) as n from devices").get()).toEqual({ n: 0 });
    expect(new Store(db, new EventBus()).getConversation("g1")?.members).toEqual(["assistant", "scout"]);
    db.close();
  });
});
