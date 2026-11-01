// Secrets in the chat. The user types a secret into a card in the conversation, or pastes it into a message; it goes
// straight into the vault and everything downstream (the stored message, message hooks, the model, logs) only sees
// vault://<id>. Plugin manifests describe the secrets they need (contributes.setup.secrets), which lets the hub
// recognise a pasted token, point the plugin's setting at it and wake the plugin.

import type { Locale, PluginSetupView, SecretRequest, SecretRequestStatus, SetupSecret } from "@piomio/shared";
import { newId, nowIso } from "@piomio/shared";
import type { Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { AuditLog } from "./audit.ts";
import type { VaultService } from "./vault/service.ts";
import type { PluginHost, PluginRecord } from "./plugins/host.ts";
import { VAULT_ID } from "./vault/service.ts";
import { LocalizedError, hubLocale, localizePluginValue, tFor } from "./i18n.ts";

/**
 * Well-known token formats that no plugin declares (MCP servers, CLIs), and model providers' keys, which the API
 * brain declares but which must not reach the model when it is not loaded (Config.apiKeys). Whole-token matches only.
 */
const KNOWN: Array<{ vault: string; pattern: RegExp }> = [
  { vault: "anthropic_api_key", pattern: /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/ },
  { vault: "openrouter_api_key", pattern: /^sk-or-v1-[A-Za-z0-9]{20,}$/ },
  { vault: "openai_api_key", pattern: /^sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}$/ },
  { vault: "xai_api_key", pattern: /^xai-[A-Za-z0-9]{20,}$/ },
  { vault: "groq_api_key", pattern: /^gsk_[A-Za-z0-9]{20,}$/ },
  { vault: "github_token", pattern: /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})$/ },
  { vault: "gitlab_token", pattern: /^glpat-[A-Za-z0-9_-]{20,}$/ },
  { vault: "slack_token", pattern: /^xox[abposr]-[A-Za-z0-9-]{10,}$/ },
  { vault: "google_api_key", pattern: /^AIza[0-9A-Za-z_-]{35}$/ },
  { vault: "stripe_secret_key", pattern: /^(sk|rk)_live_[A-Za-z0-9]{20,}$/ },
  { vault: "huggingface_token", pattern: /^hf_[A-Za-z0-9]{30,}$/ },
  { vault: "notion_token", pattern: /^(secret_|ntn_)[A-Za-z0-9]{40,}$/ },
];

const MAX_SECRET = 16_384;
/** Characters people wrap a pasted token in. */
const WRAP = /^[`'"«“<(\[]+|[`'"»”>)\].,;:!?]+$/g;

export interface StoredSecret {
  vaultId: string;
  title: string;
  pluginId?: string;
}

export interface CaptureResult {
  /** The message with every secret replaced by vault://<id> (or a placeholder when the vault is locked). */
  text: string;
  stored: StoredSecret[];
  /** Secrets found while the vault was locked: removed from the text, stored nowhere. */
  withheld: number;
  /** A pending request answered by this message, and whether its tool call was still waiting for it. */
  answered?: { request: SecretRequest; waited: boolean };
}

interface Matcher {
  vault: string;
  pattern: RegExp;
  pluginId?: string;
  secret?: SetupSecret;
}

interface Deps {
  db: Db;
  bus: EventBus;
  audit: AuditLog;
  vault: VaultService;
  plugins: () => PluginHost;
}

export class SecretIntake {
  private d: Deps;
  private waiters = new Map<string, Array<(r: SecretRequest) => void>>();
  /** Set by the runner: update the cards and, when nobody waited, tell the agent. */
  onResolved?: (r: SecretRequest, how: { waited: boolean; viaMessage: boolean }) => void;

  constructor(d: Deps) {
    this.d = d;
  }

  // ---------- requests ----------

  /** A card in the chat asking the user for one secret, or for a site's login (`login`). */
  create(input: {
    vaultId: string;
    title: string;
    hint?: string;
    link?: string;
    pluginId?: string;
    setting?: string;
    login?: { domain: string; username?: string };
    conversationId?: string;
  }): SecretRequest {
    if (!VAULT_ID.test(input.vaultId)) throw new LocalizedError("vault.badId", { id: input.vaultId.slice(0, 80) }, 400);
    const login = input.login ? { domain: siteDomain(input.login.domain), ...(input.login.username?.trim() ? { username: input.login.username.trim().slice(0, 200) } : {}) } : undefined;
    if (login && !login.domain) throw new LocalizedError("secrets.badDomain", undefined, 400);
    if (input.pluginId && !login) this.checkPluginTarget(input.pluginId, input.vaultId, input.setting);
    const id = newId("sr_");
    this.d.db
      .prepare("insert into secret_requests(id, vault_id, title, hint, link, plugin_id, setting, login, conversation_id, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        input.vaultId,
        input.title,
        input.hint ?? null,
        input.link ?? null,
        login ? null : (input.pluginId ?? null),
        login ? null : (input.setting ?? null),
        login ? JSON.stringify(login) : null,
        input.conversationId ?? null,
        "pending",
        nowIso(),
      );
    const r = this.get(id)!;
    this.d.bus.emit("secret.request", r);
    return r;
  }

  get(id: string): SecretRequest | undefined {
    const r: any = this.d.db.prepare("select * from secret_requests where id = ?").get(id);
    return r ? this.fromRow(r) : undefined;
  }

  pending(conversationId: string): SecretRequest[] {
    return (this.d.db.prepare("select * from secret_requests where conversation_id = ? and status = 'pending' order by created_at").all(conversationId) as any[]).map((r) =>
      this.fromRow(r),
    );
  }

  /** Store the value for a request (a login's username and password). `waited` tells whether a tool call was still waiting for it. */
  fulfil(id: string, value: string | { username?: string; password?: string }, actor: string): { request: SecretRequest; waited: boolean } {
    const req = this.get(id);
    if (!req) throw new LocalizedError("secrets.requestNotFound", undefined, 404);
    if (req.status !== "pending") throw new LocalizedError("secrets.requestClosed", undefined, 409);
    if (req.login) {
      const v = typeof value === "string" ? { password: value } : value;
      this.storeLogin({ vaultId: req.vaultId, title: req.title, domain: req.login.domain, username: String(v.username ?? req.login.username ?? ""), password: String(v.password ?? ""), actor });
    } else this.store({ vaultId: req.vaultId, title: req.title, value: typeof value === "string" ? value : String(value.password ?? ""), pluginId: req.pluginId, setting: req.setting, actor });
    return this.resolve(req.id, "saved");
  }

  /** A site's login typed in the chat: a login item for that domain, which only the browser may type into its pages. */
  storeLogin(input: { vaultId: string; title: string; domain: string; username: string; password: string; actor: string }): void {
    const password = input.password;
    const username = input.username.trim();
    if (!password.trim() || password.length > MAX_SECRET || username.length > 200) throw new LocalizedError("secrets.badValue", undefined, 400);
    if (!VAULT_ID.test(input.vaultId)) throw new LocalizedError("vault.badId", { id: input.vaultId.slice(0, 80) }, 400);
    if (this.d.vault.state() !== "unlocked") throw new LocalizedError("secrets.vaultLocked", undefined, 409);
    const prev = this.d.vault.getMeta(input.vaultId);
    if (prev && prev.type !== "login") throw new LocalizedError("secrets.notALogin", { id: input.vaultId }, 409);
    const domains = [...new Set([input.domain, ...(prev?.scope.domains ?? [])])];
    this.d.vault.upsert({ id: input.vaultId, type: "login", name: prev?.name ?? input.title, fields: { ...(username ? { username } : {}), password }, scope: { ...(prev?.scope ?? {}), domains } });
    this.d.audit.append(input.actor, "vault.upsert", input.vaultId, { via: "chat", login: input.domain, replaced: !!prev });
  }

  cancel(id: string, actor: string): SecretRequest {
    const req = this.get(id);
    if (!req) throw new LocalizedError("secrets.requestNotFound", undefined, 404);
    if (req.status !== "pending") return req;
    this.d.audit.append(actor, "secret.cancel", req.vaultId);
    return this.resolve(req.id, "cancelled").request;
  }

  /** Resolves when the request is saved or cancelled, or with the still-pending request after `ms`. */
  wait(id: string, ms: number): Promise<SecretRequest> {
    const now = this.get(id);
    if (!now || now.status !== "pending") return Promise.resolve(now!);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      const done = (r: SecretRequest) => {
        clearTimeout(timer);
        resolve(r);
      };
      list.push(done);
      this.waiters.set(id, list);
      const timer = setTimeout(() => {
        const l = this.waiters.get(id)?.filter((f) => f !== done) ?? [];
        if (l.length) this.waiters.set(id, l);
        else this.waiters.delete(id);
        resolve(this.get(id)!);
      }, ms);
      timer.unref?.();
    });
  }

  private resolve(id: string, status: SecretRequestStatus, viaMessage = false): { request: SecretRequest; waited: boolean } {
    this.d.db.prepare("update secret_requests set status = ?, resolved_at = ? where id = ?").run(status, nowIso(), id);
    const r = this.get(id)!;
    const waiters = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const w of waiters) w(r);
    this.d.bus.emit("secret.request", r);
    this.onResolved?.(r, { waited: waiters.length > 0, viaMessage });
    return { request: r, waited: waiters.length > 0 };
  }

  // ---------- storing ----------

  /** Write a secret typed in the chat into the vault and point the plugin's setting at it. */
  store(input: { vaultId: string; title: string; value: string; pluginId?: string; setting?: string; actor: string }): StoredSecret {
    const value = input.value.trim();
    if (!value || value.length > MAX_SECRET) throw new LocalizedError("secrets.badValue", undefined, 400);
    if (!VAULT_ID.test(input.vaultId)) throw new LocalizedError("vault.badId", { id: input.vaultId.slice(0, 80) }, 400);
    if (this.d.vault.state() !== "unlocked") throw new LocalizedError("secrets.vaultLocked", undefined, 409);
    const prev = this.d.vault.getMeta(input.vaultId);
    // Logins and identities have several fields and domain scopes: those stay in the security console.
    if (prev && prev.type !== "secret") throw new LocalizedError("secrets.notASecret", { id: input.vaultId }, 409);
    if (input.pluginId) this.checkPluginTarget(input.pluginId, input.vaultId, input.setting);
    this.d.vault.upsert({ id: input.vaultId, type: "secret", name: prev?.name ?? input.title, fields: { value }, scope: prev?.scope });
    this.d.audit.append(input.actor, "vault.upsert", input.vaultId, { via: "chat", plugin: input.pluginId, replaced: !!prev });
    if (input.pluginId && input.setting) {
      const rec = this.d.plugins().get(input.pluginId)!;
      const ref = `vault://${input.vaultId}`;
      if (rec.settings[input.setting] !== ref) this.d.plugins().setSettings(input.pluginId, { ...rec.settings, [input.setting]: ref });
    }
    // The vault itself announces the change ("vault.updated", see app.ts), as for every other way an item is stored.
    return { vaultId: input.vaultId, title: input.title, pluginId: input.pluginId };
  }

  /** The plugin must be allowed to read the item (manifest or console grant) and own the setting it names. */
  private checkPluginTarget(pluginId: string, vaultId: string, setting?: string): void {
    const rec = this.d.plugins().get(pluginId);
    if (!rec) throw new LocalizedError("plugin.notFound", undefined, 404);
    if (!pluginMayRead(rec, vaultId)) throw new LocalizedError("secrets.pluginCannotRead", { plugin: pluginId, id: vaultId }, 400);
    const props = (rec.layout?.manifest.contributes.settings as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    if (setting && !(setting in props)) throw new LocalizedError("secrets.unknownSetting", { plugin: pluginId, setting }, 400);
  }

  // ---------- messages ----------

  /**
   * Take the secrets out of a user message before anything else sees it. Recognises the formats plugins declare
   * (contributes.setup.secrets[].pattern) and well-known tokens; a message that is one bare token answers the
   * conversation's pending request.
   */
  capture(text: string, conversationId: string, actor: string): CaptureResult {
    const result: CaptureResult = { text, stored: [], withheld: 0 };
    if (!text) return result;
    const matchers = this.matchers();
    const locked = this.d.vault.state() !== "unlocked";
    const replace = (token: string, ref: string) => {
      result.text = result.text.split(token).join(ref);
    };

    for (const raw of text.split(/\s+/)) {
      const token = raw.replace(WRAP, "");
      if (token.length < 16) continue;
      const m = matchers.find((x) => x.pattern.test(token));
      if (!m) continue;
      if (locked) {
        result.withheld++;
        replace(token, tFor(hubLocale())("secrets.withheldPlaceholder"));
        continue;
      }
      const title = m.secret && m.pluginId ? this.secretTitle(m.pluginId, m.secret, hubLocale()) : tFor(hubLocale())(`secrets.known.${m.vault}`);
      const usable = m.pluginId && pluginMayRead(this.d.plugins().get(m.pluginId), m.vault);
      result.stored.push(this.store({ vaultId: m.vault, title, value: token, pluginId: usable ? m.pluginId : undefined, setting: usable ? m.secret?.setting : undefined, actor }));
      replace(token, `vault://${m.vault}`);
      const open = this.pending(conversationId).find((r) => r.vaultId === m.vault);
      if (open) result.answered = this.resolve(open.id, "saved", true);
    }
    if (result.stored.length || result.withheld) return result;

    // One bare token while the chat waits for a secret: that is the answer.
    const open = this.pending(conversationId);
    const token = text.trim().replace(WRAP, "");
    if (open.length === 1 && token.length >= 8 && !/\s/.test(token) && !/^(https?:\/\/|\/)/i.test(token)) {
      const req = open[0];
      if (locked) {
        result.withheld++;
        result.text = tFor(hubLocale())("secrets.withheldPlaceholder");
        return result;
      }
      result.stored.push(this.store({ vaultId: req.vaultId, title: req.title, value: token, pluginId: req.pluginId, setting: req.setting, actor }));
      result.text = `vault://${req.vaultId}`;
      result.answered = this.resolve(req.id, "saved", true);
    }
    return result;
  }

  /** Plugin-declared formats first (in plugin order), then the well-known ones. */
  private matchers(): Matcher[] {
    const out: Matcher[] = [];
    for (const rec of this.d.plugins().list()) {
      if (!rec.enabled) continue;
      for (const s of rec.layout?.manifest.contributes.setup?.secrets ?? []) {
        if (!s.pattern) continue;
        try {
          out.push({ vault: s.vault, pattern: new RegExp(s.pattern), pluginId: rec.id, secret: s });
        } catch {
          /* a broken pattern in a third-party manifest only disables recognition */
        }
      }
    }
    for (const k of KNOWN) if (!out.some((m) => m.vault === k.vault)) out.push(k);
    return out;
  }

  // ---------- plugin setup ----------

  /** What a plugin still needs, for the setup card. */
  setupView(pluginId: string, locale: Locale): PluginSetupView {
    const rec = this.d.plugins().get(pluginId);
    if (!rec) throw new LocalizedError("plugin.notFound", undefined, 404);
    const declared = rec.layout?.manifest.contributes.setup?.secrets ?? [];
    return {
      pluginId,
      name: localizePluginValue(rec.layout, rec.layout?.manifest.name ?? pluginId, locale),
      enabled: rec.enabled,
      status: rec.status,
      lastError: rec.lastError,
      vaultState: this.d.vault.state(),
      secrets: declared.map((s) => ({
        vaultId: s.vault,
        title: this.secretTitle(pluginId, s, locale),
        hint: s.hint ? localizePluginValue(rec.layout, s.hint, locale) : undefined,
        link: s.link,
        pattern: s.pattern,
        required: s.required,
        present: !!this.d.vault.getMeta(s.vault),
        setting: s.setting,
      })),
    };
  }

  /** The declared secret of a plugin, for storing from its setup card. */
  setupSecret(pluginId: string, vaultId: string): SetupSecret {
    const s = this.d.plugins().get(pluginId)?.layout?.manifest.contributes.setup?.secrets.find((x) => x.vault === vaultId);
    if (!s) throw new LocalizedError("secrets.notDeclared", { plugin: pluginId, id: vaultId }, 404);
    return s;
  }

  secretTitle(pluginId: string, s: SetupSecret, locale: Locale): string {
    return localizePluginValue(this.d.plugins().get(pluginId)?.layout, s.title, locale);
  }

  private fromRow(r: any): SecretRequest {
    return {
      id: r.id,
      vaultId: r.vault_id,
      title: r.title,
      hint: r.hint ?? undefined,
      link: r.link ?? undefined,
      pluginId: r.plugin_id ?? undefined,
      setting: r.setting ?? undefined,
      ...(r.login ? { login: JSON.parse(r.login) } : {}),
      conversationId: r.conversation_id ?? undefined,
      status: r.status,
      exists: !!this.d.vault.getMeta(r.vault_id),
      createdAt: r.created_at,
      resolvedAt: r.resolved_at ?? undefined,
    };
  }
}

/** Same rule as the plugin host's vault.get: manifest permissions plus console grants. */
/** "https://www.x.com/login" or "X.com" → "x.com": the host a login is kept for; "" when it is not one. */
export function siteDomain(input: string): string {
  const s = String(input ?? "").trim().toLowerCase();
  let host = s;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : "";
}

export function pluginMayRead(rec: PluginRecord | undefined, vaultId: string): boolean {
  if (!rec) return false;
  return [...rec.granted.vault, ...rec.extraVault].some((g) => g === vaultId || g === "*" || g === "secret:*");
}

/** System note for the model after secrets were taken out of the user's message. */
export function captureNote(c: CaptureResult): string {
  const lines: string[] = [];
  if (c.stored.length) {
    lines.push(
      "[System] The user's message contained secrets. They were stored in the vault and replaced with references: " +
        c.stored.map((s) => `vault://${s.vaultId} (${s.title}${s.pluginId ? `, used by plugin ${s.pluginId}` : ""})`).join(", ") +
        ". You never see secret values; refer to them by these references and do not ask the user to repeat them.",
    );
  }
  if (c.withheld) lines.push("[System] The user's message contained a secret, but the vault is locked, so it was removed and stored nowhere. Ask the user to unlock the vault and send it again.");
  return lines.join("\n");
}
