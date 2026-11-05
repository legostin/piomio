// Registers the "codex" brain (OpenAI Codex CLI on the user's ChatGPT subscription or an API key).

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import { codexChooser, createCodexProvider } from "@piomio/brains-cli";

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings = ctx.settings;
    ctx.onSettingsChange((s) => (settings = s));

    const authEnv = async (): Promise<Record<string, string>> => {
      if (!settings.apiKeyRef) return {};
      try {
        const f = await ctx.vault.get(String(settings.apiKeyRef), { reason: "Codex authentication" });
        const key = f.value ?? Object.values(f)[0];
        return key ? { OPENAI_API_KEY: key.trim() } : {};
      } catch {
        return {};
      }
    };

    // The Codex the settings name, else the newest on this machine (Codex offers newer models only to newer clients).
    const codex = codexChooser();
    ctx.brains.register(
      createCodexProvider({
        command: () => codex(String(settings.command || "")),
        authEnv,
        sandbox: () => settings.sandbox || "danger-full-access",
        stateDir: ctx.dataDir,
        log: (m) => ctx.log.info(m),
        error: (m) => ctx.log.error(m),
        locale: () => ctx.i18n.locale(),
      }),
    );
  },
};

export default plugin;
