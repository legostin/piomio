// An agent's access map (docs/superpowers/specs/2026-11-05-unified-access-design.md): what it can reach — computers
// and their folders, the internet through the hub's proxy, the services the person connected — built from what the
// hub keeps anyway (AgentDef.machines and .folders, the paired machines, brainEgressAllow, the integrations' live
// status). Nothing is stored here. Auto mode's reviewer reads it (a system on the map is not "one the person did not
// mention"), the agent reads it through hub_access, and so does the person when they ask an agent about access.
// Pure: app.ts gathers the inputs.

import type { AgentFolder, Computer, IntegrationView } from "@piomio/shared";

export interface AccessComputer {
  id: string;
  name: string;
  /** The hub's own computer. */
  here: boolean;
  online: boolean;
  /** A paired computer's commands (Blender, builds) are on; unset for the hub's own (its brains' own shells). */
  commands?: boolean;
  /** The agent's project folders there. */
  folders: AgentFolder[];
}

export interface AccessService {
  /** The catalog id ("notion", "composio:github"). */
  id: string;
  name: string;
  /** signin: waiting for the person to sign in or set it up; reconnecting: the hub is reaching it again by itself. */
  status: "connected" | "reconnecting" | "signin" | "error";
  /** Why it is not connected, or the account it is connected as. */
  detail?: string;
  /** The outside service it goes through (Composio). */
  via?: string;
}

export interface AccessMap {
  agent: { id: string; name: string };
  /** The session's own folder, when the map is for one session. */
  ownFolder?: string;
  computers: AccessComputer[];
  internet: { builtIn: string[]; added: string[] };
  services: AccessService[];
}

export interface AccessInput {
  agent: { id: string; name: string; machines?: string[]; folders?: AgentFolder[] };
  /** The id agents name the hub's computer by ("local", or its replica id). */
  here: string;
  computers: Array<Computer & { commands?: boolean }>;
  ownFolder?: string;
  builtInHosts: string[];
  addedHosts: string[];
  services: AccessService[];
}

/** The map: only the computers the agent is bound to (AgentDef.machines) when it is; replicas on standby are not there. */
export function buildAccessMap(i: AccessInput): AccessMap {
  const bound = i.agent.machines?.length ? new Set(i.agent.machines) : undefined;
  const folderOn = (id: string) => (i.agent.folders ?? []).filter((f) => (f.machine ?? i.here) === id || (id === i.here && f.machine === "local"));
  const computers = i.computers
    .filter((c) => !c.standby && (!bound || bound.has(c.id) || (c.id === i.here && bound.has("local"))))
    .map((c) => ({ id: c.id, name: c.name, here: c.id === i.here, online: c.online, ...(c.id !== i.here && c.commands !== undefined ? { commands: c.commands } : {}), folders: folderOn(c.id) }));
  return {
    agent: { id: i.agent.id, name: i.agent.name },
    ...(i.ownFolder ? { ownFolder: i.ownFolder } : {}),
    computers,
    internet: { builtIn: i.builtInHosts, added: i.addedHosts },
    services: i.services,
  };
}

/** A catalog card as a service of the map, or undefined when it is not an account the agent could use (off, a plain ability). */
export function serviceOf(v: IntegrationView, servers: Array<{ source: string; status: string; error?: string }>): AccessService | undefined {
  if (v.connect === "none" || v.connect === "remote" || v.status === "off" || v.status === "unavailable") return undefined;
  const mine = servers.filter((s) => s.source === (v.plugin ?? v.id));
  const via = v.via?.name && v.via.name !== v.name ? { via: v.via.name } : {};
  const base = { id: v.id, name: v.name, ...via };
  if (v.status === "connected") return { ...base, status: "connected", ...(v.account ? { detail: v.account } : {}) };
  const again = mine.find((s) => s.status === "reconnecting");
  if (again) return { ...base, status: "reconnecting", ...(again.error ? { detail: again.error } : {}) };
  if (v.status === "needs-setup") return { ...base, status: "signin", ...(v.detail ? { detail: v.detail } : {}) };
  return { ...base, status: "error", ...(v.detail ? { detail: v.detail } : {}) };
}

/** Hosts the person reads as kinds, not as a list of 25 patterns. */
const KINDS: Array<[RegExp, string]> = [
  [/anthropic|claude|openai|chatgpt|kimi|openrouter|googleapis/, "model APIs"],
  [/npmjs|pypi|pythonhosted/, "package registries"],
  [/github/, "GitHub"],
  [/sentry|statsig/, "the CLIs' own error reports"],
];

function kindsOf(hosts: string[]): string[] {
  const out = new Set<string>();
  for (const h of hosts) out.add(KINDS.find(([re]) => re.test(h))?.[1] ?? h);
  return [...out];
}

/**
 * The map as lines for a model, English and short. `reviewer`: for auto mode's reviewer, without what servers said
 * (an error, an account: their words, not the hub's) and with the services marked as the whole hub's, not this agent's.
 */
export function accessView(m: AccessMap, opts: { reviewer?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push("Computers:");
  for (const c of m.computers) {
    const facts = [c.here ? "the hub's own computer" : "", c.online ? "online" : "offline", c.commands === true ? "commands on" : c.commands === false ? "commands off" : ""].filter(Boolean);
    const folders = c.folders.length ? `; project folders: ${c.folders.map((f) => `${f.name} ${f.path}`).join(", ")}` : "";
    lines.push(`- ${c.name} (${c.id}): ${facts.join(", ")}${folders}`);
  }
  if (m.ownFolder) lines.push(`The agent's own folder: ${m.ownFolder}`);
  const added = m.internet.added.length ? `; added by the person: ${m.internet.added.join(", ")}` : "";
  lines.push(`Internet: commands go through the hub's proxy. Open: ${kindsOf(m.internet.builtIn).join(", ")}${added}. Any other host is checked once per session.`);
  const usable = m.services.filter((s) => s.status !== "signin");
  const waiting = m.services.filter((s) => s.status === "signin");
  lines.push(opts.reviewer ? "Services connected to the hub (shared by every agent: not a sign that this agent should act on them):" : "Services the person connected:");
  if (!usable.length) lines.push("- none");
  for (const s of usable) {
    const state = s.status === "connected" ? "connected" : s.status === "reconnecting" ? "reconnecting by itself (the sign-in is kept)" : "not working";
    lines.push(`- ${s.name}${s.via ? ` (via ${s.via})` : ""}: ${state}${s.detail && !opts.reviewer ? ` — ${s.detail}` : ""}`);
  }
  if (waiting.length) lines.push(`Not connected (the person can connect them): ${waiting.map((s) => s.name).join(", ")}`);
  return lines.join("\n");
}
