// Group chats from the chat (tools/group-tools.ts): an agent makes a group from names, renames it, adds and removes
// members and changes who leads; the limits hold, and from inside a group "this group" is the default.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("group tools", () => {
  let hub: Hub;
  const call = async (name: string, input: unknown, conversationId = "c") => {
    const r = await hub.tools.get(name)!.invoke(input, { sessionId: "s", agentId: "assistant", callId: "c", tainted: false, background: false, workspace: "", machineId: "local", conversationId });
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError };
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-groups-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    const base = hub.agents.get("assistant")!;
    for (const [id, name] of [["researcher", "Researcher"], ["atlas", "Atlas"]]) hub.agents.save({ ...base, id, name, source: "user", i18n: { ru: { name: id === "atlas" ? "Атлас" : "Исследователь" } } } as AgentDef);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("makes a group from names, the first leading, within the limits", async () => {
    expect((await call("group_create", { members: ["Researcher"] })).text).toContain("2 to 8 agents");
    expect((await call("group_create", { members: ["Researcher", "Nobody"] })).text).toContain('No agent "Nobody"');
    const made = await call("group_create", { title: "Trip", members: ["Исследователь", "atlas", "Researcher"] });
    expect(made.isError).toBe(false);
    const g = hub.store.listConversations(50).find((c) => c.kind === "group" && c.title === "Trip")!;
    expect(g.members).toEqual(["researcher", "atlas"]);
    expect(g.agentId).toBe("researcher");
    expect(made.text).toContain("Researcher (leads), Atlas");
  });

  it("changes this group: name, members and lead; refuses to leave fewer than two", async () => {
    const g = hub.store.listConversations(50).find((c) => c.kind === "group" && c.title === "Trip")!;
    expect((await call("group_update", { title: "x" })).text).toContain("this chat is not one");
    const upd = await call("group_update", { title: "Almaty trip", add: ["assistant"], lead: "Атлас" }, g.id);
    expect(upd.isError).toBe(false);
    expect(hub.store.getConversation(g.id)).toMatchObject({ title: "Almaty trip", members: ["atlas", "researcher", "assistant"], agentId: "atlas" });
    expect((await call("group_update", { group: "Almaty trip", remove: ["researcher", "assistant"] })).text).toContain("2 to 8 agents");
    expect((await call("group_update", { group: "Almaty trip", remove: ["assistant"] })).text).toContain("Atlas (leads), Researcher");
    expect((await call("group_update", {}, g.id)).text).toContain("Nothing to change");
  });

  it("asks the user first after outside content", () => {
    expect(hub.tools.get("group_create")!.descriptor.askWhenTainted).toBe(true);
    expect(hub.tools.get("group_update")!.descriptor.askWhenTainted).toBe(true);
  });
});
