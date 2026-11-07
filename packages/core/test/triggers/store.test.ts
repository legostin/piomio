import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db.ts";
import { pluginKv } from "../../src/plugins/kv.ts";
import { memoryStore, migrateRunLists, sqlStore, type TriggerStore } from "../../src/signals/store.ts";
import type { Signal, TriggerRun } from "../../src/signals/types.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-07T12:00:00Z");

const run = (id: string, at: number, over: Partial<TriggerRun> = {}): TriggerRun => ({ id, at: new Date(at).toISOString(), reason: "schedule", status: "started", ...over });
const sig = (id: string): Signal => ({ id, type: "web.page", source: "web", at: new Date(T0).toISOString(), data: { n: id }, external: true });

describe.each([
  ["sql", (now: () => number) => sqlStore(openDb(":memory:"), now)],
  ["memory", (now: () => number) => memoryStore(now)],
] as Array<[string, (now: () => number) => TriggerStore]>)("trigger store (%s)", (_name, make) => {
  it("keeps 200 runs per trigger, newest first", () => {
    let now = T0;
    const s = make(() => now);
    for (let i = 0; i < 205; i++) {
      now = T0 + i * 1000;
      s.addRun("t1", run(`r${i}`, now));
    }
    s.addRun("t2", run("other", now));
    const all = s.runs("t1", 500);
    expect(all.length).toBe(200);
    expect(all[0].id).toBe("r204");
    expect(all[199].id).toBe("r5");
    expect(s.runs("t1", 3).map((r) => r.id)).toEqual(["r204", "r203", "r202"]);
    expect(s.runs("t2").length).toBe(1);
  });

  it("finds one run by its id, without its signals, and only the trigger's own", () => {
    const s = make(() => T0);
    s.addRun("t1", { ...run("r1", T0, { outcome: "note" }), signalData: [sig("sig_a")] });
    s.addRun("t2", run("r2", T0));
    expect(s.run("t1", "r1")).toEqual(run("r1", T0, { outcome: "note" }));
    expect(s.run("t2", "r1")).toBeUndefined();
    expect(s.run("t1", "nope")).toBeUndefined();
  });

  it("keeps a trigger's newest 20 runs whatever their age, and prunes the older ones past 14 days on the next add", () => {
    let now = T0;
    const s = make(() => now);
    for (let i = 0; i < 25; i++) s.addRun("t1", run(`old${i}`, T0 + i * 1000));
    now = T0 + 15 * DAY;
    s.addRun("t1", run("new", now));
    expect(s.runs("t1", 50).map((r) => r.id)).toEqual(["new", ...Array.from({ length: 19 }, (_, i) => `old${24 - i}`)]);
    // A trigger that rarely runs keeps its last 20, however old.
    for (let i = 0; i < 5; i++) s.addRun("t2", run(`w${i}`, T0 - (5 - i) * 7 * DAY));
    expect(s.runs("t2").map((r) => r.id)).toEqual(["w4", "w3", "w2", "w1", "w0"]);
  });

  it("keeps a weekly schedule's 20 old runs when they move in from the plugin's storage", () => {
    const now = T0;
    const s = make(() => now);
    const kv = pluginKv(openDb(":memory:"), "triggers");
    // Newest first, a week apart: all but the newest two are older than 14 days.
    kv.set("runs:weekly", Array.from({ length: 20 }, (_, i) => run(`wk${i}`, T0 - i * 7 * DAY)));
    expect(migrateRunLists(kv, s)).toBe(20);
    expect(s.runs("weekly").length).toBe(20);
    s.addRun("weekly", run("next", T0 + 1000));
    expect(s.runs("weekly").map((r) => r.id)).toEqual(["next", ...Array.from({ length: 19 }, (_, i) => `wk${i}`)]);
  });

  it("keeps at most 500 notes per trigger, the newest", () => {
    let now = T0;
    const s = make(() => now);
    for (let i = 0; i < 510; i++) {
      now = T0 + i * 1000;
      s.addNote({ agentId: "a1", triggerId: "t1", triggerName: "Busy", text: `n${i}`, signalIds: [], external: false });
    }
    s.addNote({ agentId: "a1", triggerId: "t2", triggerName: "Quiet", text: "q", signalIds: [], external: false });
    const busy = s.notes({ triggerId: "t1", limit: 1000 });
    expect(busy.length).toBe(500);
    expect(busy[0].text).toBe("n509");
    expect(busy[499].text).toBe("n10");
    expect(s.notes({ triggerId: "t2" }).map((n) => n.text)).toEqual(["q"]);
  });

  it("counts the outside-content marks (__ext:) against the script's 1 MB, not the engine's 4 MB", () => {
    const s = make(() => T0);
    s.stateSet("t1", "k", "k".repeat(1_000_000));
    expect(() => s.stateSet("t1", "__ext:k2", "x".repeat(100_000))).toThrow("trigger state is limited to 1 MB");
    // The engine's own keys still have their 4 MB.
    s.stateSet("t1", "__queue", "q".repeat(3_000_000));
    s.stateSet("t1", "__ext:k", true);
    expect(s.stateBytes("t1", "script")).toBe(Buffer.byteLength("k") + Buffer.byteLength(JSON.stringify("k".repeat(1_000_000))) + Buffer.byteLength("__ext:k") + 4);
    expect(s.stateBytes("t1", "script", ["k"])).toBe(Buffer.byteLength("__ext:k") + 4);
    expect(s.stateBytes("t1", "engine")).toBe(Buffer.byteLength("__queue") + Buffer.byteLength(JSON.stringify("q".repeat(3_000_000))));
  });

  it("finds a stored signal and lists the recent ones without leaking them into runs", () => {
    const s = make(() => T0);
    s.addRun("t1", { ...run("r1", T0), signalData: [sig("s1"), sig("s2")] });
    s.addRun("t1", { ...run("r2", T0 + 1000), signalData: [sig("s3")] });
    expect(s.signal("s2")?.id).toBe("s2");
    expect(s.signal("nope")).toBeUndefined();
    expect(s.recentSignals("t1", 2).map((x) => x.id)).toEqual(["s3", "s1"]);
    expect(s.recentSignals("t1", 10).length).toBe(3);
    expect("signalData" in s.runs("t1")[0]).toBe(false);
    s.dropRuns("t1");
    expect(s.runs("t1")).toEqual([]);
    expect(s.signal("s1")).toBeUndefined();
  });

  it("filters notes by agent, trigger, time and text, and prunes after 30 days", () => {
    let now = T0;
    const s = make(() => now);
    const a = s.addNote({ agentId: "a1", triggerId: "t1", triggerName: "Price", text: "Bitcoin crossed 100k", signalIds: ["s1"], external: true });
    expect(a.id).toBeTruthy();
    expect(a.at).toBe(new Date(T0).toISOString());
    now = T0 + 1000;
    s.addNote({ agentId: "a2", triggerId: "t2", triggerName: "Mail", text: "Invoice arrived", signalIds: [], external: false });
    expect(s.notes({ agentId: "a1" }).map((n) => n.text)).toEqual(["Bitcoin crossed 100k"]);
    expect(s.notes({ triggerId: "t2" }).map((n) => n.agentId)).toEqual(["a2"]);
    expect(s.notes({ since: new Date(T0 + 500).toISOString() }).map((n) => n.agentId)).toEqual(["a2"]);
    expect(s.notes({ text: "BITCOIN" }).length).toBe(1);
    expect(s.notes({}).map((n) => n.agentId)).toEqual(["a2", "a1"]);
    expect(s.notes({ limit: 1 }).length).toBe(1);
    expect(s.notes({ agentId: "a1" })[0].signalIds).toEqual(["s1"]);
    now = T0 + 31 * DAY;
    s.addNote({ agentId: "a3", triggerId: "t3", triggerName: "X", text: "fresh", signalIds: [], external: false });
    expect(s.notes({}).map((n) => n.agentId)).toEqual(["a3"]);
  });

  it("keeps script state per trigger and refuses more than 1 MB", () => {
    const s = make(() => T0);
    expect(s.stateGet("t1", "k")).toBeUndefined();
    s.stateSet("t1", "k", { n: 1 });
    s.stateSet("t1", "k", { n: 2 });
    s.stateSet("t2", "k", "other");
    expect(s.stateGet("t1", "k")).toEqual({ n: 2 });
    expect(() => s.stateSet("t1", "big", "x".repeat(1_100_000))).toThrow(RangeError);
    expect(s.stateGet("t1", "big")).toBeUndefined();
    // Replacing a value counts only the new one.
    s.stateSet("t1", "k", "y".repeat(600_000));
    s.stateSet("t1", "k", "z".repeat(600_000));
    s.stateDelete("t1", "k");
    expect(s.stateGet("t1", "k")).toBeUndefined();
    s.stateSet("t1", "a", 1);
    s.dropState("t1");
    expect(s.stateGet("t1", "a")).toBeUndefined();
    expect(s.stateGet("t2", "k")).toBe("other");
  });

  it("keeps the engine's own keys (__) apart from the script's 1 MB, under 4 MB of their own", () => {
    const s = make(() => T0);
    s.stateSet("t1", "__batch", "b".repeat(900_000));
    // The script still has its whole megabyte.
    s.stateSet("t1", "k", "k".repeat(1_000_000));
    expect(() => s.stateSet("t1", "k2", "x".repeat(100_000))).toThrow("trigger state is limited to 1 MB");
    s.stateSet("t1", "__more", "m".repeat(3_000_000));
    expect(() => s.stateSet("t1", "__over", "o".repeat(300_000))).toThrow(/engine's own state is limited to 4 MB/);
    expect((s.stateGet("t1", "__batch") as string).length).toBe(900_000);
  });

  it("moves the runs:<id> lists out of storage, newest first", () => {
    const db = openDb(":memory:");
    const kv = pluginKv(db, "triggers");
    const s = make(() => T0);
    kv.set("runs:t1", [run("b", T0 + 2000), run("a", T0 + 1000)]);
    kv.set("runs:t2", [run("c", T0)]);
    kv.set("trigger:t1", { id: "t1" });
    expect(migrateRunLists(kv, s)).toBe(3);
    expect(s.runs("t1").map((r) => r.id)).toEqual(["b", "a"]);
    expect(s.runs("t2").map((r) => r.id)).toEqual(["c"]);
    expect(kv.list("runs:")).toEqual([]);
    expect(kv.get("trigger:t1")).toEqual({ id: "t1" });
    expect(migrateRunLists(kv, s)).toBe(0);
  });

  it("counts state in bytes, not characters, and refuses an update that grows a key past the cap", () => {
    const s = make(() => T0);
    expect(() => s.stateSet("t1", "ru", "я".repeat(600_000))).toThrow(RangeError);
    s.stateSet("t1", "a", "x".repeat(600_000));
    s.stateSet("t1", "b", "y".repeat(300_000));
    expect(() => s.stateSet("t1", "b", "y".repeat(500_000))).toThrow(RangeError);
    expect(s.stateGet("t1", "b")).toBe("y".repeat(300_000));
  });

  it("finds notes by trigger id, newest first, whatever the agent's other triggers kept", () => {
    let now = T0;
    const s = make(() => now);
    s.addNote({ agentId: "a1", triggerId: "quiet", triggerName: "Quiet", text: "old one", signalIds: [], external: false });
    for (let i = 0; i < 250; i++) {
      now = T0 + (i + 1) * 1000;
      s.addNote({ agentId: "a1", triggerId: "busy", triggerName: "Busy", text: `b${i}`, signalIds: [], external: false });
    }
    expect(s.notes({ agentId: "a1", triggerId: "quiet", limit: 20 }).map((n) => n.text)).toEqual(["old one"]);
    // By the name its notes keep, in any case: a trigger deleted since is found by it too.
    expect(s.notes({ agentId: "a1", triggerName: "QUIET", limit: 20 }).map((n) => n.text)).toEqual(["old one"]);
  });

  it("leaves a malformed run list in storage, moves the good ones and says so", () => {
    const kv = pluginKv(openDb(":memory:"), "triggers");
    const s = make(() => T0);
    kv.set("runs:good", [run("g1", T0)]);
    kv.set("runs:bad", [run("b1", T0), { at: "x" }]);
    kv.set("runs:odd", "nope");
    const warned: string[] = [];
    expect(migrateRunLists(kv, s, { warn: (m) => warned.push(m) })).toBe(1);
    expect(s.runs("good").map((r) => r.id)).toEqual(["g1"]);
    expect(s.runs("bad")).toEqual([]);
    expect(kv.list("runs:").map((r) => r.key)).toEqual(["runs:bad", "runs:odd"]);
    expect(warned.length).toBe(2);
  });
});

describe("trigger store (sql) reading notes", () => {
  /** A database whose note reads are watched: the rows each `all()` brought, and whether `iterate()` was used. */
  function watched() {
    const db = openDb(":memory:");
    const reads: Array<{ how: "all" | "iterate"; rows?: number }> = [];
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const st = prepare(sql);
      if (!/from signal_notes/.test(sql) || !/^\s*select/i.test(sql)) return st;
      return {
        all: (...a: any[]) => {
          const rows = st.all(...a);
          reads.push({ how: "all", rows: rows.length });
          return rows;
        },
        iterate: (...a: any[]) => {
          reads.push({ how: "iterate" });
          return st.iterate(...a);
        },
        get: (...a: any[]) => st.get(...a),
        run: (...a: any[]) => st.run(...a),
      };
    };
    return { db, reads };
  }

  it("brings only the rows asked for: a SQL limit, or rows read one by one with a text filter", () => {
    const { db, reads } = watched();
    let now = T0;
    const s = sqlStore(db, () => now);
    for (let i = 0; i < 300; i++) {
      now = T0 + i * 1000;
      s.addNote({ agentId: "a1", triggerId: `t${i % 3}`, triggerName: "T", text: i === 5 ? "the needle" : `n${i}`, signalIds: [], external: false });
    }
    reads.length = 0;
    expect(s.notes({ agentId: "a1", limit: 5 }).map((n) => n.text)).toEqual(["n299", "n298", "n297", "n296", "n295"]);
    expect(reads).toEqual([{ how: "all", rows: 5 }]);
    reads.length = 0;
    expect(s.notes({ agentId: "a1", text: "NEEDLE", limit: 5 }).map((n) => n.text)).toEqual(["the needle"]);
    expect(reads).toEqual([{ how: "iterate" }]);
  });
});
