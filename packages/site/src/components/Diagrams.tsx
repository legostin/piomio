// Small diagrams for the feature blocks, drawn in the page's own look (words from the locales, so they translate).

import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { Brain, Home, Laptop, Globe } from "./icons";

function Node({ title, sub, icon, tone = "plain", badge }: { title: string; sub: string; icon?: ReactNode; tone?: "plain" | "live" | "muted"; badge?: string }) {
  const tones = {
    plain: "bg-surface shadow-[0_0_0_1px_var(--border)]",
    live: "bg-accent-soft shadow-[0_0_0_1.5px_var(--accent)]",
    muted: "bg-surface-2 text-fg-2 shadow-[0_0_0_1px_var(--border)]",
  };
  return (
    <div className={`relative flex items-center gap-3 rounded-2xl px-4 py-3 ${tones[tone]}`}>
      {icon && <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-bg text-accent-text">{icon}</span>}
      <div className="min-w-0">
        <p className="font-display text-[15px] leading-tight font-bold">{title}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-fg-2">{sub}</p>
      </div>
      {badge && <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-semibold text-accent-text">{badge}</span>}
    </div>
  );
}

const Down = () => <div className="mx-auto h-5 w-0.5 bg-[repeating-linear-gradient(var(--accent)_0_5px,transparent_5px_9px)]" aria-hidden="true" />;

/** Brains in order (a subscription at its limit hands over to the next) and the machines agents work on. */
export function BrainsDiagram() {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 rounded-[22px] bg-canvas p-4 shadow-[var(--shadow)] sm:p-6 md:grid-cols-2">
      <div className="flex flex-col">
        <p className="mb-3 text-[12.5px] font-bold tracking-[0.12em] text-accent-text uppercase">{t("diagram.brains.title")}</p>
        <Node icon={<Brain size={18} />} title="Claude Code" sub={t("diagram.brains.subscription")} tone="muted" badge={t("diagram.brains.limit")} />
        <Down />
        <Node icon={<Brain size={18} />} title="Codex" sub={t("diagram.brains.subscription")} tone="live" />
        <Down />
        <Node icon={<Brain size={18} />} title={t("diagram.brains.api")} sub={t("diagram.brains.backup")} />
        <p className="mt-3 text-[13px] leading-snug text-muted">{t("diagram.brains.back")}</p>
      </div>
      <div className="flex flex-col">
        <p className="mb-3 text-[12.5px] font-bold tracking-[0.12em] text-accent-text uppercase">{t("diagram.machines.title")}</p>
        <Node icon={<Home size={18} />} title={t("diagram.machines.hub")} sub={t("diagram.machines.hubSub")} tone="live" />
        <Down />
        <div className="grid gap-3">
          <Node icon={<Laptop size={18} />} title={t("diagram.machines.laptop")} sub={t("diagram.machines.laptopSub")} />
          <Node icon={<Globe size={18} />} title={t("diagram.machines.server")} sub={t("diagram.machines.serverSub")} />
        </div>
      </div>
    </div>
  );
}

/** Teach mode in four steps. */
export function TeachFlow() {
  const { t } = useI18n();
  const steps = ["feature.teach.flow1", "feature.teach.flow2", "feature.teach.flow3", "feature.teach.flow4"] as const;
  return (
    <ol className="mt-6 grid grid-cols-2 gap-2">
      {steps.map((key, i) => (
        <li key={key} className="relative flex items-center gap-2.5 rounded-2xl bg-surface px-3.5 py-3 text-[14px] font-semibold shadow-[0_0_0_1px_var(--border)]">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-bold text-[var(--accent-fg)]">{i + 1}</span>
          <span className="leading-tight">{t(key)}</span>
        </li>
      ))}
    </ol>
  );
}
