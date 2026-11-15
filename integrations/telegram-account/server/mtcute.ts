// The real Telegram client: mtcute over WebSocket. The transport is the one Telegram's web apps use
// (wss://<dc>.web.telegram.org/apiws), so every byte goes through the hub's egress proxy to hosts named in the
// manifest; nothing opens a raw socket. The session lives in memory here: account.ts keeps its key in the vault.
//
// Reading never marks anything as read and sends no "typing"; the client does not report the account as online.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { InputMedia, MemoryStorage } from "@mtcute/core";
import { TelegramClient } from "@mtcute/core/client.js";
import { WebCryptoProvider, WebPlatform, WebSocketTransport } from "@mtcute/web";
import { FileTooLarge } from "./client.ts";
import type { ChatKind, MediaKind, QrSignIn, TgAccount, TgChat, TgClient, TgClientOptions, TgFile, TgMedia, TgMessage } from "./client.ts";

/** Telegram's answers that mean "this session is no more". */
const SIGNED_OUT = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/;

/** How long a list of the account's chats is good for. */
const DIALOGS_TTL_MS = 60_000;
const DIALOGS_MAX = 2000;

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "application/pdf": "pdf" };

// The browser platform asks `navigator.onLine`, which Node does not have: here the network is simply there.
class HubPlatform extends WebPlatform {
  device: string;
  constructor(device: string) {
    super();
    this.device = device;
  }
  override getDeviceModel(): string {
    return this.device;
  }
  override getDefaultLogLevel(): number | null {
    return null;
  }
  override isOnline(): boolean {
    return true;
  }
  override onNetworkChanged(): () => void {
    return () => {};
  }
}

const errorText = (e: any): string => String(e?.text ?? e?.message ?? e);

function chatOf(peer: any): TgChat {
  // A user has a first name; everything else is a group or a channel with a title.
  if (typeof peer?.firstName === "string" || peer?.type === "user") {
    const kind: ChatKind = peer.isBot ? "bot" : "private";
    return { id: String(peer.id), kind, title: String(peer.displayName || peer.username || peer.id), ...(peer.username ? { username: peer.username } : {}), ...(peer.isSelf ? { self: true } : {}) };
  }
  const kind: ChatKind = peer?.chatType === "channel" ? "channel" : "group";
  return { id: String(peer.id), kind, title: String(peer.title || peer.displayName || peer.id), ...(peer.username ? { username: peer.username } : {}) };
}

function mediaOf(m: any): TgMedia | undefined {
  if (!m) return undefined;
  const known: MediaKind[] = ["photo", "video", "audio", "voice", "document", "sticker"];
  const kind: MediaKind = known.includes(m.type) ? m.type : "other";
  if (kind === "other") return { kind };
  return {
    kind,
    ...(typeof m.fileName === "string" && m.fileName ? { fileName: m.fileName } : {}),
    ...(typeof m.mimeType === "string" && m.mimeType ? { mime: m.mimeType } : {}),
    ...(typeof m.fileSize === "number" ? { size: m.fileSize } : {}),
  };
}

function messageOf(m: any): TgMessage {
  const sender = m.sender;
  const fwd = m.forward?.sender;
  const replyTo = m.replyToMessage?.id;
  const media = mediaOf(m.media);
  return {
    id: m.id,
    chatId: String(m.chat.id),
    date: m.date.toISOString(),
    out: !!m.isOutgoing,
    ...(sender?.displayName ? { sender: String(sender.displayName) } : {}),
    text: String(m.text ?? ""),
    ...(typeof replyTo === "number" ? { replyTo } : {}),
    ...(fwd?.displayName ? { forwardedFrom: String(fwd.displayName) } : {}),
    ...(media ? { media } : {}),
  };
}

export async function createMtcuteClient(o: TgClientOptions): Promise<TgClient> {
  const require = createRequire(import.meta.url);
  // Compiled here from the file: the library would otherwise fetch it by URL, as a browser does.
  const wasm = new (globalThis as any).WebAssembly.Module(readFileSync(require.resolve("@mtcute/wasm/mtcute.wasm")));
  const tg = new TelegramClient({
    apiId: o.apiId,
    apiHash: o.apiHash,
    storage: new MemoryStorage(),
    crypto: new WebCryptoProvider({ wasmInput: wasm }),
    transport: new WebSocketTransport(),
    platform: new HubPlatform(o.deviceModel),
    initConnectionOptions: { deviceModel: o.deviceModel, appVersion: o.appVersion, systemVersion: `Node ${process.versions.node}` },
    // Warnings and errors only; they go to the plugin's log.
    logLevel: 2,
  });

  const signedOut = new Set<() => void>();
  let dead = false;
  const gone = (e: unknown): boolean => {
    if (!SIGNED_OUT.test(errorText(e))) return false;
    if (!dead) {
      dead = true;
      for (const cb of signedOut) cb();
    }
    return true;
  };
  tg.onError.add((e) => {
    if (!gone(e)) o.log("warn", `telegram: ${errorText(e)}`);
  });
  /** Every call passes here, so a session Telegram ended is noticed wherever it shows. */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      gone(e);
      throw e;
    }
  };

  const me = (u: any): TgAccount => ({ id: String(u.id), name: String(u.displayName || u.username || u.id), ...(u.username ? { username: u.username } : {}) });

  // The list of chats, kept a minute. Loading it also teaches the library the chats' access keys, which a session
  // opened from its key alone does not have: a chat is looked up in it before anything is asked of Telegram by id.
  let dialogs: { at: number; list: TgChat[] } | undefined;
  const loadDialogs = async (limit: number): Promise<TgChat[]> => {
    if (dialogs && Date.now() - dialogs.at < DIALOGS_TTL_MS && dialogs.list.length >= Math.min(limit, DIALOGS_MAX)) return dialogs.list.slice(0, limit);
    const list: TgChat[] = [];
    await run(async () => {
      // Archived chats too: they are the account's chats like any other, and the person must be able to close them.
      for await (const d of tg.iterDialogs({ limit: Math.min(Math.max(limit, 200), DIALOGS_MAX), archived: "keep" })) {
        const last = d.lastMessage?.date;
        list.push({ ...chatOf(d.peer), unread: d.unreadCount, ...(last ? { lastMessageAt: last.toISOString() } : {}) });
      }
    });
    dialogs = { at: Date.now(), list };
    return list.slice(0, limit);
  };
  const peerId = (chatId: string): number => Number(chatId);
  /** Make sure the library can address the chat (its access key is known). */
  const known = async (chatId: string): Promise<void> => {
    try {
      await tg.resolvePeer(peerId(chatId));
    } catch (e) {
      if (gone(e)) throw e;
      dialogs = undefined;
      await loadDialogs(DIALOGS_MAX);
      await run(() => tg.resolvePeer(peerId(chatId)));
    }
  };

  return {
    async resume(session) {
      await tg.importSession(session, true);
      try {
        await tg.connect();
        const user = await tg.getMe();
        await tg.startUpdatesLoop();
        return me(user);
      } catch (e) {
        if (SIGNED_OUT.test(errorText(e))) return undefined;
        throw e;
      }
    },

    async signInQr(h: QrSignIn) {
      let wrong = false;
      const user = await tg.signInQr({
        onUrlUpdated: (url, expires) => h.onUrl(url, expires),
        onQrScanned: () => h.onScanned(),
        password: () => h.password(wrong),
        invalidPasswordCallback: () => {
          wrong = true;
        },
        abortSignal: h.signal,
      });
      dead = false;
      await tg.startUpdatesLoop();
      return me(user);
    },

    exportSession: () => tg.exportSession(),

    async logOut() {
      await tg.logOut();
    },

    async close() {
      await tg.destroy().catch(() => {});
    },

    chats: (limit) => loadDialogs(limit),

    async chat(ref) {
      const name = ref.trim();
      if (/^-?\d+$/.test(name)) {
        const hit = (await loadDialogs(DIALOGS_MAX)).find((c) => c.id === name);
        if (hit) return hit;
      } else {
        const username = name.replace(/^@/, "").toLowerCase();
        const hit = (await loadDialogs(DIALOGS_MAX)).find((c) => c.username?.toLowerCase() === username);
        if (hit) return hit;
      }
      // Only the account's own chats: a public name Telegram could resolve (any channel, anyone's @username) is not
      // one of them, and what the person opened is kinds of *their* chats.
      return undefined;
    },

    async history(chatId, { limit, beforeId }) {
      await known(chatId);
      const page = await run(() => tg.getHistory(peerId(chatId), { limit, ...(beforeId ? { offset: { id: beforeId, date: 0 } } : {}) }));
      return page.map(messageOf);
    },

    async search(query, { chatId, limit, from }) {
      if (chatId) await known(chatId);
      const offset = from === undefined ? {} : { offset: from as any };
      const page: unknown[] & { next?: unknown } = chatId
        ? await run(() => tg.searchMessages({ chatId: peerId(chatId), query, limit, ...offset }))
        : await run(() => tg.searchGlobal({ query, limit, ...offset }));
      return { messages: page.map(messageOf), ...(page.next !== undefined ? { next: page.next } : {}) };
    },

    async download(chatId, messageId, maxBytes) {
      await known(chatId);
      const [msg] = await run(() => tg.getMessages(peerId(chatId), [messageId]));
      const media: any = msg?.media;
      const info = mediaOf(media);
      if (!msg || !info || info.kind === "other") return undefined;
      if (typeof info.size === "number" && info.size > maxBytes) throw new FileTooLarge(info.size);
      const data = await run(() => tg.downloadAsBuffer(media));
      if (data.byteLength > maxBytes) throw new FileTooLarge(data.byteLength);
      const mime = info.mime ?? (info.kind === "photo" ? "image/jpeg" : undefined);
      const fileName = info.fileName ?? `${info.kind}-${messageId}${mime && EXT[mime] ? `.${EXT[mime]}` : ""}`;
      return { data, fileName, ...(mime ? { mime } : {}) } satisfies TgFile;
    },

    async sendText(chatId, text, opts) {
      await known(chatId);
      return messageOf(await run(() => tg.sendText(peerId(chatId), text, opts?.replyTo ? { replyTo: opts.replyTo } : {})));
    },

    async sendFile(chatId, file, opts) {
      await known(chatId);
      const media = InputMedia.auto(file.data, { fileName: file.fileName, ...(file.mime ? { fileMime: file.mime } : {}), ...(opts?.caption ? { caption: opts.caption } : {}) });
      return messageOf(await run(() => tg.sendMedia(peerId(chatId), media, opts?.replyTo ? { replyTo: opts.replyTo } : {})));
    },

    onMessage(cb) {
      const listener = (m: any) => {
        try {
          cb(messageOf(m), chatOf(m.chat));
        } catch (e) {
          o.log("warn", `telegram: a new message could not be read: ${errorText(e)}`);
        }
      };
      tg.onNewMessage.add(listener);
      return () => tg.onNewMessage.remove(listener);
    },

    onSignedOut(cb) {
      signedOut.add(cb);
      return () => signedOut.delete(cb);
    },
  };
}
