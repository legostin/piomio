import { afterEach, describe, expect, it, vi } from "vitest";
import { createNative, NATIVE_EVENT, nativeErrorText, openOutside, outsideUrl, type NativeHost } from "./native";

/** A window with the app's message handler: postMessage answers with `reply(message)`. */
function appWindow(reply: (message: any) => unknown = () => ({ ok: true })) {
  const target = new EventTarget();
  const postMessage = vi.fn(reply);
  const host = Object.assign(target, { webkit: { messageHandlers: { piomio: { postMessage } } } }) as unknown as NativeHost;
  const dispatch = (detail: unknown) => target.dispatchEvent(new CustomEvent(NATIVE_EVENT, { detail }));
  return { host, postMessage, dispatch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native bridge", () => {
  it("is undefined outside the app", () => {
    expect(createNative(undefined)).toBeUndefined();
    expect(createNative(new EventTarget() as unknown as NativeHost)).toBeUndefined();
    expect(createNative(Object.assign(new EventTarget(), { webkit: { messageHandlers: {} } }) as unknown as NativeHost)).toBeUndefined();
  });

  it("posts { type, ...payload } and resolves with the reply", async () => {
    const { host, postMessage } = appWindow(async () => ({ ok: true }));
    const native = createNative(host)!;
    await expect(native.ready("c1")).resolves.toEqual({ ok: true });
    await native.approve("a1");
    await native.deny("a2");
    await native.openURL("https://example.com/x");
    await native.haptic("success");
    await native.dictation.start();
    await native.call("custom", { a: 1, type: "spoofed" });
    expect(postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: "ready", conversationId: "c1", show: true },
      { type: "approve", approvalId: "a1" },
      { type: "deny", approvalId: "a2" },
      { type: "openURL", url: "https://example.com/x" },
      { type: "haptic", kind: "success" },
      { type: "dictation.start" },
      { a: 1, type: "custom" },
    ]);
  });

  it("passes a cancelled approval through", async () => {
    const { host } = appWindow(async () => ({ ok: false, cancelled: true }));
    await expect(createNative(host)!.approve("a1")).resolves.toEqual({ ok: false, cancelled: true });
  });

  it("rejects with the app's reason as an Error", async () => {
    const reasons: unknown[] = ["Microphone access is off", new Error("Speech recognition is not allowed")];
    for (const reason of reasons) {
      const { host } = appWindow(() => Promise.reject(reason));
      const err = await createNative(host)!.dictation.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(nativeErrorText(err)).toBe(typeof reason === "string" ? reason : (reason as Error).message);
    }
    const { host } = appWindow(() => {
      throw new Error("handler gone");
    });
    await expect(createNative(host)!.haptic("light")).rejects.toThrow("handler gone");
  });

  it("returns the final words of a dictation (empty when the app sends none)", async () => {
    let words: unknown = "turn on the lights";
    const { host } = appWindow(async (m) => (m.type === "dictation.stop" ? { text: words } : { ok: true }));
    const native = createNative(host)!;
    await expect(native.dictation.stop()).resolves.toEqual({ text: "turn on the lights" });
    words = undefined;
    await expect(native.dictation.stop()).resolves.toEqual({ text: "" });
  });

  it("asks for a new session without waiting for a reply", async () => {
    const { host, postMessage } = appWindow(() => Promise.reject(new Error("reloading")));
    expect(createNative(host)!.reauth()).toBeUndefined();
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith({ type: "reauth" });
  });

  it("delivers piomio-native events until unsubscribed", () => {
    const { host, dispatch } = appWindow();
    const native = createNative(host)!;
    const seen: unknown[] = [];
    const off = native.onEvent((e) => seen.push(e));
    dispatch({ type: "dictation", text: "hel" });
    dispatch(null);
    dispatch("not an object");
    dispatch({ type: "dictation", text: "hello" });
    off();
    dispatch({ type: "dictation", text: "ignored" });
    expect(seen).toEqual([
      { type: "dictation", text: "hel" },
      { type: "dictation", text: "hello" },
    ]);
  });
});

describe("links that leave the hub", () => {
  const base = "https://192.168.1.5:8082/m/chat/c1";

  it("are other origins and non-web schemes, as absolute URLs", () => {
    expect(outsideUrl("https://github.com/login/device", base)).toBe("https://github.com/login/device");
    expect(outsideUrl("http://192.168.1.5:8081/#/approvals", base)).toBe("http://192.168.1.5:8081/#/approvals");
    expect(outsideUrl("//example.com/a", base)).toBe("https://example.com/a");
    expect(outsideUrl("mailto:me@example.com", base)).toBe("mailto:me@example.com");
  });

  it("are not the hub's own pages or script URLs", () => {
    expect(outsideUrl("/api/files?path=a.png", base)).toBeUndefined();
    expect(outsideUrl("https://192.168.1.5:8082/m/chat/c2", base)).toBeUndefined();
    expect(outsideUrl("#top", base)).toBeUndefined();
    expect(outsideUrl("javascript:alert(1)", base)).toBeUndefined();
    expect(outsideUrl("data:text/html,hi", base)).toBeUndefined();
    expect(outsideUrl("http://[bad", base)).toBeUndefined();
  });

  it("open in Safari from a click inside the app, and work as usual otherwise", () => {
    vi.stubGlobal("window", { location: { href: base } });
    const { host, postMessage } = appWindow();
    const bridge = createNative(host)!;
    const click = () => ({ preventDefault: vi.fn(), defaultPrevented: false });

    const out = click();
    openOutside(out, "https://example.com/", bridge);
    expect(out.preventDefault).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "openURL", url: "https://example.com/" });

    const own = click();
    openOutside(own, "/api/files?path=x", bridge);
    expect(own.preventDefault).not.toHaveBeenCalled();

    const browser = click();
    openOutside(browser, "https://example.com/", undefined);
    expect(browser.preventDefault).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
