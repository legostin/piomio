// After an update the default agent tells the person what changed: once per version, with the release's notes, and
// not again from another replica that starts on the same version.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { announceUpdate, compareVersions } from "../src/updates.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("compareVersions", () => {
  it("compares dotted versions as numbers", () => {
    expect(compareVersions("0.10.0", "0.9.2")).toBe(1);
    expect(compareVersions("0.2.0", "v0.2.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});

describe("the note after an update", () => {
  let hub: Hub;
  let conv = "";
  const asked: string[] = [];
  const github = (async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ body: "## What's Changed\n* The agents' browser is an ordinary browser by @legostin" }), { status: 200 });
  }) as unknown as typeof fetch;
  const notes = () => hub.store.listMessages(conv, { limit: 500 }).filter((m) => m.role === "system" && (m.parts[0] as { text?: string })?.text?.startsWith("[System] Piomio was updated"));
  const seen = (v: string) => hub.db.prepare("insert into meta(key, value) values ('app_version', ?) on conflict(key) do update set value = excluded.value").run(v);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-updates-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.saveAgent(agentFromMarkdown("desk", "---\nname: Desk\ndescription: Front desk\nbrains: [fake@local]\n---\nYou are Desk.", "user"), "user");
    hub.settings.update({ defaultAgent: "desk", language: "ru" });
    conv = hub.store.agentConversation("desk").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("says nothing on the first start or the same version", async () => {
    expect(await announceUpdate(hub, github)).toBe(false);
    expect(notes()).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("asks the default agent to tell the person, in their language, with the release's notes", async () => {
    seen("0.0.9");
    expect(await announceUpdate(hub, github)).toBe(true);
    expect(asked).toEqual([`https://api.github.com/repos/legostin/piomio/releases/tags/v${hub.config.version}`]);
    const [note] = notes();
    const text = (note.parts[0] as { text: string }).text;
    expect(text).toContain(`from 0.0.9 to ${hub.config.version}.`);
    expect(text).toContain('the hub\'s is "ru"');
    expect(text).toContain("The agents' browser is an ordinary browser");
    // Once per version: the next start, or another replica that saw the older version, stays quiet.
    expect(await announceUpdate(hub, github)).toBe(false);
    seen("0.0.9");
    expect(await announceUpdate(hub, github)).toBe(false);
    expect(notes()).toHaveLength(1);
  });
});
