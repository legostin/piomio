import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainTurn } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

describe("the person's files for a brain on another computer", () => {
  it("are put in the hub's copy of its folder, which syncs there, and the note says where", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "remote-attachments-"));
    const hub = new Hub(loadConfig({ PIOMIO_DEVICES: "0" }, { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(dataDir, "agents") }));
    try {
      const dialog = hub.store.agentConversation("assistant");
      const folder = hub.runner.workspacePath({ agentId: "assistant", conversationId: dialog.id });
      mkdirSync(join(folder, "attachments"), { recursive: true });
      writeFileSync(join(folder, "attachments", "shot.jpeg"), "jpeg");
      const shot = { type: "attachment" as const, path: `assistant/${dialog.id}/attachments/shot.jpeg`, name: "shot.jpeg", mimeType: "image/jpeg", size: 4 };
      const turn = (row: object, attachments: unknown[]): BrainTurn =>
        (hub.runner as any).turnInput({ id: "s_far", agentId: "assistant", conversationId: dialog.id, brainRef: "claude-code@mach_pc", ...row }, "What is this?", { attachments });

      // A dialog's own file is already in its folder.
      const said = turn({}, [shot]);
      expect(said.attachments).toEqual(["attachments/shot.jpeg"]);
      expect(said.text).toContain("- attachments/shot.jpeg (image/jpeg, 4 B)");
      expect(said.text).toContain("wait a few seconds and look again");
      expect(said.text).not.toContain("not on this machine");

      // A task's folder gets its own copy, which syncs to the task's computer.
      const task = hub.store.createTask({ agentId: "assistant", title: "Look", goal: "x", createdBy: "agent", background: false, parentConversationId: dialog.id });
      const taskFolder = hub.runner.workspacePath({ agentId: "assistant", taskId: task.id, conversationId: task.conversationId });
      expect(turn({ taskId: task.id, conversationId: task.conversationId }, [shot]).attachments).toEqual(["attachments/shot.jpeg"]);
      expect(existsSync(join(taskFolder, "attachments", "shot.jpeg"))).toBe(true);

      // Too big to sync: it stays on the hub, and the note says so.
      const film = { ...shot, path: `assistant/${dialog.id}/attachments/film.mov`, name: "film.mov", mimeType: "video/quicktime", size: 300 * 1024 * 1024 };
      writeFileSync(join(folder, "attachments", "film.mov"), "mov");
      const big = turn({}, [film]);
      expect(big.attachments).toBeUndefined();
      expect(big.text).toContain("film.mov (video/quicktime, 300 MB): stays on the hub, too big to copy to this computer");
    } finally {
      await hub.stop();
    }
  });
});
