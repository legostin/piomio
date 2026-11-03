import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("show_images from a remote parent dialog (no listeners)", () => {
  it.each(["linux", "windows"])("%s: maps its own and its tasks' absolute paths, waits for sync, refuses other folders", async (os) => {
    const dataDir = mkdtempSync(join(tmpdir(), "remote-show-images-"));
    const hub = new Hub(loadConfig({ PIOMIO_DEVICES: "0" }, { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(dataDir, "agents") }));
    try {
      const dialog = hub.store.agentConversation("assistant");
      const task = hub.store.createTask({ agentId: "artist", title: "Render", goal: "x", createdBy: "agent", background: false, parentConversationId: dialog.id });
      const workspace = hub.runner.workspacePath({ agentId: "assistant", conversationId: dialog.id });
      const taskWs = hub.runner.workspacePath({ agentId: "artist", taskId: task.id, conversationId: task.conversationId });
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(taskWs, "out"), { recursive: true });
      const remote = (agent: string, folder: string, file: string) => os === "windows"
        ? `C:\\Users\\me\\owlbot-workspace\\${agent}\\${folder}\\${file.replaceAll("/", "\\")}`
        : `/home/piomio/piomio-workspace/${agent}/${folder}/${file}`;
      const show = (path: string) => hub.tools.get("show_images")!.invoke({ images: [{ path }] }, {
        sessionId: "s", agentId: "assistant", conversationId: dialog.id, callId: "c", tainted: false, background: false, machineId: "mach_remote", workspace,
      } as any);
      // The child file is made on another computer. Its copy arrives later at the child's folder on the hub.
      const arrival = setTimeout(() => writeFileSync(join(taskWs, "out", "render.png"), PNG), 20);
      const result = await show(remote("artist", task.id, "out/render.png"));
      clearTimeout(arrival);
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      const images = hub.store.listMessages(dialog.id).flatMap((m) => m.parts).filter((p) => p.type === "images");
      expect(images).toEqual([{ type: "images", items: [{ src: `file:artist/${task.id}/out/render.png` }] }]);
      writeFileSync(join(workspace, "own.png"), PNG);
      expect((await show("own.png")).isError).toBeFalsy();
      expect((await show(remote("assistant", dialog.id, "own.png"))).isError).toBeFalsy();
      // No access to another task, parent traversal or a symlink escaping the task folder.
      expect((await show(remote("artist", "t_stranger", "render.png"))).isError).toBe(true);
      expect((await show(remote("artist", task.id, "../secret.png"))).isError).toBe(true);
      const outside = join(dataDir, "outside.png");
      writeFileSync(outside, PNG);
      symlinkSync(outside, join(taskWs, "escape.png"));
      expect((await show(remote("artist", task.id, "escape.png"))).isError).toBe(true);
    } finally {
      await hub.stop();
    }
  });
});
