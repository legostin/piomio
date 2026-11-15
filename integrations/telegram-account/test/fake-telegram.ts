// A fake Telegram for the tests: a client of the same shape as the real one (server/client.ts), run inside the
// plugin's process (TELEGRAM_ACCOUNT_TEST_CLIENT names this file). What the account holds comes from a fixture file;
// the test drives what Telegram would do (the code is scanned, a message arrives, the session is ended elsewhere)
// and looks at what the plugin did (what it sent, whether it signed out) through a small control server on
// 127.0.0.1, whose port is written beside the fixture.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { FileTooLarge } from "../server/client.ts";
import type { TgChat, TgClient, TgClientFactory, TgMessage } from "../server/client.ts";

export interface FakeMessage extends TgMessage {
  /** The attachment's bytes, base64. */
  file?: string;
}

export interface Fixture {
  account: { id: string; name: string; username?: string };
  /** Two-step verification, when the account has it. */
  password?: string;
  chats: TgChat[];
  messages: Record<string, FakeMessage[]>;
  /** Session keys Telegram still knows. */
  sessions: string[];
}

interface State {
  fixture: Fixture;
  sent: Array<{ chatId: string; text?: string; file?: string; caption?: string; replyTo?: number }>;
  loggedOut: number;
  /** How many clients are open now. */
  open: number;
  scan?: () => void;
  passwords: string[];
  onMessage: Set<(m: TgMessage, chat: TgChat) => void>;
  onSignedOut: Set<() => void>;
  nextId: number;
}

const file = process.env.TELEGRAM_ACCOUNT_TEST_FIXTURE!;
const state: State = { fixture: JSON.parse(readFileSync(file, "utf8")), sent: [], loggedOut: 0, open: 0, passwords: [], onMessage: new Set(), onSignedOut: new Set(), nextId: 9000 };

const body = (req: import("node:http").IncomingMessage) =>
  new Promise<any>((resolve) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => resolve(text ? JSON.parse(text) : {}));
  });

const control = createServer(async (req, res) => {
  const send = (v: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
  const b = await body(req);
  switch (req.url) {
    case "/scan":
      state.scan?.();
      return send({ ok: !!state.scan });
    case "/incoming": {
      const chat = state.fixture.chats.find((c) => c.id === b.chatId)!;
      const m: TgMessage = { id: state.nextId++, chatId: chat.id, date: new Date().toISOString(), out: false, sender: "Someone", text: "", ...b.message };
      (state.fixture.messages[chat.id] ??= []).push(m);
      for (const cb of state.onMessage) cb(m, chat);
      return send({ id: m.id });
    }
    case "/revoke":
      state.fixture.sessions = [];
      for (const cb of [...state.onSignedOut]) cb();
      return send({ ok: true });
    case "/state":
      return send({ sent: state.sent, loggedOut: state.loggedOut, open: state.open, sessions: state.fixture.sessions, passwords: state.passwords });
    default:
      res.writeHead(404).end();
  }
});
control.unref();
control.listen(0, "127.0.0.1", () => writeFileSync(`${file}.port`, String((control.address() as any).port)));

const factory: TgClientFactory = () => {
  let closed = false;
  const offs: Array<() => void> = [];
  state.open++;
  const chatById = (id: string) => state.fixture.chats.find((c) => c.id === id);
  const sorted = (chatId: string) => [...(state.fixture.messages[chatId] ?? [])].sort((a, b) => b.id - a.id);
  const strip = ({ file: _file, ...m }: FakeMessage): TgMessage => m;
  const client: TgClient = {
    async resume(session) {
      return state.fixture.sessions.includes(session) ? state.fixture.account : undefined;
    },
    async signInQr(h) {
      h.onUrl("tg://login?token=fake-token-1", new Date(Date.now() + 30_000));
      await new Promise<void>((resolve, reject) => {
        state.scan = resolve;
        h.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      state.scan = undefined;
      h.onScanned();
      if (state.fixture.password) {
        for (let wrong = false; ; wrong = true) {
          const given = await h.password(wrong);
          state.passwords.push(given);
          if (given === state.fixture.password) break;
        }
      }
      return state.fixture.account;
    },
    async exportSession() {
      const s = `session-${state.fixture.sessions.length + 1}`;
      state.fixture.sessions.push(s);
      return s;
    },
    async logOut() {
      state.loggedOut++;
      state.fixture.sessions = [];
    },
    async close() {
      if (closed) return;
      closed = true;
      state.open--;
      for (const off of offs) off();
    },
    async chats(limit) {
      return state.fixture.chats.slice(0, limit);
    },
    async chat(ref) {
      const name = ref.replace(/^@/, "").toLowerCase();
      return state.fixture.chats.find((c) => c.id === ref || c.username?.toLowerCase() === name);
    },
    async history(chatId, { limit, beforeId }) {
      return sorted(chatId).filter((m) => !beforeId || m.id < beforeId).slice(0, limit).map(strip);
    },
    async search(query, { chatId, limit }) {
      const all = chatId ? sorted(chatId) : Object.keys(state.fixture.messages).flatMap(sorted).sort((a, b) => b.date.localeCompare(a.date));
      return all.filter((m) => m.text.toLowerCase().includes(query.toLowerCase())).slice(0, limit).map(strip);
    },
    async download(chatId, messageId, maxBytes) {
      const m = (state.fixture.messages[chatId] ?? []).find((x) => x.id === messageId);
      if (!m?.media || !m.file) return undefined;
      const data = Buffer.from(m.file, "base64");
      if ((m.media.size ?? data.length) > maxBytes) throw new FileTooLarge(m.media.size ?? data.length);
      return { data, fileName: m.media.fileName ?? `file-${messageId}`, ...(m.media.mime ? { mime: m.media.mime } : {}) };
    },
    async sendText(chatId, text, o) {
      if (!chatById(chatId)) throw new Error("PEER_ID_INVALID");
      state.sent.push({ chatId, text, ...(o?.replyTo ? { replyTo: o.replyTo } : {}) });
      return { id: state.nextId++, chatId, date: new Date().toISOString(), out: true, text };
    },
    async sendFile(chatId, f, o) {
      state.sent.push({ chatId, file: f.fileName, ...(o?.caption ? { caption: o.caption } : {}), ...(o?.replyTo ? { replyTo: o.replyTo } : {}) });
      return { id: state.nextId++, chatId, date: new Date().toISOString(), out: true, text: o?.caption ?? "" };
    },
    onMessage(cb) {
      state.onMessage.add(cb);
      const off = () => state.onMessage.delete(cb);
      offs.push(off);
      return off;
    },
    onSignedOut(cb) {
      state.onSignedOut.add(cb);
      const off = () => state.onSignedOut.delete(cb);
      offs.push(off);
      return off;
    },
  };
  return client;
};

export default factory;
