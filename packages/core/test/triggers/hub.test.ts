// The hub runs the trigger engine itself, with no Triggers card: the tools under the plugin's old name, its API at
// /api/triggers and the plugin's old addresses, its two hub settings (carried over once from the card's saved ones),
// standing down and leading again.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval, ToolCallContext } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../../src/index.ts";
import { hubDbFile, openDb } from "../../src/db.ts";
import { TRIGGERS_CARRIED } from "../../src/signals/core-host.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures");

const until = async <T>(fn: () => T | Promise<T>, what: string, timeoutMs = 8000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A hub on a fresh data folder; `card`: the Triggers card's saved settings in its plugins row, as an older hub left them. */
async function startHub(o: { card?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<Hub> {
  const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
  const dataDir = mkdtempSync(join(tmpdir(), "owl-triggers-hub-"));
  if (o.card) {
    const db = openDb(hubDbFile(dataDir));
    db.prepare("insert into plugins(id, dir, source, enabled, granted, installed_at, settings) values (?, ?, ?, ?, ?, ?, ?)").run(
      "triggers",
      "/gone/plugins/triggers",
      "builtin",
      1,
      "{}",
      "2026-10-01T00:00:00Z",
      JSON.stringify(o.card),
    );
    db.close();
  }
  const config = loadConfig(
    { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC", ...o.env },
    // No Triggers card among the built-in plugins: the engine is the hub's own.
    { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(fixtures, "agents") },
  );
  const hub = new Hub(config);
  await hub.start();
  return hub;
}

describe("the hub's trigger engine", () => {
  let hub: Hub;
  let base = "";
  const call: ToolCallContext = { sessionId: "s", conversationId: "c", agentId: "assistant", callId: "x", tainted: false, background: false, workspace: tmpdir(), machineId: "local" };
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

  // Signed in as the person, the way the web UI is (once, on first use).
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, path: string, body?: unknown) => {
    if (!cookie) {
      const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: hub.auth.setupToken, password: "triggers-pass-1" }) });
      cookie = setup.headers.get("set-cookie")!.split(";")[0];
      csrf = ((await (await fetch(base + "/api/bootstrap", { headers: { origin: base, cookie } })).json()) as { csrf: string }).csrf;
    }
    const r = await fetch(base + path, {
      method,
      headers: { origin: base, cookie, "x-csrf": csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(400);
    return r.json;
  };

  beforeAll(async () => {
    // An older hub's Triggers card had local network addresses allowed.
    hub = await startHub({ card: { allowPrivateUrls: true } });
    base = hub.config.publicUrl;
    await until(() => hub.triggers.engine, "the trigger engine to start");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  /** Egress tokens the trigger engine's page loads hold. */
  const egressTokens = () => [...((hub.egress as any).grants as Map<string, { owner: string }>).values()].filter((g) => g.owner === "plugin:triggers").length;

  it("has the trigger tools with no Triggers card, owned by \"triggers\" as the plugin's were", async () => {
    expect(hub.plugins.get("triggers")).toBeUndefined();
    // The old card's leftover row (its settings are migrated from it) is no plugin: not listed, no error.
    expect(hub.plugins.list().map((p) => p.id)).not.toContain("triggers");
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("triggers");
    expect(hub.tools.get("trigger_run_now")?.descriptor.effect).toBe("local-write");
    // The person can still "always allow" them (the hub's own tools cannot be).
    const always = await hub.tools.get("hub_permission_always")!.invoke({ tool: "trigger_update" }, { ...call, approved: true });
    expect((always.content[0] as { text: string }).text).toContain("Allowed: trigger_update runs without approval");
  });

  it("carried the card's saved settings over into the hub settings once, recorded in meta", async () => {
    expect(hub.settings.get()).toMatchObject({ triggersAllowPrivateUrls: true, triggersWatchTimeoutSec: 30 });
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 30 });
    expect(hub.db.prepare("select value from meta where key = ?").get(TRIGGERS_CARRIED)).toBeTruthy();
    expect(hub.audit.list({ action: "settings.update" }).some((a) => a.actor === "core" && JSON.stringify(a.data).includes("triggersAllowPrivateUrls"))).toBe(true);
    // Turned off since: a new start (leading again, a restart) does not bring the card's value back.
    hub.updateSettings({ triggersAllowPrivateUrls: false }, "user");
    expect(hub.triggers.engine!.settings.allowPrivateUrls).toBe(false);
    hub.triggers.stop();
    await hub.triggers.start();
    expect(hub.settings.get().triggersAllowPrivateUrls).toBe(false);
    expect(hub.triggers.engine!.settings.allowPrivateUrls).toBe(false);
  });

  it("serves its API at /api/triggers and at the plugin's old address", async () => {
    const made = await api("POST", "/api/triggers", { kind: "event", name: "From the page", prompt: "Look." });
    const id = String(made.id ?? made.trigger?.id);
    expect(id).toMatch(/^t_/);
    const list = await api("GET", "/api/triggers");
    expect(list.triggers.map((t: { id: string }) => t.id)).toContain(id);
    expect(list.timezone).toBe("UTC");
    expect((await api("GET", `/api/triggers/${id}`)).name).toBe("From the page");
    expect((await api("PATCH", `/api/triggers/${id}`, { name: "Renamed" })).name).toBe("Renamed");
    expect((await api("GET", `/api/triggers/${id}/runs`)).runs).toEqual([]);
    // The plugin's address answers the same (the iOS app, the plugin's page).
    const old = await api("GET", "/api/plugins/triggers/http/triggers");
    expect(old.triggers.map((t: { id: string }) => t.id)).toEqual(list.triggers.map((t: { id: string }) => t.id));
    expect((await api("GET", `/api/plugins/triggers/http/triggers/${id}`)).name).toBe("Renamed");
    // Not found, and not signed in.
    expect((await raw("GET", "/api/triggers/t_none")).status).toBe(404);
    expect((await fetch(`${base}/api/triggers`, { headers: { origin: base } })).status).toBe(401);
    expect((await api("DELETE", `/api/triggers/${id}`)).ok).toBe(true);
  });

  it("takes its settings from the hub settings: the Settings page's change reaches it, a wrong value is refused", async () => {
    const s = await api("GET", "/api/settings");
    expect(s).toMatchObject({ triggersAllowPrivateUrls: false, triggersWatchTimeoutSec: 30 });
    await api("PATCH", "/api/settings", { triggersWatchTimeoutSec: 5, triggersAllowPrivateUrls: true });
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 5 });
    for (const bad of [{ triggersWatchTimeoutSec: 0 }, { triggersWatchTimeoutSec: 121 }, { triggersWatchTimeoutSec: 2.5 }, { triggersAllowPrivateUrls: "yes" }]) {
      const r = await raw("PATCH", "/api/settings", bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json.error).toEqual(expect.any(String));
    }
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 5 });
    await api("PATCH", "/api/settings", { triggersWatchTimeoutSec: 30, triggersAllowPrivateUrls: false });
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: false, watchTimeoutSec: 30 });
  });

  it("lets the assistant change them in the chat: the timeout at once, local network addresses only after the person's yes on a card", async () => {
    const was = hub.settings.get();
    hub.settings.update({ approvalMode: "ask" });
    const answer = (decision: "approve" | "deny") =>
      new Promise<Approval>((resolve) => {
        const off = hub.bus.on("approval.created", (a: Approval) => {
          off();
          setTimeout(() => resolve(hub.approvals.resolve(a.id, decision, { via: "web" })), 10);
        });
      });
    try {
      const conv = hub.store.agentConversation("assistant").id;
      const session = hub.store.createSession({ conversationId: conv, agentId: "assistant", brainRef: "fake@local", background: false }).row.id;
      const update = (patch: Record<string, unknown>) => hub.gateway.call(session, "hub_settings_update", { patch });
      expect(textOf(await update({ triggersWatchTimeoutSec: 12 }))).toContain("triggersWatchTimeoutSec=12");
      expect(hub.triggers.engine!.settings.watchTimeoutSec).toBe(12);
      expect(textOf(await update({ triggersWatchTimeoutSec: 500 }))).toContain("from 1 to 120");
      // Letting triggers reach the local network asks the person first: declined, nothing changes.
      const [no, denied] = await Promise.all([update({ triggersAllowPrivateUrls: true }), answer("deny")]);
      expect(denied.summary).toMatch(/local network/i);
      expect(textOf(no)).toContain("declined");
      expect(hub.settings.get().triggersAllowPrivateUrls).toBe(false);
      const [yes] = await Promise.all([update({ triggersAllowPrivateUrls: true }), answer("approve")]);
      expect(textOf(yes)).toContain("triggersAllowPrivateUrls=true");
      expect(hub.triggers.engine!.settings.allowPrivateUrls).toBe(true);
      // Taking it back needs no yes.
      expect(textOf(await update({ triggersAllowPrivateUrls: false }))).toContain("triggersAllowPrivateUrls=false");
      expect(hub.triggers.engine!.settings.allowPrivateUrls).toBe(false);
    } finally {
      hub.updateSettings({ approvalMode: was.approvalMode, triggersWatchTimeoutSec: 30, triggersAllowPrivateUrls: false }, "user");
    }
  });

  it("answers a webhook at its old address and starts the agent's task", async () => {
    const out = await hub.tools.get("trigger_create")!.invoke({ kind: "event", name: "Deploys", prompt: "Look at the deploy." }, call);
    const text = (out.content[0] as { text: string }).text;
    const id = /trigger (t_[0-9a-f]+)/.exec(text)![1];
    const secret = /Secret: (\S+)/.exec(text)![1];
    expect((await fetch(`${base}/hooks/triggers/${id}`, { method: "POST", headers: { "x-piomio-secret": "wrong" } })).status).toBe(401);
    const r = await fetch(`${base}/hooks/triggers/${id}`, { method: "POST", headers: { "x-piomio-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ build: 42 }) });
    expect(r.status).toBe(202);
    const task = await until(() => hub.store.listTasks({ limit: 50 }).find((t) => t.triggerId === id), "the webhook's task");
    expect(task).toMatchObject({ agentId: "assistant", background: true, createdBy: "trigger" });
    expect(task.goal).toContain("42");
  });

  it("asks the person before an agent gives a script a host its trigger did not have", async () => {
    const was = hub.settings.get();
    hub.settings.update({ approvalMode: "ask", approvalInlineWaitSec: 0.2 });
    try {
      const conv = hub.store.agentConversation("assistant").id;
      const session = hub.store.createSession({ conversationId: conv, agentId: "assistant", brainRef: "fake@local", background: false }).row.id;
      const code = "export default () => ({ note: 'seen' })";
      // No host: a change like any other, made at once.
      const plain = await hub.gateway.call(session, "trigger_create", { kind: "event", name: "Plain", prompt: "Look.", script: { code } });
      expect(textOf(plain)).toContain("Created trigger");
      const plainId = /trigger (t_[0-9a-f]+)/.exec(textOf(plain))![1];
      // A host: an outside action, on a card that names it, and nothing made meanwhile.
      const reach = await hub.gateway.call(session, "trigger_create", { kind: "event", name: "Reach", prompt: "Look.", script: { code, hosts: ["api.example.com"] } });
      expect(reach._meta?.status).toBe("awaiting_approval");
      const card = hub.approvals.get(String(reach._meta?.approvalId))!;
      expect(card).toMatchObject({ tool: "trigger_create", effect: "external" });
      expect(card.summary).toContain("api.example.com");
      expect(hub.triggers.engine!.list().some((t) => t.name === "Reach")).toBe(false);
      // Keeping the hosts a trigger has is a change; adding one is an outside action again, which the normal policy
      // decides: here the person's "always allow" for trigger_update (the first test) lets it through.
      const same = await hub.gateway.call(session, "trigger_update", { id: plainId, name: "Plain again" });
      expect(textOf(same)).toContain("Updated trigger");
      const added = { id: plainId, script: { code, hosts: ["evil.example.org"] } };
      expect(hub.tools.get("trigger_update")!.effectOf!(added, call)).toBe("external");
      expect(hub.tools.get("trigger_update")!.effectOf!({ id: plainId, name: "x" }, call)).toBeUndefined();
      const more = await hub.gateway.call(session, "trigger_update", added);
      expect(textOf(more)).toContain("Updated trigger");
      // Newest first: this call's decision.
      const decision = hub.audit.list({ action: "policy.decision" }).find((a) => a.target === "trigger_update");
      expect(decision?.data).toMatchObject({ decision: "allow", ruleId: expect.any(String) });
    } finally {
      hub.settings.update({ approvalMode: was.approvalMode, approvalInlineWaitSec: was.approvalInlineWaitSec });
    }
  });

  it("makes a watch at once in a session that read nothing from outside, and asks on a card naming its host after outside content", async () => {
    const was = hub.settings.get();
    hub.settings.update({ approvalMode: "ask", approvalInlineWaitSec: 0.2 });
    try {
      const conv = hub.store.agentConversation("assistant").id;
      const watch = (name: string) => ({ kind: "watch", name, prompt: "Look at the price.", url: "https://shop.example.invalid/item", enabled: false });
      const plain = hub.store.createSession({ conversationId: conv, agentId: "assistant", brainRef: "fake@local", background: false }).row.id;
      expect(textOf(await hub.gateway.call(plain, "trigger_create", watch("Plain watch")))).toContain("Created trigger");
      const read = hub.store.createSession({ conversationId: conv, agentId: "assistant", brainRef: "fake@local", background: false, tainted: true }).row.id;
      const asked = await hub.gateway.call(read, "trigger_create", watch("Tainted watch"));
      expect(asked._meta?.status).toBe("awaiting_approval");
      const card = hub.approvals.get(String(asked._meta?.approvalId))!;
      expect(card).toMatchObject({ tool: "trigger_create", effect: "external" });
      expect(card.summary).toContain("shop.example.invalid");
      expect(hub.triggers.engine!.list().some((t) => t.name === "Tainted watch")).toBe(false);
    } finally {
      hub.settings.update({ approvalMode: was.approvalMode, approvalInlineWaitSec: was.approvalInlineWaitSec });
    }
  });

  it("marks hub.task.finished as outside content when the task's session read a source tool, though the task was started plain", async () => {
    const created = await hub.tools.get("trigger_create")!.invoke(
      { name: "Finished tasks", prompt: "Look at the result.", on: [{ type: "hub.task.finished" }], script: { code: "export default (s) => ({ note: 'finished ' + s.data.taskId })" } },
      call,
    );
    const id = /trigger (t_[0-9a-f]+)/.exec((created.content[0] as { text: string }).text)![1];
    const task = hub.store.createTask({ agentId: "assistant", title: "Research", goal: "Read the web", createdBy: "user", background: true });
    expect(task.tainted).toBeFalsy();
    const session = hub.store.createSession({ conversationId: task.conversationId, taskId: task.id, agentId: "assistant", brainRef: "fake@local", background: true }).row.id;
    // A tool that reads outside content taints the session, not the task.
    await hub.gateway.call(session, "signals_recent", {});
    expect(hub.store.getTask(task.id)!.tainted).toBeFalsy();
    hub.store.updateTask(task.id, { status: "done", result: "What the page said" });
    const run = await until(async () => (await hub.triggers.engine!.runs(id)).find((r) => r.outcome === "note"), "the finished task's note");
    expect(run).toMatchObject({ external: true, signals: [{ type: "hub.task.finished", subject: "Research" }] });
    expect(hub.triggers.notes({ triggerId: id })).toMatchObject([{ text: `finished ${task.id}`, external: true }]);
    await hub.tools.get("trigger_delete")!.invoke({ id }, call);
  });

  it("checks a signature over the exact bytes of a real request, with the key from the vault", async () => {
    hub.vault.init("webhook-verify-passphrase");
    hub.vault.upsert({ id: "gh-hook", type: "secret", name: "Hook key", fields: { value: "hookkey" } });
    const made = await hub.triggers.http({ method: "POST", path: "/triggers", query: {}, headers: {}, public: false, locale: "en", body: { kind: "event", name: "GH", prompt: "Look.", verify: { kind: "github", secretRef: "vault://gh-hook" } } });
    const id = ((made.body as any).trigger?.id ?? (made.body as any).id) as string;
    // The Triggers page learns from the view how the sender is checked: the kind and the vault reference, never the key.
    expect((made.body as any).verify).toEqual({ kind: "github", secretRef: "vault://gh-hook" });
    const listed = await hub.triggers.http({ method: "GET", path: "/triggers", query: {}, headers: {}, public: false, locale: "en" });
    expect((listed.body as any).triggers.find((x: { id: string }) => x.id === id).verify).toEqual({ kind: "github", secretRef: "vault://gh-hook" });
    expect(JSON.stringify(listed.body)).not.toContain("hookkey");
    // Spacing the parsed JSON would lose: only the raw bytes carry it.
    const raw = '{ "action":  "opened",\n "n": 1 }';
    const sig = (k: string) => "sha256=" + createHmac("sha256", k).update(raw).digest("hex");
    const send = (signature: string) => fetch(`${base}/hooks/triggers/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
    expect((await send(sig("wrong"))).status).toBe(401);
    expect((await send(sig("hookkey"))).status).toBe(202);
    // A trigger whose vault item is gone answers 503 (a key already read is kept for 30 s).
    const gone = await hub.triggers.http({ method: "POST", path: "/triggers", query: {}, headers: {}, public: false, locale: "en", body: { kind: "event", name: "GH2", prompt: "Look.", verify: { kind: "github", secretRef: "vault://no-such" } } });
    const goneId = ((gone.body as any).trigger?.id ?? (gone.body as any).id) as string;
    const r2 = await fetch(`${base}/hooks/triggers/${goneId}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig("hookkey") }, body: raw });
    expect(r2.status).toBe(503);
    // A key the person kept for another agent is not read for this trigger's agent (the item's scope).
    hub.vault.upsert({ id: "gh-other", type: "secret", name: "Other agent's key", fields: { value: "hookkey" }, scope: { agents: ["someone-else"] } });
    const scoped = await hub.triggers.http({ method: "POST", path: "/triggers", query: {}, headers: {}, public: false, locale: "en", body: { kind: "event", name: "GH3", prompt: "Look.", verify: { kind: "github", secretRef: "vault://gh-other" } } });
    const scopedId = ((scoped.body as any).trigger?.id ?? (scoped.body as any).id) as string;
    const r3 = await fetch(`${base}/hooks/triggers/${scopedId}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig("hookkey") }, body: raw });
    expect(r3.status).toBe(503);
    hub.vault.seal();
  });

  it("stops when the hub stands down for another replica and starts again when it leads", async () => {
    await hub.standby();
    expect(hub.triggers.engine).toBeUndefined();
    expect(hub.tools.get("trigger_create")).toBeUndefined();
    expect(egressTokens()).toBe(0);
    expect((await fetch(`${base}/hooks/triggers/t_any`, { method: "POST" })).status).toBe(404);
    // A settings change or a plugin change on a standby replica does not start it: only the leader runs triggers.
    hub.updateSettings({ triggersWatchTimeoutSec: 9 }, "user");
    hub.bus.emit("plugins.updated", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.triggers.engine).toBeUndefined();
    await hub.lead();
    expect(hub.triggers.engine).toBeDefined();
    expect(hub.triggers.engine!.settings.watchTimeoutSec).toBe(9);
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("triggers");
    expect(egressTokens()).toBe(1);
  });
});

describe("the trigger engine and PIOMIO_PLUGINS", () => {
  it("does not run on a hub with no plugins at all (PIOMIO_PLUGINS=none), and still carries the card's settings over", async () => {
    const hub = await startHub({ env: { PIOMIO_PLUGINS: "none" }, card: { watchTimeoutSec: 60 } });
    try {
      expect(hub.triggers.wanted()).toBe(false);
      expect(hub.triggers.engine).toBeUndefined();
      expect(hub.tools.get("trigger_create")).toBeUndefined();
      expect(hub.settings.get().triggersWatchTimeoutSec).toBe(60);
    } finally {
      await hub.stop();
    }
  });
});
