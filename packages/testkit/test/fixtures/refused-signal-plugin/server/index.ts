// A plugin whose signal declaration the hub refuses (its data pattern cannot run in linear time): the harness refuses
// to start it, as the hub would leave the source out.

import type { PluginContext } from "@piomio/plugin-sdk";

export default {
  activate(_ctx: PluginContext) {},
};
