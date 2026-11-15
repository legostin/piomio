// The Telegram account integration against a fake Telegram (fake-telegram.ts): connecting by QR code with a
// two-step password, the session's key in the vault, what agents see (nothing until the person opens it; closed chats
// do not exist for them), sending only in the write mode and only to the chat the approval card named, an agent's
// request answered by the person, the "message" signal, a session ended from Telegram, and disconnecting.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { canRead, chatAccess, cleanAccess, emptyAccess, withException } from "../server/access.ts";
import { qrSvg } from "../server/account.ts";
import type { AccountStatus, ChatRow } from "../server/account.ts";
import { parseAppKeys } from "../server/app-keys.ts";
import type { RequestView } from "../server/requests.ts";
import { chatLine, messageLine } from "../server/tools.ts";
import type { Fixture } from "./fake-telegram.ts";

const dir = join(import.meta.dirname, "..");
const fake = join(import.meta.dirname, "fake-telegram.ts");

const FAMILY = { id: "-1001", kind: "group" as const, title: "Family", unread: 2, lastMessageAt: "2026-11-15T09:30:00.000Z" };
const WORK = { id: "-1002", kind: "group" as const, title: "Work secrets" };
const ANNA = { id: "501", kind: "private" as const, title: "Anna Petrova", username: "anna" };
const NEWS = { id: "-2001", kind: "channel" as const, title: "City news", username: "citynews" };
const SAVED = { id: "100", kind: "private" as const, title: "Saved Messages", self: true };
const SERVICE = { id: "777000", kind: "private" as const, title: "Telegram" };

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    account: { id: "100", name: "Lena", username: "lena" },
    chats: [FAMILY, WORK, ANNA, NEWS, SAVED, SERVICE],
    messages: {
      [FAMILY.id]: [
        { id: 10, chatId: FAMILY.id, date: "2026-11-15T09:00:00.000Z", out: false, sender: "Mom", text: "Dinner at seven?" },
        { id: 11, chatId: FAMILY.id, date: "2026-11-15T09:10:00.000Z", out: true, text: "Yes", replyTo: 10 },
        { id: 12, chatId: FAMILY.id, date: "2026-11-15T09:30:00.000Z", out: false, sender: "Dad", text: "The recipe", media: { kind: "document", fileName: "recipe.pdf", mime: "application/pdf", size: 5 }, file: Buffer.from("%PDF-").toString("base64") },
      ],
      [WORK.id]: [{ id: 20, chatId: WORK.id, date: "2026-11-15T10:00:00.000Z", out: false, sender: "Boss", text: "The dinner budget is secret" }],
      [ANNA.id]: [{ id: 30, chatId: ANNA.id, date: "2026-11-14T10:00:00.000Z", out: false, sender: "Anna Petrova", text: "See you at dinner" }],
      [SERVICE.id]: [{ id: 40, chatId: SERVICE.id, date: "2026-11-15T11:00:00.000Z", out: false, sender: "Telegram", text: "Login code: 12345. Do not give this code to anyone, dinner or not" }],
      [SAVED.id]: [{ id: 50, chatId: SAVED.id, date: "2026-11-13T10:00:00.000Z", out: true, text: "dinner password hunter2" }],
    },
    sessions: [],
    ...over,
  };
}

interface Run {
  h: PluginHarness;
  /** Ask the fake Telegram to do something, or what the plugin did to it. */
  control(path: string, body?: unknown): Promise<any>;
  status(): Promise<AccountStatus>;
  post(path: string, body?: unknown): Promise<{ status?: number; body?: any }>;
  until(state: AccountStatus["state"]): Promise<AccountStatus>;
}

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function run(
  o: { fixture?: Fixture; vault?: Record<string, Record<string, string>>; storage?: Map<string, unknown>; env?: Record<string, string>; delivered?: Array<{ name: string; data: string }>; vaultState?: { state: string } } = {},
): Promise<Run> {
  const file = join(mkdtempSync(join(tmpdir(), "tg-account-")), "fixture.json");
  writeFileSync(file, JSON.stringify(o.fixture ?? fixture()));
  const h = await startPlugin({
    dir,
    env: { TELEGRAM_ACCOUNT_TEST_CLIENT: fake, TELEGRAM_ACCOUNT_TEST_FIXTURE: file, ...o.env },
    ...(o.vault ? { vault: o.vault } : {}),
    ...(o.storage ? { storage: o.storage } : {}),
    core: (method, params) => {
      if (method === "files.deliver") {
        o.delivered?.push({ name: params.name, data: params.data });
        return { path: `downloads/${params.name}` };
      }
      if (method === "vault.check") return { state: o.vaultState?.state ?? "unlocked", exists: false };
      if (method === "files.fetch") return { name: String(params.path).split("/").pop(), size: 3, data: Buffer.from("abc").toString("base64") };
      return {};
    },
  });
  const port = await until(() => existsSync(`${file}.port`) && readFileSync(`${file}.port`, "utf8"), "the fake Telegram's control port");
  const control = async (path: string, body?: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) })).json();
  const status = async () => (await h.http({ path: "/status" })).body as AccountStatus;
  return {
    h,
    control,
    status,
    post: (path, body) => h.http({ method: "POST", path, body }),
    until: (state) => until(async () => ((await status()).state === state ? status() : undefined), `the state "${state}"`),
  };
}

/** Sign in as the person would: the code is shown, the phone scans it. */
async function signIn(r: Run): Promise<void> {
  expect(((await r.post("/signin")).body as AccountStatus).state).toBe("qr");
  await r.control("/scan");
  await r.until("connected");
}

describe("which chats agents may see", () => {
  it("opens nothing until the person does", () => {
    const a = emptyAccess();
    for (const c of [FAMILY, ANNA, NEWS, SAVED, SERVICE]) expect(canRead(a, c)).toBe(false);
  });

  it("opens kinds, and exceptions either way; closed wins", () => {
    let a = cleanAccess({ kinds: { group: true } });
    expect([canRead(a, FAMILY), canRead(a, WORK), canRead(a, ANNA)]).toEqual([true, true, false]);
    a = withException(a, WORK, "closed");
    a = withException(a, ANNA, "open");
    expect([canRead(a, FAMILY), canRead(a, WORK), canRead(a, ANNA)]).toEqual([true, false, true]);
    expect(chatAccess(a, WORK)).toEqual({ state: "closed", reason: "exception" });
    a = withException(a, WORK, "default");
    expect(chatAccess(a, WORK)).toEqual({ state: "open", reason: "kind" });
  });

  it("never opens Telegram's service chat, and Saved Messages only by name", () => {
    let a = cleanAccess({ kinds: { private: true, group: true, channel: true, bot: true }, open: { [SERVICE.id]: { title: "Telegram", kind: "private" } } });
    expect(chatAccess(a, SERVICE)).toEqual({ state: "closed", reason: "service" });
    expect(chatAccess(a, SAVED)).toEqual({ state: "closed", reason: "saved" });
    a = withException(a, SERVICE, "open");
    expect(canRead(a, SERVICE)).toBe(false);
    a = withException(a, SAVED, "open");
    expect(canRead(a, SAVED)).toBe(true);
  });

  it("reads what storage held as closed unless it clearly says open", () => {
    const a = cleanAccess({ kinds: { private: "yes", group: 1, channel: true }, open: { "not-an-id": { title: "x", kind: "group" }, "5": { title: "ok", kind: "weird" } }, closed: null });
    expect(a).toEqual({ kinds: { private: false, group: false, channel: true, bot: false }, open: {}, closed: {} });
    expect(cleanAccess("junk")).toEqual(emptyAccess());
  });
});

describe("small things", () => {
  it("reads the application keys a build wrote", () => {
    expect(parseAppKeys(JSON.stringify({ apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef" }))).toEqual({ apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef" });
    expect(parseAppKeys(JSON.stringify({ apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" }))?.apiId).toBe(12345);
    for (const bad of ["", "{}", "nope", JSON.stringify({ apiId: 0, apiHash: "0123456789abcdef0123456789abcdef" }), JSON.stringify({ apiId: 5, apiHash: "short" })]) expect(parseAppKeys(bad)).toBeUndefined();
  });

  it("draws the sign-in link as a QR code and messages as lines", () => {
    expect(qrSvg("tg://login?token=abc")).toMatch(/^<svg[\s\S]*<\/svg>$/);
    expect(chatLine(FAMILY)).toBe("-1001 · group · Family · 2 unread · last 2026-11-15 09:30 UTC");
    expect(messageLine({ id: 11, chatId: "1", date: "2026-11-15T09:10:00.000Z", out: true, text: "Yes", replyTo: 10 })).toBe("#11 2026-11-15 09:10 me (reply to #10): Yes");
    expect(messageLine({ id: 12, chatId: "1", date: "2026-11-15T09:30:00.000Z", out: false, sender: "Dad", text: "", media: { kind: "document", fileName: "recipe.pdf", size: 2048 } })).toBe("#12 2026-11-15 09:30 Dad: [document: recipe.pdf, 2 KB]");
  });
});

describe("connecting the account", () => {
  let r: Run;
  beforeAll(async () => {
    r = await run({ fixture: fixture({ password: "correct horse" }) });
  });
  afterAll(async () => {
    await r?.h.stop();
  });

  it("starts signed out, read only, with nothing open and no way to send", async () => {
    const s = await r.until("signed-out");
    expect(s).toMatchObject({ mode: "read", access: emptyAccess() });
    expect([...r.h.tools.keys()].sort()).toEqual(["chats", "download", "read", "request_access", "search", "setup", "status"]);
    expect(r.h.catalog).toEqual([{ id: "telegram-account", status: "needs-setup", connect: "setup" }]);
    expect(await r.h.invokeText("status")).toContain("No Telegram account is connected");
    const chats = await r.h.invoke("chats");
    expect(chats.isError).toBe(true);
    expect(chats.content.map((c: any) => c.text).join("")).toContain("telegram_account_setup");
  });

  it("shows the card when an agent is asked to connect", async () => {
    const res = await r.h.invoke("setup", {}, { callId: "c-setup" });
    expect(res._meta!.widgets).toEqual([{ kind: "account", data: {} }]);
  });

  it("refuses requests that are not the person's own app", async () => {
    expect((await r.h.http({ path: "/status", public: true })).status).toBe(404);
    expect((await r.h.http({ method: "POST", path: "/mode", body: { mode: "write" }, public: true })).status).toBe(404);
    expect((await r.status()).mode).toBe("read");
  });

  it("signs in by QR code, asks for the two-step password, and keeps the session's key in the vault only", async () => {
    const shown = (await r.post("/signin")).body as AccountStatus;
    expect(shown.state).toBe("qr");
    expect(shown.qr!.svg).toContain("<svg");
    expect(Date.parse(shown.qr!.expiresAt)).toBeGreaterThan(Date.now());
    // No password is expected before the scan.
    expect((await r.post("/password", { password: "x" })).status).toBe(409);

    await r.control("/scan");
    await r.until("password");
    expect(((await r.post("/password", { password: "wrong" })).body as AccountStatus)).toMatchObject({ state: "password", passwordWrong: true });
    expect(((await r.post("/password", { password: "correct horse" })).body as AccountStatus).state).toBe("connected");

    const s = await r.status();
    expect(s.account).toEqual({ name: "Lena", username: "lena" });
    expect(s.qr).toBeUndefined();
    expect(r.h.vault["telegram_account_session"]).toEqual({ value: "session-1" });
    // Neither the key nor the password is in the plugin's storage, or in anything it told the hub.
    const kept = JSON.stringify([...r.h.storage.entries()]) + JSON.stringify(r.h.coreCalls);
    expect(kept).not.toContain("session-1");
    expect(kept).not.toContain("correct horse");
    expect(r.h.catalog).toEqual([{ id: "telegram-account", status: "connected", connect: "setup", account: "@lena" }]);
    expect(r.h.coreCalls.some((c) => c.method === "ui.emit" && c.params.channel === "status" && c.params.payload.state === "connected")).toBe(true);
  });

  it("still shows agents nothing: no chat is open yet", async () => {
    expect(await r.h.invokeText("chats")).toContain("No chats are open to agents yet");
    for (const chat of ["Family", FAMILY.id, "@anna", SERVICE.id]) {
      const res = await r.h.invoke("read", { chat });
      expect(res.isError).toBe(true);
      expect(res.content.map((c: any) => c.text).join("")).toContain("No such chat among the chats open to you");
    }
    expect(await r.h.invokeText("search", { query: "dinner" })).toBe("Nothing found in the open chats.");
    expect(await r.h.invokeText("status")).toContain("Kinds of chats open to agents: none.");
  });
});

describe("what agents can do with a connected account", () => {
  let r: Run;
  const delivered: Array<{ name: string; data: string }> = [];
  beforeAll(async () => {
    r = await run({ delivered });
    await signIn(r);
  });
  afterAll(async () => {
    await r?.h.stop();
  });

  it("lists only the open chats: by kind, with the person's exceptions", async () => {
    await r.post("/kinds", { kind: "group", open: true });
    let list = await r.h.invokeText("chats");
    expect(list).toContain("Family");
    expect(list).toContain("Work secrets");
    expect(list).not.toContain("Anna");
    expect(list).not.toContain("City news");

    expect((await r.post("/exception", { chatId: WORK.id, to: "closed" })).status).toBe(200);
    expect((await r.post("/exception", { chatId: ANNA.id, to: "open" })).status).toBe(200);
    list = await r.h.invokeText("chats");
    expect(list).toContain("Family");
    expect(list).toContain("Anna Petrova (@anna)");
    expect(list).not.toContain("Work secrets");
    expect((await r.status()).access).toMatchObject({ open: { [ANNA.id]: { title: "Anna Petrova", kind: "private" } }, closed: { [WORK.id]: { title: "Work secrets", kind: "group" } } });
  });

  it("keeps Telegram's service chat and Saved Messages closed even with every kind open", async () => {
    await r.post("/kinds", { kind: "private", open: true });
    const list = await r.h.invokeText("chats");
    expect(list).not.toContain("Telegram");
    expect(list).not.toContain("Saved Messages");
    expect((await r.h.invoke("read", { chat: SERVICE.id })).isError).toBe(true);
    expect((await r.h.invoke("read", { chat: SAVED.id })).isError).toBe(true);
    // The person cannot open the service chat either.
    expect((await r.post("/exception", { chatId: SERVICE.id, to: "open" })).status).toBe(500);
    expect((await r.h.invoke("read", { chat: SERVICE.id })).isError).toBe(true);
    await r.post("/kinds", { kind: "private", open: false });
  });

  it("shows the person every chat with how it stands", async () => {
    const rows = ((await r.h.http({ path: "/chats", query: { q: "" } })).body as { chats: ChatRow[] }).chats;
    const of = (id: string) => rows.find((c) => c.id === id)!;
    expect(of(FAMILY.id)).toMatchObject({ state: "open", reason: "kind", canOpen: true });
    expect(of(WORK.id)).toMatchObject({ state: "closed", reason: "exception" });
    expect(of(ANNA.id)).toMatchObject({ state: "open", reason: "exception" });
    expect(of(SERVICE.id)).toMatchObject({ state: "closed", reason: "service", canOpen: false });
    expect(of(SAVED.id)).toMatchObject({ state: "closed", reason: "saved", canOpen: true });
    expect(((await r.h.http({ path: "/chats", query: { q: "work" } })).body as { chats: ChatRow[] }).chats.map((c) => c.title)).toEqual(["Work secrets"]);
  });

  it("reads an open chat by id, name or title, newest first, and pages back", async () => {
    const all = await r.h.invokeText("read", { chat: "Family" });
    expect(all.split("\n")).toEqual([
      "Family (group, id -1001), newest first, times in UTC:",
      "#12 2026-11-15 09:30 Dad: [document: recipe.pdf, 1 KB] The recipe",
      "#11 2026-11-15 09:10 me (reply to #10): Yes",
      "#10 2026-11-15 09:00 Mom: Dinner at seven?",
    ]);
    expect(await r.h.invokeText("read", { chat: FAMILY.id, before: 11 })).toContain("#10");
    expect(await r.h.invokeText("read", { chat: FAMILY.id, before: 11 })).not.toContain("#11");
    expect(await r.h.invokeText("read", { chat: "@anna", limit: 1 })).toContain("See you at dinner");
    expect((await r.h.invoke("read", { chat: "Work secrets" })).isError).toBe(true);
    expect((await r.h.invoke("read", { chat: WORK.id })).isError).toBe(true);
  });

  it("searches the open chats only", async () => {
    const found = await r.h.invokeText("search", { query: "dinner" });
    expect(found).toContain("Family (id -1001) #10");
    expect(found).toContain("Anna Petrova (id 501) #30");
    expect(found).not.toContain("secret");
    expect(found).not.toContain("Login code");
    expect(found).not.toContain("hunter2");
    expect(found.startsWith("2 found in the open chats")).toBe(true);
    expect((await r.h.invoke("search", { query: "budget", chat: WORK.id })).isError).toBe(true);
    expect(await r.h.invokeText("search", { query: "recipe", chat: "Family" })).toContain("#12");
  });

  it("brings an attachment into the agent's folder", async () => {
    const res = await r.h.invoke("download", { chat: FAMILY.id, message: 12 }, { sessionId: "s1" });
    expect(res.isError).toBeFalsy();
    expect(res._meta!.artifacts).toEqual(["downloads/recipe.pdf"]);
    expect(delivered).toEqual([{ name: "recipe.pdf", data: Buffer.from("%PDF-").toString("base64") }]);
    expect((await r.h.invoke("download", { chat: FAMILY.id, message: 10 })).isError).toBe(true);
    expect((await r.h.invoke("download", { chat: WORK.id, message: 20 })).isError).toBe(true);
  });

  it("cannot send while the account is read only", async () => {
    expect(r.h.tools.has("send")).toBe(false);
    expect(await r.h.invokeText("status")).toContain("Mode: read only");
  });

  it("sends in the write mode, only to the open chat the approval card named", async () => {
    expect(((await r.post("/mode", { mode: "write" })).body as AccountStatus).mode).toBe("write");
    await until(() => r.h.tools.has("send"), "the send tool");
    const tool = r.h.tools.get("send")!;
    expect(tool.effect).toBe("external");
    // The card's line names the recipient and the text (the hub fills it from the call's input, in the person's language).
    expect(tool.approvalSummary).toBe("%approval.send%");
    expect(JSON.parse(readFileSync(join(dir, ".piomio-plugin", "locales", "en.json"), "utf8"))["approval.send"]).toBe("Send a Telegram message to {title}: {text}");

    // A title that is not the chat's: the person would have approved another recipient.
    const lied = await r.h.invoke("send", { chat: ANNA.id, title: "Family", text: "hi" });
    expect(lied.isError).toBe(true);
    expect(lied.content.map((c: any) => c.text).join("")).toContain("Nothing was sent");
    // A closed chat, by its id.
    expect((await r.h.invoke("send", { chat: WORK.id, title: "Work secrets", text: "hi" })).isError).toBe(true);
    expect((await r.h.invoke("send", { chat: SERVICE.id, title: "Telegram", text: "hi" })).isError).toBe(true);
    expect((await r.h.invoke("send", { chat: "Family", title: "Family", text: "hi" })).isError).toBe(true);
    expect((await r.h.invoke("send", { chat: FAMILY.id, title: "Family" })).isError).toBe(true);
    expect((await r.h.invoke("send", { chat: FAMILY.id, title: "Family", text: "x".repeat(4097) })).isError).toBe(true);
    expect((await r.control("/state")).sent).toEqual([]);

    expect(await r.h.invokeText("send", { chat: FAMILY.id, title: "family", text: "On my way", reply_to: 10 })).toMatch(/^Sent to Family as message #\d+\.$/);
    expect(await r.h.invokeText("send", { chat: ANNA.id, title: "Anna Petrova", text: "The photos", files: ["a.jpg", "b.jpg"] }, { sessionId: "s1" })).toContain("Sent 2 files to Anna Petrova");
    expect((await r.control("/state")).sent).toEqual([
      { chatId: FAMILY.id, text: "On my way", replyTo: 10 },
      { chatId: ANNA.id, file: "a.jpg", caption: "The photos" },
      { chatId: ANNA.id, file: "b.jpg" },
    ]);

    await r.post("/mode", { mode: "read" });
    await until(() => !r.h.tools.has("send"), "the send tool to go away");
  });

  it("asks the person for a closed chat without telling the agent anything about it", async () => {
    const res = await r.h.invoke("request_access", { chat: "work", reason: "You asked about the budget." }, { callId: "c-req", conversationId: "conv1", agentId: "anna" });
    const said = res.content.map((c: any) => c.text).join("");
    expect(said).not.toMatch(/secret|-1002/i);
    const id = (res._meta!.widgets![0] as any).data.id as string;
    expect(res._meta!.widgets).toEqual([{ kind: "request", data: { id } }]);

    const view = (await r.h.http({ path: `/requests/${id}` })).body as RequestView;
    expect(view).toMatchObject({ query: "work", sending: false, status: "pending", reason: "You asked about the budget.", offline: false });
    expect(view.candidates).toEqual([{ id: WORK.id, title: "Work secrets", kind: "group", state: "closed" }]);

    // A chat the name does not fit cannot be slipped in.
    expect((await r.post(`/requests/${id}`, { allow: true, chatId: SAVED.id })).status).toBe(409);
    const done = (await r.post(`/requests/${id}`, { allow: true, chatId: WORK.id })).body as RequestView;
    expect(done).toMatchObject({ status: "allowed", chat: { id: WORK.id, title: "Work secrets", kind: "group" } });
    expect(await r.h.invokeText("read", { chat: WORK.id })).toContain("The dinner budget is secret");
    const told = r.h.coreCalls.filter((c) => c.method === "conversations.tell").at(-1)!.params;
    expect(told).toMatchObject({ conversationId: "conv1", agentId: "anna" });
    expect(told.text).toContain('the Telegram chat "Work secrets" (id -1002, group) is now open to agents');
    // Answered once.
    expect((await r.post(`/requests/${id}`, { allow: false })).status).toBe(409);
    expect((await r.h.http({ path: "/requests/nope" })).status).toBe(404);
  });

  it("asks the person before turning sending on, and takes no for an answer", async () => {
    const no = await r.h.invoke("request_access", { sending: true }, { conversationId: "conv1", agentId: "anna" });
    const noId = (no._meta!.widgets![0] as any).data.id as string;
    expect(((await r.post(`/requests/${noId}`, { allow: false })).body as RequestView).status).toBe("denied");
    expect((await r.status()).mode).toBe("read");
    expect(r.h.coreCalls.filter((c) => c.method === "conversations.tell").at(-1)!.params.text).toContain("declined");

    const yes = await r.h.invoke("request_access", { sending: true }, { conversationId: "conv1", agentId: "anna" });
    const yesId = (yes._meta!.widgets![0] as any).data.id as string;
    expect(((await r.post(`/requests/${yesId}`, { allow: true })).body as RequestView).status).toBe("allowed");
    expect((await r.status()).mode).toBe("write");
    await until(() => r.h.tools.has("send"), "the send tool");
    expect(await r.h.invokeText("request_access", { sending: true })).toContain("already on");
    expect((await r.h.invoke("request_access", {})).isError).toBe(true);
  });

  it("signals a new incoming message in an open chat, never in a closed one", async () => {
    await r.post("/exception", { chatId: WORK.id, to: "closed" });
    const sub = await r.h.subscribeSignal("message", {});
    await r.control("/incoming", { chatId: WORK.id, message: { text: "closed chat", sender: "Boss" } });
    await r.control("/incoming", { chatId: SERVICE.id, message: { text: "Login code 99999" } });
    await r.control("/incoming", { chatId: FAMILY.id, message: { text: "mine", out: true } });
    const { id } = await r.control("/incoming", { chatId: FAMILY.id, message: { text: "Who is home?", sender: "Mom" } });
    await until(() => r.h.signals.length > 0, "the signal");
    await new Promise((res) => setTimeout(res, 100));
    expect(r.h.signals).toEqual([
      {
        type: "message",
        subscription: sub,
        key: `${FAMILY.id}:${id}`,
        subject: "Family: Who is home?",
        data: { chat: { id: FAMILY.id, title: "Family", kind: "group" }, message: { id, date: expect.any(String), sender: "Mom", text: "Who is home?" } },
      },
    ]);

    // One chat only; and a chat the person closes stops at once.
    await r.h.stopSignal(sub);
    const only = await r.h.subscribeSignal("message", { chat: ANNA.id });
    await r.control("/incoming", { chatId: FAMILY.id, message: { text: "not this chat" } });
    await r.control("/incoming", { chatId: ANNA.id, message: { text: "Hello", sender: "Anna Petrova" } });
    await until(() => r.h.signals.length === 2, "the second signal");
    expect(r.h.signals[1]).toMatchObject({ subscription: only, subject: "Anna Petrova: Hello" });
    await r.post("/exception", { chatId: ANNA.id, to: "closed" });
    await r.control("/incoming", { chatId: ANNA.id, message: { text: "After closing" } });
    await new Promise((res) => setTimeout(res, 150));
    expect(r.h.signals).toHaveLength(2);
    await expect(r.h.subscribeSignal("message", { chat: "Family" })).rejects.toThrow();
    await r.h.stopSignal(only);
  });
});

describe("the session over time", () => {
  it("opens the saved session again after a restart, with the person's choices", async () => {
    const storage = new Map<string, unknown>();
    const first = await run({ storage });
    await signIn(first);
    await first.post("/kinds", { kind: "channel", open: true });
    await first.post("/mode", { mode: "write" });
    const vault = { telegram_account_session: { ...first.h.vault["telegram_account_session"]! } };
    await first.h.stop();

    const again = await run({ storage, vault, fixture: fixture({ sessions: ["session-1"] }) });
    const s = await again.until("connected");
    expect(s).toMatchObject({ mode: "write", account: { name: "Lena", username: "lena" }, access: { kinds: { channel: true, group: false } } });
    await until(() => again.h.tools.has("send"), "the send tool");
    expect(await again.h.invokeText("chats")).toContain("City news");
    await again.h.stop();
  });

  it("notices a session ended from Telegram: the key goes, the choices stay, sending is gone", async () => {
    const r = await run();
    await signIn(r);
    await r.post("/kinds", { kind: "group", open: true });
    await r.post("/mode", { mode: "write" });
    await until(() => r.h.tools.has("send"), "the send tool");

    await r.control("/revoke");
    const s = await r.until("revoked");
    expect(s.access.kinds.group).toBe(true);
    expect(r.h.vault["telegram_account_session"]).toBeUndefined();
    expect(r.h.catalog).toEqual([{ id: "telegram-account", status: "broken", connect: "setup", detail: "%catalog.revoked%" }]);
    await until(() => !r.h.tools.has("send"), "the send tool to go away");
    const res = await r.h.invoke("chats");
    expect(res.isError).toBe(true);
    expect(res.content.map((c: any) => c.text).join("")).toContain("ended from Telegram");
    expect((await r.control("/state")).open).toBe(0);

    // A saved key Telegram no longer knows is the same thing at start.
    const stale = await run({ vault: { telegram_account_session: { value: "session-old" } } });
    await stale.until("revoked");
    expect(stale.h.vault["telegram_account_session"]).toBeUndefined();
    await stale.h.stop();
    await r.h.stop();
  });

  it("disconnects: the session ends in Telegram, the key leaves the vault, the mode goes back to read only", async () => {
    const r = await run();
    await signIn(r);
    await r.post("/mode", { mode: "write" });
    expect(((await r.post("/disconnect")).body as AccountStatus)).toMatchObject({ state: "signed-out", mode: "read" });
    expect((await r.status()).account).toBeUndefined();
    expect(r.h.vault["telegram_account_session"]).toBeUndefined();
    expect(await r.control("/state")).toMatchObject({ loggedOut: 1, sessions: [], open: 0 });
    expect(r.h.tools.has("send")).toBe(false);
    expect(r.h.storage.get("account")).toBeUndefined();
    await r.h.stop();
  });

  it("can cancel a sign-in, and leaves nothing behind", async () => {
    const r = await run();
    expect(((await r.post("/signin")).body as AccountStatus).state).toBe("qr");
    expect(((await r.post("/signin/cancel")).body as AccountStatus).state).toMatch(/signed-out|qr/);
    await r.until("signed-out");
    expect(r.h.vault["telegram_account_session"]).toBeUndefined();
    expect((await r.control("/state")).open).toBe(0);
    await r.h.stop();
  });

  it("waits for the vault before anything signs in: created or unlocked first, then it goes on by itself", async () => {
    const vaultState = { state: "uninitialized" };
    const r = await run({ vaultState });
    expect(await r.until("locked")).toMatchObject({ state: "locked", vault: "uninitialized" });
    // No sign-in while the key could not be kept.
    expect((await r.post("/signin")).status).toBe(409);
    expect((await r.control("/state")).open).toBe(0);
    expect(r.h.catalog).toEqual([{ id: "telegram-account", status: "needs-setup", connect: "setup" }]);
    expect((await r.h.invoke("chats")).content.map((c: any) => c.text).join("")).toContain("vault is locked");

    vaultState.state = "sealed";
    r.h.emit("vault.state", { state: "sealed" });
    await until(async () => (await r.status()).vault === "sealed", "the locked vault");

    vaultState.state = "unlocked";
    r.h.emit("vault.state", { state: "unlocked" });
    await r.until("signed-out");
    expect((await r.status()).vault).toBeUndefined();
    await signIn(r);
    await r.h.stop();
  });

  it("says so when the build has no application keys", async () => {
    const r = await run({ env: { TELEGRAM_ACCOUNT_TEST_NO_KEYS: "1" } });
    expect((await r.status()).state).toBe("no-app");
    expect((await r.post("/signin")).status).toBe(409);
    expect(r.h.catalog).toEqual([{ id: "telegram-account", status: "broken", connect: "setup", detail: "%catalog.noApp%" }]);
    expect(await r.h.invokeText("status")).toContain("no Telegram application keys");
    await r.h.stop();
  });
});
