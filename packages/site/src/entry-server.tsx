// Prerendering (scripts/prerender.mjs): a page's markup and its <head> for one language (on the landing page with
// structured data for search engines: the app and the FAQ), a docs page's, and llms.txt for agents that read the site.

import { renderToString } from "react-dom/server";
import { siteConfig, type Lang } from "../site.config";
import { App } from "./App";
import { data } from "./data";
import { translator } from "./i18n";
import { FAQ } from "./sections/Sections";
import { PAGES, pagePath, type Page } from "./pages";
import { parseDoc } from "./docs/markdown";
import { docHref, type DocPageData } from "./docs/page";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Open Graph locale tags. The path and html lang stay the short code (`zh`); this is the regional tag. */
const OG_LOCALE: Record<Lang, string> = { en: "en_US", ru: "ru_RU", zh: "zh_CN" };
/** JSON inside <script>: nothing in it may close the tag. */
const ld = (o: object) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;

export { PAGES, pagePath };

/** The <head> tags every page has: title, description, its address in each language, the card for links. */
function headTags(o: { lang: Lang; title: string; description: string; url: (lang: Lang) => string; canonical: string; article: boolean; noindex?: boolean; languages?: readonly Lang[] }): string[] {
  const t = translator(o.lang);
  return [
    `<title>${esc(o.title)}</title>`,
    `<meta name="description" content="${esc(o.description)}" />`,
    ...(o.noindex ? [`<meta name="robots" content="noindex" />`] : []),
    `<link rel="canonical" href="${o.canonical}" />`,
    ...(o.languages ?? siteConfig.languages).map((l) => `<link rel="alternate" hreflang="${l}" href="${o.url(l)}" />`),
    `<link rel="alternate" hreflang="x-default" href="${o.url("en")}" />`,
    `<meta property="og:type" content="${o.article ? "article" : "website"}" />`,
    `<meta property="og:site_name" content="Piomio" />`,
    `<meta property="og:locale" content="${OG_LOCALE[o.lang]}" />`,
    `<meta property="og:title" content="${esc(o.title)}" />`,
    `<meta property="og:description" content="${esc(o.description)}" />`,
    `<meta property="og:url" content="${o.url(o.lang)}" />`,
    `<meta property="og:image" content="${data.origin}${data.base}og-${o.lang}.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(t("meta.ogAlt"))}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(o.title)}" />`,
    `<meta name="twitter:description" content="${esc(o.description)}" />`,
    `<meta name="twitter:image" content="${data.origin}${data.base}og-${o.lang}.png" />`,
  ];
}

export function render(lang: Lang, which: Page = "home"): { html: string; head: string } {
  const t = translator(lang);
  const page = (l: string) => `${data.origin}${data.base}${l}/${pagePath(which)}`;
  const home = which === "home";
  const head = headTags({
    lang,
    title: t(home ? "meta.title" : "server.meta.title"),
    description: t(home ? "meta.description" : "server.meta.description"),
    url: page,
    canonical: page(lang),
    article: !home,
  });
  if (home)
    head.push(
    ld({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Piomio",
      description: t("meta.description"),
      url: page(lang),
      inLanguage: lang,
      applicationCategory: "ProductivityApplication",
      operatingSystem: "macOS, Windows, Linux",
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: data.release.page,
      ...(data.release.version ? { softwareVersion: data.release.version } : {}),
      codeRepository: `https://github.com/${data.repo}`,
    }),
    ld({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: lang,
      mainEntity: FAQ.map((n) => ({ "@type": "Question", name: t(`faq.q${n}`), acceptedAnswer: { "@type": "Answer", text: t(`faq.a${n}`) } })),
    }),
    );
  return { html: renderToString(<App lang={lang} page={which} />), head: head.join("\n    ") };
}

/**
 * A docs page. The newest line's pages exist twice, at /<lang>/docs/… and /<lang>/docs/<line>/…; the first is the
 * canonical one. An older line's pages are their own and stay out of search results.
 */
export function renderDoc(doc: DocPageData): { html: string; head: string } {
  const t = translator(doc.lang);
  const { meta } = parseDoc(doc.source);
  const url = (l: string, prefix = doc.prefix) => `${data.origin}${docHref(data.base, l, prefix, doc.slug)}`;
  const head = headTags({
    lang: doc.lang,
    title: doc.slug === "index" ? meta.title : `${meta.title} · ${t("docs.meta.suffix")}`,
    description: meta.description,
    url: (l) => url(l),
    canonical: doc.version.current ? url(doc.sourceLang ?? doc.lang, "") : url(doc.sourceLang ?? doc.lang),
    languages: doc.translatedLangs,
    article: true,
    noindex: !doc.version.current,
  });
  return { html: renderToString(<App lang={doc.lang} page="docs" doc={doc} />), head: head.join("\n    ") };
}

/**
 * llms.txt: what Piomio is and where to read more, for agents (English, like everything written for models), with the
 * docs' pages as Markdown.
 */
export function llmsTxt(docs: Array<{ slug: string; title: string; description: string }> = []): string {
  const t = translator("en");
  const repo = `https://github.com/${data.repo}`;
  return `# Piomio

> ${t("meta.description")}

Piomio is a self-hosted personal agent platform: a team of AI agents with names and jobs that you talk to in a chat. It runs as a desktop app for macOS and Windows, on a Linux server (one command), and several computers form one team. Agents think with the Claude Code, Codex and Kimi Code CLIs on the person's own plans, signed in with their own accounts; a hub on a server can also take API keys (Anthropic, OpenAI, OpenRouter, DeepSeek, GLM, any OpenAI-compatible server, Ollama) when started with PIOMIO_API_KEYS=1. Anything that reaches outside (emails, bookings, payments) waits for the person's approval in the chat; secrets live in a vault the model never sees. Free and open source under Apache-2.0.

## Docs

${docs.map((d) => `- [${d.title}](${data.origin}${data.base}en/docs/${d.slug}.md): ${d.description}`).join("\n")}

The same pages as web pages: ${data.origin}${data.base}en/docs/ ([Russian](${data.origin}${data.base}ru/docs/)). Simplified Chinese ([简体中文](${data.origin}${data.base}zh/)) has the landing page and the server guide translated; ${data.origin}${data.base}zh/docs/ serves these English pages until the guide is translated.

## More

- [README](${repo}#readme): what it does, install, configuration
- [Releases](${repo}/releases): installers for macOS and Windows
- [Website](${data.origin}${data.base}en/): live demo, features, FAQ ([Russian](${data.origin}${data.base}ru/), [简体中文](${data.origin}${data.base}zh/))
- [On a server](${data.origin}${data.base}en/server/): the hub on a Linux server or the server as a computer of an existing hub, signing in to a CLI there, opening the chat ([Russian](${data.origin}${data.base}ru/server/), [简体中文](${data.origin}${data.base}zh/server/))
- [Setup for agents](${siteConfig.setupGuide}): step-by-step instructions for a coding agent asked to install and set up Piomio on the machine it runs on (macOS, Windows, a Linux server)

## Install on a server

On Linux with systemd (x64 or arm64), as root:

\`\`\`
curl -fsSL ${siteConfig.installScript} | sh
\`\`\`

It creates the user \`piomio\` without sudo and runs the hub as that user's systemd service. Sign in to Claude Code, Codex or Kimi Code as that user (\`sudo -iu piomio\`); the hub uses that sign-in as it is. The chat listens on 127.0.0.1:8080: open it through \`ssh -N -L 8080:localhost:8080 root@<server>\` at http://localhost:8080 with the setup code the installer printed. With an invite link from an existing hub (\`curl -fsSL ${siteConfig.installScript} | sh -s -- https://<hub>/join/<code>\`) the server becomes a computer of that hub instead.
`;
}
