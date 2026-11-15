// The connected Telegram account: signing in by QR code, keeping the session (its key in the vault), noticing when
// Telegram ended it, signing out, and what the person allowed: the mode (read only, or sending too) and which chats
// the agents may see. The mode and the access live in the plugin's storage, not in its settings: an agent can change
// a plugin's settings, and these are the person's alone (they change only through this plugin's own cards).

import qrcode from "qrcode-generator";
import type { PluginContext } from "@piomio/plugin-sdk";
import { CHAT_KINDS, canBeOpened, chatAccess, cleanAccess, emptyAccess, withException } from "./access.ts";
import type { Access, ChatReason, ChatState, Mode } from "./access.ts";
import type { AppKeys } from "./app-keys.ts";
import type { ChatKind, TgAccount, TgChat, TgClient, TgClientFactory } from "./client.ts";

export const SESSION_VAULT_ID = "telegram_account_session";

/** How long a QR code waits to be scanned before the sign-in gives up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** How long the password field waits. */
const PASSWORD_TIMEOUT_MS = 5 * 60_000;
const RESUME_RETRY_MS = 60_000;

export type AccountState =
  /** This build has no Telegram application keys: nothing can sign in. */
  | "no-app"
  /** The vault is locked: the session's key cannot be read yet. */
  | "locked"
  | "signed-out"
  /** A QR code is shown and waits to be scanned. */
  | "qr"
  /** Scanned; the account has two-step verification and its password is needed. */
  | "password"
  | "connecting"
  | "connected"
  /** Telegram ended the session (the person removed the device there). */
  | "revoked"
  | "error";

export interface AccountStatus {
  state: AccountState;
  /** Why it is in "error", in English (the card shows its own text for the other states). */
  detail?: string;
  account?: { name: string; username?: string };
  connectedAt?: string;
  /** While state is "qr": the code as an SVG, and when it stops working. */
  qr?: { svg: string; expiresAt: string };
  /** While state is "password": the last one was refused. */
  passwordWrong?: boolean;
  /** While state is "locked": the vault does not exist yet, or it is locked. */
  vault?: "uninitialized" | "sealed";
  mode: Mode;
  access: Access;
}

export interface ChatRow extends TgChat {
  state: ChatState;
  reason: ChatReason;
  /** False for the chat no setting opens (Telegram's service chat). */
  canOpen: boolean;
}

export class NotConnected extends Error {
  state: AccountState;
  constructor(state: AccountState) {
    super(`the Telegram account is not connected (${state})`);
    this.state = state;
  }
}

export function qrSvg(text: string): string {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Account {
  private ctx: PluginContext;
  private keys: AppKeys | undefined;
  private makeClient: TgClientFactory;
  private state: AccountState = "signed-out";
  private detail: string | undefined;
  private tg: TgClient | undefined;
  private me: (TgAccount & { connectedAt: string }) | undefined;
  private qr: { svg: string; expiresAt: string } | undefined;
  private vault: "uninitialized" | "sealed" | undefined;
  /** A sign-in was asked for and is checking the vault: a second ask meanwhile starts nothing. */
  private starting = false;
  private resuming: Promise<void> | undefined;
  private resumeAgain = false;
  private signIn: { abort: AbortController; password?: (v: string) => void; wrong: boolean; timer?: ReturnType<typeof setTimeout> } | undefined;
  private mode_: Mode = "read";
  private access_: Access = emptyAccess();
  private listeners = new Set<() => void>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private unsub: Array<() => void> = [];

  constructor(ctx: PluginContext, keys: AppKeys | undefined, makeClient: TgClientFactory) {
    this.ctx = ctx;
    this.keys = keys;
    this.makeClient = makeClient;
  }

  get mode(): Mode {
    return this.mode_;
  }
  get access(): Access {
    return this.access_;
  }
  get connected(): boolean {
    return this.state === "connected" && !!this.tg;
  }

  /** The client of the connected account. */
  client(): TgClient {
    if (!this.connected || !this.tg) throw new NotConnected(this.state);
    return this.tg;
  }

  status(): AccountStatus {
    return {
      state: this.state,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.me ? { account: { name: this.me.name, ...(this.me.username ? { username: this.me.username } : {}) }, connectedAt: this.me.connectedAt } : {}),
      ...(this.state === "qr" && this.qr ? { qr: this.qr } : {}),
      ...(this.state === "password" && this.signIn?.wrong ? { passwordWrong: true } : {}),
      ...(this.state === "locked" && this.vault ? { vault: this.vault } : {}),
      mode: this.mode_,
      access: this.access_,
    };
  }

  /** Hear every change of the status, the mode or the access. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(state: AccountState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    if (state !== "qr") this.qr = undefined;
    this.changed();
  }

  private changed(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (e) {
        this.ctx.log.warn(`telegram-account: a status listener failed: ${message(e)}`);
      }
    }
  }

  async start(): Promise<void> {
    this.mode_ = (await this.ctx.storage.get<string>("mode")) === "write" ? "write" : "read";
    this.access_ = cleanAccess(await this.ctx.storage.get("access"));
    this.me = (await this.ctx.storage.get<TgAccount & { connectedAt: string }>("account")) ?? undefined;
    if (!this.keys) return this.set("no-app");
    // Opening the session talks to Telegram: the plugin does not wait for it to count as started.
    void this.resume().catch((e) => this.ctx.log.warn(`telegram-account: ${message(e)}`));
  }

  /**
   * Open the saved session, if there is one. Called at start and when the vault opens or changes. One at a time: a
   * call while another runs is answered by one more run after it, so a vault that opened meanwhile is not missed.
   */
  resume(): Promise<void> {
    if (this.resuming) {
      this.resumeAgain = true;
      return this.resuming;
    }
    const run = (async () => {
      do {
        this.resumeAgain = false;
        await this.resumeOnce();
      } while (this.resumeAgain && !this.stopped);
    })().finally(() => {
      this.resuming = undefined;
    });
    this.resuming = run;
    return run;
  }

  private async resumeOnce(): Promise<void> {
    // A sign-in under way (or about to start) owns the state: it is not a session to open.
    if (this.stopped || !this.keys || this.tg || this.signIn || this.starting) return;
    if (this.retry) clearTimeout(this.retry);
    if (!(await this.vaultOpen())) return;
    let session: string | undefined;
    try {
      session = (await this.ctx.vault.get(`vault://${SESSION_VAULT_ID}`)).value;
    } catch (e: any) {
      const key = e?.data?.key;
      if (key === "vault.notFound") {
        // No session: signed out. What was remembered about an account is of a session that is no more.
        if (this.state !== "revoked") this.set("signed-out");
        return;
      }
      return this.set("locked", key === "vault.sealed" || key === "vault.uninitialized" ? undefined : message(e));
    }
    if (!session) return this.set("signed-out");
    this.set("connecting");
    let tg: TgClient | undefined;
    try {
      tg = await this.newClient();
      const me = await tg.resume(session);
      if (this.stopped) return void tg.close();
      if (!me) {
        await tg.close();
        await this.forgetSession();
        return this.set("revoked");
      }
      await this.adopt(tg, me, false);
    } catch (e) {
      await tg?.close();
      this.ctx.log.warn(`telegram-account: the session could not be opened: ${message(e)}. Trying again in a minute.`);
      this.set("error", message(e));
      this.retry = setTimeout(() => void this.resume(), RESUME_RETRY_MS);
    }
  }

  /**
   * Whether the vault can keep the session's key now. When it cannot (the person has not created it yet, or it is
   * locked) the state says so and nothing signs in: an account that is in without its key kept would be lost.
   */
  private async vaultOpen(): Promise<boolean> {
    let state: string | undefined;
    try {
      state = (await this.ctx.core.call<{ state?: string }>("vault.check", { ref: `vault://${SESSION_VAULT_ID}` })).state;
    } catch (e) {
      this.ctx.log.warn(`telegram-account: the vault's state could not be read: ${message(e)}`);
    }
    if (state === "unlocked") {
      this.vault = undefined;
      return true;
    }
    this.vault = state === "uninitialized" ? "uninitialized" : "sealed";
    this.set("locked");
    return false;
  }

  private async newClient(): Promise<TgClient> {
    return this.makeClient({
      apiId: this.keys!.apiId,
      apiHash: this.keys!.apiHash,
      deviceModel: "Piomio",
      appVersion: "1.0",
      log: (level, msg) => this.ctx.log[level](msg),
    });
  }

  private async adopt(tg: TgClient, me: TgAccount, fresh: boolean): Promise<void> {
    this.tg = tg;
    this.unsub.push(tg.onSignedOut(() => void this.onRevoked()));
    const connectedAt = (!fresh && this.me?.id === me.id && this.me.connectedAt) || new Date().toISOString();
    this.me = { ...me, connectedAt };
    await this.ctx.storage.set("account", this.me);
    this.set("connected");
  }

  /** Telegram ended the session: the key is worthless now. What the person allowed stays for the next sign-in. */
  private async onRevoked(): Promise<void> {
    if (!this.tg) return;
    await this.drop();
    await this.forgetSession();
    this.set("revoked");
  }

  private async drop(): Promise<void> {
    const tg = this.tg;
    this.tg = undefined;
    for (const u of this.unsub.splice(0)) u();
    await tg?.close();
  }

  private async forgetSession(): Promise<void> {
    try {
      await this.ctx.vault.remove(`vault://${SESSION_VAULT_ID}`);
    } catch (e) {
      this.ctx.log.warn(`telegram-account: the session's key could not be removed from the vault: ${message(e)}`);
    }
  }

  /**
   * Start the QR sign-in: the status then carries the code, and "password" if the account asks for one. Resolves
   * once the sign-in is under way (the state is "connecting") or could not start (the vault is not open: "locked");
   * the sign-in itself goes on after that, and the status tells how it ends.
   */
  async startSignIn(): Promise<void> {
    if (!this.keys) throw new Error("this build has no Telegram application keys");
    if (this.connected || this.signIn || this.starting) return;
    if (this.retry) clearTimeout(this.retry);
    this.starting = true;
    let open: boolean;
    try {
      // A look for a saved session that is still running (the plugin has just started) finishes first: it must not
      // write its "signed out" over a sign-in, and what it finds may make the sign-in needless.
      await this.resuming?.catch(() => {});
      open = !this.connected && (await this.vaultOpen());
    } finally {
      this.starting = false;
    }
    if (!open || this.stopped) return;
    const signIn: NonNullable<Account["signIn"]> = { abort: new AbortController(), wrong: false };
    this.signIn = signIn;
    this.set("connecting");
    void this.runSignIn(signIn);
  }

  private async runSignIn(signIn: NonNullable<Account["signIn"]>): Promise<void> {
    const giveUp = (ms: number) => {
      if (signIn.timer) clearTimeout(signIn.timer);
      signIn.timer = setTimeout(() => signIn.abort.abort(), ms);
    };
    giveUp(SIGN_IN_TIMEOUT_MS);
    let tg: TgClient | undefined;
    let signedIn = false;
    try {
      tg = await this.newClient();
      const me = await tg.signInQr({
        signal: signIn.abort.signal,
        onUrl: (url, expires) => {
          if (this.signIn !== signIn) return;
          this.qr = { svg: qrSvg(url), expiresAt: expires.toISOString() };
          this.set("qr");
        },
        onScanned: () => {
          if (this.signIn === signIn) this.set("connecting");
        },
        password: (wrong) =>
          new Promise<string>((resolve, reject) => {
            if (this.signIn !== signIn) return reject(new Error("cancelled"));
            signIn.wrong = wrong;
            signIn.password = resolve;
            signIn.abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            giveUp(PASSWORD_TIMEOUT_MS);
            this.set("password");
          }),
      });
      signedIn = true;
      if (signIn.abort.signal.aborted || this.stopped) throw new Error("cancelled");
      // The key first: an account that is in without its key kept would be lost at the next restart.
      await this.ctx.vault.put(`vault://${SESSION_VAULT_ID}`, { value: await tg.exportSession() }, { name: this.ctx.i18n.t("vault.session") });
      this.signIn = undefined;
      if (signIn.timer) clearTimeout(signIn.timer);
      await this.adopt(tg, me, true);
    } catch (e) {
      if (signIn.timer) clearTimeout(signIn.timer);
      const mine = this.signIn === signIn;
      if (mine) this.signIn = undefined;
      const cancelled = signIn.abort.signal.aborted;
      // A sign-in that got in but was not kept (its key could not be stored, or it was cancelled at the last moment)
      // must not leave a session behind on Telegram's side.
      if (tg && signedIn) await tg.logOut().catch(() => {});
      await tg?.close();
      if (!mine) return;
      if (cancelled) this.set("signed-out");
      else {
        this.ctx.log.warn(`telegram-account: the sign-in failed: ${message(e)}`);
        this.set("error", message(e));
      }
    }
  }

  cancelSignIn(): void {
    this.signIn?.abort.abort();
  }

  /** The two-step verification password the person typed on the card. It is handed to Telegram and kept nowhere. */
  submitPassword(password: string): boolean {
    const give = this.signIn?.password;
    if (!give || this.state !== "password") return false;
    this.signIn!.password = undefined;
    this.set("connecting");
    give(password);
    return true;
  }

  /** Sign out: the session ends on Telegram's side, its key leaves the vault. The mode goes back to read only. */
  async disconnect(): Promise<void> {
    this.cancelSignIn();
    if (this.retry) clearTimeout(this.retry);
    const tg = this.tg;
    if (tg) {
      try {
        await tg.logOut();
      } catch (e) {
        this.ctx.log.warn(`telegram-account: Telegram did not confirm the sign-out: ${message(e)}. The session's key is removed anyway; end the session in Telegram → Settings → Devices if it is still listed.`);
      }
    }
    await this.drop();
    await this.forgetSession();
    this.me = undefined;
    await this.ctx.storage.delete("account");
    this.mode_ = "read";
    await this.ctx.storage.set("mode", "read");
    this.set(this.keys ? "signed-out" : "no-app");
  }

  async setMode(mode: Mode): Promise<void> {
    if (mode !== "read" && mode !== "write") throw new Error("mode is read or write");
    this.mode_ = mode;
    await this.ctx.storage.set("mode", mode);
    this.changed();
  }

  async setKind(kind: ChatKind, open: boolean): Promise<void> {
    if (!CHAT_KINDS.includes(kind)) throw new Error("no such kind of chat");
    this.access_ = { ...this.access_, kinds: { ...this.access_.kinds, [kind]: open } };
    await this.ctx.storage.set("access", this.access_);
    this.changed();
  }

  /** One chat's exception: always open, always closed, or back to what its kind says. */
  async setException(chat: Pick<TgChat, "id" | "kind" | "title">, to: ChatState | "default"): Promise<void> {
    if (to === "open" && !canBeOpened(chat)) throw new Error("this chat cannot be opened");
    this.access_ = withException(this.access_, chat, to);
    await this.ctx.storage.set("access", this.access_);
    this.changed();
  }

  /** Every chat of the account with how it stands, for the person's own list (never for an agent). */
  async chatRows(query: string, limit: number): Promise<ChatRow[]> {
    const q = query.trim().toLowerCase();
    const all = await this.client().chats(2000);
    const rows = all.filter((c) => !q || c.title.toLowerCase().includes(q) || c.username?.toLowerCase().includes(q.replace(/^@/, "")));
    return rows.slice(0, limit).map((c) => ({ ...c, ...chatAccess(this.access_, c), canOpen: canBeOpened(c) }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.cancelSignIn();
    await this.drop();
  }
}
