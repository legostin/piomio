// Kimi Code as a brain, against a fake `kimi` (fixtures/fake-kimi.mjs): the device sign-in, the probe (installed,
// signed in, what it offers), and sessions over ACP: text, tool calls, Kimi's permission requests answered by the hub
// (confined), refused at the front desk, the hub's own tools let through, limits, a lost session and a cancel.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainEvent, BrainLoginUpdate, BrainSessionOptions } from "@piomio/shared";
import { createKimiProvider, kimiThinking, kimiToolName, parseKimiDeviceLogin } from "../src/index.ts";

const fakeKimi = join(import.meta.dirname, "fixtures", "fake-kimi.mjs");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** `kimi login` 2.4.1 on stderr. */
const LOGIN_OUTPUT =
  "\nOpening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=IN1G-ZJ3X\n" +
  "If the browser did not open, paste the URL above and enter code: IN1G-ZJ3X\nCode expires in 1800s.\nWaiting for authorization to complete…\n";

function signedInHome(): string {
  const home = tmp("piomio-kimi-home-");
  mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
  writeFileSync(join(home, ".kimi-code", "credentials", "kimi-code.json"), "{}");
  return home;
}

/** The hub's MCP endpoint, as far as permission questions go: answers native_permission and keeps what was asked. */
let hub: Server;
let hubUrl = "";
let hubAllows = true;
const asked: Array<{ tool_name: string; input: unknown }> = [];

beforeAll(async () => {
  hub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      asked.push(m.params.arguments);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ behavior: hubAllows ? "allow" : "deny" }) }] } }));
    });
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}/mcp`;
});
afterAll(() => hub.close());

function session(over: Partial<BrainSessionOptions> & { home: string; log: string }) {
  const { home, log, ...rest } = over;
  const provider = createKimiProvider({ command: () => fakeKimi, stateDir: tmp("piomio-kimi-state-") });
  const opts: BrainSessionOptions = {
    sessionId: "ses_1",
    agent: { id: "a", name: "A", description: "", brains: ["kimi@local"], prompt: "" } as any,
    workspace: tmp("piomio-kimi-ws-"),
    mcp: { url: hubUrl, token: "tok", bridgeCommand: ["node", "/bridge.js"] },
    systemPrompt: "You are A.",
    env: { HOME: home, FAKE_KIMI_LOG: log },
    background: false,
    ...rest,
  };
  return { provider, opts, create: () => provider.createSession(opts) };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const logged = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
const text = (events: BrainEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");

describe("reading Kimi's output", () => {
  it("finds the device page, the code and the expiry", () => {
    const at = Date.parse("2026-11-01T12:00:00Z");
    expect(parseKimiDeviceLogin(LOGIN_OUTPUT, at)).toEqual({ url: "https://www.kimi.ai/code/authorize_device?user_code=IN1G-ZJ3X", userCode: "IN1G-ZJ3X", expiresAt: "2026-11-01T12:30:00.000Z" });
    expect(parseKimiDeviceLogin("Waiting…\n", at)).toBeUndefined();
  });

  it("takes models, thinking levels and presets from the session's options", () => {
    const options = [
      { id: "model", category: "model", currentValue: "k3", options: [{ value: "k3", name: "K3" }, { value: "kimi-for-coding", name: "Kimi for Coding" }] },
      { id: "thinking", category: "thought_level", currentValue: "high", options: [{ value: "off" }, { value: "low" }, { value: "high" }, { value: "max" }] },
    ];
    // Kimi's real list for kimi-for-coding: always thinking, max by default. Balanced is the middle then.
    const real = [
      { id: "model", category: "model", currentValue: "kimi-code/kimi-for-coding", options: [{ value: "kimi-code/kimi-for-coding", name: "K2.8 Preview" }, { value: "kimi-code/k3.1-pro", name: "K3.1 Pro" }] },
      { id: "thinking", category: "thought_level", currentValue: "max", options: [{ value: "low" }, { value: "high" }, { value: "max" }] },
    ];
    expect(kimiThinking(real).presets).toEqual({ fast: { model: "kimi-code/kimi-for-coding", effort: "low" }, balanced: { model: "kimi-code/kimi-for-coding", effort: "high" }, deep: { model: "kimi-code/kimi-for-coding", effort: "max" } });
    expect(kimiThinking(real).catalog?.find((m) => m.id === "kimi-code/k3.1-pro")?.tier).toBe(5);
    expect(kimiThinking(options)).toMatchObject({
      models: ["k3", "kimi-for-coding"],
      modelNames: { k3: "K3", "kimi-for-coding": "Kimi for Coding" },
      model: "k3",
      efforts: ["off", "low", "high", "max"],
      presets: { fast: { model: "k3", effort: "low" }, balanced: { model: "k3", effort: "high" }, deep: { model: "k3", effort: "max" } },
    });
    expect(kimiThinking(undefined)).toEqual({});
  });

  it("names tool calls the way the hub knows them", () => {
    expect(kimiToolName("List the files", "execute")).toBe("Bash");
    expect(kimiToolName("Write", "edit")).toBe("Write");
    expect(kimiToolName("Grep", "read")).toBe("Grep");
    expect(kimiToolName("FetchURL", "fetch")).toBe("WebFetch");
    expect(kimiToolName("mcp__piomio__hub_note", "other")).toBe("mcp__piomio__hub_note");
  });
});

describe("probe and sign-in (fake kimi)", () => {
  const savedHome = process.env.HOME;
  afterAll(() => {
    process.env.HOME = savedHome;
  });

  it("not installed", async () => {
    const p = createKimiProvider({ command: () => join(tmp("piomio-kimi-none-"), "kimi"), stateDir: tmp("piomio-kimi-state-") });
    expect(await p.probe()).toMatchObject({ available: false, authenticated: false });
  });

  it("installed but not signed in, then signed in from the card, then what it offers", async () => {
    const home = tmp("piomio-kimi-home-");
    process.env.HOME = home;
    const p = createKimiProvider({ command: () => fakeKimi, stateDir: tmp("piomio-kimi-state-") });
    expect(await p.probe()).toMatchObject({ available: true, authenticated: false, version: "2.4.1" });

    const log = join(home, "log.jsonl");
    const updates: BrainLoginUpdate[] = [];
    const login = await p.login!({ env: { HOME: home, FAKE_KIMI_LOG: log }, onUpdate: (u) => updates.push(u) });
    const done = await login.done;
    expect(updates.find((u) => u.status === "waiting")).toMatchObject({ url: "https://www.kimi.ai/code/authorize_device?user_code=IN1G-ZJ3X", userCode: "IN1G-ZJ3X" });
    expect(done.status).toBe("succeeded");
    // No browser opens on the hub's computer: the CLI ran without `open` on its PATH.
    expect(logged(log)[0].path).not.toMatch(/\/usr\/bin/);

    expect(await p.probe()).toMatchObject({ available: true, authenticated: true, models: ["k3", "kimi-for-coding"], model: "k3", efforts: ["off", "low", "high", "max"] });
  });
});

describe("sessions over ACP (fake kimi)", () => {
  it("answers, with the system prompt in AGENTS.md, the hub's MCP server and the chosen model and thinking", async () => {
    const home = signedInHome();
    const log = join(home, "log.jsonl");
    const s = session({ home, log, model: "kimi-for-coding", effort: "low" });
    const brain = await s.create();
    const events = await collect(brain.send({ text: "HELLO" }));
    expect(text(events)).toBe("Hi there");
    expect(events).toContainEqual({ type: "model", model: "kimi-for-coding" });
    expect(events.at(-1)).toEqual({ type: "done", resumeToken: "s1" });
    expect(readFileSync(join(s.opts.workspace, "AGENTS.md"), "utf8")).toContain("You are A.");
    const reqs = logged(log);
    const created = reqs.find((r) => r.method === "session/new");
    expect(created.params.mcpServers[0]).toMatchObject({ name: "piomio", command: "node", args: ["/bridge.js"] });
    expect(created.params.mcpServers[0].env).toContainEqual({ name: "PIOMIO_URL", value: hubUrl });
    // Not confined, not a front desk: Kimi goes ahead without asking.
    expect(reqs.find((r) => r.method === "session/set_mode").params.modeId).toBe("yolo");
    expect(reqs.filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value])).toEqual([
      ["model", "kimi-for-coding"],
      ["thinking", "low"],
    ]);
    await brain.close();
  });

  it("confined: Kimi's permission request goes to the hub, which decides", async () => {
    const home = signedInHome();
    const log = join(home, "log.jsonl");
    const confine = { denyRead: [], allowRead: [], permissionTool: "native_permission" };
    const brain = await session({ home, log, confine }).create();
    asked.length = 0;
    hubAllows = true;
    const events = await collect(brain.send({ text: "TOOL" }));
    expect(asked).toEqual([{ tool_name: "kimi.Bash", input: { command: "ls -la" } }]);
    expect(events).toContainEqual({ type: "tool_call", id: "t1:Bash", name: "Bash", input: { command: "ls -la" } });
    expect(events).toContainEqual({ type: "tool_result", id: "t1:Bash", output: "file.txt", isError: false });
    expect(logged(log).find((r) => r.permission)).toEqual({ permission: "Bash", outcome: { outcome: "selected", optionId: "approve_once" } });
    expect(logged(log).find((r) => r.method === "session/set_mode")).toBeUndefined();

    hubAllows = false;
    const no = await collect(brain.send({ text: "WRITE" }));
    expect(asked.at(-1)).toEqual({ tool_name: "kimi.Write", input: { path: "/etc/hosts", content: "x" } });
    expect(no).toContainEqual({ type: "tool_result", id: "t1:Write", output: "rejected", isError: true });
    hubAllows = true;
    await brain.close();
  });

  it("front desk: commands are refused without asking; the hub's tools pass; Kimi's own questions are declined", async () => {
    const home = signedInHome();
    const log = join(home, "log.jsonl");
    const brain = await session({ home, log, frontDesk: true }).create();
    asked.length = 0;
    await collect(brain.send({ text: "TOOL" }));
    await collect(brain.send({ text: "MCP" }));
    await collect(brain.send({ text: "ASK" }));
    expect(asked).toEqual([]);
    expect(logged(log).filter((r) => r.permission)).toEqual([
      { permission: "Bash", outcome: { outcome: "selected", optionId: "reject" } },
      { permission: "mcp__piomio__hub_note", outcome: { outcome: "selected", optionId: "approve_once" } },
      { permission: "AskUserQuestion", outcome: { outcome: "cancelled" } },
    ]);
    await brain.close();
  });

  it("says when Kimi is not signed in, and turns a rate limit into a limit", async () => {
    const out = await collect((await session({ home: tmp("piomio-kimi-home-"), log: join(tmp("piomio-kimi-log-"), "l") }).create()).send({ text: "HELLO" }));
    expect(out).toContainEqual(expect.objectContaining({ type: "error", fatal: true, message: expect.stringMatching(/not signed in/) }));

    const home = signedInHome();
    const limited = await collect((await session({ home, log: join(home, "l") }).create()).send({ text: "LIMIT" }));
    const hit = limited.find((e) => e.type === "limit_hit") as Extract<BrainEvent, { type: "limit_hit" }>;
    expect(hit.detail).toMatch(/Rate limit/);
    expect(Date.parse(hit.resetAt!)).toBeGreaterThan(Date.now() + 60 * 60_000);

    // Signed in, but the plan has no Kimi Code: the brain rests for an hour and says what Kimi said.
    const noPlan = await collect((await session({ home, log: join(home, "l") }).create()).send({ text: "NOPLAN" }));
    const rest = noPlan.find((e) => e.type === "limit_hit") as Extract<BrainEvent, { type: "limit_hit" }>;
    expect(rest.detail).toMatch(/^Kimi Code: this Kimi account's plan does not include Kimi Code \(403 Your current subscription/);
    expect(noPlan.some((e) => e.type === "error")).toBe(false);
  });

  it("resumes its session; a session that is gone starts afresh from the hub's recap", async () => {
    const home = signedInHome();
    const log = join(home, "log.jsonl");
    const kept = await collect((await session({ home, log, resume: "s7" }).create()).send({ text: "again" }));
    expect(kept.at(-1)).toEqual({ type: "done", resumeToken: "s7" });
    expect(logged(log).find((r) => r.method === "session/resume").params.sessionId).toBe("s7");

    const fresh = await collect((await session({ home, log, resume: "gone" }).create()).send({ text: "go on", recap: "Earlier: we planned a trip." }));
    expect(text(fresh)).toBe("echo:Earlier: we planned a trip.\n\n---\ngo on");
    expect(fresh.at(-1)).toEqual({ type: "done", resumeToken: "s1" });
  });

  it("a dialog keeps its process between turns; an interrupted turn ends quietly", async () => {
    const home = signedInHome();
    const log = join(home, "log.jsonl");
    const brain = await session({ home, log, keepWarm: true }).create();
    await brain.warm!();
    await collect(brain.send({ text: "one" }));
    await collect(brain.send({ text: "two" }));
    expect(logged(log).filter((r) => r.method === "initialize")).toHaveLength(1);

    const turn = collect(brain.send({ text: "SLOW" }));
    await new Promise((r) => setTimeout(r, 300));
    await brain.interrupt();
    const events = await turn;
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.at(-1)?.type).toBe("done");
    expect(logged(log).some((r) => r.method === "session/cancel")).toBe(true);
    await brain.close();
  });
});
