// External MCP servers: status list and a JSON editor for the user's mcpServers config.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCw, Save, Server } from "lucide-react";
import { api, errorText } from "../lib/api";
import { MCP_EXAMPLE, parseMcpConfig } from "../lib/mcp-config";
import type { Tone } from "../lib/format";
import { useStore } from "../lib/store";
import { session } from "../state/app";
import { toast } from "../state/toast";
import { t, tRich, type MessageKey } from "../i18n";
import { Badge, Button, Card, EmptyState, ErrorNote, Loading, Page, Textarea } from "../components/ui";

interface McpStatus {
  name: string;
  source: string;
  status: "connecting" | "connected" | "reconnecting" | "signin" | "error" | "disabled";
  error?: string;
  tools: string[];
}

const STATUS: Record<McpStatus["status"], { label: MessageKey; tone: Tone }> = {
  connecting: { label: "mcp.status.connecting", tone: "info" },
  connected: { label: "mcp.status.connected", tone: "success" },
  reconnecting: { label: "mcp.status.reconnecting", tone: "warning" },
  signin: { label: "mcp.status.signin", tone: "info" },
  error: { label: "mcp.status.error", tone: "danger" },
  disabled: { label: "mcp.status.disabled", tone: "neutral" },
};

function statusOf(status: string): { label: string; tone: Tone } {
  const st = STATUS[status as McpStatus["status"]];
  return st ? { label: t(st.label), tone: st.tone } : { label: status, tone: "neutral" };
}

export function McpPage() {
  const s = useStore(session);
  const [servers, setServers] = useState<McpStatus[] | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState<string>();

  const load = useCallback(async (resetEditor: boolean) => {
    setError(undefined);
    try {
      const r = await api.get<{ servers: McpStatus[]; config: Record<string, unknown> }>("/api/mcp-servers");
      setServers(r.servers);
      if (resetEditor) {
        const json = JSON.stringify(r.config ?? {}, null, 2);
        setText(json);
        setSaved(json);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const parsed = useMemo(() => parseMcpConfig(text), [text]);
  const dirty = text !== saved;

  const save = async () => {
    if (!parsed.servers) return;
    setBusy(true);
    try {
      await api.put("/api/mcp-servers", { servers: parsed.servers });
      toast(t("mcp.saved"), "success");
      await load(true);
      setTimeout(() => void load(false), 2500);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async (name: string) => {
    setReconnecting(name);
    try {
      setServers(await api.post<McpStatus[]>(`/api/mcp-servers/${encodeURIComponent(name)}/reconnect`, {}));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setReconnecting(undefined);
    }
  };

  return (
    <Page title={t("nav.mcp")} subtitle={t("mcp.subtitle")}>
      {error && <ErrorNote onRetry={() => void load(true)}>{error}</ErrorNote>}
      {!servers && !error && <Loading />}
      {servers && servers.length === 0 && <EmptyState icon="server" title={t("mcp.empty")} hint={t("mcp.emptyHint")} />}
      {servers && servers.length > 0 && (
        <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {servers.map((m, i) => {
            const st = statusOf(m.status);
            return (
              <div key={m.name} className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center ${i ? "border-t border-border" : ""}`}>
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <Server className="mt-0.5 size-[18px] shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium">{m.name}</span>
                      <Badge tone={st.tone} dot>
                        {st.label}
                      </Badge>
                      <Badge>{m.source === "user" ? t("mcp.source.user") : t("mcp.source.plugin", { id: m.source })}</Badge>
                    </div>
                    {m.error && <div className="mt-1 text-xs break-words text-danger">{m.error}</div>}
                    {m.tools.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted select-none">{t("mcp.tools", { n: m.tools.length })}</summary>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {m.tools.map((tool) => (
                            <code key={tool} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
                              {tool}
                            </code>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
                <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => void reconnect(m.name)} loading={reconnecting === m.name} className="self-end sm:self-auto">
                  {t("mcp.reconnect")}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Card
        title={t("mcp.config")}
        actions={
          <>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setText(saved)}>
                {t("mcp.revert")}
              </Button>
            )}
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} onClick={() => void save()} disabled={!parsed.servers || !dirty} loading={busy}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">
          {tRich("mcp.configIntro", {
            format: <code className="font-mono">.mcp.json</code>,
            ref: <code className="font-mono">vault://id</code>,
            console: (
              <a href={s ? `${s.consoleUrl}/#/vault` : "#"} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">
                {t("mcp.configConsole")}
              </a>
            ),
          })}
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={16}
          spellCheck={false}
          className="font-mono text-[13px] leading-relaxed"
          aria-label={t("mcp.configLabel")}
          placeholder={MCP_EXAMPLE}
          onKeyDown={(e) => {
            if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void save();
            }
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const next = text.slice(0, a) + "  " + text.slice(b);
              setText(next);
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          {parsed.error ? <span className="text-danger">{parsed.error}</span> : <span className="text-success">{t("mcp.configOk", { n: Object.keys(parsed.servers ?? {}).length })}</span>}
          {text.trim() === "{}" || !text.trim() ? (
            <button type="button" className="text-accent-text underline" onClick={() => setText(MCP_EXAMPLE)}>
              {t("mcp.insertExample")}
            </button>
          ) : null}
        </div>
      </Card>
    </Page>
  );
}
