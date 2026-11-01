// The /archive command's card (an `agent_archive` part): what the archive does to the agent, who becomes the main
// agent when it is the default one, and the button; once it is in the archive, Restore. The archive itself is the
// hub's (POST /api/agents/:id/archive, docs/superpowers/specs/2026-11-01-agent-archive-design.md).

import { useEffect, useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { useStore } from "../../lib/store";
import { agents, ensureAgents, refreshAgents, session } from "../../state/app";
import { toast } from "../../state/toast";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Button, cx } from "../../components/ui";
import { t } from "../../i18n";

export function ArchiveCard({ agentId }: { agentId: string }) {
  const team = useStore(agents);
  const boot = useStore(session);
  const [successor, setSuccessor] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => ensureAgents(), []);
  const agent = team?.find((a) => a.id === agentId);
  if (!team) return <div className="my-2 h-32 max-w-md animate-pulse rounded-2xl bg-surface-2" />;
  if (!agent) return <div className="my-2 max-w-md rounded-2xl border border-dashed border-border px-3 py-2.5 text-sm text-muted">{t("thinking.gone")}</div>;

  const isDefault = boot?.defaultAgent === agent.id;
  // Who can take over as the main agent: an active agent other than this one.
  const others = team.filter((a) => a.id !== agent.id && !a.archived);
  const archived = !!agent.archived;
  const set = async (to: boolean) => {
    setBusy(true);
    try {
      await api.post(`/api/agents/${encodeURIComponent(agent.id)}/archive`, { archived: to, ...(to && isDefault && successor ? { successor } : {}) });
      await refreshAgents();
      toast(t(to ? "archiveCard.done" : "archiveCard.restored", { agent: agent.name }), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-card sm:max-w-md">
      <div className="flex items-start gap-3 p-3">
        <AgentAvatar avatar={agent.avatar} id={agent.id} name={agent.name} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{t(archived ? "archiveCard.inArchive" : "archiveCard.title", { agent: agent.name })}</span>
          <span className="block text-[13px] text-muted">{t(archived ? "archiveCard.restoreHint" : "archiveCard.hint")}</span>
        </span>
      </div>
      {!archived && isDefault && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="text-sm font-medium">{t("archiveCard.successor")}</div>
          {others.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {others.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setSuccessor(a.id)}
                  className={cx(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border pr-3 pl-1 text-xs font-medium transition disabled:opacity-60",
                    successor === a.id ? "border-accent bg-accent text-accent-fg" : "border-border text-muted hover:border-fg/30 hover:text-fg",
                  )}
                >
                  <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={22} />
                  {a.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-[13px] text-muted">{t("archiveCard.nobody")}</div>
          )}
        </div>
      )}
      <div className="flex justify-end border-t border-border px-3 py-2.5">
        {archived ? (
          <Button size="sm" loading={busy} icon={<ArchiveRestore className="size-4" />} onClick={() => void set(false)}>
            {t("archiveCard.restore")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" loading={busy} disabled={isDefault && !successor} icon={<Archive className="size-4" />} onClick={() => void set(true)}>
            {t("archiveCard.archive")}
          </Button>
        )}
      </div>
    </div>
  );
}
