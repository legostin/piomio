import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { pluginKv } from "../src/plugins/kv.ts";

describe("plugin key-value storage", () => {
  it("keeps JSON values per plugin", () => {
    const db = openDb(":memory:");
    const a = pluginKv(db, "triggers");
    const b = pluginKv(db, "memory");
    a.set("trigger:t_1", { id: "t_1", state: { n: 1 } });
    b.set("trigger:t_1", "other plugin");
    expect(a.get("trigger:t_1")).toEqual({ id: "t_1", state: { n: 1 } });
    expect(b.get("trigger:t_1")).toBe("other plugin");
    expect(a.get("missing")).toBeNull();
    a.set("trigger:t_1", { id: "t_1", state: { n: 2 } });
    expect(a.get("trigger:t_1")).toEqual({ id: "t_1", state: { n: 2 } });
    a.delete("trigger:t_1");
    expect(a.get("trigger:t_1")).toBeNull();
    expect(b.get("trigger:t_1")).toBe("other plugin");
  });

  it("lists by an exact prefix, in key order", () => {
    const db = openDb(":memory:");
    const kv = pluginKv(db, "triggers");
    kv.set("runs:t_2", [2]);
    kv.set("trigger:t_2", { id: "t_2" });
    kv.set("trigger:t_1", { id: "t_1" });
    kv.set("a_b", 1);
    kv.set("axb", 2);
    expect(kv.list("trigger:").map((r) => r.key)).toEqual(["trigger:t_1", "trigger:t_2"]);
    // "_" and "%" in a prefix are literal, not LIKE wildcards.
    expect(kv.list("a_").map((r) => r.key)).toEqual(["a_b"]);
    expect(kv.list().length).toBe(5);
  });
});
