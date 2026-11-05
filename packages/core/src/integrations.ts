// The integrations library and the catalog: plugins whose manifest has an `integration` block, as cards with a live
// status. `google` ones depend on the hub's Google connection, `setup` ones on their setup card (secrets, channels),
// `none` ones only on being enabled. The core adds its own card first: access from anywhere (`remote`, remote.ts).
// The catalog groups the same cards by the situation in life they help with; the Plugins panel's catalog (`all`) has
// every plugin in it, those without an `integration` block as plain entries (a brain, or "other").
// A plugin may have entries of its own besides its card (`integration.entries`, plus those it reports: the Composio
// plugin's Slack, GitHub…), listed as "<plugin>:<entry>"; one going through an outside service (`integration.via`)
// carries that service's badge.

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { CatalogView, IntegrationInfo, IntegrationVia, IntegrationView, Locale, PiomioManifest } from "@piomio/shared";
import { toolPrefixOf } from "@piomio/shared";
import type { Hub } from "./app.ts";
import { localizePluginValue, tFor } from "./i18n.ts";
import type { PluginRecord } from "./plugins/host.ts";

/** The catalog's groups, in order: situations in life, the assistant's own abilities, brains. "other" collects the rest. */
export const SITUATIONS = ["everyday", "travel", "money", "work", "reading", "communication", "home", "assistant", "brains", "other"] as const;
export type Situation = (typeof SITUATIONS)[number];

/** Categories of manifests written before the catalog, by the situation they belong to. */
const LEGACY_CATEGORY: Record<string, Situation> = {
  access: "communication",
  calendar: "work",
  mail: "communication",
  messaging: "communication",
  search: "reading",
  browser: "work",
  files: "work",
};

/** The catalog group of a manifest's category. */
export function situationOf(category: string): Situation {
  return (SITUATIONS as readonly string[]).includes(category) ? (category as Situation) : (LEGACY_CATEGORY[category] ?? "other");
}

/** The scopes every enabled Google integration needs: one sign-in covers them all. */
export function googleScopes(hub: Hub): string[] {
  const out = new Set<string>();
  for (const r of hub.plugins.list()) {
    const i = r.layout?.manifest.integration;
    if (i?.connect === "google" && r.enabled) for (const s of i.scopes) out.add(s);
  }
  return [...out];
}

/** How a plugin without an `integration` block shows in the catalog: as a brain, or as something else. */
function plainIntegration(m: PiomioManifest): IntegrationInfo {
  const brain = m.contributes.brains.length > 0;
  return { category: brain ? "brains" : "other", icon: brain ? "brain" : "puzzle", connect: m.contributes.setup?.secrets.length ? "setup" : "none", scopes: [], localApp: false, entries: [] };
}

/** A logo the hub serves, at most: a 128×128 PNG is a few KB. */
export const MAX_LOGO_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The file of a card's logo (`integration.logo` or an entry's `logo`): a PNG inside the plugin's folder, small enough;
 * undefined for anything else, so a manifest cannot make the hub serve another file.
 */
export function logoFile(hub: Hub, id: string): string | undefined {
  const ref = entryRef(id);
  const r = hub.plugins.get(ref?.pluginId ?? id);
  const integ = r?.layout?.manifest.integration;
  const rel = ref ? integ?.entries.find((e) => e.id === ref.entryId)?.logo : integ?.logo;
  if (!r || !rel || !rel.toLowerCase().endsWith(".png")) return undefined;
  const root = resolve(r.dir);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep)) return undefined;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_LOGO_BYTES) return undefined;
    const head = Buffer.alloc(8);
    const fd = openSync(file, "r");
    try {
      readSync(fd, head, 0, 8, 0);
    } finally {
      closeSync(fd);
    }
    return head.equals(PNG_SIGNATURE) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** The address of a card's logo, with its version so a new file is fetched again; undefined when it has none. */
function logoUrl(hub: Hub, id: string): string | undefined {
  const file = logoFile(hub, id);
  if (!file) return undefined;
  const st = statSync(file);
  return `/api/integrations/${encodeURIComponent(id)}/logo?v=${Math.round(st.mtimeMs).toString(36)}${st.size.toString(36)}`;
}

const ENTRY_REF = /^([a-z][a-z0-9-]{1,40}):([a-z0-9][a-z0-9_-]{0,47})$/;

/** One of a plugin's entries ("composio:slack"): its plugin and its own id; undefined for anything else. */
export function entryRef(id: string): { pluginId: string; entryId: string } | undefined {
  const m = ENTRY_REF.exec(id);
  return m ? { pluginId: m[1]!, entryId: m[2]! } : undefined;
}

/** The badge of the outside service a plugin goes through, its note about `name` in the reader's language. */
function viaFor(r: PluginRecord, via: IntegrationVia | undefined, name: string, locale: Locale): IntegrationVia | undefined {
  if (!via) return undefined;
  const v = localizePluginValue(r.layout, via, locale);
  return { name: v.name, about: v.about.replaceAll("{name}", name), ...(v.link ? { link: v.link } : {}) };
}

/**
 * A plugin's entries as catalog cards: those of its manifest, then those it added (its last report). While the plugin
 * is off, only the manifest's, off; while it is broken, all broken; before it reports, waiting for its key or a sign-in.
 */
function entryViews(hub: Hub, r: PluginRecord, integ: IntegrationInfo, own: IntegrationView, locale: Locale): IntegrationView[] {
  const reported = r.enabled ? (hub.plugins.catalogOf(r.id) ?? []) : [];
  const state = new Map(reported.map((e) => [e.id, e]));
  const known = new Set(integ.entries.map((e) => e.id));
  const entries = [
    ...integ.entries,
    ...reported.filter((e) => !known.has(e.id) && e.name).map((e) => ({ id: e.id, name: e.name!, summary: e.summary, category: e.category ?? "other", icon: e.icon ?? "puzzle", example: e.example })),
  ];
  const keyMissing = () => hub.secrets.setupView(r.id, locale).secrets.some((s) => s.required && !s.present);
  const logo = (id: string) => {
    const url = logoUrl(hub, id);
    return url ? { logo: url } : undefined;
  };
  return entries.map((e) => {
    const s = state.get(e.id);
    const name = localizePluginValue(r.layout, e.name, locale);
    const via = viaFor(r, integ.via, name, locale);
    const view: IntegrationView = {
      id: `${r.id}:${e.id}`,
      name,
      summary: localizePluginValue(r.layout, e.summary ?? "", locale) || own.summary,
      category: situationOf(e.category),
      icon: e.icon,
      connect: s?.connect ?? (r.enabled && keyMissing() ? "setup" : "signin"),
      status: s?.status ?? "needs-setup",
      plugin: r.id,
      signinReturn: false,
      ...(via ? { via } : {}),
      ...(logo(`${r.id}:${e.id}`) ?? {}),
      ...(e.example ? { example: localizePluginValue(r.layout, e.example, locale) } : {}),
      ...(s?.account ? { account: s.account } : {}),
      ...(s?.detail ? { detail: localizePluginValue(r.layout, s.detail, locale) } : {}),
    };
    if (own.status === "off" || own.status === "unavailable") return { ...view, status: own.status, ...(own.detail ? { detail: own.detail } : {}) };
    if (own.status === "broken") return { ...view, status: "broken", ...(own.detail ? { detail: own.detail } : {}) };
    return view;
  });
}

/** The library's cards; with `all`, every plugin (the Plugins panel's catalog), not only those with an `integration` block. */
export async function listIntegrations(hub: Hub, locale: Locale, opts: { all?: boolean } = {}): Promise<IntegrationView[]> {
  const t = tFor(locale);
  const views: IntegrationView[] = [remoteIntegration(hub, locale)];
  for (const r of hub.plugins.list()) {
    if (!r.layout) continue;
    const integ = r.layout.manifest.integration ?? (opts.all ? plainIntegration(r.layout.manifest) : undefined);
    if (!integ) continue;
    const view: IntegrationView = {
      id: r.id,
      name: localizePluginValue(r.layout, r.layout.manifest.name, locale),
      summary: localizePluginValue(r.layout, integ.summary ?? r.layout.manifest.description, locale),
      category: situationOf(integ.category),
      icon: integ.icon,
      connect: integ.connect,
      status: "connected",
      ...(integ.example ? { example: localizePluginValue(r.layout, integ.example, locale) } : {}),
    };
    const logo = logoUrl(hub, r.id);
    if (logo) view.logo = logo;
    if (!r.enabled) view.status = "off";
    else if (integ.connect === "google") {
      const acc = hub.connections.get("google");
      if (!hub.connections.available("google")) Object.assign(view, { status: "unavailable", detail: t("connections.unavailable") });
      else if (!acc) view.status = "needs-setup";
      else if (acc.broken) Object.assign(view, { status: "broken", account: acc.account });
      // A sign-in from before this integration was added lacks its scopes: connect again to grant them.
      else if (!integ.scopes.every((s) => acc.scopes.includes(s))) Object.assign(view, { status: "needs-setup", account: acc.account });
      else view.account = acc.account;
    } else if (integ.connect === "setup") {
      const setup = hub.secrets.setupView(r.id, locale);
      const channels = await Promise.all(hub.channels.list().filter((c) => c.pluginId === r.id).map((c) => hub.channels.status(c.id)));
      const missing = setup.secrets.some((s) => s.required && !s.present);
      const down = channels.find((c) => !c.connected);
      if (missing || down) Object.assign(view, { status: "needs-setup", ...(down?.detail ? { detail: down.detail } : {}) });
      else if (channels[0]?.detail) view.account = channels[0].detail;
    }
    // Its MCP servers: one that failed to start says why; a sign-in is connected once every server of the plugin is.
    const servers = r.enabled ? hub.mcpClients.list().filter((s) => s.source === r.id) : [];
    // One the hub is reconnecting by itself is broken for now, never waiting for a sign-in: the sign-in is kept.
    const failed = servers.find((s) => s.status === "error" || s.status === "reconnecting");
    if (failed && view.status !== "unavailable") {
      const detail = failed.status === "reconnecting" ? t("mcp.reconnecting", { error: failed.error ?? "" }) : failed.error;
      Object.assign(view, { status: "broken", ...(detail ? { detail } : {}) });
    }
    else if (integ.connect === "signin" && r.enabled && (!servers.length || servers.some((s) => s.status !== "connected"))) view.status = "needs-setup";
    // Its process fell over: broken, whatever its connection says.
    if (r.enabled && (r.status === "crashed" || r.status === "error") && view.status !== "unavailable")
      Object.assign(view, { status: "broken", ...(r.lastError ? { detail: r.lastError } : {}) });
    // The outside service's own card (Composio) is the service itself: its badge is on the cards that go through it.
    const via = viaFor(r, integ.via, view.name, locale);
    if (via && via.name !== view.name) view.via = via;
    views.push(view);
    if (integ.entries.length || r.enabled) views.push(...entryViews(hub, r, integ, view, locale));
  }
  const rank = (c: string) => SITUATIONS.indexOf(situationOf(c));
  return views.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name, locale));
}

const POPULAR_MAX = 6;
const POPULAR_DAYS = 30;

/**
 * The catalog's popular entries, most popular first: those whose tools the agents called most in the last 30 days,
 * then the built-in plugins' own picks (`integration.popular`). An installed plugin cannot name itself popular.
 */
export function popularIds(hub: Hub, views: IntegrationView[], now = new Date()): string[] {
  const since = new Date(now.getTime() - POPULAR_DAYS * 86_400_000).toISOString();
  const owners = new Map(hub.tools.list().map((d) => [d.name, d.owner]));
  // A plugin that is off has no tools registered: its earlier calls are matched by its tool prefix.
  // An entry's tools are named after it (composio_slack_send_message): they count for the entry, not its plugin.
  const prefixes = hub.plugins
    .list()
    .flatMap((r) => {
      if (!r.layout) return [];
      const prefix = `${toolPrefixOf(r.layout.manifest)}_`;
      const entries = new Set([...(r.layout.manifest.integration?.entries ?? []).map((e) => e.id), ...(hub.plugins.catalogOf(r.id) ?? []).map((e) => e.id)]);
      return [{ id: r.id, prefix }, ...[...entries].map((e) => ({ id: `${r.id}:${e}`, prefix: `${prefix}${e.replace(/-/g, "_")}_` }))];
    })
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const uses = new Map<string, number>();
  for (const [tool, n] of hub.audit.countByTarget("policy.decision", since)) {
    // An entry's prefix counts only for its own plugin's tools (or tools no longer registered): another plugin cannot
    // take a tool's uses by naming an entry after it.
    const owner = owners.get(tool);
    const entry = prefixes.find((p) => p.id.includes(":") && tool.startsWith(p.prefix) && (!owner || p.id.startsWith(`${owner}:`)))?.id;
    const id = entry ?? owner ?? prefixes.find((p) => tool.startsWith(p.prefix))?.id;
    if (id) uses.set(id, (uses.get(id) ?? 0) + n);
  }
  const pick = (id: string) => {
    const ref = entryRef(id);
    const r = hub.plugins.get(ref?.pluginId ?? id);
    if (r?.source !== "builtin") return Infinity;
    const integ = r.layout?.manifest.integration;
    return (ref ? integ?.entries.find((e) => e.id === ref.entryId)?.popular : integ?.popular) ?? Infinity;
  };
  return views
    .filter((v) => v.status !== "unavailable" && ((uses.get(v.id) ?? 0) > 0 || pick(v.id) < Infinity))
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || pick(a.id) - pick(b.id))
    .slice(0, POPULAR_MAX)
    .map((v) => v.id);
}

/** The catalog: every card, grouped by situation in life (empty groups left out), with the groups' titles. */
export async function listCatalog(hub: Hub, locale: Locale, opts: { all?: boolean } = {}): Promise<CatalogView> {
  const t = tFor(locale);
  const views = await listIntegrations(hub, locale, opts);
  const sections = SITUATIONS.map((id) => ({ id, title: t(`catalog.section.${id}`), items: views.filter((v) => situationOf(v.category) === id) }));
  return { popular: popularIds(hub, views), sections: sections.filter((s) => s.items.length) };
}

/** The core's card: the hub's Tailscale node and its link. */
function remoteIntegration(hub: Hub, locale: Locale): IntegrationView {
  const t = tFor(locale);
  const r = hub.remote.view(locale);
  const view: IntegrationView = {
    id: "remote-access",
    name: t("remote.name"),
    summary: t("remote.summary"),
    category: "communication",
    icon: "globe",
    connect: "remote",
    status: "connected",
  };
  if (!r.available) return { ...view, status: "unavailable", ...(r.error ? { detail: r.error } : {}) };
  if (!r.enabled) return { ...view, status: "off" };
  if (r.state === "running") return { ...view, ...(r.url ? { account: r.url } : {}) };
  if (r.state === "error") return { ...view, status: "broken", ...(r.error ? { detail: r.error } : {}) };
  const step = r.state === "needs-login" ? t("remote.stepLogin") : r.state === "needs-funnel" ? t("remote.stepFunnel") : t(r.preparing ? "remote.preparing" : "remote.starting");
  return { ...view, status: "needs-setup", detail: r.error ?? step };
}
