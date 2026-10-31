// Browser lifecycle: lazy launch of Google Chrome (or Playwright's Chromium) as an ordinary browser with a persistent
// profile, active tab, serialized agent tool calls,
// idle shutdown, dialogs and downloads, live view (CDP screencast) and user takeover (CDP input).

import { AsyncLocalStorage } from "node:async_hooks";
import { chromium } from "playwright";
import type { BrowserContext, CDPSession, Dialog, Download, FileChooser, Frame, LaunchOptions, Locator, Page } from "playwright";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@piomio/shared";
import type { PluginContext } from "@piomio/plugin-sdk";
import { HistoryStore } from "./history.ts";
import { createChromiumInstaller, INSTALL_WAIT_MS, isMissingExecutableError, type ChromiumInstaller } from "./install.ts";
import { Learning } from "./learning.ts";
import { pageCall } from "./page-script.ts";
import { CHECK_PASSING_RE, PAGE_RULES, type FocusInfo } from "./safety.ts";
import {
  cut,
  decideHeadless,
  findChrome,
  formatSize,
  isPrivateHost,
  launchArgs,
  proxyFromEnv,
  readSettings,
  resolveAddress,
  sanitizeFilename,
  sleep,
  ToolError,
  uniquePath,
  windowedUserAgent,
  withTimeout,
  WINDOW,
  type BrowserSettings,
  type ProxyConfig,
} from "./util.ts";

export { ToolError };

/** What a page gets of the window until it says (the toolbar takes the rest). */
export const VIEWPORT = { width: WINDOW.width, height: WINDOW.height - 87 };
const WATCH_TTL_MS = 30_000;
const FRAME_INTERVAL_MS = 100;
/** The longest one screencast step waits for a tab: one that stopped answering must not hold up the next tab. */
const CAST_STEP_MS = 2000;

/** Which browser to launch: Google Chrome by its path, or Playwright's full Chromium. */
type Engine = Pick<LaunchOptions, "executablePath" | "channel">;
const CHROMIUM: Engine = { channel: "chromium" };

export interface Classified {
  /** Activating it is an action with consequences: only browser_submit (approved by the user) does it. */
  submit: boolean;
  /** Why: "label" (buy, send, delete…), "form" (submits a form), "link" (a link that acts), "confirm" (the site confirms it). */
  reason: string;
  search: boolean;
  inForm: boolean;
  editable: boolean;
  tag: string;
  inputType: string;
  role: string;
  name: string;
  href: string;
}

export interface DownloadRecord {
  path: string;
  name: string;
  size: number;
  url: string;
}

interface Cast {
  page: Page;
  cdp: CDPSession;
  width: number;
  height: number;
  lastEmit: number;
  pending: string | null;
  timer: NodeJS.Timeout | null;
}

export class BrowserManager {
  ctx: PluginContext;
  settings: BrowserSettings;
  /** Installs Playwright's Chromium when it is missing (outside Docker); launches wait for it. */
  readonly installer: ChromiumInstaller;
  /** Google Chrome on this computer, launched instead of Playwright's Chromium (no download then). */
  readonly chrome: string | null;
  readonly downloadsDir: string;
  private readonly profileDir: string;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private active: Page | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private refSeq = 1;
  private lastUse = Date.now();
  private notes: string[] = [];
  /**
   * The tab each agent works in. Agents take turns in one browser: each keeps to its own page, so one reading news
   * cannot take the form another is filling (an upload approved for one site found the other on the page).
   */
  private agentTabs = new Map<string, Page>();
  /** A tab opened here for an agent of its own: not news for it ("a new tab opened"). */
  private openingOwnTab = false;
  /** A page asked for files (a file field was clicked) and nobody has answered yet. */
  private chooser: { page: Page; fc: FileChooser; at: number } | null = null;
  /** browser_upload is clicking something that opens a file chooser: that one is the tool's. */
  private chooserFor: ((fc: FileChooser) => void) | null = null;
  private downloadWaiters: Array<(r: { done: Promise<DownloadRecord> }) => void> = [];
  private acceptDialogs = false;
  private headlessMode: boolean | null = null;
  /** Each engine's own user agent without "Headless", found once per process. */
  private userAgents = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  // live view and takeover
  private watchers = new Map<string, number>();
  private cast: Cast | null = null;
  private castChain: Promise<void> = Promise.resolve();
  private inputCdp: { page: Page; cdp: CDPSession } | null = null;
  private inputChain: Promise<void> = Promise.resolve();
  private stateTimer: NodeJS.Timeout | null = null;
  private titles = new WeakMap<Page, string>();
  userControl = false;
  busy: string | null = null;
  /** The agent whose tool call is running (or ran last): tools.ts runs each handler inside `caller.run(agentId)`. */
  readonly caller = new AsyncLocalStorage<string>();
  private agentId: string | null = null;
  /** Every page the tabs land on (history.json in the data folder). */
  readonly history: HistoryStore;
  /** What the person does in the browser: demonstrations, hints for agents, the journal (learning.ts). */
  readonly learning: Learning;
  private tabIds = new WeakMap<Page, string>();
  private tabSeq = 0;
  /** Pages still loading, with the number of the navigation that loads them (a newer one takes over). */
  private loads = new WeakMap<Page, number>();
  private loadSeq = 0;
  private icons = new WeakMap<Page, { origin: string; icon: string }>();
  /** Main-frame navigation requests per tab, and how many the history has seen: none new means the same document. */
  private docRequests = new WeakMap<Page, { sent: number; seen: number }>();
  /** The person sent this tab somewhere from the live view (address bar, back, reload): where it lands is theirs. */
  private userAsked: { page: Page; at: number } | null = null;
  /** "user" or the agent that acted last: a page that moves by itself (a redirect, a script) counts for them. */
  private lastActor = "user";
  /** Our own isolated world in the active tab's main frame, for the touch checks (the page's scripts can not see it). */
  private touchWorld: { page: Page; contextId: number } | null = null;
  private focusTimer: NodeJS.Timeout | null = null;
  /** The last open/snapshot found a captcha: the live view asks the user to take over. */
  private captcha = false;
  private lastActivity = "";

  constructor(ctx: PluginContext) {
    const mgr = this;
    this.ctx = ctx;
    this.settings = readSettings(ctx.settings);
    this.chrome = findChrome(process.platform, process.env);
    this.installer = createChromiumInstaller({
      // With Google Chrome nothing is downloaded; if Chrome then fails to start, the launch installs Chromium itself.
      executables: () => (this.chrome ? [] : [chromium.executablePath()]),
      log: ctx.log,
      onChange: () => this.scheduleState(),
    });
    this.history = new HistoryStore({ file: join(ctx.dataDir, "history.json") });
    this.learning = new Learning(
      {
        ctx,
        settings: () => this.settings,
        get userControl() {
          return mgr.userControl;
        },
        setControl: (on) => this.setControl(on),
        inspect: (expression) => this.isolatedEval(expression),
        viewport: () => this.viewport(),
        activePage: () => this.activePage(),
        ensurePage: () => this.ensurePage(),
        titleOf: (p) => this.titleOf(p),
        titleNow: (p) => this.titles.get(p) ?? "",
        note: (text) => this.notes.push(text),
        watching: () => this.watching(),
        changed: () => this.scheduleState(),
      },
      ctx.dataDir,
    );
    this.downloadsDir = join(ctx.dataDir, "downloads");
    this.profileDir = join(ctx.dataDir, "profile");
    this.timers.push(setInterval(() => void this.tick(), 5_000));
    for (const t of this.timers) t.unref();
  }

  // ---------- settings and lifecycle ----------

  updateSettings(raw: Record<string, any>): void {
    const prev = this.settings;
    this.settings = readSettings(raw);
    if (this.context && prev.headless !== this.settings.headless && !this.busy && !this.userControl) {
      void this.close();
    }
  }

  get running(): boolean {
    return !!this.context;
  }

  /** Someone has the browser pane open (each viewer renews its watch every 20 s). */
  private watching(): boolean {
    const now = Date.now();
    for (const [id, until] of this.watchers) if (until <= now) this.watchers.delete(id);
    return this.watchers.size > 0;
  }

  /** The last viewer left: stop streaming and give control back to the agent. */
  private onWatchersGone(): void {
    // A demonstration waits for its viewer to come back (learning.tick ends it after a while).
    if (this.userControl && !this.learning.teaching) this.setControl(false);
    this.syncCast();
  }

  private async tick(): Promise<void> {
    if (this.watchers.size && !this.watching()) this.onWatchersGone();
    this.learning.tick();
    const idleMs = this.settings.idleMinutes * 60_000;
    if (this.context && !this.busy && !this.userControl && !this.watching() && Date.now() - this.lastUse > idleMs) {
      this.ctx.log.info(`closing the browser after ${this.settings.idleMinutes} min without use`);
      await this.close();
    }
  }

  touch(): void {
    this.lastUse = Date.now();
  }

  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.launching ??= this.launch().finally(() => (this.launching = null));
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    // Without Google Chrome, Playwright's Chromium may still be downloading (or missing): wait for that one install.
    if (!this.chrome) await this.installer.ensure(INSTALL_WAIT_MS);
    mkdirSync(this.profileDir, { recursive: true });
    mkdirSync(this.downloadsDir, { recursive: true });
    // A previous process (or container) may have left Chromium's profile lock behind; we are the only user of it.
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(this.profileDir, f), { force: true });
    const headless = decideHeadless(this.settings.headless, process.env, process.platform);
    const proxy = proxyFromEnv(process.env, this.settings.allowLocalNetwork);
    // Google Chrome when the computer has it, else Playwright's full Chromium (never its headless shell).
    let used = "Chromium";
    const open = async (h: boolean, engine: Engine) => {
      const c = await chromium.launchPersistentContext(this.profileDir, {
        ...engine,
        headless: h,
        // The window's own size, as in a person's browser (an emulated viewport makes the screen the page's size).
        viewport: null,
        acceptDownloads: true,
        ignoreDefaultArgs: ["--enable-automation"],
        ...(proxy ? { proxy } : {}),
        args: launchArgs({ headless: h, platform: process.platform, userAgent: h ? await this.userAgent(engine, proxy) : undefined, proxy: !!proxy }),
      });
      used = engine.executablePath ? "Google Chrome" : "Chromium";
      return c;
    };
    // Playwright still misses a browser file the installer's check did not know about: run the installer, retry once.
    const openChromium = async (h: boolean): Promise<BrowserContext> => {
      try {
        return await open(h, CHROMIUM);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!isMissingExecutableError(msg) || this.installer.disabled) throw e;
        this.ctx.log.warn(`Playwright cannot find a browser executable (${msg.split("\n")[0]}): running the installer`);
        await this.installer.ensure(INSTALL_WAIT_MS, true);
        return await open(h, CHROMIUM);
      }
    };
    const openOrInstall = async (h: boolean): Promise<BrowserContext> => {
      if (this.chrome) {
        try {
          return await open(h, { executablePath: this.chrome });
        } catch (e: any) {
          this.ctx.log.warn(`Google Chrome did not start (${String(e?.message ?? e).split("\n")[0]}): using Playwright's Chromium`);
        }
      }
      return openChromium(h);
    };
    let context: BrowserContext;
    try {
      context = await openOrInstall(headless);
      this.headlessMode = headless;
    } catch (e: any) {
      if (e instanceof ToolError) throw e;
      const msg = String(e?.message ?? e);
      if (isMissingExecutableError(msg)) {
        const off = this.installer.disabled ? ", and the automatic install is turned off (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)" : "";
        throw new ToolError(`Chromium is not installed (${msg.split("\n")[0]})${off}. On the server, run: npx playwright install chromium`, "noChromium");
      }
      if (!headless) {
        this.ctx.log.warn(`headed launch failed (${msg.split("\n")[0]}), falling back to headless`);
        context = await openOrInstall(true);
        this.headlessMode = true;
      } else {
        const detail = msg.split("\n")[0];
        throw new ToolError(`Could not start the browser: ${detail}`, "launch", { detail });
      }
    }
    this.ctx.log.info(`browser started (${used}, ${this.headlessMode ? "headless" : "headed"}${proxy ? ", via egress proxy" : ""})`);
    context.on("close", () => this.onContextClosed(context));
    context.on("page", (p) => {
      this.trackPage(p);
      if (this.context === context) {
        if (this.active && !this.active.isClosed() && this.busy && this.busy !== "tabs" && !this.openingOwnTab) this.note("A new tab opened and became active.");
        this.setActive(p);
      }
    });
    for (const p of context.pages()) this.trackPage(p);
    this.context = context;
    this.active = context.pages()[0] ?? (await context.newPage());
    this.scheduleState();
    this.syncCast();
    return context;
  }

  /**
   * What this engine calls itself with a window. Headless it says "HeadlessChrome" everywhere, workers included, and
   * only a launch flag changes that: ask a throwaway headless instance once (about:blank, no network).
   */
  private async userAgent(engine: Engine, proxy: ProxyConfig | undefined): Promise<string | undefined> {
    const key = engine.executablePath ?? String(engine.channel);
    const known = this.userAgents.get(key);
    if (known) return known;
    try {
      const b = await chromium.launch({ ...engine, headless: true, ...(proxy ? { proxy } : {}), args: ["--no-first-run"] });
      try {
        const ua = windowedUserAgent(await (await b.newPage()).evaluate(() => navigator.userAgent));
        this.userAgents.set(key, ua);
        return ua;
      } finally {
        await b.close().catch(() => {});
      }
    } catch (e: any) {
      // The real launch will report what is wrong; the browser still works, only less like a person's.
      this.ctx.log.warn(`could not read the browser's user agent: ${String(e?.message ?? e).split("\n")[0]}`);
      return undefined;
    }
  }

  /** The page's size in CSS pixels (there is no emulated viewport: it is what the window leaves). */
  async pageSize(page: Page): Promise<{ width: number; height: number }> {
    const vp = page.viewportSize();
    if (vp) return vp;
    return withTimeout(page.evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })"), CAST_STEP_MS).catch(() => VIEWPORT);
  }

  async close(): Promise<void> {
    const c = this.context;
    this.context = null;
    this.active = null;
    this.captcha = false;
    if (this.userControl) this.setControl(false);
    await this.stopCastNow();
    this.inputCdp = null;
    this.touchWorld = null;
    if (c) await withTimeout(c.close(), 10_000).catch(() => {});
    this.scheduleState();
  }

  async dispose(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.installer.dispose();
    await this.close();
    this.history.flush();
  }

  private onContextClosed(c: BrowserContext): void {
    if (this.context !== c) return;
    this.context = null;
    this.active = null;
    this.cast = null;
    this.inputCdp = null;
    this.touchWorld = null;
    this.captcha = false;
    if (this.userControl) this.setControl(false);
    this.scheduleState();
  }

  private trackPage(p: Page): void {
    p.on("dialog", (d) => void this.onDialog(d));
    // Listening takes the page's file dialog over (none would show in this browser): the person answers it in the
    // live view, an agent with browser_upload.
    p.on("filechooser", (fc) => this.onFileChooser(p, fc));
    p.on("download", (d) => this.onDownload(d));
    p.on("close", () => this.onPageClosed(p));
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) this.onNavigated(p);
    });
    p.on("load", () => void this.onLoaded(p));
    p.on("request", (r) => {
      if (!r.isNavigationRequest() || r.frame() !== p.mainFrame()) return;
      const d = this.docRequests.get(p) ?? { sent: 0, seen: 0 };
      d.sent++;
      this.docRequests.set(p, d);
    });
  }

  private tabId(p: Page): string {
    let id = this.tabIds.get(p);
    if (!id) this.tabIds.set(p, (id = String(++this.tabSeq)));
    return id;
  }

  /** Who sent the tab where it landed. */
  private actor(p: Page): string {
    if (this.userAsked?.page === p && Date.now() - this.userAsked.at < 30_000) return "user";
    if (this.userControl) return "user";
    if (this.busy) return this.agentId ?? "agent";
    return this.lastActor;
  }

  /** A tab landed on a page: a visit in the history, and the tab loads until the page has. */
  private onNavigated(p: Page): void {
    const url = p.url();
    const known = this.icons.get(p);
    if (known && known.origin !== originOf(url)) this.icons.delete(p);
    // No request since the last landing: the page rewrote its address itself (history.pushState / replaceState).
    const d = this.docRequests.get(p);
    const sameDocument = !!d && d.sent === d.seen;
    if (d) d.seen = d.sent;
    this.history.record({ url, by: this.actor(p), tab: this.tabId(p), icon: this.icons.get(p)?.icon, sameDocument });
    if (p === this.activePage()) this.learning.page(url, this.titles.get(p) ?? "");
    const n = this.beginLoad(p);
    // Resolves at once for a page that changed only its address (history.pushState).
    void p
      .waitForLoadState("load", { timeout: 60_000 })
      .catch(() => {})
      .finally(() => this.endLoad(p, n));
    this.scheduleState();
  }

  private beginLoad(p: Page): number {
    const n = ++this.loadSeq;
    this.loads.set(p, n);
    this.scheduleState();
    return n;
  }

  private endLoad(p: Page, n: number): void {
    if (this.loads.get(p) !== n) return;
    this.loads.delete(p);
    this.scheduleState();
  }

  /** The page has loaded: its title (titleOf gives it to the history) and the site's icon. */
  private async onLoaded(p: Page): Promise<void> {
    this.scheduleState();
    // A page that puts the cursor into a field by itself (a search page) opens the phone's keyboard too.
    if (this.userControl && p === this.activePage()) this.checkFocus();
    const url = p.url();
    const title = await this.titleOf(p);
    if (p === this.activePage()) this.learning.page(p.url(), title);
    if (!/^https?:/i.test(url)) return;
    const origin = originOf(url);
    const known = this.icons.get(p);
    const icon = known?.origin === origin ? known.icon : await this.iconOf(p, url);
    // The page may have rewritten its address meanwhile; the icon is still its site's.
    if (!icon || p.isClosed() || originOf(p.url()) !== origin) return;
    this.icons.set(p, { origin, icon });
    this.history.setIcon(p.url(), icon);
    this.scheduleState();
  }

  /**
   * The site's icon: the page's <link rel="icon"> (a locator, read in Playwright's isolated world, not the page's
   * own), else /favicon.ico. The live view shows it through the hub's image proxy.
   */
  private async iconOf(p: Page, url: string): Promise<string | undefined> {
    const href = await p
      .locator('link[rel~="icon" i]')
      .first()
      .getAttribute("href", { timeout: 1000 })
      .catch(() => null);
    try {
      const u = new URL(href?.trim() || "/favicon.ico", url);
      if (u.protocol === "data:" && /^data:image\//i.test(u.href) && u.href.length < 8000) return u.href;
      if ((u.protocol === "https:" || u.protocol === "http:") && u.href.length < 2000) return u.href;
      return new URL("/favicon.ico", url).href;
    } catch {
      return undefined;
    }
  }

  private onPageClosed(p: Page): void {
    for (const [id, tab] of this.agentTabs) if (tab === p) this.agentTabs.delete(id);
    if (this.active === p) {
      const rest = this.context?.pages().filter((x) => !x.isClosed()) ?? [];
      this.active = rest[rest.length - 1] ?? null;
      this.syncCast();
    }
    this.scheduleState();
  }

  setActive(p: Page): void {
    if (this.active === p) return;
    this.active = p;
    void p.bringToFront().catch(() => {});
    this.syncCast();
    this.scheduleState();
  }

  pages(): Page[] {
    return this.context?.pages().filter((p) => !p.isClosed()) ?? [];
  }

  activePage(): Page | null {
    return this.active && !this.active.isClosed() ? this.active : null;
  }

  /** The tab `agentId` works in: its own, or the active one when no other agent has it, or a new one. */
  private async pageFor(agentId: string | undefined): Promise<Page> {
    if (!agentId) return this.ensurePage();
    const context = await this.ensureContext();
    const own = this.agentTabs.get(agentId);
    if (own && !own.isClosed()) {
      this.setActive(own);
      return own;
    }
    const active = await this.ensurePage();
    if (![...this.agentTabs].some(([id, tab]) => id !== agentId && tab === active)) return active;
    this.openingOwnTab = true;
    try {
      const p = await context.newPage();
      this.setActive(p);
      return p;
    } finally {
      this.openingOwnTab = false;
    }
  }

  async ensurePage(): Promise<Page> {
    const context = await this.ensureContext();
    if (this.active && !this.active.isClosed()) return this.active;
    const rest = this.pages();
    const p = rest[rest.length - 1] ?? (await context.newPage());
    this.setActive(p);
    return p;
  }

  /** While an approved browser_submit runs, confirm() dialogs are part of the approved action and get accepted. */
  private onFileChooser(page: Page, fc: FileChooser): void {
    if (this.chooserFor) {
      this.chooserFor(fc);
      this.chooserFor = null;
      return;
    }
    this.chooser = { page, fc, at: Date.now() };
    if (this.userControl) {
      void fc
        .element()
        .getAttribute("accept")
        .catch(() => null)
        .then((accept) => this.ctx.ui.emit("filechooser", { open: true, multiple: fc.isMultiple(), accept: accept ?? "" }));
    } else {
      this.notes.push("The page opened a file chooser: to put a file there, call browser_upload with the file field's ref.");
    }
  }

  /** Where files to upload wait (the person's from the live view, an agent's from its workspace); a day at most. */
  uploadDir(): string {
    const root = join(this.ctx.dataDir, "uploads");
    mkdirSync(root, { recursive: true });
    for (const d of readdirSync(root)) {
      const p = join(root, d);
      if (Date.now() - statSync(p).mtimeMs > 86_400_000) rmSync(p, { recursive: true, force: true });
    }
    const dir = join(root, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(dir);
    return dir;
  }

  /** Save files to upload under their own names (made safe) in a fresh folder: their paths. */
  saveUploads(files: Array<{ name: string; data: Buffer }>): string[] {
    const dir = this.uploadDir();
    return files.map((f, i) => {
      const name = sanitizeFilename(f.name) || `file-${i + 1}`;
      const path = join(dir, files.slice(0, i).some((x) => sanitizeFilename(x.name) === name) ? `${i + 1}-${name}` : name);
      writeFileSync(path, f.data, { mode: 0o600 });
      return path;
    });
  }

  /** The person picked files in the live view for the page's file chooser (none: they cancelled it). */
  async answerChooser(files: Array<{ name: string; data: Buffer }>): Promise<{ ok: boolean; error?: string }> {
    const c = this.chooser;
    this.chooser = null;
    this.ctx.ui.emit("filechooser", { open: false });
    if (!c || c.page.isClosed()) return { ok: false, error: "no file field is waiting" };
    await c.fc.setFiles(files.length ? this.saveUploads(files) : []);
    if (files.length) this.learning.files(files.map((f) => f.name));
    this.scheduleState();
    return { ok: true };
  }

  /**
   * Put files into the file field `loc` (an <input type=file>, or a button or label that opens a file chooser).
   * The paths are the plugin's own copies.
   */
  async setFiles(loc: Locator, paths: string[]): Promise<void> {
    try {
      await loc.setInputFiles(paths, { timeout: 8000 });
      return;
    } catch (e: any) {
      if (!/not an? HTMLInputElement|Non-input element|is not an <input>|input\[type=file\]/i.test(String(e?.message ?? e))) throw e;
    }
    // Not the field itself: the page opens its file chooser when the control is clicked.
    const chosen = new Promise<FileChooser>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.chooserFor = null;
        reject(new ToolError("Clicking this element opened no file chooser. Use the ref of the file field (role file) from browser_snapshot."));
      }, 8000);
      this.chooserFor = (fc) => {
        clearTimeout(timer);
        resolve(fc);
      };
    });
    await loc.click({ timeout: 8000 });
    const fc = await chosen;
    await fc.setFiles(paths);
  }

  allowConfirmDialogs(on: boolean): void {
    this.acceptDialogs = on;
  }

  // ---------- notes: dialogs, downloads, new tabs ----------

  note(s: string): void {
    this.notes.push(s);
    if (this.notes.length > 10) this.notes.shift();
  }

  private async onDialog(d: Dialog): Promise<void> {
    const type = d.type();
    const msg = cut(d.message().replace(/\s+/g, " "), 200);
    try {
      if (type === "beforeunload") await d.accept();
      else if (this.acceptDialogs && type === "confirm") {
        await d.accept();
        this.note(`The page asked "${msg}": confirmed as part of the approved action.`);
      } else {
        await d.dismiss();
        this.note(type === "alert" ? `The page showed a message: "${msg}".` : `The page showed a ${type} dialog: "${msg}"; it was dismissed automatically.`);
      }
    } catch {
      /* dialog already handled */
    }
  }

  private onDownload(d: Download): void {
    const done = this.saveDownload(d);
    done.catch(() => {});
    const waiter = this.downloadWaiters.shift();
    if (waiter) {
      waiter({ done });
      return;
    }
    done.then(
      (r) => this.note(`Downloaded a file: ${r.path} (${formatSize(r.size)}).`),
      (e) => this.note(`Could not download a file: ${e.message}`),
    );
  }

  private async saveDownload(d: Download): Promise<DownloadRecord> {
    mkdirSync(this.downloadsDir, { recursive: true });
    const name = sanitizeFilename(d.suggestedFilename());
    const path = uniquePath(this.downloadsDir, name);
    await d.saveAs(path);
    const failure = await d.failure();
    if (failure) throw new Error(failure);
    const size = statSync(path).size;
    const max = this.settings.maxDownloadMb * 1024 * 1024;
    if (size > max) {
      rmSync(path, { force: true });
      throw new Error(`the file is larger than ${this.settings.maxDownloadMb} MB`);
    }
    return { path, name, size, url: d.url() };
  }

  /**
   * Resolves as soon as a download starts within `ms` (its `done` settles when the file is saved).
   * Register before triggering the download.
   */
  waitDownloadStart(ms: number): { started: Promise<{ done: Promise<DownloadRecord> }>; cancel: () => void } {
    let resolveFn!: (r: { done: Promise<DownloadRecord> }) => void;
    const started = new Promise<{ done: Promise<DownloadRecord> }>((resolve, reject) => {
      resolveFn = resolve;
      setTimeout(() => {
        const i = this.downloadWaiters.indexOf(resolveFn);
        if (i >= 0) {
          this.downloadWaiters.splice(i, 1);
          reject(new ToolError("The download did not start."));
        }
      }, ms).unref();
    });
    this.downloadWaiters.push(resolveFn);
    started.catch(() => {});
    return {
      started,
      cancel: () => {
        const i = this.downloadWaiters.indexOf(resolveFn);
        if (i >= 0) this.downloadWaiters.splice(i, 1);
      },
    };
  }

  // ---------- agent tool execution ----------

  /**
   * Run an agent tool: serialized, waits while the user controls the browser, appends notes and the page line.
   * `fn` returns the main text (or a full ToolResult, e.g. with an image).
   */
  async tool(name: string, fn: (page: Page) => Promise<string | ToolResult>): Promise<ToolResult> {
    const agentId = this.caller.getStore();
    const job = this.queue.then(() => this.runTool(name, fn, agentId));
    this.queue = job.catch(() => {});
    return job;
  }

  private async runTool(name: string, fn: (page: Page) => Promise<string | ToolResult>, agentId: string | undefined): Promise<ToolResult> {
    if (this.userControl) {
      const until = Date.now() + this.settings.takeoverWaitSec * 1000;
      while (this.userControl && Date.now() < until) await sleep(200);
      if (this.userControl) {
        return {
          content: [
            {
              type: "text",
              text: "The user is controlling the browser. Wait until they hand control back (a button in the browser's live view) and retry; ask the user if needed.",
            },
          ],
          isError: true,
        };
      }
    }
    this.touch();
    if (agentId) this.agentId = agentId;
    this.learning.agentUsed(this.agentId ?? undefined);
    this.userAsked = null;
    this.lastActor = this.agentId ?? "agent";
    this.busy = name;
    this.scheduleState();
    let result: ToolResult;
    try {
      const page = await this.pageFor(agentId);
      const before = { page, url: page.url(), pages: new Set(this.pages()) };
      const out = await fn(page);
      result = typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
      const blocked = await this.guardLanded(before);
      if (blocked) result = { content: [{ type: "text", text: blocked }], isError: true };
    } catch (e: any) {
      result = { content: [{ type: "text", text: friendlyError(e) }], isError: true };
    } finally {
      // Where the agent ended up (a tab it opened or switched to) is its tab from now on.
      const now = this.activePage();
      if (agentId && now) this.agentTabs.set(agentId, now);
      this.busy = null;
      this.touch();
      this.scheduleState();
    }
    const tail = [...this.drainNotes(), await this.pageLine()].filter(Boolean).join("\n");
    const texts = result.content.filter((c) => c.type === "text");
    if (texts.length) {
      const last = texts[texts.length - 1] as { type: "text"; text: string };
      last.text = `${last.text}\n${tail}`;
    } else {
      result.content.push({ type: "text", text: tail });
    }
    return result;
  }

  private drainNotes(): string[] {
    const n = this.notes;
    this.notes = [];
    return n;
  }

  async pageLine(): Promise<string> {
    const p = this.activePage();
    if (!p) return this.context ? "No open tabs." : "The browser is closed.";
    const title = await this.titleOf(p);
    const pages = this.pages();
    const tab = pages.length > 1 ? ` (tab ${pages.indexOf(p) + 1} of ${pages.length})` : "";
    return `Page: ${cut(title, 120) || "(untitled)"} — ${cut(p.url(), 300)}${tab}`;
  }

  async titleOf(p: Page): Promise<string> {
    const t = await withTimeout(p.title(), 1000).catch(() => this.titles.get(p) ?? "");
    this.titles.set(p, t);
    // Pages name themselves late (single-page apps): the history keeps the latest name. A tab on its way to another
    // page is "Loading <its address>" to Chrome while it still shows the old one: that is no page's name.
    if (t && !/^Loading [a-z][a-z\d+.-]*:/i.test(t)) this.history.setTitle(p.url(), t);
    return t;
  }

  /** Wait until the page settles after an action (navigation or SPA update), bounded. */
  async settle(maxMs = 2500): Promise<void> {
    const deadline = Date.now() + maxMs;
    await sleep(150);
    const p = this.activePage();
    if (!p) return;
    await p.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await p.waitForLoadState("networkidle", { timeout: Math.max(300, deadline - Date.now()) }).catch(() => {});
  }

  /** Agent navigation guard: no localhost / LAN unless allowed in settings. */
  guardUrl(u: URL): void {
    if (u.protocol === "about:") return;
    if (!this.settings.allowLocalNetwork && isPrivateHost(u.hostname)) {
      throw new ToolError(
        `${u.hostname} belongs to the local network or this server, so it is closed to the agent. ` +
          "The user can allow such addresses in the Browser plugin settings (allowLocalNetwork) or open the address themselves in the browser's live view.",
      );
    }
  }

  /** After a navigation: a public URL must not land on a local address through redirects. */
  /**
   * After an agent tool: if it navigated (link, redirect, popup) to a local address, leave that page and report.
   * Pages the user opened there himself are left alone.
   */
  private async guardLanded(before: { page: Page; url: string; pages: Set<Page> }): Promise<string | null> {
    if (this.settings.allowLocalNetwork) return null;
    const p = this.activePage();
    if (!p) return null;
    let u: URL;
    try {
      u = new URL(p.url());
    } catch {
      return null;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !isPrivateHost(u.hostname)) return null;
    const navigated = p === before.page ? p.url() !== before.url : !before.pages.has(p);
    if (!navigated) return null;
    if (p === before.page) await p.goto("about:blank").catch(() => {});
    else await p.close().catch(() => {});
    return `Navigation led to the local address ${u.hostname}, which is closed to the agent, so the page was left. The user can allow such addresses in the Browser plugin settings (allowLocalNetwork).`;
  }

  // ---------- page script helpers ----------

  async evalIn<T = any>(frame: Frame, op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const full = { rules: PAGE_RULES, seq: this.refSeq, ...args };
    const r = (await withTimeout(frame.evaluate(pageCall(op, full)), timeoutMs, "the page is not responding")) as any;
    if (r && typeof r === "object" && typeof r.seq === "number" && r.seq > this.refSeq) this.refSeq = r.seq;
    return r as T;
  }

  /**
   * A check that passes by itself (Cloudflare's "Just a moment") is up. Asked only from Playwright's isolated world
   * (title, selectors, text): a script of ours running in the page's own world stops such checks from passing.
   * `refused`: the site answered 403/429/498/503, so a page still without text is a check getting ready.
   */
  async passingCheck(page: Page, refused = false): Promise<boolean> {
    if (await page.locator("#challenge-form, #cf-challenge-running").count().catch(() => 0)) return true;
    const title = await page.title().catch(() => "");
    const body = (await page.locator("body").innerText({ timeout: 2000 }).catch(() => "")).trim();
    if (refused && !title && body.replace(/\W/g, "").length < 20) return true;
    return CHECK_PASSING_RE.test(`${title} ${body.slice(0, 1500)}`);
  }

  /** Find an element by ref in any frame of the page. */
  async locate(page: Page, ref: string): Promise<{ frame: Frame; loc: Locator }> {
    const r = String(ref ?? "").trim();
    if (!/^e\d+$/.test(r)) throw new ToolError(`Invalid ref "${cut(r, 40)}": use a ref from browser_snapshot, e.g. e12.`);
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const loc = frame.locator(`[data-owl-ref="${r}"]`);
      const n = await loc.count().catch(() => 0);
      if (n > 1) throw new ToolError(`Ref ${r} is ambiguous (the page duplicated the element). Call browser_snapshot and use the new refs.`);
      if (n === 1) return { frame, loc };
    }
    throw new ToolError(`Element ${r} was not found on the current page (it may have changed). Call browser_snapshot and use the new refs.`);
  }

  async classify(frame: Frame, ref: string): Promise<Classified> {
    const c = await this.evalIn<Classified | null>(frame, "classify", { ref });
    if (!c) throw new ToolError(`Element ${ref} was not found. Call browser_snapshot.`);
    return c;
  }

  /**
   * The focused element (assigns it a ref), or null when nothing is focused. When focus can not be inspected (inside
   * an iframe we can not reach, or the page does not answer), the answer is conservative: an editable field in a
   * form, so Enter there needs the user's approval.
   */
  async focusInfo(page: Page): Promise<FocusInfo | null> {
    const field: FocusInfo = { tag: "iframe", name: "", editable: true, inForm: true, search: false, submit: false };
    const main = await this.evalIn<any>(page.mainFrame(), "focus", {}, 3000).catch(() => undefined);
    // The page did not answer: whatever has focus, Enter or Space could activate it.
    if (!main) return { ...field, tag: "unknown", submit: true };
    if (main.none) return null;
    if (!main.frame) return main;
    for (const frame of page.frames().slice(1)) {
      if (frame.isDetached()) continue;
      const r = await this.evalIn<any>(frame, "focus", {}, 3000).catch(() => null);
      if (r && !r.frame && !r.none) return r;
    }
    return field;
  }

  // ---------- live view and takeover (driven by the UI) ----------

  onUiMessage(m: any): void {
    if (!m || typeof m !== "object") return;
    const run = (f: () => Promise<unknown>) =>
      void f().catch((e) => {
        this.ctx.log.warn(`ui ${m.type}: ${e?.message ?? e}`);
        this.ctx.ui.emit("error", describeError(e));
      });
    switch (m.type) {
      case "watch": {
        const id = typeof m.id === "string" && m.id ? m.id.slice(0, 64) : "default";
        if (m.on === false) {
          const had = this.watchers.delete(id);
          if (had && !this.watching()) this.onWatchersGone();
        } else {
          const first = !this.watching();
          this.watchers.set(id, Date.now() + WATCH_TTL_MS);
          if (first || m.refresh) void this.emitState();
          this.syncCast(first || !!m.refresh);
        }
        return;
      }
      case "start":
        this.touch();
        return run(() => this.ensurePage());
      case "navigate":
        this.touch();
        return run(async () => {
          // The user is trusted: no local-network guard here, only the http(s) scheme check. Words are searched for.
          const u = resolveAddress(String(m.text ?? m.url ?? ""), this.settings.searchEngine);
          const page = m.newTab ? await (await this.ensureContext()).newPage() : await this.ensurePage();
          this.setActive(page);
          await this.userGoto(page, () => page.goto(u.href, { waitUntil: "domcontentloaded", timeout: 30_000 }));
        });
      case "back":
      case "forward":
      case "reload":
        this.touch();
        return run(async () => {
          const page = this.activePage();
          if (!page) return;
          await this.userGoto(page, () =>
            m.type === "back" ? page.goBack({ timeout: 15_000 }) : m.type === "forward" ? page.goForward({ timeout: 15_000 }) : page.reload({ timeout: 30_000 }),
          );
        });
      case "stop":
        return run(async () => {
          const page = this.activePage();
          if (!page) return;
          await (await this.inputSession())?.send("Page.stopLoading");
          this.loads.delete(page);
          this.scheduleState();
        });
      case "tab":
        this.touch();
        return run(async () => {
          const pages = this.pages();
          const idx = Number(m.index) - 1;
          if (m.action === "new" || m.action === "switch" || m.action === "close") this.learning.tab(m.action);
          if (m.action === "new") this.setActive(await (await this.ensureContext()).newPage());
          else if (m.action === "switch" && pages[idx]) this.setActive(pages[idx]);
          else if (m.action === "close" && (pages[idx] ?? this.activePage())) await (pages[idx] ?? this.activePage())!.close();
        });
      case "control":
        this.setControl(!!m.on);
        return;
      case "input": {
        if (!this.userControl) return;
        this.touch();
        // One at a time and in order: the recorder looks at what is under the pointer before a press reaches the page,
        // and a release must not overtake its press meanwhile.
        const work = async () => {
          await this.learning.beforeInput(m);
          await this.dispatchInput(m);
          // A click or Tab may have moved the focus into (or out of) a text field: the phone's keyboard follows it.
          if ((m.event === "mouse" && m.action === "up") || (m.event === "key" && m.action === "up" && (m.key === "Tab" || m.key === "Enter"))) this.checkFocus();
        };
        // One stuck input (a page that hangs) must not hold up the ones after it.
        const job = this.inputChain.then(() => withTimeout(work(), 5000));
        this.inputChain = job.catch(() => {});
        return run(() => job);
      }
      case "probe":
        // A finger is down on the picture: is it on a text field? The answer has to come before it lifts, because
        // iOS shows the keyboard only inside the touch.
        if (!this.userControl) return;
        return run(async () => {
          const { w, h } = this.viewport();
          const editable = await this.isolatedEval<boolean | null>(probeScript(clamp01(m.x) * w, clamp01(m.y) * h));
          this.ctx.ui.emit("probe", { id: m.id, seq: m.seq, editable: editable ?? null });
        });
      case "teach":
        // The live view's Teach (for the default agent), Done and Cancel.
        if (m.action === "start") return run(async () => void (await this.learning.start({ goal: "" })));
        if (m.action === "done" || m.action === "cancel") return run(() => this.learning.finish(m.action));
        return;
      case "highlight":
        return run(() => this.learning.highlight(m));
      case "state":
        void this.emitState();
        return;
      case "activity":
        this.emitActivity(true);
        return;
    }
  }

  /** A navigation the person asked for in the live view: theirs in the history, the tab loading until it lands. */
  private async userGoto(page: Page, go: () => Promise<unknown>): Promise<void> {
    this.userAsked = { page, at: Date.now() };
    this.lastActor = "user";
    const n = this.beginLoad(page);
    try {
      await go();
    } catch (e: any) {
      // Stopped, or another navigation took over: nothing went wrong.
      if (/net::ERR_ABORTED|interrupted by another navigation/i.test(String(e?.message ?? e))) return;
      throw e;
    } finally {
      this.endLoad(page, n);
    }
  }

  setControl(on: boolean): void {
    if (this.userControl === on) return;
    this.userControl = on;
    if (on) {
      this.lastActor = "user";
      this.checkFocus();
    }
    // The user is on it: the request to take over is answered.
    if (on) this.captcha = false;
    this.ctx.log.info(on ? "user took control of the browser" : "user returned control to the agent");
    this.learning.onControl(on);
    this.ctx.ui.emit("control", { user: on });
    this.emitActivity();
    void this.emitState();
  }

  /** open / snapshot report whether the page shows a captcha (the live view then asks the user for help). */
  setCaptcha(on: boolean): void {
    if (this.captcha === on) return;
    this.captcha = on;
    this.emitActivity();
  }

  /** Tell the live view whether a text field has the focus now (null: inside a frame of another site). */
  private checkFocus(): void {
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      if (!this.userControl) return;
      void this.isolatedEval<boolean | null>(FOCUS_SCRIPT)
        .then((editable) => this.ctx.ui.emit("focus", { editable: editable ?? null }))
        .catch(() => {});
    }, 150);
  }

  /** Evaluate in our isolated world of the active tab (created again after the page navigates). */
  private async isolatedEval<T>(expression: string): Promise<T | null> {
    const page = this.activePage();
    const cdp = await this.inputSession();
    if (!page || !cdp) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let world = this.touchWorld;
      if (world?.page !== page) {
        const { frameTree } = await cdp.send("Page.getFrameTree");
        const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "piomio-touch" });
        world = this.touchWorld = { page, contextId: executionContextId };
      }
      try {
        const r = await withTimeout(cdp.send("Runtime.evaluate", { expression, contextId: world.contextId, returnByValue: true }), 2000);
        return r.exceptionDetails ? null : (r.result.value as T);
      } catch {
        // The page navigated and took the world with it.
        this.touchWorld = null;
      }
    }
    return null;
  }

  private viewport(): { w: number; h: number } {
    if (this.cast) return { w: this.cast.width, h: this.cast.height };
    const vp = this.activePage()?.viewportSize();
    return { w: vp?.width ?? VIEWPORT.width, h: vp?.height ?? VIEWPORT.height };
  }

  private async inputSession(): Promise<CDPSession | null> {
    const page = this.activePage();
    if (!page || !this.context) return null;
    if (this.cast?.page === page) return this.cast.cdp;
    if (this.inputCdp?.page === page) return this.inputCdp.cdp;
    void this.inputCdp?.cdp.detach().catch(() => {});
    const cdp = await this.context.newCDPSession(page);
    this.inputCdp = { page, cdp };
    return cdp;
  }

  async dispatchInput(m: any): Promise<void> {
    const cdp = await this.inputSession();
    if (!cdp) return;
    const { w, h } = this.viewport();
    const x = clamp01(m.x) * w;
    const y = clamp01(m.y) * h;
    const modifiers = modifierMask(m);
    switch (m.event) {
      case "mouse": {
        const type = ({ down: "mousePressed", up: "mouseReleased", move: "mouseMoved" } as const)[m.action as "down" | "up" | "move"];
        if (!type) return;
        const button = ["left", "middle", "right", "back", "forward"].includes(m.button) ? m.button : type === "mouseMoved" ? "none" : "left";
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button,
          buttons: Number.isInteger(m.buttons) ? m.buttons : undefined,
          clickCount: type === "mouseMoved" ? 0 : Math.min(3, Math.max(1, Number(m.clickCount) || 1)),
          modifiers,
        });
        return;
      }
      case "wheel":
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: clampAbs(Number(m.deltaX) || 0, 5000),
          deltaY: clampAbs(Number(m.deltaY) || 0, 5000),
          modifiers,
        });
        return;
      case "key": {
        const params = keyEventParams(m, modifiers);
        if (params) await cdp.send("Input.dispatchKeyEvent", params);
        return;
      }
      case "text": {
        const text = String(m.text ?? "").slice(0, 10_000);
        if (text) await cdp.send("Input.insertText", { text });
        return;
      }
    }
  }

  /**
   * Start/stop/move the screencast to match "someone is watching" and the active tab. Serialized.
   * `refresh` sends a still frame right away (a new viewer would otherwise wait for the next repaint).
   */
  syncCast(refresh = false): void {
    this.castChain = this.castChain.then(() => this.syncCastNow(refresh)).catch((e) => this.ctx.log.warn(`screencast: ${e?.message ?? e}`));
  }

  private emitFrame(cast: Cast, data: string): void {
    cast.lastEmit = Date.now();
    this.ctx.ui.emit("frame", { data, width: cast.width, height: cast.height, url: cast.page.url(), title: this.titles.get(cast.page) ?? "" });
  }

  /** At most one frame per FRAME_INTERVAL_MS to the UI; the trailing frame is always delivered. */
  private flushFrame(cast: Cast): void {
    if (cast.timer) return;
    const wait = Math.max(0, cast.lastEmit + FRAME_INTERVAL_MS - Date.now());
    cast.timer = setTimeout(() => {
      cast.timer = null;
      if (this.cast !== cast || !cast.pending) return;
      const data = cast.pending;
      cast.pending = null;
      this.emitFrame(cast, data);
    }, wait);
  }

  private async syncCastNow(refresh: boolean): Promise<void> {
    const page = this.activePage();
    const want = this.watching() && !!this.context && !!page;
    if (!want) return this.stopCastNow();
    if (this.cast?.page !== page) {
      await this.stopCastNow();
      const cdp = await castStep(this.context!.newCDPSession(page!), (late) => void late.detach().catch(() => {}));
      const vp = await this.pageSize(page!);
      const cast: Cast = { page: page!, cdp, width: vp.width, height: vp.height, lastEmit: 0, pending: null, timer: null };
      this.cast = cast;
      cdp.on("Page.screencastFrame", (f) => {
        // Ack at once: Chrome does not resend a repaint it skipped while waiting for an ack, so a throttled ack
        // would leave the viewer on a stale picture. Throttling happens on our side, latest frame wins.
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        if (this.cast !== cast) return;
        cast.width = Math.round(f.metadata.deviceWidth) || cast.width;
        cast.height = Math.round(f.metadata.deviceHeight) || cast.height;
        cast.pending = f.data;
        this.flushFrame(cast);
      });
      // Page domain events (screencastFrame) are only delivered to sessions that enabled the domain.
      await castStep(cdp.send("Page.enable"));
      // everyNthFrame 1: with 2, a single repaint (one typed letter) can be skipped and never shown.
      await castStep(cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 }));
      refresh = true;
    }
    // Chrome only sends screencast frames on repaint: a static page would show nothing until it changes.
    const cast = this.cast;
    if (refresh && cast) {
      const shot = await castStep(cast.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 50 })).catch(() => null);
      if (shot && this.cast === cast) this.emitFrame(cast, shot.data);
    }
  }

  private async stopCastNow(): Promise<void> {
    const c = this.cast;
    this.cast = null;
    if (!c) return;
    if (c.timer) clearTimeout(c.timer);
    // A tab that stopped answering (a page stuck loading or spinning) never answers these either: the next tab does not
    // wait for them, or every switch after it would keep showing this tab's last picture.
    void castStep(c.cdp.send("Page.stopScreencast"))
      .catch(() => {})
      .finally(() => void c.cdp.detach().catch(() => {}));
  }

  /**
   * "activity" event for the live view (whether an agent works in the browser, who, where, whether it needs the user),
   * sent on every change whether or not anyone watches: the UI opens the live view on it. Cheap and deduplicated.
   */
  emitActivity(force = false): void {
    const activity = {
      running: !!this.context,
      busy: this.busy,
      agentId: this.agentId,
      url: this.activePage()?.url() ?? "",
      control: this.userControl ? "user" : "agent",
      // A demonstration needs the person: the live view pops up for it.
      attention: (this.captcha && !!this.context) || this.learning.teaching,
      teach: this.learning.teaching,
    };
    const key = JSON.stringify(activity);
    if (!force && key === this.lastActivity) return;
    this.lastActivity = key;
    this.ctx.ui.emit("activity", activity);
  }

  /** Debounced "state" event for the UI (only while someone watches); "activity" goes out at once. */
  scheduleState(): void {
    this.emitActivity();
    if (!this.watching()) return;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.emitState();
    }, 150);
  }

  async emitState(): Promise<void> {
    const pages = this.pages();
    const active = this.activePage();
    const tabs = await Promise.all(
      pages.map(async (p, i) => {
        const url = p.url();
        const icon = this.icons.get(p);
        return {
          index: i + 1,
          title: cut(await this.titleOf(p), 80),
          url,
          active: p === active,
          loading: this.loads.has(p),
          icon: icon?.origin === originOf(url) ? icon.icon : undefined,
        };
      }),
    );
    this.ctx.ui.emit("state", {
      running: !!this.context,
      headless: this.headlessMode,
      control: this.userControl ? "user" : "agent",
      busy: this.busy,
      tabs,
      url: active?.url() ?? "",
      title: active ? (this.titles.get(active) ?? "") : "",
      loading: !!active && this.loads.has(active),
      ...(active ? await this.navState() : { canGoBack: false, canGoForward: false }),
      searchEngine: this.settings.searchEngine,
      install: this.installer.status(),
      teach: this.learning.state(),
    });
  }

  /** Whether the active tab has pages to go back and forward to. */
  private async navState(): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    try {
      const cdp = await this.inputSession();
      if (!cdp) throw new Error("no page");
      const h = await withTimeout(cdp.send("Page.getNavigationHistory"), 1000);
      // A tab opened for a page starts on about:blank: going back there is not going back anywhere.
      const first = h.entries[0]?.url === "about:blank" ? 1 : 0;
      return { canGoBack: h.currentIndex > first, canGoForward: h.currentIndex < h.entries.length - 1 };
    } catch {
      return { canGoBack: true, canGoForward: true };
    }
  }
}

// ---------- helpers ----------

/** Is this element one the keyboard types into? (Source text for the isolated world.) */
const EDITABLE = `(el) => {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
  if (el.tagName !== "INPUT" || el.disabled || el.readOnly) return false;
  return /^(text|search|email|url|tel|password|number)$/i.test(el.type || "text");
}`;

/** What is under the point (CSS px): a text field (true), something else (false), a frame of another site (null). */
function probeScript(x: number, y: number): string {
  return `(() => {
  const editable = ${EDITABLE};
  let doc = document, x = ${x.toFixed(1)}, y = ${y.toFixed(1)};
  for (let depth = 0; depth < 8; depth++) {
    let el = doc.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el) return false;
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument; } catch {}
      if (!inner) return null;
      const r = el.getBoundingClientRect();
      x -= r.left + el.clientLeft;
      y -= r.top + el.clientTop;
      doc = inner;
      continue;
    }
    const label = el.closest("label");
    return editable(el) || (!!label && editable(label.control));
  }
  return null;
})()`;
}

/** Does a text field have the focus (null: a frame of another site has it)? */
const FOCUS_SCRIPT = `(() => {
  const editable = ${EDITABLE};
  let el = document.activeElement;
  for (let depth = 0; depth < 8 && el; depth++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument; } catch {}
      if (!inner) return null;
      el = inner.activeElement;
      continue;
    }
    break;
  }
  return editable(el);
})()`;

/** A screencast step bounded by CAST_STEP_MS; what it brings after that goes to `late` (a session to let go of). */
function castStep<T>(p: Promise<T>, late?: (value: T) => void): Promise<T> {
  let gaveUp = false;
  if (late) void p.then((v) => gaveUp && late(v), () => {});
  return withTimeout(p, CAST_STEP_MS, "the tab is not answering").catch((e) => {
    gaveUp = true;
    throw e;
  });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function clampAbs(n: number, max: number): number {
  return Math.max(-max, Math.min(max, n));
}

function modifierMask(m: any): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

const SPECIAL_KEYS: Record<string, [number, string?]> = {
  Enter: [13, "\r"],
  Tab: [9],
  Backspace: [8],
  Escape: [27],
  Delete: [46],
  Insert: [45],
  Home: [36],
  End: [35],
  PageUp: [33],
  PageDown: [34],
  ArrowLeft: [37],
  ArrowUp: [38],
  ArrowRight: [39],
  ArrowDown: [40],
  Shift: [16],
  Control: [17],
  Alt: [18],
  Meta: [91],
  CapsLock: [20],
  ContextMenu: [93],
};
for (let i = 1; i <= 12; i++) SPECIAL_KEYS[`F${i}`] = [111 + i];

/** UI keyboard event → CDP Input.dispatchKeyEvent params. */
export function keyEventParams(m: any, modifiers: number, platform: NodeJS.Platform = process.platform): any | null {
  const key = String(m.key ?? "");
  if (!key || key.length > 32) return null;
  const code = String(m.code ?? "");
  const special = SPECIAL_KEYS[key];
  const printable = [...key].length === 1;
  const vk = special?.[0] ?? (Number.isInteger(m.keyCode) && m.keyCode > 0 ? m.keyCode : printable ? key.toUpperCase().charCodeAt(0) : 0);
  // Ctrl/Meta shortcuts do not insert text (AltGr = Ctrl+Alt does).
  const shortcut = (modifiers & 4) !== 0 || ((modifiers & 2) !== 0 && (modifiers & 1) === 0);
  const text = shortcut ? undefined : (special?.[1] ?? (printable ? key : undefined));
  // The native key code is the Windows one only on Windows. Chrome on a Mac reads it as a Mac key code, and the
  // Shift of a capital letter (16, the Mac's Y) then opened chrome://settings/help.
  const base = { key, code, windowsVirtualKeyCode: vk, ...(platform === "win32" ? { nativeVirtualKeyCode: vk } : {}), modifiers };
  if (m.action === "up") return { ...base, type: "keyUp" };
  return { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text, autoRepeat: !!m.repeat };
}

/**
 * An error for the model (`message`, English) and for the browser pane (`code` + `params`, shown as ui.error.<code>).
 * Playwright errors are long (call logs): keep the first line and explain the common cases.
 */
export function describeError(e: any): { message: string; code: string; params: Record<string, string> } {
  if (e instanceof ToolError) return { message: e.message, code: e.code ?? "other", params: e.params ?? { detail: e.message } };
  const msg = String(e?.message ?? e);
  const first = msg.split("\n")[0].replace(/^\w+\.\w+:\s*/, "");
  const out = (code: string, message: string, params: Record<string, string> = {}) => ({ message, code, params });
  if (/intercepts pointer events/.test(msg)) {
    return out("covered", "The element is covered by another element (a banner, popup or dialog). Close it or scroll the page and try again.");
  }
  if (/Target page, context or browser has been closed|Target closed/i.test(msg)) return out("closed", "The tab or the browser was closed.");
  if (/Timeout \d+ms exceeded|timeout/i.test(first)) return out("timeout", `Timed out: ${cut(first, 200)}`, { detail: cut(first, 200) });
  if (/net::ERR_NAME_NOT_RESOLVED/.test(msg)) return out("dns", "Site not found (DNS error). Check the address.");
  if (/net::ERR_TUNNEL_CONNECTION_FAILED|net::ERR_PROXY|407/.test(msg)) {
    return out("proxy", "The hub's proxy refused the connection (the site is closed to the browser or the proxy is unavailable).");
  }
  if (/net::ERR_/.test(msg)) return out("net", `Could not open the page: ${cut(first, 200)}`, { detail: cut(first, 200) });
  return out("other", `Error: ${cut(first, 300)}`, { detail: cut(first, 300) });
}

/** Error text for the model. */
export function friendlyError(e: any): string {
  return describeError(e).message;
}
