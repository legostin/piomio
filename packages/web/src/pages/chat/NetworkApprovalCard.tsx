import type { MessagePart } from "@piomio/shared";
import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { ApprovalActions } from "./ApprovalActions";
import { t } from "../../i18n";
import { api, errorText } from "../../lib/api";
import { Button } from "../../components/ui";

export function NetworkApprovalCard({ part }: { part: Extract<MessagePart, { type: "approval" }> }) {
  const ask = part.ask!;
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deadline = ask.networkExpiresAt ? Date.parse(ask.networkExpiresAt) : undefined;
  const seconds = deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now) / 1000));
  const pending = part.status === "pending" && (seconds === undefined || seconds > 0);
  const status = part.status === "pending" && !pending ? "expired" : part.status;
  useEffect(() => {
    if (!pending || deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending, deadline]);
  const retry = async () => {
    setRetrying(true); setError(null);
    try { await api.post(`/api/approvals/${encodeURIComponent(part.approvalId)}/network-retry`, {}); setRequested(true); }
    catch (e) { setError(errorText(e)); }
    finally { setRetrying(false); }
  };
  return (
    <section className="w-full max-w-md rounded-2xl border border-warning/35 bg-surface p-3.5 shadow-card" aria-label={t("message.network.title")}>
      <div className="flex items-center gap-2 text-sm font-semibold"><Globe className="size-4" />{t("message.network.title")}</div>
      <div className="mt-2 break-all font-mono text-sm">{ask.host}:{ask.port}</div>
      <div className="mt-2 text-xs text-muted">{t("message.network.agent", { agent: ask.agent ?? "" })}</div>
      {ask.task && <div className="mt-1 break-words text-xs text-muted">{t("message.network.task", { task: ask.task })}</div>}
      <p className="mt-2 text-xs text-muted">{t("message.network.scope")}</p>
      {pending && seconds !== undefined && <p className="mt-1 text-xs text-muted" role="timer">{t("message.network.remaining", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })}</p>}
      <p className="mt-1 text-xs text-muted">{t(ask.listed ? "message.network.listed" : "message.network.always")}</p>
      {ask.ipLiteral && <p role="note" className="mt-2 text-xs font-medium text-warning">{t("message.network.ip")}</p>}
      {pending ? <ApprovalActions approvalId={part.approvalId} network always={!ask.listed} /> : <div className="mt-2 text-sm">{t(`approvalStatus.${status}`)}</div>}
      {status === "expired" && <p className="mt-1 text-xs text-muted">{t(ask.networkClosedReason === "connection_closed" ? "message.network.disconnected" : ask.networkClosedReason === "session_ended" ? "message.network.sessionEnded" : ask.networkClosedReason === "timeout" || (part.status === "pending" && !pending) ? "message.network.timedOut" : "message.network.expired")}</p>}
      {["expired", "denied"].includes(status) && (
        requested || ask.networkRetryRequestedAt
          ? <p className="mt-2 text-xs text-muted">{t("message.network.retryRequested")}</p>
          : <div className="mt-2"><p className="mb-2 text-xs text-muted">{t("message.network.retryHint")}</p><Button variant="secondary" loading={retrying} disabled={retrying} onClick={() => void retry()}>{t("message.network.retry")}</Button></div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
