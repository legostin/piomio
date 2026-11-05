import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { EventBus } from "../src/bus.ts";
import { AuditLog } from "../src/audit.ts";
import { RuleStore } from "../src/policy/rules.ts";
import { ApprovalService } from "../src/approvals.ts";
import { Settings } from "../src/settings.ts";
import { EgressProxy, NETWORK_APPROVAL_WAIT_MS, networkHost, networkPattern } from "../src/egress.ts";
import { wireNetworkApprovals } from "../src/network-approvals.ts";
import { AutoMode, type Reviewer } from "../src/policy/auto.ts";

async function until<T>(f: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("No pending card");
}

it("validates exact hosts and domain wildcards without numeric/URL tricks or private addresses", () => {
  expect(networkPattern("*.GitHub.com.")).toBe("*.github.com");
  expect(networkHost("[2606:4700:4700::1111]")).toBe("2606:4700:4700::1111");
  for (const h of ["*", "*.com", "http://x.com", "x.com/path", "x.com:443", "x.com\r\nBad", "127.0.0.1", "169.254.169.254", "[::1]", "2130706433", "0x7f000001", "nas.local", "*.127.0.0.1", "*.localhost"]) expect(() => networkPattern(h), h).toThrow();
});

describe("network cards and proxy", () => {
  let db: ReturnType<typeof openDb>;
  let proxy: EgressProxy;
  let approvals: ApprovalService;
  let settings: Settings;
  let store: Store;
  let audit: AuditLog;
  let rules: RuleStore;
  let context: { sessionId: string; conversationId: string; agentId: string };
  let token: string;
  let bus: EventBus;
  const pending = () => until(() => approvals.list(["pending"])[0]);
  const ask = (host = "new.example", port = 443) => proxy.requestHost(context.sessionId, host, port);

  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), "network-approval-")), "hub.db"));
    bus = new EventBus(); store = new Store(db, bus); audit = new AuditLog(db); rules = new RuleStore(db);
    approvals = new ApprovalService(db, bus, audit, rules); settings = new Settings(db, "UTC");
    proxy = new EgressProxy(); proxy.extraBrainAllow = () => settings.get().brainEgressAllow;
    const conversationId = store.agentConversation("developer").id;
    const { row } = store.createSession({ conversationId, agentId: "developer", brainRef: "codex@local", background: false });
    context = { sessionId: row.id, conversationId, agentId: "developer" };
    token = proxy.issueToken(`brain:${row.id}`, ["known.example"], context);
    wireNetworkApprovals({ egress: proxy, approvals, settings, store, audit, timeoutMs: 200 });
    vi.spyOn(proxy, "resolveTarget").mockResolvedValue(["93.184.216.34"]);
  });
  afterEach(async () => { await proxy.close(); db.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("gives a live request ten minutes, accepts a decision after 90 seconds, and expires at the deadline", async () => {
    wireNetworkApprovals({ egress: proxy, approvals, settings, store, audit });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const start = Date.now();
    const waiting = ask(); await vi.advanceTimersByTimeAsync(0);
    const card = approvals.list(["pending"])[0]!;
    expect(Date.parse(card.ask!.networkExpiresAt!)).toBe(start + NETWORK_APPROVAL_WAIT_MS);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(approvals.get(card.id)!.status).toBe("pending");
    approvals.resolve(card.id, "approve", { via: "web" }); await waiting;
    const next = ask("later.example"); const failed = expect(next).rejects.toThrow("user did not answer in time");
    await vi.advanceTimersByTimeAsync(0);
    const expired = approvals.list(["pending"])[0]!;
    await vi.advanceTimersByTimeAsync(NETWORK_APPROVAL_WAIT_MS);
    await failed;
    expect(approvals.get(expired.id)).toMatchObject({ status: "expired", ask: { networkClosedReason: "timeout" } });
    expect(() => approvals.resolve(expired.id, "approve", { via: "web", remember: true })).toThrow();
    expect(settings.get().brainEgressAllow).toEqual([]);
  });

  it("an explicit retry never reopens or grants the old request and is recorded only once", async () => {
    await expect(ask()).rejects.toThrow("user did not answer in time");
    const old = approvals.list(["expired"])[0]!;
    expect(approvals.requestNetworkRetry(old.id).fresh).toBe(true);
    expect(approvals.requestNetworkRetry(old.id).fresh).toBe(false);
    expect(approvals.get(old.id)).toMatchObject({ status: "expired", ask: { networkRetryRequestedAt: expect.any(String) } });
    expect(approvals.list(["pending"])).toHaveLength(0);
    expect(settings.get().brainEgressAllow).toEqual([]);
    const fresh = ask(); const denied = expect(fresh).rejects.toThrow("user declined");
    const newCard = await pending(); expect(newCard.id).not.toBe(old.id);
    approvals.resolve(newCard.id, "deny", { via: "web" }); await denied;
    expect(approvals.get(old.id)!.status).toBe("expired");
  });

  it("late decisions are refused even before the timer callback runs", async () => {
    const waiting = ask(); const failed = expect(waiting).rejects.toThrow("not allowed");
    const card = await pending();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(card.ask!.networkExpiresAt!) + 1);
    expect(() => approvals.resolve(card.id, "approve", { via: "web", remember: true })).toThrow(/expired/);
    await failed;
    expect(approvals.get(card.id)).toMatchObject({ status: "expired", ask: { networkClosedReason: "timeout" } });
    expect(settings.get().brainEgressAllow).toEqual([]);
  });

  it("known hosts do not ask; unknown waits, once is limited to this session and port", async () => {
    await ask("known.example");
    expect(approvals.list()).toHaveLength(0);
    let finished = false;
    const waiting = ask().then(() => { finished = true; });
    const card = await pending();
    expect(card).toMatchObject({ ...context, tool: "hub_network_request", ask: { kind: "network", host: "new.example", port: 443 } });
    expect(finished).toBe(false);
    approvals.resolve(card.id, "approve", { via: "web" }); await waiting;
    await ask(); expect(approvals.list()).toHaveLength(1);
    const otherPort = ask("new.example", 8443); const declined = expect(otherPort).rejects.toThrow("user declined");
    approvals.resolve((await pending()).id, "deny", { via: "web" }); await declined;
    proxy.revoke(token);
    token = proxy.issueToken(`brain:${context.sessionId}`, [], context);
    const next = ask(); const denied = expect(next).rejects.toThrow("user declined");
    approvals.resolve((await pending()).id, "deny", { via: "web" }); await denied;
  });

  it("always stores the exact host, creates no action rule or known-content target, and removal takes effect", async () => {
    const waiting = ask(); const card = await pending();
    approvals.resolve(card.id, "approve", { via: "console", remember: true }); await waiting;
    expect(settings.get().brainEgressAllow).toEqual(["new.example"]);
    expect(rules.list()).toHaveLength(0); expect(rules.isKnownTarget("new.example")).toBe(false);
    expect(audit.list({ action: "egress.allow.always" })).toHaveLength(1);
    await ask(); expect(approvals.list()).toHaveLength(1);
    settings.update({ brainEgressAllow: [] });
    const again = ask(); const denied = expect(again).rejects.toThrow("user declined");
    approvals.resolve((await pending()).id, "deny", { via: "web" }); await denied;
  });

  it("shares simultaneous requests, and handles deny and timeout with clear messages and closed cards", async () => {
    const one = ask(); const two = ask();
    const failures = [expect(one).rejects.toThrow("user declined"), expect(two).rejects.toThrow("user declined")];
    const card = await pending(); expect(approvals.list()).toHaveLength(1);
    approvals.resolve(card.id, "deny", { via: "web" }); await Promise.all(failures);
    await expect(ask()).rejects.toThrow("user did not answer in time");
    expect(approvals.list(["pending"])).toHaveLength(0);
    expect(approvals.list(["expired"])).toHaveLength(1);
    expect(() => approvals.resolve(approvals.list(["expired"])[0].id, "approve", { via: "web", remember: true })).toThrow();
    expect(settings.get().brainEgressAllow).toEqual([]);
  });

  it("never offers private/metadata destinations or plugin requests; flags public IPs", async () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "::1", "nas.local"]) await expect(ask(host)).rejects.toThrow();
    vi.mocked(proxy.resolveTarget).mockResolvedValue(["10.0.0.1"]);
    await expect(ask("private.example")).rejects.toThrow("private address");
    expect(approvals.list()).toHaveLength(0);
    vi.mocked(proxy.resolveTarget).mockResolvedValue(["1.1.1.1"]);
    const ip = ask("1.1.1.1"); const failed = expect(ip).rejects.toThrow("user declined");
    const card = await pending(); expect(card.ask?.ipLiteral).toBe(true);
    approvals.resolve(card.id, "deny", { via: "web" }); await failed;
  });

  it("revocation cancels pending cards; restart expires them and never invokes deferred tools", async () => {
    approvals.onDeferredApproved = vi.fn(); approvals.onDeferredDenied = vi.fn();
    const waiting = ask(); const failed = expect(waiting).rejects.toThrow("cancelled");
    const card = await pending(); proxy.revoke(token); await failed;
    expect(approvals.get(card.id)?.status).toBe("expired");
    const old = approvals.create({ ...context, tool: "hub_network_request", input: {}, summary: "old", ask: { kind: "network", detail: "old.example:443" }, effect: "read", tainted: false });
    wireNetworkApprovals({ egress: proxy, approvals, settings, store, audit });
    expect(approvals.get(old.id)?.status).toBe("expired");
    expect(approvals.onDeferredApproved).not.toHaveBeenCalled(); expect(approvals.onDeferredDenied).not.toHaveBeenCalled();
  });

  it("a closed session cannot ask for another host", async () => {
    store.updateSession(context.sessionId, { status: "closed" });
    await expect(ask()).rejects.toThrow("session is no longer available");
    expect(approvals.list()).toHaveLength(0);
  });

  it("cancelling a task expires its question without reviving the task or allowing a late always decision", async () => {
    const task = store.createTask({ agentId: context.agentId, title: "Cancel me", goal: "Check", createdBy: "user", background: false, status: "running" });
    const { row } = store.createSession({ conversationId: task.conversationId, agentId: context.agentId, taskId: task.id, brainRef: "claude-code@local", background: false });
    proxy.issueToken(`brain:${row.id}`, [], { sessionId: row.id, conversationId: row.conversationId, taskId: task.id, agentId: row.agentId });
    const waiting = proxy.requestHost(row.id, "new.example", 443);
    const failed = expect(waiting).rejects.toThrow("cancelled"); const card = await pending();
    expect(store.getTask(task.id)?.status).toBe("waiting_approval");
    store.updateTask(task.id, { status: "cancelled" }); await failed;
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(approvals.get(card.id)?.status).toBe("expired");
    expect(() => approvals.resolve(card.id, "approve", { via: "web", remember: true })).toThrow();
    expect(settings.get().brainEgressAllow).toEqual([]);
  });

  async function listen() {
    await proxy.listen(0);
    expect((proxy as any).server.requestTimeout).toBeGreaterThan(NETWORK_APPROVAL_WAIT_MS);
    return ((proxy as any).server.address() as net.AddressInfo).port;
  }
  function httpGet(port: number, host: string, auth = token): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `http://${host}/`, headers: { "proxy-authorization": `Basic ${Buffer.from(`${auth}:x`).toString("base64")}` } }, (res) => {
        let body = ""; res.on("data", (b) => body += b); res.on("end", () => resolve({ status: res.statusCode!, body }));
      }).on("error", reject);
    });
  }

  it("HTTP forwards a listed host immediately and an unknown host only after approval", async () => {
    // The fixture pins every upstream to loopback; a brain's global environment proxy must not send its mock host outside.
    const localAgent = new http.Agent({ proxyEnv: {} });
    const request = http.request;
    const localRequest = vi.spyOn(http, "request").mockImplementation(((options: any, cb: any) => request({ ...options, agent: localAgent }, cb)) as typeof http.request);
    let hits = 0;
    const upstream = http.createServer((_req, res) => { hits++; res.end("upstream reached"); });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const port = await listen();
    try {
      vi.mocked(proxy.resolveTarget).mockResolvedValue(["127.0.0.1"]);
      expect(await httpGet(port, `known.example:${targetPort}`)).toEqual({ status: 200, body: "upstream reached" });
      expect(approvals.list()).toHaveLength(0);
      // The resolver is the test seam: public at the safety check, then the local fixture at connect time.
      // Real resolveTarget rechecks private addresses on both calls (covered in egress.test.ts).
      vi.mocked(proxy.resolveTarget).mockResolvedValueOnce(["93.184.216.34"]).mockResolvedValue(["127.0.0.1"]);
      const request = httpGet(port, `new.example:${targetPort}`);
      const card = await pending(); expect(hits).toBe(1);
      approvals.resolve(card.id, "approve", { via: "web" });
      expect(await request).toEqual({ status: 200, body: "upstream reached" }); expect(hits).toBe(2);
    } finally { localRequest.mockRestore(); localAgent.destroy(); upstream.closeAllConnections(); await new Promise<void>((r) => upstream.close(() => r())); }
  });

  it("CONNECT opens its tunnel only after approval and forwards its buffered payload", async () => {
    let hits = 0;
    const upstream = net.createServer((socket) => { hits++; socket.on("data", (data) => socket.end(data)); });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const port = await listen();
    vi.mocked(proxy.resolveTarget).mockResolvedValueOnce(["93.184.216.34"]).mockResolvedValue(["127.0.0.1"]);
    const client = net.connect(port, "127.0.0.1", () => client.write(`CONNECT new.example:${targetPort} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`${token}:x`).toString("base64")}\r\n\r\npayload`));
    const response = new Promise<string>((resolve) => { let out = ""; client.on("data", (b) => out += b); client.on("end", () => resolve(out)); });
    try {
      const card = await pending(); expect(hits).toBe(0);
      client.write("tail"); await new Promise((r) => setTimeout(r, 10));
      expect(hits).toBe(0);
      approvals.resolve(card.id, "approve", { via: "web" });
      expect(await response).toContain("200 Connection Established\r\n\r\npayloadtail"); expect(hits).toBe(1);
    } finally { client.destroy(); await new Promise<void>((r) => upstream.close(() => r())); }
  });

  it("HTTP holds the response until a decision and reports denials and timeouts in its body", async () => {
    const port = await listen();
    const request = httpGet(port, "new.example"); const card = await pending();
    approvals.resolve(card.id, "deny", { via: "web" });
    expect(await request).toMatchObject({ status: 403, body: expect.stringContaining("user declined") });
    expect(await httpGet(port, "new.example")).toMatchObject({ status: 403, body: expect.stringContaining("user did not answer in time") });
    const plugin = proxy.issueToken("plugin:test", []);
    expect((await httpGet(port, "new.example", plugin)).status).toBe(403);
    expect(approvals.list(["pending"])).toHaveLength(0);
  });

  it("bounds pre-approval CONNECT data and grants no access when the buffer overflows", async () => {
    const port = await listen();
    const client = net.connect(port, "127.0.0.1", () => client.write(`CONNECT new.example:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`${token}:x`).toString("base64")}\r\n\r\n`));
    client.on("error", () => {});
    const card = await pending();
    client.write(Buffer.alloc(64 * 1024 + 1, 120));
    await until(() => approvals.get(card.id)?.status === "expired" || undefined);
    expect(approvals.get(card.id)!.ask!.networkClosedReason).toBe("connection_closed");
    expect(settings.get().brainEgressAllow).toEqual([]);
    client.destroy();
  });

  it("CONNECT includes readable denial in the status and body; closed sockets expire their cards", async () => {
    const port = await listen();
    const connect = () => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT new.example:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`${token}:x`).toString("base64")}\r\n\r\n`));
      return socket;
    };
    const socket = connect();
    const response = new Promise<string>((resolve) => { let text = ""; socket.on("data", (b) => text += b); socket.on("end", () => resolve(text)); });
    approvals.resolve((await pending()).id, "deny", { via: "web" });
    const text = await response;
    expect(text.split("\r\n")[0]).toMatch(/403.*user declined/);
    expect(text).toContain("Host new.example");
    const closed = connect(); const card = await pending(); closed.destroy();
    await until(() => approvals.get(card.id)?.status === "expired" || undefined);
    expect(approvals.get(card.id)!.ask!.networkClosedReason).toBe("connection_closed");
  });
});

describe("network decisions in auto mode and after outside content", () => {
  let db: ReturnType<typeof openDb>;
  let proxy: EgressProxy;
  let approvals: ApprovalService;
  let settings: Settings;
  let store: Store;
  let context: { sessionId: string; conversationId: string; agentId: string };
  let answers: string[];
  let reviews: string[];
  const pending = () => until(() => approvals.list(["pending"])[0]);
  const ask = (host = "new.example", port = 443) => proxy.requestHost(context.sessionId, host, port);
  // Each review takes the next answer: stage 1 is ALLOW/BLOCK, stage 2 the JSON verdict.
  const reviewer: Reviewer = async (prompt) => { reviews.push(prompt); return answers.shift() ?? "ALLOW"; };

  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), "network-auto-")), "hub.db"));
    const bus = new EventBus(); store = new Store(db, bus); const audit = new AuditLog(db);
    approvals = new ApprovalService(db, bus, audit, new RuleStore(db)); settings = new Settings(db, "UTC");
    proxy = new EgressProxy(); proxy.extraBrainAllow = () => settings.get().brainEgressAllow;
    const conversationId = store.agentConversation("developer").id;
    const { row } = store.createSession({ conversationId, agentId: "developer", brainRef: "codex@local", background: false });
    context = { sessionId: row.id, conversationId, agentId: "developer" };
    proxy.issueToken(`brain:${row.id}`, ["github.com", "api.openai.com"], context);
    answers = []; reviews = [];
    const auto = new AutoMode({ reviewer: () => reviewer, context: () => ({ person: ["Fetch the repo and run its tests"], calls: [] }), dataDir: "/hub", language: () => "en", audit });
    wireNetworkApprovals({ egress: proxy, approvals, settings, store, audit, auto, workspaceFor: () => "/hub/workspaces/developer/t1", timeoutMs: 200 });
    vi.spyOn(proxy, "resolveTarget").mockResolvedValue(["93.184.216.34"]);
  });
  afterEach(async () => { await proxy.close(); db.close(); vi.restoreAllMocks(); });

  it("the reviewer answers for a new host instead of a card, once per session and port", async () => {
    await ask();
    expect(approvals.list()).toHaveLength(0);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain("new.example:443");
    await ask();
    expect(reviews).toHaveLength(1);
  });

  it("a blocked host becomes a quiet line with the reason, and the person may still allow it once", async () => {
    answers = ["BLOCK", '{"verdict":"block","rule":"exfiltration","reason":"The task does not need this site."}'];
    await expect(ask()).rejects.toThrow("auto mode stopped it: [exfiltration] The task does not need this site.");
    const line = approvals.list(["blocked"])[0];
    expect(line).toMatchObject({ tool: "hub_network_request", input: { host: "new.example", port: 443 }, auto: { rule: "exfiltration" } });
    approvals.resolve(line.id, "approve", { via: "web" });
    await ask();
    expect(reviews).toHaveLength(2);
  });

  it("what the reviewer hands over still gets the card, and ask mode skips the reviewer", async () => {
    answers = ["BLOCK", '{"verdict":"person","rule":"unclear","reason":"Only you know this site."}'];
    const first = ask(); approvals.resolve((await pending()).id, "approve", { via: "web" }); await first;
    settings.update({ approvalMode: "ask" });
    const second = ask("other.example"); approvals.resolve((await pending()).id, "approve", { via: "web" }); await second;
    expect(reviews).toHaveLength(2);
  });

  it("after outside content a listed host is looked at once per session; the brains' own model hosts never", async () => {
    await ask("github.com");
    expect(reviews).toHaveLength(0);
    store.updateSession(context.sessionId, { tainted: true });
    await ask("api.openai.com");
    expect(reviews).toHaveLength(0);
    await ask("github.com");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain("outside content");
    await ask("github.com");
    expect(reviews).toHaveLength(1);
    // Ask mode: the card says the host is listed, and offers no "always".
    settings.update({ approvalMode: "ask" });
    const waiting = ask("github.com", 8443);
    const card = await pending();
    expect(card.ask).toMatchObject({ kind: "network", host: "github.com", port: 8443, listed: true });
    approvals.resolve(card.id, "approve", { via: "web", remember: true }); await waiting;
    expect(settings.get().brainEgressAllow).toEqual([]);
  });
});
