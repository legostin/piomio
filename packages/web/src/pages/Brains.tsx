// Brains: probe status per brain ref, limits, and signing in (subscriptions sign in right here, keys go to the vault).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Brain, ChevronDown, LogIn, RefreshCw, TimerReset } from "lucide-react";
import { api, errorText } from "../lib/api";
import { formatDateTime, relativeTime } from "../lib/format";
import { hubEvents, session } from "../state/app";
import { brainStatus, type BrainRow } from "../state/brains";
import { toast } from "../state/toast";
import { t, tRich } from "../i18n";
import { Badge, Button, Card, EmptyState, ErrorNote, Loading, Page } from "../components/ui";
import { BrainLoginCard } from "../components/BrainLoginCard";
import { PluginSetupCard, VaultGate } from "../components/SecretCards";


function hostLabel(host?: string): string | undefined {
  if (!host) return undefined;
  if (host.startsWith("plugin:")) return t("brains.host.plugin", { id: host.slice(7) });
  if (host.startsWith("machine:")) return t("brains.host.machine", { id: host.slice(8) });
  return host;
}

export function BrainsPage() {
  const [signingIn, setSigningIn] = useState<string>();
  const [list, setList] = useState<BrainRow[] | null>(null);
  const [error, setError] = useState<string>();
  const [probingAll, setProbingAll] = useState(false);
  const [probing, setProbing] = useState<string>();

  const load = useCallback(async (fresh = false) => {
    setError(undefined);
    try {
      setList(await api.get<BrainRow[]>(`/api/brains${fresh ? "?probe=1" : ""}`));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return hubEvents.on((e) => {
      if (e.type === "brains.updated" || e.type === "plugins.updated" || e.type === "machine.updated") void load();
    });
  }, [load]);

  const probeAll = async () => {
    setProbingAll(true);
    await load(true);
    setProbingAll(false);
  };

  const probe = async (ref: string) => {
    setProbing(ref);
    try {
      await api.post("/api/brains/probe", { ref });
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setProbing(undefined);
    }
  };

  const clearLimit = async (ref: string) => {
    try {
      await api.del(`/api/brains/limits/${encodeURIComponent(ref)}`);
      toast(t("brains.limitCleared"), "success");
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <Page
      title={t("nav.brains")}
      subtitle={t("brains.subtitle")}
      actions={
        <Button icon={<RefreshCw className="size-4" />} onClick={() => void probeAll()} loading={probingAll}>
          {t("brains.checkAll")}
        </Button>
      }
    >
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading text={t("brains.checking")} />}
      {list && list.length === 0 && <EmptyState icon="brain" title={t("brains.empty")} hint={t("brains.emptyHint")} />}
      {list && list.length > 0 && (
        <div className="mb-8 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {list.map((b, i) => {
            const st = brainStatus(b);
            return (
              <div key={b.ref} className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center ${i ? "border-t border-border" : ""}`}>
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                    <Brain className="size-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{b.label}</span>
                      <Badge tone={st.tone} dot>
                        {st.label}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                      {b.label !== b.ref && <span className="font-mono">{b.ref}</span>}
                      {hostLabel(b.host) && <span>{hostLabel(b.host)}</span>}
                      {b.probe?.model && <span>{t("brains.model", { model: b.probe.model })}</span>}
                      {b.probe?.version && <span>{t("brains.version", { version: b.probe.version })}</span>}
                      {b.probe?.checkedAt && <span>{t("brains.checked", { time: relativeTime(b.probe.checkedAt) })}</span>}
                    </div>
                    {(b.probe?.detail || b.limitDetail) && <div className="mt-1 text-xs break-words text-muted">{b.limitedUntil ? b.limitDetail : b.probe?.detail}</div>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 pl-12 sm:pl-0">
                  {b.login && b.connected && b.probe && !b.probe.authenticated && signingIn !== b.ref && (
                    <Button size="sm" variant="primary" icon={<LogIn className="size-3.5" />} onClick={() => setSigningIn(b.ref)}>
                      {t("brainLogin.signIn")}
                    </Button>
                  )}
                  {b.limitedUntil && (
                    <Button size="sm" icon={<TimerReset className="size-3.5" />} onClick={() => void clearLimit(b.ref)}>
                      {t("brains.clearLimit")}
                    </Button>
                  )}
                  {b.connected && (
                    <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void probe(b.ref)} loading={probing === b.ref}>
                      {t("common.check")}
                    </Button>
                  )}
                </div>
                {signingIn === b.ref && (
                  <div className="w-full pl-12 sm:basis-full">
                    <BrainLoginCard brainRef={b.ref} bare />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <h2 className="mb-3 text-lg font-semibold">{t("brains.howTo")}</h2>
      {/* By the room the page has, not the window's: in the settings panel the cards stand one under another. */}
      <div className="@container">
        <div className="grid gap-3 @3xl:grid-cols-2">
          <Card title="Claude Code">
            <BrainLoginCard brainRef="claude-code@local" bare />
            <details className="group mt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-accent-text">
                {t("brainLogin.claudeToken")} <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2">
                <VaultGate>
                  <PluginSetupCard pluginId="brain-claude-code" bare />
                </VaultGate>
              </div>
            </details>
            <p className="mt-3 text-xs text-muted">{t("brains.claudeMachines")}</p>
          </Card>
          <Card title="Codex">
            <BrainLoginCard brainRef="codex@local" bare />
            <p className="mt-3 text-xs text-muted">{tRich("brains.codexKey", { id: <Code>openai_api_key</Code> })}</p>
          </Card>
          <Card title={t("brains.apiKeys")} className="@3xl:col-span-2">
            <VaultGate>
              <PluginSetupCard pluginId="brain-api" bare />
            </VaultGate>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md border border-border bg-code-bg px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
}
