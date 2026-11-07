// Trigger scripts run in QuickJS on a worker thread: their verdicts, the pio calls that reach the hub, the limits, and the
// hub's own thread left free while a script spins.

import { afterAll, describe, expect, it } from "vitest";
import { parseVerdict, runScript, SCRIPT_LIMITS, ScriptSandbox, scriptSandbox, type HostCall, type SandboxLimits, type ScriptResult } from "../../src/signals/sandbox.ts";

const now = { iso: "2026-11-07T09:00:00.000Z", local: "2026-11-07 12:00", timezone: "Europe/Moscow" };
const input = (data: unknown = {}) => ({ signal: { id: "sig_1", type: "web.webhook", data }, now });
const noHost: HostCall = async (name) => {
  throw new Error(`unexpected pio call ${name}`);
};
const limits = (over: Partial<SandboxLimits>): SandboxLimits => ({ ...SCRIPT_LIMITS, ...over });

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("trigger scripts in the sandbox", () => {
  afterAll(() => scriptSandbox.stop());

  it("gives the script's verdict", async () => {
    const r = await runScript(`export default async function (signal) { return { triage: { n: signal.data.n + 1 } } }`, input({ n: 1 }), noHost);
    expect(r.error).toBeUndefined();
    expect(r.verdict).toEqual({ triage: { n: 2 } });
    expect(r.logs).toEqual([]);
    expect(r.calls).toBe(0);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("takes TypeScript", async () => {
    const r = await runScript(`export default async function (s: any, pio: any): Promise<any> { return { note: "ok" } }`, input(), noHost);
    expect(r).toMatchObject({ verdict: { note: "ok" } });
    expect(r.error).toBeUndefined();
  });

  it("hands a batch of signals as an array", async () => {
    const r = await runScript(`export default (signals) => ({ note: String(signals.length) })`, { signals: [{ id: "a" }, { id: "b" }], now }, noHost);
    expect(r).toMatchObject({ verdict: { note: "2" } });
  });

  it("reaches the host through pio and gets its JSON back", async () => {
    const seen: Array<[string, unknown[]]> = [];
    const host: HostCall = async (name, args) => {
      seen.push([name, args]);
      return { text: "found", data: { items: [1, 2] } };
    };
    const r = await runScript(
      `export default async (signal, pio) => {
        const res = await pio.tools.call("notion_search", { q: 1 });
        return { wake: res.text, context: res.data };
      }`,
      input(),
      host,
    );
    expect(seen).toEqual([["tools.call", ["notion_search", { q: 1 }]]]);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ verdict: { wake: "found", context: { items: [1, 2] } }, calls: 1 });
  });

  it("maps every pio function to its host call, with now from the input", async () => {
    const seen: Array<[string, unknown[]]> = [];
    const host: HostCall = async (name, args) => {
      seen.push([name, args]);
      if (name === "fetch") return { status: 200, headers: { "content-type": "application/json" }, text: '{"price":5}' };
      if (name === "llm.ask") return "yes";
      if (name === "state.get") return { seen: 3 };
      if (name === "notes.recent") return ["n1"];
      return undefined;
    };
    const r = await runScript(
      `export default async (signal, pio) => {
        const page = await pio.fetch("https://api.example.com/p", { method: "GET" });
        const answer = await pio.llm.ask("is it cheap?");
        const prev = await pio.state.get("last");
        await pio.state.set("last", { seen: prev.seen + 1 });
        const gone = await pio.state.delete("old");
        const notes = await pio.notes.recent(3);
        return { wake: answer, context: { price: page.json().price, status: page.status, prev, gone: gone === undefined, notes, now: pio.now() } };
      }`,
      input(),
      host,
    );
    expect(r.error).toBeUndefined();
    expect(seen).toEqual([
      ["fetch", ["https://api.example.com/p", { method: "GET" }]],
      ["llm.ask", ["is it cheap?"]],
      ["state.get", ["last"]],
      ["state.set", ["last", { seen: 4 }]],
      ["state.delete", ["old"]],
      ["notes.recent", [3]],
    ]);
    expect(r.verdict).toEqual({ wake: "yes", context: { price: 5, status: 200, prev: { seen: 3 }, gone: true, notes: ["n1"], now } });
    expect(r.calls).toBe(6);
  });

  it("turns a host error into a rejection the script can catch", async () => {
    const host: HostCall = async () => {
      throw new Error("host example.org is not on this trigger's list");
    };
    const r = await runScript(`export default async (s, pio) => { try { await pio.fetch("x") } catch (e) { return { drop: e.message } } }`, input(), host);
    expect(r.verdict).toEqual({ drop: "host example.org is not on this trigger's list" });
    // Uncaught, it is the run's error.
    const u = await runScript(`export default async (s, pio) => { await pio.fetch("x"); return { note: "no" } }`, input(), host);
    expect(u.verdict).toBeUndefined();
    expect(u.error).toBe("host example.org is not on this trigger's list");
  });

  it("has nothing but pio: no fetch, require, process or imports", async () => {
    const r = await runScript(`export default () => ({ note: [typeof fetch, typeof require, typeof process].join(",") })`, input(), noHost);
    expect(r.verdict).toEqual({ note: "undefined,undefined,undefined" });
    const imp = await runScript(`import fs from "node:fs";\nexport default () => ({ note: typeof fs })`, input(), noHost);
    expect(imp.verdict).toBeUndefined();
    expect(imp.error).toMatch(/node:fs/);
  });

  it("stops an endless loop at the CPU limit, while the hub's own timers keep ticking", async () => {
    let ticks = 0;
    let gap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const t = Date.now();
      gap = Math.max(gap, t - last);
      last = t;
      ticks++;
    }, 50);
    const t0 = Date.now();
    let r: ScriptResult;
    try {
      r = await runScript(`export default async function () { while (true) {} }`, input(), noHost);
    } finally {
      clearInterval(timer);
    }
    expect(r.error).toMatch(/interrupted|CPU/);
    expect(r.verdict).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(4000);
    // The guest spun for two seconds on its own thread: the hub's timer kept its pace meanwhile.
    expect(ticks).toBeGreaterThan(10);
    expect(gap).toBeLessThan(1000);
    // The same sandbox goes on with the next script.
    expect((await runScript(`export default () => ({ note: "next" })`, input(), noHost)).verdict).toEqual({ note: "next" });
  });

  it("ends a run that waits past the wall limit, and the next run starts afresh", async () => {
    const host: HostCall = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await runScript(`export default async (s, pio) => { pio.log("asking"); await pio.fetch("https://slow.example.com"); return { note: "late" } }`, input(), host, limits({ wallMs: 300 }));
    expect(r.error).toMatch(/30 s|wall/);
    expect(r.verdict).toBeUndefined();
    expect(r.calls).toBe(1);
    expect(r.logs).toEqual(["asking"]);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await runScript(`export default () => ({ note: "after" })`, input(), noHost)).verdict).toEqual({ note: "after" });
  });

  it("ends a script that waits for something that never comes, without waiting out the wall limit", async () => {
    const t0 = Date.now();
    const r = await runScript(`export default async () => { await new Promise(() => {}); return { note: "never" } }`, input(), noHost);
    expect(r.error).toMatch(/never/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("stops a script that takes too much memory", async () => {
    const r = await runScript(
      `export default async () => { const a = []; for (let i = 0; i < 1e7; i++) a.push({ i, s: "item " + i }); return { note: String(a.length) } }`,
      input(),
      noHost,
      limits({ memoryBytes: 8 * 1024 * 1024 }),
    );
    expect(r.error).toMatch(/memory/i);
    expect(r.verdict).toBeUndefined();
    expect((await runScript(`export default () => ({ note: "fine" })`, input(), noHost)).verdict).toEqual({ note: "fine" });
  });

  it("refuses pio calls past the limit", async () => {
    let n = 0;
    const host: HostCall = async () => ++n;
    const r = await runScript(`export default async (s, pio) => { for (let i = 0; i < 51; i++) await pio.state.get("k"); return { note: "all" } }`, input(), host);
    expect(r.error).toMatch(/too many pio calls \(50\)/);
    expect(r.calls).toBe(50);
    expect(n).toBe(50);
  });

  it("keeps pio.log lines, at most 50 of 500 characters", async () => {
    const r = await runScript(`export default (s, pio) => { pio.log("a", 1); pio.log({ b: [2] }, null, undefined) }`, input(), noHost);
    expect(r.error).toBeUndefined();
    expect(r.verdict).toBeUndefined();
    expect(r.logs).toEqual(["a 1", '{"b":[2]} null undefined']);
    const many = await runScript(`export default (s, pio) => { for (let i = 0; i < 60; i++) pio.log("x".repeat(600)) }`, input(), noHost);
    expect(many.logs).toHaveLength(50);
    expect(many.logs[0]).toHaveLength(500);
  });

  it("needs a default export that is a function", async () => {
    const r = await runScript(`export const x = 1;`, input(), noHost);
    expect(r.error).toBe("the script must export a default function");
    const v = await runScript(`export default { note: "x" };`, input(), noHost);
    expect(v.error).toBe("the script must export a default function");
  });

  it("refuses a verdict of the wrong shape", async () => {
    const r = await runScript(`export default () => ({ wake: 1 })`, input(), noHost);
    expect(r.verdict).toBeUndefined();
    expect(r.error).toMatch(/invalid verdict/);
  });

  it("gives a syntax error as the run's error", async () => {
    const r = await runScript(`export default function ( { return 1`, input(), noHost);
    expect(r.verdict).toBeUndefined();
    expect(r.error).toMatch(/syntax/i);
  });

  it("gives a thrown error with where it was thrown", async () => {
    const r = await runScript(`export default (signal) => {\n  return { note: signal.data.missing.deep };\n}`, input(), noHost);
    expect(r.error).toMatch(/TypeError/);
    expect(r.error).toMatch(/trigger\.mjs:2/);
  });

  it("runs at most two scripts at once; the rest wait their turn", async () => {
    const sandbox = new ScriptSandbox();
    const gates: Array<() => void> = [];
    let asked = 0;
    const host: HostCall = () =>
      new Promise((resolve) => {
        asked++;
        gates.push(() => resolve("ok"));
      });
    try {
      const code = `export default async (s, pio) => ({ note: await pio.state.get("k") })`;
      const runs = [1, 2, 3].map(() => sandbox.run(code, input(), host));
      await until(() => asked === 2);
      await new Promise((r) => setTimeout(r, 300));
      expect(asked).toBe(2);
      gates.shift()!();
      await until(() => asked === 3);
      for (const g of gates.splice(0)) g();
      const results = await Promise.all(runs);
      expect(results.map((r) => r.verdict)).toEqual([{ note: "ok" }, { note: "ok" }, { note: "ok" }]);
    } finally {
      sandbox.stop();
    }
  });

  it("gives an error when the worker cannot start", async () => {
    const broken = new ScriptSandbox(new URL("data:text/javascript,throw new Error('boom')"));
    try {
      const r = await broken.run(`export default () => ({ note: "x" })`, input(), noHost);
      expect(r.verdict).toBeUndefined();
      expect(r.error).toMatch(/boom/);
    } finally {
      broken.stop();
    }
  });
});

describe("parseVerdict", () => {
  it("takes exactly one of drop, note, wake (with context) or triage", () => {
    expect(parseVerdict(undefined)).toBeUndefined();
    expect(parseVerdict(null)).toBeUndefined();
    expect(parseVerdict({ drop: "dup" })).toEqual({ drop: "dup" });
    expect(parseVerdict({ note: "price 5" })).toEqual({ note: "price 5" });
    expect(parseVerdict({ wake: "new mail" })).toEqual({ wake: "new mail" });
    expect(parseVerdict({ wake: "new mail", context: { from: "a" } })).toEqual({ wake: "new mail", context: { from: "a" } });
    expect(parseVerdict({ triage: { n: 1 } })).toEqual({ triage: { n: 1 } });
    expect(parseVerdict({ triage: null })).toEqual({ triage: null });
  });

  it("calls anything else invalid", () => {
    for (const v of [{ wake: 1 }, { drop: 2 }, { note: null }, {}, { drop: "a", note: "b" }, { drop: "a", extra: 1 }, { note: "a", context: {} }, { context: {} }, "drop", 5, [], [{ drop: "a" }], { triage: undefined }]) {
      const p = parseVerdict(v);
      expect(p, JSON.stringify(v)).toHaveProperty("invalid");
      expect(typeof (p as { invalid: string }).invalid).toBe("string");
    }
  });
});
