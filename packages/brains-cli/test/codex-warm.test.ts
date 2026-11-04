// A dialog's Codex stays up between turns (one `codex app-server`, the thread open in it), and Codex never runs in its
// Fast tier, whatever the person's own config.toml says.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrainEvent, BrainSessionOptions } from "@piomio/shared";
import { createCodexProvider } from "../src/index.ts";

const fakeCodex = join(import.meta.dirname, "fixtures", "fake-codex.mjs");

function opts(over: Partial<BrainSessionOptions> = {}): BrainSessionOptions {
  return {
    sessionId: `s_${Math.random().toString(36).slice(2)}`,
    agent: { id: "a", name: "A", brains: ["codex"] } as any,
    workspace: mkdtempSync(join(tmpdir(), "owl-cxw-work-")),
    mcp: { url: "http://x", token: "t", bridgeCommand: ["bridge"] },
    systemPrompt: "SYSTEM",
    env: {},
    background: false,
    ...over,
  } as BrainSessionOptions;
}

async function collect(gen: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const text = (ev: BrainEvent[]) => ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");

/** A session on the fake CLI, with a file that gets one line per `codex app-server` started. */
function harness(over: Partial<Parameters<typeof createCodexProvider>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owl-cxw-"));
  const spawnsFile = join(dir, "spawns");
  const argsFile = join(dir, "args");
  const provider = createCodexProvider({ command: () => fakeCodex, stateDir: join(dir, "state"), ...over });
  const env = { FAKE_CODEX_SPAWNS: spawnsFile, FAKE_ARGS_FILE: argsFile };
  const spawns = () => (existsSync(spawnsFile) ? readFileSync(spawnsFile, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const pids = () => (existsSync(spawnsFile) ? readFileSync(spawnsFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  const opened = () => (existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const session = (o: Partial<BrainSessionOptions> = {}) => provider.createSession(opts({ env, ...o }));
  return { provider, session, spawns, pids, opened, env };
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Codex never runs in its Fast tier", () => {
  it("every thread, new or resumed, turns it off whatever the person's config says", async () => {
    const h = harness();
    const s = await h.session();
    await collect(s.send({ text: "hi" }));
    await collect(s.send({ text: "again" }));
    const [started, resumed] = h.opened();
    expect(resumed.resume).toMatch(/^th-/);
    for (const t of [started, resumed]) {
      expect(t.args).toContain("features.fast_mode=false");
      expect(t.serviceTier).toBeNull();
    }
    s.close?.();
  });

  it("nor does auto mode's bare reviewer", async () => {
    const h = harness();
    const s = await h.session({ bare: true });
    await collect(s.send({ text: "hi" }));
    expect(h.opened()[0].args).toContain("features.fast_mode=false");
    expect(h.opened()[0].serviceTier).toBeNull();
  });

  it("nor a Codex too old for the app server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owl-cxw-"));
    const file = join(dir, "args");
    const provider = createCodexProvider({ command: () => fakeCodex, stateDir: join(dir, "state") });
    const s = await provider.createSession(opts({ env: { FAKE_CODEX_NO_APP: "1", FAKE_ARGS_FILE: file } }));
    await collect(s.send({ text: "hi" }));
    expect(JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]).args).toContain("features.fast_mode=false");
  });
});

describe("a dialog's Codex stays up between turns (keepWarm)", () => {
  it("answers its turns in one process, in one thread", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true });
    const first = await collect(s.send({ text: "one" }));
    const second = await collect(s.send({ text: "two" }));
    expect(text(first)).toContain("echo:one");
    expect(text(second)).toContain("echo:two");
    expect(h.spawns()).toBe(1);
    expect((second.at(-1) as any).resumeToken).toBe((first.at(-1) as any).resumeToken);
    // The thread opened once: no resume between turns.
    expect(h.opened().filter((t) => t.resume)).toEqual([]);
    s.close?.();
  });

  it("gets ready before the first turn, and that turn uses what is ready", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true });
    await s.warm?.();
    expect(h.spawns()).toBe(1);
    expect(h.opened()).toHaveLength(1);
    expect(text(await collect(s.send({ text: "one" })))).toContain("echo:one");
    expect(h.spawns()).toBe(1);
    expect(h.opened()).toHaveLength(1);
    s.close?.();
  });

  it("warming twice, or while it warms, starts one process", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true });
    await Promise.all([s.warm?.(), s.warm?.()]);
    await s.warm?.();
    expect(h.spawns()).toBe(1);
    s.close?.();
  });

  it("a turn that comes while it warms waits for it and uses it", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true });
    const warming = s.warm?.();
    const ev = await collect(s.send({ text: "one" }));
    await warming;
    expect(text(ev)).toContain("echo:one");
    expect(h.spawns()).toBe(1);
    s.close?.();
  });

  it("a warmed-up thread that is gone starts afresh, and the first turn brings the recap", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true, resume: "missing" });
    await s.warm?.();
    expect(text(await collect(s.send({ text: "next", recap: "RECAP" })))).toMatch(/^echo:RECAP\n\n---\nnext\n/);
    // Only that turn.
    expect(text(await collect(s.send({ text: "after", recap: "RECAP" })))).toMatch(/^echo:after\n/);
    expect(h.spawns()).toBe(1);
    s.close?.();
  });

  it("thinks with the model and effort each turn asks for, in the same process", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true, model: "gpt-a" });
    const first = await collect(s.send({ text: "one" }));
    expect(first).toContainEqual({ type: "model", model: "gpt-a" });
    const second = await collect(s.send({ text: "two", model: "gpt-b", effort: "high" }));
    expect(second).toContainEqual({ type: "model", model: "gpt-b" });
    expect(text(second)).toContain("model=gpt-b effort=high");
    expect(h.spawns()).toBe(1);
    s.close?.();
  });

  it("takes more input into the turn in progress, turn after turn", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true });
    await collect(s.send({ text: "first" }));
    expect(await s.steer?.({ text: "between turns" })).toBe(false);
    const ev: BrainEvent[] = [];
    let steered: Promise<boolean | undefined> | undefined;
    for await (const e of s.send({ text: "go SLOW" })) {
      ev.push(e);
      if (e.type === "tool_call" && e.name === "shell" && !steered) steered = Promise.resolve(s.steer?.({ text: "and this" }));
    }
    expect(await steered).toBe(true);
    expect(text(ev)).toBe("slow done also:and this\n");
    expect(h.spawns()).toBe(1);
    s.close?.();
  });

  it("a stopped turn leaves the process up for the next one", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true, env: { ...h.env, FAKE_SLOW_MS: "20000" } });
    const ev: BrainEvent[] = [];
    for await (const e of s.send({ text: "go SLOW" })) {
      ev.push(e);
      if (e.type === "tool_call" && e.name === "shell") s.interrupt?.();
    }
    expect(ev.at(-1)?.type).toBe("done");
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(text(await collect(s.send({ text: "next" })))).toContain("echo:next");
    expect(h.spawns()).toBe(1);
    s.close?.();
  });

  it("a stopped turn that never ends loses its process, and the next turn starts another", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true, env: { ...h.env, FAKE_SLOW_MS: "60000", FAKE_CODEX_STUCK: "1" } });
    const ev: BrainEvent[] = [];
    for await (const e of s.send({ text: "go SLOW" })) {
      ev.push(e);
      if (e.type === "tool_call" && e.name === "shell") s.interrupt?.();
    }
    expect(ev.at(-1)?.type).toBe("done");
    expect(h.spawns()).toBe(1);
    await collect(s.send({ text: "next" }));
    expect(h.spawns()).toBe(2);
    s.close?.();
  }, 20_000);

  it("a turn that failed does not leave its process waiting", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true });
    expect((await collect(s.send({ text: "LIMIT" }))).some((e) => e.type === "limit_hit")).toBe(true);
    await collect(s.send({ text: "next" }));
    expect(h.spawns()).toBe(2);
    s.close?.();
  });

  it("goes on in a fresh thread from the recap when the open thread is too full", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true, resume: "th-old" });
    const ev = await collect(s.send({ text: "go on FULL", recap: "RECAP" }));
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(text(ev)).toMatch(/^echo:RECAP\n\n---\ngo on FULL\n/);
    expect((ev.at(-1) as any).resumeToken).not.toBe("th-old");
    s.close?.();
  });

  it("the process goes when it has waited too long, and the next turn resumes the thread", async () => {
    const h = harness({ idleMs: 60 });
    const s = await h.session({ keepWarm: true });
    const first = await collect(s.send({ text: "one" }));
    const [pid] = h.pids();
    await until(() => !running(pid));
    const second = await collect(s.send({ text: "two" }));
    expect(h.spawns()).toBe(2);
    expect((second.at(-1) as any).resumeToken).toBe((first.at(-1) as any).resumeToken);
    expect(h.opened().at(-1).resume).toBe((first.at(-1) as any).resumeToken);
    s.close?.();
  });

  it("at most three wait at once: the one waiting longest goes first", async () => {
    const h = harness();
    const sessions = await Promise.all([1, 2, 3, 4].map(() => h.session({ keepWarm: true })));
    for (const s of sessions) await collect(s.send({ text: "hi" }));
    expect(h.spawns()).toBe(4);
    const pids = h.pids();
    await until(() => pids.filter(running).length === 3);
    // The newest three still answer without a new process.
    for (const s of sessions.slice(1)) await collect(s.send({ text: "again" }));
    expect(h.spawns()).toBe(4);
    for (const s of sessions) s.close?.();
  });

  it("closing the session ends its process", async () => {
    const h = harness();
    const s = await h.session({ keepWarm: true });
    await collect(s.send({ text: "one" }));
    const [pid] = h.pids();
    expect(running(pid)).toBe(true);
    s.close?.();
    await until(() => !running(pid));
  });
});

describe("work on the side keeps one process per turn", () => {
  it("a task's turn ends its process", async () => {
    const h = harness();
    const s = await h.session();
    await s.warm?.();
    expect(h.spawns()).toBe(0);
    await collect(s.send({ text: "one" }));
    const [pid] = h.pids();
    await until(() => !running(pid));
    await collect(s.send({ text: "two" }));
    expect(h.spawns()).toBe(2);
  });

  it("the bare reviewer starts ahead and answers once in that process", async () => {
    const h = harness();
    const s = await h.session({ bare: true, keepWarm: true });
    await s.warm?.();
    expect(h.spawns()).toBe(1);
    await collect(s.send({ text: "one" }));
    expect(h.spawns()).toBe(1);
    const [pid] = h.pids();
    await until(() => !running(pid));
    s.close?.();
  });
});
