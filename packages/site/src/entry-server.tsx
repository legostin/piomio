// Prerendering (scripts/prerender.mjs): the page's markup and its <head> for one language (with structured data for
// search engines: the app and the FAQ), and llms.txt for agents that read the site.

import { renderToString } from "react-dom/server";
import { siteConfig, type Lang } from "../site.config";
import { App } from "./App";
import { data } from "./data";
import { translator } from "./i18n";
import { FAQ } from "./sections/Sections";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** JSON inside <script>: nothing in it may close the tag. */
const ld = (o: object) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;

export function render(lang: Lang): { html: string; head: string } {
  const t = translator(lang);
  const page = (l: string) => `${data.origin}${data.base}${l}/`;
  const head = [
    `<title>${esc(t("meta.title"))}</title>`,
    `<meta name="description" content="${esc(t("meta.description"))}" />`,
    `<link rel="canonical" href="${page(lang)}" />`,
    ...siteConfig.languages.map((l) => `<link rel="alternate" hreflang="${l}" href="${page(l)}" />`),
    `<link rel="alternate" hreflang="x-default" href="${page("en")}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Piomio" />`,
    `<meta property="og:locale" content="${lang === "ru" ? "ru_RU" : "en_US"}" />`,
    `<meta property="og:title" content="${esc(t("meta.title"))}" />`,
    `<meta property="og:description" content="${esc(t("meta.description"))}" />`,
    `<meta property="og:url" content="${page(lang)}" />`,
    `<meta property="og:image" content="${data.origin}${data.base}og-${lang}.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(t("meta.ogAlt"))}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(t("meta.title"))}" />`,
    `<meta name="twitter:description" content="${esc(t("meta.description"))}" />`,
    `<meta name="twitter:image" content="${data.origin}${data.base}og-${lang}.png" />`,
    ld({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Piomio",
      description: t("meta.description"),
      url: page(lang),
      inLanguage: lang,
      applicationCategory: "ProductivityApplication",
      operatingSystem: "macOS, Windows, Linux (Docker)",
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
  ].join("\n    ");
  return { html: renderToString(<App lang={lang} />), head };
}

/** llms.txt: what Piomio is and where to read more, for agents (English, like everything written for models). */
export function llmsTxt(): string {
  const t = translator("en");
  const repo = `https://github.com/${data.repo}`;
  return `# Piomio

> ${t("meta.description")}

Piomio is a self-hosted personal agent platform: a team of AI agents with names and jobs that you talk to in a chat. It runs as a desktop app for macOS and Windows or as one Docker image on a server, and several computers form one team. Agents think with the Claude Code and Codex CLIs on the person's own plans, with API keys (Anthropic, OpenAI, OpenRouter, DeepSeek, Kimi, GLM, any OpenAI-compatible server, Ollama) as backups. Anything that reaches outside (emails, bookings, payments) waits for the person's approval in the chat; secrets live in a vault the model never sees. Free and open source under Apache-2.0.

## Docs

- [README](${repo}#readme): what it does, install, configuration
- [Releases](${repo}/releases): installers for macOS and Windows
- [Website](${data.origin}${data.base}en/): live demo, features, FAQ ([Russian](${data.origin}${data.base}ru/))

## Install on a server

\`\`\`
git clone ${repo}.git piomio && cd piomio
docker compose up -d
docker compose logs piomio | grep -A1 "Piomio:"
\`\`\`

Then open http://localhost:8080, enter the setup code from the logs and choose a password.
`;
}
