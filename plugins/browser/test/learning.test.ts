import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Learning, type LearningHost } from "../server/learning.ts";

/** A browser that is not there: the isolated world answers from a list of what is under each press. */
function setup(o: { remember?: boolean } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const notes: string[] = [];
  const under: string[] = [];
  let control = false;
  const ctx = {
    core: {
      call: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "agents.list") return TEAM;
        return method === "speech.transcribe" ? { available: false } : {};
      },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ui: { emit() {} },
  } as any;
  const page = { url: () => "https://water.example/catalog/7" } as any;
  let learning: Learning;
  const host: LearningHost = {
    ctx,
    settings: () => ({ rememberActions: o.remember !== false }) as any,
    get userControl() {
      return control;
    },
    setControl: (on) => {
      control = on;
      learning.onControl(on);
    },
    inspect: async (expression: string) => (expression.includes('"at"') ? ({ role: "button", name: under.shift() ?? "?" } as any) : null),
    viewport: () => ({ w: 1000, h: 800 }),
    activePage: () => page,
    ensurePage: async () => page,
    titleOf: async () => "Каталог",
    titleNow: () => "Каталог",
    note: (t) => notes.push(t),
    watching: () => true,
    changed() {},
  };
  learning = new Learning(host, mkdtempSync(join(tmpdir(), "browser-learning-")));
  /** The person takes control, presses these buttons and hands control back. */
  const takeover = async (...buttons: string[]) => {
    host.setControl(true);
    for (const b of buttons) {
      under.push(b);
      await learning.beforeInput({ event: "mouse", action: "down", x: 0.5, y: 0.5, button: "left" });
    }
    host.setControl(false);
  };
  return { learning, host, calls, notes, takeover };
}

const ORDER = ["Вода 19 л", "В корзину", "Оформить заказ", "Подтвердить"];

/** The team as the hub lists it: Marta uses the browser, the painter only its own app. */
const TEAM = [
  { id: "assistant", name: "Assistant", tools: ["*"] },
  { id: "marta", name: "Marta", tools: ["web_*", "browser_*", "memory_*"] },
  { id: "painter", name: "Painter", tools: ["blender_*"] },
];

describe("learning from takeovers", () => {
  it("gives what the person did to the agent that was just working, as a hint", async () => {
    const { learning, notes, calls, takeover } = setup();
    learning.agentUsed("assistant");
    await takeover("Мои адреса", "Дом");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("While you waited, the person did this in the browser");
    expect(notes[0]).toContain("Clicked button «Мои адреса»");
    // The page the takeover began on, with its title.
    expect(notes[0]).toContain("Landed on «Каталог» — https://water.example/catalog/7");
    expect(learning.journal.list()).toHaveLength(1);
    expect(calls.filter((c) => c.method === "conversations.tell")).toHaveLength(0);
  });

  it("offers to take over a routine the person did by themselves three times, once", async () => {
    const { learning, notes, calls, takeover } = setup();
    await takeover(...ORDER);
    await takeover(...ORDER);
    expect(calls.filter((c) => c.method === "conversations.tell")).toHaveLength(0);
    await takeover(...ORDER);
    const told = calls.filter((c) => c.method === "conversations.tell");
    expect(told).toHaveLength(1);
    // The default agent's dialog: no conversation named.
    expect(told[0].params.conversationId).toBeUndefined();
    expect(told[0].params.text).toContain("[Browser] The person did the same thing on water.example 3 times");
    expect(told[0].params.text).toContain("browser_journal dismiss");
    await takeover(...ORDER);
    expect(calls.filter((c) => c.method === "conversations.tell")).toHaveLength(1);
    expect(notes).toEqual([]);
    expect(learning.journal.list()).toHaveLength(4);
  });

  it("keeps nothing of the person's own use when they turned that off, but still helps a waiting agent", async () => {
    const { learning, notes, takeover } = setup({ remember: false });
    await takeover(...ORDER);
    expect(learning.journal.list()).toEqual([]);
    learning.agentUsed("assistant");
    await takeover("Дом");
    expect(notes).toHaveLength(1);
    expect(learning.journal.list()).toEqual([]);
  });

  it("ends a demonstration as done when the person hands control back, and tells the agent", async () => {
    const { learning, host, calls } = setup();
    await learning.start({ goal: "заказ воды", agentId: "assistant", conversationId: "c1" });
    expect(host.userControl).toBe(true);
    expect(learning.state()).toMatchObject({ goal: "заказ воды", scope: "task", speech: false, steps: 0 });
    await expect(learning.start({ goal: "ещё" })).rejects.toThrow(/already showing/);
    host.setControl(false);
    await new Promise((r) => setTimeout(r, 20));
    const told = calls.find((c) => c.method === "conversations.tell");
    expect(told?.params).toMatchObject({ conversationId: "c1" });
    expect(told?.params.text).toContain("The person finished showing you how to: заказ воды");
    expect(learning.teaching).toBe(false);
    expect(learning.journal.list()[0]).toMatchObject({ kind: "teach", goal: "заказ воды" });
  });

  it("forgets a cancelled demonstration", async () => {
    const { learning, calls } = setup();
    await learning.start({ goal: "x", agentId: "assistant", conversationId: "c1" });
    await learning.finish("cancel");
    expect(learning.journal.list()).toEqual([]);
    expect(calls.find((c) => c.method === "conversations.tell")?.params.text).toContain("cancelled the demonstration");
  });

  it("teaches the agent whose chat is open when the person presses Teach in the live view", async () => {
    const { learning, calls } = setup();
    await learning.startByPerson("marta");
    // The live view shows whose lesson it is.
    expect(learning.learner).toBe("marta");
    await learning.finish("done");
    const told = calls.find((c) => c.method === "conversations.tell");
    // Marta's own dialog: the skill she saves from it is hers.
    expect(told?.params).toMatchObject({ agentId: "marta" });
    expect(told?.params.conversationId).toBeUndefined();
    expect(told?.params.text).toContain("The person finished showing you something in the browser");
    expect(told?.params.text).toContain("you did not ask for it");
    expect(told?.params.text).toContain("first ask in one short question what this was for");
    expect(learning.journal.all()[0]).toMatchObject({ kind: "teach", agentId: "marta" });
    expect(learning.learner).toBeUndefined();
  });

  it("leaves Teach with the default agent when no agent's chat is open, or its agent cannot use the browser", async () => {
    for (const open of [undefined, "painter", "nobody", 7]) {
      const { learning, calls } = setup();
      await learning.startByPerson(open);
      expect(learning.learner).toBeUndefined();
      await learning.finish("done");
      const told = calls.find((c) => c.method === "conversations.tell");
      expect(told?.params.agentId).toBeUndefined();
      expect(told?.params.conversationId).toBeUndefined();
      expect(told?.params.text).toContain("showing an agent (from the browser's Teach button, so you were not asked)");
    }
  });

  it("says nothing when the person cancels a lesson they started themselves", async () => {
    const { learning, calls } = setup();
    await learning.startByPerson("marta");
    await learning.finish("cancel");
    expect(learning.journal.list()).toEqual([]);
    expect(calls.filter((c) => c.method === "conversations.tell")).toEqual([]);
  });
});
