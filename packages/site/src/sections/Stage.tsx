// The first screen: a short headline over the live app in the middle of the screen, and the day's chapters under it
// to pick from; what Piomio is and how to get it come after. A chapter that ends hands over to the next one, like a showreel. On a phone the window lets touches
// through to the page (it scrolls freely) and a tap opens the day full screen as stories.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Play } from "../components/icons";
import { DownloadButton } from "../components/Download";
import { DemoWindow } from "../demo/DemoWindow";
import { Story } from "../demo/Story";
import { CHAPTERS, type ChapterId } from "../demo/protocol";

const WIDE = "(min-width: 1024px)";
/** After a chapter ends, the next one starts this much later. */
const NEXT_MS = 2400;

/** Wide or not, once the page runs (null while prerendered: no live window starts before the layout is known). */
function useWide(): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const m = window.matchMedia(WIDE);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

function Picker({ active, onPick }: { active: ChapterId; onPick: (id: ChapterId) => void }) {
  const { t } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  // Keep the chosen chapter in sight where the row scrolls (phones).
  useEffect(() => {
    const r = row.current;
    const el = r?.querySelector<HTMLElement>(`[data-chip="${active}"]`);
    if (el && r && r.scrollWidth > r.clientWidth) r.scrollTo({ left: el.offsetLeft - r.clientWidth / 2 + el.clientWidth / 2, behavior: "smooth" });
  }, [active]);
  return (
    <div
      ref={row}
      role="tablist"
      aria-label={t("demo.chapters")}
      className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0"
    >
      {CHAPTERS.map((id) => {
        const on = id === active;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            data-chip={id}
            aria-selected={on}
            onClick={() => onPick(id)}
            className={`flex shrink-0 items-baseline gap-2 rounded-full px-4 py-2 text-[14px] font-semibold whitespace-nowrap transition-all duration-300 ${
              on ? "bg-fg text-bg shadow-[var(--shadow)]" : "bg-surface text-fg-2 shadow-[0_0_0_1px_var(--border)] hover:text-fg"
            }`}
          >
            <span className={`font-display text-[11.5px] tracking-wide ${on ? "text-[var(--accent)]" : "text-accent-text"}`}>{t(`chapter.${id}.time`)}</span>
            {t(`chapter.${id}.chip`)}
          </button>
        );
      })}
    </div>
  );
}

export function Stage() {
  const { t } = useI18n();
  const wide = useWide();
  const [chapter, setChapter] = useState<ChapterId>(CHAPTERS[0]);
  const [story, setStory] = useState<ChapterId | null>(null);
  const [ended, setEnded] = useState<{ id: ChapterId; at: number } | null>(null);

  // The showreel: when a chapter ends, the next one plays, unless the visitor picked another meanwhile.
  useEffect(() => {
    if (!ended) return;
    const n = CHAPTERS.indexOf(ended.id);
    if (n >= CHAPTERS.length - 1) return;
    const timer = setTimeout(() => setChapter((c) => (c === ended.id ? CHAPTERS[n + 1] : c)), NEXT_MS);
    return () => clearTimeout(timer);
  }, [ended]);

  return (
    <section id="demo" className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-[28%] -z-10 mx-auto h-[60%] max-w-[1100px] rounded-full bg-[radial-gradient(closest-side,var(--candy-glow),transparent)] opacity-60 blur-3xl" />
      <div className="mx-auto max-w-[1320px] px-4 pt-8 pb-20 sm:px-6 sm:pt-9 lg:px-10 lg:pb-28">
        <header className="mx-auto flex max-w-[72rem] flex-col items-center text-center">
          <h1 className="font-display text-[clamp(1.7rem,3.2vw,2.75rem)] leading-[1.06] font-extrabold tracking-[-0.025em] text-balance">
            {t("hero.titleLead")} <span className="marker whitespace-nowrap">{t("hero.titleMarker")}</span>
          </h1>
        </header>

        <div className="relative mx-auto mt-6 max-w-[1140px] sm:mt-8">
          <DemoWindow
            chapter={chapter}
            idle={wide === null || !!story}
            passive={wide === false}
            className="h-[min(66svh,560px)] min-h-[420px] lg:h-[clamp(480px,calc(100svh_-_285px),720px)]"
            onEnded={() => setEnded({ id: chapter, at: Date.now() })}
          />
          {wide === false && <button type="button" onClick={() => setStory(chapter)} aria-label={t("demo.tapToWatch")} className="absolute inset-x-0 top-10 bottom-0 rounded-b-[18px]" />}
        </div>

        <div className="mx-auto mt-6 max-w-[1140px]">
          <Picker active={chapter} onPick={setChapter} />
          <div className="mx-auto mt-6 flex max-w-[44rem] flex-col items-center text-center" aria-live="polite">
            <h2 className="font-display text-[clamp(1.25rem,2.2vw,1.7rem)] leading-tight font-bold tracking-[-0.01em] text-balance">{t(`chapter.${chapter}.title`)}</h2>
            <p className="mt-2.5 text-[16px] leading-relaxed text-fg-2 text-pretty">{t(`chapter.${chapter}.text`)}</p>
            <button type="button" onClick={() => setStory(chapter)} className="mt-5 inline-flex items-center gap-2 rounded-full bg-fg px-5 py-3 text-[15px] font-semibold text-bg shadow-[var(--shadow)] lg:hidden">
              <Play size={15} />
              {t("demo.fullScreen")}
            </button>
          </div>
        </div>

        <div className="mx-auto mt-16 flex max-w-[40rem] flex-col items-center border-t border-hairline pt-14 text-center sm:mt-20">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12.5px] font-semibold text-fg-2 shadow-[0_0_0_1px_var(--border)]">
            <span className="live-dot size-1.5 rounded-full" />
            {t("hero.eyebrow")}
          </p>
          <p className="text-[clamp(1.05rem,1.4vw,1.2rem)] leading-relaxed text-fg-2 text-pretty">{t("hero.lead")}</p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <DownloadButton />
            <a href="#install" className="ghost inline-flex items-center gap-2 rounded-full px-5 py-3.5 text-[15px] font-semibold">
              {t("hero.secondary")}
            </a>
          </div>
          <p className="mt-4 text-[13px] text-muted">{t("hero.fineprint")}</p>
        </div>
      </div>
      {story && (
        <Story
          start={story}
          onClose={() => {
            setStory(null);
          }}
        />
      )}
    </section>
  );
}
