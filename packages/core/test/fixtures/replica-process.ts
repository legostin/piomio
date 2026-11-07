// A hub in a process of its own, for tests that stop and resume it the way a computer's sleep does (SIGSTOP, SIGCONT):
// its timers and sockets stand still while the wall clock runs on. The test drives it over the IPC channel.
import { join } from "node:path";
import { Hub, loadConfig } from "../../src/index.ts";

let hub: Hub | undefined;

const ops: Record<string, (a: any) => unknown> = {
  async start(a: { env: NodeJS.ProcessEnv; dataDir: string; cluster?: Record<string, unknown>; ownNode?: boolean }) {
    const fixtures = import.meta.dirname;
    hub = new Hub(loadConfig(a.env, { dataDir: a.dataDir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents"), ownNode: a.ownNode ?? false }));
    await hub.start();
    Object.assign(hub.cluster, a.cluster ?? {});
    return {};
  },
  invite() {
    const { link } = hub!.cluster.invite();
    return { link, conversationId: hub!.store.agentConversation(hub!.settings.get().defaultAgent).id };
  },
  texts(a: { conversationId: string }) {
    return hub!.store.listMessages(a.conversationId).map((m) => (m.parts[0] as any)?.text);
  },
  /** Its role switches, oldest first. */
  switches() {
    return hub!.audit
      .list({ action: "cluster.*" })
      .reverse()
      .map((e) => ({ action: e.action, why: (e.data as any)?.why }));
  },
  async stop() {
    await hub?.stop();
    hub = undefined;
    return {};
  },
};

process.on("message", (m: { id: number; op: string; args?: unknown }) => {
  void (async () => {
    try {
      process.send!({ id: m.id, result: await ops[m.op]!(m.args ?? {}) });
    } catch (e: any) {
      process.send!({ id: m.id, error: String(e?.stack ?? e) });
    }
  })();
});

// The test went away: so does this hub.
process.on("disconnect", () => void Promise.resolve(hub?.stop()).finally(() => process.exit(0)));
