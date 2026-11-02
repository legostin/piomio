// Registers the "claude-code" brain: the official Claude Code CLI, headless, signed in to the user's own Claude plan on
// this computer (from the chat card, or a login it already had). The hub keeps no Claude credentials: Anthropic's
// terms don't let an app collect or store subscription tokens, so there is no token setting.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import { createClaudeCodeProvider, DEFAULT_CLAUDE_TOOLS } from "@piomio/brains-cli";

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings = ctx.settings;
    ctx.onSettingsChange((s) => (settings = s));

    ctx.brains.register(
      createClaudeCodeProvider({
        command: () => String(settings.command || "claude"),
        allowedTools: () => (Array.isArray(settings.allowedTools) && settings.allowedTools.length ? settings.allowedTools : DEFAULT_CLAUDE_TOOLS),
        stateDir: ctx.dataDir,
        log: (m) => ctx.log.info(m),
        locale: () => ctx.i18n.locale(),
      }),
    );
  },
};

export default plugin;
