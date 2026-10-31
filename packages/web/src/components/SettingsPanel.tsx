// The settings panel: every section that is not the conversation, opened beside the chat (docked on wide screens,
// full-screen on phones). The home view lists the sections; a section renders its page in compact form.

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, LogOut, MessageCircleMore, ShieldCheck, X } from "lucide-react";
import { useStore } from "../lib/store";
import { logout, session } from "../state/app";
import { closePanel, openPanel, panel, panelBack } from "../state/panel";
import { usePluginRegistry } from "../plugins/slots";
import { PluginBoundary } from "../plugins/boundary";
import { t } from "../i18n";
import { AVATAR_PALETTE } from "@piomio/shared/avatar";
import type { AvatarColor } from "@piomio/shared";
import { Icon } from "./icon";
import { cx, EmbeddedPage, IconButton } from "./ui";
import { GROUPS, SECTIONS, sectionDef, type PanelSection } from "./nav";
import { AgentsPage } from "../pages/Agents";
import { BrainsPage } from "../pages/Brains";
import { PluginsPage } from "../pages/Plugins";
import { MachinesPage } from "../pages/Machines";
import { DevicesPage } from "../pages/Devices";
import { McpPage } from "../pages/Mcp";
import { InboxPage } from "../pages/Inbox";
import { SkillsPage } from "../pages/Skills";
import { SettingsPage } from "../pages/Settings";
import { TasksPage } from "../pages/Tasks";

function SectionBody({ section }: { section: PanelSection }) {
  const { routes } = usePluginRegistry();
  switch (section) {
    case "agents":
      return <AgentsPage />;
    case "brains":
      return <BrainsPage />;
    case "plugins":
      return <PluginsPage />;
    case "machines":
      return <MachinesPage />;
    case "devices":
      return <DevicesPage />;
    case "mcp":
      return <McpPage />;
    case "notifications":
      return <InboxPage />;
    case "skills":
      return <SkillsPage />;
    case "settings":
      return <SettingsPage />;
    case "tasks":
      return <TasksPage />;
  }
  const route = routes.find((r) => `plugin:${r.key}` === section);
  if (!route) return null;
  const C = route.component;
  return (
    <PluginBoundary key={route.key} pluginId={route.pluginId}>
      <C pluginId={route.pluginId} />
    </PluginBoundary>
  );
}

/** Each section's tile, in the agents' candy palette, as in the phone's own Settings. */
const TILE: Record<string, AvatarColor> = {
  agents: "violet",
  skills: "pink",
  tasks: "blue",
  notifications: "red",
  brains: "indigo",
  plugins: "orange",
  machines: "slate",
  devices: "green",
  mcp: "amber",
  settings: "slate",
  console: "green",
  plugin: "amber",
};

function Tile({ color, children }: { color: AvatarColor; children: ReactNode }) {
  const p = AVATAR_PALETTE[color];
  return (
    <span
      className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(0_0_0/0.12)]"
      style={{ background: `linear-gradient(180deg, ${p.top}, ${p.bottom})` }}
    >
      {children}
    </span>
  );
}

/** One section: its tile and name; what it holds is the row's tooltip (the list stays short). */
function Row({ icon, color, label, hint, onClick, href }: { icon: ReactNode; color: AvatarColor; label: string; hint?: string; onClick?: () => void; href?: string }) {
  const inner = (
    <>
      <Tile color={color}>{icon}</Tile>
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{label}</span>
      {href ? <ExternalLink className="size-4 shrink-0 text-muted/70" /> : <ChevronRight className="size-4 shrink-0 text-muted/60 transition-transform group-hover:translate-x-0.5" />}
    </>
  );
  const cls = "group flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2/70";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls} title={hint}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={cls} title={hint}>
      {inner}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <div className="px-3 pb-1.5 text-[12px] font-medium text-muted">{label}</div>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:top-0 [&>*+*]:before:right-0 [&>*+*]:before:left-[54px] [&>*+*]:before:h-px [&>*+*]:before:bg-border [&>*+*]:before:content-['']">
        {children}
      </div>
    </section>
  );
}

function Home() {
  const s = useStore(session);
  const { routes } = usePluginRegistry();
  const pluginPages = routes.filter((r) => r.nav && !r.path.includes(":"));
  return (
    <div className="flex flex-col gap-5 px-4 pt-2 pb-6 sm:px-5">
      <div className="flex items-start gap-2.5 px-1 text-[13px] leading-relaxed text-muted">
        <MessageCircleMore className="mt-0.5 size-4 shrink-0 text-accent-text" />
        <span>{t("panel.askHint")}</span>
      </div>
      {GROUPS.map((g) => {
        const items = SECTIONS.filter((x) => x.group === g.id);
        const extra = g.id === "assistant" ? pluginPages : [];
        return (
          <Group key={g.id} label={t(g.label)}>
            {items.map((x) => (
              <Row key={x.id} icon={<x.icon className="size-[17px]" />} color={TILE[x.id] ?? "slate"} label={t(x.label)} hint={t(x.hint)} onClick={() => openPanel(x.id)} />
            ))}
            {extra.map((r) => (
              <Row
                key={r.key}
                icon={<Icon name={r.icon} className="size-[17px]" />}
                color={TILE.plugin}
                label={r.title}
                hint={t("panel.hint.plugin", { plugin: r.pluginId })}
                onClick={() => openPanel(`plugin:${r.key}`)}
              />
            ))}
            {g.id === "general" && s && (
              <>
                <Row icon={<ShieldCheck className="size-[17px]" />} color={TILE.console} label={t("common.securityConsole")} hint={t("panel.hint.console")} href={s.consoleUrl} />
                <button type="button" onClick={() => void logout()} className="flex w-full items-center gap-3 px-3 py-2 text-left text-[14px] font-medium text-danger transition-colors hover:bg-surface-2/70">
                  <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-danger-soft">
                    <LogOut className="size-[17px]" />
                  </span>
                  {t("common.logout")}
                </button>
              </>
            )}
          </Group>
        );
      })}
    </div>
  );
}

export function SettingsPanel() {
  const p = useStore(panel);
  const { routes } = usePluginRegistry();
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog][aria-modal=true]")) closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.open]);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [p.section, p.item]);

  if (!p.open) return null;
  const home = p.section === "home";
  const def = p.section === "home" ? undefined : sectionDef(p.section);
  const route = !home && !def ? routes.find((r) => `plugin:${r.key}` === p.section) : undefined;
  const title = home ? t("nav.settings") : def ? t(def.label) : (route?.title ?? t("nav.settings"));

  // A link inside a section that leads to a conversation or task closes the panel while it covers the chat: a full
  // screen on phones, a sheet over the chat on mid-size windows. Next to the chat only from 1280px, where both fit.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[href^='/']");
    if (a && window.matchMedia("(max-width: 1279px)").matches) closePanel();
  };

  return (
    <>
      <div className="animate-fade fixed inset-0 z-30 hidden bg-[rgb(20_14_6/0.22)] backdrop-blur-[2px] md:block xl:hidden" onClick={closePanel} aria-hidden />
      <aside
        aria-label={t("nav.settings")}
        className="animate-slide fixed inset-0 z-40 flex flex-col overflow-hidden bg-bg md:inset-y-2 md:right-2 md:left-auto md:w-[540px] md:max-w-[calc(100vw-5rem)] md:rounded-[22px] md:shadow-pop xl:relative xl:inset-auto xl:z-auto xl:my-2 xl:mr-2 xl:max-w-none xl:shrink-0 xl:shadow-sheet 2xl:w-[600px]"
        onClick={onClick}
      >
        <div className="glass flex h-12 shrink-0 items-center gap-1 px-2">
          {!home && (
            <IconButton label={t("common.back")} onClick={panelBack} className="size-8">
              <ArrowLeft className="size-[18px]" />
            </IconButton>
          )}
          <h2 key={title} className={cx("animate-fade min-w-0 flex-1 truncate text-[15px] font-semibold", home && "pl-2")}>
            {title}
          </h2>
          <IconButton label={t("layout.closePanel")} onClick={closePanel} className="size-8">
            <X className="size-[18px]" />
          </IconButton>
        </div>
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
          <EmbeddedPage.Provider value={true}>{home ? <Home /> : <SectionBody section={p.section as PanelSection} />}</EmbeddedPage.Provider>
        </div>
      </aside>
    </>
  );
}
