// Core API exposed to plugins (each method must be granted in the plugin's permissions.core).

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { AttachmentKind, CoreMethod } from "@piomio/shared";
import { parseBrainRef } from "@piomio/shared";
import type { Hub } from "./app.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, safeFileName, saveAttachment, type IncomingFile } from "./attachments.ts";
import { MAX_TRANSCRIBE_BYTES, uploadName } from "./transcribe.ts";
import { notifyInputError } from "./notifier.ts";

/** Largest file a plugin may hand to a workspace. */
const MAX_DELIVER_BYTES = 1024 * 1024 * 1024;
/** Largest file a plugin may read from a workspace (it travels as base64). */
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

const KINDS = new Set<AttachmentKind>(["photo", "voice", "audio", "video", "file"]);

/** Files a channel passes with a message (base64), checked against the same limits as the web's uploads. */
function incomingFiles(raw: unknown): IncomingFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("files must be an array");
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} files per message`);
  return raw.map((f: any) => {
    const data = Buffer.from(String(f?.data ?? ""), "base64");
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`file too large (over ${MAX_ATTACHMENT_BYTES} bytes)`);
    const out: IncomingFile = { data };
    if (typeof f?.name === "string") out.name = f.name;
    if (typeof f?.mimeType === "string") out.mimeType = f.mimeType;
    if (KINDS.has(f?.kind)) out.kind = f.kind;
    if (typeof f?.durationSec === "number" && Number.isFinite(f.durationSec)) out.durationSec = f.durationSec;
    return out;
  });
}

export function createCoreCall(hub: Hub) {
  return async (pluginId: string, method: CoreMethod, p: any): Promise<unknown> => {
    p = p ?? {};
    switch (method) {
      case "conversations.post": {
        const conv = p.conversationId ? hub.store.getConversation(p.conversationId) : hub.store.agentConversation(hub.settings.get().defaultAgent);
        if (!conv) throw new Error("conversation not found");
        const role = p.role === "assistant" ? "assistant" : "system";
        const m = hub.store.addMessage({ conversationId: conv.id, role, parts: [{ type: "text", text: String(p.text ?? "") }], status: "complete", channel: `plugin:${pluginId}` });
        return { messageId: m.id, conversationId: conv.id };
      }
      case "channels.inbound": {
        // Channels (Telegram) talk to the default agent, in its dialog.
        const conv = p.conversationId ? hub.store.getConversation(p.conversationId) : hub.store.agentConversation(hub.settings.get().defaultAgent);
        if (!conv) throw new Error("conversation not found");
        const text = String(p.text ?? "").trim();
        const files = incomingFiles(p.files);
        if (!text && !files.length) return { ignored: true };
        if (text === "/stop" && !files.length) return { interrupted: hub.runner.interrupt(conv.id) };
        const attachments = files.map((f) => saveAttachment(join(hub.config.dataDir, "workspaces"), conv, f));
        let secrets = 0;
        const m = await hub.runner.userMessage(conv.id, text, {
          channel: String(p.channel ?? pluginId),
          ...(attachments.length ? { attachments } : {}),
          ...(typeof p.context === "string" && p.context.trim() ? { context: p.context.slice(0, 2000) } : {}),
          onCapture: (c) => (secrets = c.stored.length + c.withheld),
        });
        // secrets > 0: the channel should delete the user's original message, it still holds the value.
        return { messageId: m.id, conversationId: conv.id, ...(secrets ? { secrets } : {}) };
      }
      case "conversations.tell": {
        // A note an agent answers (a teach recording, the person's hint, a noticed routine): the task it is for, else
        // the dialog named, else the default agent's. Plugins pass what they saw outside: the session counts it so.
        const text = String(p.text ?? "").trim();
        if (!text) throw new Error("text is required");
        const task = typeof p.taskId === "string" && p.taskId ? hub.store.getTask(p.taskId) : undefined;
        if (task) {
          hub.store.addMessage({ conversationId: task.conversationId, role: "system", parts: [{ type: "text", text }], status: "complete", taskId: task.id });
          if ((await hub.runner.wakeTask(task, text, { taint: true })) !== "cancelled") return { conversationId: task.conversationId, delivered: "task" };
        }
        // A cancelled task's note goes to whoever started it.
        const conv = task
          ? (task.parentConversationId ? hub.store.getConversation(task.parentConversationId) : undefined) ?? hub.store.agentConversation(task.agentId)
          : p.conversationId
            ? hub.store.getConversation(String(p.conversationId))
            : hub.store.agentConversation(hub.settings.get().defaultAgent);
        if (!conv) throw new Error("conversation not found");
        hub.runner.tellAgent(conv.id, text, { taint: true });
        return { conversationId: conv.id, delivered: "dialog" };
      }
      case "speech.transcribe": {
        if (p.check === true) return { available: !!hub.transcriber.engine() };
        const b64 = String(p.data ?? "");
        // base64 is 4/3 of the bytes: refuse a clip over the limit before decoding it.
        if (b64.length * 0.75 > MAX_TRANSCRIBE_BYTES + 3) throw new Error("the audio is larger than 25 MB");
        const data = Buffer.from(b64, "base64");
        if (!data.length) throw new Error("no audio");
        if (data.length > MAX_TRANSCRIBE_BYTES) throw new Error("the audio is larger than 25 MB");
        const mimeType = typeof p.mimeType === "string" && p.mimeType ? p.mimeType.slice(0, 100) : undefined;
        const dir = mkdtempSync(join(tmpdir(), "piomio-speech-"));
        try {
          // The services go by the extension: "audio.webm" for audio/webm;codecs=opus.
          const file = join(dir, uploadName("clip", mimeType?.split(";")[0].trim()));
          writeFileSync(file, data, { mode: 0o600 });
          return { text: await hub.transcriber.transcribe(file, mimeType) };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      case "tasks.create": {
        const agentId = p.agentId ?? hub.settings.get().defaultAgent;
        if (!hub.agents.get(agentId)) throw new Error(`unknown agent ${agentId}`);
        let goal = String(p.goal ?? "");
        // skill: the run follows one of the hub's skills (a trigger's run of a skill the person taught).
        const skill = typeof p.skill === "string" && p.skill.trim() ? p.skill.trim() : undefined;
        if (skill) {
          if (!hub.skills.get(skill)) throw new Error(`No skill "${skill}" on the hub (it may have been deleted)`);
          goal = `${goal}\n\n[System] This task follows the skill "${skill}": read its instructions (skill_load) first and do the task as they say.`;
        }
        // machine: the computer the task runs on (id or name, see machines.list), like task_delegate's.
        let brainRef: string | undefined;
        if (typeof p.machine === "string" && p.machine.trim()) {
          const place = hub.runner.placeTask(agentId, p.machine);
          if ("error" in place) throw new Error(place.error);
          brainRef = place.brainRef;
          if (place.note) goal = `${goal}\n\n${place.note}`;
        }
        const t = hub.runner.createTask({
          agentId,
          goal,
          title: String(p.title ?? String(p.goal ?? "").slice(0, 60)),
          background: p.background !== false,
          // quiet: a plugin's own background work (memory's nightly reflection) reports like a trigger's run, only
          // through the agent's notify(), not with a "Task done" notification.
          createdBy: p.triggerId || p.quiet === true ? "trigger" : "user",
          triggerId: p.triggerId,
          // report: the run's final reply is delivered to the person as a report (a trigger set to report).
          ...(p.report === true ? { deliver: "report" as const } : {}),
          parentConversationId: p.parentConversationId,
          ...(brainRef ? { brainRef } : {}),
          ...(skill ? { skill } : {}),
        });
        return t;
      }
      case "tasks.get":
        return hub.store.getTask(String(p.id)) ?? null;
      case "tasks.list":
        return hub.store.listTasks({ status: p.status, limit: p.limit ?? 50 });
      case "notify": {
        const level = p.level ?? "notify";
        const invalid = notifyInputError(level, p.title);
        if (invalid) throw new Error(invalid);
        const n = await hub.notifier.notify({ level, title: String(p.title), body: String(p.body ?? ""), triggerId: p.triggerId, agentId: p.agentId, taskId: p.taskId });
        return { id: n.id, level: n.effectiveLevel };
      }
      case "approvals.resolve": {
        if (!p.token) throw new Error("token is required");
        const a = hub.approvals.resolveByToken(String(p.id), p.decision === "approve" ? "approve" : "deny", String(p.token), "telegram");
        return { id: a.id, status: a.status, summary: a.summary };
      }
      case "settings.get": {
        const s = hub.settings.get();
        return {
          timezone: s.timezone,
          language: s.language,
          quietHours: s.quietHours,
          digestTimes: s.digestTimes,
          defaultAgent: s.defaultAgent,
          publicUrl: hub.config.publicUrl,
          consoleUrl: hub.config.consoleUrl,
        };
      }
      case "agents.list":
        return hub.agents.list().map((a) => ({ id: a.id, name: a.name, description: a.description, initiative: a.initiative }));
      case "ui.emit":
        hub.bus.emit("plugin.event", { pluginId, channel: String(p.channel ?? "default"), payload: hub.vault.redactor.value(p.payload) });
        return {};
      case "vault.check": {
        const id = String(p.ref ?? "").replace(/^vault:\/\//, "");
        const m = hub.vault.getMeta(id);
        return { exists: !!m, state: hub.vault.state(), type: m?.type, hints: m?.hints };
      }
      case "machines.list":
        // The computers tasks run on: the hub's own first (id "local"), then the paired ones.
        return hub.runner.computers().map((c) => ({ id: c.id, name: c.name, status: c.online ? "online" : "offline" }));
      case "notifications.feedback": {
        const n = hub.notifier.feedback(String(p.id), p.value, String(p.token ?? ""));
        return { id: n.id, feedback: n.feedback };
      }
      case "files.deliver": {
        // Plugins run as another unix user: files they fetch for an agent are copied into its workspace by the hub.
        const s = hub.store.getSession(String(p.sessionId ?? ""));
        if (!s) throw new Error("session not found");
        if (parseBrainRef(s.brainRef).machineId !== "local") throw new Error("files can only be delivered to a workspace on the hub");
        const data = Buffer.from(String(p.data ?? ""), "base64");
        const dir = join(hub.runner.workspacePath(s), "downloads");
        mkdirSync(dir, { recursive: true });
        let rel: string;
        if (p.path) {
          rel = String(p.path);
          const name = rel.startsWith("downloads/") ? rel.slice("downloads/".length) : "";
          if (!name || safeFileName(name) !== name || !existsSync(join(dir, name))) throw new Error("invalid path");
          if (statSync(join(dir, name)).size + data.length > MAX_DELIVER_BYTES) throw new Error("file too large");
          appendFileSync(join(dir, name), data);
        } else {
          const name = safeFileName(String(p.name ?? ""));
          const dot = name.lastIndexOf(".");
          const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
          let candidate = name;
          for (let i = 1; existsSync(join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
          writeFileSync(join(dir, candidate), data, { mode: 0o640 });
          rel = `downloads/${candidate}`;
        }
        return { path: rel, absolutePath: join(hub.runner.workspacePath(s), rel) };
      }
      case "files.fetch": {
        // A file an agent hands a plugin (one to upload to a site): from that session's workspace on the hub, nowhere else.
        const s = hub.store.getSession(String(p.sessionId ?? ""));
        if (!s) throw new Error("session not found");
        if (parseBrainRef(s.brainRef).machineId !== "local") throw new Error("files can only be read from a workspace on the hub");
        const root = realpathSync(hub.runner.workspacePath(s));
        const asked = String(p.path ?? "");
        let file: string;
        try {
          file = realpathSync(resolve(root, asked));
        } catch {
          throw new Error(`there is no ${asked} in the workspace`);
        }
        if (!file.startsWith(root + sep)) throw new Error(`${asked} is outside the workspace`);
        const st = statSync(file);
        if (!st.isFile()) throw new Error(`${asked} is not a file`);
        if (st.size > MAX_FETCH_BYTES) throw new Error(`${asked} is larger than 25 MB`);
        return { name: basename(file), size: st.size, data: readFileSync(file).toString("base64") };
      }
      case "connections.token": {
        // Only for the account its own integration connects with: a Google integration gets Google's token.
        const integ = hub.plugins.get(pluginId)?.layout?.manifest.integration;
        if (integ?.connect !== "google" || (p.provider ?? "google") !== "google") throw new Error("this plugin's integration does not use a Google connection");
        return hub.connections.token("google");
      }
      default:
        throw new Error(`unknown core method ${method}`);
    }
  };
}
