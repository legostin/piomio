// The real Telegram client: mtcute over WebSocket. The transport is the one Telegram's web apps use
// (wss://<dc>.web.telegram.org/apiws), so every byte goes through the hub's egress proxy to hosts named in the
// manifest; nothing opens a raw socket. The session lives in memory here: account.ts keeps its key in the vault.
//
// Reading never marks anything as read and sends no "typing"; the client does not report the account as online.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { InputMedia, MemoryStorage, networkMiddlewares } from "@mtcute/core";
import { TelegramClient } from "@mtcute/core/client.js";
import { WebCryptoProvider, WebPlatform, WebSocketTransport } from "@mtcute/web";
import { ChatList } from "./chat-list.ts";
import { FileTooLarge, RateLimited } from "./client.ts";
import { Pace, isPaced } from "./pace.ts";
import type { ChatKind, MediaKind, QrSignIn, TgAccount, TgChat, TgClient, TgClientOptions, TgFile, TgMedia, TgMessage } from "./client.ts";

/** Telegram's answers that mean "this session is no more". */
const SIGNED_OUT = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/;

/**
 * How long a walk of the account's chats answers "the whole list". Between walks the list follows what arrives, so
 * this only bounds what an update could have missed.
 */
const DIALOGS_FRESH_MS = 5 * 60_000;
const DIALOGS_MAX = 2000;
/** No more than one request to Telegram in this long (pace.ts says which requests). */
const REQUEST_GAP_MS = 3000;

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
  const pace = new Pace(REQUEST_GAP_MS);
  const tg = new TelegramClient({
    apiId: o.apiId,
    apiHash: o.apiHash,
    storage: new MemoryStorage(),
    crypto: new WebCryptoProvider({ wasmInput: wasm }),
    transport: new WebSocketTransport(),
    platform: new HubPlatform(o.deviceModel),
    initConnectionOptions: { deviceModel: o.deviceModel, appVersion: o.appVersion, systemVersion: `Node ${process.versions.node}` },
    network: {
      middlewares: [
        // First in line: a request waits its turn before the library's own handling (its rate-limit waits, retries).
        async (ctx, next) => {
          if (isPaced(ctx.request._)) await pace.wait();
          return next(ctx);
        },
        ...networkMiddlewares.basic(),
      ],
    },
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
  /**
   * Every call passes here, so a session Telegram ended is noticed wherever it shows, and a rate limit is told with
   * its seconds (the library keeps them beside the text, which reads "FLOOD_WAIT_%d").
   */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e: any) {
      gone(e);
      const text = errorText(e);
      if (/FLOOD_(PREMIUM_)?WAIT/.test(text)) throw new RateLimited(typeof e?.seconds === "number" ? e.seconds : Number(/WAIT_(\d+)/.exec(text)?.[1] ?? 0));
      throw e;
    }
  };

  const me = (u: any): TgAccount => ({ id: String(u.id), name: String(u.displayName || u.username || u.id), ...(u.username ? { username: u.username } : {}) });

  // The list of chats (chat-list.ts): one walk, kept and followed. Walking it also teaches the library the chats'
  // access keys, which a session opened from its key alone does not have: a chat is looked up in the list before
  // anything is asked of Telegram by id.
  const list = new ChatList(
    () =>
      run(async () => {
        const all: TgChat[] = [];
        // Archived chats too: they are the account's chats like any other, and the person must be able to close them.
        for await (const d of tg.iterDialogs({ limit: DIALOGS_MAX, archived: "keep" })) {
          let last: TgMessage | undefined;
          try {
            last = d.lastMessage ? messageOf(d.lastMessage) : undefined;
          } catch {
            // A last message of a kind this cannot read: the chat is listed without it.
          }
          all.push({ ...chatOf(d.peer), unread: d.unreadCount, ...(d.isMuted ? { muted: true } : {}), ...(last ? { lastMessageAt: last.date, last } : {}) });
        }
        return all;
      }),
    { freshMs: DIALOGS_FRESH_MS },
  );
  tg.onNewMessage.add((m: any) => {
    try {
      list.note(messageOf(m), chatOf(m.chat));
    } catch {
      // Not a message the list can show: the next walk brings the chat's state.
    }
  });
  tg.onHistoryRead.add((u: any) => {
    if (!u.isOutbox && !u.isDiscussion) list.read(String(u.chatId), u.unreadCount);
  });
  /** The first tool call should not be the one that waits for the walk. */
  const warm = () => void list.all().catch(() => {});
  const peerId = (chatId: string): number => Number(chatId);
  /** Make sure the library can address the chat (its access key is known). */
  const known = async (chatId: string): Promise<void> => {
    try {
      await tg.resolvePeer(peerId(chatId));
    } catch (e) {
      if (gone(e)) throw e;
      // The walk is what teaches the keys: wait for it (it runs only when the list is old) and ask once more.
      await list.all();
      await run(() => tg.resolvePeer(peerId(chatId)));
    }
  };
  /** A message the account sent from here goes into the list at once. */
  const sent = async (chatId: string, m: TgMessage): Promise<TgMessage> => {
    const chat = await list.find(chatId).catch(() => undefined);
    if (chat) list.note(m, chat);
    return m;
  };

  return {
    async resume(session) {
      await tg.importSession(session, true);
      try {
        await tg.connect();
        const user = await tg.getMe();
        await tg.startUpdatesLoop();
        warm();
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
      list.clear();
      await tg.startUpdatesLoop();
      warm();
      return me(user);
    },

    exportSession: () => tg.exportSession(),

    async logOut() {
      await tg.logOut();
    },

    async close() {
      await tg.destroy().catch(() => {});
    },

    chats: async (limit) => (await list.all()).slice(0, limit),

    // Only the account's own chats: a public name Telegram could resolve (any channel, anyone's @username) is not
    // one of them, and what the person opened is kinds of *their* chats.
    chat: (ref) => list.find(ref),

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
      return sent(chatId, messageOf(await run(() => tg.sendText(peerId(chatId), text, opts?.replyTo ? { replyTo: opts.replyTo } : {}))));
    },

    async sendFile(chatId, file, opts) {
      await known(chatId);
      const media = InputMedia.auto(file.data, { fileName: file.fileName, ...(file.mime ? { fileMime: file.mime } : {}), ...(opts?.caption ? { caption: opts.caption } : {}) });
      return sent(chatId, messageOf(await run(() => tg.sendMedia(peerId(chatId), media, opts?.replyTo ? { replyTo: opts.replyTo } : {}))));
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
