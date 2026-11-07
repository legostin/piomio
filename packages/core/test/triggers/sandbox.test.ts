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
    expect(gap).toBeLessThan(250);
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
    expect(r.logs).toEqual(["asking", "(1 pio call was still running when the run ended: their answers were dropped)"]);
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

  it("survives a script too deeply nested for the TypeScript stripper, and refuses one over 64 KB", async () => {
    const deep = `export default () => (${"[".repeat(3000)}${"]".repeat(3000)})`;
    const r = await runScript(deep, input(), noHost);
    expect(r.verdict).toBeUndefined();
    expect(r.error).toMatch(/nested too deeply/);
    // The stripper stays broken in the thread it failed in: that thread went, the next script gets a fresh one.
    for (let i = 0; i < 3; i++) expect((await runScript(`export default (s: any) => ({ note: "fine" })`, input(), noHost)).verdict).toEqual({ note: "fine" });
    const long = await runScript(`export default () => ({ note: "${"x".repeat(64 * 1024)}" })`, input(), noHost);
    expect(long.error).toBe("the script is longer than 64 KB");
  });

  it("keeps an error's text short, however much the script threw", async () => {
    const huge = 'const huge = "x".repeat(2e7);';
    for (const body of [
      `${huge} throw huge;`,
      `${huge} throw new Error(huge);`,
      `${huge} const e = new TypeError("t"); e.name = huge; throw e;`,
      `${huge} throw { huge };`,
      `throw Object.assign(new Error("m"), { stack: "y".repeat(2e7) });`,
    ]) {
      const r = await runScript(`export default () => { ${body} }`, input(), noHost);
      expect(r.verdict, body).toBeUndefined();
      expect(r.error!.length, body).toBeGreaterThan(0);
      expect(r.error!.length, body).toBeLessThanOrEqual(2000);
    }
    // A host error is cut too, on its way into the script.
    const host: HostCall = async () => {
      throw new Error("h".repeat(100_000));
    };
    const h = await runScript(`export default async (s, pio) => ({ note: String((await pio.fetch("x").catch((e) => e)).message.length) })`, input(), host);
    expect(Number((h.verdict as { note: string }).note)).toBeLessThanOrEqual(2000);
  });

  it("ends deep nesting with a clear error, wherever it comes from, and the next run is clean", async () => {
    const page = "[".repeat(100_000) + "]".repeat(100_000);
    const host: HostCall = async () => ({ status: 200, headers: {}, text: page });
    const cases: Array<[string, HostCall]> = [
      [`export default () => { let a = []; for (let i = 0; i < 1e5; i++) a = [a]; return { triage: a } }`, noHost],
      [`export default () => { let a = {}; for (let i = 0; i < 1e5; i++) a = { a }; throw a }`, noHost],
      [`export default async (s, pio) => { const res = await pio.fetch("https://deep.example.com"); return { triage: res.json() } }`, host],
      [`export default () => { let a = []; for (let i = 0; i < 1e5; i++) a = [a]; return { note: String(a) } }`, noHost],
      [`export default () => { const f = (n) => f(n + 1); f(0) }`, noHost],
    ];
    for (const [code, h] of cases) {
      const r = await runScript(code, input(), h);
      expect(r.verdict, code).toBeUndefined();
      expect(r.error, code).toMatch(/nested too deeply/);
      expect((await runScript(`export default () => ({ note: "clean" })`, input(), noHost)).verdict).toEqual({ note: "clean" });
    }
    // Nesting QuickJS can write, but deeper than the hub takes.
    const d = await runScript(`export default () => { let a = 1; for (let i = 0; i < 500; i++) a = [a]; return { triage: a } }`, input(), noHost);
    expect(d.error).toBe("invalid verdict: nested deeper than 100 levels");
    const args = await runScript(`export default async (s, pio) => { let a = 1; for (let i = 0; i < 500; i++) a = [a]; await pio.state.set("k", a) }`, input(), noHost);
    expect(args.error).toMatch(/nested deeper than 100 levels/);
    expect(args.calls).toBe(0);
  });

  it("ends a run whose nesting ran V8's stack out inside QuickJS, retires that thread, and prints nothing", async () => {
    // With a small native stack, V8's runs out inside the WASM before QuickJS's own check fires (the real workers have
    // enough that it never does): QuickJS's state may then be corrupt, so the run ends and its thread goes.
    const sandbox = new ScriptSandbox(undefined, { stackMb: 1 });
    const write = process.stderr.write;
    let stderr = "";
    process.stderr.write = function (this: unknown, chunk: string | Uint8Array, ...rest: unknown[]) {
      stderr += String(chunk);
      return (write as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
    } as typeof process.stderr.write;
    const page = "[".repeat(100_000) + "]".repeat(100_000);
    const host: HostCall = async () => ({ status: 200, headers: {}, text: page });
    try {
      const evalDeep = await sandbox.run(`export default () => { eval("[".repeat(2e5) + "]".repeat(2e5)) }`, input(), noHost);
      expect(evalDeep.error).toBe("the script nested too deeply: the sandbox ran out of stack");
      expect((await sandbox.run(`export default () => ({ note: "clean" })`, input(), noHost)).verdict).toEqual({ note: "clean" });
      for (const code of [
        `export default () => { let a = []; for (let i = 0; i < 1e5; i++) a = [a]; return { triage: a } }`,
        `export default async (s, pio) => ({ triage: (await pio.fetch("https://deep.example.com")).json() })`,
      ]) {
        expect((await sandbox.run(code, input(), host)).error, code).toMatch(/nested too deeply/);
        expect((await sandbox.run(`export default () => ({ note: "clean" })`, input(), noHost)).verdict).toEqual({ note: "clean" });
      }
      await new Promise((r) => setTimeout(r, 100));
      expect(stderr).not.toMatch(/Aborted/);
    } finally {
      process.stderr.write = write;
      sandbox.stop();
    }
  });

  it("holds a run until the pio calls it never awaited are back, so they neither pile up nor land late", async () => {
    const sandbox = new ScriptSandbox();
    let inflight = 0;
    let most = 0;
    const gates: Array<() => void> = [];
    const host: HostCall = () =>
      new Promise((resolve) => {
        inflight++;
        most = Math.max(most, inflight);
        gates.push(() => {
          inflight--;
          resolve("ok");
        });
      });
    try {
      const code = `export default (s, pio) => { for (let i = 0; i < 50; i++) pio.llm.ask("q" + i); return { note: "fired" } }`;
      let done = 0;
      const runs = Array.from({ length: 6 }, () => sandbox.run(code, input(), host).then((r) => (done++, r)));
      await until(() => inflight === 100);
      await new Promise((r) => setTimeout(r, 300));
      // Two runs' calls at most: the others wait for a slot, and nothing has resolved while its calls were out.
      expect(inflight).toBe(100);
      expect(done).toBe(0);
      while (done < 6) {
        for (const g of gates.splice(0)) g();
        await new Promise((r) => setTimeout(r, 20));
      }
      const results = await Promise.all(runs);
      expect(results.map((r) => r.verdict)).toEqual(Array(6).fill({ note: "fired" }));
      expect(results.map((r) => r.calls)).toEqual(Array(6).fill(50));
      expect(most).toBe(100);
    } finally {
      sandbox.stop();
    }

    // A state.set the script did not await lands before its run resolves: the next run reads it.
    const state = new Map<string, unknown>();
    const slowState: HostCall = async (name, args) => {
      await new Promise((r) => setTimeout(r, 200));
      if (name === "state.set") state.set(String(args[0]), args[1]);
      return name === "state.get" ? (state.get(String(args[0])) ?? null) : undefined;
    };
    await runScript(`export default (s, pio) => { pio.state.set("k", 1); return { note: "set" } }`, input(), slowState);
    const second = await runScript(`export default async (s, pio) => ({ note: String(await pio.state.get("k")) })`, input(), slowState);
    expect(second.verdict).toEqual({ note: "1" });

    // A call that never comes back holds its run only until the wall time; the run keeps its verdict, and says so.
    const t0 = Date.now();
    const hung = await runScript(`export default (s, pio) => { pio.fetch("https://slow.example.com"); return { note: "kept" } }`, input(), () => new Promise(() => {}), limits({ wallMs: 300 }));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(hung.verdict).toEqual({ note: "kept" });
    expect(hung.error).toBeUndefined();
    expect(hung.logs).toEqual(["(1 pio call was still running when the run ended: their answers were dropped)"]);
    expect((await runScript(`export default () => ({ note: "next" })`, input(), noHost)).verdict).toEqual({ note: "next" });
  });

  it("refuses arguments a script's toJSON made into something else than a list", async () => {
    let asked = 0;
    const host: HostCall = async () => ++asked;
    const r = await runScript(`export default async (s, pio) => { Array.prototype.toJSON = function () { return { evil: 1 } }; await pio.state.get("k") }`, input(), host);
    expect(r.error).toMatch(/not a list/);
    expect(asked).toBe(0);
  });

  it("calls a verdict JSON cannot carry invalid, not no verdict", async () => {
    for (const v of [`() => 1`, `{ toJSON() { return undefined } }`]) {
      const r = await runScript(`export default () => (${v})`, input(), noHost);
      expect(r.error, v).toMatch(/invalid verdict/);
    }
    // Nothing (and null) is still no verdict.
    for (const v of [`undefined`, `null`]) {
      const r = await runScript(`export default () => ${v}`, input(), noHost);
      expect(r, v).toMatchObject({ logs: [], calls: 0 });
      expect(r.error, v).toBeUndefined();
      expect(r.verdict, v).toBeUndefined();
    }
  });

  it("refuses a run at once when 200 already wait", async () => {
    const sandbox = new ScriptSandbox();
    const host: HostCall = () => new Promise(() => {});
    try {
      const code = `export default async (s, pio) => { await pio.state.get("k") }`;
      const queued = Array.from({ length: 202 }, () => sandbox.run(code, input(), host));
      const t0 = Date.now();
      const refused = await sandbox.run(code, input(), host);
      expect(Date.now() - t0).toBeLessThan(100);
      expect(refused.error).toMatch(/too many scripts waiting/);
      sandbox.stop();
      const ended = await Promise.all(queued);
      expect(ended.every((r) => r.error === "the script sandbox stopped")).toBe(true);
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
