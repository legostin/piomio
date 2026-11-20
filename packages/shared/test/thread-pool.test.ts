import { describe, expect, it } from "vitest";
import { keepThreadPoolAwake, threadPoolSize, wakeThreadPool } from "../src/thread-pool.ts";

describe("keeping the thread pool awake", () => {
  it("knows the pool's size: four threads unless UV_THREADPOOL_SIZE says otherwise", () => {
    expect(threadPoolSize({})).toBe(4);
    expect(threadPoolSize({ UV_THREADPOOL_SIZE: "8" })).toBe(8);
    expect(threadPoolSize({ UV_THREADPOOL_SIZE: "0" })).toBe(4);
    expect(threadPoolSize({ UV_THREADPOOL_SIZE: "many" })).toBe(4);
    expect(threadPoolSize({ UV_THREADPOOL_SIZE: "5000" })).toBe(1024);
  });

  it("posts one job per pool thread in the same tick", () => {
    let posted = 0;
    wakeThreadPool(4, () => posted++);
    expect(posted).toBe(4);
  });

  it("its own job is done by the pool", async () => {
    const done = await new Promise<number>((resolve) => {
      let n = 0;
      wakeThreadPool(3, undefined, () => ++n === 3 && resolve(n));
    });
    expect(done).toBe(3);
  });

  it("runs on macOS only", () => {
    expect(keepThreadPoolAwake({ platform: "linux" })).toBeUndefined();
    expect(keepThreadPoolAwake({ platform: "win32" })).toBeUndefined();
  });

  it("wakes the pool on every round until it is stopped", async () => {
    let rounds = 0;
    const stop = keepThreadPoolAwake({ platform: "darwin", everyMs: 5, wake: () => rounds++ });
    expect(stop).toBeTypeOf("function");
    await new Promise((r) => setTimeout(r, 60));
    stop!();
    const seen = rounds;
    expect(seen).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(rounds).toBe(seen);
  });
});
