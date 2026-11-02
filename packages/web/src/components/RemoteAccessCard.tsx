// Access from anywhere (remote.ts in the core), inside its library card: the steps from turning it on to the link.
// The hub runs its own Tailscale node; signing in to Tailscale and allowing Funnel happen on Tailscale's own pages.

import { useState, type ReactNode } from "react";
import { ExternalLink, QrCode } from "lucide-react";
import type { RemoteView } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { openExternal } from "../lib/external";
import { formatDateTime } from "../lib/format";
import { keyExpiresSoon, openedThroughLink, remoteStep } from "../lib/integrations";
import { setRemote, useRemote } from "../state/remote";
import { toast } from "../state/toast";
import { t } from "../i18n";
import { Button, CopyButton, ErrorNote, IconButton, Spinner } from "./ui";

const ADMIN_MACHINES = "https://login.tailscale.com/admin/machines";

export function RemoteAccessCard() {
  const view = useRemote();
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<"disable" | "forget">();
  const [qr, setQr] = useState(false);
  if (!view) return <Spinner />;
  const step = remoteStep(view);
  const run = async (action: "enable" | "disable" | "forget") => {
    setBusy(action);
    try {
      setRemote(await api.post<RemoteView>(`/api/remote/${action}`));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
      setConfirm(undefined);
    }
  };
  if (step === "unavailable") return null;
  if (step === "off")
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs leading-relaxed text-muted">{t("remote.intro")}</p>
        <div>
          <Button size="sm" variant="primary" loading={busy === "enable"} onClick={() => void run("enable")}>
            {t("remote.turnOn")}
          </Button>
        </div>
      </div>
    );

  const throughLink = openedThroughLink(view.url, location.host);
  return (
    <div className="flex flex-col gap-3">
      {step === "starting" && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> {t(view.preparing ? "remote.preparing" : "remote.starting")}
        </div>
      )}
      {step === "login" && (
        <Step text={t("remote.loginStep")}>
          {view.error ? (
            <p className="text-xs text-warning">{view.error}</p>
          ) : view.authUrl ? (
            <Button size="sm" variant="primary" icon={<ExternalLink className="size-4" />} onClick={() => openExternal(view.authUrl!)}>
              {t("remote.login")}
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-xs text-muted">
              <Spinner size={12} /> {t("remote.waitingUrl")}
            </span>
          )}
        </Step>
      )}
      {step === "funnel" && (
        <Step text={t("remote.funnelStep")}>
          {view.enableUrl && (
            <Button size="sm" variant="primary" icon={<ExternalLink className="size-4" />} onClick={() => openExternal(view.enableUrl!)}>
              {t("remote.allowFunnel")}
            </Button>
          )}
        </Step>
      )}
      {step === "error" && view.error && <ErrorNote>{view.error}</ErrorNote>}
      {step === "running" && view.url && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-code-bg py-1 pr-1 pl-3">
            <a href={view.url} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate font-mono text-[13px] hover:underline">
              {view.url}
            </a>
            <CopyButton text={view.url} label="" />
            <IconButton label={t("remote.qr")} active={qr} onClick={() => setQr((q) => !q)} className="size-8 shrink-0">
              <QrCode className="size-4" />
            </IconButton>
          </div>
          {qr && view.qrSvg && (
            <div
              className="size-[160px] rounded-2xl bg-white p-2.5 shadow-sm [&_svg]:block [&_svg]:size-full"
              // The SVG comes from our own hub (packages/core/src/pairing.ts) and only encodes the link above.
              dangerouslySetInnerHTML={{ __html: view.qrSvg }}
            />
          )}
          <p className="text-xs leading-relaxed text-muted">{t("remote.signInHint")}</p>
          {view.account && <p className="text-xs text-muted">{t("remote.account", { account: view.account })}</p>}
          {keyExpiresSoon(view.keyExpiry) && (
            <p className="text-xs leading-relaxed text-warning">
              {t("remote.expires", { date: formatDateTime(view.keyExpiry) })}{" "}
              <a href={ADMIN_MACHINES} target="_blank" rel="noopener" className="underline">
                {t("remote.adminMachines")}
              </a>
            </p>
          )}
        </div>
      )}

      {confirm ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm">
          <span>{t(confirm === "disable" ? "remote.turnOffConfirm" : "remote.forgetConfirm")}</span>
          {throughLink && <span className="text-xs text-warning">{t("remote.viaLink")}</span>}
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={!!busy} onClick={() => void run(confirm)}>
              {t(confirm === "disable" ? "remote.turnOff" : "remote.forget")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(undefined)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirm("disable")}>
            {t("remote.turnOff")}
          </Button>
          <Button size="sm" variant="ghost" className="text-muted" onClick={() => setConfirm("forget")}>
            {t("remote.forget")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Step({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-muted">{text}</p>
      <div>{children}</div>
    </div>
  );
}
