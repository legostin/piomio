// The pause between requests to Telegram (server/pace.ts): however many are asked at once, they leave one at a time,
// no closer than the gap.
import { describe, expect, it } from "vitest";
import { Pace, isPaced } from "../server/pace.ts";

/** A clock the test moves: sleeping only advances it. */
function clock() {
  const c = { now: 50_000, slept: [] as number[] };
  return {
    c,
    o: {
      now: () => c.now,
      sleep: async (ms: number) => {
        c.slept.push(ms);
        c.now += ms;
      },
    },
  };
}

describe("the pause between requests to Telegram", () => {
  it("is for what the tools ask, not for file parts, the stream of updates or signing in", () => {
    for (const m of ["messages.getDialogs", "messages.getHistory", "messages.search", "messages.sendMessage", "channels.getMessages", "users.getUsers"]) expect(isPaced(m), m).toBe(true);
    for (const m of ["upload.getFile", "upload.saveBigFilePart", "updates.getDifference", "updates.getChannelDifference", "auth.exportLoginToken", "account.getPassword", "help.getConfig"]) expect(isPaced(m), m).toBe(false);
  });

  it("lets the first request go at once, and one that comes after the gap too", async () => {
    const { c, o } = clock();
    const pace = new Pace(3000, o);
    await pace.wait();
    c.now += 3000;
    await pace.wait();
    expect(c.slept).toEqual([]);
  });

  it("holds a request that comes sooner for the rest of the gap", async () => {
    const { c, o } = clock();
    const pace = new Pace(3000, o);
    await pace.wait();
    c.now += 1000;
    await pace.wait();
    expect(c.slept).toEqual([2000]);
  });

  it("sends requests asked together one by one, a gap apart, in the order they were asked", async () => {
    const { c, o } = clock();
    const pace = new Pace(3000, o);
    const left: Array<[string, number]> = [];
    await Promise.all(["a", "b", "c", "d"].map((name) => pace.wait().then(() => left.push([name, c.now - 50_000]))));
    expect(left).toEqual([
      ["a", 0],
      ["b", 3000],
      ["c", 6000],
      ["d", 9000],
    ]);
  });
});
