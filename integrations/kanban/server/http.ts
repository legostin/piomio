// What the board's page calls. Each request is the person's own hand; errors come back in their language.

import type { PluginHttpRequest, PluginHttpResponse } from "@piomio/plugin-sdk";
import { PERSON, type CardInput, type ProjectInput } from "./board.ts";
import { KanbanError } from "./errors.ts";
import type { RuleInput } from "./pickup.ts";
import type { Kit } from "./tools.ts";
import type { BoardState, Card, Tile } from "./types.ts";

const ok = (body: unknown, status = 200): PluginHttpResponse => ({ status, body });

async function state(k: Kit): Promise<BoardState> {
  const agents = await k.work.agents();
  const settings = await k.ctx.core.call<{ defaultAgent?: string }>("settings.get").catch(() => undefined);
  return {
    projects: k.board.projectList().map((p) => k.board.projectView(p)),
    agents: agents.map((a) => ({ id: a.id, name: a.name, initiative: a.initiative })),
    ...(settings?.defaultAgent ? { defaultAgent: settings.defaultAgent } : {}),
    pickup: { on: k.pickup.on, rules: k.pickup.views(agents) },
  };
}

function tiles(k: Kit, project: string | undefined): Tile[] {
  const list: Card[] = !project || project === "all" ? k.board.projectList().flatMap((p) => k.board.cardsOf(p.id)) : k.board.cardsOf(k.board.project(project).id);
  return list.map((c) => k.board.tile(c));
}

export async function handleHttp(k: Kit, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  if (req.public) return ok({ error: "not found" }, 404);
  const { board, work, pickup, files, ctx } = k;
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, "") || "/";
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const assignee = async (raw: unknown): Promise<string | null | undefined> => {
    if (raw === undefined) return undefined;
    if (!raw) return null;
    return raw === "me" ? "me" : (await work.requireAgent(String(raw))).id;
  };

  try {
    if (path === "/state" && method === "GET") return ok(await state(k));
    if (path === "/cards" && method === "GET") return ok({ cards: tiles(k, req.query.project) });

    if (path === "/projects" && method === "POST") {
      const p = board.createProject(body as ProjectInput);
      return ok(board.projectView(p), 201);
    }
    let m = /^\/projects\/([\w-]+)$/.exec(path);
    if (m) {
      const p = board.project(m[1]);
      if (method === "PATCH") return ok(board.projectView(board.updateProject(p, body as ProjectInput)));
      if (method === "DELETE") {
        const cards = board.cardsOf(p.id);
        const busy = cards.find((c) => work.taken(c));
        if (busy) throw new KanbanError("cardBusy", { card: board.keyOf(busy) });
        for (const c of cards) files.removeAll(c);
        board.removeProject(p);
        return ok({ ok: true });
      }
    }

    if (path === "/cards" && method === "POST") {
      const who = await assignee(body.assignee);
      const card = board.createCard({ ...(body as CardInput), ...(who !== undefined ? { assignee: who } : {}) }, PERSON);
      return ok(board.view(card), 201);
    }
    m = /^\/cards\/([\w-]+)$/.exec(path);
    if (m) {
      const card = board.card(m[1]);
      if (method === "GET") return ok(board.view(card));
      if (method === "PATCH") {
        const who = await assignee(body.assignee);
        const input: CardInput = { ...(body as CardInput) };
        if (who === undefined) delete input.assignee;
        else input.assignee = who;
        return ok(board.view(board.updateCard(card, input, PERSON)));
      }
      if (method === "DELETE") {
        if (work.taken(card)) throw new KanbanError("cardBusy", { card: board.keyOf(card) });
        files.removeAll(card);
        board.removeCard(card);
        return ok({ ok: true });
      }
    }
    m = /^\/cards\/([\w-]+)\/(move|comments|attachments|start|accept|return|allow)$/.exec(path);
    if (m && method === "POST") {
      const card = board.card(m[1]);
      const project = board.projects.get(card.projectId)!;
      switch (m[2]) {
        case "move":
          return ok(board.view(board.move(card, board.column(project, String(body.column ?? "")), { before: body.before, by: PERSON })));
        case "comments":
          board.comment(card, body.text, PERSON);
          return ok(board.view(card), 201);
        case "attachments":
          files.add(card, { name: body.name, mimeType: body.mimeType, data: Buffer.from(String(body.data ?? ""), "base64") }, PERSON);
          return ok(board.view(card), 201);
        case "start": {
          const agent = await work.requireAgent(String(body.agent ?? card.assignee ?? ""));
          const r = await work.start(card, agent.id, { mode: "person" }, { by: PERSON });
          if (r.skipped) throw new KanbanError("notStarted", { card: board.keyOf(card), reason: r.skipped });
          return ok(board.view(card));
        }
        case "accept":
          return ok(board.view(work.accept(card, PERSON)));
        case "return": {
          const r = await work.returnToWork(card, body.comment, { mode: "person" }, PERSON);
          if (r.skipped) throw new KanbanError("notStarted", { card: board.keyOf(card), reason: r.skipped });
          return ok(board.view(card));
        }
        case "allow":
          board.allow(card, PERSON);
          return ok(board.view(card));
      }
    }
    m = /^\/cards\/([\w-]+)\/attachments\/([\w-]+)$/.exec(path);
    if (m) {
      const card = board.card(m[1]);
      const a = files.find(card, m[2]);
      if (method === "GET") return ok({ name: a.name, mimeType: a.mimeType ?? "application/octet-stream", data: files.read(card, a).toString("base64") });
      if (method === "DELETE") {
        files.remove(card, a);
        return ok(board.view(card));
      }
    }

    if (path === "/pickup" && method === "PUT") {
      await pickup.setOn(body.on === true);
      return ok(await state(k));
    }
    m = /^\/pickup\/rules\/([\w-]+)$/.exec(path);
    if (m) {
      const agent = await work.requireAgent(m[1]);
      if (method === "PUT") await pickup.setRule(agent.id, body as RuleInput);
      else if (method === "DELETE") await pickup.removeRule(agent.id);
      else return ok({ error: "method not allowed" }, 405);
      return ok(await state(k));
    }
    return ok({ error: "not found" }, 404);
  } catch (e: any) {
    if (e instanceof KanbanError) return ok({ error: ctx.i18n.t(`error.${e.code}`, e.params, req.locale), code: e.code, params: e.params }, e.status);
    ctx.log.error(`${method} ${path} failed: ${e?.message ?? e}`);
    return ok({ error: e?.message ?? String(e) }, 500);
  }
}
