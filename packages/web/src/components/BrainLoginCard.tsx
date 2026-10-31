// Signing Claude Code or Codex in from the chat: the sign-in page to open, the one-time code to type there (or a field
// for the code the page shows) and the live state from the hub. No terminal; the login stays on the server.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink, LogIn, CheckCircle2 } from "lucide-react";
import type { BrainLoginView } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { formatTime } from "../lib/format";
import { openOutside } from "../lib/native";
import { hubEvents } from "../state/app";
import { Badge, Button, CopyButton, Input, Spinner, cx } from "./ui";
import { t } from "../i18n";

const RUNNING = new Set(["installing", "starting", "waiting", "verifying"]);

/**
 * One brain's sign-in. `compact`: a row (name, state, button) for lists like the setup card;
 * `bare`: no frame, for a card that already has one; otherwise a card in the conversation.
 * `install`: the CLI is not on this computer yet and the hub installs it before the sign-in.
 */
export function BrainLoginCard({ brainRef, bare, compact, install }: { brainRef: string; bare?: boolean; compact?: boolean; install?: boolean }) {
  const [view, setView] = useState<BrainLoginView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = `?ref=${encodeURIComponent(brainRef)}`;
  const load = useCallback(() => {
    api.get<BrainLoginView>(`/api/brains/login${query}`).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, [query]);
  useEffect(() => {
    load();
    return hubEvents.on((e) => {
      if (e.type === "brain.login") setView((v) => (v && v.ref === e.data.ref ? { ...v, login: e.data } : v));
      if (e.type === "brains.updated" || e.type === "plugins.updated") load();
    });
  }, [load]);

  const act = async (path: string, body: Record<string, unknown> = {}): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.post<BrainLoginView>(`/api/brains/login${path}`, { ref: brainRef, ...body }));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!view) return error ? <div className="my-2 text-sm text-danger">{error}</div> : <Spinner />;
  const login = view.login;
  const running = !!login && RUNNING.has(login.status);
  const signedIn = !running && !!view.probe?.authenticated;
  const ended = !running && login ? login : undefined;

  const badge = !view.connected ? (
    <Badge tone="neutral">{t("brainLogin.notConnected")}</Badge>
  ) : running ? (
    <Badge tone="info">{t("brainLogin.inProgress")}</Badge>
  ) : signedIn ? (
    <Badge tone="success">{t("brainLogin.signedIn")}</Badge>
  ) : install ? (
    <Badge tone="neutral">{t("brainSetup.notInstalledBadge")}</Badge>
  ) : (
    <Badge tone="warning">{t("brainLogin.notSignedIn")}</Badge>
  );
  const canStart = view.connected && view.supported && !running;
  const startButton = canStart && (!signedIn || !compact) && (
    <Button variant={signedIn ? "ghost" : "primary"} size="sm" icon={<LogIn className="size-3.5" />} loading={busy} onClick={() => void act("")}>
      {signedIn
        ? t("brainLogin.signInAgain")
        : ended && ended.status !== "cancelled" && ended.status !== "succeeded"
          ? t("brainLogin.tryAgain")
          : install
            ? t("brainSetup.installAndSignIn")
            : t("brainLogin.signIn")}
    </Button>
  );

  const body = (
    <>
      {view.connected && !view.supported && <div className="text-sm text-muted">{t("brainLogin.unsupported")}</div>}
      {!compact && canStart && !signedIn && !ended && <div className="text-sm text-muted">{t("brainLogin.hint")}</div>}
      {running && login && <Running login={login} label={view.label} busy={busy} onCode={(code) => act("/code", { code })} onCancel={() => void act("/cancel")} />}
      {ended?.status === "succeeded" && signedIn && <div className="text-sm text-success">{t("brainLogin.done")}</div>}
      {ended && (ended.status === "failed" || ended.status === "expired") && <div className="text-sm text-danger">{ended.error ?? t("brainLogin.failed")}</div>}
      {ended?.status === "cancelled" && !signedIn && <div className="text-sm text-muted">{t("brainLogin.cancelled")}</div>}
      {signedIn && !compact && !ended && view.probe?.detail && <div className="text-sm text-muted">{view.probe.detail}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
    </>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{view.label}</span>
          {badge}
          <span className="flex-1" />
          {startButton}
        </div>
        {body}
      </div>
    );
  }
  // Signed in from the chat: one locked line, like any form that is done.
  if (!bare && signedIn && !running) {
    return (
      <div className="animate-in my-2 flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-3 py-2">
        <CheckCircle2 className="size-4 text-success" />
        <span className="text-sm font-medium">{t("brainLogin.locked", { name: view.label })}</span>
      </div>
    );
  }
  // Bare and signed in: "Sign in again" is a quiet button at the end of the status line, not a line of its own.
  const inRow = bare && signedIn;
  return (
    <div className={cx("flex flex-col gap-2.5", !bare && "my-2 rounded-xl border px-3 py-2.5", !bare && (running ? "border-accent/35 bg-accent-soft/40" : "border-border bg-surface-2/50"))}>
      {/* Bare: the surrounding card already names the brain. */}
      <div className="flex flex-wrap items-center gap-2">
        {!bare && <LogIn className={cx("size-4", running ? "text-accent-text" : "text-muted")} />}
        {!bare && <span className="text-sm font-semibold">{t("brainLogin.title", { name: view.label })}</span>}
        {badge}
        {inRow && startButton && (
          <>
            <span className="flex-1" />
            {startButton}
          </>
        )}
      </div>
      {body}
      {startButton && !inRow && <div>{startButton}</div>}
    </div>
  );
}

function Running({ login, label, busy, onCode, onCancel }: { login: NonNullable<BrainLoginView["login"]>; label: string; busy: boolean; onCode: (code: string) => Promise<boolean>; onCancel: () => void }) {
  if (login.status === "installing") {
    // The hub installs the missing CLI first (desktop installs); the sign-in goes on by itself afterwards.
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> {t("brainLogin.installing", { name: label })}
        </div>
        <div>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("brainLogin.cancel")}
          </Button>
        </div>
      </div>
    );
  }
  if (login.status === "starting" || !login.url) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> {t("brainLogin.starting")}
      </div>
    );
  }
  const verifying = login.status === "verifying";
  return (
    <div className="flex flex-col gap-2.5">
      <ol className="flex flex-col gap-2.5 text-sm">
        <Step n={1} text={login.needsCode ? t("brainLogin.openAndSignIn") : t("brainLogin.openStep")}>
          <a
            href={login.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => openOutside(e, login.url)}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-accent px-2.5 text-[13px] font-medium whitespace-nowrap text-accent-fg shadow-sm transition hover:brightness-110"
          >
            {t("brainLogin.open")} <ExternalLink className="size-3.5" />
          </a>
        </Step>
        {login.userCode && (
          <Step n={2} text={t("brainLogin.codeStep")}>
            <span className="inline-flex items-center gap-1">
              <code className="rounded-lg border border-border bg-code-bg px-2.5 py-1 font-mono text-base font-semibold tracking-widest select-all">{login.userCode}</code>
              <CopyButton text={login.userCode} />
            </span>
          </Step>
        )}
        {login.needsCode && (
          <Step n={2} text={t("brainLogin.pasteStep")}>
            <CodeForm disabled={verifying || busy} onSubmit={onCode} />
          </Step>
        )}
      </ol>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <Spinner size={14} />
        <span>{verifying ? t("brainLogin.verifying") : t("brainLogin.waiting")}</span>
        {login.expiresAt && !verifying && <span>· {t(login.userCode ? "brainLogin.validUntil" : "brainLogin.finishBy", { time: formatTime(login.expiresAt) })}</span>}
      </div>
      {login.userCode && <div className="text-xs text-muted">{t("brainLogin.phishing")}</div>}
      {!verifying && (
        <div>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("brainLogin.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Step({ n, text, children }: { n: number; text: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted">{n}</span>
        <span>{text}</span>
      </div>
      <div className="pl-7">{children}</div>
    </li>
  );
}

/** The code the sign-in page shows: it goes to the CLI on the server, never into the conversation. */
function CodeForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (code: string) => Promise<boolean> }) {
  const [code, setCode] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || disabled) return;
    if (await onSubmit(code.trim())) setCode("");
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t("brainLogin.pastePlaceholder")}
        aria-label={t("brainLogin.pastePlaceholder")}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        data-1p-ignore=""
        data-lpignore="true"
        disabled={disabled}
        className="h-9 min-w-0 flex-1 basis-56 font-mono"
      />
      <Button type="submit" variant="primary" size="sm" loading={disabled} disabled={!code.trim()}>
        {t("brainLogin.submit")}
      </Button>
    </form>
  );
}
