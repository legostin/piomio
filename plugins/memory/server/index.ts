// Builtin plugin "memory": the team's long-term memory about the user. Structured markdown facts (one per file) in
// <dataDir>/memory, versioned with git when available (hub replicas share the facts, not the rest: replicas.ts). Agents save facts as they learn them (memory_remember), the
// facts relevant to each turn are recalled into its input (turn.context), a nightly pass tidies memory and reflects on
// the day. Agents save, change and forget facts on their own, also after untrusted content: memory keeps every change
// in its history, and the user sees each one in the chat and on the Memory page, where it can be undone.
// Design: docs/superpowers/specs/2026-10-29-memory-design.md

import type { PluginContext, PluginHttpRequest, PluginHttpResponse, PluginModule } from "@piomio/plugin-sdk";
import type { Locale, ToolCallContext, ToolResult } from "@piomio/shared";
import { factNotFound, Memory, type Actor, type RememberResult } from "./memory.ts";
import { INDEX_FILE, KINDS, isCurrent, isKind, visibleTo, type Fact, type FactKind } from "./store.ts";
import { MemoryError, NotFoundError, PathError } from "./paths.ts";
import { factLine } from "./recall.ts";

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function factMeta(f: Fact): string {
  return [
    `path: ${f.path}`,
    `kind: ${f.kind}`,
    f.about.length ? `about: ${f.about.join(", ")}` : "",
    f.slot ? `slot: ${f.slot}` : "",
    `importance: ${f.importance}/5`,
    f.confidence < 1 ? `confidence: ${f.confidence}` : "",
    f.validFrom ? `since: ${f.validFrom}` : "",
    f.validUntil ? `until: ${f.validUntil}` : "",
    f.supersededBy ? `replaced by: ${f.supersededBy}` : "",
    f.scope !== "team" ? "only you" : "",
    f.status !== "active" ? `status: ${f.status}` : "",
    f.tags.length ? `tags: ${f.tags.join(", ")}` : "",
    f.updated ? `updated: ${f.updated}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A fact for the UI and the phone (FactView in the design doc). */
export function view(f: Fact) {
  const last = f.sources[f.sources.length - 1];
  return {
    path: f.path,
    title: f.title,
    text: f.body,
    kind: f.kind,
    about: f.about,
    slot: f.slot,
    tags: f.tags,
    importance: f.importance,
    confidence: f.confidence,
    validFrom: f.validFrom,
    validUntil: f.validUntil,
    supersededBy: f.supersededBy,
    supersedes: f.supersedes,
    scope: f.scope,
    sensitive: f.sensitive,
    status: f.status,
    created: f.created,
    updated: f.updated,
    source: last ? { agentId: last.agent, conversationId: last.conversation ?? "", sessionId: last.session ?? "", at: last.at, quote: last.quote ?? "" } : null,
  };
}

const sourceView = (f: Fact) => f.sources.map((s) => ({ agentId: s.agent, conversationId: s.conversation ?? "", sessionId: s.session ?? "", at: s.at, quote: s.quote ?? "" }));

const NOT_FOUND: PluginHttpResponse = { status: 404, body: { error: "Not found", code: "notFound", params: {} } };

/** First line of memory_remember's result: the chat line in the web UI reads the outcome and the path from it. */
function rememberText(r: RememberResult, mem: Memory): string {
  const lines: string[] = [];
  if (r.status === "known") lines.push(`Already known [${r.path}]: ${r.title}. Its confidence went up; nothing else to do.`);
  else lines.push(`Remembered [${r.path}]: ${r.title}.`);
  if (r.replaced.length) {
    lines.push("Replaced (kept in history as no longer true):");
    for (const p of r.replaced) lines.push(`- ${mem.store.facts.get(p)?.title ?? p} [${p}]`);
  }
  if (r.kept?.length) {
    lines.push(`Not replaced (longer notes hold many facts; update the part that changed with memory_write): ${r.kept.join(", ")}`);
  }
  if (r.related.length) {
    lines.push("Related facts already in memory (if one of them is now wrong, call memory_remember again with `replaces`):");
    for (const f of r.related) lines.push(factLine(f, 200));
  }
  return lines.join("\n");
}

const ACTIONS = new Set(["sync", "create", "update", "remember", "confirm", "edit", "forget", "restore", "undo", "approve", "reject", "tidy", "revert"]);

let memory: Memory | undefined;
let timers: NodeJS.Timeout[] = [];

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    let settings = ctx.settings ?? {};
    const mem = new Memory({
      dataDir: ctx.dataDir,
      storage: ctx.storage,
      git: settings.git !== false,
      promptMaxChars: typeof settings.promptMaxChars === "number" ? settings.promptMaxChars : 4000,
      recallMaxChars: typeof settings.recallMaxChars === "number" ? settings.recallMaxChars : 1500,
      // Undocumented diagnostics/test switch: force the substring fallback instead of FTS5.
      forceSubstringSearch: settings.searchMode === "substring",
      warn: (m) => ctx.log.warn(m),
      changed: (path, action) => ctx.ui.emit("changed", { path, action }),
    });
    memory = mem;
    await mem.start();
    ctx.onSettingsChange((s) => {
      settings = s ?? {};
      if (typeof s?.promptMaxChars === "number") mem.o.promptMaxChars = s.promptMaxChars;
      if (typeof s?.recallMaxChars === "number") mem.o.recallMaxChars = s.recallMaxChars;
    });

    /** The user's last words in each conversation: the quote a remembered fact came from. */
    const lastWords = new Map<string, string>();
    const actor = (call: ToolCallContext): Actor => ({ agentId: call.agentId, conversationId: call.conversationId, sessionId: call.sessionId, quote: lastWords.get(call.conversationId) });

    const t = (key: string, params: Record<string, string | number> = {}, locale?: Locale) => ctx.i18n.t(key, params, locale);

    /** Error for the UI and the phone: the message in the reader's language plus a code and params. */
    function fail(e: any, locale?: Locale): PluginHttpResponse {
      if (e instanceof MemoryError) {
        const key = `ui.error.${e.code}`;
        const said = t(key, e.params, locale);
        const status = e instanceof NotFoundError ? 404 : 400;
        return { status, body: { error: said !== key ? said : e.message, code: e.code, params: e.params } };
      }
      return { status: 500, body: { error: e?.message ?? String(e) } };
    }

    // ---------- the nightly pass ----------

    /** Ask the default agent to reflect on the user's messages since the last pass (a background task). */
    async function reflect(): Promise<boolean> {
      if (settings.reflect === false) return false;
      const entries = await mem.state.journalEntries();
      if (entries.length < 3) return false;
      const lines: string[] = [];
      let used = 0;
      for (const e of [...entries].reverse()) {
        const line = `- [${e.at.slice(0, 16).replace("T", " ")} UTC, to ${e.agent}] ${e.text.replace(/\s+/g, " ").slice(0, 600)}`;
        if (used + line.length > 9000) break;
        lines.unshift(line);
        used += line.length + 1;
      }
      const goal = [
        "Memory reflection: a quiet background pass, like sleep. Below are the user's own messages to the team since the last pass.",
        "Find durable facts about the user and their life that memory does not hold yet, or holds wrongly: who they are, the people, places and projects in their life, preferences, plans and dates, how they like things done.",
        "For each one: `memory_search` first; then `memory_remember` (with `replaces` when it corrects an older fact, `slot` for a changeable attribute). Skip small talk, one-off requests and anything secret. Do not message the user; when done, call `notify` with level silent.",
        "",
        "The user's messages:",
        ...lines,
      ].join("\n");
      try {
        // quiet: like a trigger's run it reports only through its own notify() (silent here), not "Task done".
        await ctx.core.call("tasks.create", { goal, title: t("task.reflect"), background: true, quiet: true });
      } catch (e: any) {
        ctx.log.warn(`memory reflection could not start: ${e?.message ?? e}`);
        return false;
      }
      await mem.state.clearJournal(entries);
      mem.state.set("lastReflect", new Date().toISOString());
      return true;
    }

    /** One pass at a time (the hourly check and the "Tidy up" button may meet). */
    let running: Promise<{ expired: number; merged: number; archived: number; reflection: boolean }> | undefined;
    async function nightly(force = false) {
      // Shared by the hubs: whichever leads at night tidies once for all of them.
      const last = Date.parse((await mem.state.get("lastTidy")) ?? "") || 0;
      if (!force && Date.now() - last < 20 * 3600_000) return undefined;
      running ??= (async () => {
        try {
          const r = await mem.tidy();
          return { ...r, reflection: await reflect() };
        } finally {
          running = undefined;
        }
      })();
      return running;
    }
    const check = () => void nightly().catch((e) => ctx.log.warn(`memory tidy failed: ${e?.message ?? e}`));
    timers = [setTimeout(check, 2 * 60_000), setInterval(check, 60 * 60_000)];
    for (const tm of timers) tm.unref?.();

    // ---------- tools ----------

    ctx.tools.register({
      name: "remember",
      description:
        "Save one durable fact about the user or their life to the team's long-term memory, the moment you learn it. " +
        "Write it as one self-contained statement in the third person (\"The user's sister Anna lives in Perm\"). " +
        "Memory checks it against what is known: a duplicate only raises confidence; a fact with the same subject and `slot`, or the paths in `replaces`, is superseded (kept in history as no longer true). " +
        "Mark sensitive facts (health, money, beliefs, documents) with `sensitive`. Never pass secrets (passwords, tokens, card numbers): those live in the vault.",
      effect: "local-write",
      approvalSummary: "%approval.remember%",
      inputSchema: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The fact: one self-contained statement, third person." },
          kind: { type: "string", enum: [...KINDS], description: "self (about the user), preference, person, place, project, event (dated: plans, birthdays, trips), howto (how the user likes things done), note." },
          about: { type: "array", items: { type: "string" }, description: "People, places, projects the fact names (e.g. [\"Anna\", \"Perm\"])." },
          slot: { type: "string", description: "A changeable attribute this fact sets, e.g. \"home city\", \"job\", \"coffee order\": a newer fact with the same subject and slot replaces this one." },
          importance: { type: "integer", minimum: 1, maximum: 5, description: "1 trivia … 5 core to who the user is. Default by kind." },
          when: { type: "string", description: "When it became true or happens (YYYY-MM-DD), for events and changes." },
          until: { type: "string", description: "When it stops being true (YYYY-MM-DD), e.g. the end of a trip." },
          scope: { type: "string", enum: ["team", "me"], description: "team (default): every agent knows it; me: only you." },
          replaces: { type: "array", items: { type: "string" }, description: "Paths of facts this one corrects or replaces." },
          sensitive: { type: "boolean", description: "True for health, money, beliefs, intimate or legal matters." },
          title: { type: "string", description: "Optional short title (default: the fact's first words)." },
        },
        required: ["fact"],
        additionalProperties: false,
      },
      handler: async (input: any, call: ToolCallContext) => {
        try {
          const r = await mem.remember(input ?? {}, actor(call));
          return text(rememberText(r, mem));
        } catch (e: any) {
          return text(e?.message ?? String(e), true);
        }
      },
    });

    ctx.tools.register({
      name: "search",
      description:
        "Search the team's long-term memory about the user (ranked by relevance, entities, importance and recency). Returns facts with their paths; " +
        "use memory_read for details and history. Search before asking the user something they may have told you already.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for (names, topics, preferences, a question)." },
          kind: { type: "string", enum: [...KINDS], description: "Only facts of this kind." },
          include_archived: { type: "boolean", description: "Also facts that are no longer true (replaced, expired): what was true before." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 10)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: (input: { query?: string; limit?: number; kind?: string; include_archived?: boolean }, call: ToolCallContext) => {
        const query = String(input.query ?? "").trim();
        if (!query) return text("Error: query is required", true);
        const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10) || 10));
        const kinds = isKind(input.kind) ? [input.kind as FactKind] : undefined;
        let hits = mem.find(query, { agentId: call.agentId, limit, includeArchived: input.include_archived === true, kinds }).map((s) => s.fact);
        // Exact words the ranking may not weigh (a file name, a rare spelling): the full-text index.
        if (hits.length < limit) {
          for (const h of mem.search(query, limit)) {
            const f = mem.store.facts.get(h.path);
            if (f && visibleTo(f, call.agentId) && (!kinds || kinds.includes(f.kind)) && !hits.includes(f)) hits.push(f);
          }
          hits = hits.slice(0, limit);
        }
        if (!hits.length) return text(`No facts match "${query}".`);
        return text(hits.map((f) => `${factLine(f, 300)}${isCurrent(f) ? "" : f.supersededBy ? ` (no longer true: replaced by ${f.supersededBy})` : " (no longer true)"}`).join("\n"));
      },
    });

    ctx.tools.register({
      name: "read",
      description: 'Read one memory fact by path (e.g. "people/anna.md", "profile.md") with its details and what it replaced, or "MEMORY.md" for the index of all facts.',
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Fact path relative to the memory root." } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: (input: { path?: string }, call: ToolCallContext) => {
        if (String(input.path ?? "").trim() === INDEX_FILE) return text(mem.store.raw(INDEX_FILE) ?? mem.store.indexMarkdown());
        const { path, fact, review } = mem.get(String(input.path ?? ""));
        if (fact && visibleTo(fact, call.agentId)) {
          const note = review ? "\n\n[A newer version of this fact is waiting for the user's review.]" : "";
          const before = mem.before(fact);
          const history = before.length ? `\n\nBefore:\n${before.map((b) => `- until ${b.validUntil || b.updated.slice(0, 10)}: ${b.body.replace(/\s+/g, " ").slice(0, 200)} [${b.path}]`).join("\n")}` : "";
          return text(`# ${fact.title}\n${factMeta(fact)}\n\n${fact.body || "(empty)"}${history}${note}`);
        }
        if (review && visibleTo(review, call.agentId)) return text(`[Pending review: not approved by the user yet]\n# ${review.title}\n${factMeta(review)}\n\n${review.body || "(empty)"}`);
        return text(`Error: no fact at ${path}. Use memory_search or memory_list to find facts.`, true);
      },
    });

    ctx.tools.register({
      name: "list",
      description: 'List memory facts (title, path), optionally only of one kind or inside one folder such as "people" or "notes".',
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Folder relative to the memory root; omit for everything." },
          kind: { type: "string", enum: [...KINDS], description: "Only facts of this kind." },
        },
        additionalProperties: false,
      },
      handler: (input: { dir?: string; kind?: string }, call: ToolCallContext) => {
        const { dir, groups, review } = mem.list(input.dir);
        const lines: string[] = [];
        let n = 0;
        for (const g of groups) {
          const facts = g.facts.filter((f) => visibleTo(f, call.agentId) && (!isKind(input.kind) || f.kind === input.kind));
          if (!facts.length) continue;
          lines.push(`${g.dir || "(root)"}:`);
          for (const f of facts) {
            if (n++ >= 500) break;
            lines.push(`- ${f.path} — ${f.title}${f.about.length ? ` (${f.about.join(", ")})` : ""}`);
          }
        }
        if (!lines.length) lines.push(dir ? `No facts in ${dir}/.` : "Memory is empty.");
        if (n > 500) lines.push(`… ${n - 500} more`);
        if (review) lines.push("", `${review} fact(s) are waiting for the user's review (not listed, not searchable).`);
        return text(lines.join("\n"));
      },
    });

    ctx.tools.register({
      name: "write",
      description:
        "Write or update a longer note in memory by path (markdown), e.g. a profile, a person's page or a project's notes. " +
        "For single facts use memory_remember instead. Without `path` a new note is created in notes/. Pass an existing path to update it: `content` replaces the old text, " +
        "so include everything that should stay (read it first). Never store passwords, tokens or other secrets.",
      effect: "local-write",
      approvalSummary: "%approval.write%",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Optional fact path, e.g. "people/anna.md" or "profile.md" (must end with .md).' },
          title: { type: "string", description: "Short title of the fact." },
          content: { type: "string", description: "Markdown text of the fact." },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
      handler: async (input: { path?: string; title?: string; content?: string; tags?: string[] }, call: ToolCallContext) => {
        const r = await mem.write(
          { path: input.path, title: String(input.title ?? ""), content: String(input.content ?? ""), tags: input.tags },
          { source: `${call.agentId}/${call.sessionId}`, actor: actor(call) },
        );
        return text(`${r.status === "created" ? "Created" : "Updated"} ${r.path}.`);
      },
    });

    ctx.tools.register({
      name: "forget",
      description: "Forget a fact by path when the user asks (it leaves memory now; the user can undo it, and the history keeps it).",
      effect: "local-write",
      approvalSummary: "%approval.forget%",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Fact path, e.g. notes/old-plan.md." } },
        required: ["path"],
        additionalProperties: false,
      },
      handler: async (input: { path?: string }) => {
        const r = await mem.forget(String(input.path ?? ""));
        return text(`Forgot [${r.path}]: ${r.title}.`);
      },
    });

    // ---------- hooks ----------

    ctx.hooks.on("session.start", (p) => ({ appendSystemPrompt: mem.sessionPrompt(p?.sessionId, p?.agentId) }));

    ctx.hooks.on("turn.context", (p) => {
      if (!p?.sessionId) return;
      const words = String(p.text ?? "");
      if (p.fromUser && !p.background && p.conversationId) {
        // In a group chat every member answering the same message hears it: journaled once.
        const again = lastWords.get(p.conversationId) === words.slice(0, 600);
        lastWords.set(p.conversationId, words.slice(0, 600));
        if (lastWords.size > 300) lastWords.delete(lastWords.keys().next().value!);
        if (!again && words.trim().length >= 12) mem.state.journal({ at: new Date().toISOString(), agent: p.agentId, conversation: p.conversationId, text: words.slice(0, 2000) });
      }
      const context = mem.turnContext(p.sessionId, p.agentId, words);
      return context ? { context } : undefined;
    });

    // ---------- HTTP for the UI and the phone ----------

    const factsBody = (req: PluginHttpRequest) => {
      const q = String(req.query.q ?? "").trim();
      const status = String(req.query.status ?? "active");
      const kind = isKind(req.query.kind) ? (req.query.kind as FactKind) : undefined;
      const limit = Math.max(1, Math.min(2000, Number(req.query.limit ?? 1000) || 1000));
      let facts: Fact[];
      if (q) facts = mem.find(q, { limit: Math.min(limit, 100), includeArchived: status !== "active", kinds: kind ? [kind] : undefined }).map((s) => s.fact);
      else {
        facts = [...mem.store.facts.values()]
          .filter((f) => (status === "all" ? true : status === "archived" ? !isCurrent(f) : isCurrent(f)) && (!kind || f.kind === kind))
          .sort((a, b) => b.importance - a.importance || b.updated.localeCompare(a.updated))
          .slice(0, limit);
      }
      if (q && status === "archived") facts = facts.filter((f) => !isCurrent(f));
      return { facts: facts.map(view), review: mem.store.review.size, counts: mem.counts(), archived: [...mem.store.facts.values()].filter((f) => !isCurrent(f)).length };
    };

    const historyOf = async (path: string, locale: Locale) =>
      (await mem.git.history(path)).map((h) => {
        const action = /^memory: (\w+)/.exec(h.message)?.[1] ?? "";
        const known = ACTIONS.has(action) ? action : "update";
        return { rev: h.rev, at: h.at, action: known, message: t(`history.${known}`, {}, locale) };
      });

    ctx.http.handle(async (req: PluginHttpRequest): Promise<PluginHttpResponse> => {
      if (req.public) return NOT_FOUND;
      const body = (req.body ?? {}) as Record<string, any>;
      const route = `${req.method.toUpperCase()} ${req.path.replace(/\/+$/, "") || "/"}`;
      const locale = req.locale;
      try {
        switch (route) {
          // ----- v2 -----
          case "GET /facts":
            return { status: 200, body: factsBody(req) };
          case "GET /fact": {
            const { path, fact, review } = mem.get(String(req.query.path ?? ""));
            const f = fact ?? review;
            if (!f) return fail(factNotFound(path), locale);
            return { status: 200, body: { fact: { ...view(f), sources: sourceView(f) }, before: mem.before(f).map(view), history: await historyOf(path, locale), pendingReview: !!(fact && review) } };
          }
          case "PATCH /fact":
            return { status: 200, body: { fact: view(await mem.edit(String(body.path ?? ""), body)) } };
          case "POST /forget":
            return { status: 200, body: await mem.forget(String(body.path ?? "")) };
          case "POST /restore":
            return { status: 200, body: { fact: view(await mem.restore(String(body.path ?? ""))) } };
          case "POST /undo":
            return { status: 200, body: await mem.undo(String(body.path ?? "")) };
          case "GET /trash":
            return { status: 200, body: { facts: mem.store.trashed().slice(0, 50).map((f) => ({ ...view(f), trashedAt: f.trashedAt })) } };
          case "GET /history":
            return { status: 200, body: { history: await historyOf(mem.get(String(req.query.path ?? "")).path, locale) } };
          case "POST /revert":
            return { status: 200, body: { fact: view(await mem.revert(String(body.path ?? ""), String(body.rev ?? ""))) } };
          case "POST /tidy":
            return { status: 200, body: (await nightly(true))! };
          case "GET /export": {
            const all = [...mem.store.facts.values(), ...mem.store.review.values()].sort((a, b) => a.path.localeCompare(b.path));
            const date = new Date().toISOString().slice(0, 10);
            return {
              status: 200,
              headers: { "content-disposition": `attachment; filename="piomio-memory-${date}.json"` },
              body: { exportedAt: new Date().toISOString(), version: 2, facts: all.map((f) => ({ ...view(f), sources: sourceView(f), raw: mem.serialize(f) })) },
            };
          }
          // ----- review -----
          case "GET /review":
            return {
              status: 200,
              body: {
                items: mem.reviewItems().map((r) => {
                  const current = mem.store.facts.get(r.path);
                  return { ...view(r), body: r.body, inPlace: r.inPlace, current: current && !r.inPlace ? { ...view(current), body: current.body } : undefined };
                }),
              },
            };
          case "POST /review/approve":
            return { status: 200, body: view(await mem.approve(String(body.path ?? ""))) };
          case "POST /review/reject":
            return { status: 200, body: await mem.reject(String(body.path ?? "")) };
          // ----- v1 (raw files) -----
          case "GET /tree":
            return { status: 200, body: mem.tree() };
          case "GET /file": {
            const p = String(req.query.path ?? "");
            if (p === INDEX_FILE) return { status: 200, body: { path: INDEX_FILE, title: "Memory index", raw: mem.store.raw(INDEX_FILE) ?? "", body: mem.store.raw(INDEX_FILE) ?? "", generated: true } };
            const { path, fact, review } = mem.get(p);
            const f = req.query.review === "1" ? review : (fact ?? review);
            if (!f) return fail(factNotFound(path), locale);
            return { status: 200, body: { ...f, raw: mem.serialize(f), pendingReview: !!review } };
          }
          case "PUT /file": {
            const f = await mem.putRaw(String(body.path ?? ""), String(body.content ?? ""));
            return { status: 200, body: { ...f, raw: mem.serialize(f) } };
          }
          case "DELETE /file":
            return { status: 200, body: await mem.forget(String(req.query.path ?? body.path ?? "")) };
          case "GET /search":
            return { status: 200, body: { results: mem.search(String(req.query.q ?? ""), Number(req.query.limit ?? 20)) } };
          default:
            return NOT_FOUND;
        }
      } catch (e) {
        return fail(e, locale);
      }
    });
  },

  async deactivate() {
    for (const tm of timers) clearTimeout(tm);
    timers = [];
    await memory?.stop();
  },
};

export default plugin;
