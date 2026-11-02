// First-run setup in the chat: with no working brain the hub answers with a setup card and keeps the message; signing
// a brain in answers it; any brain the hub has counts, whichever agent asked; a new hub's assistant opens the intro when
// its empty dialog is opened (a server's link first, while it waits for Tailscale's sign-in); the default agent leads
// the rest of the setup. The agent runs on `gated@local`
// (fixtures/plugins/fakegated: signed in while HOME/.gated-ok exists) and the real Codex brain on a fake CLI that is not
// signed in; the always-signed-in fake brains are turned off, so the hub starts with none.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBrainRef, parseBrainRef, type ProbeResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { INTRO_REMOTE_NOTE, SetupGuide } from "../src/setup.ts";

const fixtures = join(import.meta.dirname, "fixtures");

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A hub on the setup fixtures with its owner signed in to the web API. */
async function startHub() {
  const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
  const dataDir = mkdtempSync(join(tmpdir(), "ob-setup-"));
  const config = loadConfig(
    { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
    { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "setup-agents") },
  );
  const agentHome = join(dataDir, "home", "agent");
  mkdirSync(agentHome, { recursive: true });
  const hub = new Hub(config);
  await hub.start();
  await hub.plugins.setEnabled("fakebrain", false);
  const base = config.publicUrl;
  let cookie = "";
  let csrf = "";
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
  await until(() => hub.brains.has("gated@local") && hub.brains.has("codex@local") && !hub.brains.has("fake@local"), "brains");
  await ok("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
  const boot = await ok("GET", "/api/bootstrap");
  csrf = boot.csrf;
  const conv: string = boot.mainConversationId;
  const messages = async (): Promise<any[]> => ok("GET", `/api/conversations/${conv}/messages`);
  const signIn = async () => {
    writeFileSync(join(agentHome, ".gated-ok"), "");
    return ok("POST", "/api/setup/refresh", {});
  };
  return { hub, ok, conv, messages, signIn };
}

const replies = (msgs: any[]) => msgs.filter((m) => m.role === "assistant" && m.status !== "streaming");
const cards = (msgs: any[]) => msgs.filter((m) => m.parts.some((p: any) => p.type === "brain_setup"));
const textOf = (m: any) => m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");

/** A setup guide over brains given as ref → signed in, for an agent with these brains. */
function guideOver(refs: Record<string, boolean>, agentBrains: string[]): SetupGuide {
  const key = (r: string) => formatBrainRef(parseBrainRef(r));
  return new SetupGuide({
    brains: {
      list: () => Object.keys(refs).map((ref) => ({ ref })),
      has: (r: string) => key(r) in refs,
      probe: async (r: string): Promise<ProbeResult> => ({ available: true, authenticated: refs[key(r)] }),
    },
    agents: { get: () => ({ brains: agentBrains }) },
    settings: { get: () => ({ defaultAgent: "assistant" }), getKey: () => ({}), setKey: () => {} },
    bus: { on: () => {}, emit: () => {} },
  } as any);
}

describe("what counts as a brain", () => {
  it("one API key is a brain for an agent on api:*", async () => {
    const g = guideOver({ "api:anthropic@local": false, "api:deepseek@local": true }, ["claude-code@local", "codex@local", "api:*"]);
    expect(await g.usable()).toBe(true);
  });

  it("any brain that works on the hub counts, also for an agent whose own brains are not set up", async () => {
    expect(await guideOver({ "codex@local": false, "api:deepseek@local": true }, ["codex@local"]).usable()).toBe(true);
    expect(await guideOver({ "codex@vps": true }, ["claude-code@local"]).usable()).toBe(true);
  });

  it("says the hub is starting until its brains are in, and asks the page to look again then", () => {
    const g = guideOver({ "claude-code@local": true }, ["claude-code@local"]);
    const emitted: string[] = [];
    (g as any).d.bus.emit = (e: string) => emitted.push(e);
    expect(g.starting()).toBe(true);
    g.start();
    expect(g.starting()).toBe(false);
    expect(emitted).toContain("brains.updated");
    g.stop();
    expect(g.starting()).toBe(true);
  });

  it("none when nothing on the hub works", async () => {
    expect(await guideOver({ "codex@local": false, "api:anthropic@local": false }, ["codex@local", "api:*"]).usable()).toBe(false);
  });
});

/** A guide on a hub with one signed-in brain, whose link from anywhere is as given; `saved`: the setup so far. */
function guideWithLink(link: { on: boolean; up: boolean }, saved: Record<string, unknown> = { kickoffDone: true, intro: true }) {
  let kept: unknown = saved;
  const told: string[] = [];
  const guide = new SetupGuide({
    apiKeys: false,
    brains: {
      list: () => [{ ref: "claude-code@local", label: "Claude Code", login: true }],
      has: () => true,
      probe: async (): Promise<ProbeResult> => ({ available: true, authenticated: true }),
    },
    agents: { get: () => ({ brains: ["claude-code@local"] }) },
    settings: { get: () => ({ defaultAgent: "assistant" }), getKey: () => kept, setKey: (_k: string, v: unknown) => (kept = v) },
    store: { agentConversation: () => ({ id: "c1" }), listMessages: () => [] },
    vault: { state: () => "uninitialized" },
    channels: { list: () => [] },
    machines: { list: () => [] },
    remote: () => link,
    cliTools: { forBrain: () => undefined },
    bus: { on: () => {}, emit: () => {} },
    isRunning: () => false,
    tellAgent: (_id: string, note: string) => told.push(note),
  } as any);
  return { guide, told };
}

describe("the link from anywhere in the setup", () => {
  it("opens a new hub's intro while it waits for Tailscale's sign-in", async () => {
    const { guide, told } = guideWithLink({ on: true, up: false }, {});
    expect(await guide.startIntro()).toBe(true);
    expect(told).toEqual([INTRO_REMOTE_NOTE]);
    expect((await guide.state()).remaining).toEqual(["remote", "identity", "team", "telegram", "machines", "profile"]);
    const block = await guide.promptBlock("assistant");
    expect(block).toMatch(/getting acquainted[\s\S]*- remote:[\s\S]*- identity:[\s\S]*- team:/);
    expect(block).toContain('`integration_connect` with id "remote-access"');
  });

  it("is done by itself once the link is up, and absent while access from anywhere is off", async () => {
    const up = await guideWithLink({ on: true, up: true }).guide.state();
    expect(up.done).toContain("remote");
    expect(up.remaining[0]).toBe("identity");
    const off = guideWithLink({ on: false, up: false });
    expect(await off.guide.state()).toMatchObject({ remaining: ["identity", "team", "telegram", "machines", "profile"] });
    expect(await off.guide.promptBlock("assistant")).not.toMatch(/remote/);
  });

  it("is offered among the rest on a hub past its intro", async () => {
    const block = await guideWithLink({ on: true, up: false }, { kickoffDone: true }).guide.promptBlock("assistant");
    expect(block).not.toMatch(/getting acquainted/);
    expect(block).toMatch(/Steps left:\n- remote:/);
  });
});

describe("setup with no working brain", () => {
  let h: Awaited<ReturnType<typeof startHub>>;

  beforeAll(async () => {
    h = await startHub();
  });

  afterAll(async () => {
    await h?.hub.stop();
  });

  it("lists the agent's brains and the steps left", async () => {
    const s = await h.ok("GET", "/api/setup");
    expect(s).toMatchObject({ agentId: "assistant", usable: false, firstRun: true, starting: false, vault: "absent", telegram: false, machines: 0 });
    expect(s.brains).toEqual([
      expect.objectContaining({ ref: "gated@local", kind: "api", signedIn: false }),
      expect.objectContaining({ ref: "codex@local", kind: "cli", installed: true, signedIn: false, canInstall: false }),
    ]);
    expect(s.remaining).toEqual(["telegram", "backupBrain", "machines", "profile"]);
  });

  it("answers a message with one setup card instead of an error, and keeps it", async () => {
    await h.ok("POST", `/api/conversations/${h.conv}/messages`, { text: "привет" });
    await until(async () => cards(await h.messages()).length === 1, "the setup card");
    await h.ok("POST", `/api/conversations/${h.conv}/messages`, { text: "ещё раз" });
    await until(() => h.hub.setup.isHeld(h.conv) && !h.hub.runner.isRunning(h.conv), "the second message to wait");
    const msgs = await h.messages();
    expect(cards(msgs)).toHaveLength(1);
    expect(msgs.flatMap((m) => m.parts).some((p: any) => p.type === "error")).toBe(false);
    expect(replies(msgs)).toEqual([]);
  });

  it("answers the waiting messages once a brain is signed in, without a greeting", async () => {
    const s = await h.signIn();
    expect(s.usable).toBe(true);
    const reply = await until(async () => replies(await h.messages())[0], "the answer");
    expect(textOf(reply)).toBe("gated heard: привет | ещё раз");
    await sleep(1000);
    expect(replies(await h.messages())).toHaveLength(1);
    expect(h.hub.setup.isHeld(h.conv)).toBe(false);
    // That answer was the hub's first words: the intro follows it from the setup section.
    expect(h.hub.settings.getKey("setup", {} as any)).toMatchObject({ kickoffDone: true, intro: true });
  });

  it("lets an agent whose own brains are not set up think with the hub's", async () => {
    await h.ok("PUT", "/api/agents/coder", { name: "Coder", brains: ["codex@local"], prompt: "You code." });
    expect((await h.ok("GET", "/api/setup?agent=coder")).usable).toBe(true);
    const conv = h.hub.store.agentConversation("coder").id;
    await h.ok("POST", `/api/conversations/${conv}/messages`, { text: "hi coder" });
    const reply = await until(async () => replies(await h.ok("GET", `/api/conversations/${conv}/messages`))[0], "the coder's answer");
    expect(textOf(reply)).toBe("gated heard: hi coder");
    expect(cards(await h.ok("GET", `/api/conversations/${conv}/messages`))).toEqual([]);
  });

  it("gives the default agent the setup section and its tools", async () => {
    const say = async (text: string) => {
      const sent = await h.ok("POST", `/api/conversations/${h.conv}/messages`, { text });
      return textOf(
        await until(async () => {
          const msgs = await h.messages();
          return replies(msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1))[0];
        }, `the reply to ${text}`),
      );
    };
    expect(await say("SETUP?")).toBe("setup section: yes");
    expect(await say('CALL hub_setup_update {"step":"telegram","status":"skipped"}')).toMatch(/"remaining": \[\s*"identity",\s*"team",\s*"backupBrain",\s*"machines",\s*"profile"\s*\]/);
    expect((await h.ok("GET", "/api/setup")).skipped).toEqual(["telegram"]);
    expect(await say("CALL hub_setup_status {}")).toMatch(/"skipped": \[\s*"telegram"\s*\]/);
    expect(await say('CALL hub_setup_update {"step":"telegram","status":"todo"}')).toMatch(/"telegram"/);
    expect(await say('CALL hub_setup_update {"step":"profile","status":"done"}')).not.toMatch(/"profile"/);
    expect((await h.ok("GET", "/api/setup")).done).toContain("profile");
  });
});

describe("setup on a fresh hub", () => {
  let h: Awaited<ReturnType<typeof startHub>>;

  beforeAll(async () => {
    h = await startHub();
  });

  afterAll(async () => {
    await h?.hub.stop();
  });

  it("opens the intro when the assistant's empty dialog is opened with a brain, once", async () => {
    expect((await h.ok("GET", "/api/bootstrap")).firstRun).toBe(true);
    // No brain yet: not the moment.
    expect(await h.ok("POST", "/api/setup/intro", {})).toMatchObject({ usable: false, firstRun: true });
    await h.signIn();
    const s = await h.ok("POST", "/api/setup/intro", {});
    expect(s).toMatchObject({ usable: true, firstRun: false, remaining: ["identity", "team", "telegram", "backupBrain", "machines", "profile"] });
    const greeting = await until(async () => replies(await h.messages())[0], "the greeting");
    expect(textOf(greeting)).toMatch(/^gated heard: \[System\] The person has just set up the hub/);
    await h.ok("POST", "/api/setup/intro", {});
    await sleep(1000);
    expect(replies(await h.messages())).toHaveLength(1);
    expect((await h.ok("GET", "/api/bootstrap")).firstRun).toBe(false);
    // Nobody wrote, so no card was stored.
    expect(cards(await h.messages())).toEqual([]);
  });

  it("shows the profile card when the assistant gets its name during the intro", async () => {
    const sent = await h.ok("POST", `/api/conversations/${h.conv}/messages`, { text: 'CALL profile_update {"name":"Арчи"}' });
    const reply = await until(async () => {
      const msgs = await h.messages();
      return replies(msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1))[0];
    }, "the reply");
    expect(textOf(reply)).toMatch(/profile card/);
    expect(reply.parts).toContainEqual({ type: "agent_profile", agentId: "assistant" });
    expect(h.hub.agents.get("assistant")?.name).toBe("Арчи");
  });

  it("leads the intro steps first in the setup section", async () => {
    const block = await h.hub.setup.promptBlock("assistant");
    expect(block).toMatch(/getting acquainted[\s\S]*- identity:[\s\S]*- team:/);
    expect(block).toContain("`profile_show`");
    // The rest of the setup waits until the intro is over.
    expect(block).not.toMatch(/- telegram:/);
    h.hub.setup.setStep("identity", "done");
    h.hub.setup.setStep("team", "skipped");
    const after = await h.hub.setup.promptBlock("assistant");
    expect(after).not.toMatch(/getting acquainted/);
    expect(after).toMatch(/- telegram:/);
  });
});
