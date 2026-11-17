// The account's list of chats, kept. Walking it is the expensive thing to ask of Telegram: a hundred chats a
// request, one request after another, and an account that is asked for it every few seconds gets rate-limited
// (FLOOD_WAIT). So there is one walk at a time, shared by everyone who asks meanwhile; its result is kept and brought
// up to date from what arrives (a new message, a chat read on another device); and a chat is looked up in the list
// there is, whatever its age: ids, names and kinds do not go stale.

import type { TgChat, TgMessage } from "./client.ts";

/** The first walk of a large account takes a while (requests to Telegram are paced): what waited for it gave up. */
export class StillLoading extends Error {
  constructor() {
    super("the list of chats is still loading");
  }
}

/** `work`, or StillLoading once `ms` have passed; the work itself goes on. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StillLoading()), ms);
  });
  // The work may still fail after nobody waits for it.
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export interface ChatListOptions {
  /** How long a walk's result answers "the whole list" before the next walk. */
  freshMs: number;
  now?: () => number;
}

export class ChatList {
  private load: () => Promise<TgChat[]>;
  private freshMs: number;
  private now: () => number;
  private list: TgChat[] | undefined;
  /** When the list was last walked, or a walk was last refused. */
  private at = 0;
  private walking: Promise<TgChat[]> | undefined;

  constructor(load: () => Promise<TgChat[]>, o: ChatListOptions) {
    this.load = load;
    this.freshMs = o.freshMs;
    this.now = o.now ?? Date.now;
  }

  private get fresh(): boolean {
    return !!this.list && this.now() - this.at < this.freshMs;
  }

  /** One walk at a time. A refused walk leaves the list there is, and is not asked again until that list is old. */
  private walk(): Promise<TgChat[]> {
    this.walking ??= (async () => {
      try {
        this.list = await this.load();
        this.at = this.now();
        return this.list;
      } catch (e) {
        if (!this.list) throw e;
        this.at = this.now();
        return this.list;
      } finally {
        this.walking = undefined;
      }
    })();
    return this.walking;
  }

  /** Every chat, most recent first. */
  async all(): Promise<TgChat[]> {
    return this.fresh ? this.list! : this.walk();
  }

  /** Walk now, whatever the list's age (still one walk at a time). */
  reload(): Promise<TgChat[]> {
    return this.walk();
  }

  /** One chat by its id or @username. A chat the list does not have is looked for again only once the list is old. */
  async find(ref: string): Promise<TgChat | undefined> {
    const name = ref.trim();
    const username = name.replace(/^@/, "").toLowerCase();
    const byId = /^-?\d+$/.test(name);
    const pick = (list: TgChat[]) => list.find((c) => (byId ? c.id === name : c.username?.toLowerCase() === username));
    const hit = pick(this.list ?? (await this.walk()));
    if (hit || this.fresh) return hit;
    return pick(await this.walk());
  }

  /** A message arrived (or was sent from another device): its chat goes first, with it as the last message. */
  note(message: TgMessage, chat: TgChat): void {
    if (!this.list) return;
    const at = this.list.findIndex((c) => c.id === chat.id);
    const known = at >= 0 ? this.list[at]! : chat;
    if (at >= 0) this.list.splice(at, 1);
    this.list.unshift({ ...known, last: message, lastMessageAt: message.date, unread: (known.unread ?? 0) + (message.out ? 0 : 1) });
  }

  /** The chat was read (here or on another device): this many are still unread. */
  read(chatId: string, unread: number): void {
    const chat = this.list?.find((c) => c.id === chatId);
    if (chat) chat.unread = unread;
  }

  clear(): void {
    this.list = undefined;
    this.at = 0;
  }
}
