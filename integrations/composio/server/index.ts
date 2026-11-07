// The Composio integration: Slack, GitHub, Google, HubSpot, Dropbox, Box (the manifest's entries) and any other of
// Composio's apps the agent adds from the chat, each a catalog entry "composio:<app>" with Composio's badge. Composio
// is an outside service: it signs in with its own OAuth apps and keeps the accounts' tokens; the hub keeps only the
// Composio key (vault://composio).
//
// Sign-in: an auth config with Composio's own OAuth app (made once per app), a link the person opens, then the plugin
// polls the connected account until it works (nothing has to come back to the hub, so a phone can sign in too). An
// account the hub stops waiting for, or one a newer sign-in replaces, is deleted at Composio: nothing it made is left.
// A connected app's main tools become tools of their own (composio_slack_send_message…): a read only when Composio
// tags it read-only and nothing else, every other one asks; composio_tools_search adds others, composio_tool_run
// runs one by name.
//
// The apps' events are a trigger source too (composio.event, triggers.ts): composio_triggers lists the trigger types
// of the connected apps, a trigger subscribes to one, and the events come by webhook or Composio's realtime channel.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import type { CatalogEntryState, ToolResult } from "@piomio/shared";
import { ComposioError, composioApi, DEFAULT_API, type ComposioTool, type TriggerType } from "./api.ts";
import { effectOf, resultText, specOf, toolName } from "./tools.ts";
import { composioTriggers, type ComposioTriggers } from "./triggers.ts";

/** What the plugin keeps about one app. */
interface App {
  /** Composio's auth config with its own OAuth app, made at the first sign-in. */
  authConfigId?: string;
  /** The connected account that works (or last did), and its status at Composio. */
  accountId?: string;
  status?: string;
  /** A sign-in in progress: the account its link made, and until when it is waited for (ms). */
  pending?: string;
  pendingUntil?: number;
  /** An app added from the chat (not one of the manifest's): its name. */
  added?: { name: string };
  /** The service refused a call for a permission the person did not give at sign-in (an unticked box on Google's page). */
  scopesMissing?: boolean;
}

// Composio's address and the polling pace come from the environment, not from settings an agent could change: the
// key is only ever sent to Composio.
const API = process.env.PIOMIO_COMPOSIO_API || DEFAULT_API;
const POLL_MS = Math.max(20, Number(process.env.PIOMIO_COMPOSIO_POLL_MS) || 3000);
/** Tests only: a local stand-in for Pusher's wss://ws-<cluster>.pusher.com, and the realtime channel's first reconnect pause. */
const PUSHER = process.env.PIOMIO_COMPOSIO_PUSHER || undefined;
const RECONNECT_MS = Number(process.env.PIOMIO_COMPOSIO_RECONNECT_MS) || undefined;
/** Main tools one app gets as tools of its own, at most; and with those composio_tools_search added. */
const MAX_TOOLS = 30;
const MAX_APP_TOOLS = 60;
/** How long a sign-in link is waited for when Composio does not say, and how long after it runs out. */
const LINK_MS = 10 * 60_000;
const GRACE_MS = Number(process.env.PIOMIO_COMPOSIO_GRACE_MS) || 2 * 60_000;
const PENDING = new Set(["INITIATED", "INITIALIZING"]);
const APP_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** How a service says its token lacks a permission (Google: "Request had insufficient authentication scopes"). */
const SCOPES_RE = /insufficient[ _](authentication[ _])?scopes?|insufficient[ _]?permissions?|insufficient_scope/i;
/** composio_triggers' answer, at most (characters), and one type's config schema in it. */
const TRIGGERS_TEXT_MAX = 24_000;
const TRIGGER_CONFIG_MAX = 1500;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** The manifest's entries: the apps that are in the catalog from the start. */
function manifestApps(pluginDir: string): Array<{ id: string; name: string }> {
  const m = JSON.parse(readFileSync(join(pluginDir, ".piomio-plugin", "plugin.json"), "utf8"));
  return (m?.integration?.entries ?? []).map((e: any) => ({ id: String(e.id), name: String(e.name) }));
}

/** One trigger type, as composio_triggers shows it. */
function triggerLine(t: TriggerType, app: string): string {
  const how = t.types.includes("webhook") ? "instant" : "polled: up to its polling interval, 2 minutes at the shortest";
  const about = [t.description, t.instructions].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 300);
  const setup = t.requiresWebhookSetup ? " [needs a Composio address registered by hand at the provider (own OAuth app): avoid unless the user set that up]" : "";
  return `${t.slug} — ${t.name} (${app}; ${how})${about ? `: ${about}` : ""}${setup}\n  config: ${JSON.stringify(t.config).slice(0, TRIGGER_CONFIG_MAX)}`;
}

let triggers: ComposioTriggers | undefined;

const plugin: PluginModule & { stop?: () => void } = {
  async activate(ctx: PluginContext) {
    const known = manifestApps(ctx.pluginDir);
    const apps: Record<string, App> = (await ctx.storage.get<Record<string, App>>("apps")) ?? {};
    let userId = await ctx.storage.get<string>("userId");
    if (!userId) {
      // The hub is one person: one Composio user, whatever its machines.
      userId = `piomio-${randomUUID()}`;
      await ctx.storage.set("userId", userId);
    }
    const user = userId;
    /** missing: no key in the vault (or it is locked); rejected: Composio refused the one there. */
    let keyState: "missing" | "ok" | "rejected" = "missing";
    const registered = new Map<string, string[]>();
    const polls = new Map<string, ReturnType<typeof setTimeout>>();
    /** Bumped when an app signs in again or out: a poll or a tool listing still under way for it then stops. */
    const gens = new Map<string, number>();

    // The key is read once and kept until the vault changes (every read is a line in the security log).
    let cachedKey: string | undefined;
    const key = async () => {
      if (cachedKey) return cachedKey;
      const item = await ctx.vault.get("vault://composio", { reason: "Composio" });
      cachedKey = item.value ?? item.password ?? item.token ?? Object.values(item)[0] ?? "";
      return cachedKey;
    };
    const hasKey = () => key().then((k) => !!k, () => false);
    const api = () => composioApi(API, key);
    const save = () => ctx.storage.set("apps", apps);
    const isKnown = (app: string) => known.some((e) => e.id === app);
    const nameOf = (app: string) => known.find((e) => e.id === app)?.name ?? apps[app]?.added?.name ?? app;
    const ids = () => [...known.map((e) => e.id), ...Object.keys(apps).filter((a) => apps[a]!.added && !isKnown(a))];
    const connected = () => ids().filter((a) => apps[a]?.accountId && apps[a]!.status === "ACTIVE");
    const bump = (app: string) => {
      const gen = (gens.get(app) ?? 0) + 1;
      gens.set(app, gen);
      clearTimeout(polls.get(app));
      polls.delete(app);
      return gen;
    };
    const forget = (id: string) => void api().deleteAccount(id).catch((e) => ctx.log.warn(`composio: could not delete account ${id}: ${(e as Error).message}`));

    function stateOf(app: string): CatalogEntryState {
      const a = apps[app];
      const look = a?.added && !isKnown(app) ? { name: a.added.name, summary: "%entry.added%", category: "other", icon: "plug" } : {};
      const base = { id: app, ...look };
      if (keyState === "missing") return { ...base, status: "needs-setup", connect: "setup" };
      if (keyState === "rejected") return { ...base, status: "broken", connect: "setup", detail: "%detail.key%" };
      if (a?.accountId && a.status === "ACTIVE" && a.scopesMissing) return { ...base, status: "broken", connect: "signin", detail: "%detail.scopes%" };
      if (a?.accountId && a.status === "ACTIVE") return { ...base, status: "connected", connect: "signin" };
      if (a?.pending && polls.has(app)) return { ...base, status: "needs-setup", connect: "signin", detail: "%detail.waiting%" };
      if (a?.accountId && a.status && !PENDING.has(a.status)) return { ...base, status: "broken", connect: "signin", detail: "%detail.expired%" };
      return { ...base, status: "needs-setup", connect: "signin" };
    }
    const report = () => ctx.catalog.update(ids().map(stateOf));

    /** A refused key turns every entry to its key step. */
    const keyRefused = () => {
      keyState = "rejected";
      report();
    };

    /** What the agent hears about a failed request. */
    /**
     * The service refused for a permission not given at sign-in: the card asks for a new sign-in, and the agent says
     * what to do instead of guessing.
     */
    function scopesMissing(app: string): ToolResult {
      const a = apps[app];
      if (a && !a.scopesMissing) {
        a.scopesMissing = true;
        void save();
        report();
      }
      return text(
        `${nameOf(app)} was not given the permission this needs: when the user signed in, not every permission on its page was allowed (Google shows boxes to tick). ` +
          `Show its card with hub_integration_connect id composio:${app}: the user signs in again and allows everything it asks for (ticks every box).`,
        true,
      );
    }

    function failure(e: unknown, app?: string): ToolResult {
      if (app && e instanceof ComposioError && SCOPES_RE.test(e.message)) return scopesMissing(app);
      if (e instanceof ComposioError) {
        if (e.kind === "key") {
          keyRefused();
          return text("Composio refused its API key (it may have been revoked): the user stores a new one on the card (hub_integration_connect id composio).", true);
        }
        if (e.kind === "limit") return text(`Composio's plan has no calls left (${e.message}). Tell the user: it resets with the next billing month, or their Composio plan can be raised.`, true);
        if (e.kind === "rate") return text(`Too many calls just now (${e.message}); wait a little and try again.`, true);
        if (e.kind === "down") return text(`Composio is unreachable right now (${e.message}); try again later.`, true);
        return text(`${app ? nameOf(app) : "Composio"}: ${e.message}`, true);
      }
      return text(`Error: ${(e as Error)?.message ?? String(e)}`, true);
    }

    /** What the person sees when a sign-in or sign-out fails (in the hub's language). */
    function personError(e: unknown): Error {
      if (!(e instanceof ComposioError)) return e as Error;
      if (e.kind === "key") {
        keyRefused();
        return new Error(ctx.i18n.t("error.keyRejected"));
      }
      return new Error(ctx.i18n.t(e.kind === "down" ? "error.down" : "error.failed", { message: e.message }));
    }

    function unregisterTools(app: string) {
      for (const n of registered.get(app) ?? []) ctx.tools.unregister(n);
      registered.delete(app);
    }

    function addTool(app: string, tool: ComposioTool): string {
      const spec = specOf(tool, nameOf(app));
      ctx.tools.register({ ...spec, handler: (input) => run(app, tool.slug, tool.version, input) });
      const names = registered.get(app) ?? [];
      if (!names.includes(spec.name)) names.push(spec.name);
      registered.set(app, names);
      return spec.name;
    }

    /** A connected app's main tools as tools of their own (its first ones when Composio marks none as main). */
    async function registerTools(app: string, accountId: string) {
      const gen = gens.get(app);
      let list = await api().tools(app, { important: true, limit: MAX_TOOLS });
      if (!list.length) list = await api().tools(app, { limit: 20 });
      // Signed out or in again meanwhile: these tools are not for the account there is now.
      const a = apps[app];
      if (gens.get(app) !== gen || a?.accountId !== accountId || a.status !== "ACTIVE") return;
      unregisterTools(app);
      for (const tool of list.slice(0, MAX_TOOLS)) addTool(app, tool);
    }

    async function run(app: string, slug: string, version: string | undefined, input: unknown): Promise<ToolResult> {
      const a = apps[app];
      if (!a?.accountId || a.status !== "ACTIVE") return text(`${nameOf(app)} is not connected: show its card with hub_integration_connect (id composio:${app}).`, true);
      try {
        const r = await api().execute(slug, { userId: user, accountId: a.accountId, args: (input ?? {}) as Record<string, unknown>, ...(version ? { version } : {}) });
        if (!r.ok && SCOPES_RE.test(`${r.error ?? ""} ${resultText(r.data, 2000)}`)) return scopesMissing(app);
        if (!r.ok) return text(`${nameOf(app)} did not do it: ${r.error ?? "the call failed"}${r.data ? `\n${resultText(r.data, 4000)}` : ""}`, true);
        return text(resultText(r.data));
      } catch (e) {
        return failure(e, app);
      }
    }

    /** Checks a sign-in in progress until its account works, fails, or its link has run out a while ago. */
    function poll(app: string, accountId: string, until: number) {
      const gen = bump(app);
      const live = () => gens.get(app) === gen && apps[app]?.pending === accountId;
      const stop = async (drop: boolean) => {
        if (gens.get(app) === gen) polls.delete(app);
        const a = apps[app];
        if (a?.pending === accountId) {
          delete a.pending;
          delete a.pendingUntil;
        }
        // Nobody signs in with it any more: Composio keeps nothing of it.
        if (drop) forget(accountId);
        await save();
        report();
      };
      const tick = async () => {
        if (!live()) return;
        let status: string | undefined;
        try {
          status = (await api().account(accountId)).status;
        } catch (e) {
          if (!live()) return;
          if (e instanceof ComposioError && e.kind === "key") {
            keyState = "rejected";
            return stop(false);
          }
          if (e instanceof ComposioError && e.status === 404) return stop(false);
          ctx.log.warn(`composio: checking ${app}'s sign-in: ${(e as Error).message}`);
        }
        if (!live()) return;
        const a = apps[app]!;
        if (status === "ACTIVE") {
          polls.delete(app);
          const old = a.accountId;
          Object.assign(a, { accountId, status: "ACTIVE" });
          delete a.scopesMissing;
          delete a.pending;
          delete a.pendingUntil;
          await save();
          if (old && old !== accountId) forget(old);
          await registerTools(app, accountId).catch((e) => ctx.log.warn(`composio: ${app}'s tools: ${(e as Error).message}`));
          report();
          return;
        }
        if (status && !PENDING.has(status)) return stop(true);
        if (Date.now() > until + GRACE_MS) return stop(true);
        polls.set(app, setTimeout(() => void tick(), POLL_MS));
      };
      polls.set(app, setTimeout(() => void tick(), POLL_MS));
    }

    /** Where every known account and sign-in in progress is at Composio, and their apps' tools. */
    async function sync() {
      if (!(await hasKey())) {
        keyState = "missing";
        report();
        return;
      }
      keyState = "ok";
      report();
      for (const app of Object.keys(apps)) {
        const a = apps[app]!;
        if (keyState !== "ok") break;
        try {
          if (a.accountId) {
            const id = a.accountId;
            const status = (await api().account(id)).status;
            if (apps[app] !== a || a.accountId !== id) continue;
            a.status = status;
            if (status === "ACTIVE") await registerTools(app, id);
            else unregisterTools(app);
          }
          // A sign-in left in progress (the hub restarted meanwhile): wait for it again, or let it go.
          if (a.pending && !polls.has(app)) poll(app, a.pending, a.pendingUntil ?? Date.now());
        } catch (e) {
          if (e instanceof ComposioError && e.status === 404 && a.accountId) {
            delete a.accountId;
            delete a.status;
            delete a.scopesMissing;
            unregisterTools(app);
          } else if (e instanceof ComposioError && e.kind === "key") keyState = "rejected";
          else ctx.log.warn(`composio: could not check ${app}: ${(e as Error).message}`);
        }
      }
      await save();
      report();
    }
    // One sync at a time: the vault's events come in bursts.
    let syncing: Promise<void> = Promise.resolve();
    const resync = () => {
      syncing = syncing.then(sync).catch((e) => ctx.log.warn(`composio: sync failed: ${(e as Error).message}`));
      return syncing;
    };

    plugin.stop = () => {
      for (const t of polls.values()) clearTimeout(t);
      polls.clear();
    };

    /** The app's auth config with Composio's own OAuth app, made the first time. */
    async function authConfig(app: string, a: App): Promise<string> {
      if (a.authConfigId) return a.authConfigId;
      const kit = await api().toolkit(app);
      if (!kit.managed) throw new Error(ctx.i18n.t("error.notManaged", { name: nameOf(app) }));
      a.authConfigId = await api().createAuthConfig(app);
      await save();
      return a.authConfigId;
    }

    ctx.catalog.onSignIn(async (app) => {
      if (!ids().includes(app)) throw new Error(`Composio has no app "${app}" in the catalog`);
      if (!(await hasKey())) throw new Error(ctx.i18n.t("error.noKey"));
      try {
        const a = (apps[app] ??= {});
        let link;
        try {
          link = await api().link(await authConfig(app, a), user);
        } catch (e) {
          // An auth config deleted at Composio, or of another project (a new key): make a new one, once.
          if (!(e instanceof ComposioError) || (e.status !== 400 && e.status !== 404) || !a.authConfigId) throw e;
          delete a.authConfigId;
          link = await api().link(await authConfig(app, a), user);
        }
        // A sign-in started before and not finished: its account goes, this one replaces it.
        if (a.pending && a.pending !== link.accountId) forget(a.pending);
        const expires = link.expiresAt ? Date.parse(link.expiresAt) : NaN;
        a.pending = link.accountId;
        a.pendingUntil = Number.isFinite(expires) ? expires : Date.now() + LINK_MS;
        keyState = "ok";
        await save();
        poll(app, link.accountId, a.pendingUntil);
        report();
        return { url: link.url };
      } catch (e) {
        throw personError(e);
      }
    });

    ctx.catalog.onSignOut(async (app) => {
      const a = apps[app];
      // At Composio first: when that fails nothing here changes, and the card keeps saying what is true.
      try {
        for (const id of [a?.accountId, a?.pending]) if (id) await api().deleteAccount(id);
      } catch (e) {
        throw personError(e);
      }
      bump(app);
      unregisterTools(app);
      if (a) {
        delete a.accountId;
        delete a.status;
        delete a.scopesMissing;
        delete a.pending;
        delete a.pendingUntil;
        // An app added from the chat leaves the catalog with its sign-in.
        if (a.added && !isKnown(app)) delete apps[app];
      }
      await save();
      report();
    });

    // A key stored, changed or removed, or the vault unlocked: read it again and check everything with it.
    const vaultChanged = () => {
      cachedKey = undefined;
      keyState = "missing";
      void resync();
    };
    ctx.events.on("vault.updated", (p: { ids?: string[] }) => {
      if (Array.isArray(p?.ids) && !p.ids.some((id) => id.replace(/^vault:\/\//, "") === "composio")) return;
      vaultChanged();
    });
    ctx.events.on("vault.state", vaultChanged);

    const needKey = () => text("Composio has no key yet: show its card (hub_integration_connect id composio) so the user stores one; the card says where to get it.", true);

    ctx.tools.register({
      name: "apps_search",
      effect: "read",
      source: true,
      description:
        "Find apps the user can connect through Composio, an outside service that signs in to them for the user (Slack, Trello, Notion, Salesforce, Jira… about a thousand). " +
        "Each line says whether Composio can sign in to it by itself and whether it is in the catalog already (composio:<slug>). " +
        "Prefer a native integration when the catalog has one (hub_integrations_list). To connect one: composio_app_add, then hub_integration_connect.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "The app's name or what it is for" } }, required: ["query"] },
      handler: async (input) => {
        if (!(await hasKey())) return needKey();
        try {
          const list = await api().toolkits(String(input.query ?? "").trim(), 10);
          if (!list.length) return text("Composio has no app like that.");
          return text(
            list
              .map((t) => {
                const where = ids().includes(t.slug) ? ` In the catalog as composio:${t.slug}${connected().includes(t.slug) ? ", connected" : ""}.` : "";
                return `${t.slug} — ${t.name}: ${t.description.slice(0, 160)} [${t.managed ? "Composio signs in by itself" : "Composio cannot sign in by itself: cannot be added"}]${where}`;
              })
              .join("\n"),
          );
        } catch (e) {
          return failure(e);
        }
      },
    });

    ctx.tools.register({
      name: "app_add",
      effect: "local-write",
      description:
        "Add an app found with composio_apps_search to the catalog as composio:<slug>, with Composio's badge (it goes through an outside service). " +
        "Then show its card with hub_integration_connect (id composio:<slug>) so the user signs in.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "The app's slug from composio_apps_search, e.g. trello" } }, required: ["app"] },
      handler: async (input) => {
        const slug = String(input.app ?? "").trim().toLowerCase();
        if (!APP_RE.test(slug)) return text("app must be a slug from composio_apps_search, e.g. trello.", true);
        if (ids().includes(slug)) return text(`${nameOf(slug)} is in the catalog already as composio:${slug}: show its card with hub_integration_connect.`);
        if (!(await hasKey())) return needKey();
        try {
          const kit = await api().toolkit(slug);
          if (!kit.managed) return text(`Composio cannot sign in to ${kit.name} by itself (it needs its own OAuth client or credentials), so it cannot be added.`, true);
          apps[slug] = { added: { name: kit.name || slug } };
          await save();
          report();
          return text(`Added ${kit.name} to the catalog as composio:${slug}, with Composio's badge. Show its card with hub_integration_connect id composio:${slug} so the user signs in.`);
        } catch (e) {
          return failure(e);
        }
      },
    });

    ctx.tools.register({
      name: "tools_search",
      effect: "read",
      source: true,
      description:
        "Search a Composio app's other tools: its main ones are tools of their own already (composio_<app>_…). Those found for a connected app become tools of their own too " +
        "(from your next step; composio_tool_run runs one by its slug meanwhile).",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "The app, e.g. slack (as in composio:slack)" }, query: { type: "string", description: "What the tool should do" } },
        required: ["app", "query"],
      },
      handler: async (input) => {
        const app = String(input.app ?? "").trim().toLowerCase().replace(/^composio:/, "");
        if (!(await hasKey())) return needKey();
        try {
          const list = await api().tools(app, { query: String(input.query ?? "").trim(), limit: 10 });
          if (!list.length) return text(`${nameOf(app)} has no tool like that.`);
          const live = connected().includes(app);
          const lines = list.map((t) => {
            const mine = (registered.get(app) ?? []).includes(toolName(t.slug));
            // Each one found becomes a tool of its own, with what it does to the world from its own tags.
            const own = mine ? toolName(t.slug) : live && (registered.get(app)?.length ?? 0) < MAX_APP_TOOLS ? addTool(app, t) : undefined;
            return `${t.slug} — ${t.name}${own ? ` (composio_${own})` : ""} (${effectOf(t.tags) === "read" ? "reads" : "changes something: asks the user"}): ${t.description.slice(0, 200)}\n  input: ${JSON.stringify(t.inputSchema).slice(0, 600)}`;
          });
          const note = live ? "" : `\n${nameOf(app)} is not connected yet: show its card with hub_integration_connect (id composio:${app}) first.`;
          return text(lines.join("\n") + note);
        } catch (e) {
          return failure(e, app);
        }
      },
    });

    ctx.tools.register({
      name: "tool_run",
      effect: "external",
      source: true,
      approvalSummary: "%approval.run%",
      description:
        "Run a tool of a connected Composio app by its slug (e.g. SLACK_LIST_REMINDERS, from composio_tools_search) with its arguments, on the user's account. It always asks the user first; " +
        "prefer the tool's own composio_<app>_… tool once it is there.",
      inputSchema: {
        type: "object",
        properties: { tool: { type: "string", description: "The tool's slug, e.g. SLACK_LIST_REMINDERS" }, arguments: { type: "object", description: "Its input, as composio_tools_search showed it" } },
        required: ["tool"],
      },
      handler: async (input) => {
        const slug = String(input.tool ?? "").trim().toUpperCase();
        const app = connected()
          .sort((x, y) => y.length - x.length)
          .find((a) => slug.startsWith(`${a.toUpperCase()}_`));
        if (!app) return text(`No connected Composio app has ${slug || "that tool"}: connected ones are ${connected().map((a) => `composio:${a}`).join(", ") || "none"}.`, true);
        return run(app, slug, undefined, input.arguments ?? {});
      },
    });

    ctx.tools.register({
      name: "triggers",
      effect: "read",
      source: true,
      description:
        "The events of the user's apps connected through Composio that a trigger can start on (Composio trigger types: a new Gmail message, a Slack message, a GitHub push…), each with its config schema. " +
        'To listen to one, trigger_create with on: [{ type: "composio.event", config: { trigger: "<SLUG>", config: { …that type\'s config… } } }] (config.app only when the slug does not start with the app). ' +
        "Instant ones arrive within seconds; polled ones (Gmail, Google Calendar…) take up to their polling interval, 2 minutes at the shortest.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "Only this connected app, e.g. gmail (as in composio:gmail)" } } },
      handler: async (input) => {
        if (!(await hasKey())) return needKey();
        const want = String(input?.app ?? "").trim().toLowerCase().replace(/^composio:/, "");
        const list = want ? connected().filter((a) => a === want) : connected();
        if (!list.length) {
          return want
            ? text(`${nameOf(want)} is not connected through Composio: show its card with hub_integration_connect (id composio:${want}) first.`, true)
            : text("No app is connected through Composio yet: show an app's card with hub_integration_connect (id composio:<app>) first.", true);
        }
        try {
          const types = await api().listTriggerTypes(list);
          if (!types.length) return text(`Composio has no events for ${list.map(nameOf).join(", ")}.`);
          let out = "";
          let shown = 0;
          for (const t of types) {
            const line = triggerLine(t, nameOf(t.toolkit || list[0]!));
            if (out.length + line.length > TRIGGERS_TEXT_MAX) break;
            out += `${line}\n`;
            shown++;
          }
          const more = shown < types.length ? `\n…and ${types.length - shown} more: ask for one app (app: …) to see them.` : "";
          return text(`${out}${more}\nListen with on: [{ type: "composio.event", config: { trigger, config } }]; a signal's data is the event's payload plus trigger, app and account.`);
        } catch (e) {
          return failure(e);
        }
      },
    });

    // The apps' events as a trigger source: by webhook when the hub has a public https address, else over Composio's
    // realtime channel.
    triggers = composioTriggers({
      ctx,
      api,
      hasKey,
      account: (app) => (apps[app]?.status === "ACTIVE" ? apps[app]!.accountId : undefined),
      apps: ids,
      nameOf,
      ...(PUSHER ? { pusherBase: PUSHER } : {}),
      ...(RECONNECT_MS && RECONNECT_MS > 0 ? { reconnectMs: RECONNECT_MS } : {}),
    });
    ctx.signals.provide("event", triggers.provider);
    ctx.http.handle((req) => triggers!.http(req));

    // The catalog first (no request to Composio needed), then where the accounts are.
    keyState = (await hasKey()) ? "ok" : "missing";
    report();
    void resync();
  },
  async deactivate() {
    plugin.stop?.();
    await triggers?.close();
  },
};

export default plugin;
