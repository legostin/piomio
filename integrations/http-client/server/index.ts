// HTTP client: requests sent by hand on its page and by agents with its tools, saved requests, environments with
// variables, and one searchable history of them all.
// docs/superpowers/specs/2026-11-18-http-client-design.md

import { join } from "node:path";
import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import { Client } from "./client.ts";
import { History } from "./history.ts";
import { handleHttp } from "./http.ts";
import { behindHub } from "./net.ts";
import { Saved } from "./saved.ts";
import { registerTools } from "./tools.ts";

let history: History | undefined;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    const h = new History(join(ctx.dataDir, "history.db"));
    history = h;
    const saved = new Saved(ctx.storage);
    await saved.load();

    // The open pages hear about changes; several at once are one reload.
    let emit: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      emit ??= setTimeout(() => {
        emit = undefined;
        ctx.ui.emit("changed", {});
      }, 100);
    };
    saved.onChange = changed;

    // A test seam, not a setting: loopback is where the hub's own API lives, and only the environment of this process
    // (which no agent can change) opens it, for the tests' local server.
    const allowLocal = process.env.PIOMIO_HTTP_CLIENT_TEST_LOCAL === "1";
    const client = new Client({ history: h, saved, vault: ctx.vault, guard: () => ({ hubDecides: behindHub(), allowLocal }), changed });
    const kit = { ctx, client, history: h, saved, changed };
    registerTools(kit);
    ctx.http.handle((req) => handleHttp(kit, req));
  },
  deactivate() {
    history?.close();
  },
};

export default plugin;
