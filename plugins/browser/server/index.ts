// Builtin browser plugin: Google Chrome (or Playwright's Chromium) with a persistent profile, agent tools, live view and user takeover.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import { historyHttp } from "./history.ts";
import { BrowserManager } from "./manager.ts";
import { registerTools, uploadHttp } from "./tools.ts";

let manager: BrowserManager | null = null;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    // The browser itself starts lazily on the first tool call (or when the user opens it in the live view).
    const mgr = new BrowserManager(ctx);
    manager = mgr;
    // Without Google Chrome, Playwright's Chromium may be missing: download it now in the background, so
    // the first browser call does not wait for all of it (calls during the install wait for it).
    mgr.installer.check();
    registerTools(ctx, mgr);
    ctx.ui.onMessage((m) => mgr.onUiMessage(m));
    ctx.http.handle((req) => {
      // The person's speech while showing a task (the live view records it in pieces).
      if (!req.public && req.method === "POST" && req.path === "/teach/speech") return mgr.learning.speech(req);
      // Files the person picked in the live view for the page's file chooser (or none: they cancelled it).
      if (!req.public && req.method === "POST" && (req.path === "/upload/files" || req.path === "/upload/cancel")) return uploadHttp(mgr, req);
      return historyHttp(mgr.history, req);
    });
    ctx.onSettingsChange((s) => mgr.updateSettings(s));
  },
  async deactivate() {
    await manager?.dispose();
    manager = null;
  },
};

export default plugin;
