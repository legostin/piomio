// A docs page (/<lang>/docs/[<line>/]<page>/): the sidebar with the version and the pages (a menu above the page on a
// phone), the page itself, and "On this page" on wide screens.

import type { ReactNode } from "react";
import { data as site } from "../data";
import { useI18n } from "../i18n";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight } from "../components/icons";
import { DocBody } from "./DocBody";
import { outline, parseDoc } from "./markdown";
import { docHref, resolveLink, type DocPageData } from "./page";

export function DocsPage({ data }: { data: DocPageData }) {
  const { t } = useI18n();
  const doc = parseDoc(data.source);
  const toc = outline(doc.blocks);
  const pages = data.nav.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })));
  const at = pages.findIndex((p) => p.slug === data.slug);
  const [prev, next] = [pages[at - 1], pages[at + 1]];
  const href = (slug: string) => docHref(site.base, data.lang, data.prefix, slug);
  const latest = data.versions.find((v) => v.current);

  return (
    <div className="mx-auto max-w-[1320px] px-4 sm:px-6 lg:px-10">
      <div className="lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[15.5rem_minmax(0,1fr)_13.5rem]">
        <aside className="hidden lg:block">
          <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto pt-10 pb-12 pr-1">
            <Versions data={data} />
            <Nav data={data} href={href} />
          </div>
        </aside>

        <div className="min-w-0">
          <details className="group/menu sticky top-16 z-30 -mx-4 border-b border-hairline bg-[var(--glass)] backdrop-blur-xl sm:-mx-6 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[14.5px] font-semibold sm:px-6 [&::-webkit-details-marker]:hidden">
              <span className="text-muted">{t("docs.menu")}</span>
              <ChevronRight size={14} className="text-muted" />
              <span className="truncate">{pages[at]?.title}</span>
              <ChevronDown size={16} className="ml-auto shrink-0 text-muted transition-transform group-open/menu:rotate-180" />
            </summary>
            <div className="max-h-[70vh] overflow-y-auto px-4 pb-6 sm:px-6">
              <Versions data={data} />
              <Nav data={data} href={href} />
            </div>
          </details>

          <article className="max-w-[46rem] pt-8 pb-20 sm:pt-10 lg:pt-12">
            {!data.version.current && latest && (
              <p className="mb-8 rounded-2xl border-l-4 border-accent bg-accent-soft/60 px-5 py-4 text-[15px] leading-relaxed text-fg">
                {t("docs.older", { version: data.version.release })}{" "}
                <a href={docHref(site.base, data.lang, "", data.slug)} className="font-semibold text-accent-text underline-offset-4 hover:underline">
                  {t("docs.toLatest")}
                </a>
              </p>
            )}
            <header>
              {pages[at] && data.slug !== "index" && <p className="text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">{pages[at].group}</p>}
              <h1 className="mt-3 font-display text-[clamp(2rem,4.2vw,3rem)] leading-[1.05] font-extrabold tracking-[-0.025em] text-balance">{doc.meta.title}</h1>
              <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13.5px] text-muted">
                <span>{t("docs.describes", { version: data.version.release })}</span>
                {data.editUrl && (
                  <a href={data.editUrl} className="hover:text-fg">
                    {t("docs.edit")}
                  </a>
                )}
              </p>
            </header>
            <div className="mt-9">
              <DocBody blocks={doc.blocks} link={(h) => resolveLink(h, site.base, data.lang, data.prefix)} />
            </div>
            {(prev || next) && (
              <nav className="mt-16 grid gap-3 sm:grid-cols-2" aria-label={t("docs.pages")}>
                {prev ? <Step href={href(prev.slug)} label={t("docs.prev")} title={prev.title} icon={<ChevronLeft size={16} />} /> : <span />}
                {next && <Step href={href(next.slug)} label={t("docs.next")} title={next.title} icon={<ArrowRight size={16} />} end />}
              </nav>
            )}
          </article>
        </div>

        {toc.length > 1 && (
          <aside className="hidden xl:block">
            <nav className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto pt-12 pb-12" aria-label={t("docs.onThisPage")}>
              <p className="text-[12.5px] font-bold tracking-[0.12em] text-muted uppercase">{t("docs.onThisPage")}</p>
              <ul className="mt-3 flex flex-col gap-2 border-l border-hairline text-[14px] leading-snug">
                {toc.map((h) => (
                  <li key={h.id} className={h.level === 3 ? "pl-7" : "pl-4"}>
                    <a href={`#${h.id}`} className={`block ${h.level === 3 ? "text-muted" : "text-fg-2"} hover:text-fg`}>
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}
      </div>
    </div>
  );
}

/** Which version the page describes, and the others. */
function Versions({ data }: { data: DocPageData }) {
  const { t } = useI18n();
  return (
    <details className="group/v relative mt-4 lg:mt-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl bg-surface px-3.5 py-2.5 text-[14px] font-semibold shadow-[var(--shadow)] [&::-webkit-details-marker]:hidden">
        <span className="text-muted">{t("docs.version")}</span>
        <span>{data.version.id}</span>
        {data.version.current && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-bold text-accent-text">{t("docs.latest")}</span>}
        <ChevronDown size={15} className="ml-auto text-muted transition-transform group-open/v:rotate-180" />
      </summary>
      <div className="mt-2 flex flex-col rounded-xl bg-surface p-1.5 text-[14px] shadow-[var(--shadow)]">
        {data.versions.map((v) => (
          <a
            key={v.id}
            href={docHref(site.base, data.lang, v.current ? "" : `${v.id}/`, data.slug)}
            aria-current={v.id === data.version.id ? "page" : undefined}
            className={`flex items-baseline gap-2 rounded-lg px-2.5 py-2 hover:bg-surface-2 ${v.id === data.version.id ? "font-semibold text-fg" : "text-fg-2"}`}
          >
            <span>{v.id}</span>
            <span className="text-[12.5px] text-muted">{v.release}</span>
            {v.current && <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent-text">{t("docs.latest")}</span>}
          </a>
        ))}
        <div className="mt-1 border-t border-hairline pt-1">
          {data.sourceUrl && (
            <a href={data.sourceUrl} className="block rounded-lg px-2.5 py-2 text-[13px] text-fg-2 hover:bg-surface-2">
              {t("docs.atRelease", { version: data.version.release })}
            </a>
          )}
          <a href={`https://github.com/${site.repo}/releases`} className="block rounded-lg px-2.5 py-2 text-[13px] text-fg-2 hover:bg-surface-2">
            {t("docs.releases")}
          </a>
        </div>
      </div>
    </details>
  );
}

function Nav({ data, href }: { data: DocPageData; href: (slug: string) => string }) {
  return (
    <nav className="mt-6 flex flex-col gap-6">
      {data.nav.map((g) => (
        <div key={g.title}>
          <p className="px-3 text-[12px] font-bold tracking-[0.12em] text-muted uppercase">{g.title}</p>
          <ul className="mt-2 flex flex-col gap-0.5">
            {g.pages.map((p) => (
              <li key={p.slug}>
                <a
                  href={href(p.slug)}
                  aria-current={p.slug === data.slug ? "page" : undefined}
                  className={`block rounded-lg px-3 py-1.5 text-[14.5px] leading-snug transition-colors ${p.slug === data.slug ? "bg-accent-soft font-semibold text-accent-text" : "text-fg-2 hover:bg-surface-2 hover:text-fg"}`}
                >
                  {p.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Step({ href, label, title, icon, end }: { href: string; label: string; title: string; icon: ReactNode; end?: boolean }) {
  return (
    <a href={href} className={`group flex flex-col gap-1 rounded-[18px] bg-surface px-5 py-4 shadow-[var(--shadow)] transition-transform hover:-translate-y-0.5 ${end ? "sm:items-end sm:text-right" : ""}`}>
      <span className={`flex items-center gap-1.5 text-[12.5px] font-semibold text-muted ${end ? "flex-row-reverse" : ""}`}>
        {icon}
        {label}
      </span>
      <span className="font-display text-[16.5px] font-bold tracking-[-0.01em]">{title}</span>
    </a>
  );
}
