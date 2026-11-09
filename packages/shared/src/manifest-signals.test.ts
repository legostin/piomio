import { describe, expect, it } from "vitest";
import { PiomioManifestSchema, SignalDeclSchema } from "./manifest.ts";

const base = { id: "demo", name: "Demo" };

describe("contributes.signals", () => {
  it("parses two signals with defaults", () => {
    const m = PiomioManifestSchema.parse({
      ...base,
      contributes: {
        signals: [
          { type: "new_mail", title: "%mail.title%", description: "A message arrived." },
          { type: "price", mode: "subscribe", title: "Price", description: "Price moved.", external: false, config: { type: "object" } },
        ],
      },
    });
    expect(m.contributes.signals).toHaveLength(2);
    expect(m.contributes.signals[0]).toMatchObject({ mode: "broadcast", external: true });
    expect(m.contributes.signals[1]).toMatchObject({ mode: "subscribe", external: false });
  });

  it("refuses a type declared twice", () => {
    const r = PiomioManifestSchema.safeParse({
      ...base,
      contributes: { signals: [{ type: "ping", title: "a", description: "a" }, { type: "pong", title: "b", description: "b" }, { type: "ping", mode: "subscribe", title: "c", description: "c" }] },
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues).toMatchObject([{ path: ["contributes", "signals", 2, "type"], message: 'signal type "ping" is declared twice' }]);
  });

  it("defaults to no signals", () => {
    expect(PiomioManifestSchema.parse(base).contributes.signals).toEqual([]);
  });

  it("rejects a bad type", () => {
    for (const type of ["New", "1x", "a-b", "", "a".repeat(42)]) {
      expect(SignalDeclSchema.safeParse({ type, title: "t", description: "d" }).success).toBe(false);
    }
  });

  it("still parses and ignores the old contributes.triggers", () => {
    const m = PiomioManifestSchema.parse({ ...base, contributes: { triggers: ["x"] } });
    expect(m.contributes.signals).toEqual([]);
    expect("triggers" in m.contributes).toBe(false);
  });
});
