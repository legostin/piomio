// The floating live view: a compact picture-in-picture window onto an agent's screen (the browser now; desktop apps
// and other machines later), filled by plugins through ui.liveView.register. It opens on its own while a view is busy,
// turns into a pill a little after the work stops, and expands into a large overlay where the user can take over.
// Which view and which mode: plugins/liveview.ts. Bottom corners stay above the chat composer.

import { WindowTitlebar } from "./WindowTitlebar";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Hand, Maximize2, Minimize2, Minus, X } from "lucide-react";
import type { AgentDef } from "@piomio/shared";
import { createStore, useStore } from "../lib/store";
import { agents, ensureAgents } from "../state/app";
import { isBusy, liveWindow, liveWindowActions, liveWindowView, nextChangeAt, phaseOf } from "../plugins/liveview";
import type { LiveViewEntry } from "../plugins/registry";
import { usePluginRegistry } from "../plugins/slots";
import { PluginBoundary } from "../plugins/boundary";
import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./icon";
import { cx } from "./ui";
import { t } from "../i18n";

// ---------- placement ----------

type Corner = "tl" | "tr" | "bl" | "br";
const CORNER_KEY = "ob.liveView.corner";
const EDGE = 16;
/** Below the 56 px top bar. */
const TOP = 64;

function readCorner(): Corner {
  try {
    const v = localStorage.getItem(CORNER_KEY);
    return v === "tl" || v === "tr" || v === "bl" ? v : "br";
  } catch {
    return "br";
  }
}

const corner = createStore<Corner>(readCorner());

function setCorner(c: Corner): void {
  corner.set(c);
  try {
    localStorage.setItem(CORNER_KEY, c);
  } catch {
    /* private mode */
  }
}

/** Distance from the bottom of the window's box (the viewport or its frame) to the top of the chat composer (0: none). */
const composerInset = createStore(0);

/** A ref for the chat composer's area: the window keeps its bottom corners above it, clear of the send button. */
export function useComposerInsetRef(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const frame = el.closest("[data-live-view-frame]");
      const bottom = frame ? frame.getBoundingClientRect().bottom : window.innerHeight;
      composerInset.set(Math.max(0, Math.round(bottom - el.getBoundingClientRect().top)));
    };
    measure();
    // Border box: the iOS dock changes only its padding when the keyboard comes up.
    const ro = new ResizeObserver(measure);
    ro.observe(el, { box: "border-box" });
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      composerInset.set(0);
    };
  }, [el]);
  return setEl;
}

/** In a frame (the iOS app) there is no top bar, but the app's header and the notch: keep below the safe area. */
function placement(c: Corner, inset: number, framed: boolean): CSSProperties {
  const side = `calc(env(safe-area-inset-${c[1] === "l" ? "left" : "right"}, 0px) + ${EDGE}px)`;
  return {
    ...(c[0] === "t" ? { top: framed ? "calc(env(safe-area-inset-top, 0px) + 8px)" : TOP } : { bottom: Math.max(EDGE, inset + 8) }),
    ...(c[1] === "l" ? { left: side } : { right: side }),
  };
}

/** Drag the title bar; on release the window snaps to the corner of the screen quarter it was dropped in. */
function useCornerDrag() {
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const end = () => {
    start.current = null;
    setOffset(null);
  };
  return {
    offset,
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        start.current = { x: e.clientX, y: e.clientY, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        const s = start.current;
        if (!s) return;
        const x = e.clientX - s.x;
        const y = e.clientY - s.y;
        if (!s.moved && Math.hypot(x, y) < 6) return;
        s.moved = true;
        setOffset({ x, y });
      },
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        const moved = start.current?.moved;
        end();
        if (moved) setCorner(`${e.clientY < window.innerHeight / 2 ? "t" : "b"}${e.clientX < window.innerWidth / 2 ? "l" : "r"}`);
      },
      onPointerCancel: end,
    },
  };
}

// ---------- helpers ----------

/** Now, re-rendered when the next grace / pill period runs out. */
function useLiveClock(views: LiveViewEntry[]): number {
  const [, setTick] = useState(0);
  const now = Date.now();
  const at = nextChangeAt(views, now);
  useEffect(() => {
    if (at === undefined) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

function useAgent(agentId: string | undefined): AgentDef | undefined {
  const list = useStore(agents);
  useEffect(() => {
    if (agentId) ensureAgents();
  }, [agentId]);
  return agentId ? list?.find((a) => a.id === agentId) : undefined;
}

function WinButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </button>
  );
}

// ---------- pieces ----------

function TitleBar({ view, views, expanded, drag }: { view: LiveViewEntry; views: LiveViewEntry[]; expanded: boolean; drag: ReturnType<typeof useCornerDrag> }) {
  const agent = useAgent(view.activity.agentId);
  const status = view.activity.status;
  return (
    <div
      className={cx(
        "flex shrink-0 items-center gap-1.5 border-b border-border",
        expanded ? "py-1.5 pr-1.5 pl-3" : "cursor-grab touch-none py-0.5 pr-0.5 pl-2 select-none active:cursor-grabbing",
      )}
      title={expanded ? undefined : t("liveView.drag")}
      {...(expanded ? {} : drag.handlers)}
    >
      <Icon name={view.icon} className="size-4 shrink-0 text-muted" />
      {agent && <AgentAvatar avatar={agent.avatar} id={agent.id} name={agent.name} size={expanded ? 20 : 16} />}
      {isBusy(view.activity) && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" aria-hidden />}
      <div className={cx("min-w-0 flex-1 truncate", expanded ? "text-sm" : "text-xs")}>
        <span className="font-medium">{agent ? (expanded ? `${agent.name} · ${view.title}` : agent.name) : view.title}</span>
        {status && <span className="text-muted"> · {status}</span>}
      </div>
      {views.length > 1 &&
        views.map((v) => (
          <button
            key={v.key}
            type="button"
            aria-pressed={v.key === view.key}
            aria-label={v.title}
            title={v.title}
            onClick={() => (expanded ? liveWindowActions.expand(v.key) : liveWindowActions.show(v.key))}
            className={cx("inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition", v.key === view.key ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}
          >
            <Icon name={v.icon} className="size-3.5" />
          </button>
        ))}
      {expanded ? (
        <WinButton label={t("liveView.collapse")} onClick={liveWindowActions.collapse}>
          <Minimize2 className="size-4" />
        </WinButton>
      ) : (
        <>
          <WinButton label={t("liveView.expand")} onClick={() => liveWindowActions.expand(view.key)}>
            <Maximize2 className="size-3.5" />
          </WinButton>
          <WinButton label={t("liveView.minimize")} onClick={() => liveWindowActions.minimize(view)}>
            <Minus className="size-4" />
          </WinButton>
        </>
      )}
      <WinButton label={t("liveView.close")} onClick={() => liveWindowActions.close(view)}>
        <X className="size-4" />
      </WinButton>
    </div>
  );
}

function Pill({ view, now }: { view: LiveViewEntry; now: number }) {
  const agent = useAgent(view.activity.agentId);
  const live = phaseOf(view, now) === "live";
  const attention = !!view.activity.attention;
  return (
    <button
      type="button"
      // After the work stopped there is no compact window to return to: open the large view with the last picture.
      onClick={() => (live ? liveWindowActions.show(view.key) : liveWindowActions.expand(view.key))}
      title={view.activity.status || t("liveView.show", { title: view.title })}
      aria-label={t("liveView.show", { title: view.title })}
      className={cx(
        "animate-in inline-flex max-w-64 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-card transition",
        attention ? "border-warning/50 bg-warning-soft text-warning" : "border-border bg-surface text-fg hover:bg-surface-2",
      )}
    >
      {attention ? <Hand className="size-3.5" /> : <span className={cx("size-2 shrink-0 rounded-full", live ? "animate-pulse bg-success" : "bg-muted/50")} aria-hidden />}
      <Icon name={view.icon} className="size-3.5 shrink-0" />
      <span className="truncate">{attention ? t("liveView.needsYou") : (agent?.name ?? view.title)}</span>
    </button>
  );
}

// ---------- the window ----------

/**
 * `frame`: the box to place the window in instead of the page, marked `data-live-view-frame`: the iOS app's chat shell,
 * which follows the visual viewport (so the window rides above the keyboard) and runs under the app's own header.
 * Its transform makes it the containing block of the window's fixed layers.
 */
export function LiveViewWindow({ frame }: { frame?: HTMLElement }) {
  const { liveViews } = usePluginRegistry();
  const choices = useStore(liveWindow);
  const now = useLiveClock(liveViews);
  const { mode, current, visible } = liveWindowView(liveViews, choices, now);
  const where = useStore(corner);
  const inset = useStore(composerInset);
  const drag = useCornerDrag();
  const expanded = mode === "expanded";
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!expanded) return;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    // A plugin that handles Escape itself (e.g. sends it to a remote screen) prevents the default.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && liveWindowActions.collapse();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (mode === "hidden") return null;
  const framed = !!frame;
  const place = placement(where, inset, framed);
  const root = frame ?? document.body;

  if (mode === "pill" || !current) {
    return createPortal(
      <div
        className={cx("fixed z-30 flex gap-2", where[0] === "b" ? "flex-col-reverse" : "flex-col", where[1] === "l" ? "items-start" : "items-end")}
        style={place}
      >
        {visible.map((v) => (
          <Pill key={v.key} view={v} now={now} />
        ))}
      </div>,
      root,
    );
  }

  const C = current.component;
  const attention = !!current.activity.attention;
  // Mini and expanded render the same element tree (only classes change), so the plugin's content stays mounted.
  return createPortal(
    <>
      {expanded ? <div key="backdrop" className="fixed inset-0 z-[45] bg-black/40 backdrop-blur-[2px]" onClick={liveWindowActions.collapse} /> : null}
      <section
        key="window"
        ref={panel}
        tabIndex={-1}
        role={expanded ? "dialog" : "region"}
        aria-modal={expanded || undefined}
        aria-label={t("liveView.label", { title: current.title })}
        className={cx(
          "flex flex-col overflow-hidden bg-surface outline-none",
          expanded
            ? framed
              ? "window-overlay animate-in fixed inset-0 z-50 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
              : // In a Mac window the shared titlebar strip replaces the floating panel's outer margin.
                "window-overlay animate-in fixed inset-0 z-50 titlebar:inset-0! titlebar:rounded-none sm:inset-[3vh_3vw] sm:rounded-2xl sm:border sm:border-border sm:shadow-card"
            : "animate-in fixed z-30 w-[min(52vw,240px)] rounded-2xl border shadow-card sm:w-80",
          !expanded && (attention ? "border-warning ring-2 ring-warning/30" : "border-border"),
        )}
        style={expanded ? undefined : { ...place, transform: drag.offset ? `translate(${drag.offset.x}px, ${drag.offset.y}px)` : undefined }}
      >
        {expanded && <WindowTitlebar />}
        <TitleBar view={current} views={visible.length > 1 ? visible : []} expanded={expanded} drag={drag} />
        {expanded && attention ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning-soft px-3 py-1.5 text-sm text-warning">
            <Hand className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("liveView.needsYouHint")}</span>
          </div>
        ) : null}
        <div className={cx("relative overflow-hidden", expanded ? "min-h-0 flex-1 p-2 sm:p-3" : "aspect-[16/10] w-full bg-surface-2")}>
          <PluginBoundary key={current.key} pluginId={current.pluginId}>
            <C
              pluginId={current.pluginId}
              mode={expanded ? "expanded" : "mini"}
              expand={() => liveWindowActions.expand(current.key)}
              collapse={liveWindowActions.collapse}
            />
          </PluginBoundary>
          {expanded ? null : (
            <button type="button" className="absolute inset-0 cursor-zoom-in" aria-label={t("liveView.expand")} onClick={() => liveWindowActions.expand(current.key)} />
          )}
          {!expanded && attention ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-warning-soft px-2 py-1 text-xs font-medium text-warning">
              <Hand className="size-3.5 shrink-0" />
              <span className="truncate">{t("liveView.needsYou")}</span>
            </div>
          ) : null}
        </div>
      </section>
    </>,
    root,
  );
}
