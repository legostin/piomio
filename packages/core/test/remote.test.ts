// RemoteAccess with a fake node (fixtures/tailnet/fake-tailnet.mjs): its states, restarts, turning off and forgetting,
// the link shown once it answers, and what install.sh and `piomio link` read.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteView } from "@piomio/shared";
import { tFor } from "../src/i18n.ts";
import { EventBus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { deviceTls } from "../src/devices-tls.ts";
import { printLink, readRemoteStatus, RemoteAccess, remoteStatusFile } from "../src/remote.ts";
import { hubDbFile, openDb } from "../src/db.ts";
import { Settings } from "../src/settings.ts";

const FAKE = join(import.meta.dirname, "fixtures/tailnet/fake-tailnet.mjs");
chmodSync(FAKE, 0o755);

function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() > end) return reject(new Error("timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const made: RemoteAccess[] = [];
afterEach(async () => {
  for (const r of made.splice(0)) await r.stop();
});

function setup(opts: { bin?: string; plan?: unknown; password?: boolean; checkLink?: (url: string) => Promise<boolean>; status?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "owl-remote-"));
  const config = loadConfig({ PIOMIO_TAILNET_BIN: opts.bin ?? FAKE, PIOMIO_TAILNET_HOSTNAME: "piomio-test", TZ: "UTC" }, { dataDir });
  if (opts.plan) {
    mkdirSync(join(dataDir, "tailnet"), { recursive: true });
    writeFileSync(join(dataDir, "tailnet", "fake.json"), JSON.stringify(opts.plan));
  }
  let settings = { remoteAccess: false };
  const bus = new EventBus();
  const events: RemoteView[] = [];
  bus.on("remote.updated", (v) => events.push(v));
  const gateways = { started: 0, stopped: 0, async start() { this.started++; return { web: 4101, device: 4102 }; }, async stop() { this.stopped++; } };
  const remote = new RemoteAccess({
    config,
    settings: { get: () => settings, update: (p) => (settings = { ...settings, ...p }) },
    bus,
    deviceTls: () => deviceTls(dataDir),
    gateways,
    hasPassword: () => opts.password !== false,
    checkLink: opts.checkLink ?? (async () => true),
    ...(opts.status ? { statusFile: remoteStatusFile(dataDir) } : {}),
  });
  made.push(remote);
  return { remote, dataDir, events, gateways, settings: () => settings };
}

const RUNNING = { state: "running", url: "https://piomio-test.tail1234.ts.net", deviceUrl: "https://piomio-test.tail1234.ts.net:8443", account: "anna@example.com", keyExpiry: "2027-04-25T00:00:00Z" };

describe("access from anywhere", () => {
  it("is unavailable without the node program", async () => {
    const { remote } = setup({ bin: "/nonexistent/piomio-tailnet" });
    expect(remote.view("en")).toMatchObject({ available: false, enabled: false, state: "off" });
    expect(remote.view("en").error).toMatch(/npm run build:tailnet/);
    await expect(remote.enable()).rejects.toMatchObject({ key: "remote.unavailable", status: 409 });
  });

  it("needs the hub password", async () => {
    const { remote } = setup({ password: false });
    await expect(remote.enable()).rejects.toMatchObject({ key: "auth.noPassword", status: 409 });
  });

  it("walks sign-in, Funnel and the link, and tells the node where to proxy", async () => {
    const { remote, dataDir, events, gateways, settings } = setup({
      plan: {
        states: [
          { state: "starting" },
          { state: "needs-login", authUrl: "https://login.tailscale.com/a/abc" },
          { state: "needs-funnel", enableUrl: "https://login.tailscale.com/f/funnel?node=n1" },
          RUNNING,
        ],
      },
    });
    await remote.enable();
    expect(settings().remoteAccess).toBe(true);
    await until(() => events.find((e) => e.state === "running"));
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(["needs-login", "needs-funnel", "running"]));
    expect(events.find((e) => e.state === "needs-login")?.authUrl).toBe("https://login.tailscale.com/a/abc");
    expect(events.find((e) => e.state === "needs-funnel")?.enableUrl).toBe("https://login.tailscale.com/f/funnel?node=n1");
    expect(remote.view("en")).toEqual({ available: true, enabled: true, ...RUNNING });
    expect(remote.linkHost()).toBe("piomio-test.tail1234.ts.net");
    expect(remote.deviceLink()).toBe("https://piomio-test.tail1234.ts.net:8443");

    const start = JSON.parse(readFileSync(join(dataDir, "tailnet", "start.json"), "utf8"));
    expect(start).toMatchObject({ type: "start", dir: join(dataDir, "tailnet"), hostname: "piomio-test", web: "127.0.0.1:4101", device: "127.0.0.1:4102" });
    expect(start.deviceCert).toBe(deviceTls(dataDir).cert);
    expect(start.deviceKey).toBe(deviceTls(dataDir).key);
    expect(gateways.started).toBe(1);

    await remote.disable();
    expect(settings().remoteAccess).toBe(false);
    expect(remote.view("en")).toEqual({ available: true, enabled: false, state: "off" });
    expect(remote.linkHost()).toBeUndefined();
    expect(gateways.stopped).toBeGreaterThan(0);
  });

  it("restarts a node that fell over, saying why meanwhile", async () => {
    const { remote, events } = setup({ plan: { states: [{ state: "starting" }], crashOnce: true } });
    await remote.enable();
    const failed = await until(() => events.find((e) => e.state === "error"));
    expect(failed.error).toBe("Tailscale: boom: the fake node fell over");
    // The second run does not crash: it is back to "starting" after the 2 s pause.
    await until(() => events.findLast((e) => e.state !== "error" && events.indexOf(e) > events.indexOf(failed)), 6000);
  });

  it("reports machine approval as a step, not a failure", async () => {
    const { remote, events } = setup({ plan: { states: [{ state: "needs-login", message: "machine-auth" }] } });
    await remote.enable();
    await until(() => events.find((e) => e.state === "needs-login"));
    expect(remote.view("en").error).toMatch(/approve the piomio machine/);
  });

  it("forgets: signs the node out and deletes its keys", async () => {
    const { remote, dataDir, settings } = setup({ plan: { states: [RUNNING] } });
    await remote.enable();
    await until(() => remote.linkHost());
    await remote.forget();
    expect(existsSync(join(dataDir, "tailnet.logged-out"))).toBe(true);
    expect(existsSync(join(dataDir, "tailnet"))).toBe(false);
    expect(settings().remoteAccess).toBe(false);
    expect(remote.view("en").state).toBe("off");
  });

  it("shows the link only once it answers, and tells install.sh each step", async () => {
    const asked: string[] = [];
    const { remote, dataDir, events } = setup({
      status: true,
      checkLink: async (url) => asked.push(url) > 1,
      plan: { states: [{ state: "needs-login", authUrl: "https://login.tailscale.com/a/abc" }, RUNNING] },
    });
    await remote.start();
    expect(readRemoteStatus(remoteStatusFile(dataDir))).toEqual({ available: true, enabled: false, state: "off" });
    await remote.enable();
    await until(() => events.find((e) => e.state === "needs-login"));
    expect(readRemoteStatus(remoteStatusFile(dataDir))).toMatchObject({ enabled: true, state: "needs-login", authUrl: "https://login.tailscale.com/a/abc" });
    // The node says it runs, the link does not answer yet: still starting, no link anywhere.
    await until(() => events.find((e) => e.preparing));
    expect(remote.view("en")).toEqual({ available: true, enabled: true, state: "starting", preparing: true });
    expect(remote.link()).toBeUndefined();
    expect(remote.deviceLink()).toBeUndefined();
    expect(remote.linkHost()).toBe("piomio-test.tail1234.ts.net");
    expect(readRemoteStatus(remoteStatusFile(dataDir))?.url).toBeUndefined();
    // Asked again a few seconds later, it answers.
    await until(() => events.find((e) => e.state === "running"), 8000);
    expect(asked).toEqual([RUNNING.url, RUNNING.url]);
    expect(remote.link()).toBe(RUNNING.url);
    expect(readRemoteStatus(remoteStatusFile(dataDir))).toEqual({ available: true, enabled: true, state: "running", url: RUNNING.url });
  }, 15_000);

  it("comes back on hub start when it was on", async () => {
    const { remote, events, settings } = setup({ plan: { states: [RUNNING] } });
    expect(settings().remoteAccess).toBe(false);
    await remote.start();
    expect(events).toEqual([]);
    await remote.enable();
    await until(() => remote.linkHost());
    await remote.stop();
    expect(settings().remoteAccess).toBe(true);
    await remote.start();
    await until(() => remote.linkHost());
  });
});

describe("piomio link", () => {
  const t = tFor("en");

  /** Runs printLink over the states the hub writes one after another, a second apart. */
  async function run(states: unknown[], o: { wait: boolean; setupCode?: string }) {
    const file = join(mkdtempSync(join(tmpdir(), "owl-link-")), "remote.json");
    let clock = 0;
    let i = 0;
    const lines: string[] = [];
    const write = () => {
      const s = states[Math.min(i++, states.length - 1)];
      if (s) writeFileSync(file, JSON.stringify(s));
    };
    write();
    const up = await printLink({
      file,
      wait: o.wait,
      setupCode: o.setupCode,
      t,
      print: (l) => lines.push(l),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        write();
      },
    });
    return { up, out: lines.join("\n") };
  }

  const on = { available: true, enabled: true };
  const login = { ...on, state: "needs-login", authUrl: "https://login.tailscale.com/a/abc" };
  const funnel = { ...on, state: "needs-funnel", enableUrl: "https://login.tailscale.com/f/funnel" };
  const up = { ...on, state: "running", url: "https://piomio.tail1234.ts.net" };

  it("waits through the sign-in and Funnel for the link, with the setup code until the first password", async () => {
    const r = await run([undefined, { ...on, state: "off" }, login, login, funnel, { ...on, state: "starting", preparing: true }, up], { wait: true, setupCode: "Code_123456789" });
    expect(r.up).toBe(true);
    expect(r.out).toBe(
      [
        "To open Piomio from any phone or browser, sign in to Tailscale (a free account is enough):\n  https://login.tailscale.com/a/abc",
        "Waiting for the sign-in (Ctrl+C to stop: Piomio keeps running)…",
        "Now allow Funnel in Tailscale, so the link opens from the internet:\n  https://login.tailscale.com/f/funnel",
        "Piomio's link, for any device:\n  https://piomio.tail1234.ts.net/#setup=Code_123456789",
      ].join("\n"),
    );
  });

  it("without waiting stops at the sign-in page; prints the link alone once set up", async () => {
    const r = await run([undefined, login], { wait: false });
    expect(r.up).toBe(false);
    expect(r.out).toMatch(/^To open Piomio[\s\S]*a\/abc\nThe link isn't up yet\. Once you have signed in to Tailscale, piomio link prints it/);
    expect(await run([up], { wait: false })).toEqual({ up: true, out: "Piomio's link, for any device:\n  https://piomio.tail1234.ts.net" });
  });

  it("says when access from anywhere is off, and gives up when the hub never says", async () => {
    expect((await run([{ available: true, enabled: false, state: "off" }], { wait: true })).out).toMatch(/is off: say "turn on access from anywhere"/);
    const never = await run([undefined], { wait: false });
    expect(never).toEqual({ up: false, out: expect.stringMatching(/^The link isn't up yet/) });
  });
});

describe("a server's hub", () => {
  it("starts with access from anywhere on, and keeps the person's choice", () => {
    const db = openDb(hubDbFile(mkdtempSync(join(tmpdir(), "owl-server-settings-"))));
    const settings = new Settings(db, "UTC", { remoteAccess: true });
    expect(settings.get().remoteAccess).toBe(true);
    settings.update({ language: "ru" });
    expect(settings.update({ remoteAccess: false }).remoteAccess).toBe(false);
    expect(new Settings(db, "UTC", { remoteAccess: true }).get().remoteAccess).toBe(false);
    expect(new Settings(openDb(hubDbFile(mkdtempSync(join(tmpdir(), "owl-desktop-settings-")))), "UTC").get().remoteAccess).toBe(false);
  });
});
