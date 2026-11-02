// The server guide (/<lang>/server/): the hub on a Linux server, or the server as a computer of the hub you have,
// with install.sh; signing in to a CLI there; opening the chat; why not by the server's IP; what to check when stuck;
// Docker, for the strongest isolation.
// The README's "On a server, step by step" says the same.

import type { ReactNode } from "react";
import { siteConfig } from "../../site.config";
import { useI18n, type MessageKey } from "../i18n";
import { CopyBlock } from "../components/CopyBlock";
import { Rich } from "../components/Rich";
import { ArrowRight, ChevronDown, Laptop, Server } from "../components/icons";

const REPO = `https://github.com/${siteConfig.repo}`;
const HUB = ["install", "signin", "open", "anywhere", "update"] as const;
const COMPUTER = ["reach", "invite", "run", "signin", "policy"] as const;
const TROUBLE = [1, 2, 3, 4] as const;

function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-16 scroll-mt-24 sm:mt-20">
      <h2 className="font-display text-[clamp(1.6rem,3vw,2.2rem)] leading-[1.1] font-extrabold tracking-[-0.02em] text-balance">{title}</h2>
      {children}
    </section>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-8 flex flex-col gap-9">{children}</ol>;
}

function Step({ n, title, text, code, more }: { n: number; title: string; text: string; code?: string; more?: string }) {
  return (
    <li className="flex gap-4">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft font-display text-[14px] font-bold text-accent-text">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-3.5 pt-0.5">
        <h3 className="font-display text-[19px] leading-tight font-bold tracking-[-0.01em]">{title}</h3>
        <p className="text-[16px] leading-relaxed text-fg-2 text-pretty">
          <Rich text={text} />
        </p>
        {code && <CopyBlock code={code} />}
        {more && (
          <p className="text-[15px] leading-relaxed text-fg-2 text-pretty">
            <Rich text={more} />
          </p>
        )}
      </div>
    </li>
  );
}

function Commands({ title, rows }: { title: string; rows: Array<[string, MessageKey]> }) {
  const { t } = useI18n();
  return (
    <div className="mt-10 rounded-[22px] bg-surface p-5 shadow-[var(--shadow)] sm:p-6">
      <h3 className="text-[15px] font-semibold text-fg">
        <Rich text={title} />
      </h3>
      <dl className="mt-3 flex flex-col">
        {rows.map(([cmd, key]) => (
          <div key={cmd} className="flex flex-col gap-1 border-t border-hairline py-2.5 first:border-t-0 sm:flex-row sm:items-baseline sm:gap-5">
            <dt className="shrink-0 font-mono text-[13px] text-fg sm:w-[17rem]">{cmd}</dt>
            <dd className="text-[14.5px] leading-snug text-fg-2">
              <Rich text={t(key)} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ServerGuide() {
  const { t } = useI18n();
  const install = `curl -fsSL ${siteConfig.installScript} | sh`;
  const ip = t("server.ph.ip");
  const signIn = "sudo -iu piomio\ncurl -fsSL https://chatgpt.com/codex/install.sh | sh\ncodex login --device-auth";
  const codes: Partial<Record<string, string>> = {
    "hub.install": install,
    "hub.signin": signIn,
    "hub.open": `ssh -N -L 8080:localhost:8080 -L 8081:localhost:8081 root@<${ip}>`,
    "computer.run": `curl -fsSL ${siteConfig.installScript} | PIOMIO_NAME=vps sh -s -- ${t("server.ph.link")}`,
  };
  const more: Partial<Record<string, MessageKey>> = { "hub.signin": "server.hub.signin.more", "hub.open": "server.hub.open.more" };
  const ways: Array<[string, ReactNode, MessageKey, MessageKey]> = [
    ["#hub", <Server size={22} />, "server.way.hub.title", "server.way.hub.text"],
    ["#computer", <Laptop size={22} />, "server.way.computer.title", "server.way.computer.text"],
  ];
  return (
    <article className="mx-auto max-w-[52rem] px-4 pt-12 pb-24 sm:px-6 sm:pt-16">
      <header>
        <p className="text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">{t("server.eyebrow")}</p>
        <h1 className="mt-3 font-display text-[clamp(2.1rem,4.6vw,3.4rem)] leading-[1.04] font-extrabold tracking-[-0.025em] text-balance">{t("server.title")}</h1>
        <p className="mt-5 text-[18px] leading-relaxed text-fg-2 text-pretty">{t("server.lead")}</p>
        <p className="mt-4 text-[15px] leading-relaxed text-muted text-pretty">
          <Rich text={t("server.needs", { docker: "#docker" })} />
        </p>
      </header>

      <nav className="mt-10 grid gap-3 sm:grid-cols-2" aria-label={t("server.choose")}>
        {ways.map(([href, icon, title, text]) => (
          <a key={href} href={href} className="group flex flex-col rounded-[22px] bg-surface p-5 shadow-[var(--shadow)] transition-transform hover:-translate-y-0.5 sm:p-6">
            <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent-text">{icon}</span>
            <span className="mt-4 flex items-center gap-2 font-display text-[19px] font-bold tracking-[-0.01em]">
              {t(title)}
              <ArrowRight size={16} className="text-muted transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="mt-2 text-[15px] leading-relaxed text-fg-2">{t(text)}</span>
          </a>
        ))}
      </nav>

      <Part id="hub" title={t("server.hub.title")}>
        <Steps>
          {HUB.map((k, i) => (
            <Step key={k} n={i + 1} title={t(`server.hub.${k}.title`)} text={t(`server.hub.${k}.text`)} code={codes[`hub.${k}`]} more={more[`hub.${k}`] && t(more[`hub.${k}`]!)} />
          ))}
        </Steps>
        <Commands
          title={t("server.commands")}
          rows={[
            ["piomio version", "server.cmd.version"],
            ["piomio backup", "server.cmd.backup"],
            ["piomio reset-password <…>", "server.cmd.password"],
            ["piomio devices pair", "server.cmd.phone"],
            ["systemctl --user restart piomio", "server.cmd.restart"],
            ["journalctl --user -u piomio -f", "server.cmd.log"],
            ["piomio uninstall", "server.cmd.uninstall"],
          ]}
        />
      </Part>

      <Part id="computer" title={t("server.computer.title")}>
        <Steps>
          {COMPUTER.map((k, i) => (
            <Step key={k} n={i + 1} title={t(`server.computer.${k}.title`)} text={t(`server.computer.${k}.text`)} code={codes[`computer.${k}`]} />
          ))}
        </Steps>
        <Commands
          title={t("server.commands")}
          rows={[
            ["piomio-node status", "server.cmd.status"],
            ["journalctl --user -u piomio-node -f", "server.cmd.log"],
            ["piomio-node uninstall", "server.cmd.nodeUninstall"],
          ]}
        />
      </Part>

      <Part id="address" title={t("server.address.title")}>
        <div className="mt-6 flex flex-col gap-4 text-[16px] leading-relaxed text-fg-2 text-pretty">
          <p>
            <Rich text={t("server.address.lead")} />
          </p>
          <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-accent">
            {(["http", "passkeys", "console"] as const).map((k) => (
              <li key={k}>
                <Rich text={t(`server.address.${k}`)} />
              </li>
            ))}
          </ul>
          <p>
            <Rich text={t("server.address.safe", { proxy: `${REPO}#your-own-proxy` })} />
          </p>
          <p>
            <Rich text={t("server.address.bare")} />
          </p>
          <CopyBlock code={`PIOMIO_HOST=0.0.0.0\nPIOMIO_PUBLIC_URL=http://<${ip}>:8080`} />
          <p>
            <Rich text={t("server.address.bareThen")} />
          </p>
        </div>
      </Part>

      <Part id="trouble" title={t("server.trouble.title")}>
        <div className="mt-6 flex flex-col gap-2.5">
          {TROUBLE.map((n) => (
            <details key={n} className="group rounded-2xl bg-surface shadow-[var(--shadow)]">
              <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 text-[16px] leading-snug font-semibold [&::-webkit-details-marker]:hidden">
                <span>
                  <Rich text={t(`server.trouble.q${n}`)} />
                </span>
                <ChevronDown size={18} className="ml-auto shrink-0 text-muted transition-transform group-open:rotate-180" />
              </summary>
              <p className="-mt-1 px-5 pb-5 text-[15.5px] leading-relaxed text-fg-2 text-pretty">
                <Rich text={t(`server.trouble.a${n}`)} />
              </p>
            </details>
          ))}
        </div>
      </Part>

      <Part id="docker" title={t("server.docker.title")}>
        <div className="mt-6 flex flex-col gap-4 text-[16px] leading-relaxed text-fg-2 text-pretty">
          <p>
            <Rich text={t("server.docker.text")} />
          </p>
          <CopyBlock code={`git clone ${REPO}.git && cd piomio\ndocker compose up -d\ndocker compose logs piomio | grep -A1 "Piomio:"`} />
          <p>
            <Rich text={t("server.docker.more", { env: `${REPO}/blob/main/.env.example` })} />
          </p>
        </div>
      </Part>
    </article>
  );
}
