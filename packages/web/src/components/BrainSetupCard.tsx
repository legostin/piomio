// The hub's own answer while no brain works: sign Claude Code, Codex or Kimi Code in (installing it first where the hub
// can), or give a key where the hub takes keys (PIOMIO_API_KEYS). It shows where the hub put it after an unanswered message, at the end of a dialog that has none yet, and
// alone on a new hub's first screen (FirstRun.tsx). Live from /api/setup; once a brain works it shrinks to one line and
// the agent takes over. On a new hub the empty dialog of the default agent then asks the hub to open the intro.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleCheck, RefreshCw } from "lucide-react";
import type { SetupState } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { cliRows, introDue, newest, showGate } from "../lib/setup";
import { conversations, hubEvents, session, useConversationMessages } from "../state/app";
import { BrainLoginCard } from "./BrainLoginCard";
import { PluginSetupCard, VaultGate } from "./SecretCards";
import { Button, Spinner } from "./ui";
import { t } from "../i18n";

/** The setup state of an agent (the default agent when none is given), reloaded when brains, keys or plugins change. */
export function useSetupState(agentId: string | undefined, enabled = true) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
  // Brains come in one by one as the hub starts, each with an event: only the newest answer counts.
  const ticket = useMemo(newest, []);
  const load = useCallback(() => {
    const current = ticket();
    api.get<SetupState>(`/api/setup${query}`).then(
      (s) => {
        if (!current()) return;
        setState(s);
        setError(null);
      },
      (e) => current() && setError(errorText(e)),
    );
  }, [query, ticket]);
  useEffect(() => {
    if (!enabled) return;
    load();
    return hubEvents.on((e) => {
      // agents.updated: the user picked a brain for the agent in the chat header.
      if (e.type === "brains.updated" || e.type === "agents.updated" || e.type === "plugins.updated" || e.type === "vault.state" || (e.type === "brain.login" && e.data.status === "succeeded")) load();
    });
  }, [load, enabled]);
  const refresh = async () => {
    const current = ticket();
    const s = await api.post<SetupState>("/api/setup/refresh", agentId ? { agent: agentId } : {});
    if (current()) setState(s);
  };
  return { state, error, refresh };
}

/** The card a `brain_setup` part stands for, in the conversation it was added to. */
export function BrainSetupCard({ conversationId }: { conversationId: string }) {
  const agentId = useStore(conversations).find((c) => c.id === conversationId)?.agentId;
  const { state, error, refresh } = useSetupState(agentId);
  if (!state) return error ? <div className="my-2 text-sm text-danger">{error}</div> : <Spinner />;
  return <SetupCardView state={state} refresh={refresh} />;
}

/**
 * The card at the end of a dialog where nothing was written yet and no brain works; on a new hub with a brain, the
 * default agent's empty dialog asks the hub to open the intro, and the agent speaks first.
 */
export function SetupGate({ conversationId, agentId }: { conversationId: string; agentId?: string }) {
  const conv = useConversationMessages(conversationId);
  const { state, refresh } = useSetupState(agentId);
  const main = useStore(session)?.mainConversationId === conversationId;
  const due = conv.loaded && introDue(conv.messages, state, main);
  const asked = useRef(false);
  useEffect(() => {
    if (!due || asked.current) return;
    asked.current = true;
    api.post("/api/setup/intro", {}).catch(() => {
      asked.current = false;
    });
  }, [due]);
  if (!conv.loaded || !state || !showGate(conv.messages, state)) return null;
  return <SetupCardView state={state} refresh={refresh} />;
}

/** `bare`: without its own title and words, under a screen that says them (FirstRun.tsx). */
export function SetupCardView({ state, refresh, bare }: { state: SetupState; refresh: () => Promise<void>; bare?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.usable) {
    const names = state.brains.filter((b) => b.signedIn).map((b) => b.label);
    return (
      <div className="flex items-center justify-center gap-1.5 text-sm text-muted">
        <CircleCheck className="size-4 text-success" />
        {names.length ? t("brainSetup.connected", { name: names.join(", ") }) : t("brainSetup.ready")}
      </div>
    );
  }

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const rows = cliRows(state);
  return (
    <div className="animate-in w-full rounded-[22px] border border-accent/30 bg-surface p-4 shadow-card">
      {!bare && (
        <>
          <div className="mb-1 font-semibold">{t("brainSetup.title")}</div>
          <p className="mb-3 text-sm text-muted">{rows.length ? t(state.apiKeys ? "brainSetup.intro" : "brainSetup.introPlans") : t(state.apiKeys ? "brainSetup.introKeys" : "brainSetup.introNone")}</p>
        </>
      )}
      <div className="flex flex-col gap-3">
        {rows.map((b) => (
          <div key={b.ref} className="flex flex-col gap-1 rounded-xl bg-surface-2/70 px-2.5 py-2">
            <BrainLoginCard brainRef={b.ref} compact install={!b.installed && b.canInstall} />
            {!b.installed && !b.canInstall && <div className="text-xs text-muted">{b.detail ?? t("brainSetup.notInstalled")}</div>}
          </div>
        ))}
        <details className="group" open={!rows.length && state.apiKeys}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-accent-text">
            {t(state.apiKeys ? "brainSetup.apiKeys" : "brainLogin.claudeToken")} <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          {/* One gate for both cards, so an absent vault is offered once, not twice. */}
          <div className="mt-2">
            <VaultGate>
              <div className="flex flex-col gap-3">
                <PluginSetupCard pluginId="brain-claude-code" bare />
                {state.apiKeys && <PluginSetupCard pluginId="brain-api" bare />}
              </div>
            </VaultGate>
          </div>
        </details>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void check()}>
          {t("brainSetup.checkAgain")}
        </Button>
        <span className="text-xs text-muted">{t("brainSetup.checkAgainHint")}</span>
      </div>
      {error && <div className="mt-1 text-xs text-danger">{error}</div>}
    </div>
  );
}
