// Slash-command autocomplete for the composer: the hub's own commands (source "hub"), then the skills'.

export interface CommandInfo {
  name: string;
  description: string;
  source?: string;
  /** A hub command's hint for its words ("what to do"): choosing it puts it in the field to write them. */
  args?: string;
}

/** A hub command without words ("/brain", "/archive") is sent as soon as it is chosen; the rest wait for their words. */
export function sendsAtOnce(c: CommandInfo): boolean {
  return c.source === "hub" && !c.args;
}

/** The "/word" being typed at the start of the input, or null when autocomplete should be hidden. */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1] : null;
}

/** Commands matching the query: prefix matches first (the hub's in their own order, then the rest by name), then substring matches in name or description. */
export function filterCommands(commands: CommandInfo[], query: string, limit = 8): CommandInfo[] {
  const q = query.toLowerCase();
  const prefix: CommandInfo[] = [];
  const rest: CommandInfo[] = [];
  for (const c of commands) {
    const n = c.name.toLowerCase().replace(/^\//, "");
    if (n.startsWith(q)) prefix.push(c);
    else if (q && (n.includes(q) || c.description.toLowerCase().includes(q))) rest.push(c);
  }
  const hub = (c: CommandInfo) => (c.source === "hub" ? 0 : 1);
  prefix.sort((a, b) => hub(a) - hub(b) || (hub(a) ? a.name.localeCompare(b.name) : 0));
  return [...prefix, ...rest].slice(0, limit);
}

/** Text after choosing a command: "/name " ready for arguments. */
export function applyCommand(name: string): string {
  return `/${name.replace(/^\//, "")} `;
}
