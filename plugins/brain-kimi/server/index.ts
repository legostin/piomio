// Registers the "kimi" brain (the Kimi Code CLI on the user's Kimi membership, signed in with its own device code).

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import { createKimiProvider } from "@piomio/brains-cli";

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings = ctx.settings;
    ctx.onSettingsChange((s) => (settings = s));
    ctx.brains.register(
      createKimiProvider({
        command: () => String(settings.command || "kimi"),
        stateDir: ctx.dataDir,
        log: (m) => ctx.log.info(m),
        locale: () => ctx.i18n.locale(),
      }),
    );
  },
};

export default plugin;
