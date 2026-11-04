// What the demo hub answers: the requests the web UI makes, from the world. Shapes follow packages/core/src/server/api.ts;
// anything the visitor can reach but the demo does not act out answers a gentle "not in the demo".

import type { LibraryItem, Message } from "@piomio/shared";
import browserEn from "../../../../../plugins/browser/.piomio-plugin/locales/en.json";
import browserRu from "../../../../../plugins/browser/.piomio-plugin/locales/ru.json";
import memoryEn from "../../../../../plugins/memory/.piomio-plugin/locales/en.json";
import memoryRu from "../../../../../plugins/memory/.piomio-plugin/locales/ru.json";
import triggersEn from "../../../../../plugins/triggers/.piomio-plugin/locales/en.json";
import triggersRu from "../../../../../plugins/triggers/.piomio-plugin/locales/ru.json";
import { iso } from "../world";
import type { DemoHub } from "./hub";
import { DemoError } from "./router";

const UI_PLUGINS: Array<{ id: string; messages: { en: Record<string, string>; ru: Record<string, string> } }> = [
  { id: "browser", messages: { en: browserEn, ru: browserRu } },
  { id: "memory", messages: { en: memoryEn, ru: memoryRu } },
  { id: "triggers", messages: { en: triggersEn, ru: triggersRu } },
];

/** Where the demo's copies of the UI plugins are, next to demo.html. */
export function pluginUrl(id: string): string {
  return new URL(`plugins-ui/${id}/index.js`, document.baseURI).href;
}

export function registerRoutes(hub: DemoHub, notInDemo: string): void {
  const r = hub.router;
  const w = () => hub.world;
  const refuse = () => {
    throw new DemoError(409, notInDemo);
  };

  // ----- start-up -----
  r.route("GET", "/api/auth/state", () => ({ hasPassword: true, authenticated: true, passkeys: 1, version: "demo", language: w().locale, locales: ["en", "ru"] }));
  r.route("GET", "/api/bootstrap", () => ({
    csrf: "demo",
    version: "demo",
    publicUrl: location.origin,
    consoleUrl: location.origin,
    mainConversationId: `dlg_${w().defaultAgent}`,
    defaultAgent: w().defaultAgent,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: w().locale,
    locales: ["en", "ru"],
    vaultState: "unlocked",
    apiKeys: false,
    firstRun: false,
    pendingApprovals: w().approvals.filter((a) => a.status === "pending").length,
    uiPlugins: UI_PLUGINS.map((p) => ({
      id: p.id,
      name: p.messages[w().locale].name ?? p.id,
      url: pluginUrl(p.id),
      messages: { en: p.messages.en, [w().locale]: p.messages[w().locale] },
    })),
    channels: [],
  }));

  r.route("GET", "/api/brains", () => w().brains);
  r.route("GET", "/api/setup", () => ({
    agentId: w().defaultAgent,
    brains: w().brains.map((b) => ({ ref: b.ref, label: b.label, kind: b.ref.startsWith("api:") ? "api" : "cli", installed: true, signedIn: true, canInstall: false })),
    usable: true,
    firstRun: false,
    starting: false,
    vault: "open",
    apiKeys: false,
    telegram: true,
    machines: 2,
    done: ["identity", "team", "telegram", "backupBrain", "machines", "profile"],
    skipped: [],
    remaining: [],
  }));

  // ----- the team and its dialogs -----
  r.route("GET", "/api/team", () => hub.team());
  r.route("GET", "/api/groups", () => hub.groups());
  r.route("POST", "/api/groups/:id/archive", refuse);
  r.route("DELETE", "/api/groups/:id", refuse);
  r.route("GET", "/api/agents", () => w().agents);
  r.route("GET", "/api/agents/:id", ({ params }) => w().agents.find((a) => a.id === params.id) ?? refuse());
  // How an agent thinks (the header's picker): its brains first, every kind of work on "auto".
  r.route("GET", "/api/agents/:id/thinking", ({ params }) => {
    const a = w().agents.find((x) => x.id === params.id) ?? refuse();
    const order = [...a.brains, ...w().brains.map((b) => b.ref).filter((ref) => !a.brains.includes(ref))];
    const brains = order
      .map((ref) => w().brains.find((b) => b.ref === ref))
      .filter((b) => !!b)
      .map((b) => ({
        ref: b.ref,
        label: b.label,
        ready: !b.limitedUntil,
        models: (b.probe?.models ?? []).map((id) => ({ id, name: b.probe?.modelNames?.[id] ?? id })),
        model: b.probe?.model,
        efforts: b.probe?.efforts ?? [],
        presets: {},
      }));
    const first = brains.find((b) => b.ready);
    return {
      agentId: a.id,
      brains,
      kinds: (["chat", "task", "feed", "schedule"] as const).map((kind) => ({ kind, choice: { preset: "auto" }, brain: first?.ref, model: first?.model, effort: "medium", preset: "auto" })),
    };
  });
  r.route("PUT", "/api/agents/:id/thinking/:kind", refuse);
  r.route("GET", "/api/conversations", () => w().conversations.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
  r.route("GET", "/api/conversations/:id", ({ params }) => hub.conversation(params.id) ?? refuse());
  r.route("PATCH", "/api/conversations/:id", refuse);
  r.route("GET", "/api/conversations/:id/messages", ({ params, query }) => {
    const limit = Math.min(Number(query.get("limit") ?? 100), 500);
    const before = query.get("before");
    const list = hub.messagesOf(params.id).filter((m) => !before || m.createdAt < before);
    return list.slice(-limit);
  });
  r.route("POST", "/api/conversations/:id/messages", ({ params, body }) => {
    const text = String(body?.text ?? "").trim();
    if (!text) throw new DemoError(400, "empty");
    return hub.userMessage(params.id, text);
  });
  r.route("POST", "/api/conversations/:id/read", ({ params, body }) => {
    hub.markRead(params.id, String(body?.at ?? iso()));
    return { ok: true };
  });
  r.route("POST", "/api/conversations/:id/warm", () => ({ ok: true }));
  r.route("POST", "/api/updates/check", () => ({ ok: true }));
  r.route("POST", "/api/conversations/:id/interrupt", () => ({ interrupted: false }));
  r.route("POST", "/api/messages/:id/choose", ({ params, body }) => {
    const m = hub.findMessage(params.id);
    const i = Number(body?.index);
    const part = m?.parts.find((p) => p.type === "choices");
    if (!m || !part || part.type !== "choices" || part.chosen !== undefined || !part.options[i]) throw new DemoError(409, notInDemo);
    hub.updateMessage(m.id, (x) => ({ ...x, parts: x.parts.map((p) => (p.type === "choices" ? { ...p, chosen: i } : p)) }));
    return hub.userMessage(m.conversationId, part.options[i]) satisfies Message;
  });

  // ----- tasks, machines, notifications -----
  r.route("GET", "/api/tasks", () => w().tasks.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
  r.route("GET", "/api/tasks/:id", ({ params }) => w().tasks.find((t) => t.id === params.id) ?? refuse());
  r.route("GET", "/api/machines/activity", () => w().machines);
  r.route("GET", "/api/notifications", () => []);
  r.route("GET", "/api/commands", () => []);
  r.route("GET", "/api/skills", () => []);

  // ----- channels and pages -----
  r.route("GET", "/api/feeds", () => w().feeds);
  r.route("GET", "/api/feeds/:id", ({ params }) => w().feeds.find((f) => f.id === params.id) ?? refuse());
  r.route("GET", "/api/feeds/:id/posts", ({ params, query }) => {
    const before = query.get("before");
    const limit = Number(query.get("limit") ?? 30);
    return w()
      .posts.filter((p) => p.feedId === params.id && (!before || p.createdAt < before))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  });
  r.route("POST", "/api/feeds/:id/run", refuse);
  r.route("PATCH", "/api/feeds/:id", refuse);
  r.route("DELETE", "/api/feeds/:id", refuse);
  r.route("POST", "/api/feeds/:id/read", ({ params }) => {
    const f = w().feeds.find((x) => x.id === params.id);
    if (f && f.unread) {
      f.unread = 0;
      hub.emit({ type: "feed.updated", data: f });
    }
    return { ok: true };
  });
  r.route("GET", "/api/pages", () => w().pages);
  r.route("GET", "/api/pages/:id", ({ params }) => w().pages.find((p) => p.id === params.id) ?? refuse());
  // An agent's library (core/src/library.ts), read from the demo's chats and pages the same way.
  r.route("GET", "/api/library", ({ query }) => {
    const agent = query.get("agent") ?? undefined;
    const kind = query.get("kind") ?? undefined;
    const words = (query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (...t: Array<string | undefined>) => words.every((x) => t.filter(Boolean).join(" ").toLowerCase().includes(x));
    const items: LibraryItem[] = [];
    for (const c of w().conversations) {
      if (agent && c.agentId !== agent && !c.members?.includes(agent)) continue;
      for (const m of w().messages[c.id] ?? []) {
        const from = m.role === "user" && !m.agentId ? "person" : "agent";
        const at = { agentId: m.agentId ?? c.agentId, conversationId: c.id, messageId: m.id, at: m.createdAt };
        for (const p of m.parts) {
          if (p.type === "attachment" && hit(p.name, p.transcript)) {
            const k = p.kind === "voice" || p.mimeType?.startsWith("audio/") ? "audio" : /^(image|video)\//.test(p.mimeType ?? "") ? "media" : "file";
            items.push({ ...at, id: p.path, kind: k, from, name: p.name, path: p.path, mimeType: p.mimeType, size: p.size, durationSec: p.durationSec, transcript: p.transcript, voice: p.kind === "voice" || undefined });
          } else if (p.type === "images") {
            for (const it of p.items) if (hit(it.caption, it.alt)) items.push({ ...at, id: it.src, kind: "media", from: "agent", name: it.caption ?? it.alt ?? "image", src: it.src, caption: it.caption });
          }
        }
      }
    }
    for (const p of w().pages) if ((!agent || p.agentId === agent) && hit(p.title, p.summary)) items.push({ id: `page:${p.id}`, kind: "page", from: "agent", name: p.title, pageId: p.id, agentId: p.agentId, caption: p.summary, src: p.cover, conversationId: p.conversationId, at: p.updatedAt });
    const seen = new Set<string>();
    const out = items
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .filter((it) => !seen.has(it.id) && seen.add(it.id) && (!kind || it.kind === kind));
    return { items: out, more: false };
  });

  // ----- integrations and secrets -----
  r.route("GET", "/api/integrations", () => w().integrations);
  r.route("GET", "/api/catalog", () => ({ popular: w().integrations.map((x) => x.id), sections: [{ id: "everyday", title: w().content.ui.catalogTitle, items: w().integrations }] }));
  r.route("POST", "/api/integrations/:id/signin", ({ params }) => {
    hub.signal(`signin:${params.id}`);
    // The real hub answers the service's sign-in page; the demo's opens nowhere (shims.ts keeps window.open quiet).
    return { url: `https://signin.demo.invalid/${params.id}` };
  });
  r.route("POST", "/api/integrations/:id/enabled", ({ params, body }) => {
    hub.setIntegration(params.id, { status: body?.enabled ? "connected" : "off" });
    return { ok: true };
  });
  r.route("GET", "/api/secret-requests/:id", ({ params }) => w().secretRequests.find((x) => x.id === params.id) ?? refuse());
  r.route("POST", "/api/secret-requests/:id", ({ params }) => hub.saveSecret(params.id) ?? refuse());
  r.route("POST", "/api/secret-requests/:id/cancel", ({ params }) => {
    const x = w().secretRequests.find((s) => s.id === params.id);
    if (x && x.status === "pending") x.status = "cancelled";
    return x ?? refuse();
  });

  // ----- plugins' own HTTP (the browser's teach voice, history) -----
  r.route("POST", "/api/plugins/:id/http/teach/speech", () => ({ text: "" }));
  r.route("GET", "/api/plugins/:id/http/history", () => []);
  r.route("GET", "/api/plugins/:id/http/sites", () => []);

  // ----- approvals -----
  r.route("POST", "/api/approvals/:id", ({ params, body }) => {
    const a = w().approvals.find((x) => x.id === params.id);
    if (!a || a.status !== "pending") throw new DemoError(409, notInDemo);
    hub.resolveApproval(a.id, body?.decision === "approve" ? "approved" : "denied", body?.remember === true);
    return { id: a.id, status: a.status };
  });
}
