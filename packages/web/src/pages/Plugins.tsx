// Plugins: a catalog of everything the hub can do. The popular ones come first, then the rest by category, with
// search and category chips; a row shows only what a plugin is and whether it is on. Everything else lives on the
// plugin's own page: the switch, what continues in the chat (connecting, fixing, "Try"), its setup and settings, and
// the technical view (permissions, capabilities, logs, restart, removal). Installing from a link ends the catalog.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, ChevronRight, Download, GitBranch, Power, RotateCw, Search, ShieldAlert, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import type { CatalogSection, IntegrationView } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { formatTime, type Tone } from "../lib/format";
import { chatStep, filterCatalog, findEntry, hasSwitch, hueOf, isOn, popularEntries, rowState } from "../lib/catalog";
import { STATUS_TONE } from "../lib/integrations";
import { hubEvents } from "../state/app";
import { useAsk } from "../state/ask";
import { loadCatalog, useCatalog } from "../state/catalog";
import { loadIntegrations } from "../state/integrations";
import { openPanelItem, panel, panelBack } from "../state/panel";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import { pluginLoad } from "../plugins/host";
import { usePluginRegistry } from "../plugins/slots";
import { Icon } from "../components/icon";
import { GoogleConnection, ServiceSignIn } from "../components/IntegrationCard";
import { RemoteAccessCard } from "../components/RemoteAccessCard";
import { SchemaForm } from "../components/SchemaForm";
import { ServiceLogo } from "../components/ServiceLogo";
import { ViaBadge } from "../components/ViaBadge";
import { PluginSetupCard } from "../components/SecretCards";
import { Badge, Button, cx, EmptyState, ErrorNote, Field, Input, Loading, Modal, Page, Spinner, Toggle } from "../components/ui";

interface Permissions {
  network: string[];
  vault: string[];
  core: string[];
  ui: string[];
  fs: string[];
}

interface PluginView {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: "builtin" | "installed";
  enabled: boolean;
  status: string;
  lastError?: string;
  formats: string[];
  permissions: Permissions;
  contributes?: { tools?: boolean; brains?: string[]; channels?: string[]; triggers?: string[]; hooks?: string[]; http?: boolean; settings?: Record<string, unknown>; setup?: { secrets?: unknown[] } };
  settings: Record<string, unknown>;
  hasUi: boolean;
  hasServer: boolean;
  commitHash?: string;
}

interface InstallPreview {
  stagingId: string;
  manifest: { id: string; name: string; version: string; description: string; author?: string };
  formats: string[];
  permissions: Permissions;
  commitHash?: string;
  warnings: string[];
  hasServer: boolean;
  hasUi: boolean;
}

const STATUS: Record<string, { key: MessageKey; tone: Tone }> = {
  running: { key: "plugins.status.running", tone: "success" },
  starting: { key: "plugins.status.starting", tone: "info" },
  stopped: { key: "plugins.status.stopped", tone: "neutral" },
  crashed: { key: "plugins.status.crashed", tone: "danger" },
  disabled: { key: "plugins.status.disabled", tone: "neutral" },
  "no-server": { key: "plugins.status.noServer", tone: "neutral" },
  error: { key: "plugins.status.error", tone: "danger" },
};

const PERM_LABELS: Record<keyof Permissions, MessageKey> = {
  network: "plugins.perm.network",
  vault: "plugins.perm.vault",
  core: "plugins.perm.core",
  ui: "plugins.perm.ui",
  fs: "plugins.perm.fs",
};

const UI_STATUS: Record<"loading" | "active" | "error", MessageKey> = { loading: "plugins.ui.loading", active: "plugins.ui.active", error: "plugins.ui.error" };

const ROW_STATE: Record<"on" | "attention" | "broken", { key: MessageKey; tone: string }> = {
  on: { key: "plugins.state.on", tone: "success" },
  attention: { key: "plugins.state.attention", tone: "warning" },
  broken: { key: "plugins.state.broken", tone: "danger" },
};

const STEP_LABEL: Record<"connect" | "fix" | "settings", MessageKey> = { connect: "catalog.connect", fix: "catalog.fix", settings: "catalog.settingsInChat" };
const STEP_ASK: Record<"connect" | "fix" | "settings", MessageKey> = { connect: "catalog.ask.connect", fix: "catalog.ask.fix", settings: "catalog.ask.settings" };
const STATUS_LINE: Partial<Record<IntegrationView["status"], MessageKey>> = {
  "needs-setup": "integrations.status.needsSetup",
  broken: "integrations.status.broken",
  unavailable: "integrations.status.unavailable",
};

export function PluginsPage() {
  const p = useStore(panel);
  return p.item ? <PluginPage key={p.item} id={p.item} /> : <PluginCatalog />;
}

/** A plugin's icon on its category's tint, or the service's own logo. */
function PluginIcon({ v, situation, size = "md" }: { v: IntegrationView; situation: string; size?: "md" | "lg" }) {
  const hue = hueOf(situation);
  const icon = (
    <span
      className={cx("flex shrink-0 items-center justify-center", size === "lg" ? "size-14 rounded-2xl" : "size-10 rounded-xl")}
      style={{ background: `color-mix(in srgb, ${hue} ${isOn(v) ? 16 : 10}%, transparent)`, color: hue }}
      aria-hidden
    >
      <Icon name={v.icon} className={size === "lg" ? "size-7" : "size-5"} />
    </span>
  );
  // A real service shows its own logo; abilities (weather, currencies…) keep their icon.
  return <ServiceLogo logo={v.logo} size={size} fallback={icon} />;
}

/** Whether a plugin is on, waiting for the person or broken; nothing for one that is off. `compact`: the dot alone. */
function StateMark({ v, compact }: { v: IntegrationView; compact?: boolean }) {
  const s = rowState(v);
  if (!s) return null;
  const { key, tone } = ROW_STATE[s];
  if (compact)
    return s === "on" ? (
      <CheckCircle2 className="size-4 shrink-0 text-success" aria-label={t(key)} />
    ) : (
      <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: `var(--${tone})` }} title={t(key)} aria-label={t(key)} role="img" />
    );
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs" style={{ color: `var(--${s === "on" ? "muted" : tone})` }}>
      <span className="size-1.5 rounded-full" style={{ background: `var(--${tone})` }} />
      {t(key)}
    </span>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{children}</h3>;
}

function PopularTile({ v, situation }: { v: IntegrationView; situation: string }) {
  return (
    <button
      type="button"
      onClick={() => openPanelItem("plugins", v.id)}
      className="press flex min-w-0 flex-col gap-2.5 rounded-2xl border border-border bg-surface p-3 text-left shadow-card transition-colors hover:bg-surface-2/60"
    >
      <div className="flex items-start justify-between gap-2">
        <PluginIcon v={v} situation={situation} />
        <StateMark v={v} compact />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[14px] font-medium">{v.name}</span>
          {v.via && <ViaBadge via={v.via} />}
        </div>
        <p className="line-clamp-2 text-xs leading-snug text-muted">{v.summary}</p>
      </div>
    </button>
  );
}

function CatalogRow({ v, situation }: { v: IntegrationView; situation: string }) {
  return (
    <button type="button" onClick={() => openPanelItem("plugins", v.id)} className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2/60">
      <PluginIcon v={v} situation={situation} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{v.name}</span>
          {v.via && <ViaBadge via={v.via} />}
        </div>
        <p className="truncate text-[13px] text-muted">{v.summary}</p>
      </div>
      <StateMark v={v} />
      <ChevronRight className="size-4 shrink-0 text-muted/60 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function PluginCatalog() {
  const c = useCatalog();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const [error, setError] = useState<string>();
  const [installOpen, setInstallOpen] = useState(false);
  const retry = () => loadCatalog().then(() => setError(undefined), (e) => setError(errorText(e)));
  const searching = query.trim().length > 0;
  const chosen: CatalogSection[] = c ? (category ? c.sections.filter((s) => s.id === category) : c.sections) : [];
  const sections = filterCatalog(chosen, query);
  const popular = c && !searching && !category ? popularEntries(c) : [];

  return (
    <Page title={t("nav.plugins")}>
      {error && <ErrorNote onRetry={() => void retry()}>{error}</ErrorNote>}
      {!c && !error && <Loading />}
      {c && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" />
              <Input
                type="search"
                value={query}
                onChange={(e) => {
                  // A search looks through the whole catalog.
                  setQuery(e.target.value);
                  setCategory(undefined);
                }}
                placeholder={t("plugins.search")}
                aria-label={t("plugins.search")}
                className="h-10 rounded-full border-transparent! bg-surface-2! pl-10 focus:border-accent! focus:bg-surface!"
              />
            </div>
            <div className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-5 sm:px-5" role="tablist" aria-label={t("plugins.categories")}>
              {[{ id: undefined, title: t("plugins.all") }, ...c.sections.map((s) => ({ id: s.id as string | undefined, title: s.title }))].map((s) => (
                <button
                  key={s.id ?? "all"}
                  type="button"
                  role="tab"
                  aria-selected={category === s.id}
                  onClick={() => setCategory(s.id)}
                  className={cx(
                    "press inline-flex h-8 shrink-0 items-center rounded-full px-3 text-[13px] font-medium whitespace-nowrap",
                    category === s.id ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {s.title}
                </button>
              ))}
            </div>
          </div>

          {popular.length > 0 && (
            <section aria-label={t("plugins.popular")}>
              <SectionTitle>{t("plugins.popular")}</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {popular.map(({ entry, situation }) => (
                  <PopularTile key={entry.id} v={entry} situation={situation} />
                ))}
              </div>
            </section>
          )}

          {!sections.length && <EmptyState icon="search" title={t("common.nothingFound")} />}
          {sections.map((s) => (
            <section key={s.id} aria-label={s.title}>
              {!category && <SectionTitle>{s.title}</SectionTitle>}
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {s.items.map((v) => (
                  <CatalogRow key={v.id} v={v} situation={s.id} />
                ))}
              </div>
            </section>
          ))}

          <button type="button" onClick={() => setInstallOpen(true)} className="flex items-center gap-1.5 self-center px-2 py-1 text-xs text-muted transition hover:text-fg">
            <Download className="size-3.5" />
            {t("plugins.installFromLink")}
          </button>
        </div>
      )}
      {installOpen && (
        <InstallModal
          onClose={() => setInstallOpen(false)}
          onInstalled={(id) => {
            setInstallOpen(false);
            void loadCatalog().then(() => openPanelItem("plugins", id));
          }}
        />
      )}
    </Page>
  );
}

/** A plugin's own page: everything about it, set up here or in the chat. */
function PluginPage({ id }: { id: string }) {
  const c = useCatalog();
  const ask = useAsk();
  const { settings: sections } = usePluginRegistry();
  const uiLoad = useStore(pluginLoad);
  // undefined: loading; null: not a plugin (the core's access from anywhere) or gone.
  const [plugin, setPlugin] = useState<PluginView | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [removing, setRemoving] = useState(false);
  // Turned on here: its "Try" appears with a little motion.
  const [fresh, setFresh] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.get<PluginView[]>("/api/plugins");
      setPlugin(list.find((p) => p.id === id) ?? null);
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    return hubEvents.on((e) => {
      if (e.type === "plugins.updated") void load();
    });
  }, [load]);

  const found = c ? findEntry(c, id) : undefined;
  if (error) return <div className="px-4 py-4 sm:px-5"><ErrorNote onRetry={() => void load()}>{error}</ErrorNote></div>;
  if (!c || plugin === undefined) return <Loading />;
  if (!found && !plugin)
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8">
        <EmptyState icon="puzzle" title={t("plugins.gone")} />
        <Button size="sm" onClick={panelBack}>
          {t("common.back")}
        </Button>
      </div>
    );

  // A plugin the catalog cannot show (its manifest failed to load) still gets its technical page.
  const v: IntegrationView = found?.entry ?? {
    id,
    name: plugin!.name,
    summary: plugin!.description ?? "",
    category: "other",
    icon: "puzzle",
    connect: "none",
    status: plugin!.enabled ? (plugin!.lastError ? "broken" : "connected") : "off",
  };
  const situation = found?.situation ?? "other";
  const sectionTitle = c.sections.find((s) => s.id === situation)?.title;
  const step = chatStep(v);
  const on = isOn(v);
  const status = STATUS_LINE[v.status];
  const ui = plugin ? uiLoad[plugin.id] : undefined;
  const hasSetup = !!plugin?.enabled && (!!plugin.contributes?.setup?.secrets?.length || sections.some((s) => s.pluginId === id));
  const hasSettings = !!plugin?.contributes?.settings && Object.keys(plugin.contributes.settings).length > 0;

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, "success");
      await Promise.all([load(), loadCatalog(), loadIntegrations().catch(() => {})]);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };

  const toggle = (next: boolean) =>
    run("enabled", async () => {
      await api.post(`/api/plugins/${encodeURIComponent(id)}/enabled`, { enabled: next });
      setFresh(next);
    });

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3.5">
        <PluginIcon v={v} situation={situation} size="lg" />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-display text-lg leading-tight font-semibold">{v.name}</h3>
            {v.via && <ViaBadge via={v.via} />}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {[sectionTitle, plugin && (plugin.source === "builtin" ? t("plugins.builtin") : t("plugins.installedByYou")), plugin?.version && `v${plugin.version}`].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      {v.summary && <p className="text-sm leading-relaxed text-fg/90">{v.summary}</p>}

      {(plugin?.lastError || ui?.error) && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{plugin?.lastError ?? `UI: ${ui?.error}`}</span>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t(on ? "plugins.isOn" : "plugins.isOff")}</div>
            {status && (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs" style={{ color: `var(--${STATUS_TONE[v.status] === "neutral" ? "muted" : STATUS_TONE[v.status]})` }}>
                <span className="size-1.5 shrink-0 rounded-full bg-current" />
                <span className="min-w-0 break-words">{v.status === "unavailable" && v.detail ? v.detail : t(status)}</span>
              </p>
            )}
            {v.account && v.status === "connected" && v.connect !== "remote" && (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                <span className="truncate">{v.account}</span>
              </p>
            )}
          </div>
          {busy === "enabled" ? (
            <Spinner size={18} />
          ) : hasSwitch(v) ? (
            <Toggle checked={on} onChange={(next) => void toggle(next)} label={<span className="sr-only">{t(on ? "catalog.turnOff" : "catalog.turnOn", { name: v.name })}</span>} />
          ) : null}
        </div>
        {(step || (on && v.example && v.status === "connected")) && (
          <div className="flex flex-wrap items-center gap-2">
            {step && (
              <Button size="sm" variant={step === "settings" ? "ghost" : "primary"} onClick={() => ask(t(STEP_ASK[step], { name: v.name }))}>
                {t(STEP_LABEL[step])}
                <ArrowRight className="size-3.5" />
              </Button>
            )}
            {on && v.example && v.status === "connected" && (
              <button
                type="button"
                onClick={() => ask(v.example!)}
                className={cx("inline-flex max-w-full items-start gap-1.5 rounded-xl border border-border bg-surface-2/60 px-2.5 py-1.5 text-left text-xs leading-snug text-fg transition hover:bg-surface-2", fresh && "animate-in")}
                title={t("catalog.tryHint")}
              >
                <Sparkles className="mt-px size-3.5 shrink-0" style={{ color: hueOf(situation) }} />
                <span className="line-clamp-2">{t("catalog.try", { example: v.example })}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {v.connect === "remote" && <RemoteAccessCard />}
      {v.connect === "google" && on && v.status !== "unavailable" && <GoogleConnection view={v} />}
      {v.connect === "signin" && on && <ServiceSignIn view={v} />}
      {/* One of a plugin's entries waiting for the plugin's key (Composio's): its field, here and now. */}
      {v.plugin && v.connect === "setup" && on && <PluginSetupCard pluginId={v.plugin} bare />}

      {hasSetup && (
        <Disclosure title={t("plugins.setup")} open={v.status === "needs-setup" || v.status === "broken"}>
          <PluginSetupCard pluginId={id} bare />
        </Disclosure>
      )}

      {hasSettings && plugin && (
        <Disclosure title={t("plugins.settings")}>
          <SchemaForm
            schema={plugin.contributes?.settings}
            value={plugin.settings}
            onSubmit={async (value) => {
              await api.put(`/api/plugins/${encodeURIComponent(id)}/settings`, value);
              toast(t("common.settingsSaved"), "success");
              await load();
            }}
          />
        </Disclosure>
      )}

      {plugin && (
        <Disclosure title={t("plugins.about")}>
          <div className="flex flex-col gap-3">
            {plugin.description && plugin.description !== v.summary && <p className="text-sm text-muted">{plugin.description}</p>}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {(() => {
                const known = STATUS[plugin.status];
                return (
                  <Badge tone={known?.tone ?? "neutral"} dot>
                    {known ? t(known.key) : plugin.status}
                  </Badge>
                );
              })()}
              {plugin.hasUi && ui && <Badge tone={ui.status === "error" ? "danger" : ui.status === "active" ? "success" : "neutral"}>{t(UI_STATUS[ui.status])}</Badge>}
              {plugin.formats.map((f) => (
                <Badge key={f} tone="info">
                  {f}
                </Badge>
              ))}
            </div>
            <div className="font-mono text-xs text-muted">
              {plugin.id}
              {plugin.commitHash && (
                <span className="ml-2 inline-flex items-center gap-1">
                  <GitBranch className="size-3" />
                  {plugin.commitHash.slice(0, 8)}
                </span>
              )}
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium">{t("plugins.capabilities")}</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <PermissionList p={plugin.permissions} />
                <div className="flex flex-wrap content-start gap-1 text-xs">
                  {plugin.contributes?.tools && <Badge>{t("plugins.cap.tools")}</Badge>}
                  {plugin.contributes?.http && <Badge>http</Badge>}
                  {plugin.hasServer && <Badge>{t("plugins.cap.process")}</Badge>}
                  {plugin.hasUi && <Badge>UI</Badge>}
                  {plugin.contributes?.brains?.map((b) => <Badge key={b}>{t("plugins.cap.brain", { name: b })}</Badge>)}
                  {plugin.contributes?.channels?.map((ch) => <Badge key={ch}>{t("plugins.cap.channel", { name: ch })}</Badge>)}
                  {plugin.contributes?.triggers?.map((tr) => <Badge key={tr}>{t("plugins.cap.trigger", { name: tr })}</Badge>)}
                </div>
              </div>
            </div>
          </div>
        </Disclosure>
      )}

      {plugin?.hasServer && (
        <Disclosure title={t("plugins.logs")} lazy>
          <PluginLogs id={id} />
        </Disclosure>
      )}

      {plugin && ((plugin.hasServer && plugin.enabled) || plugin.source === "installed") && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {plugin.hasServer && plugin.enabled && (
            <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} loading={busy === "restart"} onClick={() => void run("restart", () => api.post(`/api/plugins/${encodeURIComponent(id)}/restart`, {}), t("plugins.restarted"))}>
              {t("plugins.restart")}
            </Button>
          )}
          {plugin.source === "installed" && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(true)}>
              {t("common.delete")}
            </Button>
          )}
        </div>
      )}

      <Modal
        open={removing}
        onClose={() => setRemoving(false)}
        title={t("plugins.removeTitle", { name: v.name })}
        footer={
          <>
            <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setRemoving(false);
                void api.del(`/api/plugins/${encodeURIComponent(id)}`).then(
                  () => {
                    toast(t("plugins.removed"), "success");
                    panelBack();
                    void loadCatalog();
                  },
                  (e) => toast(errorText(e), "error"),
                );
              }}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("plugins.removeText")}</p>
      </Modal>
    </div>
  );
}

/** A part of a plugin's page that opens when wanted; `lazy` mounts its body only once opened. */
function Disclosure({ title, open: initial = false, lazy, children }: { title: string; open?: boolean; lazy?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <details open={initial} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group rounded-2xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronRight className="size-4 shrink-0 text-muted/70 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-border px-3.5 py-3">{!lazy || open ? children : null}</div>
    </details>
  );
}

function PermissionList({ p }: { p: Permissions }) {
  const rows = (Object.keys(PERM_LABELS) as Array<keyof Permissions>).filter((k) => p?.[k]?.length);
  if (!rows.length) return <div className="text-xs text-muted">{t("plugins.perm.none")}</div>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map((k) => (
        <div key={k} className="contents">
          <dt className="text-muted">{t(PERM_LABELS[k])}</dt>
          <dd className="flex flex-wrap gap-1">
            {p[k].map((val) => (
              <code key={val} className={cx("rounded bg-surface-2 px-1.5 py-0.5 font-mono", (val === "*" || val === "approvals.resolve") && "bg-warning-soft text-warning")}>
                {val}
              </code>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PluginLogs({ id }: { id: string }) {
  const [logs, setLogs] = useState<Array<{ ts: string; level: string; msg: string }> | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.get<Array<{ ts: string; level: string; msg: string }>>(`/api/plugins/${encodeURIComponent(id)}/logs`).then(setLogs, (e) => setError(errorText(e)));
  }, [id]);
  useEffect(load, [load]);
  return (
    <div className="flex flex-col gap-2">
      {error && <ErrorNote>{error}</ErrorNote>}
      {!logs && !error && <Spinner />}
      {logs && logs.length === 0 && <div className="text-sm text-muted">{t("plugins.noLogs")}</div>}
      {logs && logs.length > 0 && (
        <pre className="max-h-[50vh] overflow-auto rounded-xl bg-code-bg p-3 font-mono text-xs leading-relaxed">
          {logs.map((l, i) => (
            <div key={i} className={cx("break-words whitespace-pre-wrap", l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "")}>
              <span className="text-muted">{formatTime(l.ts)} </span>
              {l.msg}
            </div>
          ))}
        </pre>
      )}
      <div>
        <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} onClick={load}>
          {t("common.refresh")}
        </Button>
      </div>
    </div>
  );
}

function InstallModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: (id: string) => void }) {
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [agree, setAgree] = useState(false);

  const prepare = async () => {
    if (!source.trim()) return setError(t("plugins.needSource"));
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await api.post<InstallPreview>("/api/plugins/install", { source: source.trim() }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post("/api/plugins/install/confirm", { stagingId: preview.stagingId });
      toast(t("plugins.installed", { name: preview.manifest.name }), "success");
      onInstalled(preview.manifest.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={preview ? t("plugins.installConfirmTitle", { name: preview.manifest.name }) : t("plugins.installTitle")}
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)}>{t("common.back")}</Button>
            <Button variant="primary" icon={<Power className="size-4" />} onClick={() => void confirm()} loading={busy} disabled={preview.warnings.length > 0 && !agree}>
              {t("plugins.installConfirm")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={() => void prepare()} loading={busy}>
              {t("common.check")}
            </Button>
          </>
        )
      }
    >
      {!preview ? (
        <div className="flex flex-col gap-4">
          <Field label={t("plugins.source")} hint={t("plugins.sourceHint")}>
            <Input
              autoFocus
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://github.com/user/piomio-plugin.git"
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") void prepare();
              }}
            />
          </Field>
          <p className="text-xs text-muted">{t("plugins.stagingNote")}</p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{preview.manifest.name}</span>
              <span className="font-mono text-xs text-muted">
                {preview.manifest.id} v{preview.manifest.version}
              </span>
              {preview.formats.map((f) => (
                <Badge key={f} tone="info">
                  {f}
                </Badge>
              ))}
            </div>
            {preview.manifest.description && <p className="mt-1 text-sm text-muted">{preview.manifest.description}</p>}
            <div className="mt-1 text-xs text-muted">
              {preview.manifest.author && <>{t("plugins.author", { name: preview.manifest.author })} · </>}
              {preview.hasServer ? t("plugins.hasServer") : t("plugins.noServer")} · {preview.hasUi ? t("plugins.hasUi") : t("plugins.noUi")}
              {preview.commitHash && <> · {t("plugins.commit", { hash: preview.commitHash.slice(0, 10) })}</>}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium">{t("plugins.permissions")}</div>
            <PermissionList p={preview.permissions} />
          </div>
          {preview.warnings.length > 0 && (
            <div className="rounded-xl border border-warning/40 bg-warning-soft/60 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-warning">
                <ShieldAlert className="size-4" /> {t("plugins.attention")}
              </div>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <div className="mt-3">
                <Toggle checked={agree} onChange={setAgree} label={t("plugins.trust")} />
              </div>
            </div>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Modal>
  );
}
