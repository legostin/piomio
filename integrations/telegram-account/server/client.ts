// What the integration needs from a Telegram client, as plain data. The real one (mtcute.ts) speaks MTProto to
// Telegram; the tests give a fake of the same shape. Nothing above this file knows the library.

export type ChatKind = "private" | "group" | "channel" | "bot";

export interface TgChat {
  /** Telegram's marked id as text: a user's id, or a negative one for a group or a channel. */
  id: string;
  kind: ChatKind;
  title: string;
  username?: string;
  /** Saved Messages: the account's chat with itself. */
  self?: boolean;
  unread?: number;
  /** ISO time of the last message. */
  lastMessageAt?: string;
}

export type MediaKind = "photo" | "video" | "audio" | "voice" | "document" | "sticker" | "other";

export interface TgMedia {
  kind: MediaKind;
  fileName?: string;
  mime?: string;
  /** Bytes, when Telegram says. */
  size?: number;
}

export interface TgMessage {
  id: number;
  chatId: string;
  /** ISO time. */
  date: string;
  /** Sent by the account itself. */
  out: boolean;
  sender?: string;
  text: string;
  replyTo?: number;
  forwardedFrom?: string;
  media?: TgMedia;
}

/** One page of found messages. `next`, when there are more, is what `from` takes to go on from here. */
export interface TgPage {
  messages: TgMessage[];
  next?: unknown;
}

export interface TgAccount {
  id: string;
  name: string;
  username?: string;
}

export interface TgFile {
  data: Uint8Array;
  fileName: string;
  mime?: string;
}

export interface QrSignIn {
  /** The link the QR code carries (tg://login?token=…); it changes about every half a minute. */
  onUrl(url: string, expires: Date): void;
  /** The code was scanned; the sign-in is being finished. */
  onScanned(): void;
  /** The account has two-step verification: resolves with what the person typed. `wrong` after a refused try. */
  password(wrong: boolean): Promise<string>;
  signal: AbortSignal;
}

export interface TgClient {
  /** Open a saved session. Undefined when Telegram no longer knows it (ended from another device). */
  resume(session: string): Promise<TgAccount | undefined>;
  /** Sign in by QR code; resolves once the account is in. Rejects when aborted. */
  signInQr(h: QrSignIn): Promise<TgAccount>;
  /** The session key to keep (in the vault): whoever holds it is the account. */
  exportSession(): Promise<string>;
  /** End the session on Telegram's side. */
  logOut(): Promise<void>;
  /** Drop the connection; the session stays valid. */
  close(): Promise<void>;
  /** The account's chats, most recent first. */
  chats(limit: number): Promise<TgChat[]>;
  /** One of the account's chats by its id or @username; undefined when the account has no such chat (a public name it is not in included). */
  chat(ref: string): Promise<TgChat | undefined>;
  /** Messages of a chat, newest first; `beforeId` pages back. Reading marks nothing as read. */
  history(chatId: string, o: { limit: number; beforeId?: number }): Promise<TgMessage[]>;
  /** Messages with the words, newest first, a page at a time: in one chat, or in every chat of the account. */
  search(query: string, o: { chatId?: string; limit: number; from?: unknown }): Promise<TgPage>;
  /** A message's attachment; undefined when it has none. Rejects with FileTooLarge over `maxBytes`. */
  download(chatId: string, messageId: number, maxBytes: number): Promise<TgFile | undefined>;
  sendText(chatId: string, text: string, o?: { replyTo?: number }): Promise<TgMessage>;
  sendFile(chatId: string, file: TgFile, o?: { caption?: string; replyTo?: number }): Promise<TgMessage>;
  /** New messages as they arrive, with their chat. Returns the unsubscribe. */
  onMessage(cb: (message: TgMessage, chat: TgChat) => void): () => void;
  /** Telegram ended the session (the person removed the device there). */
  onSignedOut(cb: () => void): () => void;
}

export interface TgClientOptions {
  apiId: number;
  apiHash: string;
  /** What Telegram shows in Settings → Devices. */
  deviceModel: string;
  appVersion: string;
  log(level: "debug" | "info" | "warn" | "error", msg: string): void;
}

export type TgClientFactory = (o: TgClientOptions) => TgClient | Promise<TgClient>;

/** A download refused for its size. */
export class FileTooLarge extends Error {
  size: number;
  constructor(size: number) {
    super(`the file is ${size} bytes`);
    this.size = size;
  }
}
