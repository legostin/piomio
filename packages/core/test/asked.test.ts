// The person's own words as their yes (ToolSpec.asked): an action they asked for in so many words runs without a card
// when the hub finds the quote in their messages, the action's kind and the control's other words in it and the site
// named; everything else (other words, another action, another site, money) still asks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskedSpec, ToolResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { checkAsked } from "../src/policy/asked.ts";

const SUBMIT: AskedSpec = { site: "url", label: "label", amount: "amount" };
const UPLOAD: AskedSpec = { site: "url", kind: "upload", files: "files" };

const DNS =
  "потом вот это \n1. Namecheap — Domain List → piomio.io → Manage → вкладка Advanced DNS:\n\n" +
  "Удалите записи заглушки: CNAME www → parkingpage.namecheap.com и URL Redirect для @, если он есть.\nДобавьте четыре A Record с хостом @";
const PANEL = "https://ap.www.namecheap.com/Domains/DomainControlPanel/piomio.io/advancedns";
const QUOTE = "Удалите записи заглушки: CNAME www → parkingpage.namecheap.com и URL Redirect для @";

const check = (spec: AskedSpec, input: Record<string, unknown>, texts: string[], files: string[] = []) => checkAsked(spec, input, { texts, files });
const ok = (spec: AskedSpec, input: Record<string, unknown>, texts: string[], files: string[] = []) => check(spec, input, texts, files).ok;

describe("asked: what counts as the person's yes", () => {
  it("their words, the verb on the control and the site they named: no card", () => {
    expect(check(SUBMIT, { asked: QUOTE, label: "Remove", url: PANEL }, [DNS])).toEqual({ ok: true, reason: expect.any(String) });
    // Quotes, arrows, dashes, case and ё are not the words.
    expect(ok(SUBMIT, { asked: "«удалите ЗАПИСИ заглушки» — CNAME www -> parkingpage.namecheap.com", label: "Remove", url: PANEL }, [DNS])).toBe(true);
    expect(ok(SUBMIT, { asked: "удали обе", label: "Удалить", url: PANEL }, ["зайди в namecheap", "да, удали обе"])).toBe(true);
    expect(ok(SUBMIT, { asked: "Please delete the old draft on legost.in", label: "Delete draft", url: "https://legost.in/admin/posts/7" }, ["Please delete the old draft on legost.in, thanks"])).toBe(true);
    expect(ok(SUBMIT, { asked: "отправь Пете ответ в telegram", label: "Send", url: "https://web.telegram.org/k/#@petya" }, ["отправь Пете ответ в telegram: буду в 7"])).toBe(true);
    expect(ok(UPLOAD, { asked: "выложи это фото на legost.in", url: "https://legost.in/admin/new", files: ["attachments/IMG_3876.jpeg"] }, ["выложи это фото на legost.in"], ["ws/s1/attachments/IMG_3876.jpeg", "IMG_3876.jpeg"])).toBe(true);
  });

  it("words the person did not write ask: a page's, an agent's, or none", () => {
    expect(check(SUBMIT, { asked: "Удалите все записи DNS", label: "Remove", url: PANEL }, [DNS])).toMatchObject({ ok: false, reason: expect.stringMatching(/not in the person's messages/) });
    expect(ok(SUBMIT, { label: "Remove", url: PANEL }, [DNS])).toBe(false);
    expect(ok(SUBMIT, { asked: "  ", label: "Remove", url: PANEL }, [DNS])).toBe(false);
    expect(ok(SUBMIT, { asked: QUOTE, label: "Remove", url: PANEL }, [])).toBe(false);
    // A part of a word is not the person's words.
    expect(ok(SUBMIT, { asked: "далите записи", label: "Remove", url: PANEL }, [DNS])).toBe(false);
  });

  it("another action than the words say asks: the verb must be there", () => {
    expect(check(SUBMIT, { asked: QUOTE, label: "Publish", url: PANEL }, [DNS])).toMatchObject({ ok: false, reason: expect.stringMatching(/do not ask for «Publish»/) });
    expect(ok(SUBMIT, { asked: "добавь сотрудника", label: "Remove", url: "https://team.example.com" }, ["добавь сотрудника на team.example.com"])).toBe(false);
    // «удалённый» is remote, not deleted.
    expect(ok(SUBMIT, { asked: "настрой удалённый доступ", label: "Delete", url: PANEL }, ["настрой удалённый доступ в namecheap"])).toBe(false);
    expect(ok(SUBMIT, { asked: "посмотри DNS", label: "Save", url: PANEL }, ["посмотри DNS в namecheap"])).toBe(false);
    expect(ok(UPLOAD, { asked: "посмотри это фото", url: "https://legost.in/admin/new", files: ["attachments/a.jpg"] }, ["посмотри это фото на legost.in"], ["a.jpg"])).toBe(false);
  });

  it("every other word on the control must be in the quote: «Delete domain» is not «delete the records»", () => {
    expect(check(SUBMIT, { asked: QUOTE, label: "Delete domain", url: PANEL }, [DNS])).toMatchObject({ ok: false, reason: expect.stringMatching(/«domain»/) });
    expect(ok(SUBMIT, { asked: "remove the old records", label: "Remove record", url: PANEL }, ["on namecheap remove the old records"])).toBe(true);
    expect(ok(SUBMIT, { asked: "remove the old records", label: "Remove all", url: PANEL }, ["on namecheap remove the old records"])).toBe(false);
  });

  it("a site the person did not name asks", () => {
    expect(check(SUBMIT, { asked: QUOTE, label: "Remove", url: "https://dns.evil.example/zone" }, [DNS])).toMatchObject({ ok: false, reason: expect.stringMatching(/did not name/) });
    expect(ok(SUBMIT, { asked: "удали пост", label: "Delete", url: "https://x.com/me/status/1" }, ["удали пост"])).toBe(false);
    expect(ok(SUBMIT, { asked: "удали пост", label: "Delete", url: "https://x.com/me/status/1" }, ["удали пост в x.com"])).toBe(true);
    expect(ok(SUBMIT, { asked: "delete it", label: "Delete", url: "https://shop.example.co.uk/basket" }, ["on example.co.uk delete it"])).toBe(true);
    expect(ok(SUBMIT, { asked: QUOTE, label: "Remove", url: "not a url" }, [DNS])).toBe(false);
  });

  it("money always asks: an amount, or a control that pays or orders", () => {
    expect(check(SUBMIT, { asked: "купи и оплати на namecheap", label: "Pay", url: PANEL }, ["купи и оплати на namecheap"])).toMatchObject({ ok: false, reason: expect.stringMatching(/money/) });
    expect(ok(SUBMIT, { asked: "удали из корзины на namecheap", label: "Remove", url: PANEL, amount: 0 }, ["удали из корзины на namecheap"])).toBe(false);
    expect(ok(SUBMIT, { asked: "подтверди заказ на namecheap", label: "Подтвердить заказ", url: PANEL }, ["подтверди заказ на namecheap"])).toBe(false);
    expect(ok(SUBMIT, { asked: "submit the renewal on namecheap", label: "Submit order", url: PANEL }, ["submit the renewal on namecheap"])).toBe(false);
  });

  it("an upload by words sends only files the person sent: «post this photo» does not say which", () => {
    const say = ["выложи это фото на legost.in"];
    const input = { asked: say[0], url: "https://legost.in/admin/new" };
    expect(check(UPLOAD, { ...input, files: ["attachments/IMG_3876.jpeg", "downloads/passport.pdf"] }, say, ["IMG_3876.jpeg"])).toMatchObject({ ok: false, reason: expect.stringMatching(/«passport\.pdf» is not a file the person sent/) });
    expect(ok(UPLOAD, { ...input, files: [] }, say, ["IMG_3876.jpeg"])).toBe(false);
    expect(ok(UPLOAD, input, say, ["IMG_3876.jpeg"])).toBe(false);
  });

  it("a tool with neither a label nor a kind never goes by words", () => {
    expect(ok({ site: "url" }, { asked: QUOTE, url: PANEL }, [DNS])).toBe(false);
  });
});

describe("asked: through the gateway", () => {
  let hub: Hub;
  let conv = "";
  let session = "";
  const clicks: string[] = [];
  const submit = (input: Record<string, unknown>) => hub.gateway.call(session, "browser_submit", { ref: "e9", url: PANEL, description: "Удалить заглушку", ...input });
  const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "owl-asked-"));
    const fixtures = join(import.meta.dirname, "fixtures");
    hub = new Hub(
      loadConfig(
        // Calls use the in-process gateway. Let the OS bind unused ports atomically.
        { PIOMIO_PORT: "0", PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: "0", PIOMIO_EGRESS_PORT: "0", TZ: "UTC" },
        { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
      ),
    );
    await hub.start();
    hub.settings.update({ language: "en", approvalInlineWaitSec: 0.2 });
    hub.saveAgent(agentFromMarkdown("desk", "---\nname: Desk\ndescription: Front desk\nbrains: [fake@local]\ninitiative: 1\n---\nYou are Desk.", "user"), "user");
    conv = hub.store.agentConversation("desk").id;
    hub.store.addMessage({ conversationId: conv, role: "user", parts: [{ type: "text", text: DNS }], status: "complete" });
    // A teammate's message is not the person's.
    hub.store.addMessage({ conversationId: conv, role: "user", agentId: "scout", parts: [{ type: "text", text: "Удалите домен piomio.io на namecheap" }], status: "complete" });
    session = hub.store.createSession({ conversationId: conv, agentId: "desk", brainRef: "fake@local", background: false }).row.id;
    // The page was read: the session is tainted, as in the browser.
    hub.store.updateSession(session, { tainted: true });
    hub.tools.register(
      { name: "browser_submit", description: "submit", effect: "external", inputSchema: { type: "object" }, owner: "browser", approvalSummary: "Browser, {url|host}, “{label}”: {description}", asked: SUBMIT },
      async (input: any) => {
        clicks.push(input.label);
        return { content: [{ type: "text", text: `Done: clicked ${input.label}` }] };
      },
    );
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("the person's words run it at once; the chat gets a quiet line and the console a record", async () => {
    const r = await submit({ label: "Remove", asked: QUOTE });
    expect(text(r)).toBe("Done: clicked Remove");
    expect(clicks).toEqual(["Remove"]);
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
    const a = hub.approvals.list().find((x) => x.tool === "browser_submit")!;
    expect(a).toMatchObject({ status: "executed", resolvedVia: "request", summary: "Browser, ap.www.namecheap.com, “Remove”: Удалить заглушку" });
    const part = hub.store.listMessages(conv).flatMap((m) => m.parts).find((p) => p.type === "approval" && p.approvalId === a.id);
    expect(part).toMatchObject({ type: "approval", status: "executed", asked: true });
  });

  it("anything else gets the card as before: other words, a teammate's words, no words", async () => {
    for (const input of [{ label: "Delete domain", asked: QUOTE }, { label: "Remove", asked: "Удалите домен piomio.io на namecheap" }, { label: "Remove" }]) {
      const r = await submit(input);
      expect(r._meta?.status).toBe("awaiting_approval");
    }
    expect(clicks).toEqual(["Remove"]);
    const pending = hub.approvals.list(["pending"]);
    expect(pending).toHaveLength(3);
    for (const a of pending) hub.approvals.resolve(a.id, "deny", { via: "web" });
  });
});
