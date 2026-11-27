import { useState } from "react";
import { api, errorText } from "../../lib/api";
import { Button } from "../../components/ui";
import { t } from "../../i18n";

/** The card's buttons, as in any agent: allow once, allow always (a rule from the card) unless there is none to make, or deny. */
export function ApprovalActions({ approvalId, network = false, always = true }: { approvalId: string; network?: boolean; always?: boolean }) {
  const [busy, setBusy] = useState<"approve" | "always" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (kind: "approve" | "always" | "deny") => {
    setBusy(kind);
    setError(null);
    try {
      await api.post(`/api/approvals/${encodeURIComponent(approvalId)}`, { decision: kind === "deny" ? "deny" : "approve", remember: kind === "always" });
    } catch (e) {
      setError(t("message.approval.failed", { error: errorText(e) }));
      setBusy(null);
    }
  };
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" loading={busy === "approve"} disabled={busy !== null} onClick={() => void answer("approve")}>
          {t(network ? "message.network.once" : "message.approval.approve")}
        </Button>
        <Button variant="secondary" className="flex-1" loading={busy === "deny"} disabled={busy !== null} onClick={() => void answer("deny")}>
          {t("message.approval.deny")}
        </Button>
      </div>
      {always && (
        <button
          type="button"
          className="self-center px-2 py-1 text-xs font-medium text-muted hover:text-fg disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => void answer("always")}
        >
          {t("message.approval.always")}
        </button>
      )}
      {error && (
        <div className="text-xs break-words text-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}


/**
 * "Allow" on an action auto mode stopped: the agent hears it may try again. A call goes through once, when the agent
 * runs it again; a network host is open to that session from then on.
 */
export function AllowStopped({ approvalId }: { approvalId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/approvals/${encodeURIComponent(approvalId)}`, { decision: "approve" });
    } catch (e) {
      setError(t("message.approval.failed", { error: errorText(e) }));
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <Button variant="secondary" loading={busy} disabled={busy} onClick={() => void allow()}>
        {t("message.approval.approve")}
      </Button>
      {error && (
        <div className="text-xs break-words text-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
