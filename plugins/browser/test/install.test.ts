// Chromium auto-install: presence check, one install at a time, shared waiters, failures and retries.
// The installer process is faked: nothing is downloaded here.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  autoInstallDisabled,
  ChromiumInstaller,
  errorLine,
  isMissingExecutableError,
  playwrightCli,
  type InstallProcess,
} from "../server/install.ts";
import { ToolError } from "../server/util.ts";

const CHROME = "/pw/chromium-1248/chrome-linux64/chrome";
const SHELL = "/pw/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";

interface FakeRun {
  line(s: string): void;
  /** Exit 0 with Chromium installed. */
  succeed(): void;
  /** Exit 0 without installing anything. */
  exit0(): void;
  fail(message: string): void;
  killed: boolean;
}

function setup(opts: { present?: string[]; disabled?: boolean; maxInstallMs?: number; executables?: () => string[] } = {}) {
  const files = new Set(opts.present ?? []);
  const runs: FakeRun[] = [];
  const logs: string[] = [];
  let changes = 0;
  const installer = new ChromiumInstaller({
    executables: opts.executables ?? (() => [CHROME, SHELL]),
    exists: (p) => files.has(p),
    spawn: (onLine): InstallProcess => {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const done = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const run: FakeRun = {
        line: onLine,
        succeed: () => {
          files.add(CHROME);
          files.add(SHELL);
          resolve();
        },
        exit0: () => resolve(),
        fail: (m) => reject(new Error(m)),
        killed: false,
      };
      runs.push(run);
      return {
        done,
        kill: () => {
          run.killed = true;
          reject(new Error("the Playwright installer was stopped (SIGTERM)"));
        },
      };
    },
    log: { info: (...a: unknown[]) => logs.push(a.join(" ")), warn: (...a: unknown[]) => logs.push(`WARN ${a.join(" ")}`) },
    disabled: opts.disabled,
    maxInstallMs: opts.maxInstallMs,
    onChange: () => changes++,
  });
  return { installer, runs, files, logs, changes: () => changes };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("chromium installer", () => {
  it("does nothing when Chromium is present", async () => {
    const { installer, runs } = setup({ present: [CHROME, SHELL] });
    expect(installer.missing()).toEqual([]);
    expect(installer.check()).toBe(false);
    await installer.ensure();
    expect(runs).toHaveLength(0);
    expect(installer.status()).toEqual({ installing: false, step: null, progress: null, error: null });
  });

  it("treats a missing headless shell as missing", () => {
    const { installer } = setup({ present: [CHROME] });
    expect(installer.missing()).toEqual([SHELL]);
  });

  it("counts executables it cannot locate as present and leaves the verdict to the launch", () => {
    const { installer, logs } = setup({
      executables: () => {
        throw new Error("unsupported platform");
      },
    });
    expect(installer.missing()).toEqual([]);
    expect(logs.some((l) => l.startsWith("WARN") && l.includes("unsupported platform"))).toBe(true);
  });

  it("installs once on start, and every waiter shares that install", async () => {
    const { installer, runs, logs, changes } = setup();
    expect(installer.check()).toBe(true);
    expect(installer.installing).toBe(true);
    const a = installer.ensure();
    const b = installer.ensure();
    expect(installer.check()).toBe(true);
    expect(runs).toHaveLength(1);

    runs[0].line("Downloading Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248) from https://cdn.playwright.dev/x.zip");
    runs[0].line("|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                        |  50% of 113.4 MiB");
    expect(installer.status()).toMatchObject({ installing: true, step: "Chrome Headless Shell 156.0.8078.4", progress: 50 });
    expect(changes()).toBeGreaterThanOrEqual(3);

    runs[0].succeed();
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(installer.status()).toEqual({ installing: false, step: null, progress: null, error: null });
    expect(logs.some((l) => l.includes("Chromium is installed"))).toBe(true);

    await installer.ensure();
    expect(runs).toHaveLength(1);
  });

  it("starts the install from a browser call when nothing started it", async () => {
    const { installer, runs } = setup({ present: [CHROME] });
    const p = installer.ensure();
    expect(runs).toHaveLength(1);
    runs[0].succeed();
    await p;
    expect(installer.missing()).toEqual([]);
  });

  it("reports a failed install in English and retries on the next call", async () => {
    const { installer, runs } = setup();
    installer.check();
    const waiting = installer.ensure().catch((e) => e);
    runs[0].line("Downloading Chrome for Testing 156.0.8078.4 (playwright chromium v1248) from https://cdn.playwright.dev/x.zip");
    runs[0].line("Error: getaddrinfo ENOTFOUND cdn.playwright.dev");
    runs[0].line("    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26)");
    runs[0].fail("the Playwright installer exited with code 1");
    const err = await waiting;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("installFailed");
    expect(err.message).toMatch(/^Could not install Chromium: the Playwright installer exited with code 1: Error: getaddrinfo ENOTFOUND cdn\.playwright\.dev\./);
    expect(err.message).toContain("cdn.playwright.dev");
    expect(err.params.detail).toContain("ENOTFOUND");
    expect(installer.status()).toMatchObject({ installing: false, error: expect.stringContaining("ENOTFOUND") });

    // A failed install is not cached: the next call runs the installer again.
    const retry = installer.ensure();
    expect(runs).toHaveLength(2);
    expect(installer.status().error).toBeNull();
    runs[1].succeed();
    await retry;
    expect(installer.status().installing).toBe(false);
  });

  it("fails when the installer exits cleanly but the files are still missing", async () => {
    const { installer, runs } = setup();
    const waiting = installer.ensure().catch((e) => e);
    runs[0].exit0(); // exit code 0, nothing on disk
    const err = await waiting;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("installFailed");
    expect(err.message).toContain(`still missing: ${CHROME}, ${SHELL}`);
  });

  it("stops waiting after the timeout while the install goes on, and the next call joins it", async () => {
    const { installer, runs } = setup();
    installer.check();
    runs[0].line("Downloading Chrome for Testing 156.0.8078.4 (playwright chromium v1248) from https://cdn.playwright.dev/x.zip");
    runs[0].line("|■■■■■■■■■■■■■■■■                                                                |  20% of 172.8 MiB");
    const err = await installer.ensure(20).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("installing");
    expect(err.message).toContain("Chromium is still being installed (downloading Chrome for Testing 156.0.8078.4: 20%)");
    expect(installer.installing).toBe(true);
    expect(runs[0].killed).toBe(false);

    const next = installer.ensure();
    expect(runs).toHaveLength(1);
    runs[0].succeed();
    await next;
  });

  it("kills an install that takes too long and reports it", async () => {
    const { installer, runs } = setup({ maxInstallMs: 20 });
    const err = await installer.ensure().catch((e) => e);
    expect(runs[0].killed).toBe(true);
    expect(err.code).toBe("installFailed");
    expect(err.message).toMatch(/took longer than .* and was stopped/);
  });

  it("only reports the missing browser when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD turns the install off", async () => {
    const { installer, runs, logs } = setup({ disabled: true });
    expect(installer.check()).toBe(false);
    expect(logs.some((l) => l.startsWith("WARN") && l.includes("npx playwright install chromium"))).toBe(true);
    const err = await installer.ensure().catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("noChromium");
    expect(err.message).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD");
    expect(runs).toHaveLength(0);
  });

  it("runs the installer when forced although every known file is present (Playwright still misses one)", async () => {
    const { installer, runs } = setup({ present: [CHROME, SHELL] });
    const p = installer.ensure(1000, true);
    expect(runs).toHaveLength(1);
    runs[0].succeed();
    await p;
  });

  it("stops a running install on dispose", async () => {
    const { installer, runs } = setup();
    installer.check();
    installer.dispose();
    expect(runs[0].killed).toBe(true);
    await settled();
    expect(installer.installing).toBe(false);
    expect(installer.status().error).toContain("stopped");
  });
});

describe("install helpers", () => {
  it("reads PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD like Playwright", () => {
    expect(autoInstallDisabled({})).toBe(false);
    expect(autoInstallDisabled({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" })).toBe(true);
    expect(autoInstallDisabled({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "true" })).toBe(true);
    expect(autoInstallDisabled({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "0" })).toBe(false);
    expect(autoInstallDisabled({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "" })).toBe(false);
  });

  it("recognizes Playwright's missing-executable error", () => {
    expect(isMissingExecutableError("browserType.launchPersistentContext: Executable doesn't exist at /x/chrome")).toBe(true);
    expect(isMissingExecutableError("browserType.launch: Target page, context or browser has been closed")).toBe(false);
  });

  it("picks the first error line that is not a stack frame", () => {
    expect(errorLine(["Downloading X", "Error: Download failed: server returned code 403", "    at foo (bar.js:1:1)"])).toBe(
      "Error: Download failed: server returned code 403",
    );
    expect(errorLine(["|■■ | 10% of 1 MiB"])).toBeNull();
  });

  it("locates Playwright's CLI in node_modules", () => {
    expect(existsSync(playwrightCli())).toBe(true);
  });
});
