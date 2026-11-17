import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SelfCheck, watchThreadPool } from "../src/self-check.ts";

/** Lets the probe's answer (a settled promise) reach the check. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("the hub's self-check", () => {
  it("stays quiet while each probe is answered", async () => {
    let dead = 0;
    const check = new SelfCheck({ probe: async () => {}, misses: 2, onDead: () => dead++ });
    for (let i = 0; i < 10; i++) {
      check.tick();
      await settle();
    }
    expect(dead).toBe(0);
  });

  it("reports once when a probe stays unanswered for the allowed number of checks", () => {
    const seen: number[] = [];
    const check = new SelfCheck({ probe: () => new Promise(() => {}), misses: 3, onDead: (missed) => seen.push(missed) });
    check.tick(); // asks
    check.tick();
    check.tick();
    expect(seen).toEqual([]);
    check.tick();
    expect(seen).toEqual([3]);
    check.tick();
    check.tick();
    expect(seen).toEqual([3]);
  });

  it("forgives a late answer: the count starts over", async () => {
    let answer: () => void = () => {};
    let dead = 0;
    const check = new SelfCheck({ probe: () => new Promise<void>((r) => (answer = r)), misses: 3, onDead: () => dead++ });
    check.tick(); // asks
    check.tick();
    check.tick(); // two checks without an answer
    answer();
    await settle();
    check.tick(); // asks again
    check.tick();
    check.tick();
    expect(dead).toBe(0);
    check.tick();
    expect(dead).toBe(1);
  });

  it("takes a failed probe for an answer: the work was done", async () => {
    let dead = 0;
    const check = new SelfCheck({ probe: () => Promise.reject(new Error("ENOENT")), misses: 1, onDead: () => dead++ });
    for (let i = 0; i < 5; i++) {
      check.tick();
      await settle();
    }
    expect(dead).toBe(0);
  });
});

describe("the thread pool watch", () => {
  it("leaves a hub whose file reads complete alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "self-check-"));
    const lines: string[] = [];
    let kills = 0;
    const check = watchThreadPool({ dir, log: (m) => lines.push(m), kill: () => kills++ });
    for (let i = 0; i < 6; i++) {
      check.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    check.stop();
    expect(kills).toBe(0);
    expect(lines).toEqual([]);
  });

  it("says what hangs, records it and ends the process when file reads stop completing", () => {
    const lines: string[] = [];
    const order: string[] = [];
    const records: unknown[] = [];
    const check = watchThreadPool({
      dir: tmpdir(),
      log: (m) => (lines.push(m), order.push("log")),
      kill: () => order.push("kill"),
      record: (data) => (records.push(data), order.push("record")),
      probe: () => new Promise(() => {}),
      pending: () => ["GetAddrInfoReqWrap", "FSReqCallback", "GetAddrInfoReqWrap", "Timeout", "TCPSocketWrap"],
      misses: 2,
    });
    check.tick();
    check.tick();
    check.tick();
    expect(order).toEqual(["log", "record", "kill"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("thread pool");
    expect(lines[0]).toContain("GetAddrInfoReqWrap×2");
    expect(lines[0]).toContain("FSReqCallback×1");
    // Sockets and timers are not the pool's work.
    expect(lines[0]).not.toContain("Timeout");
    expect(records).toEqual([{ pending: { GetAddrInfoReqWrap: 2, FSReqCallback: 1 } }]);
  });

  it("still ends the process when the record cannot be written", () => {
    let kills = 0;
    const check = watchThreadPool({
      dir: tmpdir(),
      log: () => {},
      kill: () => kills++,
      record: () => {
        throw new Error("database is locked");
      },
      probe: () => new Promise(() => {}),
      misses: 1,
    });
    check.tick();
    check.tick();
    expect(kills).toBe(1);
  });

  it("ends a real process whose pool is held, long before the pool is free again", async () => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "fixtures", "stuck-pool.ts")], {
      env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    // The key derivations take far longer than this; an exit that waited for them would run into it.
    const giveUp = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const [code, signal] = await new Promise<[number | null, string | null]>((r) => child.on("exit", (c, s) => r([c, s])));
    clearTimeout(giveUp);
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(out).toContain("the thread pool stopped taking work");
    expect(out).toContain("FSReqPromise×1");
    expect(code === null ? signal : code).not.toBe(0);
  }, 15_000);
});
