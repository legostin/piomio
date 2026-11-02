// Channels (feeds.ts): the schedule in the user's time zone, a channel's first run and the editor's goal, posts the
// hub refuses (repeats, too many in a run), unread counts, and end to end through the API and the editor's tools:
// the fake brain posts with feed_post inside the channel's run, in the channel's own folder.
// Uses the scripted fake brain (test/fixtures/plugins/fakebrain): "CALL <tool> <json>".
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feed, FeedPost, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { Feeds, nextRun } from "../src/feeds.ts";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Settings } from "../src/settings.ts";
import type { AgentRegistry } from "../src/agents.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a channel's schedule", () => {
  it("is the next local time on an allowed day, in the user's time zone", () => {
    // 2026-10-28 is a Wednesday; Almaty is UTC+5.
    const at = (iso: string) => new Date(iso);
    expect(nextRun(["08:00", "19:00"], [], "Asia/Almaty", at("2026-10-28T02:00:00Z"))?.toISOString()).toBe("2026-10-28T03:00:00.000Z");
    expect(nextRun(["08:00", "19:00"], [], "Asia/Almaty", at("2026-10-28T03:00:00Z"))?.toISOString()).toBe("2026-10-28T14:00:00.000Z");
    expect(nextRun(["19:00", "08:00"], [], "Asia/Almaty", at("2026-10-28T15:00:00Z"))?.toISOString()).toBe("2026-10-29T03:00:00.000Z");
    // Mondays only: from Wednesday to next Monday.
    expect(nextRun(["09:00"], [1], "Asia/Almaty", at("2026-10-28T02:00:00Z"))?.toISOString()).toBe("2026-11-02T04:00:00.000Z");
    // Summer time: Berlin is UTC+2 before 25 October 2026 and UTC+1 after.
    expect(nextRun(["08:00"], [], "Europe/Berlin", at("2026-10-24T12:00:00Z"))?.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    expect(nextRun(["08:00"], [], "Europe/Berlin", at("2026-10-23T12:00:00Z"))?.toISOString()).toBe("2026-10-24T06:00:00.000Z");
    expect(nextRun([], [], "UTC", at("2026-10-28T00:00:00Z"))).toBeUndefined();
  });
});

// The hub on several machines (cluster.ts): the Mac leads and sleeps, the VPS leads meanwhile and gathers the channel,
// and the Mac wakes still leading. A sleeping computer's wall clock runs on while its timers stand still: here
// `vi.setSystemTime` moves the wall clock alone, and advancing the timers moves both.
describe("a channel's time on a replica that slept through it", () => {
  const clocks = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] as Array<"setTimeout"> };
  afterEach(() => vi.useRealTimers());

  /** A channel gathered at 12:00 Almaty (07:00 UTC) on a Mac that sleeps from 11:59 to 12:02:54 and then ticks. */
  function sleptThrough() {
    vi.useFakeTimers(clocks);
    vi.setSystemTime(new Date("2026-10-31T06:59:00Z"));
    const db = openDb(":memory:");
    const created: string[] = [];
    const feeds = new Feeds({
      db,
      bus: new EventBus(),
      settings: new Settings(db, "Asia/Almaty"),
      agents: { get: (id: string) => ({ id }), list: () => [], isArchived: () => false } as unknown as AgentRegistry,
      createTask: (t) => {
        created.push(t.feedId);
        return { id: `task_${created.length}`, createdAt: new Date().toISOString() } as Task;
      },
      getTask: () => undefined,
    });
    const f = feeds.create({ brief: "Video game news", times: ["12:00"] }, { run: false });
    expect(f.nextRunAt).toBe("2026-10-31T07:00:00.000Z");
    feeds.tick();
    vi.setSystemTime(new Date("2026-10-31T07:02:54Z"));
    feeds.tick();
    const later = (ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        vi.advanceTimersByTime(30_000);
        feeds.tick();
      }
    };
    return { db, feeds, created, id: f.id, later };
  }

  it("waits for what the replica that led meanwhile wrote, and does not gather it again", () => {
    const { db, created, id, later } = sleptThrough();
    expect(created).toHaveLength(0);
    // The VPS's run, replicated seconds after the wake.
    db.prepare("update feeds set last_run_at = ?, next_run_at = ? where id = ?").run("2026-10-31T07:00:21.000Z", "2026-11-01T07:00:00.000Z", id);
    later(5);
    expect(created).toHaveLength(0);
  });

  it("waits as well for a time that comes right after it woke, while the other replica may still lead", () => {
    vi.useFakeTimers(clocks);
    vi.setSystemTime(new Date("2026-10-31T06:58:00Z"));
    const db = openDb(":memory:");
    const created: string[] = [];
    const feeds = new Feeds({
      db,
      bus: new EventBus(),
      settings: new Settings(db, "Asia/Almaty"),
      agents: { get: (id: string) => ({ id }), list: () => [], isArchived: () => false } as unknown as AgentRegistry,
      createTask: (t) => {
        created.push(t.feedId);
        return { id: `task_${created.length}`, createdAt: new Date().toISOString() } as Task;
      },
      getTask: () => undefined,
    });
    const f = feeds.create({ brief: "Video game news", times: ["12:00"] }, { run: false });
    feeds.tick();
    vi.setSystemTime(new Date("2026-10-31T06:59:50Z")); // asleep until 11:59:50
    feeds.tick();
    vi.advanceTimersByTime(30_000);
    feeds.tick(); // 12:00:20
    expect(created).toHaveLength(0);
    db.prepare("update feeds set next_run_at = ? where id = ?").run("2026-11-01T07:00:00.000Z", f.id);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000);
      feeds.tick();
    }
    expect(created).toHaveLength(0);
  });

  it("gathers a time it slept through once, after the wait, when no other replica did", () => {
    const { feeds, created, id, later } = sleptThrough();
    later(1);
    expect(created).toHaveLength(0);
    later(1);
    expect(created).toEqual([id]);
    later(5);
    expect(created).toHaveLength(1);
    expect(feeds.get(id)!.nextRunAt).toBe("2026-11-01T07:00:00.000Z");
  });
});

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
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("channels (integration)", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";

  const req = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : undefined };
  };
  const call = async (name: string, input: unknown, ctx: { taskId?: string } = {}) => {
    const r = await hub.tools.get(name)!.invoke(input, { sessionId: "s", agentId: "assistant", callId: "c", tainted: false, background: false, workspace: "", machineId: "local", conversationId: "c", ...ctx });
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError };
  };
  const runOf = (feedId: string): Task | undefined => hub.store.listTasks({ limit: 200 }).find((t) => t.feedId === feedId);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-feeds-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    await req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    csrf = (await req("GET", "/api/bootstrap")).json.csrf;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("makes a channel from the user's words, starts its first run with the editor's goal, and checks what it is given", async () => {
    expect((await req("POST", "/api/feeds", { brief: "" })).status).toBe(400);
    expect((await req("POST", "/api/feeds", { brief: "x", times: ["25:00"] })).status).toBe(400);
    expect((await req("POST", "/api/feeds", { brief: "x", agentId: "nobody", times: ["08:00"], weekdays: [9] })).status).toBe(400);

    const made = await req("POST", "/api/feeds", { brief: "Local AI models and agents. Only big releases, no hype.", times: ["19:00", "08:00"] });
    expect(made.status).toBe(200);
    const f = made.json as Feed;
    expect(f).toMatchObject({ title: "Local AI models and agents", agentId: "assistant", times: ["08:00", "19:00"], weekdays: [], sources: [], enabled: true, unread: 0 });
    expect(f.nextRunAt).toBeDefined();
    // The first run: a background task for the editor, in the channel's own folder.
    const run = await until(() => runOf(f.id), "the first run");
    expect(run).toMatchObject({ agentId: "assistant", background: true, createdBy: "trigger", title: "Channel “Local AI models and agents”" });
    expect(run.goal).toMatch(/^You edit the user's channel “Local AI models and agents” \(feed f_\S+\)/);
    expect(run.goal).toContain("This is the channel's first run: find good sources for it.");
    expect(run.goal).toContain("Only big releases, no hype.");
    await until(() => !["queued", "running"].includes(hub.store.getTask(run.id)!.status), "the run to end");
    expect(existsSync(join(hub.config.dataDir, "workspaces", "assistant", `feed-${f.id}`))).toBe(true);
    // "Refresh" while a run is going is that run; after it, a new one.
    const again = hub.feeds.run(f.id);
    expect(again.id).not.toBe(run.id);
    expect(hub.feeds.run(f.id).id).toBe(again.id);
    expect((await req("POST", `/api/feeds/${f.id}/run`)).json.taskId).toBe(again.id);
    await until(() => !["queued", "running"].includes(hub.store.getTask(again.id)!.status), "the second run to end");
  });

  it("takes the editor's posts once, counts them unread, and shows them to every agent", async () => {
    const f = (await req("POST", "/api/feeds", { brief: "Kazakhstan tech news", title: "KZ tech", times: ["09:00"] })).json as Feed;
    await until(() => runOf(f.id) && !["queued", "running"].includes(runOf(f.id)!.status), "the first run to end");
    const run = runOf(f.id)!;
    expect((await call("feed_sources", { sources: ["rss https://example.kz/feed.xml", "  ", "search kz startups"] }, { taskId: run.id })).text).toBe("Sources of “KZ tech” saved (2).");
    expect(await call("feed_post", { title: "", text: "x" }, { taskId: run.id })).toMatchObject({ isError: true, text: "Give a title and a text." });
    expect(await call("feed_post", { title: "A", text: "b", url: "javascript:alert(1)" }, { taskId: run.id })).toMatchObject({ isError: true });
    expect(await call("feed_post", { title: "Kaspi opens an AI lab", text: "In Almaty.", url: "https://example.kz/a", source: "Example" }, { taskId: run.id })).toEqual({ isError: false, text: "Posted in “KZ tech”." });
    expect((await call("feed_post", { title: "Other title", text: "x", url: "https://example.kz/a" }, { taskId: run.id })).text).toBe("Already posted: https://example.kz/a");
    expect((await call("feed_post", { feed: "KZ tech", title: "kaspi opens an AI LAB", text: "again" })).text).toBe("Already posted: “kaspi opens an AI LAB”");
    await call("feed_post", { feed: f.id, title: "Second", text: "**bold** news", image: "https://example.kz/p.jpg" });

    const view = (await req("GET", `/api/feeds/${f.id}`)).json as Feed;
    expect(view).toMatchObject({ unread: 2, sources: ["rss https://example.kz/feed.xml", "search kz startups"], lastPost: { title: "Second" } });
    const posts = (await req("GET", `/api/feeds/${f.id}/posts`)).json as FeedPost[];
    expect(posts.map((p) => p.title)).toEqual(["Second", "Kaspi opens an AI lab"]);
    expect(posts[1]).toMatchObject({ url: "https://example.kz/a", source: "Example", text: "In Almaty." });
    expect((await req("GET", `/api/feeds/${f.id}/posts?limit=1&before=${posts[0].id}`)).json.map((p: FeedPost) => p.title)).toEqual(["Kaspi opens an AI lab"]);

    // Every agent can see the channels and read them.
    expect((await call("feed_list", {})).text).toMatch(new RegExp(`- ${f.id} “KZ tech”, edited by [^:]+: 09:00 daily; 2 unread, last post .* “Second”\\n  About: Kazakhstan tech news`));
    expect((await call("feed_read", { feed: "kz tech", limit: 1 })).text).toMatch(/^- \[p_\S+\] .+ “Second”\n  \*\*bold\*\* news$/);
    expect((await call("feed_read", { feed: "nope" })).isError).toBe(true);

    expect((await req("POST", `/api/feeds/${f.id}/read`)).status).toBe(200);
    expect(((await req("GET", `/api/feeds/${f.id}`)).json as Feed).unread).toBe(0);
  });

  it("shows news as cards in the chat, from a channel's posts and from what the agent found", async () => {
    const f = (await req("POST", "/api/feeds", { brief: "Cards", title: "Cards", times: ["09:00"], enabled: false })).json as Feed;
    await call("feed_post", { feed: f.id, title: "From the channel", text: "A post.", url: "https://example.com/1", source: "Ex" });
    const [post] = (await req("GET", `/api/feeds/${f.id}/posts`)).json as FeedPost[];
    const main = (await req("GET", "/api/bootstrap")).json.mainConversationId as string;
    const args = { title: "Morning news", posts: [post.id, "p_missing"], items: [{ title: "Found myself", url: "https://news.example/x", image: "ftp://no" }, { text: "no title" }] };
    await req("POST", `/api/conversations/${main}/messages`, { text: `CALL show_news ${JSON.stringify(args)}` });
    const card = await until(async () => {
      const msgs = (await req("GET", `/api/conversations/${main}/messages`)).json as Array<{ parts: any[] }>;
      return msgs.flatMap((m) => m.parts).find((p) => p.type === "news");
    }, "the news card");
    expect(card).toEqual({
      type: "news",
      title: "Morning news",
      feedId: f.id,
      items: [
        { title: "From the channel", text: "A post.", url: "https://example.com/1", source: "Ex", at: post.createdAt },
        { title: "Found myself", url: "https://news.example/x" },
      ],
    });
    expect(await call("show_news", { posts: ["p_none"] })).toMatchObject({ isError: true });
  });

  it("is made in the chat: quick replies come back as the person's words, and the channel's card shows under the reply", async () => {
    const main = (await req("GET", "/api/bootstrap")).json.mainConversationId as string;
    const replies = async () => ((await req("GET", `/api/conversations/${main}/messages`)).json as Array<{ id: string; role: string; parts: any[] }>);
    await req("POST", `/api/conversations/${main}/messages`, { text: `CALL show_choices {"options":["Утром","Утром и вечером"," "]}` });
    const asked = await until(async () => (await replies()).find((m) => m.parts.some((p) => p.type === "choices")), "the buttons");
    expect(asked.parts.find((p) => p.type === "choices")).toEqual({ type: "choices", options: ["Утром", "Утром и вечером"] });
    await until(async () => !hub.runner.isRunning(main), "the turn to end");

    const chose = await req("POST", `/api/messages/${asked.id}/choose`, { index: 1 });
    expect(chose.status).toBe(200);
    expect(chose.json).toMatchObject({ role: "user", parts: [{ type: "text", text: "Утром и вечером" }] });
    expect((await replies()).find((m) => m.id === asked.id)!.parts.find((p) => p.type === "choices").chosen).toBe(1);
    expect((await req("POST", `/api/messages/${asked.id}/choose`, { index: 0 })).status).toBe(409);
    await until(async () => !hub.runner.isRunning(main), "the reply to end");

    await req("POST", `/api/conversations/${main}/messages`, { text: `CALL feed_create {"brief":"Steppe startups","times":["08:00","19:00"]}` });
    const card = await until(async () => (await replies()).flatMap((m) => m.parts).find((p) => p.type === "feed"), "the channel's card");
    expect(hub.feeds.get(card.feedId)).toMatchObject({ title: "Steppe startups", times: ["08:00", "19:00"] });
    await until(async () => !hub.runner.isRunning(main), "the turn to end");
  });

  it("gives its editor the channel's tools in a run whatever the agent's own list, and the chat's show tools everywhere", async () => {
    await req("PUT", "/api/agents/narrow", { name: "Narrow", description: "", brains: ["fake@local"], prompt: "", tools: ["memory_*"] });
    const f = (await req("POST", "/api/feeds", { brief: "Narrow news", agentId: "narrow", times: ["09:00"] })).json as Feed;
    const run = await until(() => runOf(f.id), "the run");
    await until(() => !["queued", "running"].includes(hub.store.getTask(run.id)!.status), "the run to end");
    const inRun = hub.gateway.listFor(hub.store.activeSession(run.conversationId, "narrow")!).map((t) => t.name);
    expect(inRun).toEqual(expect.arrayContaining(["feed_post", "feed_sources", "feed_update"]));
    expect(inRun).not.toContain("feed_create");

    const dialog = hub.store.agentConversation("narrow");
    await req("POST", `/api/conversations/${dialog.id}/messages`, { text: "hi" });
    await until(() => hub.store.activeSession(dialog.id, "narrow"), "the dialog's session");
    const inChat = hub.gateway.listFor(hub.store.activeSession(dialog.id, "narrow")!).map((t) => t.name);
    expect(inChat).toEqual(expect.arrayContaining(["show_choices", "show_map", "feed_show"]));
    expect(inChat).not.toContain("feed_post");
  });

  it("is made in a setup chat that asks at once and then becomes the channel's settings chat; an agent's too", async () => {
    const made = await req("POST", "/api/setup-chats", { purpose: "feed" });
    expect(made.status).toBe(200);
    const chat = made.json as { id: string; kind: string; purpose: string; title: string };
    expect(chat).toMatchObject({ kind: "setup", purpose: "feed", title: "New channel" });
    const msgs = async (id: string) => (await req("GET", `/api/conversations/${id}/messages`)).json as Array<{ role: string; parts: any[] }>;
    expect((await msgs(chat.id))[0]).toMatchObject({ role: "assistant", parts: [{ type: "text", text: expect.stringMatching(/^What should the channel follow\?/) }] });
    expect((await req("POST", "/api/setup-chats", { purpose: "nonsense" })).status).toBe(400);

    await req("POST", `/api/conversations/${chat.id}/messages`, { text: `CALL feed_create {"brief":"Steppe hiking trails","times":["08:00"]}` });
    const became = await until(() => hub.store.getConversation(chat.id)?.entity, "the chat to become the channel");
    expect(hub.feeds.get(became)).toMatchObject({ title: "Steppe hiking trails", chatId: chat.id });
    await until(() => !hub.runner.isRunning(chat.id), "the turn to end");

    const agentChat = (await req("POST", "/api/setup-chats", { purpose: "agent" })).json as { id: string };
    await req("POST", `/api/conversations/${agentChat.id}/messages`, { text: `CALL hub_agent_draft {"name":"Hiker","description":"Plans hikes.","prompt":"You plan hikes.","create":true}` });
    const agentId = await until(() => hub.store.getConversation(agentChat.id)?.entity, "the chat to become the agent");
    expect(hub.agents.get(agentId)).toMatchObject({ name: "Hiker" });
    await until(() => !hub.runner.isRunning(agentChat.id), "the turn to end");

    // One left without making anything goes after a day; the made ones stay.
    const left = hub.setupChats.start("feed", "en");
    expect(hub.setupChats.sweep(Date.now() + 25 * 3600_000)).toBe(1);
    expect(hub.store.getConversation(left.id)).toBeUndefined();
    expect(hub.store.getConversation(chat.id)).toBeDefined();
  });

  it("is made, renamed, paused and deleted by agents and the user", async () => {
    const made = await call("feed_create", { brief: "Weekly digest of Almaty events", times: ["10:00"], weekdays: [6] });
    expect(made.text).toMatch(/^Channel f_\S+ “Weekly digest of Almaty events” made, edited by .*, gathered at 10:00\. Its first run has started/);
    const id = /Channel (f_\S+)/.exec(made.text)![1];
    expect((await call("feed_update", { feed: id, title: "Almaty weekend", enabled: false })).text).toBe("Channel “Almaty weekend” updated.");
    const paused = (await req("GET", `/api/feeds/${id}`)).json as Feed;
    expect(paused).toMatchObject({ title: "Almaty weekend", enabled: false, weekdays: [6] });
    expect(paused.nextRunAt).toBeUndefined();
    expect((await req("PATCH", `/api/feeds/${id}`, { enabled: true, times: ["11:00"] })).json).toMatchObject({ enabled: true, times: ["11:00"] });
    expect((await req("DELETE", `/api/feeds/${id}`)).status).toBe(200);
    expect((await req("GET", `/api/feeds/${id}`)).status).toBe(404);
  });

  it("gathers a channel when its time comes, once, and not while a run is still going", async () => {
    const f = (await req("POST", "/api/feeds", { brief: "Due soon", times: ["06:00"], enabled: false })).json as Feed;
    expect(runOf(f.id)).toBeUndefined();
    await req("PATCH", `/api/feeds/${f.id}`, { enabled: true });
    const due = new Date(Date.parse(((await req("GET", `/api/feeds/${f.id}`)).json as Feed).nextRunAt!) + 1000);
    hub.feeds.tick(due);
    const first = await until(() => runOf(f.id), "the scheduled run");
    hub.feeds.tick(due);
    expect(hub.store.listTasks({ limit: 200 }).filter((t) => t.feedId === f.id)).toHaveLength(1);
    expect(Date.parse(((await req("GET", `/api/feeds/${f.id}`)).json as Feed).nextRunAt!)).toBeGreaterThan(due.getTime());
    await until(() => !["queued", "running"].includes(hub.store.getTask(first.id)!.status), "the run to end");
  });
});
