// What the team can do: one block per feature, words on one side and the real app on the other (a looping clip
// recorded from the demo above) or a diagram, alternating sides as the page goes down.

import { useI18n, type MessageKey } from "../i18n";
import { Check } from "../components/icons";
import { Clip } from "../components/Clip";
import { BrainsDiagram, TeachFlow } from "../components/Diagrams";
import type { ChapterId } from "../demo/protocol";

type FeatureId = "team" | "morning" | "mail" | "approvals" | "teach" | "security" | "services" | "pages" | "channels" | "machines";

const BLOCKS: Array<{ id: FeatureId; clip?: ChapterId; diagram?: "brains"; featured?: boolean }> = [
  { id: "team", clip: "team" },
  { id: "mail", clip: "mail" },
  { id: "approvals", clip: "send" },
  { id: "teach", clip: "browser", featured: true },
  { id: "morning", clip: "morning" },
  { id: "security", clip: "security" },
  { id: "services", clip: "services" },
  { id: "pages", clip: "pages" },
  { id: "channels", clip: "channels" },
  { id: "machines", diagram: "brains" },
];

function Block({ id, clip, diagram, featured, flip }: (typeof BLOCKS)[number] & { flip: boolean }) {
  const { t } = useI18n();
  const k = (s: string) => `feature.${id}.${s}` as MessageKey;
  const text = (
    <div className="reveal flex flex-col justify-center">
      <p className="text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">{t(k("eyebrow"))}</p>
      <h3 className="mt-3 font-display text-[clamp(1.6rem,2.8vw,2.3rem)] leading-[1.08] font-extrabold tracking-[-0.02em] text-balance">{t(k("title"))}</h3>
      <p className="mt-4 text-[17px] leading-relaxed text-fg-2 text-pretty">{t(k("text"))}</p>
      {!featured && (
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
      {featured && <TeachFlow />}
    </div>
  );
  const media = <div className="reveal">{clip ? <Clip chapter={clip} label={t(k("title"))} /> : diagram === "brains" ? <BrainsDiagram /> : null}</div>;
  return (
    <article
      id={`feature-${id}`}
      className={`grid items-center gap-8 lg:grid-cols-12 lg:gap-14 ${featured ? "rounded-[32px] bg-canvas p-5 shadow-[var(--shadow)] sm:p-8 lg:p-12" : ""}`}
    >
      {flip ? (
        <>
          <div className="lg:order-2 lg:col-span-5">{text}</div>
          <div className="lg:order-1 lg:col-span-7">{media}</div>
        </>
      ) : (
        <>
          <div className="lg:col-span-5">{text}</div>
          <div className="lg:col-span-7">{media}</div>
        </>
      )}
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
      </div>
    </section>
  );
}
