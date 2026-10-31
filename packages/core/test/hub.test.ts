// End-to-end tests of the hub with a scripted brain plugin (test/fixtures/plugins/fakebrain).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { createCoreCall } from "../src/core-call.ts";

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
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

/** Minimal browser-like client: one cookie jar, Origin header, CSRF header when known. */
class Client {
  cookie = "";
  csrf = "";
  base: string;
  origin: string;
  constructor(base: string, origin = base) {
    this.base = base;
    this.origin = origin;
  }
  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.origin ? { origin: this.origin } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { "x-csrf": this.csrf } : {}),
        ...headers,
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
  /** Raw bytes, as the web's file upload sends them. */
  async upload(path: string, data: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const r = await fetch(this.base + path, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: this.origin, cookie: this.cookie, "x-csrf": this.csrf, ...headers },
      body: data,
    });
    const text = await r.text();
    try {
      return { status: r.status, json: JSON.parse(text) };
    } catch {
      return { status: r.status, json: text };
    }
  }
  async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
}

describe("hub (integration)", () => {
  let hub: Hub;
  let web: Client;
  let consoleClient: Client;
  let conv: string;

  const lastReply = async (conversationId: string, match: RegExp) =>
    until(async () => {
      const msgs: any[] = await web.req("GET", `/api/conversations/${conversationId}/messages`);
      return msgs.find((m) => m.role === "assistant" && m.status !== "streaming" && m.parts.some((p: any) => p.type === "text" && match.test(p.text)));
    }, `reply matching ${match}`);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-hub-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    consoleClient = new Client(config.consoleUrl);
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2@local"), "fake brains to register");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("requires setup token, session cookie, CSRF and same Origin", async () => {
    expect((await web.raw("GET", "/api/bootstrap")).status).toBe(401);
    expect((await web.raw("POST", "/api/auth/setup", { token: "wrong", password: "integration-pass-1" })).status).toBeGreaterThanOrEqual(400);
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await web.req("GET", "/api/bootstrap");
    conv = boot.mainConversationId;

    expect((await web.raw("POST", "/api/conversations", { title: "x" })).status).toBe(403); // no CSRF yet
    web.csrf = boot.csrf;
    expect((await web.raw("POST", "/api/conversations", { title: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    // `Origin: null` (the page's no-referrer policy on an XMLHttpRequest) passes only when the browser vouches for it.
    expect((await web.raw("POST", "/api/conversations", { title: "x" }, { origin: "null" })).status).toBe(403);
    expect((await web.raw("POST", "/api/conversations", { title: "x" }, { origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await web.raw("POST", "/api/conversations", { title: "x" }, { origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await web.raw("POST", "/api/conversations", { title: "x" }, { origin: "https://evil.example", "sec-fetch-site": "same-origin" })).status).toBe(403);
    expect((await web.raw("POST", "/api/conversations", { title: "x" })).status).toBe(200);
    await web.req("PATCH", "/api/settings", { approvalInlineWaitSec: 1 });
  });


  it("signs the desktop app's window in with a one-time ticket", async () => {
    const ticket = "t".repeat(43);
    hub.desktopTickets.add(ticket);
    const app = new Client(hub.config.publicUrl);
    expect((await app.raw("POST", "/api/auth/desktop", { ticket }, { origin: "https://evil.example" })).status).toBe(403);
    await app.req("POST", "/api/auth/desktop", { ticket });
    expect((await app.raw("GET", "/api/bootstrap")).status).toBe(200);
    const other = new Client(hub.config.publicUrl);
    expect((await other.raw("POST", "/api/auth/desktop", { ticket })).status).toBe(401);
    expect((await other.raw("POST", "/api/auth/desktop", { ticket: "nope" })).status).toBe(401);
  });
  it("runs a chat turn on the first brain", async () => {
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: "hello there" });
    const m = await lastReply(conv, /fake heard: hello there/);
    expect(m.brainRef).toBe("fake@local");
  });

  it("tells a brain session the current time on its first turn, not on every turn", async () => {
    const c = await web.req("POST", "/api/conversations", { title: "time" });
    await web.req("POST", `/api/conversations/${c.id}/messages`, { text: "TIME?" });
    await lastReply(c.id, /^fake time: \[Now: \w+day, \d{1,2} \w+ \d{4}, \d\d:\d\d \([^)]+\)\]$/);
    await web.req("POST", `/api/conversations/${c.id}/messages`, { text: "TIME?" });
    await lastReply(c.id, /^fake time: none$/);
  });

  it("takes files with a message and hands the brain their paths and a note", async () => {
    const c = await web.req("POST", "/api/conversations", { title: "files" });
    const up = await web.upload(`/api/conversations/${c.id}/attachments?name=${encodeURIComponent("чек.jpg")}&type=image/jpeg`, Buffer.from("jpeg bytes"));
    expect(up.status).toBe(200);
    expect(up.json).toEqual({ type: "attachment", path: `assistant/${c.id}/attachments/чек.jpg`, name: "чек.jpg", mimeType: "image/jpeg", size: 10 });
    await web.req("POST", `/api/conversations/${c.id}/messages`, { text: "what is this?", attachments: [up.json.path] });
    const r = await lastReply(c.id, /fake files:/);
    expect(r.parts.find((p: any) => p.type === "text").text).toBe(
      "fake files: attachments/чек.jpg:here | note: [The user attached a file, saved in your working folder: / - attachments/чек.jpg (image/jpeg, 10 B) / Open it with your file tools when the request needs it.]",
    );
    const msgs: any[] = await web.req("GET", `/api/conversations/${c.id}/messages`);
    expect(msgs.find((m) => m.role === "user").parts).toEqual([{ type: "text", text: "what is this?" }, up.json]);
    expect((await web.raw("GET", `/api/files?path=${encodeURIComponent(up.json.path)}`)).json).toBe("jpeg bytes");
  });

  it("sends files without words, and refuses files that are not the conversation's, too many or too large", async () => {
    const c = await web.req("POST", "/api/conversations", { title: "only files" });
    const other = await web.req("POST", "/api/conversations", { title: "other" });
    const a = (await web.upload(`/api/conversations/${c.id}/attachments?name=a.pdf`, Buffer.from("%PDF"))).json;
    await web.req("POST", `/api/conversations/${c.id}/messages`, { attachments: [a.path] });
    await lastReply(c.id, /^fake files: attachments\/a\.pdf:here \| note: \[The user attached a file/);
    const refused = async (id: string, body: unknown) => (await web.raw("POST", `/api/conversations/${id}/messages`, body)).json.error;
    expect(await refused(other.id, { attachments: [a.path] })).toBe("This file is not an attachment of the conversation");
    expect(await refused(c.id, { attachments: [`assistant/${c.id}/attachments/../../x`] })).toBe("This file is not an attachment of the conversation");
    expect(await refused(c.id, { attachments: Array.from({ length: 11 }, (_, i) => `p${i}`) })).toBe("At most 10 files per message");
    expect(await refused(c.id, { text: "  " })).toBe("The message is empty");
    // The hub answers from the declared length, before the body: send its start only.
    const big = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(
        `${hub.config.publicUrl}/api/conversations/${c.id}/attachments?name=big.bin`,
        { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(25 * 1024 * 1024 + 1), origin: web.origin, cookie: web.cookie, "x-csrf": web.csrf } },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            req.destroy();
            resolve({ status: res.statusCode!, json: JSON.parse(body) });
          });
        },
      );
      req.on("error", reject);
      req.write(Buffer.alloc(1024));
    });
    expect(big).toEqual({ status: 413, json: { error: "The file is larger than 25 MB" } });
    expect((await web.upload(`/api/conversations/${c.id}/attachments?name=x.txt`, Buffer.from("x"), { "x-csrf": "wrong" })).status).toBe(403);
    expect((await web.upload(`/api/conversations/${c.id}/attachments?name=x.txt`, Buffer.alloc(0))).json.error).toBe("The file is empty");
    expect((await web.upload("/api/conversations/nope/attachments?name=x.txt", Buffer.from("x"))).status).toBe(404);
  });

  it("serves workspace files sandboxed: an uploaded page cannot run script on the hub's origin", async () => {
    const c = await web.req("POST", "/api/conversations", { title: "page" });
    const page = (await web.upload(`/api/conversations/${c.id}/attachments?name=evil.html`, Buffer.from("<script>fetch('/api/bootstrap')</script>"))).json;
    const r = await fetch(`${hub.config.publicUrl}/api/files?path=${encodeURIComponent(page.path)}`, { headers: { cookie: web.cookie } });
    expect(r.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const pdf = (await web.upload(`/api/conversations/${c.id}/attachments?name=doc.pdf`, Buffer.from("%PDF-1.4"))).json;
    const p = await fetch(`${hub.config.publicUrl}/api/files?path=${encodeURIComponent(pdf.path)}`, { headers: { cookie: web.cookie } });
    expect(p.headers.get("content-type")).toBe("application/pdf");
    expect(p.headers.get("content-security-policy")).toBeNull();
  });

  it("serves workspace files with their length, as byte ranges and as 304 when unchanged", async () => {
    const c = await web.req("POST", "/api/conversations", { title: "ranges" });
    const clip = (await web.upload(`/api/conversations/${c.id}/attachments?name=${encodeURIComponent("клип.mp4")}`, Buffer.from("0123456789"))).json;
    const url = `${hub.config.publicUrl}/api/files?path=${encodeURIComponent(clip.path)}`;
    const whole = await fetch(url, { headers: { cookie: web.cookie } });
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("content-length")).toBe("10");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    const etag = whole.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    const part = await fetch(url, { headers: { cookie: web.cookie, range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect(await (await fetch(url, { headers: { cookie: web.cookie, range: "bytes=-3" } })).text()).toBe("789");
    expect((await fetch(url, { headers: { cookie: web.cookie, range: "bytes=20-" } })).status).toBe(416);
    // A range for another version of the file gets the whole file.
    expect((await fetch(url, { headers: { cookie: web.cookie, range: "bytes=0-1", "if-range": '"old"' } })).status).toBe(200);
    expect((await fetch(url, { headers: { cookie: web.cookie, "if-none-match": etag } })).status).toBe(304);
    const saved = await fetch(`${url}&download=1`, { headers: { cookie: web.cookie } });
    expect(saved.headers.get("content-disposition")).toBe(`attachment; filename="____.mp4"; filename*=UTF-8''${encodeURIComponent("клип.mp4")}`);
  });

  it("takes back a file that was uploaded and not sent, and keeps a sent one", async () => {
    const c = await web.req("POST", "/api/conversations", { title: "take back" });
    const kept = (await web.upload(`/api/conversations/${c.id}/attachments?name=kept.png`, Buffer.from("png"))).json;
    const dropped = (await web.upload(`/api/conversations/${c.id}/attachments?name=dropped.png`, Buffer.from("png"))).json;
    await web.req("POST", `/api/conversations/${c.id}/messages`, { attachments: [kept.path] });
    const discard = (path: string) => web.req("DELETE", `/api/conversations/${c.id}/attachments?path=${encodeURIComponent(path)}`);
    expect(await discard(kept.path)).toEqual({ removed: false });
    expect(await discard(dropped.path)).toEqual({ removed: true });
    expect(await discard(`assistant/${c.id}/attachments/../../x`)).toEqual({ removed: false });
    expect((await web.raw("GET", `/api/files?path=${encodeURIComponent(dropped.path)}`)).status).toBe(404);
    expect((await web.raw("GET", `/api/files?path=${encodeURIComponent(kept.path)}`)).status).toBe(200);
  });

  it("takes a channel's files inline (a Telegram voice note)", async () => {
    const call = createCoreCall(hub);
    const voice = { data: Buffer.from("OggS voice").toString("base64"), mimeType: "audio/ogg", kind: "voice", durationSec: 12 };
    const r = (await call("fakebrain", "channels.inbound", { channel: "test", text: "", files: [voice] })) as any;
    const m = await lastReply(r.conversationId, /^fake files: attachments\/voice-\d{8}-\d{6}\.ogg:here \| note: .*\(audio\/ogg, 10 B, voice message 0:12\)/);
    expect(m.channel).toBe("test");
    const huge = { data: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") };
    await expect(call("fakebrain", "channels.inbound", { channel: "test", text: "x", files: [huge] })).rejects.toThrow(/too large/);
    expect(await call("fakebrain", "channels.inbound", { channel: "test", text: " ", files: [] })).toEqual({ ignored: true });
    // Context for the model only: the brain reads it before the words, the chat shows the words alone.
    const own = await web.req("POST", "/api/conversations", { title: "forwarded" });
    const fwd = (await call("fakebrain", "channels.inbound", { channel: "test", conversationId: own.id, text: "ECHO? forwarded", context: "[Forwarded from Оля]" })) as any;
    await lastReply(fwd.conversationId, /^fake saw: \[Forwarded from Оля\]$/);
    const msgs: any[] = await web.req("GET", `/api/conversations/${fwd.conversationId}/messages`);
    expect(msgs.find((m) => m.id === fwd.messageId).parts).toEqual([{ type: "text", text: "ECHO? forwarded" }]);
  });

  it("transcribes voice messages before the agent's turn, says why when it cannot, and lets the agent ask again", async () => {
    // A fake OpenAI-compatible speech-to-text server: "heard <file name>", or 401 for the model "broken".
    const stt = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        res.setHeader("content-type", "application/json");
        if (body.includes("broken")) return res.writeHead(401).end(JSON.stringify({ error: { message: "Invalid API key" } }));
        res.end(JSON.stringify({ text: `heard ${/filename="([^"]+)"/.exec(body)?.[1]}` }));
      });
    });
    await new Promise<void>((r) => stt.listen(0, "127.0.0.1", r));
    const sttUrl = `http://127.0.0.1:${(stt.address() as any).port}/v1`;
    try {
      const call = createCoreCall(hub);
      const voice = { data: Buffer.from("OggS").toString("base64"), mimeType: "audio/ogg", kind: "voice", durationSec: 3 };
      const say = async (title: string) => {
        const c = await web.req("POST", "/api/conversations", { title });
        await call("fakebrain", "channels.inbound", { channel: "test", conversationId: c.id, text: "", files: [voice] });
        const m = await lastReply(c.id, /^fake files:/);
        return { id: c.id, reply: m.parts.find((p: any) => p.type === "text").text as string };
      };
      expect((await web.raw("PATCH", "/api/settings", { transcription: { provider: "loud" } })).json.error).toMatch(/^Speech-to-text settings are wrong: transcription.provider must be one of/);

      await web.req("PATCH", "/api/settings", { transcription: { provider: "custom", baseUrl: sttUrl, model: "small" } });
      const ok = await say("voice");
      expect(ok.reply).toMatch(/- attachments\/(voice-\d{8}-\d{6}\.ogg) \(audio\/ogg, 4 B, voice message 0:03\), transcript: "heard voice-\d{8}-\d{6}\.ogg"/);
      const stored: any[] = await web.req("GET", `/api/conversations/${ok.id}/messages`);
      expect(stored.find((m) => m.role === "user").parts[0].transcript).toMatch(/^heard voice-/);

      await web.req("PATCH", "/api/settings", { transcription: { provider: "custom", baseUrl: sttUrl, model: "broken" } });
      expect((await say("voice, failing")).reply).toContain("voice message 0:03), could not transcribe it: 127.0.0.1:");
      expect((await say("voice, failing 2")).reply).toContain("answered 401: Invalid API key");

      await web.req("PATCH", "/api/settings", { transcription: { provider: "off" } });
      const none = await say("voice, nothing set up");
      expect(none.reply).toContain("voice message 0:03), no speech-to-text is set up / You cannot hear voice messages until speech-to-text is set up.");

      // The agent asks again once it is set up.
      await web.req("PATCH", "/api/settings", { transcription: { provider: "custom", baseUrl: sttUrl, model: "small" } });
      await web.upload(`/api/conversations/${none.id}/attachments?name=memo.m4a`, Buffer.from("m4a"));
      await web.req("POST", `/api/conversations/${none.id}/messages`, { text: 'CALL transcribe_audio {"path":"attachments/memo.m4a"}' });
      await lastReply(none.id, /^tool said: Transcript: heard memo\.m4a$/);
      await web.req("POST", `/api/conversations/${none.id}/messages`, { text: 'CALL transcribe_audio {"path":"../../etc/passwd"}' });
      await lastReply(none.id, /^tool said: \.\.\/\.\.\/etc\/passwd: (outside your workspace|no such file in your workspace)$/);
    } finally {
      await web.req("PATCH", "/api/settings", { transcription: { provider: "auto" } });
      stt.close();
    }
  });

  it("routes channel messages to the default agent's dialog and shows it in the team", async () => {
    const seen: any[] = [];
    const off = hub.bus.on("team.updated", (m) => seen.push(m));
    try {
      const r = (await createCoreCall(hub)("fakebrain", "channels.inbound", { channel: "test", text: "from the channel" })) as any;
      expect(r.conversationId).toBe(conv);
      expect(hub.store.agentConversation("assistant").id).toBe(conv);
      await lastReply(conv, /fake heard: from the channel/);
      await until(() => {
        const mine = seen.filter((m) => m.conversationId === conv);
        return mine.some((m) => m.running) && mine.at(-1)?.running === false;
      }, "the turn to start and end");

      const team: any[] = await web.req("GET", "/api/team");
      const me = team.find((m) => m.agentId === "assistant");
      expect(me).toMatchObject({ conversationId: conv, running: false, lastMessage: { role: "assistant", text: "fake heard: from the channel" } });
      expect(me.unread).toBeGreaterThan(0);
      await web.req("POST", `/api/conversations/${conv}/read`, {});
      expect(((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "assistant").unread).toBe(0);
      expect((await web.raw("POST", "/api/conversations/nope/read", {})).status).toBe(404);
    } finally {
      off();
    }
  });

  it("mirrors the main agent's replies to web messages into the channels, once", async () => {
    const sent: any[] = [];
    const peer = { closed: false, request: async (_m: string, p: any) => (sent.push(p), {}) } as any;
    hub.channels.register("mirror", "Mirror", "mirror-test", peer);
    try {
      // Typed in the web UI: the reply also goes to the channel, with the question quoted.
      await web.req("POST", `/api/conversations/${conv}/messages`, { text: "web question" });
      await lastReply(conv, /fake heard: web question/);
      const out = await until(() => sent.find((s) => /fake heard: web question/.test(s.message.text)), "the mirrored reply");
      expect(out).toMatchObject({ channelId: "mirror", message: { kind: "reply", quote: "web question", conversationId: conv } });

      // Only the answer leaves the web: no tool calls, their results or the narration around them.
      await web.req("POST", `/api/conversations/${conv}/messages`, { text: "THINK about it" });
      const full = await lastReply(conv, /fake found it/);
      expect(full.parts.map((p: any) => p.type)).toEqual(["text", "tool_call", "tool_result", "text"]);
      const answer = await until(() => sent.find((s) => /fake found it/.test(s.message.text)), "the mirrored answer");
      expect(answer.message.text).toBe("fake found it");

      // Written in the channel: the answer goes back there once, without quoting the user to themselves.
      await createCoreCall(hub)("mirror-test", "channels.inbound", { channel: "mirror", text: "phone question" });
      await lastReply(conv, /fake heard: phone question/);
      await until(() => sent.some((s) => /fake heard: phone question/.test(s.message.text)), "the channel reply");
      await new Promise((r) => setTimeout(r, 200));
      const phone = sent.filter((s) => /fake heard: phone question/.test(s.message.text));
      expect(phone).toHaveLength(1);
      expect(phone[0].message.quote).toBeUndefined();

      // Another agent's dialog stays in the web.
      await web.req("PUT", "/api/agents/quiet", { name: "Quiet", description: "Stays home", brains: ["fake@local"], prompt: "Be quiet." });
      const quiet = ((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "quiet");
      await web.req("POST", `/api/conversations/${quiet.conversationId}/messages`, { text: "side question" });
      await lastReply(quiet.conversationId, /fake heard: side question/);

      // And the user can turn mirroring off.
      await web.req("PATCH", "/api/settings", { channelMirror: false });
      await web.req("POST", `/api/conversations/${conv}/messages`, { text: "private question" });
      await lastReply(conv, /fake heard: private question/);
      await new Promise((r) => setTimeout(r, 200));
      expect(sent.some((s) => /side question|private question/.test(s.message.text))).toBe(false);
    } finally {
      await web.req("PATCH", "/api/settings", { channelMirror: true });
      await web.req("DELETE", "/api/agents/quiet");
      hub.channels.unregisterPlugin("mirror-test");
    }
  });

  it("gives each agent its own dialog, keeps it when the agent leaves", async () => {
    await web.req("PUT", "/api/agents/scout", { name: "Scout", description: "Looks around", brains: ["fake@local"], prompt: "Look around." });
    const scout = ((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "scout");
    expect(scout.conversationId).not.toBe(conv);
    expect(scout.unread).toBe(0);

    // The agent's proactive messages land in its own dialog.
    await hub.notifier.notify({ level: "ask", title: "scout found something", body: "details", agentId: "scout" });
    const msgs: any[] = await web.req("GET", `/api/conversations/${scout.conversationId}/messages`);
    expect(msgs.some((m) => m.parts.some((p: any) => p.type === "notification" && p.title === "scout found something"))).toBe(true);
    expect(((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "scout").unread).toBe(1);

    // Talking in the dialog runs that agent, and the dialog cannot be handed to another agent.
    await web.req("POST", `/api/conversations/${scout.conversationId}/messages`, { text: "hi scout" });
    expect((await lastReply(scout.conversationId, /fake heard: hi scout/)).agentId).toBe("scout");
    expect((await web.raw("PATCH", `/api/conversations/${scout.conversationId}`, { agentId: "assistant" })).status).toBe(400);

    // "/" follows the default agent; deleting it falls back to the assistant.
    await web.req("PATCH", "/api/settings", { defaultAgent: "scout" });
    expect((await web.req("GET", "/api/bootstrap")).mainConversationId).toBe(scout.conversationId);
    await web.req("DELETE", "/api/agents/scout");
    expect((await web.req("GET", "/api/settings")).defaultAgent).toBe("assistant");
    expect((await web.req("GET", "/api/bootstrap")).mainConversationId).toBe(conv);
    expect(((await web.req("GET", "/api/team")) as any[]).some((m) => m.agentId === "scout")).toBe(false);
    expect(((await web.req("GET", `/api/conversations/${scout.conversationId}/messages`)) as any[]).length).toBeGreaterThan(0);
  });

  it("delivers a schedule's report as the agent's own message", async () => {
    const task = hub.runner.createTask({ agentId: "assistant", goal: "Brief me", title: "Morning brief", background: true, createdBy: "trigger", triggerId: "t_brief", deliver: "report" });
    const n = await until(() => hub.notifier.list(50).find((x) => x.taskId === task.id && x.kind === "report"), "the report");
    expect(n.body).toMatch(/fake heard/);
    const msgs: any[] = await web.req("GET", `/api/conversations/${conv}/messages`);
    expect(msgs.some((m) => m.parts.some((p: any) => p.type === "notification" && p.kind === "report" && p.notificationId === n.id))).toBe(true);
  });

  it("has the assistant write the digest", async () => {
    await hub.notifier.notify({ level: "digest", title: "E2E digest item", body: "something to tell", agentId: "assistant" });
    expect((await web.req("POST", "/api/digest/flush", {})).sent).toBeGreaterThan(0);
    const d = await until(() => hub.notifier.list(100).find((x) => x.kind === "digest" && x.deliveredAt), "the digest");
    expect(d.body).toMatch(/fake heard/);
    const msgs: any[] = await web.req("GET", `/api/conversations/${conv}/messages`);
    expect(msgs.some((m) => m.parts.some((p: any) => p.type === "notification" && p.kind === "digest" && p.notificationId === d.id))).toBe(true);
    // The writer reads other runs' words and channel headlines: its task is marked as reading outside content from the start.
    expect(hub.store.getTask(d.taskId!)).toMatchObject({ deliver: "digest", tainted: true });
  });

  it("sends the digest's card when its writer fails", async () => {
    // A digest waiting for a writer that cannot start: pinned to a brain this hub does not have.
    const task = hub.runner.createTask({ agentId: "assistant", goal: "Write the digest", title: "Digest", background: true, createdBy: "trigger", deliver: "digest", brainRef: "gone@local" });
    const material = { partOfDay: "day", date: "2026-10-31", items: [{ id: "n_x", title: "Writer failure item", body: "kept whole", time: "10:00" }], sections: [], channels: [], told: [] };
    hub.db
      .prepare("insert into notifications(id, level, kind, title, body, agent_id, task_id, created_at) values ('n_digest_fail', 'digest', 'digest', 'Digest', ?, 'assistant', ?, ?)")
      .run(JSON.stringify(material), task.id, new Date().toISOString());
    const d = await until(() => hub.notifier.get("n_digest_fail")?.deliveredAt && hub.notifier.get("n_digest_fail"), "the card");
    expect(d.body).toContain("**Writer failure item** · 10:00");
    expect(d.body).toContain("kept whole");
    expect(hub.store.getTask(task.id)?.status).toBe("failed");
    // No alert about it: the card is the answer.
    expect(hub.notifier.list(100).some((x) => x.taskId === task.id && x.kind !== "digest")).toBe(false);
  });

  /** A digest waiting for `task`: the row the notifier files when it starts a writer, with no timer behind it (so only the runner can send the card). */
  const fileDigest = (id: string, taskId: string) => {
    const material = { partOfDay: "day", date: "2026-10-31", items: [{ id: `${id}_item`, title: "Interrupted writer item", body: "kept whole", time: "10:00" }], sections: [], channels: [], told: [] };
    hub.db
      .prepare("insert into notifications(id, level, kind, title, body, agent_id, task_id, created_at) values (?, 'digest', 'digest', 'Digest', ?, 'assistant', ?, ?)")
      .run(id, JSON.stringify(material), taskId, new Date().toISOString());
  };

  it("sends the digest's card at once when its writer's agent is gone", async () => {
    const task = hub.runner.createTask({ agentId: "ghost", goal: "Write the digest", title: "Digest", background: true, createdBy: "trigger", deliver: "digest" });
    fileDigest("n_digest_ghost", task.id);
    const d = await until(() => hub.notifier.get("n_digest_ghost")?.deliveredAt && hub.notifier.get("n_digest_ghost"), "the card", 5000);
    expect(d.body).toContain("**Interrupted writer item** · 10:00");
    expect(hub.store.getTask(task.id)?.status).toBe("failed");
  });

  it("sends the digest's card at once, with no notice about it, when its writer's budget is used up", async () => {
    // An agent with no background runs a day: its tasks fail before they start.
    await web.req("PUT", "/api/agents/frugal", { name: "Frugal", description: "No budget", brains: ["fake@local"], prompt: "Be frugal.", budget: { backgroundRunsPerDay: 0 } });
    // The notices about this agent's budget that exist already (other tests may leave some): only a new one would be wrong.
    const budgetNotices = () => hub.notifier.list(500).filter((x) => x.agentId === "frugal" && /daily budget/.test(x.title)).map((x) => x.id);
    const before = budgetNotices();
    try {
      const task = hub.runner.createTask({ agentId: "frugal", goal: "Write the digest", title: "Digest", background: true, createdBy: "trigger", deliver: "digest" });
      fileDigest("n_digest_budget", task.id);
      const d = await until(() => hub.notifier.get("n_digest_budget")?.deliveredAt && hub.notifier.get("n_digest_budget"), "the card", 5000);
      expect(d.body).toContain("**Interrupted writer item** · 10:00");
      expect(hub.store.getTask(task.id)?.status).toBe("failed");
      // The card is the answer: no "used up its daily budget" item for the next digest.
      expect(budgetNotices()).toEqual(before);
    } finally {
      await web.req("DELETE", "/api/agents/frugal");
    }
  });

  it("still tells the person about a budget used up by an ordinary background task", async () => {
    await web.req("PUT", "/api/agents/frugal", { name: "Frugal", description: "No budget", brains: ["fake@local"], prompt: "Be frugal.", budget: { backgroundRunsPerDay: 0 } });
    try {
      const task = hub.runner.createTask({ agentId: "frugal", goal: "Check things", title: "Check things", background: true, createdBy: "trigger", triggerId: "t_frugal" });
      await until(() => hub.store.getTask(task.id)?.status === "failed", "the task to fail", 5000);
      expect(hub.notifier.list(100).some((x) => /Frugal has used up its daily budget/.test(x.title))).toBe(true);
    } finally {
      await web.req("DELETE", "/api/agents/frugal");
    }
  });

  /** The Inbox tests notify as an agent of their own: the assistant's hourly budget of alerts is not theirs to use up. */
  const asInboxer = async (run: (dialog: string) => Promise<void>) => {
    await web.req("PUT", "/api/agents/inboxer", { name: "Inboxer", description: "Writes to the Inbox", brains: ["fake@local"], prompt: "Write." });
    try {
      await run(hub.store.agentConversation("inboxer").id);
    } finally {
      await web.req("DELETE", "/api/agents/inboxer");
    }
  };

  it("serves the Inbox and keeps its unread count", () =>
    asInboxer(async (dialog) => {
      const q = await hub.notifier.notify({ level: "ask", title: "Inbox question", body: "", agentId: "inboxer" });
      const a = await hub.notifier.notify({ level: "notify", title: "Inbox alert", body: "news", agentId: "inboxer", triggerId: "t_inbox" });
      const view = await web.req("GET", "/api/inbox");
      expect(Array.isArray(view.entries)).toBe(true);
      expect(view.questions.map((e: any) => e.id)).toContain(q.id);
      expect(view.entries.find((e: any) => e.id === a.id)).toMatchObject({ kind: "alert", unread: true, feedbackable: true, agentId: "inboxer", conversationId: dialog });
      expect(view.unread).toBeGreaterThanOrEqual(2);

      const r = await web.req("POST", "/api/inbox/read", { ids: [a.id, q.id, 7] });
      expect(r).toEqual({ ok: true, unread: view.unread - 2 });
      expect((await web.req("GET", "/api/bootstrap")).inboxUnread).toBe(r.unread);
      const after = await web.req("GET", "/api/inbox");
      expect(after.questions.map((e: any) => e.id)).not.toContain(q.id);
      expect(after.entries.find((e: any) => e.id === a.id)).toMatchObject({ unread: false });
      expect(after.unread).toBe(r.unread);

      expect(Array.isArray(await web.req("GET", "/api/inbox/behind"))).toBe(true);
      expect((await web.raw("POST", "/api/inbox/read", { ids: "x" })).status).toBe(400);
      expect((await web.raw("POST", "/api/inbox/read", {})).status).toBe(400);
    }));

  it("pages the Inbox by ?before and ?limit, and takes a limit that is not a number as not given", () =>
    asInboxer(async () => {
      await hub.notifier.notify({ level: "notify", title: "Inbox page one", body: "1", agentId: "inboxer" });
      await new Promise((r) => setTimeout(r, 5));
      await hub.notifier.notify({ level: "notify", title: "Inbox page two", body: "2", agentId: "inboxer" });
      const first = await web.req("GET", "/api/inbox?limit=1");
      expect(first.entries).toHaveLength(1);
      expect(first.hasMore).toBe(true);
      const older = await web.req("GET", `/api/inbox?limit=1&before=${encodeURIComponent(first.entries[0].createdAt)}`);
      expect(older.questions).toEqual([]);
      expect(older.entries[0].createdAt < first.entries[0].createdAt).toBe(true);
      expect(older.entries[0].id).not.toBe(first.entries[0].id);
      expect((await web.raw("GET", "/api/inbox?limit=lots")).status).toBe(200);
      expect((await web.raw("GET", "/api/inbox/behind?limit=lots&before=a&before=b")).status).toBe(200);
    }));

  it("tells the apps the new unread count when a chat is read", () =>
    asInboxer(async (dialog) => {
      await hub.notifier.notify({ level: "notify", title: "Inbox badge alert", body: "unread", agentId: "inboxer" });
      const unread = hub.notifier.unreadCount();
      // What this chat holds unread (the agent's dialog outlives the agent, with what earlier tests left in it): reading it reads all of that.
      const view = hub.notifier.inbox({ limit: 200 });
      const inDialog = [...view.questions, ...view.entries].filter((e) => e.conversationId === dialog && e.unread).length;
      expect(inDialog).toBeGreaterThan(0);
      const seen: number[] = [];
      const off = hub.bus.on("inbox.changed", (e) => seen.push(e.unread));
      try {
        await web.req("POST", `/api/conversations/${dialog}/read`, {});
      } finally {
        off();
      }
      expect(seen).toEqual([unread - inDialog]);
      expect((await web.req("GET", "/api/bootstrap")).inboxUnread).toBe(unread - inDialog);
      // Reading it again changes nothing, so the apps are not told again; nor when an Inbox entry is opened a second time.
      const again: number[] = [];
      const offAgain = hub.bus.on("inbox.changed", (e) => again.push(e.unread));
      try {
        await web.req("POST", `/api/conversations/${dialog}/read`, {});
        const opened = hub.notifier.inbox({ limit: 200 }).entries.find((e) => e.conversationId === dialog);
        await web.req("POST", "/api/inbox/read", { ids: [opened!.id] });
        await web.req("POST", "/api/inbox/read", { ids: [opened!.id] });
      } finally {
        offAgain();
      }
      expect(again).toEqual([]);
    }));

  it("tells the person plainly when a schedule's report did not come", async () => {
    // Pinned to a brain this hub does not have: the run cannot start, and the agent has nothing set up to start it with.
    const task = hub.runner.createTask({ agentId: "assistant", goal: "Brief me", title: "Morning brief", background: true, createdBy: "trigger", triggerId: "t_brief_failing", deliver: "report", brainRef: "gone@local" });
    const n = await until(() => hub.notifier.list(50).find((x) => x.taskId === task.id), "the alert");
    expect(n).toMatchObject({
      level: "notify",
      kind: "alert",
      title: "Didn't work out: “Morning brief”",
      body: "Тестовый ассистент isn't signed in to any brain yet. Sign in from its chat.",
      // From the schedule: muting the schedule mutes its failures too.
      triggerId: "t_brief_failing",
    });
    expect(hub.store.getTask(task.id)?.status).toBe("failed");
    const dialog = hub.store.listMessages(hub.store.agentConversation("assistant").id, { limit: 100 });
    expect(dialog.some((m) => m.parts.some((p) => p.type === "notification" && p.kind === "alert" && p.notificationId === n.id))).toBe(true);
    // No report was made out of the failure.
    expect(hub.notifier.list(50).some((x) => x.taskId === task.id && x.kind === "report")).toBe(false);
  });

  it("keeps an ordinary failing schedule quiet", async () => {
    const task = hub.runner.createTask({ agentId: "assistant", goal: "Check things", title: "Quiet check", background: true, createdBy: "trigger", triggerId: "t_check_failing", brainRef: "gone@local" });
    await until(() => hub.store.getTask(task.id)?.status === "failed", "the task to fail");
    // The failure path is synchronous after the status change; give any stray notification a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.notifier.list(100).filter((x) => x.taskId === task.id)).toEqual([]);
  });

  it("serves tools to brains over MCP with per-session tokens", async () => {
    expect((await web.raw("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer nope" })).status).toBe(401);
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: 'CALL notify {"level":"silent","title":"from-mcp"}' });
    await lastReply(conv, /tool said:/);
    const notes: any[] = await web.req("GET", "/api/notifications");
    expect(notes.some((n) => n.title === "from-mcp")).toBe(true);
  });

  it("refuses a call without the tool's required parameters before any approval card", async () => {
    const before = hub.approvals.list(["pending"]).length;
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: "CALL fake_send {}" });
    expect(await lastReply(conv, /Parameter text is required\. Nothing was done and nobody was asked; call fake_send again with it\./)).toBeTruthy();
    expect(hub.approvals.list(["pending"]).length).toBe(before);
  });

  it("holds external actions for approval and runs them after the user approves", async () => {
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: 'CALL fake_send {"text":"to bob"}' });
    await lastReply(conv, /awaiting_approval|waiting for the user.s approval/);

    // The approval is only visible and resolvable in the isolated console.
    expect((await consoleClient.raw("GET", "/console-api/approvals")).status).toBe(401);
    const login = await consoleClient.req("POST", "/console-api/auth/login", { password: "integration-pass-1" });
    consoleClient.csrf = login.csrf;
    const pending: any[] = await consoleClient.req("GET", "/console-api/approvals");
    const a = pending.find((p) => p.tool === "fake_send");
    expect(a.summary).toBe("Отправить to bob");
    expect((await consoleClient.raw("POST", `/console-api/approvals/${a.id}`, { decision: "approve" }, { "content-type": "text/plain" })).status).toBe(415);
    await consoleClient.req("POST", `/console-api/approvals/${a.id}`, { decision: "approve" });
    expect((await consoleClient.raw("POST", `/console-api/approvals/${a.id}`, { decision: "approve" })).status).toBe(409);
    expect((await consoleClient.raw("POST", "/console-api/approvals/nope", { decision: "approve" })).status).toBe(404);
    expect((await consoleClient.raw("GET", "/console-api/auth/state")).json).toMatchObject({ language: "en", locales: ["en", "ru"] });
    expect((await consoleClient.raw("PUT", "/console-api/vault/items", { id: "../x", name: "x", type: "note", fields: {} })).status).toBe(400);

    await until(async () => {
      const msgs: any[] = await web.req("GET", `/api/conversations/${conv}/messages`);
      return msgs.some((m) => m.role === "system" && m.parts.some((p: any) => p.type === "text" && p.text.includes("sent: to bob")));
    }, "deferred result note");
    const audit: any[] = await consoleClient.req("GET", "/console-api/audit?limit=200");
    expect(audit.some((e) => e.action === "tool.call" && e.target === "fake_send")).toBe(true);
    expect((await consoleClient.req("GET", "/console-api/audit/verify")).ok).toBe(true);
  });

  it("speaks the reader's language and keeps a hub language", async () => {
    expect((await web.raw("GET", "/api/tasks/nope")).json.error).toBe("Task not found");
    expect((await web.raw("GET", "/api/tasks/nope", undefined, { "x-piomio-locale": "ru" })).json.error).toBe("Задача не найдена");
    expect((await web.raw("GET", "/api/tasks/nope", undefined, { "accept-language": "ru-RU,ru;q=0.9" })).json.error).toBe("Задача не найдена");
    const state = (await web.raw("GET", "/api/auth/state")).json;
    expect(state.locales).toEqual(["en", "ru"]);
    expect((await web.raw("PATCH", "/api/settings", { language: "xx" })).status).toBe(400);
    await web.req("PATCH", "/api/settings", { language: "ru-RU" });
    expect((await web.req("GET", "/api/bootstrap")).language).toBe("ru");
    const agents: any[] = await web.req("GET", "/api/agents");
    expect(agents.find((a) => a.id === "assistant")).toBeTruthy();
    await web.req("PATCH", "/api/settings", { language: "en" });

    // Editing a translated agent in Russian changes the Russian name only.
    await web.req("PUT", "/api/agents/polyglot", { name: "Polyglot", description: "Speaks", prompt: "x", i18n: { ru: { name: "Полиглот" } } });
    const ru = await web.raw("PUT", "/api/agents/polyglot", { name: "Полиглот 2", description: "Говорит" }, { "x-piomio-locale": "ru" });
    expect(ru.status).toBe(200);
    const byLang = async (l: string) => ((await web.raw("GET", "/api/agents", undefined, { "x-piomio-locale": l })).json as any[]).find((a) => a.id === "polyglot");
    expect(await byLang("en")).toMatchObject({ name: "Polyglot", description: "Speaks" });
    expect(await byLang("ru")).toMatchObject({ name: "Полиглот 2", description: "Говорит" });
    await web.req("DELETE", "/api/agents/polyglot");
  });

  it("delivers plugin files into the session workspace", async () => {
    const s = hub.db.prepare("select id from sessions order by created_at limit 1").get() as { id: string };
    const call = createCoreCall(hub);
    const first = (await call("fakebrain", "files.deliver", { sessionId: s.id, name: "../../evil/отчёт.txt", data: Buffer.from("hel").toString("base64") })) as any;
    expect(first.path).toBe("downloads/отчёт.txt");
    await call("fakebrain", "files.deliver", { sessionId: s.id, name: "x", path: first.path, data: Buffer.from("lo").toString("base64") });
    expect(readFileSync(first.absolutePath, "utf8")).toBe("hello");
    const second = (await call("fakebrain", "files.deliver", { sessionId: s.id, name: "отчёт.txt", data: "" })) as any;
    expect(second.path).toBe("downloads/отчёт (1).txt");
    await expect(call("fakebrain", "files.deliver", { sessionId: s.id, path: "downloads/../../x", data: "" })).rejects.toThrow(/invalid path/);
    await expect(call("fakebrain", "files.deliver", { sessionId: "nope", name: "a", data: "" })).rejects.toThrow(/session not found/);
  });

  it("lets the security console grant a plugin extra vault items", async () => {
    const r = await consoleClient.req("PUT", "/console-api/plugins/fakebrain/vault", { items: ["vault://my_key", "my_key", "other"] });
    expect(r.extraVault).toEqual(["my_key", "other"]);
    const list: any[] = await consoleClient.req("GET", "/console-api/plugins");
    expect(list.find((p) => p.id === "fakebrain").extraVault).toEqual(["my_key", "other"]);
    await expect(consoleClient.req("PUT", "/console-api/plugins/fakebrain/vault", { items: ["../x"] })).rejects.toThrow(/400/);
    // The main UI origin cannot do this.
    await expect(web.req("PUT", "/console-api/plugins/fakebrain/vault", { items: ["x"] })).rejects.toThrow();
    await consoleClient.req("PUT", "/console-api/plugins/fakebrain/vault", { items: [] });
  });

  it("falls back to the next brain when a subscription limit is hit", async () => {
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: "LIMIT please" });
    const m = await lastReply(conv, /fake2 heard/);
    expect(m.brainRef).toBe("fake2@local");
    const brains: any[] = await web.req("GET", "/api/brains");
    expect(brains.find((b) => b.ref === "fake@local").limitedUntil).toBeTruthy();
    expect(brains.find((b) => b.ref === "fake2:a@local")).toMatchObject({ label: "fake2 (a)", connected: true });
    expect(brains.find((b) => b.ref === "fake2@local")?.connected).toBe(true);
    await web.req("DELETE", `/api/brains/limits/${encodeURIComponent("fake@local")}`);
  });

  it("moves an open conversation to the brain the user picks", async () => {
    await web.req("PUT", "/api/agents/picker", { name: "Picker", description: "Switches", brains: ["fake@local", "fake2@local"], prompt: "Pick." });
    const chat = (await web.req("POST", "/api/conversations", { title: "pick a brain", agentId: "picker" })).id;
    await web.req("POST", `/api/conversations/${chat}/messages`, { text: "first" });
    expect((await lastReply(chat, /heard: first/)).brainRef).toBe("fake@local");
    // The brain picker in the chat header makes the chosen brain the dialog's: the router keeps to it.
    await web.req("PUT", "/api/agents/picker/thinking/chat", { brain: "fake2@local" });
    await web.req("POST", `/api/conversations/${chat}/messages`, { text: "second" });
    expect(await lastReply(chat, /heard: second/)).toMatchObject({ brainRef: "fake2@local", parts: [expect.objectContaining({ text: "fake2 heard: second" })] });
    await web.req("DELETE", "/api/agents/picker");
  });

  it("lets the default agent run the hub from chat, and nobody else", async () => {
    const say = async (c: string, tool: string, args: unknown) => {
      const sent = await web.req("POST", `/api/conversations/${c}/messages`, { text: `CALL ${tool} ${JSON.stringify(args)}` });
      const reply = await until(async () => {
        const msgs: any[] = await web.req("GET", `/api/conversations/${c}/messages`);
        const after = msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1);
        return after.find((m) => m.role === "assistant" && m.status !== "streaming" && m.parts.some((p: any) => p.type === "text" && /tool said:/.test(p.text)));
      }, `reply to ${tool}`);
      return reply.parts.find((p: any) => p.type === "text" && /tool said:/.test(p.text)).text as string;
    };
    const chat = (await web.req("POST", "/api/conversations", { title: "hub admin" })).id;

    expect(await say(chat, "hub_settings_update", { patch: { digestTimes: ["08:30"], timezone: "Europe/Berlin" } })).toMatch(/Settings updated/);
    expect((await web.req("GET", "/api/settings")).digestTimes).toEqual(["08:30"]);
    expect(await say(chat, "hub_settings_update", { patch: { brainEgressAllow: ["evil.example"] } })).toMatch(/only be changed by the user/);
    expect((await web.req("GET", "/api/settings")).brainEgressAllow).toEqual([]);

    expect(await say(chat, "hub_agent_save", { name: "Helper", avatar: { color: "pink", shape: "star" }, brains: ["fake@local"], prompt: "Help." })).toMatch(/helper created/);
    const helper = ((await web.req("GET", "/api/agents")) as any[]).find((a) => a.id === "helper");
    expect(helper).toMatchObject({ name: "Helper", avatar: { color: "pink", shape: "star" }, source: "user" });
    expect(await say(chat, "hub_agent_save", { id: "helper", avatar: { color: "nope", shape: "star" } })).toMatch(/Invalid avatar/);

    // Another agent does not even see the hub tools.
    const other = (await web.req("POST", "/api/conversations", { title: "helper chat", agentId: "helper" })).id;
    expect(await say(other, "hub_settings_get", {})).toMatch(/not available to this agent/);

    // After outside content it looks freely, and a change waits for the person's yes on its card (hub-approval.test.ts).
    for (const s of hub.db.prepare("select id from sessions where conversation_id = ?").all(chat) as Array<{ id: string }>) hub.store.updateSession(s.id, { tainted: true });
    expect(await say(chat, "hub_settings_update", { patch: { digestTimes: ["07:00"] } })).toMatch(/waiting for the user's approval/);
    const held = hub.approvals.list(["pending"]).find((a) => a.tool === "hub_settings_update")!;
    hub.approvals.resolve(held.id, "deny", { via: "web" });
    expect((await web.req("GET", "/api/settings")).digestTimes).toEqual(["08:30"]);
    expect(await say(chat, "hub_plugins_list", {})).toMatch(/fakebrain/);

    // The brain of this very conversation cannot be switched off from it.
    const fresh = (await web.req("POST", "/api/conversations", { title: "plugins" })).id;
    expect(await say(fresh, "hub_plugin_enable", { id: "fakebrain", enabled: false })).toMatch(/runs the brain of this conversation/);
    await web.req("DELETE", "/api/agents/helper");
    await web.req("PATCH", "/api/settings", { digestTimes: ["09:00", "19:00"], timezone: "UTC" });
  });

  it("runs background tasks to completion", async () => {
    const t = await web.req("POST", "/api/tasks", { goal: "summarize the day" });
    const done = await until(async () => {
      const x = await web.req("GET", `/api/tasks/${t.id}`);
      return x.status === "done" || x.status === "failed" ? x : undefined;
    }, "task to finish");
    expect(done.status).toBe("done");
    expect(done.result).toMatch(/heard/);
  });
});
