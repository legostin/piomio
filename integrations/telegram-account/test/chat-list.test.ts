// The account's list of chats as the integration keeps it (server/chat-list.ts). Walking the whole list is the
// expensive thing to ask of Telegram (a hundred chats a request), and asking it for every tool call got the account
// rate-limited: so the list is walked once, shared by everyone who asks meanwhile, kept, and brought up to date from
// what arrives.
import { describe, expect, it } from "vitest";
import { ChatList, StillLoading, within } from "../server/chat-list.ts";
import { RateLimited } from "../server/client.ts";
import type { TgChat, TgMessage } from "../server/client.ts";

const chat = (id: string, over: Partial<TgChat> = {}): TgChat => ({ id, kind: "private", title: `Chat ${id}`, ...over });
const message = (chatId: string, id: number, over: Partial<TgMessage> = {}): TgMessage => ({ id, chatId, date: "2026-11-17T07:00:00.000Z", out: false, sender: "Someone", text: "hello", ...over });

function listOf(chats: TgChat[], o: { freshMs?: number } = {}) {
  const t = { now: 1_000_000, walks: 0, fail: undefined as Error | undefined, release: undefined as (() => void) | undefined, hold: false };
  const list = new ChatList(
    async () => {
      t.walks++;
      if (t.hold) await new Promise<void>((r) => (t.release = r));
      if (t.fail) throw t.fail;
      return chats.map((c) => ({ ...c }));
    },
    { freshMs: o.freshMs ?? 60_000, now: () => t.now },
  );
  return { list, t };
}

describe("the account's list of chats", () => {
  it("walks the list once for an account of any size, however often it is asked", async () => {
    // 1142 chats, as the account that was rate-limited had: fewer than the most a walk takes.
    const { list, t } = listOf(Array.from({ length: 1142 }, (_, i) => chat(String(i + 1))));
    expect((await list.all()).length).toBe(1142);
    expect((await list.all()).length).toBe(1142);
    expect((await list.find("7"))?.title).toBe("Chat 7");
    expect(t.walks).toBe(1);
  });

  it("shares one walk between calls that come together", async () => {
    const { list, t } = listOf([chat("1"), chat("2"), chat("3")]);
    t.hold = true;
    const three = [list.find("1"), list.find("2"), list.find("3")];
    await new Promise((r) => setTimeout(r, 10));
    expect(t.walks).toBe(1);
    t.release!();
    expect((await Promise.all(three)).map((c) => c?.id)).toEqual(["1", "2", "3"]);
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

  it("looks again for a chat it does not know only when the list is old", async () => {
    const chats = [chat("1")];
    const { list, t } = listOf(chats);
    await list.all();
    expect(await list.find("9")).toBeUndefined();
    expect(t.walks).toBe(1);
    chats.push(chat("9"));
    t.now += 61_000;
    expect((await list.find("9"))?.id).toBe("9");
    expect(t.walks).toBe(2);
  });

  it("answers with the list it has when Telegram refuses a new walk, and fails only with none", async () => {
    const { list, t } = listOf([chat("1")]);
    await list.all();
    t.now += 120_000;
    t.fail = new RateLimited(37);
    expect((await list.all()).map((c) => c.id)).toEqual(["1"]);
    // It does not ask again at once: the next walk waits for a fresh minute.
    await list.all();
    expect(t.walks).toBe(2);

    const none = listOf([chat("1")]);
    none.t.fail = new RateLimited(37);
    await expect(none.list.all()).rejects.toMatchObject({ seconds: 37 });
  });

  it("keeps the list up to date from new messages and from what was read elsewhere", async () => {
    const { list, t } = listOf([chat("1", { unread: 0 }), chat("2", { unread: 4 })]);
    await list.all();
    list.note(message("2", 50, { text: "newest" }), chat("2"));
    list.note(message("1", 60, { out: true, text: "mine" }), chat("1"));
    list.note(message("3", 70, { text: "a new chat" }), chat("3", { title: "New one" }));
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

  it("lets a caller that cannot wait long give up, while the walk goes on", async () => {
    const { list, t } = listOf([chat("1")]);
    t.hold = true;
    await expect(within(list.all(), 20)).rejects.toBeInstanceOf(StillLoading);
    t.release!();
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
