// What the page and the chat card share.

import type { CSSProperties, ReactNode } from "react";
import type { PiomioUI } from "@piomio/ui";
import { ME, type Method } from "../../server/types.ts";

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

/** Opens the default agent's dialog and says this there in the person's words. */
export async function askInChat(agentId: string | undefined, text: string): Promise<void> {
  if (!agentId) return;
  try {
    const team = await UI.api.get<Array<{ agentId: string; conversationId: string }>>("/api/team");
    UI.navigate("/");
    const member = team.find((m) => m.agentId === agentId);
    if (member) await UI.api.post(`/api/conversations/${enc(member.conversationId)}/messages`, { text });
  } catch (e) {
    fail(e);
  }
}

export const nameOf = (by: string): string => (by === ME ? t("ui.me") : by);

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const duration = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export function statusTone(status: number | undefined): Tone {
  if (!status) return "danger";
  if (status < 300) return "success";
  if (status < 400) return "info";
  if (status < 500) return "warning";
  return "danger";
}

const METHOD_COLOR: Record<string, string> = {
  GET: "var(--success)",
  POST: "var(--info)",
  PUT: "var(--warning)",
  PATCH: "var(--warning)",
  DELETE: "var(--danger)",
};

export function MethodMark({ method }: { method: Method | string }) {
  return (
    <span className="hc-method" style={{ color: METHOD_COLOR[method] ?? "var(--muted)" }}>
      {method}
    </span>
  );
}

/** "api.example.com/items?page=2" for a list: the scheme says nothing there. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

/** Today: the time; earlier: the day too. */
export function when(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return UI.i18n.formatDate(d, today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** JSON reads better spread out; anything else is shown as it came. */
export function pretty(body: string, contentType: string): string {
  if (body.length > 1024 * 1024 || !(/json/i.test(contentType) || /^\s*[[{]/.test(body))) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    UI.toast(t("ui.copied"), "success");
  } catch (e) {
    fail(e);
  }
}

const PATHS: Record<string, ReactNode> = {
  send: <path d="M4 12l16-8-6 16-3-7z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  back: <path d="M15 5l-7 7 7 7" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 012-2h9" />
    </>
  ),
  save: <path d="M6 4h10l3 3v13H5V4zM8 4v5h7M8 20v-6h8v6" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  open: <path d="M14 5h5v5M19 5l-8 8M10 6H5v13h13v-5" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  layers: <path d="M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4" />,
};

export function Icon({ name, size: s = 14, style }: { name: string; size?: number; style?: CSSProperties }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", ...style }} aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
