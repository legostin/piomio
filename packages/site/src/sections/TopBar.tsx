// The top bar: the owl and the name, the page's parts, the language, GitHub and the download.

import { siteConfig } from "../../site.config";
import { data } from "../data";
import { useI18n } from "../i18n";
import { GitHub, OwlMark, Star } from "../components/icons";
import { DownloadButton } from "../components/Download";

export function TopBar() {
  const { lang, t } = useI18n();
  const links: Array<[string, string]> = [
    ["#demo", t("nav.demo")],
    ["#features", t("nav.features")],
    ["#security", t("nav.security")],
    ["#faq", t("nav.faq")],
  ];
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
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-full bg-surface-2 p-0.5 text-[12.5px] font-semibold" role="group" aria-label={t("nav.language")}>
            {siteConfig.languages.map((l) => (
              <a
                key={l}
                href={`${data.base}${l}/`}
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
