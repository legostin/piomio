// React renderers for plugin slots.

import { WindowTitlebar } from "../components/WindowTitlebar";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useStore } from "../lib/store";
import { Icon } from "../components/icon";
import { cx, IconButton } from "../components/ui";
import { t } from "../i18n";
import { PluginBoundary } from "./boundary";
import { inSlot, registry } from "./registry";

export function usePluginRegistry() {
  return useStore(registry);
}

export function useSlot(slot: Parameters<typeof inSlot>[1]) {
  const { contributions } = usePluginRegistry();
  return useMemo(() => inSlot(contributions, slot), [contributions, slot]);
}

/** layout.statusbar + ui.statusbar.add items. */
export function PluginStatusItems() {
  const { statusbar } = usePluginRegistry();
  if (!statusbar.length) return null;
  return (
    <>
      {statusbar.map((s) => {
        const C = s.render;
        return (
          <PluginBoundary key={s.key} pluginId={s.pluginId} silent>
            <span className="inline-flex items-center text-xs">
              <C pluginId={s.pluginId} />
            </span>
          </PluginBoundary>
        );
      })}
    </>
  );
}

/** layout.sidebar: extra items at the bottom of the left navigation. */
export function PluginSidebarItems() {
  const items = useSlot("layout.sidebar");
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((c) => {
        const C = c.component;
        return (
          <PluginBoundary key={c.key} pluginId={c.pluginId}>
            <C pluginId={c.pluginId} />
          </PluginBoundary>
        );
      })}
    </div>
  );
}

/** sidebar.panel: collapsible panels in the left sidebar. */
export function SidebarPanels() {
  const panels = useSlot("sidebar.panel");
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ob.panels") ?? "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("ob.panels", JSON.stringify(closed));
    } catch {
      /* private mode */
    }
  }, [closed]);
  if (!panels.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {panels.map((p) => {
        const C = p.component;
        const id = `${p.pluginId}:${p.id}`;
        const open = !closed[id];
        return (
          <div key={p.key}>
            {/* A quiet label like "Machines"; it folds the panel on a click, its chevron shows only on hover. */}
            <button
              type="button"
              onClick={() => setClosed((c) => ({ ...c, [id]: open }))}
              className="group flex w-full items-center gap-1.5 px-1 py-1 text-left text-[12px] font-medium text-muted hover:text-fg"
              aria-expanded={open}
            >
              <Icon name={p.icon} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{p.title ?? p.id}</span>
              {open ? (
                <ChevronDown className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              ) : (
                <ChevronRight className="size-3.5 opacity-60" />
              )}
            </button>
            {open && (
              <div className="animate-fade rounded-2xl bg-surface/60 p-2.5 text-sm">
                <PluginBoundary pluginId={p.pluginId}>
                  <C pluginId={p.pluginId} />
                </PluginBoundary>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** pane.right: a collapsible pane with tabs (desktop: side column, phone: full-screen sheet). */
export function RightPane({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tabs = useSlot("pane.right");
  const [active, setActive] = useState<string | undefined>();
  const current = tabs.find((tab) => tab.key === active) ?? tabs[0];
  if (!open || !current) return null;
  const C = current.component;
  return (
    <aside className="window-overlay animate-slide fixed inset-0 z-40 flex flex-col overflow-hidden bg-bg lg:static lg:z-auto lg:my-2 lg:mr-2 lg:w-[420px] lg:shrink-0 lg:rounded-[22px] lg:shadow-sheet xl:w-[480px]">
      <WindowTitlebar className="lg:hidden" />
      <div className="glass flex h-12 shrink-0 items-center gap-1 px-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              className={cx(
                "press inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium whitespace-nowrap",
                tab.key === current.key ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              <Icon name={tab.icon} className="size-4" />
              {tab.title ?? tab.id}
            </button>
          ))}
        </div>
        <IconButton label={t("layout.closePanel")} onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <PluginBoundary key={current.key} pluginId={current.pluginId}>
          <C pluginId={current.pluginId} />
        </PluginBoundary>
      </div>
    </aside>
  );
}

/** chat.composerActions: extra buttons next to the send button. */
export function ComposerActions({ conversationId }: { conversationId: string }) {
  const items = useSlot("chat.composerActions");
  if (!items.length) return null;
  return (
    <>
      {items.map((c) => {
        const C = c.component;
        return (
          <PluginBoundary key={c.key} pluginId={c.pluginId} silent>
            <C pluginId={c.pluginId} conversationId={conversationId} />
          </PluginBoundary>
        );
      })}
    </>
  );
}
