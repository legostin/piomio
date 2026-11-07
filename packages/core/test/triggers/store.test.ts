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

  it("prunes runs older than 14 days on the next add", () => {
    let now = T0;
    const s = make(() => now);
    s.addRun("t1", run("old", now));
    now = T0 + 15 * DAY;
    s.addRun("t1", run("new", now));
    expect(s.runs("t1", 10).map((r) => r.id)).toEqual(["new"]);
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
});
