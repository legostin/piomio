// Hosts inside the person's network: closed until they say yes on a card of their own, never auto mode's call.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { EventBus } from "../src/bus.ts";
import { AuditLog } from "../src/audit.ts";
import { RuleStore } from "../src/policy/rules.ts";
import { ApprovalService } from "../src/approvals.ts";
import { Settings } from "../src/settings.ts";
import { EgressProxy, privateClass, privatePattern } from "../src/egress.ts";
import { wireNetworkApprovals } from "../src/network-approvals.ts";
import { AutoMode, type Reviewer } from "../src/policy/auto.ts";

async function until<T>(f: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("No pending card");
}

it("tells a network of the person's own from this computer and from the public internet", () => {
  for (const ip of ["10.1.2.3", "172.16.0.9", "192.168.1.10", "100.100.1.1", "fd12::1", "::ffff:10.0.0.5"]) expect(privateClass(ip), ip).toBe("lan");
  for (const ip of ["127.0.0.1", "::1", "169.254.169.254", "168.63.129.16", "0.0.0.0", "224.0.0.1", "fe80::1", "198.18.0.1"]) expect(privateClass(ip), ip).toBe("local");
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(privateClass(ip), ip).toBe("public");
});

it("a list of private hosts takes names, single labels, wildcards and IPs, never everything or a URL", () => {
  expect(privatePattern(" Jira.Corp.Example. ")).toBe("jira.corp.example");
  expect(privatePattern("*.Corp.example")).toBe("*.corp.example");
  expect(privatePattern("nas")).toBe("nas");
  expect(privatePattern("nas.local")).toBe("nas.local");
  expect(privatePattern("192.168.1.10")).toBe("192.168.1.10");
  expect(privatePattern("[FD12::1]")).toBe("fd12::1");
  for (const bad of ["*", "*.", "*.*", "http://nas.local", "nas.local/path", "nas.local:8080", "a b", "", "*.10.0.0.1", "-x.example", "x\r\ny"]) expect(() => privatePattern(bad), bad).toThrow();
});

describe("private hosts", () => {
  let db: ReturnType<typeof openDb>;
  let proxy: EgressProxy;
  let approvals: ApprovalService;
  let settings: Settings;
  let store: Store;
  let audit: AuditLog;
  let context: { sessionId: string; conversationId: string; agentId: string };
  let token: string;
  let dns: Record<string, string[]>;
  let reviews: string[];
  const pending = () => until(() => approvals.list(["pending"])[0]);
  const ask = (host: string, port = 443) => proxy.requestHost(context.sessionId, host, port);
  const reviewer: Reviewer = async (prompt) => { reviews.push(prompt); return "ALLOW"; };

  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), "private-network-")), "hub.db"));
    const bus = new EventBus(); store = new Store(db, bus); audit = new AuditLog(db);
    approvals = new ApprovalService(db, bus, audit, new RuleStore(db)); settings = new Settings(db, "UTC");
    settings.update({ approvalMode: "ask" });
    proxy = new EgressProxy();
    proxy.extraBrainAllow = () => settings.get().brainEgressAllow;
    proxy.privateAllow = () => settings.get().egressPrivateAllow;
    proxy.ownAddresses = () => ["192.168.1.2"];
    dns = {
      "jira.corp.example": ["10.20.30.40"], "wiki.corp.example": ["10.20.30.41"], "public.example": ["93.184.216.34"],
      "rebind.example": ["127.0.0.1"], "meta.example": ["169.254.169.254"], "self.example": ["192.168.1.2"], nas: ["192.168.1.50"], localhost: ["127.0.0.1"],
    };
    proxy.lookup = async (h) => { if (!dns[h]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return dns[h]; };
    const conversationId = store.agentConversation("developer").id;
    const { row } = store.createSession({ conversationId, agentId: "developer", brainRef: "codex@local", background: false });
    context = { sessionId: row.id, conversationId, agentId: "developer" };
    token = proxy.issueToken(`brain:${row.id}`, ["known.example"], context);
    reviews = [];
    const auto = new AutoMode({ reviewer: () => reviewer, context: () => ({ person: ["Open our Jira"], calls: [] }), dataDir: "/hub", language: () => "en", audit });
    wireNetworkApprovals({ egress: proxy, approvals, settings, store, audit, auto, workspaceFor: () => "/hub/workspaces/developer", timeoutMs: 300 });
  });
  afterEach(async () => { await proxy.close(); db.close(); });

  it("a host inside the person's network gets its own card with the address it resolves to", async () => {
    const waiting = ask("jira.corp.example");
    const card = await pending();
    expect(card).toMatchObject({ ...context, tool: "hub_network_request", ask: { kind: "network", host: "jira.corp.example", port: 443, private: true, addresses: ["10.20.30.40"] } });
    expect(card.summary).toContain("jira.corp.example");
    approvals.resolve(card.id, "approve", { via: "web" });
    await waiting;
    // Once: this session reaches it again without a card, nothing is written down.
    await ask("jira.corp.example");
    expect(approvals.list()).toHaveLength(1);
    expect(settings.get().egressPrivateAllow).toEqual([]);
    expect(settings.get().brainEgressAllow).toEqual([]);
    expect(await proxy.resolveTarget("jira.corp.example")).toEqual(["10.20.30.40"]);
  });

  it("once ends with the session: the next one is asked again", async () => {
    const waiting = ask("jira.corp.example");
    approvals.resolve((await pending()).id, "approve", { via: "web" });
    await waiting;
    proxy.revoke(token);
    await expect(proxy.resolveTarget("jira.corp.example")).rejects.toThrow(/private/);
    token = proxy.issueToken(`brain:${context.sessionId}`, [], context);
    const again = ask("jira.corp.example"); const declined = expect(again).rejects.toThrow("user declined");
    approvals.resolve((await pending()).id, "deny", { via: "web" });
    await declined;
  });

  it("once is that session's alone: another brain's shell is asked for itself, on any port", async () => {
    const waiting = ask("jira.corp.example");
    approvals.resolve((await pending()).id, "approve", { via: "web" });
    await waiting;
    const other = store.createSession({ conversationId: context.conversationId, agentId: "developer", brainRef: "codex@local", background: false }).row;
    proxy.issueToken(`brain:${other.id}`, [], { sessionId: other.id, conversationId: other.conversationId, agentId: "developer" });
    const theirs = proxy.requestHost(other.id, "jira.corp.example", 443); const declined = expect(theirs).rejects.toThrow("user declined");
    const card = await pending();
    expect(card).toMatchObject({ sessionId: other.id, ask: { private: true } });
    approvals.resolve(card.id, "deny", { via: "web" });
    await declined;
    // The first session on another port: still the person's card, never an ordinary one a reviewer could answer.
    settings.update({ approvalMode: "auto" });
    const port = ask("jira.corp.example", 8443); const no = expect(port).rejects.toThrow("user declined");
    const second = await pending();
    expect(second.ask).toMatchObject({ private: true, port: 8443 });
    expect(reviews).toHaveLength(0);
    approvals.resolve(second.id, "deny", { via: "web" });
    await no;
  });

  it("always writes the exact host to the private list only, and removing it closes the host again", async () => {
    const waiting = ask("jira.corp.example");
    const card = await pending();
    approvals.resolve(card.id, "approve", { via: "web", remember: true });
    await waiting;
    expect(settings.get().egressPrivateAllow).toEqual(["jira.corp.example"]);
    expect(settings.get().brainEgressAllow).toEqual([]);
    expect(audit.list({ action: "egress.private.always" })).toHaveLength(1);
    // A host on the private list is open to brains without a second list.
    await ask("jira.corp.example");
    expect(approvals.list()).toHaveLength(1);
    // Its neighbour is not.
    const other = ask("wiki.corp.example"); const declined = expect(other).rejects.toThrow("user declined");
    approvals.resolve((await pending()).id, "deny", { via: "web" });
    await declined;
    settings.update({ egressPrivateAllow: [] });
    const closed = ask("jira.corp.example"); const no = expect(closed).rejects.toThrow("user declined");
    approvals.resolve((await pending()).id, "deny", { via: "web" });
    await no;
  });

  it("a host already on the public list that resolves inside the network still asks, as a private one", async () => {
    settings.update({ brainEgressAllow: ["jira.corp.example", "*.corp.example"] });
    const waiting = ask("jira.corp.example");
    const card = await pending();
    expect(card.ask).toMatchObject({ private: true, addresses: ["10.20.30.40"] });
    expect(card.ask?.listed).toBeUndefined();
    approvals.resolve(card.id, "approve", { via: "web" });
    await waiting;
  });

  it("after outside content a host on the private list asks like any listed one: about this session, with no always", async () => {
    settings.update({ egressPrivateAllow: ["jira.corp.example", "nas"] });
    await ask("jira.corp.example");
    expect(approvals.list()).toHaveLength(0);
    store.updateSession(context.sessionId, { tainted: true });
    for (const host of ["jira.corp.example", "nas"]) {
      const waiting = ask(host);
      const card = await pending();
      expect(card.ask).toMatchObject({ kind: "network", host, listed: true });
      expect(card.ask?.private).toBeUndefined();
      approvals.resolve(card.id, "approve", { via: "web", remember: true });
      await waiting;
    }
    expect(settings.get().egressPrivateAllow).toEqual(["jira.corp.example", "nas"]);
  });

  it("this computer, link-local and metadata addresses are never offered", async () => {
    for (const host of ["rebind.example", "meta.example", "self.example", "127.0.0.1", "169.254.169.254", "localhost"]) {
      await expect(ask(host), host).rejects.toThrow(/this computer|not offered|private/i);
    }
    expect(approvals.list()).toHaveLength(0);
  });

  it("a name from public DNS on the private list is never followed to this computer", async () => {
    settings.update({ egressPrivateAllow: ["jira.corp.example", "nas", "127.0.0.1"] });
    expect(await proxy.resolveTarget("jira.corp.example")).toEqual(["10.20.30.40"]);
    dns["jira.corp.example"] = ["127.0.0.1"];
    await expect(proxy.resolveTarget("jira.corp.example")).rejects.toThrow(/this computer/);
    dns["jira.corp.example"] = ["192.168.1.2"];
    await expect(proxy.resolveTarget("jira.corp.example")).rejects.toThrow(/this computer/);
    // What the person listed by a local name or by its address stays theirs to open.
    dns.nas = ["127.0.0.1"];
    expect(await proxy.resolveTarget("nas")).toEqual(["127.0.0.1"]);
    expect(await proxy.resolveTarget("127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("auto mode never answers for the person's network: the card is theirs", async () => {
    settings.update({ approvalMode: "auto" });
    const waiting = ask("jira.corp.example");
    const card = await pending();
    expect(reviews).toHaveLength(0);
    approvals.resolve(card.id, "approve", { via: "web" });
    await waiting;
    // A public host still goes to the reviewer.
    await ask("public.example");
    expect(reviews).toHaveLength(1);
    expect(approvals.list()).toHaveLength(1);
  });

  it("a tool's address is asked about for its session without a shell of the hub's", async () => {
    const other = store.createSession({ conversationId: context.conversationId, agentId: "developer", brainRef: "claude@pc", background: false }).row;
    const ctx = { sessionId: other.id, conversationId: other.conversationId, agentId: "developer" };
    const plugin = proxy.issueToken("plugin:browser", ["*"]);
    expect(proxy.allowed(plugin, "jira.corp.example").ok).toBe(true);
    await expect(proxy.resolveTarget("jira.corp.example")).rejects.toThrow(/private/);
    const waiting = proxy.requestPrivate(ctx, "jira.corp.example", 443);
    const card = await pending();
    expect(card).toMatchObject({ sessionId: other.id, ask: { private: true, addresses: ["10.20.30.40"] } });
    approvals.resolve(card.id, "approve", { via: "web" });
    await waiting;
    // The plugin's browser now gets through; a public host needs no card at all.
    expect(await proxy.resolveTarget("jira.corp.example")).toEqual(["10.20.30.40"]);
    expect(await proxy.requestPrivate(ctx, "public.example", 443)).toBe(false);
    expect(approvals.list()).toHaveLength(1);
    // The session is over: so is its yes.
    proxy.forgetSession(other.id);
    await expect(proxy.resolveTarget("jira.corp.example")).rejects.toThrow(/private/);
  });

  it("a declined or unanswered private card says so and grants nothing", async () => {
    const ctx = { ...context };
    const declined = proxy.requestPrivate(ctx, "jira.corp.example", 443); const no = expect(declined).rejects.toThrow("user declined");
    approvals.resolve((await pending()).id, "deny", { via: "web" });
    await no;
    await expect(proxy.requestPrivate(ctx, "jira.corp.example", 443)).rejects.toThrow("user did not answer in time");
    await expect(proxy.resolveTarget("jira.corp.example")).rejects.toThrow(/private/);
    expect(settings.get().egressPrivateAllow).toEqual([]);
  });

  it("a wildcard is the person's to type in settings: a card never writes one", async () => {
    const waiting = ask("jira.corp.example");
    const card = await pending();
    db.prepare("update approvals set ask = ? where id = ?").run(JSON.stringify({ ...card.ask, host: "*.corp.example" }), card.id);
    expect(() => approvals.resolve(card.id, "approve", { via: "web", remember: true })).toThrow();
    expect(settings.get().egressPrivateAllow).toEqual([]);
    approvals.resolve(card.id, "deny", { via: "web" });
    await expect(waiting).rejects.toThrow();
  });
});
