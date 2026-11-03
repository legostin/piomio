// Built-in plugin "pio": the assistant that is always next to you (docs/superpowers/specs/2026-11-03-pio-always-on-design.md).
// Its window in the desktop app (the UI module's bare page /pio/overlay) reports what it sees and hears; this side
// keeps that in memory, gives Pio its [On screen] block and its tools, takes quiet looks on its own, and shows on the
// team list what Pio is doing.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import type { AgentPresence, Message } from "@piomio/shared";
import { Bodies } from "./bodies.ts";
import { screenBlock, watchNote } from "./context.ts";
import { cleanPrefs, DEFAULT_PREFS, type Prefs } from "./prefs.ts";
import { Relay, type ActResult } from "./relay.ts";
import { AGENT, registerTools } from "./tools.ts";
import { GAPS, looked, nextWatch, type WatchState } from "./watch.ts";

const TICK_MS = 5_000;
const PRESENCE_EVERY_MS = 30_000;
const PREFS_KEY = "prefs";

/** What a Pio window sends (ui plugin.send). */
type FromWindow =
  | { type: "hello"; body: string; conversationId?: string }
  | {
      type: "state";
      body: string;
      watching?: boolean;
      voice?: boolean;
      control?: boolean;
      hearing?: boolean;
      speaking?: boolean;
      /** Pio's chat and the person's window, so a body the hub forgot comes back whole from one heartbeat. */
      conversationId?: string;
      window?: { app?: unknown; title?: unknown };
    }
  | { type: "window"; body: string; app: string; title?: string }
  | { type: "bye"; body: string }
  | { type: "open"; body: string }
  | ({ type: "result" } & ActResult);

let stop: (() => void) | undefined;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    const bodies = new Bodies();
    const relay = new Relay((channel, payload) => ctx.ui.emit(channel, payload));
    const watch: WatchState = {};
    let prefs: Prefs = cleanPrefs(await ctx.storage.get(PREFS_KEY));
    let conversationId: string | undefined;
    let presence: AgentPresence | undefined;

    // The hub forgets it after a minute and a half: said again on every change and every half minute.
    let presenceAt = 0;
    const showPresence = () => {
      const now = bodies.presence();
      if (now === presence && (!now || Date.now() - presenceAt < PRESENCE_EVERY_MS)) return;
      presence = now;
      presenceAt = Date.now();
      ctx.core.call("agents.presence", { agentId: AGENT, presence: now ?? null }).catch((e) => ctx.log.warn(`presence: ${(e as Error).message}`));
    };

    const setPrefs = async (p: Partial<Prefs>): Promise<Prefs> => {
      prefs = cleanPrefs(p, prefs);
      await ctx.storage.set(PREFS_KEY, prefs);
      ctx.ui.emit("prefs", prefs);
      return prefs;
    };

    ctx.ui.onMessage((m: FromWindow) => {
      if (!m || typeof m !== "object" || typeof (m as { body?: unknown }).body !== "string") {
        if (m?.type === "result") relay.answer(m);
        return;
      }
      switch (m.type) {
        case "hello":
          bodies.touch(m.body);
          if (typeof m.conversationId === "string") conversationId = m.conversationId;
          ctx.ui.emit("prefs", prefs);
          break;
        case "state":
          // A heartbeat carries the whole picture: a window the hub forgot (a restart, the computer asleep past GONE_MS)
          // is back with its switches, the person's window and Pio's chat, not only its presence.
          bodies.state(m.body, m);
          if (m.window && typeof m.window === "object" && typeof m.window.app === "string")
            bodies.window(m.body, m.window.app.slice(0, 120), typeof m.window.title === "string" ? m.window.title.slice(0, 300) : undefined);
          if (typeof m.conversationId === "string") conversationId = m.conversationId;
          // Answered, so the window knows the way to the plugin is open (its socket may look fine while it is not).
          ctx.ui.emit("seen", { body: m.body });
          break;
        case "window":
          bodies.window(m.body, String(m.app ?? "").slice(0, 120), typeof m.title === "string" ? m.title.slice(0, 300) : undefined);
          break;
        case "bye":
          bodies.gone(m.body);
          break;
        case "open":
          // "Open chat" in Pio's window: the main window shows Pio's chat.
          ctx.ui.emit("open-chat", {});
          break;
        case "result":
          relay.answer(m);
          break;
      }
      showPresence();
    });

    // The person talking with Pio, and Pio's own remarks, keep its quiet looks away for a while.
    ctx.events.on("message.created", (m: Message) => {
      if (m.role === "user" && m.conversationId === conversationId) watch.lastTalkAt = Date.now();
    });
    ctx.events.on("message.updated", (m: Message) => {
      if (m.agentId !== AGENT || m.role !== "assistant" || m.quiet || m.status !== "complete") return;
      conversationId ??= m.conversationId;
      watch.lastRemarkAt = Date.now();
    });

    ctx.hooks.on("turn.context", (p) => {
      if (p.agentId !== AGENT || p.taskId) return;
      conversationId = p.conversationId;
      return { context: screenBlock(bodies.active(), Date.now()) };
    });

    registerTools(ctx, { bodies, relay, prefs: () => prefs, setPrefs, show: () => ctx.ui.emit("show", {}) });

    let looking = false;
    const tick = async () => {
      if (looking) return;
      const now = Date.now();
      const body = bodies.active();
      showPresence();
      const due = nextWatch(body, watch, now, prefs.chattiness);
      if (!due || !body) return;
      looking = true;
      looked(watch, body, now);
      try {
        const r = await ctx.core.call<{ skipped?: string; conversationId?: string }>("conversations.tell", { agentId: AGENT, quiet: true, text: watchNote(body, now, due.reason) });
        if (r?.conversationId) conversationId = r.conversationId;
        // Busy with the person: try again in half a minute, not after a whole gap.
        if (r?.skipped) watch.lastLookAt = now - GAPS[prefs.chattiness].look + 30_000;
      } catch (e) {
        ctx.log.warn(`quiet look: ${(e as Error).message}`);
      } finally {
        looking = false;
      }
    };
    const timer = setInterval(() => void tick(), TICK_MS);
    stop = () => {
      clearInterval(timer);
      relay.close();
    };
    ctx.log.info(`pio ready (chattiness ${prefs.chattiness}, listen ${prefs.listen}; defaults ${JSON.stringify(DEFAULT_PREFS)})`);
  },
  deactivate() {
    stop?.();
  },
};

export default plugin;
