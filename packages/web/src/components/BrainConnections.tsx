// One brain's own connections (Brains page): what the person connected in Claude Code or Codex itself, each with a
// switch for the agents thinking with that brain on that computer. The CLI is asked when the list opens.

import { useCallback, useEffect, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import type { BrainConnectionView } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import type { Tone } from "../lib/format";
import { Badge, Button, ErrorNote, Loading, Toggle } from "./ui";

interface Listing {
  ref: string;
  connections: BrainConnectionView[];
  supported: boolean;
}

const STATUS: Record<BrainConnectionView["status"], { label: MessageKey; tone: Tone } | undefined> = {
  connected: { label: "brainConnections.status.connected", tone: "success" },
  signin: { label: "brainConnections.status.signin", tone: "warning" },
  failed: { label: "brainConnections.status.failed", tone: "danger" },
  off: { label: "brainConnections.status.off", tone: "neutral" },
  unknown: undefined,
};

const SOURCE: Record<BrainConnectionView["source"], MessageKey> = {
  config: "brainConnections.source.config",
  plugin: "brainConnections.source.plugin",
  account: "brainConnections.source.account",
};

/** A brain whose CLI can have connections of its own. */
export function hasOwnConnections(ref: string): boolean {
  return /^(claude-code|codex)@/.test(ref);
}

export function BrainConnectionsPanel({ brainRef }: { brainRef: string }) {
  const [list, setList] = useState<Listing | null>(null);
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState<string>();

  const load = useCallback(
    async (refresh = false) => {
      setError(undefined);
      try {
        setList(await api.get<Listing>(`/api/brains/connections?ref=${encodeURIComponent(brainRef)}${refresh ? "&refresh=1" : ""}`));
      } catch (e) {
        setError(errorText(e));
      }
    },
    [brainRef],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const set = async (name: string, enabled: boolean) => {
    setSwitching(name);
    try {
      setList(await api.put<Listing>("/api/brains/connections", { ref: brainRef, name, enabled }));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSwitching(undefined);
    }
  };

  if (error) return <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>;
  if (!list) return <Loading text={t("brainConnections.asking")} />;
  if (!list.supported) return <p className="text-xs text-muted">{t("brainConnections.unsupported")}</p>;
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="mb-2 flex items-start gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted">{t("brainConnections.hint")}</p>
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()} loading={refreshing}>
          {t("common.refresh")}
        </Button>
      </div>
      {list.connections.length === 0 && <p className="text-sm text-muted">{t("brainConnections.empty")}</p>}
      {list.connections.map((c, i) => {
        const st = STATUS[c.status];
        return (
          <div key={c.name} className={`flex items-center gap-3 py-2 ${i ? "border-t border-border" : ""}`}>
            <Plug className="size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-all">{c.name}</span>
                {st && (
                  <Badge tone={st.tone} dot>
                    {t(st.label)}
                  </Badge>
                )}
                <Badge>{t(SOURCE[c.source])}</Badge>
              </div>
              {c.detail && <div className="mt-0.5 text-xs break-words text-danger">{c.detail}</div>}
              {c.tools && c.tools.length > 0 && <div className="mt-0.5 text-xs text-muted">{t("brainConnections.tools", { n: c.tools.length, read: c.readTools?.length ?? 0 })}</div>}
            </div>
            <Toggle checked={c.enabled} disabled={switching === c.name} onChange={(v) => void set(c.name, v)} />
          </div>
        );
      })}
    </div>
  );
}
