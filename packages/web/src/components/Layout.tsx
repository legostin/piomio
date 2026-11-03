// App shell, kept minimal: the team on the left, right on the canvas (each agent with its dialog, then group chats,
// then the machines and what runs there; a drawer on phones), and the current view as a sheet of paper floating on the
// canvas, with the settings panel as a second sheet beside it. Views put their own slim top bar (TopBar): the view's
// own content and only the status that needs the person right now.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Inbox, ListChecks, Menu, PanelRight, Settings, X } from "lucide-react";
import { useStore } from "../lib/store";
import { ACTIVE_STATUSES } from "../lib/format";
import { agentForPath, chatForPath } from "../lib/team";
import { feedForPath } from "../lib/feeds";
import { connection, ensureTasks, session, tasks } from "../state/app";
import { openPanel, panel, togglePanel } from "../state/panel";
import { PluginSidebarItems, PluginStatusItems, RightPane, SidebarPanels, usePluginRegistry, useSlot } from "../plugins/slots";
import { liveWindow, liveWindowActions } from "../plugins/liveview";
import { cx, IconButton } from "./ui";
import { dragRegion } from "../lib/desktop";
import { ApprovalsBadge, ConnectionBadge, VaultBadge } from "./StatusBadges";
import { CommandPalette } from "./CommandPalette";
import { Icon } from "./icon";
import { LiveViewWindow } from "./LiveViewWindow";
import { SettingsPanel } from "./SettingsPanel";
import { AppUpdateButton, MachinesBlock } from "./MachinesBlock";
import { OwlMark, type OwlMood } from "./OwlMark";
import { TeamList } from "../pages/chat/TeamList";
import { t } from "../i18n";
import { AppVersion } from "./AppVersion";

interface Shell {
  openDrawer: () => void;
  pane: boolean;
  togglePane: () => void;
}
const ShellContext = createContext<Shell>({ openDrawer: () => {}, pane: false, togglePane: () => {} });

/** The owl in the corner: its eyes say whether the hub answers. */
function Brand() {
  const c = useStore(connection);
  const s = useStore(session);
  const mood: OwlMood = c === "open" ? "awake" : c === "offline" ? "asleep" : "sleepy";
  return (
    <div {...dragRegion()} className="flex px-4 pt-4 pb-3 titlebar:pt-[18px] titlebar:pl-[100px]">
      <Link href="/" className="flex items-center gap-2.5" title={s?.version ? `Piomio ${s.version}` : "Piomio"}>
        <OwlMark size={28} mood={mood} />
        <span className="font-display text-[16px] font-semibold">Piomio</span>
      </Link>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [loc] = useLocation();
  const s = useStore(session);
  const p = useStore(panel);
  const taskList = useStore(tasks);
  useEffect(() => ensureTasks(), []);
  const activeTasks = (taskList ?? []).filter((x) => ACTIVE_STATUSES.includes(x.status)).length;
  const tasksOpen = p.open && p.section === "tasks";
  // The plugins' live views (the agents' browser): opened from here at any time, not only when an agent works there.
  const { liveViews } = usePluginRegistry();
  const live = useStore(liveWindow);
  const inboxOpen = p.open && p.section === "notifications";
  // One row of icons: the live views (the agents' browser), the Inbox, tasks and the settings; their names on hover.
  const item = (on: boolean) =>
    cx("press relative flex size-10 items-center justify-center rounded-xl", on ? "bg-surface text-fg shadow-card" : "text-muted hover:bg-surface/60 hover:text-fg");
  const count = (n: number) => (
    <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-white tabular-nums">{n}</span>
  );
  return (
    <>
      <div className="min-h-0 flex-1">
        <TeamList activeAgentId={agentForPath(loc, s?.defaultAgent)} activeConversationId={chatForPath(loc)} activeFeedId={feedForPath(loc)} onNavigate={onNavigate} />
      </div>
      <div className="shrink-0 px-5 py-1"><AppVersion /></div>
      <MachinesBlock onNavigate={onNavigate} />
      <div className="flex flex-col gap-2 px-3 empty:hidden">
        <PluginSidebarItems />
        <SidebarPanels />
      </div>
      <AppUpdateButton />
      <nav className="flex items-center justify-between gap-1 px-3 pt-1 pb-3">
        {liveViews.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => {
              if (live.expanded === v.key) liveWindowActions.collapse();
              else liveWindowActions.expand(v.key);
              onNavigate?.();
            }}
            aria-pressed={live.expanded === v.key}
            aria-label={v.title}
            title={v.title}
            className={item(live.expanded === v.key)}
          >
            <Icon name={v.icon} className="size-[18px]" />
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            if (inboxOpen) togglePanel();
            else openPanel("notifications");
            onNavigate?.();
          }}
          aria-pressed={inboxOpen}
          aria-label={t("nav.notifications")}
          title={t("nav.notifications")}
          className={item(inboxOpen)}
        >
          <Inbox className="size-[18px]" />
          {!!s?.inboxUnread && count(s.inboxUnread)}
        </button>
        <button
          type="button"
          onClick={() => {
            if (tasksOpen) togglePanel();
            else openPanel("tasks");
            onNavigate?.();
          }}
          aria-pressed={tasksOpen}
          aria-label={t("nav.tasks")}
          title={activeTasks > 0 ? `${t("nav.tasks")} · ${t("team.activeTasks", { n: activeTasks })}` : t("nav.tasks")}
          className={item(tasksOpen)}
        >
          <ListChecks className="size-[18px]" />
          {activeTasks > 0 && <span className="live-dot absolute top-1.5 right-1.5 size-1.5 rounded-full" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (p.open && !tasksOpen && !inboxOpen) togglePanel();
            else openPanel("home");
            onNavigate?.();
          }}
          aria-pressed={p.open && !tasksOpen && !inboxOpen}
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
          className={item(p.open && !tasksOpen && !inboxOpen)}
        >
          <Settings className="size-[18px]" />
        </button>
      </nav>
    </>
  );
}

/**
 * What the bar shows on the right: only what needs the person now (no connection, a sealed vault, approvals waiting),
 * plugin status items when the bar is wide enough, and the plugin side pane's toggle when a plugin has one. Settings
 * live in the sidebar.
 */
export function HeaderActions() {
  const shell = useContext(ShellContext);
  const panes = useSlot("pane.right");
  return (
    <div className="flex shrink-0 items-center gap-1 empty:hidden">
      <div className="hidden items-center gap-2 empty:hidden @3xl/top:flex">
        <PluginStatusItems />
      </div>
      <div className="md:hidden"><AppVersion /></div>
      <ConnectionBadge />
      <VaultBadge />
      <ApprovalsBadge />
      {panes.length > 0 && (
        <IconButton label={t("layout.sidePanel")} onClick={shell.togglePane} active={shell.pane} className="size-8">
          <PanelRight className="size-[17px]" />
        </IconButton>
      )}
    </div>
  );
}

/** The slim bar at the top of a view: menu (phones), the view's own content, what needs attention. */
export function TopBar({ children }: { children?: ReactNode }) {
  const shell = useContext(ShellContext);
  return (
    <header {...dragRegion(true)} className="glass @container/top relative z-20 flex h-12 shrink-0 items-center gap-1.5 px-2 sm:px-3 titlebar:max-md:h-14 titlebar:max-md:pt-2 titlebar:max-md:pl-24">
      <IconButton label={t("layout.menu")} onClick={shell.openDrawer} className="size-8 md:hidden">
        <Menu className="size-[18px]" />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      <HeaderActions />
    </header>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [pane, setPane] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ob.pane") === "1";
    } catch {
      return false;
    }
  });
  const panes = useSlot("pane.right");
  useEffect(() => {
    try {
      localStorage.setItem("ob.pane", pane ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [pane]);
  useEffect(() => setDrawer(false), [loc]);

  return (
    <ShellContext.Provider value={{ openDrawer: () => setDrawer(true), pane, togglePane: () => setPane((v) => !v) }}>
      {/* The shell never scrolls as a whole: it holds what escapes its panels (relative) and cannot be scrolled (clip). */}
      <div {...dragRegion()} className="relative flex h-dvh overflow-clip bg-canvas">
        <aside className="hidden w-[272px] shrink-0 flex-col md:flex">
          <Brand />
          <Sidebar />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="animate-fade absolute inset-0 bg-[rgb(20_14_6/0.32)] backdrop-blur-[3px]" onClick={() => setDrawer(false)} />
            <aside className="animate-in absolute inset-y-0 left-0 flex w-[86%] max-w-80 flex-col bg-canvas shadow-pop">
              <div className="flex items-center justify-between pr-2">
                <Brand />
                <IconButton label={t("layout.closeMenu")} onClick={() => setDrawer(false)}>
                  <X className="size-5" />
                </IconButton>
              </div>
              <Sidebar onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-bg md:my-2 md:mr-2 md:rounded-[22px] md:shadow-sheet">{children}</main>
        <SettingsPanel />
        <RightPane open={pane && panes.length > 0} onClose={() => setPane(false)} />
        <LiveViewWindow />
        <CommandPalette />
      </div>
    </ShellContext.Provider>
  );
}
