// Prerendering (scripts/prerender.mjs): a page's markup and its <head> for one language (on the landing page with
// structured data for search engines: the app and the FAQ), and llms.txt for agents that read the site.

import { renderToString } from "react-dom/server";
import { siteConfig, type Lang } from "../site.config";
import { App } from "./App";
import { data } from "./data";
import { translator } from "./i18n";
import { FAQ } from "./sections/Sections";
import { PAGES, pagePath, type Page } from "./pages";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** JSON inside <script>: nothing in it may close the tag. */
const ld = (o: object) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;

export { PAGES, pagePath };

export function render(lang: Lang, which: Page = "home"): { html: string; head: string } {
  const t = translator(lang);
  const page = (l: string) => `${data.origin}${data.base}${l}/${pagePath(which)}`;
  const home = which === "home";
  const title = t(home ? "meta.title" : "server.meta.title");
  const description = t(home ? "meta.description" : "server.meta.description");
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${page(lang)}" />`,
    ...siteConfig.languages.map((l) => `<link rel="alternate" hreflang="${l}" href="${page(l)}" />`),
    `<link rel="alternate" hreflang="x-default" href="${page("en")}" />`,
    `<meta property="og:type" content="${home ? "website" : "article"}" />`,
    `<meta property="og:site_name" content="Piomio" />`,
    `<meta property="og:locale" content="${lang === "ru" ? "ru_RU" : "en_US"}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${page(lang)}" />`,
    `<meta property="og:image" content="${data.origin}${data.base}og-${lang}.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(t("meta.ogAlt"))}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${data.origin}${data.base}og-${lang}.png" />`,
  ];
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

/** llms.txt: what Piomio is and where to read more, for agents (English, like everything written for models). */
export function llmsTxt(): string {
  const t = translator("en");
  const repo = `https://github.com/${data.repo}`;
  return `# Piomio

> ${t("meta.description")}

Piomio is a self-hosted personal agent platform: a team of AI agents with names and jobs that you talk to in a chat. It runs as a desktop app for macOS and Windows, on a Linux server (one command), and several computers form one team. Agents think with the Claude Code, Codex and Kimi Code CLIs on the person's own plans, signed in with their own accounts; a hub on a server can also take API keys (Anthropic, OpenAI, OpenRouter, DeepSeek, GLM, any OpenAI-compatible server, Ollama) when started with PIOMIO_API_KEYS=1. Anything that reaches outside (emails, bookings, payments) waits for the person's approval in the chat; secrets live in a vault the model never sees. Free and open source under Apache-2.0.

## Docs

- [README](${repo}#readme): what it does, install, configuration
- [Releases](${repo}/releases): installers for macOS and Windows
- [Website](${data.origin}${data.base}en/): live demo, features, FAQ ([Russian](${data.origin}${data.base}ru/))
- [On a server](${data.origin}${data.base}en/server/): the hub on a Linux server or the server as a computer of an existing hub, signing in to a CLI there, opening the chat ([Russian](${data.origin}${data.base}ru/server/))
- [Setup for agents](${siteConfig.setupGuide}): step-by-step instructions for a coding agent asked to install and set up Piomio on the machine it runs on (macOS, Windows, a Linux server)

## Install on a server

On Linux with systemd (x64 or arm64), as root:

\`\`\`
curl -fsSL ${siteConfig.installScript} | sh
\`\`\`

It creates the user \`piomio\` without sudo and runs the hub as that user's systemd service. Sign in to Claude Code, Codex or Kimi Code as that user (\`sudo -iu piomio\`); the hub uses that sign-in as it is. The chat listens on 127.0.0.1:8080: open it through \`ssh -N -L 8080:localhost:8080 root@<server>\` at http://localhost:8080 with the setup code the installer printed. With an invite link from an existing hub (\`curl -fsSL ${siteConfig.installScript} | sh -s -- https://<hub>/join/<code>\`) the server becomes a computer of that hub instead.
`;
}
