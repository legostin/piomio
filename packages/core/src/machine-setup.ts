// What the person set for each machine (which brains, subscription or key, allowed models, a spend limit) and what its
// gateway spent (docs/superpowers/specs/2026-10-30-cluster-design.md, "Machines as a pool"). Keys stay in the vault:
// a machine gets them in node.setup, into its daemon's memory only.

import type { MachineBrainId, MachineModel, MachineSettings, MachineSetupView, MachineUsage, NodeSetup } from "@piomio/shared";
import { brainWire, KEY_PROVIDERS, keyProvider, nowIso } from "@piomio/shared";
import { json, type Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { AuditLog } from "./audit.ts";
import type { VaultService } from "./vault/service.ts";

export const MACHINE_BRAINS: readonly MachineBrainId[] = ["claude-code", "codex"];

/** Model ids become CLI arguments on the machine: plain tokens only. */
const SAFE_MODEL = /^[A-Za-z0-9][\w.:/@[\]-]{0,199}$/;

export class SetupError extends Error {}

/**
 * Checks and normalizes what an agent or the person asks for; throws SetupError with a reason for the model. Key mode
 * exists only on a hub started with PIOMIO_API_KEYS=1 (`apiKeys`).
 */
export function normalizeSettings(input: unknown, apiKeys = true): MachineSettings {
  const raw = (input ?? {}) as any;
  const out: MachineSettings = { brains: {} };
  for (const [id, b] of Object.entries((raw.brains ?? {}) as Record<string, any>)) {
    if (!MACHINE_BRAINS.includes(id as MachineBrainId)) throw new SetupError(`Unknown brain "${id}": use ${MACHINE_BRAINS.join(" or ")}.`);
    if (!b) continue;
    const brain = id as MachineBrainId;
    const auth = b.auth === "key" ? "key" : b.auth === "subscription" || b.auth === undefined ? "subscription" : undefined;
    if (!auth) throw new SetupError(`${brain}: auth is "subscription" or "key".`);
    if (auth === "key" && !apiKeys) {
      throw new SetupError(`${brain}: key mode is off on this hub (it starts without PIOMIO_API_KEYS=1); the machine's ${brain} works on its own sign-in, auth "subscription".`);
    }
    const wire = brainWire(brain);
    const providers: string[] | undefined = auth === "key" ? [...new Set<string>((b.providers ?? []).map(String))] : undefined;
    for (const p of providers ?? []) {
      const kp = keyProvider(p);
      if (!kp) throw new SetupError(`${brain}: unknown provider "${p}". Known: ${KEY_PROVIDERS.map((k) => `${k.id} (${k.wire === "openai" ? "Codex" : "Claude Code"})`).join(", ")}.`);
      if (kp.wire !== wire) throw new SetupError(`${brain} cannot use ${kp.label}: ${brain === "codex" ? "Codex takes OpenAI" : "Claude Code takes Anthropic-compatible providers"}.`);
    }
    if (auth === "key" && !providers?.length) throw new SetupError(`${brain}: key mode needs at least one provider.`);
    const models: MachineModel[] = [];
    for (const m of (b.models ?? []) as any[]) {
      const id = String(m?.id ?? m ?? "").trim();
      if (!SAFE_MODEL.test(id)) throw new SetupError(`${brain}: "${id}" is not a model id.`);
      const provider: string | undefined = m?.provider ? String(m.provider) : providers?.[0];
      if (auth === "key" && !providers!.includes(provider!)) throw new SetupError(`${brain}: model ${id} names provider ${provider}, which is not among its providers.`);
      const price = m?.price ? { input: Number(m.price.input), output: Number(m.price.output) } : undefined;
      if (price && (!(price.input >= 0) || !(price.output >= 0))) throw new SetupError(`${brain}: model ${id} has a bad price.`);
      if (auth === "key" && !price) throw new SetupError(`${brain}: model ${id} needs a price (dollars per million input and output tokens) so the limit can be kept. Look it up on the provider's pricing page or ask the person.`);
      if (!models.some((x) => x.id === id)) models.push({ id, ...(auth === "key" ? { provider } : {}), ...(price ? { price } : {}) });
    }
    if (auth === "key" && !models.length) throw new SetupError(`${brain}: key mode needs at least one allowed model.`);
    out.brains[brain] = { auth, ...(providers ? { providers } : {}), ...(models.length ? { models } : {}) };
  }
  if (raw.limit !== undefined && raw.limit !== null) {
    const usd = Number(raw.limit.usd);
    const period = raw.limit.period === "day" ? "day" : raw.limit.period === "month" || raw.limit.period === undefined ? "month" : undefined;
    if (!(usd > 0) || !period) throw new SetupError(`limit is { usd: <dollars above 0>, period: "day" | "month" }.`);
    out.limit = { usd, period };
  }
  return out;
}

/** Settings as they apply: without API keys (Config.apiKeys) a brain set to key mode runs on its own sign-in, any model. */
export function effectiveSettings(s: MachineSettings, apiKeys: boolean): MachineSettings {
  if (apiKeys) return s;
  const brains: MachineSettings["brains"] = {};
  for (const [id, b] of Object.entries(s.brains) as Array<[MachineBrainId, NonNullable<MachineSettings["brains"][MachineBrainId]>]>) {
    brains[id] = b.auth === "key" ? { auth: "subscription" } : b;
  }
  return { ...s, brains };
}

/** The current period of a limit: its first day and when the next one starts (UTC days). */
export function periodOf(period: "day" | "month", now = new Date()): { since: string; resetsAt: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const start = period === "day" ? new Date(Date.UTC(y, m, d)) : new Date(Date.UTC(y, m, 1));
  const next = period === "day" ? new Date(Date.UTC(y, m, d + 1)) : new Date(Date.UTC(y, m + 1, 1));
  return { since: start.toISOString().slice(0, 10), resetsAt: next.toISOString() };
}

export class MachineSetups {
  private db: Db;
  private bus: EventBus;
  private audit: AuditLog;
  private vault: () => VaultService;
  private apiKeys: () => boolean;
  private now: () => Date;

  constructor(d: { db: Db; bus: EventBus; audit: AuditLog; vault: () => VaultService; apiKeys: () => boolean; now?: () => Date }) {
    this.db = d.db;
    this.bus = d.bus;
    this.audit = d.audit;
    this.vault = d.vault;
    this.apiKeys = d.apiKeys;
    this.now = d.now ?? (() => new Date());
  }

  get(machineId: string): MachineSettings {
    const r = this.db.prepare("select data from machine_settings where machine_id = ?").get(machineId) as { data: string } | undefined;
    return json<MachineSettings>(r?.data, { brains: {} });
  }

  set(machineId: string, input: unknown, actor = "user"): MachineSettings {
    const s = normalizeSettings(input, this.apiKeys());
    this.db
      .prepare("insert into machine_settings(machine_id, data, updated_at) values (?,?,?) on conflict(machine_id) do update set data = excluded.data, updated_at = excluded.updated_at")
      .run(machineId, JSON.stringify(s), nowIso());
    this.audit.append(actor, "machine.setup", machineId, { brains: Object.fromEntries(Object.entries(s.brains).map(([k, b]) => [k, b!.auth])), limit: s.limit ?? null });
    this.checkLimit(machineId);
    this.bus.emit("machine.setup", { machineId });
    return s;
  }

  /** Dollars the machine's key-mode brains spent in the limit's current period (a month without a limit). */
  spent(machineId: string, period: "day" | "month" = this.get(machineId).limit?.period ?? "month"): number {
    const { since } = periodOf(period, this.now());
    const r = this.db.prepare("select coalesce(sum(usd), 0) as usd from machine_spend where machine_id = ? and day >= ?").get(machineId, since) as { usd: number };
    return Math.round(r.usd * 1e6) / 1e6;
  }

  view(machineId: string): MachineSetupView {
    const settings = effectiveSettings(this.get(machineId), this.apiKeys());
    const period = settings.limit?.period ?? "month";
    const vault = this.vault();
    const keys = this.apiKeys() && (vault.state() === "unlocked" || vault.state() === "sealed") ? KEY_PROVIDERS.filter((p) => !!vault.getMeta(p.vaultId)).map((p) => p.id) : [];
    return { machineId, settings, spent: { usd: this.spent(machineId, period), period, since: periodOf(period, this.now()).since }, keys };
  }

  /** A call the machine's gateway made. Returns whether the limit is now reached. */
  record(machineId: string, u: MachineUsage): boolean {
    const day = String(u.at ?? nowIso()).slice(0, 10);
    this.db
      .prepare(
        `insert into machine_spend(day, machine_id, brain_id, provider, model, input_tokens, output_tokens, usd) values (?,?,?,?,?,?,?,?)
         on conflict(day, machine_id, brain_id, provider, model) do update set input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens, usd = usd + excluded.usd`,
      )
      .run(day, machineId, String(u.brainId), String(u.provider), String(u.model), Math.max(0, Math.round(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)), Math.max(0, Math.round(u.outputTokens)), Math.max(0, Number(u.usd) || 0));
    return this.checkLimit(machineId);
  }

  /** Over the limit: the machine's key-mode brains rest until the period ends (brain_limits); under it again: they work. */
  checkLimit(machineId: string): boolean {
    const s = effectiveSettings(this.get(machineId), this.apiKeys());
    const keyBrains = MACHINE_BRAINS.filter((b) => s.brains[b]?.auth === "key").map((b) => `${b}@${machineId}`);
    const all = MACHINE_BRAINS.map((b) => `${b}@${machineId}`);
    const over = !!s.limit && this.spent(machineId, s.limit.period) >= s.limit.usd;
    const del = this.db.prepare("delete from brain_limits where brain_ref = ? and detail like 'spend:%'");
    for (const ref of all) if (!over || !keyBrains.includes(ref)) del.run(ref);
    if (over && s.limit) {
      const { resetsAt } = periodOf(s.limit.period, this.now());
      const up = this.db.prepare(
        "insert into brain_limits(brain_ref, until, detail) values (?,?,?) on conflict(brain_ref) do update set until = excluded.until, detail = excluded.detail",
      );
      for (const ref of keyBrains) up.run(ref, resetsAt, `spend: $${s.limit.usd} ${s.limit.period} limit reached`);
    }
    return over;
  }

  /** What the machine's daemon gets: its brains, allowed models and, unlocked, the keys of its providers. */
  nodeSetup(machineId: string): NodeSetup {
    const s = effectiveSettings(this.get(machineId), this.apiKeys());
    const vault = this.vault();
    const sealed = vault.state() !== "unlocked";
    const setup: NodeSetup = { brains: {}, ...(sealed ? { sealed: true } : {}) };
    for (const b of MACHINE_BRAINS) {
      const bs = s.brains[b];
      if (!bs) continue;
      const providers: Array<{ id: string; key: string }> = [];
      if (bs.auth === "key" && !sealed) {
        for (const p of bs.providers ?? []) {
          const kp = keyProvider(p);
          if (!kp || !vault.getMeta(kp.vaultId)) continue;
          try {
            const key = vault.access(`vault://${kp.vaultId}`, { actor: `machine:${machineId}` }).value;
            if (key) providers.push({ id: p, key: key.trim() });
          } catch {
            /* scoped away from machines: the brain says it has no key */
          }
        }
      }
      setup.brains[b] = { auth: bs.auth, models: bs.models ?? [], ...(bs.auth === "key" ? { providers } : {}) };
    }
    if (s.limit) setup.limit = { ...s.limit, spent: this.spent(machineId, s.limit.period), resetsAt: periodOf(s.limit.period, this.now()).resetsAt };
    return setup;
  }
}
