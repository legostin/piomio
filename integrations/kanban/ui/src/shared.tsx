// What the page, its panels and the chat cards share.

import type { CSSProperties, ReactNode } from "react";
import type { PiomioUI } from "@piomio/ui";
import { ME, type AgentInfo, type BoardState, type ColumnType, type Priority } from "../../server/types.ts";

export let UI: PiomioUI;
export const setUI = (ui: PiomioUI): void => {
  UI = ui;
};

export const t = (key: string, params?: Record<string, string | number>): string => UI.i18n.t(key, params);
export const enc = encodeURIComponent;

export function http<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  return UI.plugin.http<T>(method, path, body);
}

export const fail = (e: unknown): void => UI.toast((e as { message?: string })?.message ?? String(e), "error");

/** Opens an agent's dialog (the default agent's without one) and says this there in the person's words. */
export async function askInChat(state: BoardState | null, agentId: string | undefined, text: string): Promise<void> {
  const id = agentId ?? state?.defaultAgent;
  if (!id) return;
  try {
    const team = await UI.api.get<Array<{ agentId: string; conversationId: string }>>("/api/team");
    UI.navigate(id === state?.defaultAgent ? "/" : `/agent/${enc(id)}`);
    const member = team.find((m) => m.agentId === id);
    if (member) await UI.api.post(`/api/conversations/${enc(member.conversationId)}/messages`, { text });
  } catch (e) {
    fail(e);
  }
}

export const nameOf = (id: string | undefined, agents: AgentInfo[]): string => {
  if (!id) return "";
  if (id === ME) return t("ui.me");
  return agents.find((a) => a.id === id)?.name ?? id;
};

const CLOSED = new Set(["done", "failed", "cancelled"]);
export const isOpenRun = (status: string | undefined): boolean => !!status && !CLOSED.has(status);

export function runTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "running") return "info";
  if (status === "done") return "success";
  if (status === "failed") return "danger";
  if (status === "waiting_input" || status === "waiting_approval") return "warning";
  return "neutral";
}

const PATHS: Record<string, ReactNode> = {
  board: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8 8v7M12 8v3M16 8v9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  clip: <path d="M19 11.5l-7.6 7.6a4.8 4.8 0 01-6.8-6.8l7.9-7.9a3.2 3.2 0 014.5 4.5l-7.9 7.9a1.6 1.6 0 01-2.3-2.3l7.2-7.2" />,
  comment: <path d="M4 5h16v11H9l-5 4z" />,
  link: <path d="M14 5h5v5M19 5l-8 8M10 6H5v13h13v-5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  wait: <path d="M7 4h10M7 20h10M8 4c0 5 8 6 8 8s-8 3-8 8M16 4c0 5-8 6-8 8s8 3 8 8" />,
  shield: <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />,
  spark: <path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" />,
};

export function Icon({ name, size = 14, style }: { name: string; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", ...style }} aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Bars that fill up with how urgent it is; urgent is a solid mark. No mark without a priority. */
export function PriorityMark({ priority }: { priority: Priority }) {
  if (priority === "none") return null;
  const label = t(`priority.${priority}`);
  if (priority === "urgent") {
    return (
      <span className="kb-urgent" title={label} aria-label={label}>
        !
      </span>
    );
  }
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <span className="kb-bars" title={label} aria-label={label}>
      {[1, 2, 3].map((n) => (
        <i key={n} style={{ height: 3 + n * 3, opacity: n <= filled ? 1 : 0.25 }} />
      ))}
    </span>
  );
}

export function AgentChip({ id, agents, busy }: { id?: string; agents: AgentInfo[]; busy?: boolean }) {
  if (!id) return null;
  const name = nameOf(id, agents);
  return (
    <span className={`kb-chip${busy ? " is-busy" : ""}`} title={name} aria-label={name}>
      {[...name][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export const TYPE_COLOR: Record<ColumnType, string> = {
  backlog: "var(--muted)",
  queue: "var(--info)",
  active: "var(--accent)",
  review: "var(--warning)",
  done: "var(--success)",
  cancelled: "var(--muted)",
};

export function dueState(due: string | undefined): "over" | "soon" | undefined {
  if (!due) return undefined;
  const days = (Date.parse(`${due}T23:59:59`) - Date.now()) / 86_400_000;
  return days < 0 ? "over" : days < 2 ? "soon" : undefined;
}

export const formatDue = (due: string): string => UI.i18n.formatDate(`${due}T12:00:00`, { day: "numeric", month: "short" });
