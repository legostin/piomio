// The authenticated hub API, shared by the web UI (cookie sessions, port 8080) and the phones (device port, bearer
// tokens). The caller adds its own auth hook first; everything here assumes the request comes from the owner.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AgentDef, TaskStatus } from "@piomio/shared";
import { formatBrainRef, GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS, isWorkKind, LOCALES, parseBrainRef, type Locale, type ThinkingPatch } from "@piomio/shared";
import { hubLocale, localizePluginValue, requestLocale, tFor } from "../i18n.ts";
import type { Hub } from "../app.ts";
import { toUiEvent } from "../bus.ts";
import { agentFromMarkdown, localizedAgent, patchAgent } from "../agents.ts";
import { draftPatch } from "../agent-drafts.ts";
import { applyThinking } from "../thinking.ts";
import { pipeToLeader } from "./forward.ts";
import { attachmentDisposition, HttpError, safeFile, sendFile } from "./http.ts";
import { UpdateError } from "../self-update.ts";
import { imageFileName, MediaError } from "../media.ts";
import { entryRef, googleScopes, listCatalog, listIntegrations, logoFile } from "../integrations.ts";
import { callbackParams } from "../connections.ts";
import { machineHubUrl, qrSvg } from "../pairing.ts";
import { attachmentFromPath, discardAttachment, formatSize, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, saveAttachment, type AttachmentPart } from "../attachments.ts";

export interface ApiOptions {
  kind: "web" | "device";
  /** Extra fields for /api/bootstrap: the web UI's CSRF token, the phone's own device. */
  bootstrap(req: FastifyRequest): Record<string, unknown>;
  /** May this request open the realtime socket (the web UI checks Origin). */
  wsAllowed(req: FastifyRequest): boolean;
  /** Every realtime socket as it opens (the device port closes a revoked phone's sockets). */
  onSocket?(socket: WebSocket, req: FastifyRequest): void;
  /** The caller's auth hook: a file upload runs it before its body (up to 25 MB) is read. */
  authenticate(req: FastifyRequest): Promise<void>;
}

export async function registerApi(api: FastifyInstance, hub: Hub, opts: ApiOptions): Promise<void> {
  const cfg = hub.config;

  api.get("/api/bootstrap", async (req) => {
    const s = hub.settings.get();
    return {
      ...opts.bootstrap(req),
      version: cfg.version,
      publicUrl: cfg.publicUrl,
      consoleUrl: cfg.consoleUrl,
      // The default agent's dialog: what "/" opens.
      mainConversationId: hub.store.agentConversation(s.defaultAgent).id,
      defaultAgent: s.defaultAgent,
      timezone: s.timezone,
      language: s.language,
      locales: LOCALES,
      vaultState: hub.vault.state(),
      // Model access through API keys (PIOMIO_API_KEYS=1): the brain pages may offer keys.
      apiKeys: cfg.apiKeys,
      // A new hub: the app shows only the setup card until a brain works, then the assistant opens the intro.
      firstRun: hub.setup.firstRun(),
      pendingApprovals: hub.approvals.pendingCount(),
      inboxUnread: hub.notifier.unreadCount(),
      uiPlugins: hub.plugins.uiPlugins(requestLocale(req)),
      channels: hub.channels.list(),
    };
  });

  // ----- conversations -----
  /** A group's members as given: agents on the team, 2–8 of them, each once; the lead first. */
  const groupMembers = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) throw new HttpError(400, "group.memberCount", { min: GROUP_MIN_MEMBERS, max: GROUP_MAX_MEMBERS });
    const ids = raw as string[];
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "group.duplicateMember");
    if (ids.length < GROUP_MIN_MEMBERS || ids.length > GROUP_MAX_MEMBERS) throw new HttpError(400, "group.memberCount", { min: GROUP_MIN_MEMBERS, max: GROUP_MAX_MEMBERS });
    const missing = ids.find((id) => !hub.agents.get(id));
    if (missing) throw new HttpError(400, "group.unknownMember", { id: missing });
    return ids;
  };
  const title = (v: unknown) => String(v ?? "").trim().slice(0, 120);
  api.get("/api/conversations", async () => hub.store.listConversations(200));
  api.post("/api/conversations", async (req) => {
    const b = (req.body ?? {}) as { kind?: string; title?: string; agentId?: string; members?: unknown };
    if (b.kind === "group") {
      const members = groupMembers(b.members);
      return hub.store.createConversation({ kind: "group", title: title(b.title) || tFor(requestLocale(req))("group.newTitle"), agentId: members[0], members });
    }
    const agentId = b.agentId && hub.agents.get(b.agentId) ? b.agentId : hub.settings.get().defaultAgent;
    return hub.store.createConversation({ kind: "chat", title: String(b.title || tFor(requestLocale(req))("conversation.newTitle")), agentId });
  });
  api.patch("/api/conversations/:id", async (req) => {
    const b = (req.body ?? {}) as { title?: string; agentId?: string; members?: unknown };
    if (b.agentId && !hub.agents.get(b.agentId)) throw new HttpError(400, "agent.notFound");
    const prev = hub.store.getConversation((req.params as any).id);
    if (!prev) throw new HttpError(404, "conversation.notFound");
    if (b.members !== undefined && prev.kind !== "group") throw new HttpError(400, "group.notGroup");
    if (prev.kind === "group") {
      // A group's lead is its first member: a new lead (agentId) moves to the front.
      const members =
        b.members !== undefined
          ? groupMembers(b.members)
          : b.agentId !== undefined
            ? groupMembers([b.agentId, ...(prev.members ?? []).filter((id) => id !== b.agentId)])
            : undefined;
      const name = b.title !== undefined ? title(b.title) : undefined;
      return hub.store.updateConversation(prev.id, { ...(name ? { title: name } : {}), ...(members ? { members } : {}) });
    }
    // An agent's dialog belongs to that agent.
    if (prev.kind === "main" && b.agentId !== undefined && b.agentId !== prev.agentId) throw new HttpError(400, "conversation.agentFixed");
    return hub.store.updateConversation(prev.id, { title: b.title, agentId: b.agentId });
  });
  api.post("/api/conversations/:id/read", async (req) => {
    const id = (req.params as any).id as string;
    if (!hub.store.getConversation(id)) throw new HttpError(404, "conversation.notFound");
    const at = (req.body as { at?: unknown } | undefined)?.at;
    const unread = hub.notifier.unreadCount();
    hub.team.markRead(id, typeof at === "string" ? at : undefined);
    // Reading the chat reads what the Inbox holds from it: the badges follow when the count moved.
    hub.notifier.inboxChanged(unread);
    return { ok: true };
  });
  // "Mark unread" in the agent's menu: its last message counts as unread again until the dialog is read.
  api.post("/api/conversations/:id/unread", async (req) => {
    const id = (req.params as any).id as string;
    if (!hub.store.getConversation(id)) throw new HttpError(404, "conversation.notFound");
    const unread = hub.notifier.unreadCount();
    hub.team.markUnread(id);
    hub.notifier.inboxChanged(unread);
    return { ok: true };
  });
  api.get("/api/conversations/:id/messages", async (req) => {
    const q = req.query as { before?: string; limit?: string };
    return hub.store.listMessages((req.params as any).id, { before: q.before, limit: Math.min(Number(q.limit ?? 100), 500) });
  });
  api.post("/api/conversations/:id/messages", async (req) => {
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as { text?: string; attachments?: unknown };
    const text = String(b.text ?? "").trim();
    // Paths from POST .../attachments: only this conversation's own files.
    const paths = Array.isArray(b.attachments) ? [...new Set(b.attachments)] : [];
    if (paths.length > MAX_ATTACHMENTS) throw new HttpError(400, "attachment.tooMany", { max: MAX_ATTACHMENTS });
    const attachments: AttachmentPart[] = [];
    if (paths.length) {
      const conv = hub.store.getConversation(id);
      if (!conv) throw new HttpError(404, "conversation.notFound");
      for (const p of paths) {
        const part = attachmentFromPath(join(cfg.dataDir, "workspaces"), conv, p);
        if (!part) throw new HttpError(400, "attachment.invalid");
        attachments.push(part);
      }
    }
    if (!text && !attachments.length) throw new HttpError(400, "message.empty");
    return hub.runner.userMessage(id, text, { channel: opts.kind === "device" ? "app" : "web", ...(attachments.length ? { attachments } : {}) });
  });
  // A quick reply tapped (a `choices` part): it becomes the person's message.
  api.post("/api/messages/:id/choose", async (req) => {
    const b = (req.body ?? {}) as { index?: unknown };
    const sent = await hub.runner.choose((req.params as { id: string }).id, Number(b.index), opts.kind === "device" ? "app" : "web");
    if (!sent) throw new HttpError(409, "choice.unavailable");
    return sent;
  });
  // A file for the next message: raw bytes, saved in the conversation's workspace (attachments/).
  await api.register(async (up) => {
    // Signed in before a 25 MB body is read, not after.
    up.addHook("onRequest", opts.authenticate);
    up.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES }, (_req, body, done) => done(null, body));
    up.setErrorHandler((err: any) => {
      throw err?.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? new HttpError(413, "attachment.tooLarge", { max: formatSize(MAX_ATTACHMENT_BYTES) }) : err;
    });
    up.post("/api/conversations/:id/attachments", { bodyLimit: MAX_ATTACHMENT_BYTES }, async (req) => {
      const conv = hub.store.getConversation((req.params as any).id);
      if (!conv) throw new HttpError(404, "conversation.notFound");
      if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "attachment.notBytes");
      if (!req.body.length) throw new HttpError(400, "attachment.empty");
      const q = req.query as { name?: string; type?: string };
      return saveAttachment(join(cfg.dataDir, "workspaces"), conv, { name: q.name, mimeType: q.type, data: req.body });
    });
  });
  // A file uploaded for the next message and taken back before it was sent.
  api.delete("/api/conversations/:id/attachments", async (req) => {
    const conv = hub.store.getConversation((req.params as any).id);
    if (!conv) throw new HttpError(404, "conversation.notFound");
    const path = (req.query as { path?: unknown }).path;
    return { removed: discardAttachment(join(cfg.dataDir, "workspaces"), conv, path, (p) => hub.store.messagesMention(conv.id, JSON.stringify(p))) };
  });
  api.post("/api/conversations/:id/interrupt", async (req) => ({ interrupted: hub.runner.interrupt((req.params as any).id) }));
  // The person opened the dialog or is typing: its brain gets ready ahead of the message (runner.warm), in the background.
  api.post("/api/conversations/:id/warm", async (req) => {
    void hub.runner.warm((req.params as any).id);
    return { ok: true };
  });
  // The buttons on an approval card in the chat: allow (once, or always: a rule from the card), or deny.
  api.post("/api/approvals/:id", async (req) => {
    const b = (req.body ?? {}) as { decision?: unknown; remember?: unknown };
    if (b.decision !== "approve" && b.decision !== "deny") throw new HttpError(400, "decision: approve | deny");
    const a = hub.approvals.resolve((req.params as { id: string }).id, b.decision, {
      via: opts.kind === "device" ? "device" : "web",
      remember: b.decision === "approve" && b.remember === true,
    });
    return { id: a.id, status: a.status };
  });

  // ----- team: every agent with its long-lived dialog (created on first listing), and the group chats -----
  api.get("/api/team", async () => hub.team.list());
  api.get("/api/groups", async () => hub.team.listGroups());

  // ----- setup chats: "New channel", "Add agent" (setup-chats.ts) -----
  api.post("/api/setup-chats", async (req) => {
    const purpose = (req.body as { purpose?: unknown } | undefined)?.purpose;
    if (purpose !== "feed" && purpose !== "agent") throw new HttpError(400, "setup.badPurpose");
    return hub.setupChats.start(purpose, requestLocale(req));
  });

  // ----- pages agents make (pages.ts): their cards in the chat; the pages themselves are at their links -----
  api.get("/api/pages", async () => hub.pages.list());
  api.get("/api/pages/:id", async (req) => {
    const p = hub.pages.get((req.params as { id: string }).id);
    if (!p) throw new HttpError(404, "pages.notFound");
    return p;
  });

  // ----- channels (feeds.ts): news an agent of the team gathers on a schedule -----
  api.get("/api/feeds", async () => hub.feeds.list());
  api.post("/api/feeds", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return hub.feeds.create({ title: b.title, brief: b.brief, agentId: b.agentId, times: b.times, weekdays: b.weekdays, enabled: b.enabled });
  });
  const feed = (req: FastifyRequest) => {
    const f = hub.feeds.get((req.params as { id: string }).id);
    if (!f) throw new HttpError(404, "feed.notFound");
    return f;
  };
  api.get("/api/feeds/:id", async (req) => feed(req));
  api.patch("/api/feeds/:id", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return hub.feeds.update(feed(req).id, { title: b.title, brief: b.brief, agentId: b.agentId, times: b.times, weekdays: b.weekdays, enabled: b.enabled });
  });
  api.delete("/api/feeds/:id", async (req) => {
    hub.feeds.delete(feed(req).id);
    return { ok: true };
  });
  api.get("/api/feeds/:id/posts", async (req) => {
    const q = req.query as { before?: string; limit?: string };
    return hub.feeds.posts(feed(req).id, { before: q.before, limit: q.limit ? Number(q.limit) : undefined });
  });
  api.post("/api/feeds/:id/read", async (req) => {
    hub.feeds.markRead(feed(req).id);
    return { ok: true };
  });
  api.post("/api/feeds/:id/run", async (req) => {
    const task = hub.feeds.run(feed(req).id);
    return { taskId: task.id };
  });

  // ----- tasks -----
  api.get("/api/tasks", async (req) => {
    const q = req.query as { status?: string; limit?: string };
    return hub.store.listTasks({ status: q.status ? (q.status.split(",") as TaskStatus[]) : undefined, limit: Math.min(Number(q.limit ?? 200), 1000) });
  });
  api.post("/api/tasks", async (req) => {
    const b = (req.body ?? {}) as { goal?: string; title?: string; agentId?: string; background?: boolean };
    const goal = String(b.goal ?? "").trim();
    if (!goal) throw new HttpError(400, "task.goalRequired");
    const agentId = b.agentId && hub.agents.get(b.agentId) ? b.agentId : hub.settings.get().defaultAgent;
    return hub.runner.createTask({ agentId, goal, title: String(b.title || goal.slice(0, 60)), background: b.background ?? false, createdBy: "user" });
  });
  api.get("/api/tasks/:id", async (req) => {
    const t = hub.store.getTask((req.params as any).id);
    if (!t) throw new HttpError(404, "task.notFound");
    return t;
  });
  api.post("/api/tasks/:id/cancel", async (req) => hub.runner.cancelTask((req.params as any).id) ?? { error: "not found" });
  api.post("/api/tasks/:id/retry", async (req) => hub.runner.retryTask((req.params as any).id) ?? { error: "not found" });

  // ----- agents -----
  // The team and the archive: archived agents carry `archived` (their dialog still opens, to bring them back).
  api.get("/api/agents", async (req) => {
    const locale = requestLocale(req);
    return hub.agents.all().map((a) => ({ ...localizedAgent(a, locale), ...(hub.agents.isArchived(a.id) ? { archived: true } : {}) }));
  });
  api.put("/api/agents/:id", async (req) => {
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as Partial<AgentDef> & { markdown?: string };
    // The editor showed the name and description in the reader's language: edits to a translated
    // agent go into that translation, so the other languages keep theirs.
    const base = hub.agents.get(id) ?? agentFromMarkdown(id, "", "user");
    const agent: AgentDef = b.markdown ? agentFromMarkdown(id, b.markdown, "user") : { ...patchAgent(base, b, requestLocale(req)), id, source: "user" };
    return hub.saveAgent(agent, "user");
  });
  // The agent's menu in the list (web, desktop, phone). The default agent leaves only with a successor in its place.
  api.delete("/api/agents/:id", async (req) => {
    const successor = (req.query as { successor?: string }).successor;
    return { ok: true, ...hub.deleteAgent((req.params as any).id as string, { successor: successor || undefined }, "user") };
  });
  api.post("/api/agents/:id/archive", async (req) => {
    const b = (req.body ?? {}) as { archived?: unknown; successor?: unknown };
    const successor = typeof b.successor === "string" && b.successor ? b.successor : undefined;
    return { ok: true, ...hub.archiveAgent((req.params as any).id as string, b.archived !== false, { successor }, "user") };
  });
  api.post("/api/agents/:id/pin", async (req) => {
    hub.pinAgent((req.params as any).id as string, (req.body as { pinned?: unknown } | undefined)?.pinned !== false, "user");
    return { ok: true };
  });
  // How the agent thinks for each kind of work: the header picker, the chat card and the phone.
  api.get("/api/agents/:id/thinking", async (req) => {
    const a = hub.agents.get((req.params as any).id);
    if (!a) throw new HttpError(404, "agent.notFound");
    return hub.thinkingView(a);
  });
  api.put("/api/agents/:id/thinking/:kind", async (req) => {
    const { id, kind } = req.params as { id: string; kind: string };
    const a = hub.agents.get(id);
    if (!a) throw new HttpError(404, "agent.notFound");
    if (!isWorkKind(kind)) throw new HttpError(400, "thinking.badKind");
    const b = (req.body ?? {}) as ThinkingPatch;
    const now = (await hub.thinkingView(a)).kinds.find((k) => k.kind === kind)?.brain;
    const saved = hub.saveAgent({ ...applyThinking(a, kind, b, now), source: "user" }, "user");
    return hub.thinkingView(saved);
  });

  // ----- new agents put together in the chat (the card) -----
  api.get("/api/agent-drafts/:id", async (req) => {
    const d = hub.agentDrafts.get((req.params as any).id);
    if (!d) throw new HttpError(404, "agentDraft.notFound");
    return d;
  });
  // In the card the user picks the look and the proactivity; everything else they say in words.
  api.patch("/api/agent-drafts/:id", async (req) => {
    const patch = draftPatch((req.body ?? {}) as Record<string, unknown>, ["avatar", "initiative"]);
    return hub.agentDrafts.update((req.params as any).id, patch);
  });
  api.post("/api/agent-drafts/:id/create", async (req) => {
    const agent = hub.createAgentFromDraft((req.params as any).id, "user");
    const draft = hub.agentDrafts.get((req.params as any).id)!;
    hub.runner.noteAndContinue(
      draft.conversationId,
      `[System] The user pressed Create in the card: agent “${agent.name}” (id ${agent.id}) is on the team now, with its own dialog in the sidebar. ` +
        "Say so in one short sentence; do not call hub_agent_draft for it again.",
    );
    return { draft, agent: localizedAgent(agent, requestLocale(req)) };
  });

  // ----- brains -----
  api.get("/api/brains", async (req) => {
    const fresh = (req.query as any).probe === "1";
    const listed = hub.brains.list();
    const refs = new Map<string, { ref: string; label: string; host?: string; login?: boolean }>();
    for (const b of listed) refs.set(b.ref, { ref: b.ref, label: b.label, host: b.host, login: b.login });
    for (const a of hub.agents.list()) for (const r of a.brains) {
      // "api:*" stands for the providers listed above, not for a brain of its own.
      if (r.includes(":*")) continue;
      const key = formatBrainRef(parseBrainRef(r));
      if (!refs.has(key)) refs.set(key, { ref: key, label: key });
    }
    const limits = new Map((hub.db.prepare("select brain_ref, until, detail from brain_limits").all() as any[]).map((r) => [r.brain_ref, r]));
    return Promise.all(
      [...refs.values()].map(async (b) => {
        const connected = hub.brains.has(b.ref);
        const probe = connected ? await hub.brains.probe(b.ref, fresh ? 0 : 5 * 60_000) : undefined;
        const lim = limits.get(b.ref);
        return { ...b, connected, probe, limitedUntil: lim && Date.parse(lim.until) > Date.now() ? lim.until : undefined, limitDetail: lim?.detail };
      }),
    );
  });
  api.post("/api/brains/probe", async (req) => {
    const ref = String((req.body as any)?.ref ?? "");
    hub.brains.invalidate(ref);
    return hub.brains.probe(ref, 0);
  });
  api.delete("/api/brains/limits/:ref", async (req) => {
    hub.db.prepare("delete from brain_limits where brain_ref = ?").run(decodeURIComponent((req.params as any).ref));
    hub.bus.emit("brains.updated", {});
    return { ok: true };
  });

  // ----- signing CLI brains in from the chat: the sign-in card -----
  const loginRef = (req: FastifyRequest) => {
    const ref = String((req.query as any)?.ref ?? (req.body as any)?.ref ?? "");
    if (!/^[\w.:@-]{1,200}$/.test(ref)) throw new HttpError(400, "brain.refNotConnected", { ref: ref.slice(0, 80) });
    return ref;
  };
  api.get("/api/brains/login", async (req) => hub.brainLogins.view(loginRef(req)));
  api.post("/api/brains/login", async (req) => {
    const ref = loginRef(req);
    await hub.brainLogins.start(ref, { actor: "user" });
    return hub.brainLogins.view(ref);
  });
  api.post("/api/brains/login/code", async (req) => {
    const ref = loginRef(req);
    await hub.brainLogins.submitCode(ref, String((req.body as any)?.code ?? ""));
    return hub.brainLogins.view(ref);
  });
  api.post("/api/brains/login/cancel", async (req) => {
    const ref = loginRef(req);
    await hub.brainLogins.cancel(ref, "user");
    return hub.brainLogins.view(ref);
  });

  // ----- first-run setup: the setup card in the chat -----
  const setupAgent = (req: FastifyRequest) => {
    const id = String((req.query as any)?.agent ?? (req.body as any)?.agent ?? "");
    return hub.agents.get(id) ? id : undefined;
  };
  api.get("/api/setup", async (req) => hub.setup.state(setupAgent(req)));
  api.post("/api/setup/refresh", async (req) => {
    await hub.refreshBrains();
    return hub.setup.state(setupAgent(req));
  });
  // The person opened the assistant's empty dialog on a new hub: it speaks first (once per hub).
  api.post("/api/setup/intro", async () => {
    await hub.setup.startIntro();
    return hub.setup.state();
  });

  // ----- plugins -----
  const pluginView = (r: ReturnType<typeof hub.plugins.list>[number], locale: Locale) => ({
    id: r.id,
    name: localizePluginValue(r.layout, r.layout?.manifest.name ?? r.id, locale),
    version: r.layout?.manifest.version,
    description: localizePluginValue(r.layout, r.layout?.manifest.description, locale),
    source: r.source,
    enabled: r.enabled,
    status: r.status,
    lastError: r.lastError,
    formats: r.layout?.formats ?? [],
    permissions: r.granted,
    contributes: localizePluginValue(r.layout, r.layout?.manifest.contributes, locale),
    settings: r.settings,
    hasUi: !!r.layout?.uiEntry,
    hasServer: !!r.layout?.serverEntry,
    commitHash: r.commitHash,
  });
  api.get("/api/plugins", async (req) => hub.plugins.list().map((r) => pluginView(r, requestLocale(req))));
  api.get("/api/plugins/:id/logs", async (req) => hub.plugins.get((req.params as any).id)?.logs ?? []);
  api.post("/api/plugins/install", async (req) => hub.plugins.prepareInstall(String((req.body as any)?.source ?? ""), requestLocale(req)));
  api.post("/api/plugins/install/confirm", async (req) => pluginView(await hub.plugins.confirmInstall(String((req.body as any)?.stagingId ?? "")), requestLocale(req)));
  api.post("/api/plugins/:id/enabled", async (req) => {
    await hub.plugins.setEnabled((req.params as any).id, !!(req.body as any)?.enabled);
    return pluginView(hub.plugins.get((req.params as any).id)!, requestLocale(req));
  });
  api.put("/api/plugins/:id/settings", async (req) => {
    hub.plugins.setSettings((req.params as any).id, (req.body ?? {}) as Record<string, unknown>);
    return { ok: true };
  });
  api.post("/api/plugins/:id/restart", async (req) => {
    await hub.plugins.restart((req.params as any).id);
    return pluginView(hub.plugins.get((req.params as any).id)!, requestLocale(req));
  });
  api.delete("/api/plugins/:id", async (req) => {
    await hub.plugins.uninstall((req.params as any).id);
    return { ok: true };
  });
  api.all("/api/plugins/:id/http/*", async (req, reply) => {
    const id = (req.params as any).id as string;
    const r = await hub.plugins.http(id, {
      method: req.method,
      path: "/" + ((req.params as any)["*"] as string),
      query: req.query as Record<string, string>,
      headers: { "content-type": String(req.headers["content-type"] ?? "") },
      body: req.body ?? null,
      public: false,
      locale: requestLocale(req),
    });
    reply.code(r.status ?? 200);
    for (const [k, v] of Object.entries(r.headers ?? {})) if (/^(content-type|cache-control|content-disposition)$/i.test(k)) reply.header(k, v);
    return reply.send(r.body ?? "");
  });
  api.post("/api/plugins/:id/message", async (req) => {
    hub.plugins.uiMessage((req.params as any).id, req.body);
    return { ok: true };
  });

  // ----- tools, skills, commands, channels -----
  api.get("/api/tools", async () => hub.tools.list().map((t) => ({ name: t.name, description: t.description, effect: t.effect, owner: t.owner, source: !!t.source })));
  // `agents`: who has it; empty: the whole team.
  api.get("/api/skills", async () => {
    const held = hub.skills.holders?.all() ?? new Map<string, string[]>();
    return hub.skills.list().map((s) => ({ ...s, agents: held.get(s.name) ?? [] }));
  });
  // The hub's own commands first, then the skills' (one named like a hub command is the hub's).
  api.get("/api/commands", async (req) => {
    const own = hub.commands.list(requestLocale(req));
    const names = new Set(own.map((c) => c.name));
    return [...own, ...hub.skills.listCommands().filter((c) => !names.has(c.name)).map((c) => ({ name: c.name, description: c.description, source: c.source }))];
  });
  api.get("/api/channels", async () => Promise.all(hub.channels.list().map(async (c) => ({ ...c, ...(await hub.channels.status(c.id)) }))));

  // ----- machines -----
  api.get("/api/machines", async () => hub.machines.list());
  // What an agent may be bound to (AgentDef.machines): this hub's computer, the machines, the other replicas.
  api.get("/api/computers", async () => hub.computers());
  // The hub's computer and the paired machines with the turns running there now; "machines.activity" keeps it current.
  api.get("/api/machines/activity", async () => hub.activity.view());
  api.get("/api/machines/setups", async () => hub.machines.list().map((m) => hub.setups.view(m.id)));
  api.get("/api/cluster", async () => hub.cluster.states());
  api.get("/api/machines/:id/setup", async (req) => {
    const m = hub.machines.find((req.params as any).id);
    if (!m) throw new HttpError(404, "machine.notFound");
    return hub.setups.view(m.id);
  });
  // A hub only this computer can reach gives other machines its link, when it has one.
  api.post("/api/machines/pairing-code", async () => ({ ...hub.machines.createPairingCode(), hubUrl: machineHubUrl(cfg.publicUrl, hub.remote.link()) }));
  // One link connects a computer or a phone (invites.ts); a phone's chat may invite a computer too.
  api.post("/api/invites", async () => hub.createInvite());
  api.delete("/api/invites/:code", async (req) => ({ ok: hub.invites.revoke((req.params as { code: string }).code) }));
  // "Update" on a machine's row: this hub's own update on a server install ("local"), or a machine's daemon.
  api.post("/api/machines/:id/update", async (req) => {
    try {
      return await hub.updates.update((req.params as { id: string }).id);
    } catch (e) {
      if (e instanceof UpdateError) throw new HttpError(409, `update.${e.reason}`, { version: e.version ?? "" });
      throw e;
    }
  });
  api.patch("/api/machines/:id", async (req) => hub.machines.rename((req.params as any).id, String((req.body as any)?.name ?? "")));
  api.delete("/api/machines/:id", async (req) => {
    hub.machines.revoke((req.params as any).id);
    return { ok: true };
  });

  // ----- the vault from the chat: create or unlock only (reading items, sealing, scopes stay in the security console) -----
  const unlockTries = { count: 0, since: Date.now() };
  const passphraseIn = (req: FastifyRequest) => {
    const b = (req.body ?? {}) as { passphrase?: unknown; remember?: unknown };
    return { passphrase: String(b.passphrase ?? ""), remember: b.remember === true };
  };
  api.post("/api/vault/init", async (req) => {
    const { passphrase, remember } = passphraseIn(req);
    hub.vault.init(passphrase);
    hub.rememberVaultPassphrase(remember ? passphrase : undefined);
    hub.audit.append("user", "vault.init", undefined, { via: "chat", remember });
    return { state: hub.vault.state() };
  });
  api.post("/api/vault/unlock", async (req) => {
    if (Date.now() - unlockTries.since > 10 * 60_000) Object.assign(unlockTries, { count: 0, since: Date.now() });
    if (unlockTries.count >= 10) throw new HttpError(429, "auth.tooManyAttempts");
    const { passphrase, remember } = passphraseIn(req);
    try {
      hub.vault.unlock(passphrase);
    } catch (e) {
      unlockTries.count++;
      throw e;
    }
    unlockTries.count = 0;
    hub.rememberVaultPassphrase(remember ? passphrase : undefined);
    hub.audit.append("user", "vault.unlock", undefined, { via: "chat", remember });
    return { state: hub.vault.state() };
  });

  // ----- secrets typed into the chat: write-only, nothing here ever returns a value -----
  api.get("/api/secret-requests/:id", async (req) => {
    const r = hub.secrets.get((req.params as any).id);
    if (!r) throw new HttpError(404, "secrets.requestNotFound");
    return { ...r, vaultState: hub.vault.state() };
  });
  api.post("/api/secret-requests/:id", async (req) => {
    const b = (req.body ?? {}) as { value?: unknown; username?: unknown; password?: unknown };
    const value = b.password !== undefined ? { username: b.username === undefined ? undefined : String(b.username), password: String(b.password) } : String(b.value ?? "");
    const { request } = hub.secrets.fulfil((req.params as any).id, value, "user");
    return { ...request, vaultState: hub.vault.state() };
  });
  api.post("/api/secret-requests/:id/cancel", async (req) => ({ ...hub.secrets.cancel((req.params as any).id, "user"), vaultState: hub.vault.state() }));
  api.get("/api/plugins/:id/setup", async (req) => hub.secrets.setupView((req.params as any).id, requestLocale(req)));
  api.post("/api/plugins/:id/secrets/:vault", async (req) => {
    const { id, vault } = req.params as { id: string; vault: string };
    const s = hub.secrets.setupSecret(id, vault);
    hub.secrets.store({ vaultId: s.vault, title: hub.secrets.secretTitle(id, s, hubLocale()), value: String((req.body as any)?.value ?? ""), pluginId: id, setting: s.setting, actor: "user" });
    return hub.secrets.setupView(id, requestLocale(req));
  });

  // ----- MCP servers -----
  api.get("/api/mcp-servers", async () => ({ servers: hub.mcpClients.list(), config: hub.mcpClients.readUserServers() }));
  api.put("/api/mcp-servers", async (req) => {
    const servers = ((req.body as any)?.servers ?? {}) as Record<string, any>;
    for (const [name, s] of Object.entries(servers)) {
      for (const [k, v] of Object.entries({ ...(s.env ?? {}), ...(s.headers ?? {}) })) {
        if (/key|token|secret|password/i.test(k) && typeof v === "string" && !v.startsWith("vault://") && v !== "•••") {
          throw new HttpError(400, "settings.secretInPlainText", { field: `${name}.${k}` });
        }
      }
    }
    // Keep masked values from the previous config.
    const prev = hub.mcpClients.readUserServers();
    for (const [name, s] of Object.entries(servers)) {
      for (const key of ["env", "headers"] as const) {
        if (!s[key]) continue;
        for (const [k, v] of Object.entries(s[key] as Record<string, string>)) if (v === "•••") s[key][k] = (prev[name] as any)?.[key]?.[k] ?? "";
      }
    }
    hub.mcpClients.writeUserServers(servers);
    hub.audit.append("user", "mcp.config", undefined, { servers: Object.keys(servers) });
    hub.reindex();
    return { ok: true };
  });
  api.post("/api/mcp-servers/:name/reconnect", async (req) => {
    await hub.mcpClients.reconnect((req.params as any).name);
    return hub.mcpClients.list();
  });

  // ----- integrations: the library's cards, the catalog (the same cards by situation), and the hub's Google sign-in -----
  api.get("/api/integrations", async (req) => listIntegrations(hub, requestLocale(req)));
  api.get("/api/catalog", async (req) => listCatalog(hub, requestLocale(req), { all: ["1", "true"].includes(String((req.query as any)?.all)) }));
  // A card's logo: the PNG its plugin ships (the catalog draws it instead of the icon).
  api.get("/api/integrations/:id/logo", async (req, reply) => {
    const id = (req.params as any).id as string;
    const file = logoFile(hub, id);
    if (!file) throw new HttpError(404, "connections.notFound", { id });
    reply.header("content-type", "image/png").header("cache-control", "private, max-age=86400").header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'");
    return reply.send(readFileSync(file));
  });
  api.post("/api/integrations/:id/enabled", async (req) => {
    const id = (req.params as any).id as string;
    // One of a plugin's entries (composio:slack) turns its plugin on or off.
    const pluginId = entryRef(id)?.pluginId ?? id;
    if (!hub.plugins.get(pluginId)?.layout?.manifest.integration) throw new HttpError(404, "connections.notFound", { id });
    const b = (req.body ?? {}) as { enabled?: unknown; conversationId?: unknown };
    await hub.plugins.setEnabled(pluginId, !!b.enabled);
    hub.bus.emit("connections.updated", { provider: pluginId });
    const view = (await listIntegrations(hub, requestLocale(req))).find((i) => i.id === id);
    // Turned on from its card in a chat (the agent offered it): the agent hears and carries on with what was asked.
    if (b.enabled && view?.status === "connected" && typeof b.conversationId === "string" && hub.store.getConversation(b.conversationId)) {
      const tools = hub.tools.list().filter((d) => d.owner === pluginId).map((d) => d.name);
      hub.runner.tellAgent(
        b.conversationId,
        `[System] The user turned on ${view.name} (${id}) from its card${tools.length ? `; its tools are available now: ${tools.join(", ")}` : ""}. Carry on with what the user asked.`,
      );
    }
    return view;
  });
  // An integration whose MCP server has its own sign-in (Granola): the address to open, the pasted way back, signing out.
  const signinServer = (id: string): string => {
    if (hub.plugins.get(id)?.layout?.manifest.integration?.connect !== "signin") throw new HttpError(404, "connections.notFound", { id });
    const s = hub.mcpClients.list().find((x) => x.source === id);
    if (!s) throw new HttpError(409, "mcp.noSignin", { name: id });
    return s.name;
  };
  // One of a plugin's entries (composio:slack) signs in and out through its plugin.
  api.post("/api/integrations/:id/signin", async (req) => {
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as { conversationId?: unknown };
    const conversationId = typeof b.conversationId === "string" ? b.conversationId : undefined;
    if (entryRef(id)) return { url: await hub.entrySignIn(id, conversationId) };
    return { url: await hub.mcpClients.signIn(signinServer(id), conversationId) };
  });
  api.delete("/api/integrations/:id/signin", async (req) => {
    const id = (req.params as any).id as string;
    if (entryRef(id)) await hub.entrySignOut(id);
    else await hub.mcpClients.signOut(signinServer(id));
    hub.bus.emit("connections.updated", { provider: entryRef(id)?.pluginId ?? id });
    return { ok: true };
  });
  api.post("/api/mcp/signin/complete", async (req) => {
    const r = await hub.mcpClients.completeSignIn(callbackParams(String((req.body as any)?.url ?? "")));
    hub.mcpSignedIn(r.source, r.conversationId);
    return { ok: true };
  });
  api.get("/api/connections", async () => ({ google: { available: hub.connections.available("google"), account: hub.connections.get("google") ?? null } }));
  api.post("/api/connections/google/start", async (req) => {
    const b = (req.body ?? {}) as { integration?: string; conversationId?: string };
    return hub.connections.start("google", googleScopes(hub), { integration: b.integration, conversationId: b.conversationId });
  });
  // The return address pasted by hand: a hub the browser cannot reach on 127.0.0.1 (a VPS, a phone).
  api.post("/api/connections/google/complete", async (req) => {
    const r = await hub.connections.complete(String((req.body as any)?.url ?? ""));
    hub.connectionDone(r.account, r.origin);
    return r.account;
  });
  api.delete("/api/connections/google", async () => {
    await hub.connections.disconnect("google");
    return { ok: true };
  });

  // ----- settings -----
  api.get("/api/settings", async () => hub.settings.get());
  api.patch("/api/settings", async (req) => hub.updateSettings((req.body ?? {}) as Record<string, unknown>, "user"));
  // Which speech-to-text service voice messages go to now (none: not set up).
  api.get("/api/transcription", async () => {
    const e = hub.transcriber.engine();
    return { engine: e ? { label: e.label, model: e.model } : null };
  });

  // ----- notifications, approvals (count only; resolving happens in the console) -----
  api.get("/api/notifications", async (req) => hub.notifier.list(Math.min(Number((req.query as any).limit ?? 100), 500)));
  api.post("/api/notifications/:id/feedback", async (req) => hub.notifier.feedback((req.params as any).id, (req.body as any)?.value));
  api.post("/api/digest/flush", async () => ({ sent: await hub.notifier.flushDigest() }));
  /** `?before=` (an entry's createdAt) and `?limit=` of an Inbox page; what is not a single value counts as not given. */
  const inboxPage = (req: { query: unknown }) => {
    const q = req.query as { before?: unknown; limit?: unknown };
    return { before: typeof q.before === "string" && q.before ? q.before : undefined, limit: typeof q.limit === "string" && q.limit ? Number(q.limit) : undefined };
  };
  api.get("/api/inbox", async (req) => hub.notifier.inbox(inboxPage(req)));
  api.get("/api/inbox/behind", async (req) => hub.notifier.behind(inboxPage(req)));
  api.post("/api/inbox/read", async (req) => {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids)) throw new HttpError(400, "inbox.badIds");
    hub.notifier.markInboxRead(ids.filter((x): x is string => typeof x === "string"));
    return { ok: true, unread: hub.notifier.unreadCount() };
  });
  api.get("/api/approvals/pending-count", async () => ({ count: hub.approvals.pendingCount() }));

  // ----- workspace files (artifacts) -----
  api.get("/api/files", async (req, reply) => {
    const p = String((req.query as any).path ?? "");
    const file = safeFile(join(cfg.dataDir, "workspaces"), p);
    if (!file) throw new HttpError(404, "file.notFound");
    // Files come from agents, web pages and whoever writes to the user: one opened in a tab (a page, an SVG)
    // gets an opaque origin without script. A PDF keeps the browser's own viewer, which never runs as the hub.
    reply.header("x-content-type-options", "nosniff");
    if (!/\.pdf$/i.test(file)) reply.header("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    return sendFile(reply, file, { download: (req.query as any).download === "1" });
  });

  // ----- images and maps the agents show (media.ts): the page CSP only loads pictures from here -----
  const sendImage = (reply: FastifyReply, data: Buffer, type: string, maxAge: number) =>
    reply
      .header("content-type", type)
      .header("cache-control", `private, max-age=${maxAge}`)
      // Opened on its own (an SVG in a new tab), the picture still cannot run script on the hub's origin.
      .header("content-security-policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header("x-content-type-options", "nosniff")
      .send(data);
  const mediaFailure = (e: unknown) => (e instanceof MediaError ? new HttpError(e.status, e.key) : e);
  api.get("/api/media", async (req, reply) => {
    const q = req.query as { url?: unknown; download?: unknown };
    try {
      const r = await hub.media.image(q.url);
      // The viewer's download button: the picture saved under its own name.
      if (q.download === "1") reply.header("content-disposition", attachmentDisposition(imageFileName(String(q.url), r.type)));
      return sendImage(reply, r.data, r.type, 24 * 3600);
    } catch (e) {
      throw mediaFailure(e);
    }
  });
  api.get("/api/map/tiles/:z/:x/:y", async (req, reply) => {
    const { z, x, y } = req.params as { z: string; x: string; y: string };
    if (!y.endsWith(".png")) throw new HttpError(400, "media.badTile");
    try {
      return sendImage(reply, await hub.media.tile(z, x, y), "image/png", 7 * 24 * 3600);
    } catch (e) {
      throw mediaFailure(e);
    }
  });

  // ----- phones: the web UI pairs, renames and revokes them; a phone manages only itself -----
  if (opts.kind === "web") {
    api.get("/api/devices", async () => ({ devices: hub.devices.list(), network: hub.deviceNetwork() }));
    api.post("/api/devices/pairing", async () => hub.devicePairing());
    // Access from anywhere (remote.ts): the switch, and forgetting the node.
    const remoteView = (req: FastifyRequest) => {
      const v = hub.remote.view(requestLocale(req));
      return v.state === "running" && v.url ? { ...v, qrSvg: qrSvg(v.url) } : v;
    };
    api.get("/api/remote", async (req) => remoteView(req));
    api.post("/api/remote/enable", async (req) => {
      await hub.remote.enable();
      hub.audit.append("user", "remote.enable");
      return remoteView(req);
    });
    api.post("/api/remote/disable", async (req) => {
      await hub.remote.disable();
      hub.audit.append("user", "remote.disable");
      return remoteView(req);
    });
    api.post("/api/remote/forget", async (req) => {
      await hub.remote.forget();
      hub.audit.append("user", "remote.forget");
      return remoteView(req);
    });
    api.patch("/api/devices/:id", async (req) => hub.devices.rename((req.params as any).id, String((req.body as any)?.name ?? "")));
    api.delete("/api/devices/:id", async (req) => {
      hub.devices.revoke((req.params as any).id, "user");
      return { ok: true };
    });
  }

  // ----- UI plugin assets: plugin UI modules run in the web UI's page and in the phone's chat page -----
  api.get("/plugins-ui/:id/*", async (req, reply) => {
    const dir = hub.plugins.uiDir((req.params as any).id);
    const file = dir ? safeFile(dir, (req.params as any)["*"]) : undefined;
    if (!file) throw new HttpError(404, "not found");
    return sendFile(reply, file);
  });

  // ----- realtime -----
  api.get("/api/ws", { websocket: true }, (socket, req) => {
    if (!opts.wsAllowed(req)) {
      socket.close(4403, "origin");
      return;
    }
    // A phone on a standby replica: its events come from the leader.
    if ((req as any).device && pipeToLeader(hub, socket as unknown as WebSocket, req)) return;
    const send = (ev: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(ev));
    };
    opts.onSocket?.(socket as unknown as WebSocket, req);
    const unsub = hub.bus.onAny((name, payload) => {
      if (name === "approval.created" || name === "approval.resolved") {
        send({ type: "approval.pending", data: { count: hub.approvals.pendingCount() } });
        return;
      }
      const ev = toUiEvent(name, payload);
      if (ev) send(ev);
    });
    const ping = setInterval(() => socket.ping(), 25_000);
    socket.on("close", () => {
      unsub();
      clearInterval(ping);
    });
    socket.on("message", (raw) => {
      // Client → plugin backend messages: {pluginId, payload}
      try {
        const m = JSON.parse(String(raw));
        if (m?.type === "plugin.message" && typeof m.pluginId === "string") hub.plugins.uiMessage(m.pluginId, m.payload);
      } catch {
        /* ignore */
      }
    });
  });
}
