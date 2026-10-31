// Small diagrams for the feature blocks, drawn in the page's own look (words from the locales, so they translate). They
// show how a thing works, not the app's screens: the screens are in the demo at the top.

import type { ReactNode } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { Bell, Brain, Check, Globe, Home, Laptop, Mail, Pointer } from "./icons";

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

const Frame = ({ children }: { children: ReactNode }) => <div className="rounded-[22px] bg-canvas p-4 shadow-[var(--shadow)] sm:p-6">{children}</div>;

const Label = ({ children }: { children: ReactNode }) => <p className="text-[12px] font-bold tracking-[0.12em] text-muted uppercase">{children}</p>;

/** A teammate's face: the first letter on a soft tile. */
const Face = ({ name }: { name: string }) => (
  <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-accent-soft font-display text-[14px] font-bold text-accent-text">{name.slice(0, 1)}</span>
);

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

/** What teach mode leaves behind: a skill with your steps, your words, the clicks it may make alone and when it runs. */
export function SkillDiagram() {
  const { t } = useI18n();
  return (
    <Frame>
      <div className="rounded-2xl bg-surface p-5 shadow-[0_0_0_1px_var(--border)] sm:p-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
            <Pointer size={18} />
          </span>
          <div className="min-w-0">
            <p className="font-display text-[17px] leading-tight font-bold">{t("diagram.skill.title")}</p>
            <p className="mt-0.5 text-[13px] text-fg-2">{t("diagram.skill.learned")}</p>
          </div>
          <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-semibold text-accent-text">{t("diagram.skill.badge")}</span>
        </div>
        <div className="mt-5">
          <Label>{t("diagram.skill.steps")}</Label>
          <ol className="mt-2.5 flex flex-col gap-2">
            {([1, 2, 3, 4] as const).map((n) => (
              <li key={n} className="flex items-baseline gap-3 text-[15px] leading-snug">
                <span className="w-4 shrink-0 font-display text-[13px] font-bold text-accent-text tabular-nums">{n}</span>
                {t(`diagram.skill.step${n}`)}
              </li>
            ))}
          </ol>
          <p className="mt-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13.5px] leading-snug text-fg-2 italic">{t("diagram.skill.said")}</p>
        </div>
        <div className="mt-5">
          <Label>{t("diagram.skill.alone")}</Label>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {(["diagram.skill.click1", "diagram.skill.click2"] as const).map((key) => (
              <span key={key} className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-[13.5px] font-semibold text-accent-text">
                <Check size={13} />
                {t(key)}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-5 flex items-center gap-2 border-t border-hairline pt-4 text-[14px] font-medium">
          <Bell size={16} className="text-accent-text" />
          {t("diagram.skill.runs")}
        </p>
      </div>
    </Frame>
  );
}

/** One phishing email on its way: it asks the agent to send invoices out, and the new address stops at your card. */
export function ApprovalDiagram() {
  const { t } = useI18n();
  return (
    <Frame>
      <div className="rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--border)]">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-fg-2">
            <Mail size={16} />
          </span>
          <p className="text-[14px] font-semibold">{t("diagram.approve.inbox")}</p>
          <span className="ml-auto rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] font-semibold text-fg-2">{t("diagram.approve.outside")}</span>
        </div>
        <p className="mt-3 text-[14.5px] leading-snug text-fg-2">{t("diagram.approve.inboxText")}</p>
      </div>
      <Down />
      <div className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 shadow-[0_0_0_1px_var(--border)]">
        <Face name={t("diagram.approve.agent")} />
        <p className="min-w-0 text-[14.5px] leading-snug">
          <b className="font-semibold">{t("diagram.approve.agent")}</b> {t("diagram.approve.agentText")}
        </p>
      </div>
      <Down />
      <div className="rounded-2xl bg-accent-soft p-4 shadow-[0_0_0_1.5px_var(--accent)]">
        <p className="font-display text-[15.5px] leading-tight font-bold">{t("diagram.approve.card")}</p>
        <p className="mt-1 text-[13.5px] text-fg-2">{t("diagram.approve.cardSub")}</p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          <span className="inline-flex items-center rounded-full bg-fg px-4 py-2 text-[13.5px] font-semibold text-bg">{t("diagram.approve.deny")}</span>
          <span className="inline-flex items-center rounded-full bg-surface px-4 py-2 text-[13.5px] font-semibold shadow-[0_0_0_1px_var(--border)]">{t("diagram.approve.allow")}</span>
        </div>
      </div>
      <div className="mt-5">
        <Label>{t("diagram.approve.rules")}</Label>
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {(["diagram.approve.rule1", "diagram.approve.rule2"] as const).map((key) => (
            <li key={key} className="flex items-center gap-2.5 text-[14px] text-fg-2">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text">
                <Check size={12} />
              </span>
              {t(key)}
            </li>
          ))}
        </ul>
      </div>
    </Frame>
  );
}

/** One message with three requests: Pio hands each to the right teammate, and the inbox goes on meanwhile. */
export function TeamDiagram() {
  const { t } = useI18n();
  const rows: Array<[MessageKey, MessageKey, MessageKey, boolean]> = [
    ["diagram.team.leo", "diagram.team.task1", "diagram.team.task1Status", true],
    ["diagram.team.leo", "diagram.team.task2", "diagram.team.task2Status", false],
    ["diagram.team.pioName", "diagram.team.task3", "diagram.team.task3Status", false],
  ];
  return (
    <Frame>
      <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-fg px-4 py-3 text-[14.5px] leading-snug text-bg">
        <p className="mb-1 text-[12px] font-semibold opacity-60">{t("diagram.team.you")}</p>
        {t("diagram.team.request")}
      </div>
      <p className="mt-4 text-center text-[13px] font-semibold text-accent-text">{t("diagram.team.pio")}</p>
      <Down />
      <ul className="flex flex-col gap-2">
        {rows.map(([who, task, status, live]) => (
          <li key={task} className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 shadow-[0_0_0_1px_var(--border)]">
            <Face name={t(who)} />
            <div className="min-w-0">
              <p className="text-[14.5px] leading-tight font-semibold">{t(task)}</p>
              <p className="mt-0.5 text-[12.5px] text-fg-2">{t(who)}</p>
            </div>
            <span className={`ml-auto flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold ${live ? "text-accent-text" : "text-fg-2"}`}>
              {live ? <span className="live-dot size-1.5 rounded-full" /> : <Check size={13} />}
              {t(status)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <Face name={t("diagram.team.ada")} />
        <p className="min-w-0 text-[14px] font-semibold">{t("diagram.team.task4")}</p>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-fg-2">
          <Check size={13} />
          {t("diagram.team.task4Status")}
        </span>
      </div>
    </Frame>
  );
}
