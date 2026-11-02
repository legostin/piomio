// A new hub's first screen: until some brain works, the app is only the assistant asking for one, with the setup card.
// Once a brain works the app opens as usual, on the assistant's dialog, where it speaks first (BrainSetupCard.tsx).
// Hubs already in use never see it: `firstRun` comes with the bootstrap, so they skip the check.

import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../lib/store";
import { agents, ensureAgents, session } from "../state/app";
import { SetupCardView, useSetupState } from "./BrainSetupCard";
import { AgentAvatar } from "./AgentAvatar";
import { OwlMark } from "./OwlMark";
import { t } from "../i18n";

export function FirstRunGate({ children }: { children: ReactNode }) {
  const first = !!useStore(session)?.firstRun;
  // Once through, the app stays: a brain that drops later is the setup card's business, not this screen's.
  const [through, setThrough] = useState(!first);
  const { state, refresh } = useSetupState(undefined, !through);
  const usable = !!state?.usable;
  useEffect(() => {
    if (usable) setThrough(true);
  }, [usable]);

  if (through || usable) return <>{children}</>;
  // Still starting: its brains are not all in, so it is too early to ask for one.
  if (!state || state.starting)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg" role="status">
        <OwlMark size={52} mood="sleepy" className="animate-zoom" />
        <span className="animate-fade text-sm text-muted">{t("app.connecting")}</span>
      </div>
    );
  return (
    <FirstRunScreen agentId={state.agentId} apiKeys={state.apiKeys}>
      <SetupCardView state={state} refresh={refresh} bare />
    </FirstRunScreen>
  );
}

function FirstRunScreen({ agentId, apiKeys, children }: { agentId: string; apiKeys: boolean; children: ReactNode }) {
  const agent = useStore(agents)?.find((a) => a.id === agentId);
  useEffect(() => {
    ensureAgents();
  }, []);
  return (
    <div className="flex min-h-dvh justify-center overflow-y-auto bg-bg px-4 py-10">
      <div className="my-auto flex w-full max-w-lg flex-col items-center gap-6">
        <div className="animate-zoom hero-halo flex size-32 items-center justify-center rounded-3xl bg-surface-2/70">
          <AgentAvatar avatar={agent?.avatar} id={agentId} name={agent?.name ?? ""} size={88} />
        </div>
        <div className="text-center">
          <h1 className="font-display text-[26px] leading-tight font-semibold">{t("firstRun.title")}</h1>
          <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-muted">{t(apiKeys ? "firstRun.intro" : "firstRun.introPlans")}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
