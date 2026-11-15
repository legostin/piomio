// A plugin that signs in to an account itself, for the tests: it keeps the session's key in the vault (ctx.vault.put)
// and says how its own card stands with a catalog entry under its own id.
import type { PluginContext } from "@piomio/plugin-sdk";

const text = (e: any) => String(e?.message ?? e);

export default {
  async activate(ctx: PluginContext) {
    const tool = (name: string, run: (input: any) => Promise<string>) =>
      ctx.tools.register({
        name,
        description: name,
        effect: "local-write",
        inputSchema: { type: "object", properties: {} },
        handler: async (input) => {
          try {
            return await run(input);
          } catch (e) {
            return { content: [{ type: "text", text: text(e) }], isError: true };
          }
        },
      });
    tool("put", async (i) => {
      await ctx.vault.put(String(i.ref), i.fields, i.name ? { name: String(i.name) } : undefined);
      return "stored";
    });
    tool("get", async (i) => JSON.stringify(await ctx.vault.get(String(i.ref))));
    tool("remove", async (i) => {
      await ctx.vault.remove(String(i.ref));
      return "removed";
    });
    tool("report", async (i) => {
      ctx.catalog.update(i.entries);
      return "reported";
    });
  },
};
