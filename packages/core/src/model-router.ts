// Which brain, model and effort take a request, chosen under the hood (docs/superpowers/specs/2026-10-29-front-desk-design.md).
// Every request comes with what it needs: a quick word, the front desk's answer, everyday work or hard thinking, and
// what it is about (code, reasoning, writing). Every brain publishes what its models are like (ProbeResult.catalog,
// shared/models.ts). The router scores each brain's models for the request and orders the brains, each with its best
// model and the effort that fits; the runner then takes the first one that can work now (signed in, not over a limit,
// not busy). It knows profiles, not providers: a new provider counts as soon as its brain publishes a catalog.

import type { ModelProfile, ModelSkill, ProbeResult, WorkKind } from "@piomio/shared";
import { catalogOf, fitEffort, isKnownModel, markLegacy, parseBrainRef } from "@piomio/shared";

/**
 * How much a request asks of the model:
 * - light: a word in passing (thanks, yes) or a simple errand: the cheapest quick model;
 * - quick: the dialog's front desk: a strong model that answers at once (low effort);
 * - standard: everyday work;
 * - deep: hard problems: the most capable model, thinking long.
 * No need reaches a premium model (Claude's Fable): it runs only where the person chose it by name.
 */
export type Need = "light" | "quick" | "standard" | "deep";

/** The capability each need aims at (ModelProfile.tier). */
const TARGET: Record<Need, number> = { light: 2, quick: 4, standard: 4, deep: 5 };
/** The effort each need asks for; a brain takes the nearest it has (fitEffort). */
const EFFORT: Record<Need, string> = { light: "low", quick: "low", standard: "medium", deep: "xhigh" };

export interface RouteAsk {
  need: Need;
  /** What the work is mostly about: a model good at it scores higher. */
  skill?: ModelSkill;
  /** The work runs commands or changes files with the brain's own tools: brains without them (API) are left out. */
  hands?: boolean;
}

export interface RouteBrain {
  ref: string;
  probe?: Pick<ProbeResult, "models" | "modelNames" | "efforts" | "catalog" | "model" | "presets">;
}

export interface Route {
  ref: string;
  /** The model to use on that brain; unset: the brain's default (it publishes no models). */
  model?: string;
  effort?: string;
  score: number;
}

/** Brains that think through an API: no shell or files of their own. */
const isApi = (ref: string) => parseBrainRef(ref).brainId === "api";

/** How well one model fits the request. */
export function scoreModel(p: Pick<ModelProfile, "tier" | "speed" | "cost" | "good">, ask: RouteAsk): number {
  const target = TARGET[ask.need];
  let s: number;
  if (ask.need === "deep") s = p.tier * 4 - p.cost * 0.5;
  else {
    // Too weak is worse than too strong; past the target only cost and speed count.
    s = -Math.abs(p.tier - target) * 3 - (p.tier < target ? 3 : 0);
    if (ask.need === "light") s += p.speed * 2 - p.cost * 3;
    if (ask.need === "quick") s += p.speed * 3 - p.cost;
    if (ask.need === "standard") s += p.speed - p.cost;
  }
  // `good` is in order of strength: what a model is best at counts most.
  const at = ask.skill ? (p.good ?? []).indexOf(ask.skill) : -1;
  if (at === 0) s += 4;
  else if (at > 0) s += 2;
  return s;
}

/** What a model a brain names for a preset is like, when nothing else describes it. */
const ROLE: Record<string, { tier: number; speed: number; cost: number }> = {
  fast: { tier: 2, speed: 3, cost: 1 },
  balanced: { tier: 4, speed: 2, cost: 2 },
  deep: { tier: 5, speed: 1, cost: 2 },
};

/**
 * A brain's models as profiles: its catalog, else its model list with the known families' profiles. A model nobody
 * describes but that the brain names for its presets takes the presets' word for it, when they name more than one
 * model: its strongest role's capability, its quickest role's speed.
 */
export function modelsOf(b: RouteBrain): ModelProfile[] {
  const p = b.probe;
  if (!p) return [];
  const roles = new Map<string, Array<(typeof ROLE)[string]>>();
  for (const [preset, mean] of Object.entries(p.presets ?? {})) if (mean?.model && ROLE[preset]) roles.set(mean.model, [...(roles.get(mean.model) ?? []), ROLE[preset]]);
  // Presets that name one model for every role (only the effort differs) say nothing about it: that model would
  // look the strongest, quickest and cheapest at once.
  if (roles.size < 2) roles.clear();
  const own = p.catalog ?? [];
  const lineup = catalogOf([...(p.models ?? []), ...roles.keys()], p.modelNames ?? {}, own).map((m) => {
    const r = roles.get(m.id);
    if (!r || own.some((o) => o.id === m.id) || isKnownModel(m.id, m.name)) return m;
    return { ...m, tier: Math.max(...r.map((x) => x.tier)), speed: Math.max(...r.map((x) => x.speed)), cost: Math.min(...r.map((x) => x.cost)) };
  });
  // Older generations next to newer ones (GPT-5.6 beside GPT-6) are marked, also where the brain's list says nothing.
  return markLegacy(lineup);
}

/**
 * The brains in the order they should take the request, each with its best model and effort. Brains that cannot do
 * the work (no hands when it needs them) are left out; a brain with no models listed takes its default model and
 * counts as a middling one. Ties keep the order given (the agent's).
 */
export function route(brains: RouteBrain[], ask: RouteAsk): Route[] {
  const out: Array<Route & { at: number }> = [];
  brains.forEach((b, at) => {
    if (ask.hands && isApi(b.ref)) return;
    const local = parseBrainRef(b.ref).machineId === "local" ? 0.5 : 0;
    const models = modelsOf(b);
    // A brain that lists no efforts takes none.
    const effort = b.probe?.efforts ? fitEffort(EFFORT[ask.need], b.probe.efforts) : undefined;
    if (!models.length) {
      out.push({ ref: b.ref, ...(effort ? { effort } : {}), score: scoreModel({ tier: 3, speed: 2, cost: 2 }, ask) + local, at });
      return;
    }
    // An older generation only when the brain has nothing current; a premium model (ModelProfile.premium) only when
    // it has nothing else: the person names that one themselves (an exact model never comes here).
    const current = models.filter((m) => !m.legacy);
    const usual = (current.length ? current : models).filter((m) => !m.premium);
    const pool = usual.length ? usual : current.length ? current : models;
    const best = pool.map((m) => ({ m, s: scoreModel(m, ask) })).sort((a, z) => z.s - a.s)[0];
    out.push({ ref: b.ref, model: best.m.id, ...(effort ? { effort } : {}), score: best.s + local, at });
  });
  return out.sort((a, z) => z.score - a.score || a.at - z.at).map(({ at: _, ...r }) => r);
}

const TRIVIAL =
  /^(спасибо|спс|благодарю|ок|окей|ok|okay|да|нет|ага|угу|хорошо|понял|поняла|понятно|отлично|супер|класс|круто|ясно|привет|пока|доброе утро|спокойной ночи|thanks|thank you|thx|ty|yes|no|yep|nope|sure|great|cool|nice|good|got it|hi|hello|hey|bye|good night|good morning)[\s!.,)]*$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;

/** What a dialog message needs: a word in passing is light, everything else the front desk's quick answer. */
export function needOfMessage(text: string): Need {
  const t = text.trim();
  return TRIVIAL.test(t) || (t.length > 0 && t.length <= 8 && EMOJI_ONLY.test(t)) ? "light" : "quick";
}

const CODE = /\b(code|coding|script|function|bug|refactor|test|compile|build|repo|commit|typescript|python|javascript|rust|golang|sql|regex|api|deploy)\b|код|скрипт|функци|баг|рефактор|тест|компил|сборк|репозитор|коммит|программ/i;
const DEEP = /\b(analy[sz]e|research|investigate|compare|design|architecture|strategy|plan|prove|think hard|in depth)\b|анализ|исслед|сравни|продумай|спроектир|архитектур|стратег|подумай|глубок|разбер/i;

/** What a task's goal is about, when whoever started it did not say: code, or reasoning when it asks for thought. */
export function skillOfGoal(goal: string): ModelSkill | undefined {
  if (CODE.test(goal)) return "code";
  if (DEEP.test(goal)) return "reasoning";
  return undefined;
}

/** A preset as a need; "auto" depends on the kind of work (and, in a dialog, on the message). */
export function needOf(preset: string | undefined, kind: WorkKind, text: string): Need {
  if (preset === "fast") return "light";
  if (preset === "balanced") return "standard";
  if (preset === "deep") return "deep";
  // "auto" (or none): the dialog answers at once; a channel's routine run is light; other work everyday.
  if (kind === "chat") return needOfMessage(text);
  if (kind === "feed") return "light";
  return "standard";
}
