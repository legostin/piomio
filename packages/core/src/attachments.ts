// Files the user sends to an agent (web upload, Telegram photos, documents and voice notes). They are saved in the
// conversation's workspace (`attachments/`), where its brain session already works, and stored as `attachment` parts
// whose path is relative to the workspaces root (what /api/files serves). The brain gets workspace-relative paths and
// an English note; a session working in another folder (a group member) gets a copy.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { AttachmentKind, MessagePart } from "@piomio/shared";
import { MAX_SYNC_FILE_BYTES } from "@piomio/replica";
import { IMAGE_TYPES } from "./media.ts";

/** Largest file the hub takes in one upload (Telegram hands bots at most 20 MB anyway). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Most files in one message. */
export const MAX_ATTACHMENTS = 10;
const MAX_NAME = 150;

export type AttachmentPart = Extract<MessagePart, { type: "attachment" }>;

/** A conversation as far as its files are concerned: they live in the workspace of its agent and its task or itself. */
export interface AttachmentOwner {
  id: string;
  agentId: string;
  taskId?: string;
}

export interface IncomingFile {
  name?: string;
  mimeType?: string;
  data: Buffer;
  kind?: AttachmentKind;
  durationSec?: number;
}

/** A file as a brain session sees it: its path in the session's workspace, none when the file is gone. */
export interface SessionFile {
  part: AttachmentPart;
  path?: string;
  /** A voice note without a transcript: why (SPEECH_NOT_SET_UP, or the reason it failed). */
  speech?: string;
}

/** A voice note's status when the hub has no speech-to-text: the note then tells the agent how to set it up. */
export const SPEECH_NOT_SET_UP = "no speech-to-text is set up";
const SPEECH_SETUP_HINT =
  "You cannot hear voice messages until speech-to-text is set up. Offer the user to set it up: a Groq API key (free tier, https://console.groq.com/keys) " +
  "or an OpenAI API key, asked for with secret_request as groq_api_key or openai_api_key. Then call transcribe_audio on the file.";

/** A recording the hub transcribes: a voice note or an audio file. */
export function isSpeech(p: AttachmentPart): boolean {
  return p.kind === "voice" || p.kind === "audio" || (!p.kind && !!p.mimeType?.startsWith("audio/"));
}

const TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

/** Plain file name: no path separators, control characters or leading dots, at most 150 characters with the extension kept. */
export function safeFileName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  let clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+/, "").trim();
  if (clean.length > MAX_NAME) {
    const ext = extname(clean).slice(0, 16);
    clean = clean.slice(0, MAX_NAME - ext.length).trimEnd() + ext;
  }
  return clean || "file";
}

/** The type a client gave when it looks like one, else the type by extension. */
export function mimeOf(name: string, given?: string): string {
  if (given && /^[\w.+-]+\/[\w.+-]+$/.test(given.trim())) return given.trim().toLowerCase();
  return TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A name for a file that came without one (a Telegram photo or voice note): what it is and when, e.g. photo-20261027-091500.jpg. */
export function defaultName(kind: AttachmentKind | undefined, mimeType: string, now = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = Object.keys(TYPES).find((e) => TYPES[e] === mimeType) ?? "";
  return `${kind ?? "file"}-${stamp}${ext}`;
}

/** The conversation's attachments folder (absolute). */
export function attachmentsDir(root: string, conv: AttachmentOwner): string {
  return join(root, conv.agentId, conv.taskId ?? conv.id, "attachments");
}

/** `name`, or `stem (2).ext`, `stem (3).ext`… — the first that `taken` says is free. */
function freeName(name: string, taken: (n: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let i = 2; taken(candidate); i++) candidate = `${stem} (${i})${ext}`;
  return candidate;
}

/** Writes an incoming file into the conversation's attachments folder and returns its message part. */
export function saveAttachment(root: string, conv: AttachmentOwner, f: IncomingFile, now = new Date()): AttachmentPart {
  const dir = attachmentsDir(root, conv);
  mkdirSync(dir, { recursive: true });
  const wanted = f.name?.trim() ? safeFileName(f.name) : defaultName(f.kind, mimeOf("", f.mimeType), now);
  const name = freeName(wanted, (n) => existsSync(join(dir, n)));
  writeFileSync(join(dir, name), f.data, { mode: 0o640 });
  const part: AttachmentPart = { type: "attachment", path: relative(root, join(dir, name)).split(sep).join("/"), name, mimeType: mimeOf(name, f.mimeType), size: f.data.length };
  if (f.kind) part.kind = f.kind;
  if (f.durationSec !== undefined && Number.isFinite(f.durationSec)) part.durationSec = Math.max(0, Math.round(f.durationSec));
  return part;
}

/** A path the web sends with a message: only a file directly in this conversation's attachments folder counts. */
export function attachmentFromPath(root: string, conv: AttachmentOwner, path: unknown): AttachmentPart | undefined {
  if (typeof path !== "string") return undefined;
  const prefix = `${conv.agentId}/${conv.taskId ?? conv.id}/attachments/`;
  if (!path.startsWith(prefix)) return undefined;
  const name = path.slice(prefix.length);
  if (!name || safeFileName(name) !== name) return undefined;
  const file = join(attachmentsDir(root, conv), name);
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return undefined;
    return { type: "attachment", path, name, mimeType: mimeOf(name), size: st.size };
  } catch {
    return undefined;
  }
}

/**
 * Takes back a file the person uploaded and did not send (removed from the composer, or replaced by a marked-up copy).
 * A file a message already names stays.
 */
export function discardAttachment(root: string, conv: AttachmentOwner, path: unknown, sent: (path: string) => boolean): boolean {
  const part = attachmentFromPath(root, conv, path);
  if (!part || sent(part.path)) return false;
  rmSync(join(attachmentsDir(root, conv), part.name), { force: true });
  return true;
}

const sameFile = (a: string, b: string) => {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/** The files as a session working in `workspace` sees them, copied into its `attachments/` when they live elsewhere. */
export function forSession(parts: AttachmentPart[], root: string, workspace: string): SessionFile[] {
  return parts.map((part) => {
    const src = join(root, part.path);
    if (!existsSync(src)) return { part };
    const rel = relative(workspace, src);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return { part, path: rel.split(sep).join("/") };
    const dir = join(workspace, "attachments");
    mkdirSync(dir, { recursive: true });
    const name = freeName(basename(src), (n) => existsSync(join(dir, n)) && !sameFile(src, join(dir, n)));
    if (!existsSync(join(dir, name))) copyFileSync(src, join(dir, name));
    return { part, path: `attachments/${name}` };
  });
}

/** 512 B, 47 KB, 1.2 MB, 25 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
}

/** 0:12, 1:12, 1:02:03. */
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function describe(p: AttachmentPart): string {
  const bits = [p.mimeType ?? "unknown type"];
  if (p.size !== undefined) bits.push(formatSize(p.size));
  if (p.durationSec !== undefined) bits.push(p.kind === "voice" ? `voice message ${formatDuration(p.durationSec)}` : formatDuration(p.durationSec));
  else if (p.kind === "voice") bits.push("voice message");
  return bits.join(", ");
}

/** What the file says, when it is a recording: its transcript, or why there is none. */
function heard(f: SessionFile): string {
  if (f.part.transcript !== undefined) return f.part.transcript ? `, transcript: "${f.part.transcript}"` : ", transcript: (no speech)";
  return f.speech ? `, ${f.speech}` : "";
}

/**
 * The English note that tells the brain which files came with the user's message and where they are. `remote`: the
 * brain works on another computer, whose folder is the hub's copy of it (file sync): a file comes over in seconds,
 * one without a path was too big to sync.
 */
export function attachmentNote(files: SessionFile[], opts: { remote?: boolean } = {}): string {
  if (!files.length) return "";
  const one = files.length === 1;
  const what = one ? "a file" : `${files.length} files`;
  const missing = (f: SessionFile) =>
    opts.remote && (f.part.size ?? 0) > MAX_SYNC_FILE_BYTES ? ` (${describe(f.part)})${heard(f)}: stays on the hub, too big to copy to this computer` : " (no longer available)";
  const lines = files.map((f) => (f.path ? `- ${f.path} (${describe(f.part)})${heard(f)}` : `- ${f.part.name}${missing(f)}`));
  const them = one ? "it" : "them";
  const setup = files.some((f) => f.speech === SPEECH_NOT_SET_UP) ? [SPEECH_SETUP_HINT] : [];
  const synced = opts.remote ? [`${one ? "It comes" : "They come"} over from the hub: if ${one ? "it" : "one"} is not there yet, wait a few seconds and look again.`] : [];
  return [`[The user attached ${what}, saved in your working folder:`, ...lines, ...setup, ...synced, `Open ${them} with your file tools when the request needs ${them}.]`].join("\n");
}
