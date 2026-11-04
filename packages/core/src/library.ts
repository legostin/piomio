// An agent's library: everything the person and the agent sent each other — photos, videos, voice notes, documents,
// the pictures the agent showed — and the pages it made. Nothing is stored twice: the library is read from the chats
// (the agent's dialog, its tasks and setup chats, the groups it is in) and the pages table, newest first. The same
// file or picture shown in a task and again in the dialog that started it is one item. Files that are gone (a
// deleted agent's folder) are left out.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LibraryItem, LibraryKind, MessagePart, PageView } from "@piomio/shared";
import type { Db } from "./db.ts";

export const LIBRARY_KINDS: LibraryKind[] = ["media", "audio", "file", "page"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Messages with files a library reads at most (a personal hub has far fewer). */
const MAX_ROWS = 20_000;

export interface LibraryQuery {
  /** One agent's library; every agent's without. */
  agentId?: string;
  kind?: LibraryKind;
  /** Words in the name, caption or transcript (any case). */
  q?: string;
  /** Only items older than this (paging: the `at` of the last item seen). */
  before?: string;
  limit?: number;
}

export interface LibraryPage {
  items: LibraryItem[];
  /** There are older items: ask again with `before` set to the last item's `at`. */
  more: boolean;
}

export interface LibraryDeps {
  db: Db;
  /** <dataDir>/workspaces: attachment paths are relative to it. */
  workspacesRoot: string;
  pages: { list(agentId?: string): PageView[] };
}

type AttachmentPart = Extract<MessagePart, { type: "attachment" }>;

const IMAGE_OR_VIDEO = /^(image|video)\//i;

/** Which shelf a file goes on: photos and videos, voice notes and audio, everything else. */
export function attachmentKind(p: Pick<AttachmentPart, "kind" | "mimeType">): Exclude<LibraryKind, "page"> {
  if (p.kind === "voice" || p.kind === "audio" || p.mimeType?.startsWith("audio/")) return "audio";
  if (p.kind === "photo" || p.kind === "video" || (p.mimeType && IMAGE_OR_VIDEO.test(p.mimeType))) return "media";
  return "file";
}

/** The name a shown picture goes by: its caption, else the last part of its path or address. */
function imageName(src: string, caption?: string, alt?: string): string {
  if (caption) return caption;
  if (alt) return alt;
  const raw = src.startsWith("file:") ? src.slice(5) : src;
  let last = raw.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    /* keep it as it is */
  }
  return last || "image";
}

interface Row {
  id: string;
  conversation_id: string;
  role: string;
  agent_id: string | null;
  parts: string;
  created_at: string;
  conv_agent: string;
}

/** The library, newest first, one page of it. */
export function readLibrary(d: LibraryDeps, query: LibraryQuery = {}): LibraryPage {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(query.limit ?? DEFAULT_LIMIT)));
  const kind = query.kind && LIBRARY_KINDS.includes(query.kind) ? query.kind : undefined;
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...texts: Array<string | undefined>) => {
    if (!words.length) return true;
    const hay = texts.filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  };

  const items: LibraryItem[] = [];
  const seen = new Set<string>();
  const keep = (it: LibraryItem) => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    if (kind && it.kind !== kind) return;
    if (query.before && !(it.at < query.before)) return;
    items.push(it);
  };

  if (kind !== "page") {
    const where = ["(instr(m.parts, '\"type\":\"attachment\"') > 0 or instr(m.parts, '\"type\":\"images\"') > 0)"];
    const args: string[] = [];
    if (query.agentId) {
      where.push("(c.agent_id = ? or m.agent_id = ? or instr(coalesce(c.members, ''), ?) > 0)");
      args.push(query.agentId, query.agentId, JSON.stringify(query.agentId));
    }
    const rows = d.db
      .prepare(
        `select m.id, m.conversation_id, m.role, m.agent_id, m.parts, m.created_at, c.agent_id as conv_agent
         from messages m join conversations c on c.id = m.conversation_id
         where ${where.join(" and ")} order by m.created_at desc, m.rowid desc limit ${MAX_ROWS}`,
      )
      .all(...args) as unknown as Row[];
    for (const r of rows) {
      let parts: MessagePart[];
      try {
        parts = JSON.parse(r.parts);
      } catch {
        continue;
      }
      const from = r.role === "user" && !r.agent_id ? "person" : "agent";
      const agentId = r.agent_id ?? r.conv_agent;
      const base = { from, agentId, conversationId: r.conversation_id, messageId: r.id, at: r.created_at } as const;
      for (const p of parts) {
        if (p.type === "attachment") {
          if (seen.has(p.path) || !existsSync(join(d.workspacesRoot, p.path))) continue;
          if (!matches(p.name, p.transcript)) continue;
          keep({
            ...base,
            id: p.path,
            kind: attachmentKind(p),
            name: p.name,
            path: p.path,
            ...(p.mimeType ? { mimeType: p.mimeType } : {}),
            ...(p.size !== undefined ? { size: p.size } : {}),
            ...(p.durationSec !== undefined ? { durationSec: p.durationSec } : {}),
            ...(p.transcript ? { transcript: p.transcript } : {}),
            ...(p.kind === "voice" ? { voice: true } : {}),
          });
        } else if (p.type === "images") {
          for (const it of p.items) {
            if (seen.has(it.src)) continue;
            const file = it.src.startsWith("file:") ? it.src.slice(5) : undefined;
            if (file !== undefined && !existsSync(join(d.workspacesRoot, file))) continue;
            if (file === undefined && !/^https?:\/\//i.test(it.src)) continue;
            if (!matches(it.caption, it.alt, it.src)) continue;
            keep({
              ...base,
              from: "agent",
              id: it.src,
              kind: "media",
              name: imageName(it.src, it.caption, it.alt),
              src: it.src,
              ...(file !== undefined ? { path: file } : {}),
              ...(it.caption ? { caption: it.caption } : {}),
            });
          }
        }
      }
    }
  }

  if (!kind || kind === "page") {
    for (const p of d.pages.list(query.agentId)) {
      if (!matches(p.title, p.summary)) continue;
      keep({
        id: `page:${p.id}`,
        kind: "page",
        from: "agent",
        name: p.title,
        pageId: p.id,
        agentId: p.agentId,
        ...(p.summary ? { caption: p.summary } : {}),
        ...(p.cover ? { src: p.cover } : {}),
        ...(p.conversationId ? { conversationId: p.conversationId } : {}),
        at: p.updatedAt,
      });
    }
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { items: items.slice(0, limit), more: items.length > limit };
}

/** Whether a file (its path under the workspaces root) is in the agent's library: something it may send or open again. */
export function libraryHas(d: LibraryDeps, agentId: string, path: string): LibraryItem | undefined {
  const name = path.split("/").pop() ?? "";
  return readLibrary(d, { agentId, q: name, limit: MAX_LIMIT }).items.find((it) => it.path === path);
}
