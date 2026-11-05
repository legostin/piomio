// Kanban: projects with their own columns, cards with content and attachments, on top of the hub's tasks: a card is the
// plan, a task one run of it. Agents take cards by themselves when the person turns that on and tells them which.
// docs/superpowers/specs/2026-11-05-kanban-design.md

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import type { Task } from "@piomio/shared";
import { Board } from "./board.ts";
import { Files } from "./files.ts";
import { handleHttp } from "./http.ts";
import { Pickup } from "./pickup.ts";
import { registerTools } from "./tools.ts";
import type { Card } from "./types.ts";
import { Work } from "./work.ts";

let pickup: Pickup | undefined;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    const board = new Board({
      storage: ctx.storage,
      columnName: (type) => ctx.i18n.t(`column.${type}`),
      defaultProjectName: () => ctx.i18n.t("project.default"),
      log: (m) => ctx.log.warn(m),
    });
    await board.load();
    const work = new Work(ctx, board);
    const p = new Pickup(ctx, board, work);
    pickup = p;
    await p.load();
    const files = new Files(ctx, board);
    const kit = { ctx, board, work, pickup: p, files };

    // The open pages hear about changes (several at once are one reload), and the engine looks at the queue.
    let emit: ReturnType<typeof setTimeout> | undefined;
    board.onChange = () => {
      p.kick();
      emit ??= setTimeout(() => {
        emit = undefined;
        ctx.ui.emit("changed", {});
      }, 100);
    };
    work.onSettled = (agentId, ok) => p.settled(agentId, ok);

    registerTools(kit);
    ctx.http.handle((req) => handleHttp(kit, req));
    ctx.events.on("task.updated", (task: Task) => work.onTask(task));
    ctx.events.on("agent.removed", (e: { agentId: string }) => {
      void p.removeRule(e.agentId).catch((err) => ctx.log.warn(`could not remove ${e.agentId}'s rule: ${err?.message ?? err}`));
      for (const card of [...board.cards.values()] as Card[]) {
        if (card.assignee === e.agentId) {
          delete card.assignee;
          board.saveCard(card);
        }
      }
    });
    // After activation, so the hub is not kept waiting.
    setImmediate(() => p.start());
  },
  deactivate() {
    pickup?.stop();
  },
};

export default plugin;
