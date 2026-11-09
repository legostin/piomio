// A stub quick model for the hub's signal tests: brain "kimi" (one the quick model tries), signed in, which answers
// every question with a triage wake, and keeps what it was asked in its storage so a test can read what it was shown.
// It is the only brain the test hub has, so the wake tasks run on it too.

import type { PluginContext } from "@piomio/plugin-sdk";
import type { BrainEvent } from "@piomio/shared";

export default {
  activate(ctx: PluginContext) {
    ctx.brains.register({
      id: "kimi",
      label: "Quick stub",
      probe: async () => ({ available: true, authenticated: true }),
      createSession: async () => ({
        async *send(turn: { text: string }): AsyncGenerator<BrainEvent> {
          const asked = (await ctx.storage.get<string[]>("questions")) ?? [];
          await ctx.storage.set("questions", [...asked, turn.text].slice(-20));
          yield { type: "text", delta: JSON.stringify({ decision: "wake", why: "a ping is worth a look", summary: "A ping came" }) };
          yield { type: "done" };
        },
        interrupt() {},
        close() {},
      }),
    });
  },
};
