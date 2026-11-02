// The top bar: the owl and the name, the page's parts and the docs, the language, GitHub and the download.

import { siteConfig, type Lang } from "../../site.config";
import { data } from "../data";
import { useI18n } from "../i18n";
import { Book, GitHub, OwlMark, Star } from "../components/icons";
import { DownloadButton } from "../components/Download";
import { pagePath, type Page } from "../pages";

/** `hrefFor`: this page in another language, when it is not a fixed page (a docs page). */
export function TopBar({ page = "home", hrefFor }: { page?: Page; hrefFor?: (lang: Lang) => string }) {
  const { lang, t } = useI18n();
  // On another page the landing page's parts are links back to it.
  const home = page === "home" ? "" : `${data.base}${lang}/`;
  const links: Array<[string, string]> = [
    [`${home}#demo`, t("nav.demo")],
    [`${home}#features`, t("nav.features")],
    [`${home}#security`, t("nav.security")],
    [`${home}#faq`, t("nav.faq")],
  ];
  const docs = `${data.base}${lang}/docs/`;
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-[var(--glass)] backdrop-blur-xl backdrop-saturate-150">
      <nav className="mx-auto flex h-16 max-w-[1320px] items-center gap-3 px-4 sm:px-6 lg:px-10">
        <a href={`${data.base}${lang}/`} className="flex items-center gap-2.5 rounded-lg" aria-label={t("nav.home")}>
          <OwlMark size={30} />
          <span className="font-display text-[17px] font-bold tracking-tight">Piomio</span>
        </a>
        <div className="ml-6 hidden items-center gap-1 lg:flex">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="rounded-full px-3 py-1.5 text-[14.5px] font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg">
              {label}
            </a>
          ))}
          <a href={docs} aria-current={page === "docs" ? "page" : undefined} className="rounded-full px-3 py-1.5 text-[14.5px] font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg aria-[current=page]:text-fg">
            {t("nav.docs")}
          </a>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Below lg the page's parts hide; the docs stay, as a word, or a book where even that doesn't fit. */}
          <a
            href={docs}
            aria-current={page === "docs" ? "page" : undefined}
            aria-label={t("nav.docs")}
            className="grid size-9 place-items-center rounded-full text-fg-2 hover:text-fg aria-[current=page]:text-fg sm:size-auto sm:px-2.5 sm:py-1.5 lg:hidden"
          >
            <Book size={18} className="sm:hidden" />
            <span className="hidden text-[14px] font-medium sm:inline">{t("nav.docs")}</span>
          </a>
          <div className="flex rounded-full bg-surface-2 p-0.5 text-[12.5px] font-semibold" role="group" aria-label={t("nav.language")}>
            {siteConfig.languages.map((l) => (
              <a
                key={l}
                href={hrefFor ? hrefFor(l) : `${data.base}${l}/${pagePath(page)}`}
                hrefLang={l}
                lang={l}
                aria-current={l === lang ? "page" : undefined}
                className={`rounded-full px-2.5 py-1 uppercase transition-colors ${l === lang ? "bg-surface text-fg shadow-[var(--shadow)]" : "text-muted hover:text-fg"}`}
              >
                {l}
              </a>
            ))}
          </div>
          <a
            href={`https://github.com/${data.repo}`}
            className="ghost hidden items-center gap-2 rounded-full px-3 py-1.5 text-[14px] font-medium sm:inline-flex"
            aria-label={data.stars ? t("nav.stars", { count: data.stars }) : "GitHub"}
          >
            <GitHub size={17} />
            {data.stars ? (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Star size={13} className="text-accent" />
                {data.stars.toLocaleString(lang)}
              </span>
            ) : (
              <span>GitHub</span>
            )}
          </a>
          <DownloadButton size="sm" />
        </div>
      </nav>
    </header>
  );
}
