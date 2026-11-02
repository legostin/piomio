// One link for any device (packages/core/src/invites.ts): the /join link to forward to a computer or a phone, "This
// computer" when the web UI is open on another computer than the hub's, the line for a Linux server and the phone's QR.
// Used by the chat card the assistant shows and by Machines and Devices.

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Laptop, RefreshCw, Share2, SquareTerminal } from "lucide-react";
import type { Invite, InviteUsed } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { countdown } from "../lib/format";
import { onAnotherComputer, pairLink } from "../lib/desktop";
import { hubEvents } from "../state/app";
import { openPanelItem } from "../state/panel";
import { toast } from "../state/toast";
import { Badge, Button, CopyButton, ErrorNote, Spinner, cx } from "./ui";
import { t } from "../i18n";

/** Joins already announced in a toast: Machines and a chat card may both show one invite. */
const announced = new Set<string>();

export function joinedText(who: InviteUsed): string {
  return t(who.kind === "machine" ? "invite.joinedMachine" : "invite.joinedPhone", { name: who.name });
}

/**
 * Asks the hub for an invite when it opens and shows it until a device joins (then calls `onJoined`), it expires (a new
 * one on request) or the person cancels it.
 */
export function InviteBlock({ onJoined, onClose }: { onJoined?: (who: InviteUsed) => void; onClose?: () => void }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [server, setServer] = useState(false);

  const create = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setInvite(await api.post<Invite>("/api/invites"));
      setNow(Date.now());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // One invite per opening (StrictMode runs effects twice in development).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void create();
  }, [create]);

  const left = invite ? Math.max(0, Math.ceil((Date.parse(invite.expiresAt) - now) / 1000)) : 0;
  const expired = !!invite && left === 0;
  useEffect(() => {
    if (!invite || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [invite, expired]);

  useEffect(
    () =>
      hubEvents.on((e) => {
        // Access from anywhere came on while the card waited without a link: a new invite carries it.
        if (e.type === "remote.updated" && e.data.state === "running" && e.data.url && invite && !invite.url && !busy) {
          void api.del(`/api/invites/${encodeURIComponent(invite.code)}`).catch(() => {});
          void create();
          return;
        }
        if (e.type !== "invite.used" || !invite || e.data.code !== invite.code) return;
        if (!announced.has(e.data.code)) toast(joinedText(e.data), "success");
        announced.add(e.data.code);
        onJoined?.(e.data);
      }),
    [invite, busy, create, onJoined],
  );

  const cancel = async () => {
    if (invite && !expired) await api.del(`/api/invites/${encodeURIComponent(invite.code)}`).catch(() => {});
    onClose?.();
  };

  if (!invite) {
    if (error) return <ErrorNote onRetry={() => void create()}>{error}</ErrorNote>;
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> {t("common.loading")}
      </div>
    );
  }
  const share = typeof navigator.share === "function" && invite.url;
  return (
    <div className="flex flex-col gap-3">
      {invite.url ? (
        <div className={cx("flex flex-col gap-1.5", expired && "opacity-40")}>
          <p className="text-sm">{t("invite.forward")}</p>
          <div className="flex items-center gap-1 rounded-xl border border-border bg-code-bg py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={invite.url}>
              {invite.url}
            </code>
            {share && (
              <Button size="sm" variant="ghost" icon={<Share2 className="size-3.5" />} aria-label={t("invite.share")} onClick={() => void navigator.share({ url: invite.url }).catch(() => {})} />
            )}
            <CopyButton text={invite.url} className="shrink-0" />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 text-sm text-warning">{t("invite.unreachable")}</p>
          <Button size="sm" onClick={() => openPanelItem("plugins", "remote-access")}>
            {t("remote.devicesSetUp")}
          </Button>
        </div>
      )}
      {!expired && (onAnotherComputer(location.hostname, navigator.userAgent) || invite.serverCommand) && (
        <div className="flex flex-wrap gap-2">
          {onAnotherComputer(location.hostname, navigator.userAgent) && (
            <a
              href={pairLink(location.origin, invite.code)}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-surface px-2.5 text-[13px] font-medium hover:bg-surface-2"
            >
              <Laptop className="size-3.5" /> {t("invite.thisComputer")}
            </a>
          )}
          {invite.serverCommand && (
            <Button size="sm" variant={server ? "secondary" : "ghost"} icon={<SquareTerminal className="size-3.5" />} onClick={() => setServer((s) => !s)}>
              {t("invite.server")}
            </Button>
          )}
        </div>
      )}
      {!expired && server && invite.serverCommand && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs leading-relaxed text-muted">{t("invite.serverHint")}</p>
          <div className="flex items-start gap-1 rounded-xl border border-border bg-code-bg py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 py-1 font-mono text-[12.5px] break-all">{invite.serverCommand}</code>
            <CopyButton text={invite.serverCommand} className="shrink-0" />
          </div>
        </div>
      )}
      {invite.qrSvg && (
        <div className="flex items-center gap-3">
          <div
            role="img"
            aria-label={t("devices.qr")}
            className={cx("size-[120px] shrink-0 rounded-xl bg-white p-2 shadow-sm [&_svg]:block [&_svg]:size-full", expired && "opacity-25")}
            // The SVG comes from our own hub (packages/core/src/pairing.ts) and only encodes the phone's pairing link.
            dangerouslySetInnerHTML={{ __html: invite.qrSvg }}
          />
          <p className="text-xs leading-relaxed text-muted">{t("invite.qr")}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {expired ? <Badge tone="danger">{t("invite.expired")}</Badge> : <Badge tone="info">{t("invite.validFor", { time: countdown(left) })}</Badge>}
        {expired && (
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void create()}>
            {t("invite.new")}
          </Button>
        )}
        {onClose && (
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            {expired ? t("common.close") : t("invite.cancel")}
          </Button>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** What a finished invite leaves behind: who joined. */
export function Joined({ who }: { who: InviteUsed }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-success">
      <CircleCheck className="size-4 shrink-0" /> {joinedText(who)}
    </div>
  );
}
