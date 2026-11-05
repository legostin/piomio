// What an agent's Codex may use is the hub's tools only (as Claude Code's --strict-mcp-config gives it): the person's
// own Codex MCP servers (config.toml), its plugins and the ChatGPT apps run outside the hub's gateway, with no policy,
// review or audit of their own. `-c mcp_servers={}` does not take away a table config.toml defines, so each of the
// person's servers is turned off by its name.

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

/** `-c` overrides that leave an agent's Codex with the hub's tools alone. */
export function isolationConfig(env: Record<string, string | undefined>): string[] {
  return ["features.plugins=false", "features.apps=false", ...personalServers(env).map((n) => `mcp_servers.${n}.enabled=false`)];
}
