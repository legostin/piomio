import type { MessagePart } from "@piomio/shared";
import { Globe } from "lucide-react";
import { ApprovalActions } from "./ApprovalActions";
import { t } from "../../i18n";

export function NetworkApprovalCard({ part }: { part: Extract<MessagePart, { type: "approval" }> }) {
  const ask = part.ask!;
  const pending = part.status === "pending";
  return (
    <section className="w-full max-w-md rounded-2xl border border-warning/35 bg-surface p-3.5 shadow-card" aria-label={t("message.network.title")}>
      <div className="flex items-center gap-2 text-sm font-semibold"><Globe className="size-4" />{t("message.network.title")}</div>
      <div className="mt-2 break-all font-mono text-sm">{ask.host}:{ask.port}</div>
      <div className="mt-2 text-xs text-muted">{t("message.network.agent", { agent: ask.agent ?? "" })}</div>
      {ask.task && <div className="mt-1 break-words text-xs text-muted">{t("message.network.task", { task: ask.task })}</div>}
      <p className="mt-2 text-xs text-muted">{t("message.network.scope")}</p>
      <p className="mt-1 text-xs text-muted">{t("message.network.always")}</p>
      {ask.ipLiteral && <p role="note" className="mt-2 text-xs font-medium text-warning">{t("message.network.ip")}</p>}
      {pending ? <ApprovalActions approvalId={part.approvalId} network /> : <div className="mt-2 text-sm">{t(`approvalStatus.${part.status}`)}</div>}
    </section>
  );
}
