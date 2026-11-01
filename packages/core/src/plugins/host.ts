// Plugin host: discovers plugins, spawns their server processes, routes RPC, enforces permissions.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, cpSync, rmSync, renameSync, statSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Catalog, CatalogEntryState, CoreMethod, Locale, MessagePart, PiomioManifest, PluginLayout, PluginPermissions, ToolCallContext, ToolDescriptor, ToolResult, ToolSpec } from "@piomio/shared";
import { createRpcPeer, ndjsonTransport, readPluginLayout, toolPrefixOf, nowIso, ENTRY_ID_RE, type RpcPeer } from "@piomio/shared";
import { json, type Db } from "../db.ts";
import { hubLocale, localizePluginValue, LocalizedError, tFor } from "../i18n.ts";
import type { Config } from "../config.ts";
import type { EventBus, BusEventName } from "../bus.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { HookRegistry, HookName } from "../hooks.ts";
import type { VaultService } from "../vault/service.ts";
import type { AuditLog } from "../audit.ts";
import type { EgressProxy } from "../egress.ts";
import { npmEnv, npmInvocation, withPath } from "../cli-tools.ts";
import { linkUserKeychains } from "./keychains.ts";
import { compilePluginUi } from "./ui-compile.ts";

/**
 * What model access through plain API keys means for the builtin plugins (Config.apiKeys): without it the API brain
 * is not loaded at all (its id stays the hub's), and Codex gets neither the OpenAI key nor the setting that names it.
 */
export const HELD_BACK_WITHOUT_KEYS: readonly string[] = ["brain-api"];
const KEY_PARTS: Record<string, { vault: string[]; settings: string[] }> = { "brain-codex": { vault: ["openai_api_key"], settings: ["apiKeyRef"] } };

/** A builtin layout without its key parts: those vault items out of its permissions, those settings out of its form. */
function withoutKeys(layout: PluginLayout): PluginLayout {
  const parts = KEY_PARTS[layout.manifest.id];
  if (!parts) return layout;
  const m = layout.manifest;
  const settings = m.contributes?.settings as { properties?: Record<string, unknown> } | undefined;
  const properties = settings?.properties ? Object.fromEntries(Object.entries(settings.properties).filter(([k]) => !parts.settings.includes(k))) : undefined;
  return {
    ...layout,
    manifest: {
      ...m,
      permissions: { ...m.permissions, vault: m.permissions.vault.filter((v) => !parts.vault.includes(v)) },
      ...(m.contributes && properties ? { contributes: { ...m.contributes, settings: { ...settings, properties } } } : {}),
    },
  };
}

export type PluginStatus = "stopped" | "starting" | "running" | "crashed" | "disabled" | "no-server" | "error";

export interface PluginRecord {
  id: string;
  dir: string;
  source: "builtin" | "installed";
  enabled: boolean;
  granted: PluginPermissions;
  /** Vault items granted by the user in the security console, on top of the manifest. */
  extraVault: string[];
  commitHash?: string;
  settings: Record<string, unknown>;
  layout?: PluginLayout;
  status: PluginStatus;
  lastError?: string;
  logs: Array<{ ts: string; level: string; msg: string }>;
}

export interface BrainSink {
  registerPluginBrain(brainId: string, label: string, pluginId: string, peer: RpcPeer, variants?: string[], login?: boolean): void;
  unregisterPlugin(pluginId: string): void;
}

export interface ChannelSink {
  register(channelId: string, label: string, pluginId: string, peer: RpcPeer): void;
  unregisterPlugin(pluginId: string): void;
}

export interface HostDeps {
  config: Config;
  db: Db;
  bus: EventBus;
  tools: ToolRegistry;
  hooks: HookRegistry;
  vault: VaultService;
  audit: AuditLog;
  egress: EgressProxy;
  brains: BrainSink;
  channels: ChannelSink;
  coreCall: (pluginId: string, method: CoreMethod, params: any) => Promise<unknown>;
  /** Called after plugin set changes (skills/agents/mcp roots need re-indexing). */
  onLayoutsChanged: () => void;
  /** Directories of CLIs the hub installed itself; brain hosts find them after the system PATH. */
  cliBinDirs?: () => string[];
  /** Add a card to the reply the agent is writing (SessionRunner.attachPart): plugins' widgets go there. */
  attachPart?: (conversationId: string, part: MessagePart) => void;
  /** A plugin reported its catalog entries (ctx.catalog.update): what they were before and are now. */
  onCatalogUpdated?: (pluginId: string, before: CatalogEntryState[], after: CatalogEntryState[]) => void;
}

/** Entries one plugin may report, at most. */
const MAX_CATALOG_ENTRIES = 200;
const ENTRY_STATUSES = new Set(["connected", "needs-setup", "broken"]);

/** A plugin's report of its catalog entries, kept to what the catalog can show: bad entries are dropped. */
export function cleanCatalogReport(entries: unknown): CatalogEntryState[] {
  const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const out: CatalogEntryState[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(entries) ? entries : []) {
    const id = typeof e?.id === "string" ? e.id : "";
    if (!ENTRY_ID_RE.test(id) || seen.has(id) || !ENTRY_STATUSES.has(e.status) || (e.connect !== "setup" && e.connect !== "signin")) continue;
    seen.add(id);
    const entry: CatalogEntryState = { id, status: e.status, connect: e.connect };
    for (const k of ["name", "summary", "category", "icon", "example", "account", "detail"] as const) {
      const v = str(e[k], k === "summary" || k === "detail" || k === "example" ? 400 : 80);
      if (v) entry[k] = v;
    }
    out.push(entry);
    if (out.length >= MAX_CATALOG_ENTRIES) break;
  }
  return out;
}

/** A widget's data as stored in the conversation, at most. */
export const MAX_WIDGET_BYTES = 64 * 1024;
/** Widgets one tool call can show. */
const MAX_WIDGETS_PER_CALL = 4;

interface Running {
  child: ChildProcess;
  peer: RpcPeer;
  stopping: boolean;
  unsubs: Array<() => void>;
}

export interface InstallPreview {
  stagingId: string;
  manifest: PiomioManifest;
  formats: PluginLayout["formats"];
  permissions: PluginPermissions;
  commitHash?: string;
  warnings: string[];
  hasServer: boolean;
  hasUi: boolean;
}

const MAX_LOGS = 300;

export class PluginHost {
  d: HostDeps;
  records = new Map<string, PluginRecord>();
  private running = new Map<string, Running>();
  private crashes = new Map<string, number[]>();
  private httpPlugins = new Set<string>();
  private uiMessageTargets = new Set<string>();
  private staging = new Map<string, { dir: string; commitHash?: string; layout: PluginLayout; source: string }>();
  /** What each running plugin last reported about its catalog entries. */
  private catalogs = new Map<string, CatalogEntryState[]>();

  constructor(deps: HostDeps) {
    this.d = deps;
  }

  get installedDir(): string {
    return join(this.d.config.dataDir, "plugins");
  }

  dataDirOf(id: string): string {
    return join(this.d.config.dataDir, "plugins-data", id);
  }

  // ---------- discovery ----------

  discover(): void {
    const seen = new Set<string>();
    const consider = (dir: string, source: "builtin" | "installed") => {
      let layout: PluginLayout;
      try {
        layout = readPluginLayout(dir);
      } catch (e) {
        console.error(`[plugins] skip ${dir}: ${(e as Error).message}`);
        return;
      }
      const id = layout.manifest.id;
      if (source === "builtin" && !this.d.config.apiKeys) {
        if (HELD_BACK_WITHOUT_KEYS.includes(id)) {
          seen.add(id);
          return;
        }
        layout = withoutKeys(layout);
      }
      if (seen.has(id)) {
        console.error(`[plugins] duplicate plugin id ${id} in ${dir}, skipped`);
        return;
      }
      seen.add(id);
      const row = this.d.db.prepare("select * from plugins where id = ?").get(id) as any;
      if (!row) {
        if (source === "installed") {
          console.error(`[plugins] ${dir} has no install record; ignored (install it through the UI)`);
          return;
        }
        // Catalog plugins (defaultEnabled: false) ship turned off: the person turns them on when they want them.
        this.d.db
          .prepare("insert into plugins(id, dir, source, enabled, granted, commit_hash, installed_at, settings) values (?,?,?,?,?,?,?,?)")
          .run(id, dir, source, layout.manifest.defaultEnabled ? 1 : 0, JSON.stringify(layout.manifest.permissions), null, nowIso(), "{}");
      } else if (source === "builtin") {
        // Builtin plugins always get their declared permissions (they ship with the hub).
        this.d.db.prepare("update plugins set dir = ?, granted = ? where id = ?").run(dir, JSON.stringify(layout.manifest.permissions), id);
      }
      const r = this.d.db.prepare("select * from plugins where id = ?").get(id) as any;
      const prev = this.records.get(id);
      this.records.set(id, {
        id,
        dir,
        source,
        enabled: !!r.enabled,
        granted: json<PluginPermissions>(r.granted, layout.manifest.permissions),
        extraVault: json<string[]>(r.extra_vault, []).filter((v) => this.d.config.apiKeys || source !== "builtin" || !KEY_PARTS[id]?.vault.includes(v)),
        commitHash: r.commit_hash ?? undefined,
        settings: json(r.settings, {}),
        layout,
        status: prev?.status ?? (layout.serverEntry ? "stopped" : "no-server"),
        lastError: prev?.lastError,
        logs: prev?.logs ?? [],
      });
    };
    const scan = (root: string, source: "builtin" | "installed") => {
      if (!existsSync(root)) return;
      for (const d of readdirSync(root)) {
        // "_template" and the like are not plugins.
        if (d.startsWith(".") || d.startsWith("_")) continue;
        const dir = join(root, d);
        if (!statSync(dir).isDirectory()) continue;
        consider(dir, source);
      }
    };
    for (const root of this.d.config.builtinPluginsDirs) scan(root, "builtin");
    mkdirSync(this.installedDir, { recursive: true });
    scan(this.installedDir, "installed");
    this.d.onLayoutsChanged();
  }

  list(): PluginRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id);
  }

  enabledLayouts(): PluginLayout[] {
    return this.list()
      .filter((r) => r.enabled && r.layout)
      .map((r) => r.layout!);
  }

  // ---------- lifecycle ----------

  async startAll(filter: Config["plugins"]): Promise<void> {
    const ids = this.list()
      .filter((r) => r.enabled && r.layout?.serverEntry)
      .map((r) => r.id)
      .filter((id) => filter === "all" || (Array.isArray(filter) && filter.includes(id)));
    await Promise.all(ids.map((id) => this.start(id).catch((e) => console.error(`[plugins] ${id} failed to start:`, e.message))));
  }

  async start(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec || !rec.layout) throw new Error(`unknown plugin ${id}`);
    if (!rec.enabled) {
      rec.status = "disabled";
      return;
    }
    if (!rec.layout.serverEntry) {
      rec.status = "no-server";
      return;
    }
    if (this.running.has(id)) return;
    rec.status = "starting";
    const dataDir = this.dataDirOf(id);

    const cfg = this.d.config;
    const proxyToken = this.d.egress.issueToken(`plugin:${id}`, rec.granted.network);
    const proxyUrl = `http://${proxyToken}:x@127.0.0.1:${cfg.egressPort}`;
    // Builtin brain plugins run harness CLIs (claude, codex) as the "agent" user with a persistent home where the CLI
    // logins live (config.brainHome: the user's own home in the desktop app); everything else runs as the
    // unprivileged "plugin" user.
    const isBrainHost = rec.source === "builtin" && rec.layout.manifest.contributes.brains.length > 0;
    const home = isBrainHost ? cfg.brainHome : dataDir;
    const runAs = isBrainHost ? cfg.isolation.agentUser : cfg.isolation.pluginUser;
    if (cfg.isolation.users) {
      // Directories must belong to the user the plugin runs as (plugins-data is sticky world-writable, like /tmp).
      execFileSync("sudo", ["-n", "-u", runAs, "--", "mkdir", "-p", dataDir, home], { stdio: "pipe", env: passEnv() });
    } else {
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(home, { recursive: true });
      // Running as the user: CLIs that keep logins in the macOS keychain must find it from their own HOME.
      if (isBrainHost) linkUserKeychains(home);
    }
    const env: Record<string, string> = {
      HOME: home,
      PIOMIO_DATA_DIR_PLUGIN: dataDir,
      PIOMIO_PLUGIN_ID: id,
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      TZ: cfg.timezone,
    };
    const runner = join(cfg.appRoot, "packages", "plugin-sdk", "src", "runner.ts");
    const nodeArgs = ["--disable-warning=ExperimentalWarning", runner, rec.layout.serverEntry];
    let child: ChildProcess;
    if (cfg.isolation.users) {
      const s = sudoSpawn(runAs, { ...passEnv(), ...env }, process.execPath, nodeArgs);
      child = spawn(s.command, s.args, { cwd: rec.dir, env: s.env, stdio: ["pipe", "pipe", "pipe"] });
    } else {
      const base = isBrainHost ? withPath(scrubEnv(process.env), [], this.d.cliBinDirs?.() ?? []) : scrubEnv(process.env);
      child = spawn(process.execPath, nodeArgs, { cwd: rec.dir, env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    }

    const peer = createRpcPeer(ndjsonTransport(child.stdout!, child.stdin!));
    const running: Running = { child, peer, stopping: false, unsubs: [] };
    this.running.set(id, running);

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) this.log(rec, "stderr", line);
    });
    child.on("exit", (code, signal) => this.onExit(id, code, signal, child));
    child.on("error", (e) => {
      rec.lastError = e.message;
      this.log(rec, "error", `spawn failed: ${e.message}`);
    });

    this.wire(rec, peer, running);

    let readyResolve!: () => void;
    const ready = new Promise<void>((r) => (readyResolve = r));
    peer.handle("plugin.ready", () => {
      readyResolve();
      return {};
    });
    try {
      await peer.request(
        "plugin.activate",
        {
          pluginId: id,
          dataDir,
          pluginDir: rec.dir,
          hubUrl: cfg.internalUrl,
          appRoot: cfg.appRoot,
          settings: rec.settings,
          locale: hubLocale(),
          messages: rec.layout?.messages ?? {},
        },
        { timeoutMs: 60_000 },
      );
      await ready;
      rec.status = "running";
      rec.lastError = undefined;
      this.d.audit.append("core", "plugin.start", id);
    } catch (e: any) {
      rec.status = "error";
      rec.lastError = e.message;
      this.log(rec, "error", `activation failed: ${e.message}`);
      await this.stop(id);
      rec.status = "error";
      throw e;
    } finally {
      this.d.bus.emit("plugins.updated", {});
    }
  }

  async stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) return;
    r.stopping = true;
    try {
      await r.peer.request("plugin.deactivate", {}, { timeoutMs: 3000 });
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (r.child.exitCode === null) r.child.kill("SIGKILL");
    }, 3000).unref();
    this.cleanup(id);
    const rec = this.records.get(id);
    if (rec && rec.status !== "error") rec.status = rec.enabled ? "stopped" : "disabled";
    this.d.bus.emit("plugins.updated", {});
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  private cleanup(id: string): void {
    const r = this.running.get(id);
    if (r) {
      for (const u of r.unsubs) u();
      r.peer.close();
    }
    this.running.delete(id);
    this.d.tools.unregisterOwner(id);
    this.d.hooks.unregisterOwner(id);
    this.d.brains.unregisterPlugin(id);
    this.d.channels.unregisterPlugin(id);
    this.httpPlugins.delete(id);
    this.uiMessageTargets.delete(id);
    this.d.egress.revokeOwner(`plugin:${id}`);
    const before = this.catalogs.get(id);
    this.catalogs.delete(id);
    if (before?.length) this.d.onCatalogUpdated?.(id, before, []);
  }

  private onExit(id: string, code: number | null, signal: string | null, child: ChildProcess): void {
    const r = this.running.get(id);
    const rec = this.records.get(id);
    // A process stopped earlier that exits only now (turned off and on again quickly, a restart): not the running one.
    if (!r || !rec || r.child !== child) return;
    const expected = r.stopping;
    this.cleanup(id);
    if (expected) return;
    this.log(rec, "error", `process exited unexpectedly (code=${code}, signal=${signal})`);
    const now = Date.now();
    const list = (this.crashes.get(id) ?? []).filter((t) => now - t < 10 * 60_000);
    list.push(now);
    this.crashes.set(id, list);
    if (list.length >= 5) {
      rec.status = "crashed";
      rec.lastError = tFor(hubLocale())("plugin.crashLoop");
      this.d.audit.append("core", "plugin.crash-disabled", id);
      this.d.bus.emit("plugins.updated", {});
      return;
    }
    rec.status = "crashed";
    const delay = Math.min(30_000, 1000 * 2 ** (list.length - 1));
    setTimeout(() => {
      if (rec.enabled && !this.running.has(id)) this.start(id).catch((e) => this.log(rec, "error", `restart failed: ${e.message}`));
    }, delay).unref();
    this.d.bus.emit("plugins.updated", {});
  }

  private log(rec: PluginRecord, level: string, msg: string): void {
    rec.logs.push({ ts: nowIso(), level, msg: this.d.vault.redactor.text(msg) });
    if (rec.logs.length > MAX_LOGS) rec.logs.splice(0, rec.logs.length - MAX_LOGS);
    if (level === "error" || process.env.PIOMIO_DEBUG) console.error(`[plugin:${rec.id}] ${msg}`);
  }

  // ---------- RPC wiring ----------

  private wire(rec: PluginRecord, peer: RpcPeer, running: Running): void {
    const id = rec.id;
    const m = rec.layout!.manifest;
    const prefix = toolPrefixOf(m);
    const deny = (what: string): never => {
      this.d.audit.append(`plugin:${id}`, "plugin.permission-denied", what);
      throw new Error(`plugin ${id} is not allowed: ${what}`);
    };

    peer.onNotification("log", (p: { level: string; msg: string }) => this.log(rec, p.level, p.msg));

    peer.handle("register.tool", (p: { spec: ToolSpec }) => {
      if (!m.contributes.tools) deny("contributes.tools is false");
      const short = p.spec.name;
      const name = `${prefix}_${short}`;
      const descriptor: ToolDescriptor = { ...p.spec, name, owner: id };
      this.d.tools.register(descriptor, async (input, ctx) =>
        this.showWidgets(rec, ctx, await peer.request<ToolResult>("tool.invoke", { name: short, input, context: ctx }, { timeoutMs: 15 * 60_000 })),
      );
      return {};
    });

    peer.handle("unregister.tool", (p: { name: string }) => {
      this.d.tools.unregister(`${prefix}_${String(p.name)}`, id);
      return {};
    });

    peer.handle("catalog.update", (p: { entries: unknown }) => {
      if (!m.integration) deny("catalog entries without an integration block");
      const before = this.catalogs.get(id) ?? [];
      const after = cleanCatalogReport(p.entries);
      this.catalogs.set(id, after);
      this.d.onCatalogUpdated?.(id, before, after);
      return {};
    });

    peer.handle("register.brain", (p: { id: string; label: string; variants?: string[]; login?: boolean }) => {
      if (!m.contributes.brains.includes(p.id)) deny(`brain ${p.id} not declared in contributes.brains`);
      const variants = Array.isArray(p.variants) ? p.variants.filter((v) => typeof v === "string" && /^[\w.-]{1,64}$/.test(v)).slice(0, 32) : [];
      this.d.brains.registerPluginBrain(p.id, p.label, id, peer, variants, p.login === true);
      this.d.bus.emit("brains.updated", {});
      return {};
    });

    peer.handle("register.channel", (p: { id: string; label: string }) => {
      if (!m.contributes.channels.includes(p.id)) deny(`channel ${p.id} not declared in contributes.channels`);
      this.d.channels.register(p.id, p.label, id, peer);
      return {};
    });

    peer.handle("register.hook", (p: { hook: HookName }) => {
      if (!m.contributes.hooks.includes(p.hook)) deny(`hook ${p.hook} not declared in contributes.hooks`);
      this.d.hooks.register(p.hook, id, (payload) => peer.request("hook.run", { hook: p.hook, payload }, { timeoutMs: 10_000 }));
      return {};
    });

    peer.handle("register.http", () => {
      if (!m.contributes.http) deny("contributes.http is false");
      this.httpPlugins.add(id);
      return {};
    });

    peer.handle("events.subscribe", (p: { names: BusEventName[] }) => {
      for (const name of p.names) {
        const unsub = this.d.bus.on(name, (payload) => {
          if (!peer.closed) peer.notify("event", { name, payload: this.d.vault.redactor.value(payload) });
        });
        running.unsubs.push(unsub);
      }
      this.uiMessageTargets.add(id);
      return {};
    });

    peer.handle("vault.get", (p: { ref: string; domain?: string; reason?: string }) => {
      const itemId = p.ref.replace(/^vault:\/\//, "");
      const meta = this.d.vault.getMeta(itemId);
      const allowed = [...rec.granted.vault, ...rec.extraVault].some((g) => g === itemId || g === "*" || (meta && g === `${meta.type}:*`));
      if (!allowed) deny(`vault item ${itemId} not in permissions.vault`);
      return this.d.vault.access(p.ref, { actor: `plugin:${id}`, pluginId: id, domain: p.domain });
    });

    const kv = this.d.db;
    peer.handle("storage.get", (p: { key: string }) => {
      const r = kv.prepare("select value from plugin_kv where plugin_id = ? and key = ?").get(id, p.key) as { value: string } | undefined;
      return r ? JSON.parse(r.value) : null;
    });
    peer.handle("storage.set", (p: { key: string; value: unknown }) => {
      kv.prepare("insert into plugin_kv(plugin_id, key, value) values (?,?,?) on conflict(plugin_id, key) do update set value = excluded.value").run(
        id,
        p.key,
        JSON.stringify(p.value ?? null),
      );
      return {};
    });
    peer.handle("storage.delete", (p: { key: string }) => {
      kv.prepare("delete from plugin_kv where plugin_id = ? and key = ?").run(id, p.key);
      return {};
    });
    peer.handle("storage.list", (p: { prefix?: string }) => {
      const rows = kv.prepare("select key, value from plugin_kv where plugin_id = ? and key like ? order by key").all(id, `${(p.prefix ?? "").replace(/[%_]/g, "\\$&")}%`) as Array<{
        key: string;
        value: string;
      }>;
      return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
    });

    peer.handle("core.call", async (p: { method: CoreMethod; params: unknown }) => {
      if (!rec.granted.core.includes(p.method)) deny(`core method ${p.method} not in permissions.core`);
      return this.d.coreCall(id, p.method, p.params);
    });
  }

  /**
   * The cards a plugin's tool call showed (ctx.widgets.show, carried in the result's _meta) go into the reply as
   * `widget` parts; the model reads the result without them. Undeclared kinds and oversized data are dropped.
   */
  private showWidgets(rec: PluginRecord, ctx: ToolCallContext, result: ToolResult): ToolResult {
    const widgets = result?._meta?.widgets;
    if (!widgets) return result;
    const { widgets: _, ...meta } = result._meta!;
    const declared = rec.layout?.manifest.contributes.widgets ?? [];
    const list = Array.isArray(widgets) ? widgets.slice(0, MAX_WIDGETS_PER_CALL) : [];
    for (const w of list) {
      const kind = String(w?.kind ?? "");
      if (!declared.includes(kind)) {
        this.log(rec, "warn", `widget "${kind}" is not declared in contributes.widgets; not shown`);
        continue;
      }
      const data = this.d.vault.redactor.value(w.data ?? null);
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_WIDGET_BYTES) {
        this.log(rec, "warn", `widget "${kind}" data is over ${MAX_WIDGET_BYTES} bytes; not shown`);
        continue;
      }
      if (ctx?.conversationId) this.d.attachPart?.(ctx.conversationId, { type: "widget", plugin: rec.id, kind, data });
    }
    return Object.keys(meta).length ? { ...result, _meta: meta } : { content: result.content, ...(result.isError ? { isError: true } : {}) };
  }

  // ---------- Catalog entries ----------

  /** What a running plugin last reported about its catalog entries; undefined when it has not (or is not running). */
  catalogOf(id: string): CatalogEntryState[] | undefined {
    return this.catalogs.get(id);
  }

  /** The address that signs one of a plugin's entries in, from the plugin. */
  async catalogSignIn(id: string, entryId: string): Promise<string> {
    const r = this.running.get(id);
    if (!r) throw new LocalizedError("catalog.notRunning", { name: id });
    const { url } = await r.peer.request<{ url: string }>("catalog.signin", { entryId }, { timeoutMs: 120_000 });
    if (!/^https:\/\//.test(String(url))) throw new LocalizedError("catalog.badSignin", { name: id });
    return url;
  }

  async catalogSignOut(id: string, entryId: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) throw new LocalizedError("catalog.notRunning", { name: id });
    await r.peer.request("catalog.signout", { entryId }, { timeoutMs: 60_000 });
  }

  // ---------- HTTP and UI routing ----------

  hasHttp(id: string): boolean {
    return this.httpPlugins.has(id);
  }

  async http(
    id: string,
    req: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; public: boolean; locale: Locale },
  ) {
    const r = this.running.get(id);
    if (!r || !this.httpPlugins.has(id)) return { status: 404, body: { error: "plugin has no http handler" } };
    return r.peer.request<{ status?: number; headers?: Record<string, string>; body?: unknown }>("http.request", req, { timeoutMs: 60_000 });
  }

  uiMessage(id: string, payload: unknown): void {
    const r = this.running.get(id);
    if (r && !r.peer.closed) r.peer.notify("ui.message", { payload });
  }

  /** UI modules for the web app, with each plugin's messages in `locale` (and English for fallback). */
  uiPlugins(locale: Locale = hubLocale()): Array<{ id: string; name: string; url: string; messages: Catalog }> {
    return this.list()
      .filter((r) => r.enabled && r.layout?.uiEntry && existsSync(r.layout.uiEntry))
      .map((r) => ({
        id: r.id,
        name: localizePluginValue(r.layout, r.layout!.manifest.name, locale),
        url: `/plugins-ui/${r.id}/${basename(r.layout!.uiEntry!)}`,
        messages: { en: r.layout!.messages.en, [locale]: r.layout!.messages[locale] },
      }));
  }

  /** Tell running plugins that the hub language changed (ctx.i18n.onChange). */
  broadcastLocale(locale: Locale): void {
    for (const r of this.running.values()) if (!r.peer.closed) r.peer.notify("locale.changed", { locale });
  }

  uiDir(id: string): string | undefined {
    const r = this.records.get(id);
    return r?.enabled && r.layout?.uiEntry ? dirname(r.layout.uiEntry) : undefined;
  }

  // ---------- settings ----------

  setSettings(id: string, settings: Record<string, unknown>): void {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown plugin ${id}`);
    rec.settings = settings;
    this.d.db.prepare("update plugins set settings = ? where id = ?").run(JSON.stringify(settings), id);
    const r = this.running.get(id);
    if (r && !r.peer.closed) r.peer.notify("settings.changed", { settings });
    this.d.audit.append("user", "plugin.settings", id);
  }

  /** Grant a plugin extra vault items (e.g. the key a setting like customKeyRef points to). Takes effect on the next vault.get. */
  setExtraVault(id: string, items: string[]): void {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown plugin ${id}`);
    const clean = [...new Set(items.map((s) => String(s).replace(/^vault:\/\//, "").trim()).filter(Boolean))];
    for (const it of clean) if (!/^[\w.:*-]{1,128}$/.test(it)) throw new Error(`invalid vault item ${it}`);
    rec.extraVault = clean;
    this.d.db.prepare("update plugins set extra_vault = ? where id = ?").run(JSON.stringify(clean), id);
    this.d.audit.append("user", "plugin.vault", id, { items: clean });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown plugin ${id}`);
    rec.enabled = enabled;
    this.d.db.prepare("update plugins set enabled = ? where id = ?").run(enabled ? 1 : 0, id);
    this.d.audit.append("user", enabled ? "plugin.enable" : "plugin.disable", id);
    if (enabled) {
      this.crashes.delete(id);
      rec.status = "stopped";
      await this.start(id).catch(() => {});
    } else {
      await this.stop(id);
      rec.status = "disabled";
    }
    this.d.onLayoutsChanged();
    this.d.bus.emit("plugins.updated", {});
  }

  // ---------- install ----------

  async prepareInstall(source: string, locale: Locale = hubLocale()): Promise<InstallPreview> {
    const stagingRoot = join(this.installedDir, ".staging");
    mkdirSync(stagingRoot, { recursive: true });
    const stagingId = randomBytes(6).toString("hex");
    const dir = join(stagingRoot, stagingId);
    let commitHash: string | undefined;
    if (/^(https?:\/\/|git@|ssh:\/\/)/.test(source)) {
      execFileSync("git", ["clone", "--depth", "1", source, dir], { stdio: "pipe", timeout: 120_000 });
      commitHash = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } else {
      const src = resolve(source);
      if (!existsSync(src)) throw new LocalizedError("plugin.dirNotFound", { path: src });
      cpSync(src, dir, { recursive: true, filter: (p) => !p.includes(`${"node_modules"}`) });
    }
    const layout = readPluginLayout(dir);
    if (this.records.get(layout.manifest.id)?.source === "builtin" || HELD_BACK_WITHOUT_KEYS.includes(layout.manifest.id)) {
      throw new LocalizedError("plugin.builtinCannotReplace", { id: layout.manifest.id });
    }
    // A card's source without its build (an integration an agent made): the hub compiles it.
    compilePluginUi(dir, layout.uiEntry);
    this.staging.set(stagingId, { dir, commitHash, layout, source });
    const perms = layout.manifest.permissions;
    const t = tFor(locale);
    const warnings: string[] = [];
    if (layout.uiEntry) warnings.push(t("plugin.warn.ui"));
    if (perms.network.includes("*")) warnings.push(t("plugin.warn.network"));
    if (perms.vault.length) warnings.push(t("plugin.warn.vault", { items: perms.vault.join(", ") }));
    if (perms.core.includes("approvals.resolve")) warnings.push(t("plugin.warn.approvals"));
    if (layout.formats.includes("claude") || layout.formats.includes("codex")) warnings.push(t("plugin.warn.skills"));
    if (layout.mcpFile) warnings.push(t("plugin.warn.mcp"));
    return {
      stagingId,
      manifest: localizePluginValue(layout, layout.manifest, locale),
      formats: layout.formats,
      permissions: perms,
      commitHash,
      warnings,
      hasServer: !!layout.serverEntry,
      hasUi: !!layout.uiEntry,
    };
  }

  /** Drops a staged installation the person declined. */
  discardInstall(stagingId: string): void {
    const st = this.staging.get(stagingId);
    if (!st) return;
    this.staging.delete(stagingId);
    rmSync(st.dir, { recursive: true, force: true });
  }

  async confirmInstall(stagingId: string): Promise<PluginRecord> {
    const st = this.staging.get(stagingId);
    if (!st) throw new LocalizedError("plugin.installExpired");
    this.staging.delete(stagingId);
    const id = st.layout.manifest.id;
    const target = join(this.installedDir, id);
    if (this.running.has(id)) await this.stop(id);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(st.dir, target);
    const pkg = join(target, "package.json");
    if (existsSync(pkg)) {
      const deps = JSON.parse(readFileSync(pkg, "utf8")).dependencies;
      if (deps && Object.keys(deps).length) {
        const npm = npmInvocation(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
        execFileSync(npm.file, npm.args, { cwd: target, stdio: "pipe", timeout: 300_000, shell: npm.shell, env: npmEnv() });
      }
    }
    const perms = st.layout.manifest.permissions;
    this.d.db
      .prepare(
        "insert into plugins(id, dir, source, enabled, granted, commit_hash, installed_at, settings) values (?,?,?,?,?,?,?,?) on conflict(id) do update set dir = excluded.dir, granted = excluded.granted, commit_hash = excluded.commit_hash, enabled = 1",
      )
      .run(id, target, "installed", 1, JSON.stringify(perms), st.commitHash ?? null, nowIso(), "{}");
    this.d.audit.append("user", "plugin.install", id, { source: st.source, commit: st.commitHash, permissions: perms });
    this.discover();
    await this.start(id).catch(() => {});
    this.d.bus.emit("plugins.updated", {});
    return this.records.get(id)!;
  }

  async uninstall(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown plugin ${id}`);
    if (rec.source === "builtin") throw new LocalizedError("plugin.builtinCannotRemove");
    await this.stop(id);
    rmSync(rec.dir, { recursive: true, force: true });
    this.d.db.prepare("delete from plugins where id = ?").run(id);
    this.d.db.prepare("delete from plugin_kv where plugin_id = ?").run(id);
    this.records.delete(id);
    this.d.audit.append("user", "plugin.uninstall", id);
    this.d.onLayoutsChanged();
    this.d.bus.emit("plugins.updated", {});
  }
}

/**
 * Run `command` as another unix user with exactly `env`. The variables travel in sudo's own environment
 * (`--preserve-env`, allowed by the sudoers rule), never on the command line: any user in the container can
 * read command lines with ps, and these carry egress tokens and MCP server secrets.
 */
export function sudoSpawn(user: string, env: Record<string, string>, command: string, args: string[]): { command: string; args: string[]; env: Record<string, string> } {
  for (const k of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid environment variable name: ${k}`);
  return { command: "sudo", args: ["-n", `--preserve-env=${Object.keys(env).join(",")}`, "-u", user, "--", command, ...args], env };
}

/** Harmless variables isolated children still need: binaries, locale, X display, browsers. */
export function passEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: env.LANG ?? "C.UTF-8" };
  for (const k of ["LC_ALL", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "DISABLE_AUTOUPDATER"]) if (env[k]) out[k] = env[k]!;
  return out;
}

export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL/i.test(k)) continue;
    if (k.startsWith("PIOMIO_")) continue;
    out[k] = v;
  }
  return out;
}
