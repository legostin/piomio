// How the page starts: the desktop UI asks /api/auth/state first; the iOS app's chat page (/m/*) goes straight to
// /api/bootstrap and, on a 401, asks the app to sign it in again instead of showing the sign-in screen.

import { afterEach, describe, expect, it, vi } from "vitest";

type Reply = { status: number; body?: unknown; hang?: boolean };

const BOOTSTRAP = { csrf: "csrf-1", version: "1", language: "en", locales: ["en"], uiPlugins: [], channels: [], mainConversationId: "c1", defaultAgent: "owl" };

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: () => void;
  close() {}
  send() {}
}

/** A fresh state/app.ts on `pathname`, with the hub answering `routes` (path → reply) and the app's bridge if `app`. */
async function start(pathname: string, routes: Record<string, Reply>, app: boolean) {
  vi.resetModules();
  const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
  const postMessage = vi.fn(async () => ({ ok: true }));
  const location = { pathname, hash: "", search: "", href: `https://hub.local:8082${pathname}`, protocol: "https:", host: "hub.local:8082" };
  vi.stubGlobal("window", { ...listeners, location, ...(app ? { webkit: { messageHandlers: { piomio: { postMessage } } } } : {}) });
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", { ...listeners, visibilityState: "visible", cookie: "", documentElement: { lang: "" } });
  vi.stubGlobal("history", { replaceState: () => {} });
  vi.stubGlobal("WebSocket", FakeSocket);
  const fetch = vi.fn(async (url: string) => {
    const path = url.split("?")[0];
    const r = routes[path] ?? { status: 200, body: [] };
    if (r.hang) await new Promise(() => {});
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal("fetch", fetch);
  const state = await import("./app");
  const { api } = await import("../lib/api");
  const paths = () => fetch.mock.calls.map((c) => String(c[0]).split("?")[0]);
  return { state, api, fetch, paths, postMessage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../lib/cache");
});

/** This device kept a copy of the hub: the keys and values lib/cache.ts would find. */
function deviceCopy(kept: Record<string, unknown>) {
  vi.doMock("../lib/cache", async (original) => ({ ...(await original<typeof import("../lib/cache")>()), cacheGet: async (key: string) => kept[key] }));
}

const settled = () => new Promise((r) => setTimeout(r, 5));

describe("a page this device has a copy of", () => {
  const kept = { bootstrap: { ...BOOTSTRAP, csrf: "" }, team: [{ agentId: "owl", conversationId: "c1" }] };

  it("shows it without waiting for the hub", async () => {
    deviceCopy(kept);
    const { state, paths } = await start("/", { "/api/auth/state": { status: 200, hang: true }, "/api/bootstrap": { status: 200, hang: true } }, false);
    await state.init();
    expect(state.phase.get().kind).toBe("ready");
    expect(state.team.get()).toEqual(kept.team);
    expect(paths()).not.toContain("/api/auth/state");
  });

  it("then takes the hub's session, with its CSRF token", async () => {
    deviceCopy(kept);
    const { state } = await start("/", { "/api/bootstrap": { status: 200, body: { ...BOOTSTRAP, version: "2" } } }, false);
    await state.init();
    await settled();
    expect(state.session.get()).toMatchObject({ csrf: "csrf-1", version: "2" });
  });

  it("goes to the sign-in screen when the hub says the session is over", async () => {
    deviceCopy(kept);
    const { state } = await start(
      "/",
      { "/api/bootstrap": { status: 401, body: { error: "auth.required" } }, "/api/auth/state": { status: 200, body: { hasPassword: true, authenticated: false, passkeys: 0, version: "1" } } },
      false,
    );
    await state.init();
    await settled();
    expect(state.phase.get().kind).toBe("login");
    expect(state.session.get()).toBeNull();
  });

  it("without a copy, nothing shows before the hub answers", async () => {
    deviceCopy({});
    const { state, paths } = await start("/", { "/api/auth/state": { status: 200, body: { hasPassword: true, authenticated: false, passkeys: 0, version: "1" } } }, false);
    await state.init();
    expect(paths()[0]).toBe("/api/auth/state");
    expect(state.phase.get().kind).toBe("login");
  });
});

describe("after a reconnect", () => {
  it("asks the hub again only for the dialogs on screen; the others when they open", async () => {
    const message = (id: string) => [{ id, conversationId: "x", role: "user", parts: [], status: "complete", createdAt: "2026-01-01T00:00:00.000Z" }];
    const { state, fetch } = await start(
      "/m/chat/a",
      { "/api/bootstrap": { status: 200, body: BOOTSTRAP }, "/api/conversations/a/messages": { status: 200, body: message("ma") }, "/api/conversations/b/messages": { status: 200, body: message("mb") } },
      true,
    );
    await state.init();
    await state.loadMessages("a");
    await state.loadMessages("b");
    const leave = state.showingDialog("a");
    const asked = (id: string) => fetch.mock.calls.filter((c) => String(c[0]).startsWith(`/api/conversations/${id}/messages`)).length;
    expect([asked("a"), asked("b")]).toEqual([1, 1]);

    state.refreshDialogs();
    await settled();
    expect([asked("a"), asked("b")]).toEqual([2, 1]);
    // What it already had stays on the page until then.
    expect(state.messages.get().b.messages.map((m) => m.id)).toEqual(["mb"]);

    await state.loadMessages("b");
    expect(asked("b")).toBe(2);
    await state.loadMessages("b");
    expect(asked("b")).toBe(2);

    leave();
    state.refreshDialogs();
    await settled();
    expect(asked("a")).toBe(2);
  });

  it("a dialog shown in two places stays on screen until both leave", async () => {
    const { state, fetch } = await start("/m/chat/a", { "/api/bootstrap": { status: 200, body: BOOTSTRAP } }, true);
    await state.init();
    await state.loadMessages("a");
    const one = state.showingDialog("a");
    const two = state.showingDialog("a");
    one();
    state.refreshDialogs();
    await settled();
    two();
    state.refreshDialogs();
    await settled();
    expect(fetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/conversations/a/messages")).length).toBe(2);
  });
});

describe("init", () => {
  it("desktop: starts at /api/auth/state", async () => {
    const { state, paths } = await start("/", { "/api/auth/state": { status: 200, body: { hasPassword: true, authenticated: false, passkeys: 0, version: "1" } } }, false);
    await state.init();
    expect(paths()[0]).toBe("/api/auth/state");
    expect(state.phase.get().kind).toBe("login");
  });

  it("phone page: skips /api/auth/state, signs in with the bootstrap's CSRF token", async () => {
    const { state, api, fetch, paths } = await start("/m/chat/c1", { "/api/bootstrap": { status: 200, body: BOOTSTRAP } }, true);
    await state.init();
    expect(paths()[0]).toBe("/api/bootstrap");
    expect(paths()).not.toContain("/api/auth/state");
    expect(state.phase.get().kind).toBe("ready");
    await api.post("/api/conversations/c1/read", { at: "now" });
    const post = fetch.mock.calls.find((c) => String(c[0]).endsWith("/read")) as unknown as [string, RequestInit];
    expect((post[1].headers as Record<string, string>)["x-csrf"]).toBe("csrf-1");
  });

  it("phone page: a 401 at start asks the app to sign in again", async () => {
    const { state, paths, postMessage } = await start("/m/chat/c1", { "/api/bootstrap": { status: 401, body: { error: "auth.required" } } }, true);
    await state.init();
    expect(state.phase.get().kind).toBe("reauth");
    expect(postMessage).toHaveBeenCalledWith({ type: "reauth" });
    expect(paths()).not.toContain("/api/auth/state");
  });

  it("phone page: a 401 later asks the app once", async () => {
    const { state, api, postMessage } = await start("/m/chat/c1", { "/api/bootstrap": { status: 200, body: BOOTSTRAP }, "/api/tasks": { status: 401 } }, true);
    await state.init();
    await expect(api.get("/api/tasks")).rejects.toMatchObject({ status: 401 });
    await expect(api.get("/api/tasks")).rejects.toMatchObject({ status: 401 });
    expect(state.phase.get().kind).toBe("reauth");
    expect(state.session.get()).toBeNull();
    expect(postMessage.mock.calls.filter((c) => (c as unknown[])[0] && ((c as unknown[])[0] as { type: string }).type === "reauth")).toHaveLength(1);
  });

  it("phone page in a plain browser: a 401 falls back to the sign-in screen", async () => {
    const { state, paths } = await start(
      "/m/chat/c1",
      { "/api/bootstrap": { status: 401 }, "/api/auth/state": { status: 200, body: { hasPassword: true, authenticated: false, passkeys: 0, version: "1" } } },
      false,
    );
    await state.init();
    expect(paths()).toEqual(["/api/bootstrap", "/api/auth/state"]);
    expect(state.phase.get().kind).toBe("login");
  });
});
