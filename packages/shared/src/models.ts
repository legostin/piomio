// What a model is like, for choosing one per request (core/src/model-router.ts): how capable, how quick, how costly
// and what it is good at. A brain publishes the profiles of the models it offers (ProbeResult.catalog); for model
// families it does not describe, the table below fills in. A new provider plugs in by publishing its catalog: the
// router reads profiles, never provider names.

/** What a model is especially good at (ModelProfile.good lists them strongest first). */
export type ModelSkill = "code" | "reasoning" | "writing" | "vision";
export const MODEL_SKILLS: readonly ModelSkill[] = ["code", "reasoning", "writing", "vision"];

export interface ModelProfile {
  /** The id the brain takes (an alias such as "sonnet" for Claude Code). */
  id: string;
  /** For people. */
  name?: string;
  /** How capable: 1 (a small local model) … 5 (the best there is). */
  tier: number;
  /** How quick to answer: 1 (slow, thinks long) … 3 (fast). */
  speed: number;
  /** How costly: 1 (cheap or free) … 3 (expensive). */
  cost: number;
  /** Strongest first. */
  good?: ModelSkill[];
  /** An older generation the provider has moved on from: chosen only when the brain has nothing current. */
  legacy?: boolean;
}

type Traits = Omit<ModelProfile, "id" | "name" | "legacy">;

/** What a provider's own model list says about a model (Codex's model/list, an API's /models). */
export interface ModelMeta {
  id: string;
  name?: string;
  /** The provider's words for it ("Frontier intelligence…", "Older fast and efficient model."). */
  description?: string;
  /** The provider marks it old: deprecated, or pointing to its successor. */
  deprecated?: boolean;
  /** USD per million tokens, input and output, when the provider says. */
  price?: { input: number; output: number };
  /** It takes images, when the provider says. */
  images?: boolean;
}

/**
 * Known model families by id, first match wins (more specific patterns first). Reasonable as of late 2026; a brain's
 * own catalog and the plugin's settings come before it.
 */
export const KNOWN_MODELS: ReadonlyArray<readonly [RegExp, Traits]> = [
  // Anthropic
  [/fable/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "writing", "code", "vision"] }],
  [/opus/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "writing", "code", "vision"] }],
  [/sonnet/i, { tier: 4, speed: 2, cost: 2, good: ["writing", "code", "vision"] }],
  [/haiku/i, { tier: 2, speed: 3, cost: 1, good: ["vision"] }],
  // OpenAI. GPT-6 Astra is the flagship; each generation's line goes by size: Sol the workhorse, Terra, then Luna, the
  // small quick one (GPT-6.1 Sol and Terra, GPT-6 Luna in late 2026).
  [/gpt-?6[\w.]*-?(mini|nano|luna)/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/gpt-?[\d.]*-?luna/i, { tier: 2, speed: 3, cost: 1 }],
  [/gpt-?[\d.]*-?terra/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/gpt-?[\d.]*-?sol\b/i, { tier: 4, speed: 2, cost: 2, good: ["code", "reasoning", "writing"] }],
  [/gpt-?6/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "code", "writing", "vision"] }],
  [/codex[-_.]?(mini|spark)/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/codex/i, { tier: 4, speed: 2, cost: 2, good: ["code", "reasoning"] }],
  [/gpt-?5[\w.]*-?nano/i, { tier: 2, speed: 3, cost: 1 }],
  [/gpt-?5[\w.]*-?mini/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/gpt-?5[\w.]*-?pro/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "code", "writing"] }],
  [/gpt-?5/i, { tier: 5, speed: 2, cost: 2, good: ["reasoning", "code", "writing", "vision"] }],
  [/gpt-?4\.1-?(mini|nano)|gpt-?4o-?mini/i, { tier: 2, speed: 3, cost: 1, good: ["vision"] }],
  [/gpt-?4/i, { tier: 3, speed: 2, cost: 2, good: ["writing", "vision"] }],
  [/^o\d(-mini)?/i, { tier: 4, speed: 1, cost: 2, good: ["reasoning", "code"] }],
  [/gpt-?oss-?20b/i, { tier: 2, speed: 3, cost: 1 }],
  [/gpt-?oss/i, { tier: 3, speed: 3, cost: 1, good: ["reasoning"] }],
  // Google
  [/gemini[\w.-]*flash[-_]?lite/i, { tier: 2, speed: 3, cost: 1, good: ["vision"] }],
  [/gemini[\w.-]*flash/i, { tier: 3, speed: 3, cost: 1, good: ["vision", "code"] }],
  [/gemini[\w.-]*pro/i, { tier: 5, speed: 2, cost: 2, good: ["reasoning", "code", "vision", "writing"] }],
  [/gemma/i, { tier: 2, speed: 3, cost: 1 }],
  // Moonshot (Kimi). Kimi Code's plan names its models kimi-code/k3, k3-256k, k3.1-pro(-highspeed), kimi-for-coding
  // and kimi-for-coding-highspeed; the highspeed K3 costs twice the plan's quota.
  [/kimi-for-coding-highspeed/i, { tier: 4, speed: 3, cost: 1, good: ["code"] }],
  [/(^|\/)k3[\w.-]*highspeed/i, { tier: 5, speed: 3, cost: 2, good: ["code", "reasoning", "writing"] }],
  [/(^|\/)k3([.-][\w.-]*)?$/i, { tier: 5, speed: 2, cost: 1, good: ["code", "reasoning", "writing"] }],
  [/kimi[\w.-]*(thinking|k2\.5|k3)/i, { tier: 4, speed: 1, cost: 1, good: ["reasoning", "code"] }],
  [/kimi|moonshot/i, { tier: 4, speed: 2, cost: 1, good: ["code", "writing"] }],
  // DeepSeek
  [/deepseek[\w.-]*(reasoner|r1|r2)/i, { tier: 4, speed: 1, cost: 1, good: ["reasoning", "code"] }],
  [/deepseek[\w.-]*coder/i, { tier: 3, speed: 2, cost: 1, good: ["code"] }],
  [/deepseek/i, { tier: 4, speed: 2, cost: 1, good: ["code", "writing"] }],
  // Zhipu (GLM)
  [/glm[\w.-]*(flash|air)/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/glm/i, { tier: 4, speed: 2, cost: 1, good: ["code", "reasoning"] }],
  // Alibaba (Qwen)
  [/qwen[\w.-]*coder/i, { tier: 4, speed: 2, cost: 1, good: ["code"] }],
  [/qwen[\w.-]*(max|235b|480b)/i, { tier: 4, speed: 2, cost: 2, good: ["reasoning", "writing"] }],
  [/qwen[\w.-]*(turbo|flash|[0-9]b\b|1[0-4]b\b)/i, { tier: 2, speed: 3, cost: 1 }],
  [/qwen/i, { tier: 3, speed: 2, cost: 1, good: ["writing"] }],
  // xAI (Grok)
  [/grok[\w.-]*code/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/grok[\w.-]*(fast|mini)/i, { tier: 3, speed: 3, cost: 1, good: ["reasoning"] }],
  [/grok/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "writing"] }],
  // Mistral
  [/codestral|devstral/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/mistral[\w.-]*(large|medium)|magistral/i, { tier: 4, speed: 2, cost: 2, good: ["writing", "reasoning"] }],
  [/mistral|ministral|mixtral/i, { tier: 2, speed: 3, cost: 1 }],
  // Meta and other open models (often local)
  [/llama[\w.-]*(405b|maverick)/i, { tier: 3, speed: 2, cost: 1 }],
  [/llama/i, { tier: 2, speed: 3, cost: 1 }],
  [/phi|smollm|tinyllama/i, { tier: 1, speed: 3, cost: 1 }],
  // Aggregators choosing for themselves
  [/openrouter\/auto/i, { tier: 4, speed: 2, cost: 2 }],
];

const UNKNOWN: Traits = { tier: 3, speed: 2, cost: 2 };

/** Whether the table knows the model's family. */
export function isKnownModel(id: string, name?: string): boolean {
  return KNOWN_MODELS.some(([re]) => re.test(id) || (!!name && re.test(name)));
}

/** A model's profile by its id (and name): from the table, or a middling one for a model nobody describes. */
export function profileOf(id: string, name?: string): ModelProfile {
  const hit = KNOWN_MODELS.find(([re]) => re.test(id) || (!!name && re.test(name)));
  const traits = hit ? hit[1] : UNKNOWN;
  return { id, ...(name ? { name } : {}), tier: traits.tier, speed: traits.speed, cost: traits.cost, ...(traits.good ? { good: [...traits.good] } : {}) };
}

const OLD = /\b(older|legacy|previous[- ]generation|deprecated|outdated|superseded|retired)\b/i;
const TOP = /\b(frontier|flagship|most (capable|intelligent|powerful|advanced|demanding)|smartest|state[- ]of[- ]the[- ]art)\b/i;
const LIGHT = /\b(fast|efficient|affordable|lightweight|low[- ]latency|cheap|small|mini|budget)\b/i;
const MIDDLE = /\b(workhorse|balanced|everyday|general[- ]purpose|straightforward)\b/i;

/**
 * A model's profile from what its provider says now, over the table: the description's words for how capable and
 * quick it is, its price for cost, and whether it is an older generation. The table fills in what they leave out.
 */
export function profileFrom(m: ModelMeta): ModelProfile {
  const p = profileOf(m.id, m.name);
  const d = m.description ?? "";
  if (TOP.test(d)) Object.assign(p, { tier: 5, speed: Math.min(p.speed, 2), cost: Math.max(p.cost, 2) });
  else if (LIGHT.test(d)) Object.assign(p, { tier: Math.min(p.tier, /\bcod(e|ing)|agentic\b/i.test(d) ? 3 : 2), speed: 3, cost: 1 });
  else if (MIDDLE.test(d)) Object.assign(p, { tier: Math.min(Math.max(p.tier, 3), 4), speed: Math.max(p.speed, 2) });
  if (/\bcod(e|ing)\b/i.test(d) && !p.good?.includes("code")) p.good = ["code", ...(p.good ?? [])];
  if (m.images && !p.good?.includes("vision")) p.good = [...(p.good ?? []), "vision"];
  if (m.price) {
    const blended = (m.price.input + 3 * m.price.output) / 4;
    p.cost = blended < 1 ? 1 : blended < 8 ? 2 : 3;
  }
  if (m.deprecated || OLD.test(d)) p.legacy = true;
  return p;
}

/** "gpt-5.6-luna" → { vendor: "gpt", family: "gpt-luna", version: 5.6 }; dates (2411, 20250514) are not versions. */
export function modelVersion(id: string): { vendor: string; family: string; version?: number } {
  const lower = id.toLowerCase().replace(/^.*\//, "");
  const vendor = /^[a-z]+/.exec(lower)?.[0] ?? lower;
  const v = /(?<![\d.])(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/.exec(lower);
  const version = v ? Number(`${v[1]}.${v[2] ?? 0}`) : undefined;
  const family = lower
    .replace(v?.[0] ?? "\u0000", "")
    .replace(/\d{4,}/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return { vendor, family, version };
}

/**
 * A lineup with its older generations marked: a model whose maker has a newer major version in the same list
 * (GPT-5.6 next to GPT-6), or whose own line has a newer version (Haiku 4.5 next to Haiku 5.5).
 */
export function markLegacy(models: ModelProfile[]): ModelProfile[] {
  const v = models.map((m) => ({ m, ...modelVersion(m.id) }));
  const newestMajor = new Map<string, number>();
  const newestInFamily = new Map<string, number>();
  for (const x of v) {
    if (x.version === undefined) continue;
    newestMajor.set(x.vendor, Math.max(newestMajor.get(x.vendor) ?? 0, Math.floor(x.version)));
    newestInFamily.set(x.family, Math.max(newestInFamily.get(x.family) ?? 0, x.version));
  }
  return v.map(({ m, vendor, family, version }) => {
    if (version === undefined || m.legacy) return m;
    const older = Math.floor(version) < (newestMajor.get(vendor) ?? 0) || version < (newestInFamily.get(family) ?? 0);
    return older ? { ...m, legacy: true } : m;
  });
}

/** A brain's catalog: its own profiles where it gave them, the table's for the rest of its models. */
export function catalogOf(models: readonly string[], names: Record<string, string> = {}, own: readonly ModelProfile[] = []): ModelProfile[] {
  const ids = [...new Set([...own.map((p) => p.id), ...models])];
  return ids.map((id) => own.find((p) => p.id === id) ?? profileOf(id, names[id]));
}

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** A model's name for people: "claude-sonnet-5-5" → "Sonnet 5.5", "opus" → "Opus"; other ids as they are. */
export function modelLabel(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/i.exec(id);
  if (claude) return `${capital(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  if (/^(fable|opus|sonnet|haiku)$/i.test(id)) return capital(id.toLowerCase());
  return id;
}
