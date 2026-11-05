// What agents can do with the board. Everything the page can do is here too: the chat comes first.
// Tool descriptions and results are for the model: English, not in the locales.

import type { PluginContext, ToolRegistration } from "@piomio/plugin-sdk";
import type { JsonSchema, ToolCallContext, ToolResult } from "@piomio/shared";
import type { Board, By, CardInput, ColumnInput, ProjectInput } from "./board.ts";
import { KanbanError } from "./errors.ts";
import type { Files } from "./files.ts";
import type { Pickup, RuleInput } from "./pickup.ts";
import { cardLine, cardText, pickupText, projectLine } from "./text.ts";
import { COLUMN_TYPES, PRIORITIES, type Card } from "./types.ts";
import type { Work } from "./work.ts";

export interface Kit {
  ctx: PluginContext;
  board: Board;
  work: Work;
  pickup: Pickup;
  files: Files;
}

const MAX_IMPORT = 200;

const CARD: JsonSchema = { type: "string", description: "The card's name, like SITE-12." };
const STATUS = `A column of the project: its name, or a type (${COLUMN_TYPES.join(", ")}) for the first column of that type.`;
const EXTERNAL: JsonSchema = {
  type: "object",
  description: "The same work in another tracker. A card with this source and id is updated instead of duplicated.",
  properties: {
    source: { type: "string", description: 'The tracker, lowercase, e.g. "linear".' },
    id: { type: "string", description: 'Its id there, e.g. "ENG-123".' },
    url: { type: "string" },
  },
  required: ["source", "id"],
};
const FIELDS: Record<string, JsonSchema> = {
  title: { type: "string" },
  description: { type: "string", description: "Markdown." },
  status: { type: "string", description: STATUS },
  priority: { type: "string", enum: [...PRIORITIES] },
  assignee: { type: "string", description: 'An agent\'s id, or "me" for the person (no agent takes it). Empty: anyone with a rule may take it.' },
  labels: { type: "array", items: { type: "string" } },
  due: { type: "string", description: "YYYY-MM-DD; empty to clear." },
  blockedBy: { type: "array", items: { type: "string" }, description: "Cards that have to close first (the whole list)." },
  external: EXTERNAL,
};

const text = (s: string, taint = false): ToolResult => ({ content: [{ type: "text", text: s }], ...(taint ? { _meta: { taint: true } } : {}) });
const byOf = (call: ToolCallContext): By => ({ actor: call.agentId, ...(call.tainted ? { tainted: true } : {}) });
/** In a dialog the person sees the card; a task's work shows nothing. */
const inDialog = (call: ToolCallContext): boolean => !call.taskId && !call.background;

export function registerTools(kit: Kit): void {
  const { ctx, board, work, pickup, files } = kit;

  const add = (tool: Omit<ToolRegistration, "handler"> & { handler: (i: any, call: ToolCallContext) => Promise<ToolResult | string> | ToolResult | string }): void => {
    ctx.tools.register({
      ...tool,
      handler: async (input, call) => {
        try {
          return await tool.handler(input ?? {}, call);
        } catch (e: any) {
          const message = e instanceof KanbanError ? ctx.i18n.t(`error.${e.code}`, e.params, "en") : (e?.message ?? String(e));
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    });
  };

  const showCard = (call: ToolCallContext, card: Card): void => {
    if (inDialog(call)) ctx.widgets.show(call, "card", { id: card.id, key: board.keyOf(card), title: card.title });
  };

  /** A field of the input that exists, for the card's own validation. */
  const cardInput = (i: any): CardInput => {
    const out: CardInput = {};
    for (const k of ["project", "title", "description", "status", "priority", "labels", "due", "blockedBy", "external", "before"] as const) {
      if (i[k] !== undefined) (out as any)[k] = i[k];
    }
    return out;
  };

  /** "me", an agent's id or name, or empty for nobody. */
  const assigneeOf = async (raw: unknown): Promise<string | null | undefined> => {
    if (raw === undefined) return undefined;
    const value = String(raw ?? "").trim();
    if (!value) return null;
    if (value.toLowerCase() === "me") return "me";
    return (await work.requireAgent(value)).id;
  };

  add({
    name: "projects",
    description: "The kanban projects: their columns with types and how many cards each holds, and each project's notes.",
    inputSchema: { type: "object", properties: { includeArchived: { type: "boolean" } } },
    effect: "read",
    handler: (i) => {
      const list = board.projectList(i.includeArchived === true);
      return list.length ? list.map((p) => projectLine(board, p)).join("\n") : "There are no projects yet. kanban_project_save makes one.";
    },
  });

  add({
    name: "project_save",
    description:
      "Make a kanban project, or change one (pass `project`): its name, key, notes, columns; archive it. A project starts with standard columns (backlog, queue, in progress, review, done). " +
      "Every column has a name of the person's choosing and a type that tells the board what it means: backlog (not ready), queue (agents may take cards from here), active (being worked on), review (the person checks finished work; a project with one sends finished cards there, without one straight to done), done, cancelled. " +
      "`columns` is the whole new list, in order; cards in a removed column go to `moveCardsTo`, else to a column of the same type. `limit` on a column is how many cards it should hold; agents respect it on active columns. " +
      "`description` is notes that every run on this project's cards reads: the folder to work in, the repository, how to report.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project to change: its name or key. Omit to make a new one." },
        name: { type: "string" },
        key: { type: "string", description: "Short and unique, the start of its cards' names (SITE). Made from the name if omitted." },
        description: { type: "string" },
        columns: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: [...COLUMN_TYPES] }, limit: { type: "integer" } }, required: ["name"] },
        },
        moveCardsTo: { type: "string" },
        archived: { type: "boolean" },
      },
    },
    effect: "local-write",
    askWhenTainted: true,
    handler: (i) => {
      const input: ProjectInput = {};
      for (const k of ["name", "key", "description", "moveCardsTo", "archived"] as const) if (i[k] !== undefined) (input as any)[k] = i[k];
      if (i.columns !== undefined) input.columns = i.columns as ColumnInput[];
      const p = i.project ? board.updateProject(board.project(i.project), input) : board.createProject(input);
      return `${i.project ? "Saved" : "Made"} ${projectLine(board, p)}`;
    },
  });

  add({
    name: "board",
    description: "Show the person a project's board as a live card in the chat. You get only how many cards each column holds: kanban_cards lists them.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Its name or key; may be omitted when there is only one." } } },
    effect: "read",
    handler: (i, call) => {
      if (!i.project && !board.projectList().length) return "There are no projects yet. kanban_project_save makes one.";
      const p = board.projectFor(i.project);
      if (inDialog(call)) ctx.widgets.show(call, "board", { projectId: p.id, name: p.name });
      return `${projectLine(board, p)}${inDialog(call) ? "\nThe person sees the board as a card." : ""}`;
    },
  });

  add({
    name: "cards",
    description: "Find kanban cards, in board order. Filter by project, status (a column's name or type), assignee, label, priority, words, or external (\"linear:ENG-123\").",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        status: { type: "string" },
        assignee: { type: "string" },
        label: { type: "string" },
        priority: { type: "string", enum: [...PRIORITIES] },
        query: { type: "string" },
        external: { type: "string" },
        limit: { type: "integer" },
      },
    },
    effect: "read",
    handler: (i) => {
      const list = board.filter(i);
      if (!list.length) return "No cards match.";
      return text(list.map((c) => cardLine(board, c)).join("\n"), list.some((c) => c.outside));
    },
  });

  add({
    name: "card",
    description: "Read a kanban card: its description, what it waits for, attachments, comments, runs and their results. In a dialog the person also sees it as a live card with its actions.",
    inputSchema: { type: "object", properties: { card: CARD }, required: ["card"] },
    effect: "read",
    handler: (i, call) => {
      const card = board.card(i.card);
      showCard(call, card);
      return text(cardText(board, card) + (inDialog(call) ? "\nThe person sees it as a card." : ""), card.outside);
    },
  });

  add({
    name: "card_save",
    description:
      "Make a kanban card, or change one (pass `card`). To move a card, change `status`; `before` puts it in front of another card in the column. " +
      "A card with an `external` that already exists is updated, not duplicated. In a queue column it is ready for agents with a rule; only what is not ready belongs in the backlog. " +
      "Text from outside (a tracker, a page, a mail) is fine here, but such a card does not run by itself until the person allows it (kanban_allow).",
    inputSchema: { type: "object", properties: { card: CARD, project: { type: "string", description: "Its name or key, for a new card. May be omitted when there is only one." }, before: { type: "string" }, ...FIELDS } },
    effect: "local-write",
    handler: async (i, call) => {
      const input = cardInput(i);
      const assignee = await assigneeOf(i.assignee);
      if (assignee !== undefined) input.assignee = assignee;
      const external = board.checkExternal(input.external);
      const existing = i.card ? board.card(i.card) : external ? board.findExternal(external.source, external.id) : undefined;
      const card = existing ? board.updateCard(existing, input, byOf(call)) : board.createCard(input, byOf(call));
      showCard(call, card);
      const held = card.outside && !card.allowed && board.columnOf(card).type === "queue" ? " It waits in the queue until the person allows it: it holds outside content." : "";
      return `${existing ? "Saved" : "Made"} ${cardLine(board, card)}.${held}${inDialog(call) ? " The person sees it as a card." : ""}`;
    },
  });

  add({
    name: "card_import",
    description:
      "Put many cards on a project at once, typically from another tracker (load the kanban-trackers skill first). Each needs `external`: a card already imported is updated and stays in its column, so importing again is safe. " +
      "New cards go to `status` (default: the project's first column). The person sees nothing run until they allow it.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        status: { type: "string", description: STATUS },
        cards: { type: "array", items: { type: "object", properties: FIELDS, required: ["title", "external"] } },
      },
      required: ["cards"],
    },
    effect: "local-write",
    handler: async (i, call) => {
      if (!Array.isArray(i.cards) || !i.cards.length) throw new KanbanError("cardsRequired");
      if (i.cards.length > MAX_IMPORT) throw new KanbanError("importTooMany", { max: MAX_IMPORT });
      const by = byOf(call);
      const project = board.projectFor(i.project);
      let made = 0;
      let updated = 0;
      const failed: string[] = [];
      for (const raw of i.cards) {
        try {
          const external = board.checkExternal(raw.external);
          if (!external) throw new KanbanError("externalInvalid");
          const assignee = await assigneeOf(raw.assignee);
          const input: CardInput = { ...cardInput(raw), ...(assignee !== undefined ? { assignee } : {}) };
          const existing = board.findExternal(external.source, external.id);
          if (existing) {
            delete input.status;
            board.updateCard(existing, input, by);
            updated++;
          } else {
            board.createCard({ ...input, project: project.id, ...(input.status || i.status ? { status: input.status ?? i.status } : {}) }, by);
            made++;
          }
        } catch (e: any) {
          failed.push(`${raw?.external?.id ?? raw?.title ?? "?"}: ${e instanceof KanbanError ? ctx.i18n.t(`error.${e.code}`, e.params, "en") : e?.message}`);
        }
      }
      return `${project.name}: ${made} new, ${updated} updated${failed.length ? `, ${failed.length} failed:\n${failed.join("\n")}` : "."}`;
    },
  });

  add({
    name: "comment",
    description: "Add a comment to a kanban card: progress worth keeping, a decision, a question for later. `files` attaches files from your folder.",
    inputSchema: { type: "object", properties: { card: CARD, text: { type: "string" }, files: { type: "array", items: { type: "string" }, description: "Paths in your folder." } }, required: ["card", "text"] },
    effect: "local-write",
    handler: async (i, call) => {
      const card = board.card(i.card);
      const by = byOf(call);
      board.comment(card, i.text, by);
      for (const path of Array.isArray(i.files) ? i.files : []) await files.fromWorkspace(card, String(path), undefined, call, by);
      return `Commented on ${board.keyOf(card)}.`;
    },
  });

  add({
    name: "attach",
    description: "Attach a file from your folder to a kanban card (at most 25 MB).",
    inputSchema: { type: "object", properties: { card: CARD, path: { type: "string", description: "Its path in your folder." }, name: { type: "string" } }, required: ["card", "path"] },
    effect: "local-write",
    handler: async (i, call) => {
      const card = board.card(i.card);
      const a = await files.fromWorkspace(card, String(i.path), i.name ? String(i.name) : undefined, call, byOf(call));
      return `Attached ${a.name} to ${board.keyOf(card)} (${a.id}).`;
    },
  });

  add({
    name: "attachment_get",
    description: "Put one of a kanban card's attachments in your folder, to read or use it. Says where it landed.",
    inputSchema: { type: "object", properties: { card: CARD, attachment: { type: "string", description: "Its id or name." } }, required: ["card", "attachment"] },
    effect: "read",
    handler: async (i, call) => {
      const card = board.card(i.card);
      const path = await files.toWorkspace(card, files.find(card, i.attachment), call);
      return text(`It is at ${path} in your folder.`, card.outside);
    },
  });

  add({
    name: "start",
    description:
      "Start work on a kanban card now, as a task: when the person asks for it, or to hand a card to a teammate. Its result comes back here and is saved on the card, and the card moves on by itself. " +
      "`agent` defaults to the card's assignee, else you. To cancel a run, cancel its task.",
    inputSchema: { type: "object", properties: { card: CARD, agent: { type: "string" } }, required: ["card"] },
    effect: "local-write",
    handler: async (i, call) => {
      const card = board.card(i.card);
      const assignee = card.assignee && card.assignee !== "me" ? card.assignee : undefined;
      const agent = await work.requireAgent(i.agent ?? assignee ?? call.agentId);
      const r = await work.start(card, agent.id, { mode: "dialog", call }, { by: byOf(call) });
      if (r.skipped) throw new KanbanError("notStarted", { card: board.keyOf(card), reason: r.skipped });
      showCard(call, card);
      return `${agent.id} is working on ${board.keyOf(card)} (task ${r.taskId}).`;
    },
  });

  add({
    name: "return",
    description: "Send a finished kanban card back to work with what is missing: the comment goes on the card and whoever did it gets a new run. When the person accepts instead, move the card to done (kanban_card_save, status done).",
    inputSchema: { type: "object", properties: { card: CARD, comment: { type: "string" } }, required: ["card", "comment"] },
    effect: "local-write",
    handler: async (i, call) => {
      const card = board.card(i.card);
      const r = await work.returnToWork(card, i.comment, { mode: "dialog", call }, byOf(call));
      if (r.skipped) throw new KanbanError("notStarted", { card: board.keyOf(card), reason: r.skipped });
      showCard(call, card);
      return r.taskId ? `${board.keyOf(card)} is back in work (task ${r.taskId}).` : `${board.keyOf(card)} waits in ${board.columnOf(card).name}: there is nobody to hand it back to.`;
    },
  });

  add({
    name: "allow",
    description: "Let kanban cards that hold outside content (an imported tracker's text, a page, a mail) run: only when the person says so. After outside content this asks them.",
    inputSchema: { type: "object", properties: { cards: { type: "array", items: { type: "string" } } }, required: ["cards"] },
    effect: "local-write",
    askWhenTainted: true,
    approvalSummary: "%approval.allow%",
    handler: (i, call) => {
      if (!Array.isArray(i.cards) || !i.cards.length) throw new KanbanError("cardsRequired");
      const list = i.cards.map((c: string) => board.card(c));
      for (const card of list) board.allow(card, { actor: call.agentId });
      return `Allowed ${list.map((c: Card) => board.keyOf(c)).join(", ")}.`;
    },
  });

  add({
    name: "delete",
    description: "Delete a kanban card, or a whole project with its cards, for good: only when the person asks. Archiving a project (kanban_project_save) keeps it. The person confirms on a card.",
    inputSchema: { type: "object", properties: { card: CARD, project: { type: "string" } } },
    effect: "external",
    approvalSummary: "%approval.delete%",
    handler: (i) => {
      if (i.card) {
        const card = board.card(i.card);
        const key = board.keyOf(card);
        if (work.taken(card)) throw new KanbanError("cardBusy", { card: key });
        files.removeAll(card);
        board.removeCard(card);
        return `Deleted ${key}.`;
      }
      if (!i.project) throw new KanbanError("deleteWhat");
      const p = board.project(i.project);
      const cards = board.cardsOf(p.id);
      const busy = cards.find((c) => work.taken(c));
      if (busy) throw new KanbanError("cardBusy", { card: board.keyOf(busy) });
      for (const c of cards) files.removeAll(c);
      board.removeProject(p);
      return `Deleted ${p.name} and its ${cards.length} cards.`;
    },
  });

  add({
    name: "pickup",
    description:
      "Agents taking kanban cards by themselves. With no input: how it stands. `on` is the switch for the whole board: change it only when the person asks. " +
      "A rule says what an agent takes: when the person tells an agent to take cards (\"take tasks from the Site project\"), set its rule (`agent` defaults to you): `projects` (empty: all), `labels`, `minPriority`, `parallel` (how many at once, default 1). `enabled: false` pauses it, `remove: true` deletes it. " +
      "It takes cards from queue columns, most urgent first, as long as nothing they wait for is open; a card holding outside content waits until the person allows it. It needs initiative Acts (2) and works within the agent's daily budget of background runs. Tell the person if the switch is off or the initiative too low.",
    inputSchema: {
      type: "object",
      properties: {
        on: { type: "boolean" },
        agent: { type: "string" },
        enabled: { type: "boolean" },
        projects: { type: "array", items: { type: "string" } },
        labels: { type: "array", items: { type: "string" } },
        minPriority: { type: "string", enum: [...PRIORITIES] },
        parallel: { type: "integer", minimum: 1 },
        remove: { type: "boolean" },
      },
    },
    effect: "local-write",
    askWhenTainted: true,
    handler: async (i, call) => {
      if (typeof i.on === "boolean") await pickup.setOn(i.on);
      const fields = ["enabled", "projects", "labels", "minPriority", "parallel"] as const;
      const changesRule = i.agent !== undefined || i.remove === true || fields.some((k) => i[k] !== undefined);
      if (changesRule) {
        const agent = await work.requireAgent(i.agent ?? call.agentId);
        if (i.remove === true) await pickup.removeRule(agent.id);
        else {
          const input: RuleInput = {};
          for (const k of fields) if (i[k] !== undefined) (input as any)[k] = i[k];
          await pickup.setRule(agent.id, input);
        }
      }
      return pickupText(board, pickup.on, pickup.views(await work.agents()));
    },
  });
}
