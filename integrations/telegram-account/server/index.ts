// Telegram account: the person's own Telegram account, connected by QR code, for their agents to read (and, when the
// person turns it on, to write from, each message approved). Not the Piomio bot (plugins/telegram): that one is a
// channel to the hub; this one is the person's account itself.
//
//   account.ts   the session: sign-in, the key in the vault, sign-out, the mode and the access
//   access.ts    which chats agents may see
//   tools.ts     the agents' tools and the "message" signal
//   requests.ts  an agent's "open this chat?" card
//   mtcute.ts    the Telegram client (client.ts is its shape; tests give a fake)

import { pathToFileURL } from "node:url";
import type { PluginContext, PluginHttpRequest, PluginHttpResponse, PluginModule } from "@piomio/plugin-sdk";
import type { CatalogEntryState, Locale } from "@piomio/shared";
import { CHAT_KINDS } from "./access.ts";
import { Account, NotConnected } from "./account.ts";
import type { AccountStatus } from "./account.ts";
import { readAppKeys } from "./app-keys.ts";
import type { ChatKind, TgClientFactory } from "./client.ts";
import { RequestError, Requests } from "./requests.ts";
import { provideSignal, registerTools } from "./tools.ts";

export type { AccountStatus, ChatRow } from "./account.ts";
export type { RequestView } from "./requests.ts";
export type { Access, ChatReason, ChatState, Mode } from "./access.ts";
export type { ChatKind } from "./client.ts";

/** Tests run the plugin against a fake Telegram: a module whose default export makes the client. */
const TEST_CLIENT_ENV = "TELEGRAM_ACCOUNT_TEST_CLIENT";

let account: Account | undefined;

async function clientFactory(): Promise<TgClientFactory> {
  const fake = process.env[TEST_CLIENT_ENV];
  if (fake) return (await import(pathToFileURL(fake).href)).default as TgClientFactory;
  const { createMtcuteClient } = await import("./mtcute.ts");
  return createMtcuteClient;
}

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    // A test's fake comes with its own keys; a real build reads the ones stamped into it.
    const keys = process.env[TEST_CLIENT_ENV] && !process.env.TELEGRAM_ACCOUNT_TEST_NO_KEYS ? { apiId: 1, apiHash: "0".repeat(32) } : readAppKeys(ctx.pluginDir);
    const acc = new Account(ctx, keys, await clientFactory());
    account = acc;
    const requests = new Requests(ctx, acc);
    const tools = registerTools(ctx, acc, requests);
    provideSignal(ctx, acc);

    const report = () => {
      const s = acc.status();
      const entry: CatalogEntryState =
        s.state === "connected"
          ? { id: ctx.pluginId, status: "connected", connect: "setup", ...(s.account ? { account: s.account.username ? `@${s.account.username}` : s.account.name } : {}) }
          : s.state === "revoked" || s.state === "error" || s.state === "no-app"
            ? { id: ctx.pluginId, status: "broken", connect: "setup", detail: `%catalog.${s.state === "no-app" ? "noApp" : s.state}%` }
            : { id: ctx.pluginId, status: "needs-setup", connect: "setup" };
      ctx.catalog.update([entry]);
      ctx.ui.emit("status", s);
      tools.syncMode();
    };
    acc.onChange(report);
    ctx.events.on("vault.state", () => void acc.resume());
    ctx.events.on("vault.updated", () => void acc.resume());

    const t = (key: string, locale: Locale) => ctx.i18n.t(key, undefined, locale);
    const fail = (status: number, key: string, locale: Locale): PluginHttpResponse => ({ status, body: { error: t(key, locale) } });
    const ok = (body: unknown): PluginHttpResponse => ({ status: 200, body });

    // The card's side: only the person's own app reaches these (never a public request), so what changes here is
    // theirs: the sign-in, the mode, the open chats, the answer to an agent's request.
    ctx.http.handle(async (req: PluginHttpRequest): Promise<PluginHttpResponse> => {
      if (req.public) return { status: 404, body: { error: "not found" } };
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const path = req.path.replace(/\/+$/, "") || "/";
      const route = `${req.method.toUpperCase()} ${path}`;
      const requestId = /^\/requests\/([\w-]{1,40})$/.exec(path)?.[1];
      try {
        if (requestId) {
          if (req.method.toUpperCase() === "GET") return ok(await requests.view(requestId));
          if (req.method.toUpperCase() === "POST") return ok(await requests.answer(requestId, { allow: body.allow === true, ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}) }));
        }
        switch (route) {
          case "GET /status":
            return ok(acc.status());
          case "POST /signin": {
            if (acc.status().state === "no-app") return fail(409, "http.noApp", req.locale);
            await acc.startSignIn();
            if (acc.status().state === "locked") return fail(409, "http.locked", req.locale);
            // The code arrives within a second or two: answer with it rather than with "connecting".
            for (let n = 0; n < 60 && acc.status().state === "connecting"; n++) await new Promise((r) => setTimeout(r, 100));
            return ok(acc.status());
          }
          case "POST /signin/cancel":
            acc.cancelSignIn();
            return ok(acc.status());
          case "POST /password": {
            const password = typeof body.password === "string" ? body.password : "";
            if (!password) return fail(400, "http.password", req.locale);
            if (!acc.submitPassword(password)) return fail(409, "http.noPassword", req.locale);
            for (let n = 0; n < 100 && acc.status().state === "connecting"; n++) await new Promise((r) => setTimeout(r, 100));
            return ok(acc.status());
          }
          case "POST /disconnect":
            await acc.disconnect();
            return ok(acc.status());
          case "POST /mode":
            if (body.mode !== "read" && body.mode !== "write") return fail(400, "http.bad", req.locale);
            await acc.setMode(body.mode);
            return ok(acc.status());
          case "POST /kinds":
            if (!CHAT_KINDS.includes(body.kind as ChatKind) || typeof body.open !== "boolean") return fail(400, "http.bad", req.locale);
            await acc.setKind(body.kind as ChatKind, body.open);
            return ok(acc.status());
          case "POST /exception": {
            const id = String(body.chatId ?? "");
            const to = body.to;
            if (!/^-?\d{1,20}$/.test(id) || (to !== "open" && to !== "closed" && to !== "default")) return fail(400, "http.bad", req.locale);
            // Dropping an exception needs no Telegram: it works while signed out too.
            const kept = acc.access.open[id] ?? acc.access.closed[id];
            const chat = to === "default" && kept ? { id, ...kept } : await acc.client().chat(id);
            if (!chat) return fail(404, "http.noChat", req.locale);
            await acc.setException(chat, to);
            return ok(acc.status());
          }
          case "GET /chats":
            return ok({ chats: await acc.chatRows(String(req.query.q ?? ""), 200) });
          default:
            return { status: 404, body: { error: "not found" } };
        }
      } catch (e: any) {
        if (e instanceof NotConnected) return fail(409, "http.notConnected", req.locale);
        if (e instanceof RequestError) return fail(e.code === "notFound" ? 404 : 409, `http.request.${e.code}`, req.locale);
        ctx.log.warn(`telegram-account: ${route} failed: ${e?.message ?? e}`);
        return { status: 500, body: { error: String(e?.message ?? e).slice(0, 300) } };
      }
    });

    await acc.start();
    report();
  },

  async deactivate() {
    await account?.stop();
  },
};

export default plugin;
