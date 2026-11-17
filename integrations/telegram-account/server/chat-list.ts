// The account's list of chats, kept. Walking it is the expensive thing to ask of Telegram: a hundred chats a
// request, one request after another with a pause between them, and an account that is asked for it every few
// seconds gets rate-limited (FLOOD_WAIT). So there is one walk at a time, shared by everyone who asks meanwhile; its
// result is kept and brought up to date from what arrives (a new message, a chat read on another device); and a chat
// is looked up in the list there is, whatever its age: ids, names and kinds do not go stale.
//
// The walk comes page by page, the most recent chats first, and nobody waits for more of it than they need: "what
// is new" is answered from the first page, one chat as soon as its page is there, and only what must see every chat
// (a search across the account, a chat named by its title) waits for the end.

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
  /** How long a finished walk answers "the whole list" before the next walk. */
  freshMs: number;
  /** How long after a walk Telegram refused the next one is tried. */
  retryMs: number;
  now?: () => number;
}

/** One walk of the list: its pages in order, the most recent chats first. */
export type ChatPages = () => AsyncIterable<TgChat[]>;

/**
 * What arrived while a walk went on, in the order it happened: a message with its chat, or a chat read down to this
 * many unread.
 */
type Noted = { message: TgMessage; chat: TgChat } | { read: string; unread: number };

/** Put a message into a list: its chat goes first, with it as the last message. A message the list has is left. */
function applyNote(list: TgChat[], message: TgMessage, chat: TgChat): void {
  const at = list.findIndex((c) => c.id === chat.id);
  const known = at >= 0 ? list[at]! : chat;
  if (known.last && known.last.id >= message.id) return;
  if (at >= 0) list.splice(at, 1);
  list.unshift({ ...known, last: message, lastMessageAt: message.date, unread: (known.unread ?? 0) + (message.out ? 0 : 1) });
}

/** A chat of the list was read: this many are still unread. The chat's entry is replaced, not changed. */
function applyRead(list: TgChat[], chatId: string, unread: number): void {
  const at = list.findIndex((c) => c.id === chatId);
  if (at >= 0) list[at] = { ...list[at]!, unread };
}

export class ChatList {
  private pages: ChatPages;
  private freshMs: number;
  private retryMs: number;
  private now: () => number;
  /** What is known now: the whole list, or its first pages while the first walk goes on (or was refused midway). */
  private list: TgChat[] | undefined;
  /** A walk reached the end: `list` is every chat. */
  private complete = false;
  /** When a walk last ended, finished or refused. */
  private at = 0;
  private walking: Promise<void> | undefined;
  /**
   * What arrived during the walk: put again, in order, into the pages as they come, which may be older than it. A
   * page is how its chats were when it came, so what was read before that is dropped for them; a message is told
   * from one the page has by its id.
   */
  private noted: Noted[] = [];
  private waiting = new Set<() => void>();

  constructor(pages: ChatPages, o: ChatListOptions) {
    this.pages = pages;
    this.freshMs = o.freshMs;
    this.retryMs = o.retryMs;
    this.now = o.now ?? Date.now;
  }

  /** Time for a walk: nothing is known, the whole list is old, or a refused walk can be tried again. */
  private get stale(): boolean {
    return !this.list || this.now() - this.at >= (this.complete ? this.freshMs : this.retryMs);
  }

  /** Resolves when the walk brings its next page, or ends. */
  private step(): Promise<void> {
    return new Promise((resolve) => this.waiting.add(resolve));
  }

  private wake(): void {
    const all = [...this.waiting];
    this.waiting.clear();
    for (const resolve of all) resolve();
  }

  /**
   * One walk at a time. While no walk has finished yet its pages are shown as they come; a later walk replaces the
   * whole list at its end. A refused walk leaves what there is, and rejects only when there is nothing.
   */
  private walk(): Promise<void> {
    this.walking ??= (async () => {
      const next: TgChat[] = [];
      const withNotes = () => {
        const list = [...next];
        for (const n of this.noted) {
          if ("read" in n) applyRead(list, n.read, n.unread);
          else applyNote(list, n.message, n.chat);
        }
        return list;
      };
      this.noted = [];
      try {
        for await (const page of this.pages()) {
          const came = new Set(page.map((c) => c.id));
          this.noted = this.noted.filter((n) => !("read" in n) || !came.has(n.read));
          next.push(...page);
          if (!this.complete) this.list = withNotes();
          this.wake();
        }
        this.list = withNotes();
        this.complete = true;
      } catch (e) {
        if (!this.list) throw e;
      } finally {
        this.at = this.now();
        this.noted = [];
        this.walking = undefined;
        this.wake();
      }
    })();
    return this.walking;
  }

  /** Every chat, most recent first: waits for a walk to reach the end. */
  async all(): Promise<TgChat[]> {
    if (this.stale || this.walking) await this.walk();
    return this.list!;
  }

  /**
   * The chats known now, most recent first, without waiting for the whole walk: at least its first page.
   * `complete` is false while older chats are still to come.
   */
  async recent(): Promise<{ chats: TgChat[]; complete: boolean }> {
    if (this.stale) {
      const walk = this.walk();
      // Nobody may be waiting for the end of it: its failure is told to whoever asks next.
      walk.catch(() => {});
      while (!this.list && this.walking) await Promise.race([this.step(), walk]);
      if (!this.list) await walk;
    }
    return { chats: this.list!, complete: this.complete };
  }

  /**
   * One chat by its id or @username. While a walk goes on it is found as soon as its page comes; a chat the whole
   * list does not have is looked for again only once the list is old.
   */
  async find(ref: string): Promise<TgChat | undefined> {
    const name = ref.trim();
    const username = name.replace(/^@/, "").toLowerCase();
    const byId = /^-?\d+$/.test(name);
    const pick = () => this.list?.find((c) => (byId ? c.id === name : c.username?.toLowerCase() === username));
    for (;;) {
      const hit = pick();
      if (hit) return hit;
      if (!this.walking && !this.stale) return undefined;
      const walk = this.walk();
      // A page may come before the end, and nobody then waits for this walk's end here: its failure is not lost,
      // whoever sees the walk over asks it below.
      walk.catch(() => {});
      await Promise.race([this.step(), walk]).catch(() => {});
      if (this.walking !== walk) {
        // The walk is over: with nothing at all it failed, and says why.
        await walk;
        return pick();
      }
    }
  }

  /** A message arrived (or was sent from another device): its chat goes first, with it as the last message. */
  note(message: TgMessage, chat: TgChat): void {
    if (this.walking) this.noted.push({ message, chat });
    if (this.list) applyNote(this.list, message, chat);
  }

  /** The chat was read (here or on another device): this many are still unread. */
  read(chatId: string, unread: number): void {
    if (this.walking) this.noted.push({ read: chatId, unread });
    if (this.list) applyRead(this.list, chatId, unread);
  }

  clear(): void {
    this.list = undefined;
    this.complete = false;
    this.at = 0;
  }
}
