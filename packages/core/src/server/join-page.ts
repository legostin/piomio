// The invite's page (`/join/<code>`, invites.ts) and the desktop installers. One https link reaches any device; the page
// hands off to the app through piomio:// links: the desktop app pairs with the address the page was opened at, the
// phone with its usual pairing link. Server-rendered, no script, in the browser's language. The User-Agent only picks
// which way comes first: the others stay one click away, since an iPad says it is a Mac.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Hub } from "../app.ts";
import { requestLocale, tFor } from "../i18n.ts";
import { desktopPairLink, hubName } from "../pairing.ts";
import { HttpError, type FailureBudget } from "./http.ts";

type Platform = "windows" | "macos" | "ios" | "android" | "other";

export function platformOf(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  return "other";
}

/** The release assets packaging/desktop/build.mjs makes, by the hub's own version. */
export function installerUrl(repo: string, version: string, os: "windows" | "macos"): string {
  const asset = os === "windows" ? `piomio-setup-${version}-x64.exe` : `piomio-${version}.dmg`;
  return `https://github.com/${repo}/releases/download/v${version}/${asset}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root{--bg:#fbfaf7;--fg:#17140f;--muted:#6b665d;--line:#e4e0d7;--card:#fff;--accent:#17140f;--on-accent:#fbfaf7;--code:#f2efe8}
@media (prefers-color-scheme:dark){:root{--bg:#141310;--fg:#f2efe8;--muted:#a39d91;--line:#2d2a24;--card:#1c1a16;--accent:#f2efe8;--on-accent:#141310;--code:#24221d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:0 auto;padding:12vh 16px 4rem}.owl{font:600 1.1rem ui-monospace,monospace;color:var(--muted)}
h1{font-size:1.6rem;line-height:1.25;margin:.4rem 0 .6rem}p{margin:.5rem 0}.muted{color:var(--muted);font-size:.92rem}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin:18px 0}
h2{font-size:1rem;margin:0 0 .4rem}
.button{display:inline-block;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;padding:.7rem 1.2rem;border-radius:12px;margin:.4rem 0}
.secondary{display:inline-block;color:var(--fg);font-weight:600;margin:.2rem 1rem .2rem 0}
code{display:block;background:var(--code);border-radius:10px;padding:.6rem .75rem;font:13px/1.5 ui-monospace,monospace;overflow-wrap:anywhere;user-select:all}
details{margin-top:18px}summary{cursor:pointer;color:var(--muted)}`;

/** Registers `GET /join/:code` and `GET /download/desktop/:os` on the web app (local and the link's gateway). */
export function registerJoinPage(app: FastifyInstance, hub: Hub, o: { remote: boolean; budget: FailureBudget }): void {
  const cfg = hub.config;

  app.get("/join/:code", async (req, reply) => {
    const t = tFor(requestLocale(req));
    const code = (req.params as { code: string }).code;
    if (o.budget.exhausted(req)) throw new HttpError(429, "auth.tooManyAttempts");
    if (!hub.invites.valid(code)) {
      o.budget.fail(req);
      return page(reply, 410, t("join.expiredTitle"), `<p>${esc(t("join.expired"))}</p>`, t);
    }
    // The address this browser reached the hub at is one the desktop app on this computer can reach too.
    const origin = `${o.remote ? "https:" : new URL(cfg.publicUrl).protocol}//${req.headers.host}`;
    const platform = platformOf(String(req.headers["user-agent"] ?? ""));
    const desktop = desktopSection(t, desktopPairLink(origin, code), platform === "macos" ? ["macos", "windows"] : ["windows", "macos"]);
    const phoneLink = hub.phoneLink(code);
    const phone = phoneSection(t, phoneLink);
    const server = `<section><h2>${esc(t("join.server.title"))}</h2><p class="muted">${esc(t("join.server.hint"))}</p><code>curl -fsSLo piomio-node.mjs ${esc(origin)}/download/piomio-node.mjs &amp;&amp; node piomio-node.mjs pair ${esc(origin)}/join/${esc(code)}</code></section>`;
    const first = platform === "ios" ? phone : platform === "android" ? `<section><p>${esc(t("join.android"))}</p></section>` : platform === "other" ? server : desktop;
    const rest = (platform === "ios" ? [desktop, server] : platform === "android" ? [desktop, phone, server] : platform === "other" ? [desktop, phone] : [phone, server]).join("");
    const lead = `<p>${esc(t("join.lead", { hub: hubName() }))}</p>`;
    return page(reply, 200, t("join.title"), `${lead}${first}<details><summary>${esc(t("join.other"))}</summary>${rest}</details>`, t);
  });

  // The hub hands out the desktop app of its own version, from the project's GitHub releases.
  app.get("/download/desktop/:os", async (req, reply) => {
    const os = (req.params as { os: string }).os;
    if (os !== "windows" && os !== "macos") throw new HttpError(404, "not found");
    return reply.header("referrer-policy", "no-referrer").redirect(installerUrl(cfg.releasesRepo, cfg.version, os), 302);
  });
}

function desktopSection(t: (k: string, p?: Record<string, string | number>) => string, appLink: string, oses: ("windows" | "macos")[]): string {
  const name = { windows: "Windows", macos: "macOS" };
  const downloads = oses.map((os) => `<a class="secondary" href="/download/desktop/${os}" rel="noreferrer">${esc(t("join.desktop.download", { os: name[os] }))}</a>`).join("");
  return (
    `<section><h2>${esc(t("join.desktop.title"))}</h2><a class="button" href="${esc(appLink)}">${esc(t("join.desktop.open"))}</a>` +
    `<p class="muted">${esc(t("join.desktop.hint"))}</p>` +
    `<p><strong>${esc(t("join.desktop.noApp"))}</strong></p><p>${downloads}</p>` +
    `<p class="muted">${esc(t("join.desktop.signing"))}</p><p class="muted">${esc(t("join.desktop.again"))}</p></section>`
  );
}

function phoneSection(t: (k: string, p?: Record<string, string | number>) => string, phoneLink: string | undefined): string {
  if (!phoneLink) return `<section><h2>${esc(t("join.phone.title"))}</h2><p class="muted">${esc(t("join.phone.unreachable"))}</p></section>`;
  return `<section><h2>${esc(t("join.phone.title"))}</h2><a class="button" href="${esc(phoneLink)}">${esc(t("join.phone.open"))}</a><p class="muted">${esc(t("join.phone.hint"))}</p></section>`;
}

function page(reply: FastifyReply, status: number, title: string, body: string, t: (k: string) => string): FastifyReply {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="owl" aria-hidden="true">0_0</div><h1>${esc(title)}</h1>${body}<p class="muted">${esc(t("join.footer"))}</p></main></body></html>`;
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'")
    .header("referrer-policy", "no-referrer")
    .header("cache-control", "no-store")
    .send(html);
}
