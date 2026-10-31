// Core methods plugins call (core-call.ts) against a fake hub: a note that wakes an agent (conversations.tell), the
// words of an audio clip (speech.transcribe) and a task that follows a skill (tasks.create).
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Task } from "@piomio/shared";
import type { Hub } from "../src/app.ts";
import { createCoreCall } from "../src/core-call.ts";
import { TranscribeError } from "../src/transcribe.ts";

interface Fake {
  hub: Hub;
  told: Array<{ conversationId: string; note: string; opts?: { taint?: boolean } }>;
  woken: Array<{ taskId: string; text: string; opts?: { taint?: boolean } }>;
  messages: Array<{ conversationId: string; role: string; text: string; taskId?: string }>;
  heard: Array<{ file: string; mimeType?: string; bytes: string }>;
  created: any[];
  notified: any[];
}

function fakeHub(opts: { tasks?: Task[]; engine?: boolean; transcribe?: (file: string) => Promise<string>; wake?: "steered" | "started" | "cancelled" } = {}): Fake {
  const f: Fake = { told: [], woken: [], messages: [], heard: [], created: [], notified: [], hub: undefined as unknown as Hub };
  const convs = new Map<string, Conversation>([
    ["c_dialog", { id: "c_dialog", kind: "agent", agentId: "assistant" } as Conversation],
    ["c_other", { id: "c_other", kind: "agent", agentId: "coder" } as Conversation],
  ]);
  const tasks = new Map((opts.tasks ?? []).map((t) => [t.id, t]));
  f.hub = {
    settings: { get: () => ({ defaultAgent: "assistant" }) },
    agents: { get: (id: string) => (["assistant", "coder"].includes(id) ? { id } : undefined) },
    skills: { get: (name: string) => (name === "order-water" ? { name, taught: true } : name === "make-integration" ? { name, taught: false } : undefined) },
    store: {
      getConversation: (id: string) => convs.get(id),
      agentConversation: (agentId: string) => [...convs.values()].find((c) => c.agentId === agentId)!,
      getTask: (id: string) => tasks.get(id),
      addMessage: (m: any) => {
        f.messages.push({ conversationId: m.conversationId, role: m.role, text: m.parts[0].text, ...(m.taskId ? { taskId: m.taskId } : {}) });
        return { id: `m_${f.messages.length}` };
      },
    },
    runner: {
      tellAgent: (conversationId: string, note: string, o?: { taint?: boolean }) => void f.told.push({ conversationId, note, opts: o }),
      wakeTask: async (task: Task, text: string, o?: { taint?: boolean }) => {
        f.woken.push({ taskId: task.id, text, opts: o });
        return opts.wake ?? "started";
      },
      createTask: (t: any) => {
        f.created.push(t);
        return { id: "t_new", ...t };
      },
    },
    notifier: {
      notify: async (n: any) => {
        f.notified.push(n);
        return { id: "n_1", effectiveLevel: n.level };
      },
    },
    transcriber: {
      engine: () => (opts.engine === false ? undefined : { label: "Fake" }),
      transcribe: async (file: string, mimeType?: string) => {
        f.heard.push({ file, mimeType, bytes: readFileSync(file, "utf8") });
        return opts.transcribe ? opts.transcribe(file) : "сначала каталог";
      },
    },
  } as unknown as Hub;
  return f;
}

const task = (over: Partial<Task> = {}): Task => ({ id: "t_1", conversationId: "c_task", agentId: "coder", title: "Order", goal: "", status: "running", createdBy: "agent", background: false, createdAt: "", updatedAt: "", ...over }) as Task;

describe("core methods for plugins", () => {
  it("conversations.tell wakes the task that exists, with the note stored in it as outside content", async () => {
    const f = fakeHub({ tasks: [task()] });
    const r = await createCoreCall(f.hub)("browser", "conversations.tell", { taskId: "t_1", conversationId: "c_dialog", text: "[System] The person showed: 1) clicked «Каталог»" });
    expect(r).toEqual({ conversationId: "c_task", delivered: "task" });
    expect(f.messages).toEqual([{ conversationId: "c_task", role: "system", text: "[System] The person showed: 1) clicked «Каталог»", taskId: "t_1" }]);
    expect(f.woken).toEqual([{ taskId: "t_1", text: "[System] The person showed: 1) clicked «Каталог»", opts: { taint: true } }]);
    expect(f.told).toEqual([]);
  });

  it("conversations.tell goes to the dialog: the one named, else the default agent's; a cancelled task's note reaches its starter", async () => {
    const f = fakeHub({ tasks: [task({ id: "t_gone", parentConversationId: "c_other" })], wake: "cancelled" });
    const call = createCoreCall(f.hub);
    expect(await call("browser", "conversations.tell", { conversationId: "c_other", text: "hint" })).toEqual({ conversationId: "c_other", delivered: "dialog" });
    expect(await call("browser", "conversations.tell", { text: "noticed a routine" })).toEqual({ conversationId: "c_dialog", delivered: "dialog" });
    // A task id that does not exist: the dialog.
    expect(await call("browser", "conversations.tell", { taskId: "t_missing", text: "recording" })).toEqual({ conversationId: "c_dialog", delivered: "dialog" });
    expect(await call("browser", "conversations.tell", { taskId: "t_gone", text: "late recording" })).toEqual({ conversationId: "c_other", delivered: "dialog" });
    expect(f.told).toEqual([
      { conversationId: "c_other", note: "hint", opts: { taint: true } },
      { conversationId: "c_dialog", note: "noticed a routine", opts: { taint: true } },
      { conversationId: "c_dialog", note: "recording", opts: { taint: true } },
      { conversationId: "c_other", note: "late recording", opts: { taint: true } },
    ]);
    await expect(call("browser", "conversations.tell", { conversationId: "c_nope", text: "x" })).rejects.toThrow(/conversation not found/);
    await expect(call("browser", "conversations.tell", { text: "  " })).rejects.toThrow(/text is required/);
  });

  it("speech.transcribe turns a clip into words through a temp file it always removes", async () => {
    const f = fakeHub();
    const call = createCoreCall(f.hub);
    expect(await call("browser", "speech.transcribe", { check: true })).toEqual({ available: true });
    expect(await createCoreCall(fakeHub({ engine: false }).hub)("browser", "speech.transcribe", { check: true })).toEqual({ available: false });

    const r = await call("browser", "speech.transcribe", { data: Buffer.from("OggS fake").toString("base64"), mimeType: "audio/webm;codecs=opus" });
    expect(r).toEqual({ text: "сначала каталог" });
    expect(f.heard).toHaveLength(1);
    expect(f.heard[0]).toMatchObject({ mimeType: "audio/webm;codecs=opus", bytes: "OggS fake" });
    expect(f.heard[0].file).toMatch(/\.webm$/);
    expect(existsSync(f.heard[0].file)).toBe(false);

    // A failure keeps its reason, and the file is gone too.
    const failing = fakeHub({
      transcribe: async () => {
        throw new TranscribeError("Fake answered 401: Invalid API key");
      },
    });
    await expect(createCoreCall(failing.hub)("browser", "speech.transcribe", { data: Buffer.from("x").toString("base64"), mimeType: "audio/ogg" })).rejects.toThrow("Fake answered 401: Invalid API key");
    expect(existsSync(failing.heard[0].file)).toBe(false);

    await expect(call("browser", "speech.transcribe", { data: "", mimeType: "audio/ogg" })).rejects.toThrow(/no audio/);
    await expect(call("browser", "speech.transcribe", { data: "A".repeat(36 * 1024 * 1024), mimeType: "audio/ogg" })).rejects.toThrow(/25 MB/);
  });

  it("tasks.create runs a skill: the task carries it and its goal says to follow it", async () => {
    const f = fakeHub();
    const call = createCoreCall(f.hub);
    await call("triggers", "tasks.create", { agentId: "assistant", goal: "Order water", title: "Water", triggerId: "t_w", skill: "order-water" });
    expect(f.created[0]).toMatchObject({ skill: "order-water", createdBy: "trigger", background: true });
    expect(f.created[0].goal).toMatch(/^Order water\n\n.*skill "order-water"/s);
    await call("triggers", "tasks.create", { agentId: "assistant", goal: "No skill" });
    expect(f.created[1].skill).toBeUndefined();
    expect(f.created[1].goal).toBe("No skill");
    await expect(call("triggers", "tasks.create", { agentId: "assistant", goal: "x", skill: "nope" })).rejects.toThrow(/No skill "nope"/);
  });

  it("notify records a valid call and tells the plugin what is wrong with an invalid one", async () => {
    const f = fakeHub();
    const call = createCoreCall(f.hub);
    expect(await call("triggers", "notify", { title: "Ботсад закрыт", body: "Весь день", agentId: "assistant" })).toEqual({ id: "n_1", level: "notify" });
    expect(f.notified).toEqual([{ level: "notify", title: "Ботсад закрыт", body: "Весь день", triggerId: undefined, agentId: "assistant", taskId: undefined }]);
    await expect(call("triggers", "notify", { level: "normal", title: "x" })).rejects.toThrow(/level must be one of silent, digest, notify, ask/);
    await expect(call("triggers", "notify", { level: "digest" })).rejects.toThrow(/title is required/);
    expect(f.notified).toHaveLength(1);
  });
});

describe("files.fetch: a file an agent hands a plugin", () => {
  it("reads a file inside the session's workspace and nothing outside it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "fetch-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "fetch-out-"));
    mkdirSync(join(ws, "attachments"));
    writeFileSync(join(ws, "attachments", "photo.jpg"), "jpeg bytes");
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
    const f = fakeHub();
    const sessions: Record<string, any> = { s_local: { id: "s_local", brainRef: "fake@local" }, s_far: { id: "s_far", brainRef: "fake@vps" } };
    (f.hub as any).store.getSession = (id: string) => sessions[id];
    (f.hub as any).runner.workspacePath = () => ws;
    const call = createCoreCall(f.hub);
    const got = (await call("browser", "files.fetch", { sessionId: "s_local", path: "attachments/photo.jpg" })) as { name: string; size: number; data: string };
    expect(got).toMatchObject({ name: "photo.jpg", size: 10 });
    expect(Buffer.from(got.data, "base64").toString()).toBe("jpeg bytes");
    // An absolute path inside the workspace is fine too.
    expect(await call("browser", "files.fetch", { sessionId: "s_local", path: join(ws, "attachments", "photo.jpg") })).toMatchObject({ name: "photo.jpg" });
    await expect(call("browser", "files.fetch", { sessionId: "s_local", path: "../" + join("..", outside, "secret.txt") })).rejects.toThrow(/outside the workspace|there is no/);
    await expect(call("browser", "files.fetch", { sessionId: "s_local", path: join(outside, "secret.txt") })).rejects.toThrow(/outside the workspace/);
    await expect(call("browser", "files.fetch", { sessionId: "s_local", path: "link.txt" })).rejects.toThrow(/outside the workspace/);
    await expect(call("browser", "files.fetch", { sessionId: "s_local", path: "attachments" })).rejects.toThrow(/not a file/);
    await expect(call("browser", "files.fetch", { sessionId: "s_local", path: "missing.jpg" })).rejects.toThrow(/there is no missing.jpg/);
    await expect(call("browser", "files.fetch", { sessionId: "s_far", path: "attachments/photo.jpg" })).rejects.toThrow(/on the hub/);
  });
});
