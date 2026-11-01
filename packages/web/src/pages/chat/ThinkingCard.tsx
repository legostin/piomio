// How an agent thinks for each kind of work, as a live card in its chat (a `thinking` part, from thinking_show or
// thinking_set): a preset per kind, or "as in the chat" for the kinds that follow the dialog's choice.

import { useEffect, useState } from "react";
import { Brain, CalendarClock, ListChecks, MessageCircle, Newspaper } from "lucide-react";
import type { ThinkingPatch, ThinkingPreset, WorkKind } from "@piomio/shared";
import { errorText } from "../../lib/api";
import { useStore } from "../../lib/store";
import { agents, ensureAgents } from "../../state/app";
import { describeThinking, ensureThinking, setThinking, thinking } from "../../state/thinking";
import { toast } from "../../state/toast";
import { cx, Spinner } from "../../components/ui";
import { t } from "../../i18n";
import { PRESETS } from "./ThinkingMenu";

const KIND_ICONS = { chat: MessageCircle, task: ListChecks, feed: Newspaper, schedule: CalendarClock } as const;

export function ThinkingCard({ agentId }: { agentId: string }) {
  const views = useStore(thinking);
  const team = useStore(agents);
  const [busy, setBusy] = useState<string>();
  useEffect(() => ensureAgents(), []);
  useEffect(() => ensureThinking(agentId), [agentId]);
  const view = views[agentId];
  const agent = team?.find((a) => a.id === agentId);
  if (!view || !team) return <div className="my-2 h-48 max-w-md animate-pulse rounded-2xl bg-surface-2" />;
  if (!agent) return <div className="my-2 max-w-md rounded-2xl border border-dashed border-border px-3 py-2.5 text-sm text-muted">{t("thinking.gone")}</div>;

  const change = async (kind: WorkKind, key: string, patch: ThinkingPatch) => {
    setBusy(`${kind}:${key}`);
    try {
      await setThinking(agentId, kind, patch);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };
  const brainLabel = (ref?: string) => view.brains.find((b) => b.ref === ref)?.label;
  const chip = (selected: boolean) =>
    cx(
      "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition disabled:opacity-60",
      selected ? "border-accent bg-accent text-accent-fg" : "border-border text-muted hover:border-fg/30 hover:text-fg",
    );

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-card sm:max-w-md">
      <div className="flex items-start gap-3 p-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Brain className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{t("thinking.card.title", { agent: agent.name })}</span>
          <span className="line-clamp-2 text-[13px] text-muted">{t("thinking.card.hint")}</span>
        </span>
      </div>
      {view.kinds.map((k) => {
        const Icon = KIND_ICONS[k.kind];
        const follows = k.kind !== "chat" && !k.own;
        const exact = !!(k.own?.model || k.own?.effort);
        const how = [brainLabel(k.brain), describeThinking(view, k.brain, k.model, k.effort)].filter(Boolean).join(" · ") || t("thinking.noBrain");
        const pick = (p: ThinkingPreset) => k.own?.preset === p && !exact;
        return (
          <div key={k.kind} className="border-t border-border px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted" />
              <span className="text-sm font-medium">{t(`thinking.kind.${k.kind}`)}</span>
            </div>
            <div className="mt-0.5 truncate pl-6 text-xs text-muted" title={how}>
              {how}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {k.kind !== "chat" && (
                <button type="button" disabled={!!busy} className={chip(follows)} onClick={() => void change(k.kind, "follow", { follow: true })}>
                  {busy === `${k.kind}:follow` && <Spinner size={12} />}
                  {t("thinking.follow")}
                </button>
              )}
              {PRESETS.map((p) => (
                <button key={p} type="button" disabled={!!busy} className={chip(k.kind === "chat" ? k.choice.preset === p && !exact : pick(p))} onClick={() => void change(k.kind, p, { preset: p })}>
                  {busy === `${k.kind}:${p}` && <Spinner size={12} />}
                  {t(`thinking.preset.${p}`)}
                </button>
              ))}
              {exact && <span className={chip(true)}>{t("thinking.exactChoice")}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
