// Machines: connected piomio-node daemons, pairing, rename, revoke.

import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Check, Laptop, Link2, Pencil, Server, SlidersHorizontal, Star, Trash2, X } from "lucide-react";
import type { Machine, MachineSetupView, ReplicaState } from "@piomio/shared";
import { askInChat } from "../state/ask";
import { api, errorText } from "../lib/api";
import { relativeTime } from "../lib/format";
import { hubEvents } from "../state/app";
import { toast } from "../state/toast";
import { t, tRich } from "../i18n";
import { Badge, Button, EmptyState, ErrorNote, IconButton, Input, Loading, Modal, Page } from "../components/ui";
import { InviteBlock } from "../components/Invite";

export function MachinesPage() {
  const [list, setList] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string>();
  const [pairOpen, setPairOpen] = useState(false);
  const [revoking, setRevoking] = useState<Machine | null>(null);
  const [setups, setSetups] = useState<Record<string, MachineSetupView>>({});
  const [replicas, setReplicas] = useState<ReplicaState[]>([]);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setList(await api.get<Machine[]>("/api/machines"));
      const views = await api.get<MachineSetupView[]>("/api/machines/setups").catch(() => []);
      setSetups(Object.fromEntries(views.map((v) => [v.machineId, v])));
      setReplicas(await api.get<ReplicaState[]>("/api/cluster").catch(() => []));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return hubEvents.on((e) => {
      if (e.type === "machine.updated" || e.type === "machine.setup" || e.type === "machine.spend" || e.type === "cluster.updated") void load();
    });
  }, [load]);

  return (
    <Page
      title={t("nav.machines")}
      subtitle={t("machines.subtitle")}
      actions={
        <Button variant="primary" icon={<Link2 className="size-4" />} onClick={() => setPairOpen(true)}>
          {t("machines.pair")}
        </Button>
      }
    >
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {replicas.length > 1 && <ClusterLine replicas={replicas} onChanged={setReplicas} />}
      {list && list.length === 0 && <EmptyState icon="laptop" title={t("machines.empty")} hint={t("machines.emptyHint")} />}
      <div className="grid gap-3 md:grid-cols-2">
        {list?.map((m) => (
          <MachineCard key={m.id} m={m} setup={setups[m.id]} onChanged={load} onRevoke={() => setRevoking(m)} />
        ))}
      </div>

      {pairOpen && <PairModal onClose={() => setPairOpen(false)} />}
      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={t("machines.revokeTitle", { name: revoking?.name })}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const m = revoking!;
                setRevoking(null);
                try {
                  await api.del(`/api/machines/${encodeURIComponent(m.id)}`);
                  toast(t("machines.revoked"), "success");
                  await load();
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              {t("machines.revoke")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("machines.revokeText")}</p>
      </Modal>
    </Page>
  );
}

/**
 * Where the hub itself lives: one quiet line, who leads now and which replica is the primary (a filled star). The
 * others' outlined star makes that one the primary: the same as "keep the hub on …" in the chat.
 */
function ClusterLine({ replicas, onChanged }: { replicas: ReplicaState[]; onChanged: (next: ReplicaState[]) => void }) {
  const makePrimary = async (r: ReplicaState) => {
    try {
      onChanged(await api.post<ReplicaState[]>("/api/cluster/primary", { replica: r.id }));
      toast(t("cluster.primarySet", { name: r.name }), "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-2.5 text-sm shadow-card">
      <Server className="size-4 text-muted" />
      <span className="text-muted">{t("cluster.title")}</span>
      {replicas.map((r) => (
        <span key={r.id} className="inline-flex items-center gap-0.5">
          <Badge tone={!r.online ? "neutral" : r.role === "leader" ? "success" : "info"} dot>
            {r.name} · {!r.online ? t("cluster.offline") : r.role === "leader" ? t("cluster.leader") : t("cluster.standby")}
            {r.online && r.sealed ? ` · ${t("cluster.sealed")}` : ""}
          </Badge>
          {r.primary ? (
            <span role="img" aria-label={t("cluster.primary")} title={t("cluster.primary")} className="mx-1 inline-flex">
              <Star className="size-3.5 fill-current text-accent-text" />
            </span>
          ) : (
            <IconButton label={t("cluster.makePrimary", { name: r.name })} onClick={() => void makePrimary(r)} className="size-7">
              <Star className="size-3.5" />
            </IconButton>
          )}
        </span>
      ))}
    </div>
  );
}

/** What the machine's brains may use, in one line: sign-in, models, the limit and the spend. */
function setupLine(v: MachineSetupView | undefined): string | undefined {
  if (!v) return undefined;
  const brains = Object.entries(v.settings.brains).map(([id, b]) => {
    const how = b!.auth === "key" ? t("machines.setup.key", { providers: (b!.providers ?? []).join(", ") }) : t("machines.setup.subscription");
    const models = b!.models?.length ? ` · ${b!.models.map((m) => m.id).join(", ")}` : "";
    return `${id}: ${how}${models}`;
  });
  const limit = v.settings.limit
    ? t(v.settings.limit.period === "day" ? "machines.setup.limitDay" : "machines.setup.limitMonth", { spent: v.spent.usd.toFixed(2), usd: v.settings.limit.usd })
    : v.spent.usd > 0
      ? t("machines.setup.spent", { spent: v.spent.usd.toFixed(2) })
      : "";
  const parts = [...brains, limit].filter(Boolean);
  return parts.length ? parts.join(" — ") : undefined;
}

function MachineCard({ m, setup, onChanged, onRevoke }: { m: Machine; setup?: MachineSetupView; onChanged: () => Promise<void>; onRevoke: () => void }) {
  const [, navigate] = useLocation();
  const line = setupLine(setup);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(m.name);
  const online = m.status === "online";
  const save = async () => {
    setEditing(false);
    if (!name.trim() || name.trim() === m.name) return setName(m.name);
    try {
      await api.patch(`/api/machines/${encodeURIComponent(m.id)}`, { name: name.trim() });
      await onChanged();
    } catch (e) {
      toast(errorText(e), "error");
      setName(m.name);
    }
  };
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Laptop className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-8" maxLength={60} />
              <IconButton label={t("common.save")} onClick={() => void save()} className="size-8 shrink-0">
                <Check className="size-4" />
              </IconButton>
              <IconButton
                label={t("common.cancel")}
                onClick={() => {
                  setEditing(false);
                  setName(m.name);
                }}
                className="size-8 shrink-0"
              >
                <X className="size-4" />
              </IconButton>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{m.name}</span>
              <Badge tone={online ? "success" : "neutral"} dot>
                {online ? t("machines.online") : t("machines.offline")}
              </Badge>
              <IconButton label={t("common.rename")} onClick={() => setEditing(true)} className="size-7">
                <Pencil className="size-3.5" />
              </IconButton>
            </div>
          )}
          <div className="mt-0.5 text-xs text-muted">
            {m.info ? `${m.info.os} · ${m.info.arch} · ${m.info.hostname}` : t("machines.noInfo")}
            {m.info?.nodeVersion && ` · node ${m.info.nodeVersion}`}
          </div>
          <div className="text-xs text-muted">
            {online ? t("machines.connected") : m.lastSeenAt ? t("machines.lastSeen", { time: relativeTime(m.lastSeenAt) }) : t("machines.neverConnected")}
          </div>
        </div>
      </div>
      {m.info?.clis && m.info.clis.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {m.info.clis.map((c) => (
            <Badge key={c.brainId} tone={c.authenticated ? "success" : c.available ? "warning" : "neutral"}>
              {c.brainId}
              {c.version ? ` ${c.version}` : ""}
              {!c.available ? ` — ${t("machines.cliMissing")}` : !c.authenticated ? ` — ${t("machines.cliNeedsLogin")}` : ""}
            </Badge>
          ))}
        </div>
      )}
      {m.info?.allowedDirs && m.info.allowedDirs.length > 0 && (
        <div className="mt-2 text-xs text-muted">
          {tRich("machines.folders", { list: <span className="font-mono">{m.info.allowedDirs.join(", ")}</span> })}
        </div>
      )}
      {line && <div className="mt-2 text-xs text-muted">{line}</div>}
      <div className="mt-3 flex justify-end gap-1">
        <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="size-3.5" />} onClick={() => void askInChat(undefined, t("machines.setupAsk", { name: m.name }), navigate)}>
          {t("machines.setup.open")}
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onRevoke}>
          {t("machines.revoke")}
        </Button>
      </div>
    </div>
  );
}

/** Connecting a computer: one link, forwarded to it or opened there (components/Invite.tsx). */
function PairModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={t("machines.pair")}>
      <InviteBlock onJoined={onClose} onClose={onClose} />
    </Modal>
  );
}
