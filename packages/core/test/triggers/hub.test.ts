// The hub runs the trigger engine itself: the tools under the card's name, the old webhook address, the card's switch
// and settings, standing down and leading again.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../../src/index.ts";
import { listIntegrations, popularIds } from "../../src/integrations.ts";

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

describe("the hub's trigger engine", () => {
  let hub: Hub;
  let base = "";
  const call: ToolCallContext = { sessionId: "s", conversationId: "c", agentId: "assistant", callId: "x", tainted: false, background: false, workspace: tmpdir(), machineId: "local" };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-triggers-hub-")), builtinPluginsDirs: [join(fixtures, "triggers-card")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.triggers.engine, "the trigger engine to start");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  /** Egress tokens the trigger engine's page loads hold. */
  const egressTokens = () => [...((hub.egress as any).grants as Map<string, { owner: string }>).values()].filter((g) => g.owner === "plugin:triggers").length;

  it("has the trigger tools, owned by the Triggers card as the plugin's were", async () => {
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("triggers");
    expect(hub.tools.get("trigger_run_now")?.descriptor.effect).toBe("local-write");
    // The person can still "always allow" them (the hub's own tools cannot be).
    const always = await hub.tools.get("hub_permission_always")!.invoke({ tool: "trigger_update" }, { ...call, approved: true });
    expect((always.content[0] as { text: string }).text).toContain("Allowed: trigger_update runs without approval");
  });

  it("credits the card with its tools' uses in the catalog, on or off", async () => {
    for (let i = 0; i < 3; i++) hub.audit.append("agent:assistant", "policy.decision", "trigger_list", { decision: "allow" });
    expect(popularIds(hub, await listIntegrations(hub, "en"))).toContain("triggers");
    // Off, its tools are gone: their earlier uses are matched by the card's tool prefix.
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.tools.get("trigger_list"), "the tools to go");
    expect(popularIds(hub, await listIntegrations(hub, "en"))).toContain("triggers");
    await hub.plugins.setEnabled("triggers", true);
    await until(() => hub.triggers.engine && hub.tools.get("trigger_list"), "the engine to start again");
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
      const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");
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

  it("checks a signature over the exact bytes of a real request, with the key from the vault", async () => {
    hub.vault.init("webhook-verify-passphrase");
    hub.vault.upsert({ id: "gh-hook", type: "secret", name: "Hook key", fields: { value: "hookkey" } });
    const made = await hub.triggers.http({ method: "POST", path: "/triggers", query: {}, headers: {}, public: false, locale: "en", body: { kind: "event", name: "GH", prompt: "Look.", verify: { kind: "github", secretRef: "vault://gh-hook" } } });
    const id = ((made.body as any).trigger?.id ?? (made.body as any).id) as string;
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
    hub.vault.seal();
  });

  it("turned on from its card in a chat, tells the agent its tool names", async () => {
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.triggers.engine, "the engine to stop");
    // Signed in as the person, the way the web UI is.
    let cookie = "";
    const api = async (method: string, path: string, body?: unknown, csrf = "") => {
      const r = await fetch(base + path, {
        method,
        headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      cookie = r.headers.get("set-cookie")?.split(";")[0] ?? cookie;
      expect(r.status).toBeLessThan(400);
      return r.json();
    };
    await api("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "triggers-pass-1" });
    const { csrf } = await api("GET", "/api/bootstrap");
    const conv = hub.store.agentConversation("assistant");
    const told = vi.spyOn(hub.runner, "tellAgent").mockImplementation(() => {});
    try {
      await api("POST", "/api/integrations/triggers/enabled", { enabled: true, conversationId: conv.id }, csrf);
      expect(told).toHaveBeenCalledWith(conv.id, expect.stringMatching(/its tools are available now: .*trigger_create/));
    } finally {
      told.mockRestore();
    }
    await until(() => hub.triggers.engine, "the engine to start again");
  });

  it("a settings listener that throws stops neither the others nor the audit line", () => {
    const heard: unknown[] = [];
    const offBad = hub.plugins.onSettings("triggers", () => {
      throw new Error("listener broke");
    });
    const offGood = hub.plugins.onSettings("triggers", (x) => void heard.push(x));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = hub.audit.list({ action: "plugin.settings" }).length;
    try {
      expect(() => hub.plugins.setSettings("triggers", { watchTimeoutSec: 7 })).not.toThrow();
      expect(heard).toEqual([{ watchTimeoutSec: 7 }]);
      expect(hub.triggers.engine!.settings.watchTimeoutSec).toBe(7);
      expect(hub.audit.list({ action: "plugin.settings" }).length).toBe(before + 1);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("listener broke"));
    } finally {
      err.mockRestore();
      offBad();
      offGood();
    }
  });

  it("stops when the hub stands down for another replica and starts again when it leads", async () => {
    await hub.standby();
    expect(hub.triggers.engine).toBeUndefined();
    expect(hub.tools.get("trigger_create")).toBeUndefined();
    expect(egressTokens()).toBe(0);
    expect((await fetch(`${base}/hooks/triggers/t_any`, { method: "POST" })).status).toBe(404);
    // A card change on a standby replica does not start it: only the leader runs triggers.
    hub.bus.emit("plugins.updated", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.triggers.engine).toBeUndefined();
    await hub.lead();
    expect(hub.triggers.engine).toBeDefined();
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("triggers");
    expect(egressTokens()).toBe(1);
  });

  it("follows the card: settings reach the engine, off stops it, on starts it again", async () => {
    hub.plugins.setSettings("triggers", { allowPrivateUrls: true, watchTimeoutSec: 5 });
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 5 });
    expect(egressTokens()).toBe(1);
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.triggers.engine, "the engine to stop");
    expect(hub.tools.get("trigger_create")).toBeUndefined();
    expect((await fetch(`${base}/hooks/triggers/t_any`, { method: "POST" })).status).toBe(404);
    // Its page loads' egress token goes with it, and a new one comes with the next start.
    expect(egressTokens()).toBe(0);
    await hub.plugins.setEnabled("triggers", true);
    await until(() => hub.triggers.engine && hub.tools.get("trigger_create"), "the engine to start again");
    expect(egressTokens()).toBe(1);
  });
});
