// The account's list of chats as the integration keeps it (server/chat-list.ts). Walking the whole list is the
// expensive thing to ask of Telegram (a hundred chats a request, and requests are paced), and asking it for every
// tool call got the account rate-limited: so the list is walked once, page by page, shared by everyone who asks
// meanwhile, kept, and brought up to date from what arrives. What needs only the recent chats is answered from the
// first page; what needs one chat, as soon as its page is there.
import { describe, expect, it } from "vitest";
import { ChatList, StillLoading, within } from "../server/chat-list.ts";
import { RateLimited } from "../server/client.ts";
import type { TgChat, TgMessage } from "../server/client.ts";

const chat = (id: string, over: Partial<TgChat> = {}): TgChat => ({ id, kind: "private", title: `Chat ${id}`, ...over });
const message = (chatId: string, id: number, over: Partial<TgMessage> = {}): TgMessage => ({ id, chatId, date: "2026-11-17T07:00:00.000Z", out: false, sender: "Someone", text: "hello", ...over });
const many = (n: number) => Array.from({ length: n }, (_, i) => chat(String(i + 1)));
const tick = () => new Promise((r) => setTimeout(r, 2));

function listOf(chats: TgChat[], o: { freshMs?: number; retryMs?: number; page?: number } = {}) {
  const size = o.page ?? 100;
  const t = {
    now: 1_000_000,
    walks: 0,
    /** Pages Telegram was asked for. */
    pages: 0,
    fail: undefined as Error | undefined,
    /** With `fail`: the page (from 0) that fails; the ones before it arrive. */
    failAt: 0,
    /** Each page waits to be let through by step(). */
    hold: false,
    gates: [] as Array<() => void>,
    /** Let the next page through. */
    async step() {
      while (!t.gates.length) await tick();
      t.gates.shift()!();
      await tick();
    },
  };
  const list = new ChatList(
    async function* () {
      t.walks++;
      for (let at = 0, n = 0; at < chats.length || n === 0; at += size, n++) {
        t.pages++;
        if (t.hold) await new Promise<void>((r) => t.gates.push(r));
        if (t.fail && n >= t.failAt) throw t.fail;
        yield chats.slice(at, at + size).map((c) => ({ ...c }));
      }
    },
    { freshMs: o.freshMs ?? 300_000, retryMs: o.retryMs ?? 60_000, now: () => t.now },
  );
  return { list, t };
}

describe("the account's list of chats", () => {
  it("walks the list once for an account of any size, however often it is asked", async () => {
    // 1142 chats, as the account that was rate-limited had: fewer than the most a walk takes.
    const { list, t } = listOf(many(1142));
    expect((await list.all()).length).toBe(1142);
    expect((await list.all()).length).toBe(1142);
    expect((await list.find("7"))?.title).toBe("Chat 7");
    expect(await list.recent()).toMatchObject({ complete: true });
    expect(t.walks).toBe(1);
    expect(t.pages).toBe(12);
  });

  it("shares one walk between calls that come together", async () => {
    const { list, t } = listOf(many(3));
    t.hold = true;
    const three = [list.find("1"), list.find("2"), list.all()];
    await tick();
    expect(t.walks).toBe(1);
    await t.step();
    expect((await Promise.all(three)).map((c) => (Array.isArray(c) ? c.length : c?.id))).toEqual(["1", "2", 3]);
    expect(t.walks).toBe(1);
  });

  it("answers from the first page while the rest loads, and finds a chat as soon as its page is there", async () => {
    const { list, t } = listOf(many(250));
    t.hold = true;
    const recent = list.recent();
    const later = list.find("150");
    const whole = list.all();
    let found: TgChat | undefined;
    let done = false;
    void later.then((c) => (found = c));
    void whole.then(() => (done = true));

    await t.step();
    expect(await recent).toMatchObject({ complete: false, chats: { length: 100 } });
    expect((await list.find("42"))?.id).toBe("42");
    expect(found).toBeUndefined();

    await t.step();
    expect(found?.id).toBe("150");
    expect(done).toBe(false);
    expect((await list.recent()).chats.length).toBe(200);

    await t.step();
    expect((await whole).length).toBe(250);
    expect(await list.recent()).toMatchObject({ complete: true, chats: { length: 250 } });
    expect(await list.find("999")).toBeUndefined();
    expect(t.walks).toBe(1);
  });

  it("finds a chat by id or @username in a list of any age, and walks again for the whole list once it is old", async () => {
    const { list, t } = listOf([chat("1", { username: "Anna" }), chat("2")]);
    await list.all();
    t.now += 3_600_000;
    expect((await list.find("2"))?.id).toBe("2");
    expect((await list.find("@anna"))?.id).toBe("1");
    expect(t.walks).toBe(1);
    await list.all();
    expect(t.walks).toBe(2);
  });

  it("keeps answering with the whole list it has while it walks again", async () => {
    const chats = many(150);
    const { list, t } = listOf(chats);
    await list.all();
    t.now += 3_600_000;
    t.hold = true;
    chats.unshift(chat("new"));
    // Stale: a new walk starts, and what is known answers meanwhile.
    expect(await list.recent()).toMatchObject({ complete: true, chats: { length: 150 } });
    await t.step();
    expect((await list.recent()).chats.length).toBe(150);
    await t.step();
    expect((await list.recent()).chats.map((c) => c.id).slice(0, 2)).toEqual(["new", "1"]);
    expect(t.walks).toBe(2);
  });

  it("looks again for a chat it does not know only when the list is old", async () => {
    const chats = [chat("1")];
    const { list, t } = listOf(chats);
    await list.all();
    expect(await list.find("9")).toBeUndefined();
    expect(t.walks).toBe(1);
    chats.push(chat("9"));
    t.now += 301_000;
    expect((await list.find("9"))?.id).toBe("9");
    expect(t.walks).toBe(2);
  });

  it("answers with the list it has when Telegram refuses a new walk, and fails only with none", async () => {
    const { list, t } = listOf([chat("1")]);
    await list.all();
    t.now += 600_000;
    t.fail = new RateLimited(37);
    expect((await list.all()).map((c) => c.id)).toEqual(["1"]);
    // It does not ask again at once.
    await list.all();
    expect(await list.find("5")).toBeUndefined();
    expect(t.walks).toBe(2);

    const none = listOf([chat("1")]);
    none.t.fail = new RateLimited(37);
    await expect(none.list.all()).rejects.toMatchObject({ seconds: 37 });
    await expect(none.list.recent()).rejects.toMatchObject({ seconds: 37 });
    await expect(none.list.find("1")).rejects.toMatchObject({ seconds: 37 });
  });

  it("keeps the pages it got when the first walk is refused midway, and goes on a minute later", async () => {
    const { list, t } = listOf(many(250));
    t.fail = new RateLimited(20);
    t.failAt = 1;
    expect(await list.recent()).toMatchObject({ complete: false, chats: { length: 100 } });
    await tick();
    // The whole list is what there is for now; nothing is asked again at once.
    expect((await list.all()).length).toBe(100);
    expect(await list.find("150")).toBeUndefined();
    expect(t.walks).toBe(1);
    t.fail = undefined;
    t.now += 61_000;
    expect((await list.find("150"))?.id).toBe("150");
    expect((await list.all()).length).toBe(250);
    expect(t.walks).toBe(2);
  });

  it("keeps the list up to date from new messages and from what was read elsewhere", async () => {
    const { list, t } = listOf([chat("1", { unread: 0 }), chat("2", { unread: 4 })]);
    await list.all();
    list.note(message("2", 50, { text: "newest" }), chat("2"));
    list.note(message("1", 60, { out: true, text: "mine" }), chat("1"));
    list.note(message("3", 70, { text: "a new chat" }), chat("3", { title: "New one" }));
    // The same message told twice counts once.
    list.note(message("2", 50, { text: "newest" }), chat("2"));
    const all = await list.all();
    // Most recent first; an incoming message counts as unread, the account's own does not.
    expect(all.map((c) => [c.id, c.unread, c.last?.text])).toEqual([
      ["3", 1, "a new chat"],
      ["1", 0, "mine"],
      ["2", 5, "newest"],
    ]);
    list.read("2", 0);
    expect((await list.find("2"))?.unread).toBe(0);
    expect(t.walks).toBe(1);
  });

  it("neither loses nor doubles a message that arrives while the list loads", async () => {
    const chats = [...many(100), chat("150", { unread: 2, muted: true, last: message("150", 40, { text: "already there" }) }), chat("151", { last: message("151", 7, { text: "old" }) })];
    const { list, t } = listOf(chats);
    t.hold = true;
    const whole = list.all();
    await t.step();
    // Both chats are on the page that has not come yet. Telegram's page will already count the first message, not the second.
    list.note(message("150", 40, { text: "already there" }), chat("150"));
    list.note(message("151", 8, { text: "fresh" }), chat("151"));
    expect((await list.recent()).chats.slice(0, 2).map((c) => [c.id, c.last?.text])).toEqual([
      ["151", "fresh"],
      ["150", "already there"],
    ]);
    await t.step();
    const all = await whole;
    expect(all.length).toBe(102);
    expect(all.filter((c) => c.id === "150")).toEqual([expect.objectContaining({ unread: 2, muted: true, last: expect.objectContaining({ text: "already there" }) })]);
    expect(all[0]).toMatchObject({ id: "151", unread: 1, last: { text: "fresh" } });
  });

  it("keeps what was read elsewhere while the list loads, in the order it happened", async () => {
    const chats = [chat("1", { unread: 4, last: message("1", 5) }), chat("2", { unread: 1, last: message("2", 6) }), ...many(100).slice(2), chat("150", { unread: 3 })];
    const { list, t } = listOf(chats);
    await list.all();
    t.now += 3_600_000;
    t.hold = true;
    const whole = list.all();
    await t.step();
    // The page with chats 1 and 2 has come, and counts them as they were. Then: 1 is read; 2 gets a message, is
    // read, and gets one more.
    list.read("1", 0);
    list.note(message("2", 7), chat("2"));
    list.read("2", 0);
    list.note(message("2", 8, { text: "after reading" }), chat("2"));
    // 150 was read before its page was asked for: the page, which has a message that came after that, knows better.
    list.read("150", 2);
    await t.step();
    const all = await whole;
    expect(all.find((c) => c.id === "1")?.unread).toBe(0);
    expect(all[0]).toMatchObject({ id: "2", unread: 1, last: { text: "after reading" } });
    expect(all.find((c) => c.id === "150")?.unread).toBe(3);
    expect(t.walks).toBe(2);

    // The same during the very first walk, when the pages are shown as they come.
    const first = listOf([chat("1", { unread: 4 }), ...many(150).slice(1)]);
    first.t.hold = true;
    const loading = first.list.all();
    await first.t.step();
    first.list.read("1", 0);
    expect((await first.list.find("1"))?.unread).toBe(0);
    await first.t.step();
    expect((await loading).find((c) => c.id === "1")?.unread).toBe(0);
  });

  it("lets a caller that cannot wait long give up, while the walk goes on", async () => {
    const { list, t } = listOf([chat("1")]);
    t.hold = true;
    await expect(within(list.all(), 20)).rejects.toBeInstanceOf(StillLoading);
    await t.step();
    expect((await within(list.all(), 20)).length).toBe(1);
    expect(t.walks).toBe(1);
  });

  it("starts over after clear()", async () => {
    const { list, t } = listOf([chat("1")]);
    await list.all();
    list.clear();
    await list.all();
    expect(t.walks).toBe(2);
  });
});
