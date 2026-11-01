// How an agent thinks in its chats: the brain, a plain preset (fast, balanced, deep: each brain maps it to one of its
// models and an effort) and, for those who want it, the exact model and effort. One menu in two places: the chat
// header's picker (all of it) and a card in the chat (the /brain and /effort commands: only that part).
// Choosing a brain moves it to the front of the agent's fallback order; the others stay as fallbacks. Other kinds of
// work (tasks, channels, schedules) are set up in the chat: the header's last item asks the agent, which shows its card.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Brain, Check, ChevronRight, ListChecks, Plus, Scale, Sparkles, Wand2, Zap } from "lucide-react";
import type { AgentDef, ThinkingPreset } from "@piomio/shared";
import { errorText } from "../../lib/api";
import { useStore } from "../../lib/store";
import { activeBrain, brainReady, brains, brainStatus, ensureBrains, findBrain, normalizeBrainRef, type BrainRow } from "../../state/brains";
import { describeThinking, effortName, ensureThinking, modelName, setThinking, thinking } from "../../state/thinking";
import { askInChat } from "../../state/ask";
import { openPanel } from "../../state/panel";
import { toast } from "../../state/toast";
import { agents, ensureAgents } from "../../state/app";
import { Badge, cx, Spinner } from "../../components/ui";
import { t } from "../../i18n";

export const PRESETS: ThinkingPreset[] = ["auto", "fast", "balanced", "deep"];
export const PRESET_ICONS = { auto: Wand2, fast: Zap, balanced: Scale, deep: Sparkles } as const;

/** What the agent's chats think with now, and the changes the menu makes. */
export function useThinkingMenu(agent: AgentDef) {
  const list = useStore(brains);
  const views = useStore(thinking);
  const [busy, setBusy] = useState<string>();
  useEffect(() => ensureBrains(), []);
  useEffect(() => ensureThinking(agent.id), [agent.id]);
  const view = views[agent.id];
  const chat = view?.kinds.find((k) => k.kind === "chat");
  // A bound agent (AgentDef.machines) thinks only with its computers' brains: none of those, none at all.
  const bound = !!agent.machines?.length;
  const active = list ? ((chat?.brain ? findBrain(list, chat.brain) : undefined) ?? (bound ? undefined : activeBrain(agent.brains, list))) : undefined;
  const ready = !!active && brainReady(active);
  const option = view?.brains.find((b) => active && normalizeBrainRef(b.ref) === normalizeBrainRef(active.ref));
  const own = chat?.own;
  const isExact = !!(own?.model || own?.effort);
  const how = chat ? describeThinking(view, chat.brain, chat.model, chat.effort) : undefined;
  // In a word: the preset (or the exact model).
  const short = chat?.preset ? t(`thinking.preset.${chat.preset}`) : isExact ? (modelName(view, chat?.brain, own?.model) ?? (own?.effort ? effortName(own.effort) : undefined)) : undefined;
  const rows = (list ?? [])
    .filter((b) => !bound || view?.brains.some((o) => normalizeBrainRef(o.ref) === normalizeBrainRef(b.ref)))
    .sort((a, b) => Number(brainReady(b)) - Number(brainReady(a)));
  const none = t(bound ? "brainPicker.machinesOff" : "brainPicker.none");

  const run = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    try {
      await fn();
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const choosePreset = (p: ThinkingPreset) => run(`preset:${p}`, () => setThinking(agent.id, "chat", { preset: p }));
  // From a preset to an exact choice, the other half stays what it was.
  const chooseModel = (model: string) => run(`model:${model}`, () => setThinking(agent.id, "chat", { model, ...(own?.effort || !chat?.effort ? {} : { effort: chat.effort }), ...(option ? { brain: option.ref } : {}) }));
  const chooseEffort = (effort: string) => run(`effort:${effort}`, () => setThinking(agent.id, "chat", { effort, ...(own?.model || !chat?.model ? {} : { model: chat.model }), ...(option ? { brain: option.ref } : {}) }));
  const chooseBrain = async (b: BrainRow): Promise<boolean> => {
    if (active && normalizeBrainRef(active.ref) === normalizeBrainRef(b.ref)) return true;
    const ok = await run(`brain:${b.ref}`, () => setThinking(agent.id, "chat", { brain: b.ref }));
    if (ok) toast(t("brainPicker.switched", { agent: agent.name, brain: b.label }), "success");
    return ok;
  };
  return { list, view, chat, active, ready, option, own, isExact, how, short, rows, none, busy, choosePreset, chooseModel, chooseEffort, chooseBrain };
}

type Menu = ReturnType<typeof useThinkingMenu>;

const chip = (selected: boolean) =>
  cx(
    "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition disabled:opacity-50",
    selected ? "border-accent bg-accent text-accent-fg" : "border-border text-muted hover:border-fg/30 hover:text-fg",
  );

/** The four presets, each with what it comes to on the brain in use. */
function Presets({ m }: { m: Menu }) {
  return (
    <>
      {PRESETS.map((p) => {
        const Icon = PRESET_ICONS[p];
        const means = m.option?.presets[p];
        const sub = means ? describeThinking(m.view, m.option?.ref, means.model, means.effort) : undefined;
        const current = m.chat?.preset === p && !m.isExact;
        return (
          <button
            key={p}
            type="button"
            role="menuitemradio"
            aria-checked={current}
            disabled={!!m.busy}
            onClick={() => void m.choosePreset(p)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition enabled:hover:bg-surface-2 disabled:opacity-70"
          >
            <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-lg", current ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted")}>
              {m.busy === `preset:${p}` ? <Spinner size={14} /> : <Icon className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t(`thinking.preset.${p}`)}</span>
              <span className="block truncate text-[11px] text-muted">{sub ?? t(`thinking.presetHint.${p}`)}</span>
            </span>
            {current && <Check className="size-4 shrink-0 text-accent-text" />}
          </button>
        );
      })}
    </>
  );
}

/** The brain's own models or efforts as chips, "Default" first. */
function Exact({ m, what }: { m: Menu; what: "model" | "effort" }) {
  const o = m.option;
  if (!o) return null;
  const items = what === "model" ? o.models.map((x) => ({ id: x.id, name: x.name })) : o.efforts.map((e) => ({ id: e, name: effortName(e) }));
  if (!items.length) return null;
  const now = what === "model" ? m.chat?.model : m.chat?.effort;
  const pick = what === "model" ? m.chooseModel : m.chooseEffort;
  return (
    <div>
      <div className="mb-1 text-[11px] text-muted">{t(what === "model" ? "thinking.model" : "thinking.effort")}</div>
      <div className="flex flex-wrap gap-1">
        <button type="button" disabled={!!m.busy} className={chip(!now)} onClick={() => void pick("")}>
          {t("thinking.default")}
        </button>
        {items.map((x) => (
          <button key={x.id} type="button" disabled={!!m.busy} className={chip(now === x.id)} onClick={() => void pick(x.id)}>
            {m.busy === `${what}:${x.id}` && <Spinner size={12} />}
            {x.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The brains, ready ones first: a tap switches; one that does not answer says why. `compact` (the chat card): the ones
 * that do not answer wait behind one line.
 */
function Brains({ m, onChosen, compact }: { m: Menu; onChosen?: () => void; compact?: boolean }) {
  const [more, setMore] = useState(false);
  const isActive = (b: BrainRow) => !!m.active && normalizeBrainRef(m.active.ref) === normalizeBrainRef(b.ref);
  const hidden = compact && !more ? m.rows.filter((b) => !brainReady(b) && !isActive(b)) : [];
  return (
    <>
      {m.rows.filter((b) => !hidden.includes(b)).map((b) => {
        const ok = brainReady(b);
        const current = isActive(b);
        const st = brainStatus(b);
        return (
          <button
            key={b.ref}
            type="button"
            role="menuitemradio"
            aria-checked={current}
            disabled={!ok || !!m.busy}
            onClick={() => void m.chooseBrain(b).then((done) => done && onChosen?.())}
            title={!ok ? (b.probe?.detail ?? st.label) : undefined}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition enabled:hover:bg-surface-2 disabled:opacity-55"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {m.busy === `brain:${b.ref}` ? <Spinner size={14} /> : current ? <Check className="size-4 text-accent-text" /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{b.label}</span>
            {!ok && <Badge tone={st.tone}>{st.label}</Badge>}
          </button>
        );
      })}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setMore(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <ChevronRight className="size-4 shrink-0" />
          {t("thinking.moreBrains", { n: hidden.length })}
        </button>
      )}
      <div className="px-2 pt-0.5 pb-1 text-[11px] leading-snug text-muted">{t("brainPicker.hint")}</div>
    </>
  );
}

function ConnectBrain({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick?.();
        openPanel("brains");
      }}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-accent-text hover:bg-surface-2"
    >
      <Plus className="size-4" /> {t("brainPicker.connect")}
    </button>
  );
}

/** The header picker's menu: presets, the exact model and effort behind a toggle, the brains, other kinds of work. */
export function ThinkingMenu({ agent, onClose }: { agent: AgentDef; onClose: () => void }) {
  const m = useThinkingMenu(agent);
  const [, navigate] = useLocation();
  const [exact, setExact] = useState(false);
  const o = m.option;
  return (
    <>
      <div className="px-2 pt-1 pb-1.5 text-xs text-muted">{t("thinking.heading", { agent: agent.name })}</div>
      <Presets m={m} />
      {o && (o.models.length > 0 || o.efforts.length > 0) && (
        <>
          <button
            type="button"
            aria-expanded={exact}
            onClick={() => setExact((v) => !v)}
            className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <ChevronRight className={cx("size-4 shrink-0 transition-transform", exact && "rotate-90")} />
            <span className="flex-1">{t("thinking.exact")}</span>
            {m.isExact && <span className="truncate text-[11px] text-fg">{m.how}</span>}
          </button>
          {exact && (
            <div className="space-y-2 px-2 pt-0.5 pb-2">
              <Exact m={m} what="model" />
              <Exact m={m} what="effort" />
            </div>
          )}
        </>
      )}
      <div className="mt-1 border-t border-border px-2 pt-2 pb-1 text-xs text-muted">{t("thinking.brains")}</div>
      <Brains m={m} onChosen={onClose} />
      <div className="mt-1 border-t border-border pt-1">
        <button
          type="button"
          onClick={() => {
            onClose();
            void askInChat(agent.id, t("thinking.askKinds"), navigate).catch((e) => toast(errorText(e), "error"));
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-fg hover:bg-surface-2"
        >
          <ListChecks className="size-4 text-muted" /> {t("thinking.kinds")}
        </button>
        <ConnectBrain onClick={onClose} />
      </div>
    </>
  );
}

/**
 * The menu as a card in the chat (a `thinking` part with `focus`, from /brain or /effort): the brains and the models
 * of the one in use, or the presets and the brain's efforts.
 */
export function ThinkingMenuCard({ agentId, focus }: { agentId: string; focus: "brain" | "effort" }) {
  const team = useStore(agents);
  useEffect(() => ensureAgents(), []);
  const agent = team?.find((a) => a.id === agentId);
  if (!team) return <div className="my-2 h-40 max-w-md animate-pulse rounded-2xl bg-surface-2" />;
  if (!agent) return <div className="my-2 max-w-md rounded-2xl border border-dashed border-border px-3 py-2.5 text-sm text-muted">{t("thinking.gone")}</div>;
  return <MenuCard agent={agent} focus={focus} />;
}

function MenuCard({ agent, focus }: { agent: AgentDef; focus: "brain" | "effort" }) {
  const m = useThinkingMenu(agent);
  if (!m.list || !m.view) return <div className="my-2 h-40 max-w-md animate-pulse rounded-2xl bg-surface-2" />;
  const Icon = focus === "effort" && m.chat?.preset && !m.isExact ? PRESET_ICONS[m.chat.preset] : Brain;
  // Nothing chosen: the brain's own default depth.
  const now = focus === "brain" ? (m.active?.label ?? m.none) : !m.active ? m.none : m.isExact && m.how ? m.how : [m.short ?? t("thinking.default"), m.how].filter(Boolean).join(" · ");
  return (
    <div className="my-2 max-w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-card sm:max-w-md">
      <div className="flex items-start gap-3 p-3 pb-2">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{t(focus === "brain" ? "thinking.card.brainTitle" : "thinking.card.effortTitle", { agent: agent.name })}</span>
          <span className="block truncate text-[13px] text-muted" title={now}>
            {now}
          </span>
        </span>
      </div>
      <div role="menu" className="border-t border-border p-1.5">
        {focus === "brain" ? (
          <>
            <Brains m={m} compact />
            {m.option && m.option.models.length > 0 && (
              <div className="border-t border-border px-2 pt-2 pb-1">
                <Exact m={m} what="model" />
              </div>
            )}
            <ConnectBrain />
          </>
        ) : (
          <>
            <Presets m={m} />
            {m.option && m.option.efforts.length > 0 && (
              <div className="mt-1 border-t border-border px-2 pt-2 pb-1">
                <Exact m={m} what="effort" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
