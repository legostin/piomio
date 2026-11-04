// End-to-end: an agent's library. Files the person sends, files the agent sends (send_files), pictures it shows and
// pages it makes all land in GET /api/library; the agent finds them again (library_find), opens them in another
// workspace (library_open) and sends them again; a sent document reaches the channels as a file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const PDF = Buffer.from("%PDF-1.4\n% a contract\n");

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("an agent's library", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";
  let root = "";
  const sent: any[] = [];

  const req = async (method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string }) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        origin: base,
        ...(raw ? { "content-type": raw.type } : body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf": csrf } : {}),
      },
      body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return r;
  };
  const json = async (method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string }) => {
    const r = await req(method, path, body, raw);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return r.json();
  };
  const ctx = (over: Record<string, unknown> = {}) =>
    ({ sessionId: "s", agentId: "assistant", conversationId: conv, callId: "c", tainted: false, background: false, machineId: "local", workspace: hub.runner.workspacePath({ agentId: "assistant", conversationId: conv }), ...over }) as any;
  const tool = (name: string, input: unknown, over: Record<string, unknown> = {}) => hub.tools.get(name)!.invoke(input, ctx(over));
  const said = (r: any) => r.content.map((c: any) => c.text).join("\n");
  const library = (q = "") => json("GET", `/api/library?agent=assistant${q}`);

  /** Send `CALL tool args` and return the assistant reply once it is complete. */
  const call = async (name: string, args: unknown) => {
    const m = await json("POST", `/api/conversations/${conv}/messages`, { text: `CALL ${name} ${JSON.stringify(args)}` });
    return until(async () => {
      const msgs: any[] = await json("GET", `/api/conversations/${conv}/messages`);
      const after = msgs.slice(msgs.findIndex((x) => x.id === m.id) + 1);
      return after.find((x) => x.role === "assistant" && x.status === "complete" && x.parts.some((p: any) => p.type === "text" && p.text.startsWith("tool said:")));
    }, `reply to ${name}`);
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-library-hub-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    root = join(config.dataDir, "workspaces");
    await until(() => hub.brains.has("fake@local"), "the fake brain");
    await json("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await json("GET", "/api/bootstrap");
    csrf = boot.csrf;
    conv = boot.mainConversationId;
    hub.channels.register("phone", "Phone", "phone-test", { closed: false, request: async (_m: string, p: any) => (sent.push(p.message), {}) } as any);
    const ws = hub.runner.workspacePath({ agentId: "assistant", conversationId: conv });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "chart.png"), PNG);
    writeFileSync(join(ws, "report.txt"), "Q3 report");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("holds what the person sent", async () => {
    const part = await json("POST", `/api/conversations/${conv}/attachments?name=contract.pdf&type=application/pdf`, undefined, { data: PDF, type: "application/octet-stream" });
    await json("POST", `/api/conversations/${conv}/messages`, { text: "here is the contract", attachments: [part.path] });
    const lib = await library();
    expect(lib.items[0]).toMatchObject({ kind: "file", from: "person", name: "contract.pdf", path: part.path, mimeType: "application/pdf", agentId: "assistant", conversationId: conv });
    expect(lib.more).toBe(false);
  });

  it("send_files puts the agent's file in the chat, the library and the channels", async () => {
    sent.length = 0;
    const reply = await call("send_files", { files: [{ path: "report.txt", name: "Q3 report.txt" }] });
    expect(reply.parts.find((p: any) => p.type === "tool_result").isError).toBeFalsy();
    const part = reply.parts.find((p: any) => p.type === "attachment");
    expect(part).toMatchObject({ name: "Q3 report.txt", mimeType: "text/plain", size: 9, path: `assistant/${conv}/attachments/Q3 report.txt` });
    // A copy: the agent may change or delete its own file, the library keeps what was sent.
    expect(readFileSync(join(root, part.path), "utf8")).toBe("Q3 report");
    const out = await until(() => sent.find((m) => m.media), "the mirrored reply with the file");
    expect(out.media).toEqual([{ kind: "file", data: Buffer.from("Q3 report").toString("base64"), mimeType: "text/plain", name: "Q3 report.txt" }]);
    const lib = await library("&kind=file");
    expect(lib.items.map((it: any) => [it.name, it.from])).toEqual([
      ["Q3 report.txt", "agent"],
      ["contract.pdf", "person"],
    ]);
  });

  it("pictures the agent showed and pages it made are there too, once each", async () => {
    await call("show_images", { images: [{ path: "chart.png", caption: "Sales" }] });
    await call("show_images", { images: [{ path: "chart.png", caption: "Sales again" }] });
    const page = hub.pages.create({ title: "Trip plan", summary: "Three days in Rome", code: "export default function P() { return null }", data: {} }, { agentId: "assistant", conversationId: conv });
    const lib = await library();
    const media = lib.items.filter((it: any) => it.kind === "media");
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ from: "agent", src: `file:assistant/${conv}/chart.png`, path: `assistant/${conv}/chart.png`, caption: "Sales again" });
    expect(lib.items.find((it: any) => it.kind === "page")).toMatchObject({ id: `page:${page.id}`, name: "Trip plan", caption: "Three days in Rome", pageId: page.id });
    expect((await library("&q=rome")).items.map((it: any) => it.name)).toEqual(["Trip plan"]);
    expect((await library("&q=CONTRACT")).items.map((it: any) => it.name)).toEqual(["contract.pdf"]);
    // Paging: older than the newest item.
    const older = await library(`&limit=1&before=${encodeURIComponent(lib.items[0].at)}`);
    expect(older.items).toHaveLength(1);
    expect(older.more).toBe(true);
    // Another agent's library does not hold them.
    expect((await json("GET", "/api/library?agent=nobody")).items).toEqual([]);
  });

  it("the agent finds, opens and sends again what came before", async () => {
    const found = said(await tool("library_find", { query: "contract" }));
    const ref = /ref: (\S+)/.exec(found)![1];
    expect(found).toMatch(/\[file\] "contract\.pdf" \(application\/pdf, 22 B\), from the person/);

    // In a task of its own, the file comes into the task's folder.
    const task = hub.store.createTask({ agentId: "assistant", title: "Review", goal: "x", createdBy: "agent", background: false, parentConversationId: conv });
    const taskWs = hub.runner.workspacePath({ agentId: "assistant", taskId: task.id, conversationId: task.conversationId });
    mkdirSync(taskWs, { recursive: true });
    const opened = said(await tool("library_open", { refs: [ref, "elsewhere/x.pdf"] }, { workspace: taskWs, conversationId: task.conversationId, taskId: task.id }));
    expect(opened).toContain(`${ref}: attachments/contract.pdf`);
    expect(opened).toMatch(/elsewhere\/x\.pdf: not in your library/);
    expect(readFileSync(join(taskWs, "attachments", "contract.pdf"))).toEqual(PDF);

    // Sent again by its ref: the same file, no second copy.
    const again = await tool("send_files", { files: [{ path: ref }] });
    expect(again.isError).toBeFalsy();
    const kind = (await library("&kind=file")).items.filter((it: any) => it.name === "contract.pdf");
    expect(kind).toHaveLength(1);
    expect(existsSync(join(root, `assistant/${conv}/attachments/contract (2).pdf`))).toBe(false);
  });

  it("send_files refuses files outside the workspace, missing ones and too many", async () => {
    for (const [input, why] of [
      [{ files: [{ path: "../../../piomio.db" }] }, /outside your workspace|no such file/],
      [{ files: [{ path: "missing.pdf" }] }, /no such file/],
      [{ files: [{ name: "x" }] }, /give path/],
      [{ files: Array.from({ length: 11 }, () => ({ path: "report.txt" })) }, /At most 10/],
    ] as const) {
      const r = await tool("send_files", input);
      expect(r.isError, JSON.stringify(input).slice(0, 60)).toBe(true);
      expect(said(r)).toMatch(why);
    }
  });
});
