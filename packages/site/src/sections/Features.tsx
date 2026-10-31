// What sets Piomio apart: four blocks, words on one side and a diagram of how it works on the other, alternating sides
// as the page goes down; then the rest of the day as small tiles. The app's own screens stay in the demo at the top:
// every block names its chapters there, and a tap plays one in the live window.

import type { ReactNode } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { Check, Layout, Play, Plug, Rss, Sun } from "../components/icons";
import { ApprovalDiagram, BrainsDiagram, SkillDiagram, TeachFlow, TeamDiagram } from "../components/Diagrams";
import type { ChapterId } from "../demo/protocol";
import { watchInDemo } from "../demo/watch";

type FeatureId = "teach" | "approvals" | "machines" | "team";

const BLOCKS: Array<{ id: FeatureId; demo: ChapterId[]; diagram: () => ReactNode; featured?: boolean }> = [
  { id: "teach", demo: ["browser"], diagram: () => <SkillDiagram />, featured: true },
  { id: "approvals", demo: ["send", "security"], diagram: () => <ApprovalDiagram /> },
  { id: "machines", demo: ["machines"], diagram: () => <BrainsDiagram /> },
  { id: "team", demo: ["team", "mail"], diagram: () => <TeamDiagram /> },
];

const TILES: Array<{ id: "morning" | "services" | "pages" | "channels"; icon: ReactNode }> = [
  { id: "morning", icon: <Sun size={20} /> },
  { id: "services", icon: <Plug size={20} /> },
  { id: "pages", icon: <Layout size={20} /> },
  { id: "channels", icon: <Rss size={20} /> },
];

/** A chapter of the demo as a button: its time and name; a tap plays it in the window at the top. */
function DemoChip({ id }: { id: ChapterId }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => watchInDemo(id)}
      className="inline-flex items-center gap-2 rounded-full bg-surface px-3.5 py-2 text-[13.5px] font-semibold shadow-[0_0_0_1px_var(--border)] transition-colors hover:bg-surface-2"
    >
      <Play size={12} className="text-accent-text" />
      <span className="font-display text-[11.5px] tracking-wide text-accent-text">{t(`chapter.${id}.time`)}</span>
      {t(`chapter.${id}.chip`)}
    </button>
  );
}

function Block({ id, demo, diagram, featured, flip }: (typeof BLOCKS)[number] & { flip: boolean }) {
  const { t } = useI18n();
  const k = (s: string) => `feature.${id}.${s}` as MessageKey;
  const text = (
    <div className="reveal flex flex-col justify-center">
      <p className="text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">{t(k("eyebrow"))}</p>
      <h3 className="mt-3 font-display text-[clamp(1.6rem,2.8vw,2.3rem)] leading-[1.08] font-extrabold tracking-[-0.02em] text-balance">{t(k("title"))}</h3>
      <p className="mt-4 text-[17px] leading-relaxed text-fg-2 text-pretty">{t(k("text"))}</p>
      {featured ? (
        <TeachFlow />
      ) : (
        <ul className="mt-6 flex flex-col gap-2.5">
          {(["p1", "p2", "p3"] as const).map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-[15.5px] leading-snug">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text">
                <Check size={12} />
              </span>
              {t(k(p))}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-7 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[13px] font-semibold text-muted">{t("features.inDemo")}</span>
        {demo.map((c) => (
          <DemoChip key={c} id={c} />
        ))}
      </div>
    </div>
  );
  const media = <div className="reveal mx-auto w-full max-w-[680px]">{diagram()}</div>;
  return (
    <article
      id={`feature-${id}`}
      className={`grid items-center gap-8 lg:grid-cols-12 lg:gap-14 ${featured ? "rounded-[32px] bg-canvas p-5 shadow-[var(--shadow)] sm:p-8 lg:p-12" : ""}`}
    >
      <div className={`lg:col-span-5 ${flip ? "lg:order-2" : ""}`}>{text}</div>
      <div className={`lg:col-span-7 ${flip ? "lg:order-1" : ""}`}>{media}</div>
    </article>
  );
}

export function Features() {
  const { t } = useI18n();
  return (
    <section id="features" className="relative py-20 sm:py-28">
      <div className="mx-auto max-w-[1320px] px-4 sm:px-6 lg:px-10">
        <header className="reveal mx-auto max-w-[46rem] text-center">
          <p className="text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">{t("features.eyebrow")}</p>
          <h2 className="mt-3 font-display text-[clamp(1.9rem,3.8vw,3.1rem)] leading-[1.06] font-extrabold tracking-[-0.02em] text-balance">{t("features.title")}</h2>
          <p className="mx-auto mt-4 max-w-[36rem] text-[17px] leading-relaxed text-fg-2 text-pretty">{t("features.lead")}</p>
        </header>
        <div className="mt-16 flex flex-col gap-24 sm:mt-20 lg:gap-32">
          {BLOCKS.map((b, i) => (
            <Block key={b.id} {...b} flip={i % 2 === 1} />
          ))}
        </div>
        <div className="mt-24 lg:mt-32">
          <h3 className="reveal text-center font-display text-[clamp(1.35rem,2.2vw,1.75rem)] leading-tight font-bold tracking-[-0.01em]">{t("features.moreTitle")}</h3>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TILES.map(({ id, icon }) => (
              <article key={id} className="reveal flex flex-col rounded-[22px] bg-surface p-6 shadow-[var(--shadow)]">
                <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent-text">{icon}</span>
                <h4 className="mt-5 font-display text-[18px] leading-tight font-bold tracking-[-0.01em] text-balance">{t(`feature.${id}.title`)}</h4>
                <p className="mt-2.5 text-[15px] leading-relaxed text-fg-2">{t(`feature.${id}.text`)}</p>
                <div className="mt-auto pt-5">
                  <DemoChip id={id} />
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
