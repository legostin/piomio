// What an agent's Codex may use is the hub's tools (as Claude Code's --strict-mcp-config gives it) and the person's own
// Codex MCP servers they turned on for agents (BrainSessionOptions.connections). The rest of config.toml's servers, its
// plugins and the ChatGPT apps run outside the hub's gateway, with no policy, review or audit of their own.
// `-c mcp_servers={}` does not take away a table config.toml defines, so each of those servers is turned off by its name.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/;
/** A name Codex's `-c` reads as one key. Another (a dotted, quoted one) is left as it is: rare, and never ours. */
const PLAIN = /^[A-Za-z0-9_-]+$/;

/** The person's Codex MCP servers by name, from CODEX_HOME's config.toml (else HOME/.codex). */
export function personalServers(env: Record<string, string | undefined>): string[] {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  const file = join(home, "config.toml");
  if (!existsSync(file)) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = HEADER.exec(line);
    const name = m?.[1] ?? m?.[2] ?? m?.[3];
    if (name && name !== "piomio" && PLAIN.test(name)) names.add(name);
  }
  return [...names];
}

/**
 * `-c` overrides that leave an agent's Codex with the hub's tools and the connections turned on (`on`, by name). Such a
 * server keeps the person's own settings, but what it changes it asks about first: Codex sends that to the hub.
 */
export function isolationConfig(env: Record<string, string | undefined>, on: readonly string[] = []): string[] {
  return [
    "features.plugins=false",
    "features.apps=false",
    ...personalServers(env).map((n) => (on.includes(n) ? `mcp_servers.${n}.default_tools_approval_mode="writes"` : `mcp_servers.${n}.enabled=false`)),
  ];
}
