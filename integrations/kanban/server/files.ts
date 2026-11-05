// Attachments: bytes in the plugin's data folder, one folder per card; the card keeps what they are. The hub carries them
// to and from an agent's workspace (files.fetch, files.deliver): a plugin never touches a workspace itself.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { PluginContext } from "@piomio/plugin-sdk";
import type { ToolCallContext } from "@piomio/shared";
import type { Board, By } from "./board.ts";
import { KanbanError } from "./errors.ts";
import type { Card, CardAttachment } from "./types.ts";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 50;
/** A file goes to a workspace in pieces of this many bytes. */
const CHUNK = 3 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

/** A name safe to show and to save under: no folders, no control characters. */
export function safeName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const name = basename(String(raw ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(-150);
  return name && name !== "." && name !== ".." ? name : "file";
}

export class Files {
  private ctx: PluginContext;
  private board: Board;

  constructor(ctx: PluginContext, board: Board) {
    this.ctx = ctx;
    this.board = board;
  }

  private dir(card: Card): string {
    return join(this.ctx.dataDir, "attachments", card.id);
  }

  private file(card: Card, attachment: CardAttachment): string {
    return join(this.dir(card), attachment.id);
  }

  add(card: Card, f: { name: unknown; mimeType?: unknown; data: Buffer }, by: By): CardAttachment {
    if (f.data.length > MAX_ATTACHMENT_BYTES) throw new KanbanError("attachmentTooLarge", { max: MAX_ATTACHMENT_BYTES / (1024 * 1024) });
    if (card.attachments.length >= MAX_ATTACHMENTS) throw new KanbanError("attachmentsTooMany", { max: MAX_ATTACHMENTS });
    const name = safeName(f.name);
    const mimeType = typeof f.mimeType === "string" && f.mimeType ? f.mimeType : TYPES[extname(name).toLowerCase()];
    const a: CardAttachment = {
      id: `att_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      name,
      ...(mimeType ? { mimeType } : {}),
      size: f.data.length,
      addedBy: by.actor,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(this.dir(card), { recursive: true });
    writeFileSync(this.file(card, a), f.data, { mode: 0o640 });
    this.board.written(card, by);
    card.attachments.push(a);
    this.board.saveCard(card);
    return a;
  }

  find(card: Card, ref: string): CardAttachment {
    const r = String(ref ?? "").trim();
    const a = card.attachments.find((x) => x.id === r) ?? card.attachments.find((x) => x.name === r);
    if (!a) throw new KanbanError("attachmentNotFound", { attachment: r, card: this.board.keyOf(card) });
    return a;
  }

  read(card: Card, a: CardAttachment): Buffer {
    const file = this.file(card, a);
    if (!existsSync(file)) throw new KanbanError("attachmentNotFound", { attachment: a.name, card: this.board.keyOf(card) });
    return readFileSync(file);
  }

  remove(card: Card, a: CardAttachment): void {
    rmSync(this.file(card, a), { force: true });
    card.attachments = card.attachments.filter((x) => x.id !== a.id);
    this.board.saveCard(card);
  }

  removeAll(card: Card): void {
    rmSync(this.dir(card), { recursive: true, force: true });
  }

  /** A file from the calling session's workspace onto the card. */
  async fromWorkspace(card: Card, path: string, name: string | undefined, call: ToolCallContext, by: By): Promise<CardAttachment> {
    const f = await this.ctx.core.call<{ name: string; size: number; data: string }>("files.fetch", { sessionId: call.sessionId, path });
    return this.add(card, { name: name ?? f.name, data: Buffer.from(f.data, "base64") }, by);
  }

  /** An attachment into the calling session's workspace: where it landed, relative to the workspace. */
  async toWorkspace(card: Card, a: CardAttachment, call: ToolCallContext): Promise<string> {
    const data = this.read(card, a);
    let path: string | undefined;
    for (let at = 0; at === 0 || at < data.length; at += CHUNK) {
      const piece = data.subarray(at, at + CHUNK).toString("base64");
      const r = await this.ctx.core.call<{ path: string }>("files.deliver", path ? { sessionId: call.sessionId, path, data: piece } : { sessionId: call.sessionId, name: a.name, data: piece });
      path = r.path;
    }
    return path!;
  }
}
