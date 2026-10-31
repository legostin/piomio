// How an agent thinks in its dialog, right in the header: one control for the brain, a plain preset (fast, balanced,
// deep: each brain maps it to one of its models and an effort), and, for those who want it, the exact model and effort.
// Choosing a brain moves it to the front of the agent's fallback order; the others stay as fallbacks. Other kinds of
// work (tasks, channels, schedules) are set up in the chat: the last item asks the agent, which shows its card.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Brain, Check, ChevronDown, ChevronRight, ListChecks, Plus, Scale, Sparkles, Wand2, Zap } from "lucide-react";
import type { AgentDef, ThinkingPreset } from "@piomio/shared";
import { errorText } from "../../lib/api";
import { useStore } from "../../lib/store";
import { activeBrain, brainReady, brains, brainStatus, ensureBrains, findBrain, normalizeBrainRef, type BrainRow } from "../../state/brains";
import { describeThinking, effortName, ensureThinking, modelName, setThinking, thinking } from "../../state/thinking";
import { askInChat } from "../../state/ask";
import { openPanel } from "../../state/panel";
import { toast } from "../../state/toast";
import { Badge, cx, Spinner } from "../../components/ui";
import { t } from "../../i18n";

export const PRESETS: ThinkingPreset[] = ["auto", "fast", "balanced", "deep"];
export const PRESET_ICONS = { auto: Wand2, fast: Zap, balanced: Scale, deep: Sparkles } as const;

export function BrainPicker({ agent }: { agent: AgentDef }) {
  const list = useStore(brains);
  const views = useStore(thinking);
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [exact, setExact] = useState(false);
  const [busy, setBusy] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => ensureBrains(), []);
  useEffect(() => ensureThinking(agent.id), [agent.id]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!list) return null;
  const view = views[agent.id];
  const chat = view?.kinds.find((k) => k.kind === "chat");
  // A bound agent (AgentDef.machines) thinks only with its computers' brains: none of those, none at all.
  const bound = !!agent.machines?.length;
  const active = (chat?.brain ? findBrain(list, chat.brain) : undefined) ?? (bound ? undefined : activeBrain(agent.brains, list));
  const ready = !!active && brainReady(active);
  const option = view?.brains.find((b) => active && normalizeBrainRef(b.ref) === normalizeBrainRef(active.ref));
  const own = chat?.own;
  const isExact = !!(own?.model || own?.effort);
  const how = chat ? describeThinking(view, chat.brain, chat.model, chat.effort) : undefined;
  // In the button: the brain and the preset (or the exact model) in a word.
  const short = chat?.preset ? t(`thinking.preset.${chat.preset}`) : isExact ? (modelName(view, chat?.brain, own?.model) ?? (own?.effort ? effortName(own.effort) : undefined)) : undefined;
  const rows = list
    .filter((b) => !bound || view?.brains.some((o) => normalizeBrainRef(o.ref) === normalizeBrainRef(b.ref)))
    .sort((a, b) => Number(brainReady(b)) - Number(brainReady(a)));
  const none = t(bound ? "brainPicker.machinesOff" : "brainPicker.none");
  const TriggerIcon = ready && chat?.preset && !isExact ? PRESET_ICONS[chat.preset] : Brain;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };
  const choosePreset = (p: ThinkingPreset) => run(`preset:${p}`, () => setThinking(agent.id, "chat", { preset: p }));
  // From a preset to an exact choice, the other half stays what it was.
  const chooseModel = (model: string) => run(`model:${model}`, () => setThinking(agent.id, "chat", { model, ...(own?.effort || !chat?.effort ? {} : { effort: chat.effort }), ...(option ? { brain: option.ref } : {}) }));
  const chooseEffort = (effort: string) => run(`effort:${effort}`, () => setThinking(agent.id, "chat", { effort, ...(own?.model || !chat?.model ? {} : { model: chat.model }), ...(option ? { brain: option.ref } : {}) }));
  const chooseBrain = (b: BrainRow) => {
    if (active && normalizeBrainRef(active.ref) === normalizeBrainRef(b.ref)) return setOpen(false);
    return run(`brain:${b.ref}`, async () => {
      await setThinking(agent.id, "chat", { brain: b.ref });
      toast(t("brainPicker.switched", { agent: agent.name, brain: b.label }), "success");
      setOpen(false);
    });
  };
  const chip = (selected: boolean) =>
    cx(
      "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition disabled:opacity-50",
      selected ? "border-accent bg-accent text-accent-fg" : "border-border text-muted hover:border-fg/30 hover:text-fg",
    );

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("thinking.label", { agent: agent.name })}: ${active ? [active.label, chat?.preset ? t(`thinking.preset.${chat.preset}`) : undefined, how].filter(Boolean).join(" · ") : none}`}
        className={cx(
          "press flex max-w-[12rem] items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition",
          ready ? "text-muted hover:bg-surface-2 hover:text-fg" : "border border-warning/40 bg-warning-soft/60 text-warning",
        )}
      >
        <TriggerIcon className="size-3.5 shrink-0" />
        {/* Quiet: the preset in a word (the brain only when none answers); a narrow bar keeps the icon. */}
        <span className="hidden truncate @lg/top:inline">{ready ? (short ?? active?.label) : (active?.label ?? none)}</span>
        <ChevronDown className={cx("size-3 shrink-0 opacity-60 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="animate-in absolute top-full left-0 z-30 mt-1.5 max-h-[min(80vh,40rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-card">
          <div className="px-2 pt-1 pb-1.5 text-xs text-muted">{t("thinking.heading", { agent: agent.name })}</div>
          {PRESETS.map((p) => {
            const Icon = PRESET_ICONS[p];
            const means = option?.presets[p];
            const sub = means ? describeThinking(view, option?.ref, means.model, means.effort) : undefined;
            const current = chat?.preset === p && !isExact;
            return (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                disabled={!!busy}
                onClick={() => void choosePreset(p)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition enabled:hover:bg-surface-2 disabled:opacity-70"
              >
                <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-lg", current ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted")}>
                  {busy === `preset:${p}` ? <Spinner size={14} /> : <Icon className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t(`thinking.preset.${p}`)}</span>
                  <span className="block truncate text-[11px] text-muted">{sub ?? t(`thinking.presetHint.${p}`)}</span>
                </span>
                {current && <Check className="size-4 shrink-0 text-accent-text" />}
              </button>
            );
          })}
          {option && (option.models.length > 0 || option.efforts.length > 0) && (
            <>
              <button
                type="button"
                aria-expanded={exact}
                onClick={() => setExact((v) => !v)}
                className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted transition hover:bg-surface-2 hover:text-fg"
              >
                <ChevronRight className={cx("size-4 shrink-0 transition-transform", exact && "rotate-90")} />
                <span className="flex-1">{t("thinking.exact")}</span>
                {isExact && <span className="truncate text-[11px] text-fg">{how}</span>}
              </button>
              {exact && (
                <div className="space-y-2 px-2 pt-0.5 pb-2">
                  {option.models.length > 0 && (
                    <div>
                      <div className="mb-1 text-[11px] text-muted">{t("thinking.model")}</div>
                      <div className="flex flex-wrap gap-1">
                        <button type="button" disabled={!!busy} className={chip(!chat?.model)} onClick={() => void chooseModel("")}>
                          {t("thinking.default")}
                        </button>
                        {option.models.map((m) => (
                          <button key={m.id} type="button" disabled={!!busy} className={chip(chat?.model === m.id)} onClick={() => void chooseModel(m.id)}>
                            {busy === `model:${m.id}` && <Spinner size={12} />}
                            {m.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {option.efforts.length > 0 && (
                    <div>
                      <div className="mb-1 text-[11px] text-muted">{t("thinking.effort")}</div>
                      <div className="flex flex-wrap gap-1">
                        <button type="button" disabled={!!busy} className={chip(!chat?.effort)} onClick={() => void chooseEffort("")}>
                          {t("thinking.default")}
                        </button>
                        {option.efforts.map((e) => (
                          <button key={e} type="button" disabled={!!busy} className={chip(chat?.effort === e)} onClick={() => void chooseEffort(e)}>
                            {busy === `effort:${e}` && <Spinner size={12} />}
                            {effortName(e)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <div className="mt-1 border-t border-border px-2 pt-2 pb-1 text-xs text-muted">{t("thinking.brains")}</div>
          {rows.map((b) => {
            const ok = brainReady(b);
            const current = !!active && normalizeBrainRef(active.ref) === normalizeBrainRef(b.ref);
            const st = brainStatus(b);
            return (
              <button
                key={b.ref}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                disabled={!ok || !!busy}
                onClick={() => void chooseBrain(b)}
                title={!ok ? (b.probe?.detail ?? st.label) : undefined}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition enabled:hover:bg-surface-2 disabled:opacity-55"
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {busy === `brain:${b.ref}` ? <Spinner size={14} /> : current ? <Check className="size-4 text-accent-text" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{b.label}</span>
                {!ok && <Badge tone={st.tone}>{st.label}</Badge>}
              </button>
            );
          })}
          <div className="px-2 pt-0.5 pb-1 text-[11px] leading-snug text-muted">{t("brainPicker.hint")}</div>
          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void askInChat(agent.id, t("thinking.askKinds"), navigate).catch((e) => toast(errorText(e), "error"));
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-fg hover:bg-surface-2"
            >
              <ListChecks className="size-4 text-muted" /> {t("thinking.kinds")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openPanel("brains");
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-accent-text hover:bg-surface-2"
            >
              <Plus className="size-4" /> {t("brainPicker.connect")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
