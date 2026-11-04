// Ctrl/Cmd+K command palette: the team and group chats, settings sections, quick actions and plugin commands.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { CornerDownLeft, Search } from "lucide-react";
import { createStore, useStore } from "../lib/store";
import { agentPath, groupPath } from "../lib/team";
import { agents, clearCacheNow, ensureAgents, ensureGroups, groups, logout, session } from "../state/app";
import { toast } from "../state/toast";
import { usePluginRegistry } from "../plugins/slots";
import { liveWindowActions } from "../plugins/liveview";
import { Icon } from "./icon";
import { cx } from "./ui";
import { SECTIONS } from "./nav";
import { addAgent, openPanel } from "../state/panel";
import { t } from "../i18n";

const open = createStore(false);
export const openPalette = () => open.set(true);

interface Item {
  id: string;
  title: string;
  group: string;
  icon?: string;
  run: () => void | Promise<void>;
}

export function filterItems<T extends { title: string; group: string }>(items: T[], q: string): T[] {
  const query = q.trim().toLowerCase();
  if (!query) return items;
  const words = query.split(/\s+/);
  return items
    .map((it) => {
      const hay = `${it.title} ${it.group}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      return { it, score: it.title.toLowerCase().startsWith(query) ? 0 : 1 };
    })
    .filter((x): x is { it: T; score: number } => !!x)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.it);
}

export function CommandPalette() {
  const isOpen = useStore(open);
  const [, navigate] = useLocation();
  const { routes, commands, liveViews } = usePluginRegistry();
  const s = useStore(session);
  const agentList = useStore(agents);
  const groupList = useStore(groups);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open.set(!open.get());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (isOpen) {
      ensureAgents();
      ensureGroups();
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [isOpen]);

  const items: Item[] = useMemo(() => {
    const actions = t("palette.group.actions");
    const goTo = t("palette.group.goTo");
    const out: Item[] = [
      { id: "add-agent", title: t("team.add"), group: actions, icon: "plus", run: addAgent },
      { id: "new-task", title: t("tasks.new"), group: actions, icon: "list-todo", run: () => navigate("/tasks?new=1") },
    ];
    for (const v of liveViews) out.push({ id: `live:${v.key}`, title: t("liveView.command", { title: v.title }), group: actions, icon: v.icon, run: () => liveWindowActions.expand(v.key) });
    for (const a of agentList ?? []) out.push({ id: `agent:${a.id}`, title: a.name, group: t("palette.group.team"), icon: "bot", run: () => navigate(agentPath(a.id, s?.defaultAgent)) });
    for (const g of groupList ?? []) out.push({ id: `group:${g.conversationId}`, title: g.title, group: t("team.groups"), icon: "users", run: () => navigate(groupPath(g.conversationId)) });
    out.push({ id: "settings", title: t("nav.settings"), group: goTo, icon: "settings", run: () => openPanel("home") });
    for (const n of SECTIONS) out.push({ id: `section:${n.id}`, title: t(n.label), group: goTo, run: () => openPanel(n.id), icon: undefined });
    for (const r of routes)
      if (!r.path.includes(":")) out.push({ id: `route:${r.key}`, title: r.title, group: t("palette.group.plugins"), icon: r.icon, run: () => navigate(r.path.replace(/\/\*$/, "")) });
    for (const c of commands) out.push({ id: `cmd:${c.key}`, title: c.title, group: t("palette.group.command", { plugin: c.pluginId }), icon: "zap", run: c.run });
    if (s) {
      out.push({ id: "console", title: t("common.securityConsole"), group: goTo, icon: "shield-check", run: () => void window.open(s.consoleUrl, "_blank", "noopener") });
      out.push({ id: "approvals", title: t("palette.approvals"), group: goTo, icon: "shield", run: () => void window.open(`${s.consoleUrl}/#/approvals`, "_blank", "noopener") });
    }
    out.push({ id: "clear-cache", title: t("common.clearCache"), group: actions, icon: "eraser", run: () => void clearCacheNow() });
    out.push({ id: "logout", title: t("common.logout"), group: actions, icon: "power", run: () => logout() });
    return out;
  }, [routes, commands, liveViews, s, agentList, groupList, navigate]);

  const filtered = useMemo(() => filterItems(items, q), [items, q]);

  useEffect(() => {
    list.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!isOpen) return null;

  const run = async (it: Item | undefined) => {
    if (!it) return;
    open.set(false);
    try {
      await it.run();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh]">
      <div className="animate-fade absolute inset-0 bg-[rgb(20_14_6/0.32)] backdrop-blur-[6px]" onClick={() => open.set(false)} />
      <div className="animate-zoom relative w-full max-w-lg overflow-hidden rounded-3xl border border-hairline bg-surface shadow-pop" role="dialog" aria-label={t("palette.title")}>
        <div className="flex items-center gap-2 border-b border-hairline px-4">
          <Search className="size-4 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") open.set(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                void run(filtered[sel]);
              }
            }}
            placeholder={t("palette.placeholder")}
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted">{t("common.nothingFound")}</div>}
          {filtered.map((it, i) => (
            <button
              key={it.id}
              type="button"
              data-idx={i}
              onMouseMove={() => setSel(i)}
              onClick={() => void run(it)}
              className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm", i === sel ? "bg-accent-soft text-accent-text" : "text-fg")}
            >
              <Icon name={it.icon ?? "compass"} className="size-4 shrink-0 opacity-80" />
              <span className="min-w-0 flex-1 truncate">{it.title}</span>
              <span className="shrink-0 text-xs text-muted">{it.group}</span>
              {i === sel && <CornerDownLeft className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
