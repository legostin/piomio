import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval, ToolResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

const body = (result: ToolResult) => JSON.parse(result.content.find((c) => c.type === "text")!.text!);

describe("networked commands through the real hub approval handler (no listeners)", () => {
  it.each(["Bash", "codex.command"])("%s: declining a task's push stops it, allowing a fetch returns it to the CLI", async (tool) => {
    const dataDir = mkdtempSync(join(tmpdir(), "network-approval-"));
    const hub = new Hub(loadConfig({ PIOMIO_DEVICES: "0" }, { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(dataDir, "agents") }));
    hub.settings.update({ approvalMode: "ask" });
    const cards: Approval[] = [];
    const off = hub.bus.on("approval.created", (a: Approval) => {
      cards.push(a);
      // Let the handler install its waiter before answering the card.
      queueMicrotask(() => hub.approvals.resolve(a.id, cards.length === 1 ? "deny" : "approve", { via: "console" }));
    });
    const call = (command: string) => hub.tools.get("native_permission")!.invoke({ tool_name: tool, input: { command } }, {
      sessionId: "s-network", conversationId: "c-network", taskId: "t-network", agentId: "developer", callId: "call",
      tainted: false, background: false, workspace: join(dataDir, "workspaces/developer/t-network"), machineId: "local",
    });
    try {
      expect(body(await call("git push origin main"))).toMatchObject({ behavior: "deny", message: expect.stringContaining("declined") });
      expect(cards[0].ask).toMatchObject({ kind: "command", detail: "git push origin main" });
      expect(body(await call("git fetch https://github.com/legostin/piomio.git main"))).toMatchObject({ behavior: "allow" });
      expect(cards).toHaveLength(2);
      expect(body(await call("git status --short"))).toMatchObject({ behavior: "allow" });
      expect(cards).toHaveLength(2);
    } finally {
      off();
      await hub.stop();
    }
  });
});
