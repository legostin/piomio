// Below the story: how it works, security, integrations, the iPhone app, install, footer.

import { useState, type ReactNode } from "react";
import { siteConfig } from "../../site.config";
import { data } from "../data";
import { useI18n, type MessageKey } from "../i18n";
import { downloadHref } from "../components/Download";
import { Apple, Bell, Box, Brain, Chain, Check, Copy, Docker, FaceId, Filter, GitHub, Globe, Home, Laptop, Lock, Mic, OwlMark, ThumbUp, Windows } from "../components/icons";
import { LOGOS } from "../logos";

function Heading({ eyebrow, title, lead, center }: { eyebrow: string; title: string; lead?: string; center?: boolean }) {
  return (
    <header className={`reveal ${center ? "mx-auto text-center" : ""} max-w-[44rem]`}>
      <p className="text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">{eyebrow}</p>
      <h2 className="mt-3 font-display text-[clamp(1.9rem,3.8vw,3.1rem)] leading-[1.06] font-extrabold tracking-[-0.02em] text-balance">{title}</h2>
      {lead && <p className={`mt-4 text-[17px] leading-relaxed text-fg-2 text-pretty ${center ? "mx-auto max-w-[36rem]" : "max-w-[36rem]"}`}>{lead}</p>}
    </header>
  );
}

function Section({ id, children, tone }: { id: string; children: ReactNode; tone?: "canvas" }) {
  return (
    <section id={id} className={`relative py-20 sm:py-28 ${tone === "canvas" ? "grain bg-canvas" : ""}`}>
      <div className="relative mx-auto max-w-[1320px] px-4 sm:px-6 lg:px-10">{children}</div>
    </section>
  );
}

export function HowItWorks() {
  const { t } = useI18n();
  const cards: Array<[ReactNode, MessageKey, MessageKey, string[]]> = [
    [<Brain size={22} />, "how.brains.title", "how.brains.text", ["Claude Code", "Codex", "Anthropic API", "OpenAI", "OpenRouter", "Ollama"]],
    [<Laptop size={22} />, "how.hardware.title", "how.hardware.text", ["macOS", "Windows", "Docker", "Linux", "Tailscale"]],
    [<Home size={22} />, "how.home.title", "how.home.text", ["Apache-2.0", "Markdown", "SQLite", "Git"]],
  ];
  return (
    <Section id="how" tone="canvas">
      <Heading eyebrow={t("how.eyebrow")} title={t("how.title")} />
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {cards.map(([icon, title, text, tags]) => (
          <article key={title} className="reveal flex flex-col rounded-[22px] bg-surface p-6 shadow-[var(--shadow)] sm:p-7">
            <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent-text">{icon}</span>
            <h3 className="mt-5 font-display text-[20px] leading-tight font-bold tracking-[-0.01em]">{t(title)}</h3>
            <p className="mt-3 text-[15.5px] leading-relaxed text-fg-2">{t(text)}</p>
            <div className="mt-auto flex flex-wrap gap-1.5 pt-6">
              {tags.map((tag) => (
                <span key={tag} className="rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium text-fg-2">
                  {tag}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </Section>
  );
}

export function Security() {
  const { t } = useI18n();
  const layers: Array<[ReactNode, MessageKey, MessageKey]> = [
    [<Lock size={20} />, "security.vault.title", "security.vault.text"],
    [<ThumbUp size={20} />, "security.approvals.title", "security.approvals.text"],
    [<Box size={20} />, "security.sandbox.title", "security.sandbox.text"],
    [<Filter size={20} />, "security.egress.title", "security.egress.text"],
    [<Chain size={20} />, "security.audit.title", "security.audit.text"],
  ];
  return (
    <Section id="security">
      <Heading eyebrow={t("security.eyebrow")} title={t("security.title")} lead={t("security.lead")} />
      {/* The path of one action: from the agent, through the five layers, out into the world. */}
      <div className="reveal mt-12 overflow-hidden rounded-[26px] bg-surface p-4 shadow-[var(--shadow)] sm:p-6">
        <div className="flex flex-col items-stretch gap-3 xl:flex-row xl:items-center">
          <div className="flex items-center gap-3 rounded-2xl bg-fg px-4 py-3 text-bg xl:w-[130px] xl:shrink-0 xl:flex-col xl:py-6">
            <OwlMark size={34} />
            <span className="font-display text-[15px] font-bold">{t("security.diagram.agent")}</span>
          </div>
          <div className="relative grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="pointer-events-none absolute inset-x-0 top-1/2 hidden h-0.5 -translate-y-1/2 bg-[repeating-linear-gradient(90deg,var(--accent)_0_8px,transparent_8px_14px)] opacity-60 xl:block" />
            {layers.map(([icon, title, text]) => (
              <div key={title} className="relative flex flex-col rounded-2xl bg-bg p-4 shadow-[0_0_0_1px_var(--border)]">
                <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-text">{icon}</span>
                <h3 className="mt-3 font-display text-[15px] leading-tight font-bold hyphens-auto">{t(title)}</h3>
                <p className="mt-1.5 text-[13.5px] leading-snug text-fg-2">{t(text)}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 rounded-2xl px-4 py-3 shadow-[0_0_0_1px_var(--border)] xl:w-[120px] xl:shrink-0 xl:flex-col xl:py-6">
            <Globe size={26} className="text-accent-text" />
            <span className="font-display text-[14px] font-bold">{t("security.diagram.world")}</span>
          </div>
        </div>
        <pre className="mt-4 overflow-x-auto rounded-2xl bg-[var(--code-bg)] px-5 py-4 font-mono text-[12.5px] leading-relaxed text-[var(--code-fg)]">
          <span className="opacity-50">{t("security.code.seen")}</span>
          {"\n"}gmail_send({"{"} to: <span className="text-[#ffc857]">"{t("security.code.to")}"</span>, token: <span className="text-[#7be495]">"vault://gmail"</span> {"}"})
          {"\n"}
          <span className="opacity-50">{t("security.code.after")}</span>
        </pre>
      </div>
    </Section>
  );
}

export function Integrations() {
  const { t } = useI18n();
  return (
    <Section id="integrations" tone="canvas">
      <Heading eyebrow={t("integrations.eyebrow")} title={t("integrations.title")} lead={t("integrations.lead")} center />
      <div className="reveal mx-auto mt-12 grid max-w-[1040px] grid-cols-3 gap-2.5 sm:grid-cols-5 lg:grid-cols-8">
        {LOGOS.map((l) => (
          <div key={l.name} className="group flex flex-col items-center gap-2 rounded-2xl bg-surface p-3 shadow-[var(--shadow)] transition-transform duration-300 hover:-translate-y-0.5">
            {l.src ? (
              <img src={l.src} alt="" width={36} height={36} loading="lazy" className="size-9 rounded-[10px] object-contain" />
            ) : (
              <span className="grid size-9 place-items-center rounded-[10px] bg-accent-soft font-display text-[15px] font-bold text-accent-text">{l.name.slice(0, 1)}</span>
            )}
            <span className="w-full truncate text-center text-[12px] font-medium text-fg-2">{l.name}</span>
          </div>
        ))}
        <div className="flex items-center justify-center rounded-2xl px-3 py-3 text-center text-[12.5px] font-semibold text-accent-text shadow-[0_0_0_1px_var(--border)_inset]">{t("integrations.more")}</div>
      </div>
    </Section>
  );
}

/** Real screenshots of the iOS app (assets/iphone/<lang>-<n>-<what>.jpg): the first in front, the second behind it. */
function PhoneShots({ shots }: { shots: string[] }) {
  const { t } = useI18n();
  const phone = (src: string, alt: string, className: string) => (
    <div className={`rounded-[44px] bg-[#1c1814] p-[9px] shadow-[0_40px_80px_-30px_rgb(70_45_10/0.45),0_0_0_1px_rgb(255_255_255/0.08)_inset] ${className}`}>
      <img src={src} alt={alt} loading="lazy" className="block aspect-[1206/2622] w-full rounded-[36px] bg-bg" />
    </div>
  );
  return (
    <div className="relative mx-auto w-[min(440px,80vw)] pt-6">
      <div className="absolute inset-[-10%] -z-10 rounded-full bg-[radial-gradient(closest-side,var(--candy-glow),transparent)] opacity-70 blur-2xl" />
      {shots[1] && phone(shots[1], t("iphone.shotTeam"), "absolute top-0 left-0 w-[58%] -rotate-6")}
      {phone(shots[0], t("iphone.shotChat"), "relative ml-auto w-[64%] rotate-[3deg]")}
    </div>
  );
}

function PhoneMock() {
  const { t, lang } = useI18n();
  const shots = import.meta.glob("../assets/iphone/*.{png,jpg}", { eager: true, import: "default" }) as Record<string, string>;
  const own = Object.entries(shots)
    .filter(([p]) => p.includes(`/${lang}-`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, src]) => src);
  if (own.length) return <PhoneShots shots={own} />;
  return (
    <div className="relative mx-auto w-[min(300px,78vw)]">
      <div className="absolute inset-[-14%] -z-10 rounded-full bg-[radial-gradient(closest-side,var(--candy-glow),transparent)] opacity-70 blur-2xl" />
      <div className="relative aspect-[9/19.3] rounded-[46px] bg-[#1c1814] p-[11px] shadow-[0_40px_80px_-30px_rgb(70_45_10/0.45),0_0_0_1px_rgb(255_255_255/0.08)_inset]">
        <div className="relative h-full overflow-hidden rounded-[36px] bg-bg">
          <div className="absolute top-2.5 left-1/2 z-10 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-[#1c1814]" />
          {own.length ? (
            <img src={own[0]} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full flex-col px-3.5 pt-12 pb-4 text-[12.5px]">
              <div className="flex items-center gap-2 pb-3">
                <span className="relative size-7 rounded-[9px] bg-[linear-gradient(#ff8fc8,#db2777)]">
                  <span className="absolute top-[11px] left-[7px] size-[5px] rounded-full bg-white" />
                  <span className="absolute top-[11px] right-[7px] size-[5px] rounded-full bg-white" />
                </span>
                <span className="font-semibold">{t("iphone.mock.agent")}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2.5">
                <div className="w-[86%] rounded-2xl rounded-tl-md bg-surface px-3 py-2 leading-snug shadow-[var(--shadow)]">{t("iphone.mock.reply")}</div>
                <div className="w-[60%] rounded-2xl rounded-tl-md bg-surface px-3 py-2 leading-snug shadow-[var(--shadow)]">{t("iphone.mock.ask")}</div>
                <div className="mt-1 w-[92%] rounded-2xl bg-surface p-3 shadow-[var(--shadow)]">
                  <p className="leading-snug font-semibold">{t("iphone.mock.card")}</p>
                  <div className="mt-2.5 flex gap-1.5">
                    <span className="candy inline-flex flex-1 items-center justify-center gap-1 rounded-full py-1.5 text-[12px] font-semibold">
                      <FaceId size={13} />
                      {t("iphone.mock.approve")}
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-full bg-surface px-3 py-2 text-muted shadow-[0_0_0_1px_var(--border)]">
                <span className="flex-1">…</span>
                <Mic size={14} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Iphone() {
  const { t } = useI18n();
  const points: Array<[ReactNode, MessageKey]> = [
    [<FaceId size={18} />, "iphone.point1"],
    [<Bell size={18} />, "iphone.point2"],
    [<Mic size={18} />, "iphone.point3"],
  ];
  return (
    <Section id="iphone">
      <div className="grid items-center gap-14 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="reveal">
            <p className="flex items-center gap-2.5 text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">
              {t("iphone.eyebrow")}
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11.5px] tracking-normal normal-case">{t("iphone.soon")}</span>
            </p>
            <h2 className="mt-3 font-display text-[clamp(1.9rem,3.8vw,3.1rem)] leading-[1.06] font-extrabold tracking-[-0.02em] text-balance">{t("iphone.title")}</h2>
            <p className="mt-4 max-w-[34rem] text-[17px] leading-relaxed text-fg-2 text-pretty">{t("iphone.lead")}</p>
          </div>
          <ul className="reveal mt-7 flex flex-col gap-3">
            {points.map(([icon, key]) => (
              <li key={key} className="flex items-center gap-3 text-[16px] font-medium">
                <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-text">{icon}</span>
                {t(key)}
              </li>
            ))}
          </ul>
          <div className="reveal mt-9">
            {data.testflightUrl ? (
              <a href={data.testflightUrl} className="candy inline-flex items-center gap-2.5 rounded-full px-6 py-3.5 text-[16px] font-semibold">
                <Apple size={18} />
                {t("iphone.testflight")}
              </a>
            ) : (
              <span aria-disabled="true" className="inline-flex cursor-default items-center gap-2.5 rounded-full bg-surface-2 px-6 py-3.5 text-[16px] font-semibold text-muted">
                <Apple size={18} />
                {t("iphone.testflightSoon")}
              </span>
            )}
          </div>
        </div>
        <div className="reveal">
          <PhoneMock />
        </div>
      </div>
    </Section>
  );
}

function CopyBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-2xl bg-[var(--code-bg)] py-4 pr-24 pl-5 font-mono text-[13px] leading-relaxed text-[var(--code-fg)]">{code}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          });
        }}
        className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--code-fg)] transition-colors hover:bg-white/20"
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
        {done ? t("install.copied") : t("install.copy")}
      </button>
    </div>
  );
}

export function Install() {
  const { t } = useI18n();
  const [tab, setTab] = useState<"mac" | "win" | "docker">("mac");
  const tabs: Array<["mac" | "win" | "docker", ReactNode, MessageKey]> = [
    ["mac", <Apple size={16} />, "install.tab.mac"],
    ["win", <Windows size={15} />, "install.tab.win"],
    ["docker", <Docker size={17} />, "install.tab.docker"],
  ];
  const steps = (os: "mac" | "win") => (
    <ol className="flex flex-col gap-3">
      {([1, 2, 3] as const).map((n) => (
        <li key={n} className="flex gap-3.5 text-[16px] leading-relaxed">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft font-display text-[13px] font-bold text-accent-text">{n}</span>
          <span className="pt-0.5">{t(`install.${os}.step${n}`)}</span>
        </li>
      ))}
    </ol>
  );
  return (
    <Section id="install" tone="canvas">
      <div className="grid items-start gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        <Heading eyebrow={t("install.eyebrow")} title={t("install.title")} lead={t("install.lead")} />
        <div className="reveal rounded-[26px] bg-surface p-5 shadow-[var(--shadow)] sm:p-7">
          <div className="flex gap-1 rounded-full bg-surface-2 p-1" role="tablist">
            {tabs.map(([id, icon, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`inline-flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-[14px] font-semibold transition-all ${tab === id ? "bg-surface text-fg shadow-[var(--shadow)]" : "text-muted hover:text-fg"}`}
              >
                {icon}
                {t(label)}
              </button>
            ))}
          </div>
          <div className="mt-7" role="tabpanel">
            {tab === "docker" ? (
              <div className="flex flex-col gap-4">
                <p className="text-[16px] text-fg-2">{t("install.docker.lead")}</p>
                <CopyBlock code={`git clone https://github.com/${siteConfig.repo}.git piomio && cd piomio\ndocker compose up -d\ndocker compose logs piomio | grep -A1 "Piomio:"`} />
                <p className="text-[14px] text-muted">{t("install.docker.note")}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {steps(tab)}
                <div className="flex flex-wrap items-center gap-3">
                  <a href={downloadHref(tab)} className="candy inline-flex items-center gap-2 rounded-full px-5 py-3 text-[15px] font-semibold">
                    {tab === "mac" ? <Apple size={17} /> : <Windows size={16} />}
                    {t("install.download")}
                    {data.release.version && <span className="font-medium opacity-70">{t("install.version", { version: data.release.version })}</span>}
                  </a>
                  <a href={data.release.page} className="text-[14px] font-semibold text-accent-text underline-offset-4 hover:underline">
                    {t("install.allReleases")}
                  </a>
                </div>
                <p className="text-[13.5px] leading-relaxed text-muted">{t(`install.${tab}.note`)}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

export function Footer() {
  const { t } = useI18n();
  const repo = `https://github.com/${data.repo}`;
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-4 py-12 sm:flex-row sm:items-center sm:px-6 lg:px-10">
        <div className="flex items-center gap-3">
          <OwlMark size={34} />
          <div>
            <p className="font-display text-[16px] font-bold">Piomio</p>
            <p className="text-[13.5px] text-muted">{t("footer.tagline")}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[14px] font-medium text-fg-2 sm:ml-auto">
          <a href={repo} className="inline-flex items-center gap-1.5 hover:text-fg">
            <GitHub size={15} />
            {t("footer.github")}
          </a>
          <a href={`${repo}#readme`} className="hover:text-fg">
            {t("footer.readme")}
          </a>
          <a href={data.release.page} className="hover:text-fg">
            {t("footer.releases")}
          </a>
          <a href={`${repo}#license`} className="hover:text-fg">
            {t("footer.license")}
          </a>
        </div>
      </div>
    </footer>
  );
}
