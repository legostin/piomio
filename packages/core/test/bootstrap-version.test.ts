import Fastify from "fastify";
import { expect, it } from "vitest";
import type { Hub } from "../src/app.ts";
import { registerApi } from "../src/server/api.ts";

it("bootstrap reports the serving hub version and machine name, preserving web and device fields", async () => {
  for (const kind of ["web", "device"] as const) {
    const api = Fastify();
    const hub = {
      config: { version: "0.2.25", publicUrl: "https://hub.example", consoleUrl: "https://console.example" },
      settings: { get: () => ({ defaultAgent: "assistant", timezone: "UTC", language: "en" }) },
      store: { agentConversation: () => ({ id: "chat" }) },
      vault: { state: () => "locked" }, setup: { firstRun: () => false },
      approvals: { pendingCount: () => 0 }, notifier: { unreadCount: () => 0 },
      plugins: { uiPlugins: () => [], waiting: () => [] }, channels: { list: () => [] },
      // The computer serving this UI by the name the person knows it by (pairing.ts localComputerName).
      machines: { localName: () => "vps" },
    } as unknown as Hub;
    try {
      await registerApi(api, hub, { kind, bootstrap: () => kind === "web" ? { csrf: "token" } : { device: { id: "phone" } }, wsAllowed: () => false, authenticate: async () => {} });
      const response = await api.inject({ method: "GET", url: "/api/bootstrap" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ version: "0.2.25", hubName: "vps", ...(kind === "web" ? { csrf: "token" } : { device: { id: "phone" } }) });
    } finally { await api.close(); }
  }
});
