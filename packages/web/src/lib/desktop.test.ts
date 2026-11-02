import { describe, expect, it } from "vitest";
import { desktopApp, desktopInvoke, desktopTicketFrom, dragRegion, onAnotherComputer, pairLink } from "./desktop";

describe("desktop app links", () => {
  it("reads a sign-in ticket from the address fragment", () => {
    const t = "A1_-".repeat(11);
    expect(desktopTicketFrom(`#desktop=${t}`)).toBe(t);
    expect(desktopTicketFrom("#desktop=short")).toBeUndefined();
    expect(desktopTicketFrom("#setup=abcdefgh")).toBeUndefined();
    expect(desktopTicketFrom("")).toBeUndefined();
  });

  it("builds the pairing link the app opens", () => {
    expect(pairLink("https://bot.example.com", "AB12CD34")).toBe("piomio://pair?hub=https%3A%2F%2Fbot.example.com&code=AB12CD34");
    expect(pairLink("http://localhost:41790", "x", "piomio-test")).toBe("piomio-test://pair?hub=http%3A%2F%2Flocalhost%3A41790&code=x");
  });

  it("knows the app window it runs in", () => {
    expect(desktopApp({})).toBeUndefined();
    expect(desktopApp({ piomioDesktop: { scheme: "piomio", test: false } })).toEqual({ scheme: "piomio", test: false, overlayTitleBar: false, pio: false });
    expect(desktopApp({ piomioDesktop: { scheme: "piomio-test", test: true } })).toEqual({ scheme: "piomio-test", test: true, overlayTitleBar: false, pio: false });
    expect(desktopApp({ piomioDesktop: { scheme: "piomio", pio: true } })?.pio).toBe(true);
    expect(desktopApp({ piomioDesktop: { scheme: "piomio", overlayTitleBar: true } })?.overlayTitleBar).toBe(true);
    expect(desktopApp({ piomioDesktop: { scheme: "javascript" } })).toBeUndefined();
  });

  it("marks where a window without a title bar is dragged from", () => {
    const mac = { scheme: "piomio", test: false, overlayTitleBar: true, pio: false };
    expect(dragRegion(false, mac)).toEqual({ "data-tauri-drag-region": "" });
    expect(dragRegion(true, mac)).toEqual({ "data-tauri-drag-region": "deep" });
    expect(dragRegion(true, { ...mac, overlayTitleBar: false })).toEqual({});
    expect(dragRegion(true, undefined)).toEqual({});
  });

  it("offers to connect the computer the web UI is open on, unless it is the hub's own or a phone", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15";
    expect(onAnotherComputer("piomio.tail1234.ts.net", mac, {})).toBe(true);
    expect(onAnotherComputer("192.168.1.2", mac, {})).toBe(true);
    expect(onAnotherComputer("localhost", mac, {})).toBe(false);
    expect(onAnotherComputer("127.0.0.1", mac, {})).toBe(false);
    expect(onAnotherComputer("piomio.tail1234.ts.net", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", {})).toBe(false);
    expect(onAnotherComputer("piomio.tail1234.ts.net", mac, { piomioDesktop: { scheme: "piomio" } })).toBe(false);
  });
});

describe("the Pio window's commands", () => {
  it("go to the app's IPC, and fail outside its window", async () => {
    const calls: unknown[] = [];
    const w = { __TAURI_INTERNALS__: { invoke: async (cmd: string, args?: unknown) => (calls.push([cmd, args]), { ok: true }) } };
    await expect(desktopInvoke("pio_frontmost", undefined, w)).resolves.toEqual({ ok: true });
    await desktopInvoke("pio_frame", { expanded: true }, w);
    expect(calls).toEqual([["pio_frontmost", undefined], ["pio_frame", { expanded: true }]]);
    await expect(desktopInvoke("pio_frontmost", undefined, {})).rejects.toThrow(/Pio window/);
  });
});
