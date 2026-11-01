// What a CLI brain's own tools may do without asking: Claude Code's Read/Write/Edit/Bash/…, Codex's commands and
// file changes, Kimi Code's tools (which have no sandbox around them). The brains run them in their own processes, outside the hub's tool gateway; the CLI asks the hub here
// (Claude Code through its permission prompt tool, Codex through its approval requests: tools/native-permission.ts).
// Inside the agent's own folder (and the temp folders, and the CLI's own folder for the session's saved tool output)
// they just work, and so does a command that runs inside the sandbox; reading or writing elsewhere in the person's
// home, a command outside the sandbox, network from a command, and anything unknown wait for the person's yes on an
// approval card, like an external action. Outside the home (system files, tools) reading is fine. The person's
// credentials and the hub's own data (conversations, the vault, other agents' folders) are never theirs to read.
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type NativeAction =
  | { kind: "read"; tool: string; path: string }
  | { kind: "write"; tool: string; path: string }
  /** A shell command the CLI wants to run outside its sandbox. */
  | { kind: "command"; tool: string; command: string; cwd?: string; reason?: string; network?: string }
  /**
   * A shell command that runs inside the sandbox: no network, writes only in the agent's folders and temp, the
   * person's credentials unreadable. Claude Code still asks about some (paths outside its folder); they need no yes.
   */
  | { kind: "sandboxed"; tool: string; command: string }
  | { kind: "fetch"; tool: string; url?: string }
  | { kind: "free"; tool: string }
  | { kind: "other"; tool: string; input: unknown };

export interface NativeScope {
  /** The agent's own folder for this session. */
  workspace: string;
  /** More folders it may read and write in (temp folders are always in). */
  roots?: string[];
  /** Folders no tool of the brain may read or write, whatever the person says (see `confinement`). */
  denied?: string[];
  home?: string;
}

export interface NativeDecision {
  decision: "allow" | "ask" | "deny";
  /** English, for the audit log. */
  reason: string;
}

/** Tools with no reach of their own: planning, subagents (which ask again), skills, deferred tool lookup. */
const FREE = new Set(["TodoWrite", "Task", "Agent", "Skill", "ToolSearch", "ExitPlanMode", "EnterPlanMode", "KillShell", "BashOutput", "TaskOutput", "TaskStop"]);
/** The web through the CLI: outside content, which taints the session (runner.ts), but reaches nothing of the person's. */
const FETCH = new Set(["WebFetch", "WebSearch"]);
const READ = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A Claude Code tool call as an action. Paths are resolved against `cwd`. */
export function classifyClaudeTool(tool: string, input: unknown, cwd: string): NativeAction {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const at = (p: string | undefined) => (p ? resolve(cwd, expandHome(p)) : cwd);
  if (FREE.has(tool)) return { kind: "free", tool };
  if (FETCH.has(tool)) return { kind: "fetch", tool, url: str(i.url) };
  if (READ.has(tool)) return { kind: "read", tool, path: at(str(i.file_path) ?? str(i.notebook_path) ?? str(i.path)) };
  if (WRITE.has(tool)) return { kind: "write", tool, path: at(str(i.file_path) ?? str(i.notebook_path)) };
  if (tool === "Bash") {
    if (i.dangerouslyDisableSandbox !== true) return { kind: "sandboxed", tool, command: str(i.command) ?? "" };
    return { kind: "command", tool, command: str(i.command) ?? "", cwd, reason: str(i.description) };
  }
  return { kind: "other", tool, input };
}

/** Kimi Code's tools with no reach of their own (planning, subagents that ask again, skills, its goals). */
const KIMI_FREE = new Set(["Agent", "AgentSwarm", "Skill", "SetTodoList", "TodoList", "TaskList", "TaskOutput", "TaskStop", "WaitFor", "ExitPlanMode", "Think", "select_tools", "NotifyUser", "CreateGoal", "GetGoal", "SetGoalBudget", "UpdateGoal"]);

/**
 * A Kimi Code tool call (asked as "kimi.<tool>") as an action. Kimi runs commands with no sandbox around them, so
 * Bash is a command outside one; its file tools name the file `path`.
 */
export function classifyKimiTool(tool: string, input: unknown, cwd: string): NativeAction {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const at = (p: string | undefined) => (p ? resolve(cwd, expandHome(p)) : cwd);
  const file = str(i.path) ?? str(i.file_path);
  if (KIMI_FREE.has(tool)) return { kind: "free", tool };
  if (tool === "Bash") return { kind: "command", tool, command: str(i.command) ?? "", cwd, reason: str(i.description) };
  if (tool === "Write" || tool === "Edit") return { kind: "write", tool, path: at(file) };
  if (tool === "Read" || tool === "Glob" || tool === "Grep" || tool === "ReadMediaFile") return { kind: "read", tool, path: at(file) };
  if (tool === "FetchURL" || tool === "WebSearch") return { kind: "fetch", tool, url: str(i.url) };
  return { kind: "other", tool, input };
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** `p` is `dir` or inside it. */
export function within(p: string, dir: string): boolean {
  const rel = relative(normalize(dir), normalize(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Claude Code's own folder for a session started in `workspace` (~/.claude/projects/<the path, non-alphanumerics as
 * "-">): it keeps the session's long tool outputs there and reads them back, which is the agent's own work.
 */
export function claudeProjectDir(workspace: string, home = homedir()): string {
  return join(home, ".claude", "projects", resolve(workspace).replace(/[^A-Za-z0-9]/g, "-"));
}

/** One program with its arguments: no `;`, `&&`, `|`, redirection, substitution or second line. */
export function simpleCommand(command: string): boolean {
  return !!command.trim() && !/[;&|`$<>\n\\]|\(\s*\)/.test(command);
}

/** Programs whose first argument is what runs: the rule is for that script. */
const INTERPRETERS = new Set(["python", "python3", "node", "bash", "sh", "zsh", "ruby", "perl", "deno", "bun", "npx", "uv", "uvx"]);

/**
 * What an "always allow" from a command's card covers: the same program and subcommand ("git push *" for
 * "git push origin main"; "python3 make.py *" for a script), for simple commands only (simpleCommand); code given
 * inline (-c, -e) or a script with several commands stays this exact command. The rule matches the command with a
 * space after it (native-permission.ts), so "git push" alone is covered too.
 */
export function commandRule(command: string): { op: "eq" | "glob"; value: string } {
  const words = command.trim().split(/\s+/);
  const exact = { op: "eq" as const, value: command };
  if (!simpleCommand(command) || !/^[\w./-]+$/.test(words[0]) || words[0].includes("=")) return exact;
  const program = words[0].split("/").pop()!;
  if (INTERPRETERS.has(program)) {
    if (!words[1] || words[1].startsWith("-")) return exact;
    return { op: "glob", value: `${words[0]} ${words[1]} *` };
  }
  const sub = words[1] && /^[a-z][\w-]*$/.test(words[1]) ? ` ${words[1]}` : "";
  return { op: "glob", value: `${words[0]}${sub} *` };
}

/** The temp folders a command may use (macOS keeps them under /private). */
function temps(): string[] {
  const t = tmpdir();
  return [t, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].filter((d, n, all) => all.indexOf(d) === n);
}

export function decideNative(a: NativeAction, scope: NativeScope): NativeDecision {
  const home = scope.home ?? homedir();
  const own = [scope.workspace, claudeProjectDir(scope.workspace, home), ...(scope.roots ?? []), ...temps()];
  const mine = (p: string) => own.some((d) => within(p, d));
  // Only the agent's own folders open a denied one (the hub's data may well sit in a temp folder).
  const exempt = [scope.workspace, ...(scope.roots ?? [])];
  const denied = (p: string) => !exempt.some((d) => within(p, d)) && (scope.denied ?? []).some((d) => within(p, d));
  if ((a.kind === "read" || a.kind === "write") && denied(a.path)) return { decision: "deny", reason: "the person's credentials or the hub's own data" };
  switch (a.kind) {
    case "free":
      return { decision: "allow", reason: "no reach of its own" };
    case "sandboxed":
      return { decision: "allow", reason: "runs inside the sandbox" };
    case "fetch":
      return { decision: "allow", reason: "the web, through the hub's egress rules" };
    case "read":
      if (mine(a.path)) return { decision: "allow", reason: "inside the agent's folder" };
      // System files and tools are fine to read; the person's home is theirs.
      if (!within(a.path, home)) return { decision: "allow", reason: "outside the person's home" };
      return { decision: "ask", reason: "reads the person's files outside the agent's folder" };
    case "write":
      if (mine(a.path)) return { decision: "allow", reason: "inside the agent's folder" };
      return { decision: "ask", reason: "writes outside the agent's folder" };
    case "command":
      if (!a.network && systemStatusOnly(a.command)) return { decision: "allow", reason: "only reads how the computer is doing" };
      return { decision: "ask", reason: a.network ? `a command reaching ${a.network}` : "a command outside the sandbox" };
    case "other":
      return { decision: "ask", reason: `an unknown tool (${a.tool})` };
  }
}

/**
 * Commands that only report how the computer is doing (processes, memory, CPU, disks, the system's version), and
 * filters over their output. The sandbox may refuse them (process lists), and the person should not have to say yes
 * to "how loaded is my Mac". Anything else, a redirection or substitution, a path, or a flag that shows other
 * processes' environment or writes, is not one: it asks.
 */
const STATUS: Record<string, (args: string[]) => boolean> = {
  // `-E` (and `-e` in legacy mode, `e` BSD-style) shows each process's environment, secrets included; `-M`/`-N` read another kernel's memory.
  ps: (args) => !args.some((x) => /^-?[A-Za-z]*[eEMN][A-Za-z]*$/.test(x)),
  sysctl: (args) => !args.some((x) => x.includes("=") || /^-[A-Za-z]*[wf]/.test(x)),
  top: (args) => args.some((x) => /^-[A-Za-z]*l/.test(x)),
  pmset: (args) => args[0] === "-g",
  memory_pressure: (args) => args.every((x) => x === "-Q"),
  df: () => true,
  vm_stat: numbersOrFlags,
  iostat: numbersOrFlags,
  uptime: none,
  sw_vers: numbersOrFlags,
  uname: numbersOrFlags,
  hostname: (args) => args.every((x) => x.startsWith("-")),
  whoami: none,
  nproc: none,
  date: (args) => args.every((x) => (x.startsWith("+") || x.startsWith("-")) && x !== "-s" && !x.startsWith("-f")),
  echo: () => true,
  printf: () => true,
};
/** Filters read what the command before them printed, never files: only flags, numbers and (for grep) one pattern. */
const FILTERS: Record<string, (args: string[]) => boolean> = {
  head: numbersOrFlags,
  tail: numbersOrFlags,
  sort: (args) => numbersOrFlags(args) && !args.some((x) => /^-[A-Za-z]*o/.test(x)),
  uniq: numbersOrFlags,
  wc: numbersOrFlags,
  cut: numbersOrFlags,
  column: numbersOrFlags,
  tr: () => true,
  grep: grepOverInput,
  egrep: grepOverInput,
  fgrep: grepOverInput,
};

function none(args: string[]): boolean {
  return args.length === 0;
}
function numbersOrFlags(args: string[]): boolean {
  return args.every((x) => x.startsWith("-") || /^[\d.,]+$/.test(x));
}
function grepOverInput(args: string[]): boolean {
  if (args.some((x) => /^-[A-Za-z]*[frRd]/.test(x) || x.startsWith("--file") || x.startsWith("--include") || x.startsWith("--dir"))) return false;
  return args.filter((x) => !x.startsWith("-") && !/^\d+$/.test(x)).length <= 1;
}

/** Shell words of one command line, split into commands by `|`, `||`, `&&`, `;` and new lines; undefined when it has
 * anything a plain status command does not need (substitutions, redirections, globs, escapes, background). */
function commands(line: string): { words: string[]; piped: boolean }[] | undefined {
  // Throwing away error output is harmless.
  const src = line.replace(/(^|\s)(2>&1|2>\/dev\/null|>\/dev\/null)(?=\s|$|[;|&])/g, "$1");
  const out: { words: string[]; piped: boolean }[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let piped = false;
  const end = (next: boolean) => {
    if (word !== undefined) words.push(word);
    word = undefined;
    if (!words.length) return false;
    out.push({ words, piped });
    words = [];
    piped = next;
    return true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, i + 1);
      if (close < 0) return undefined;
      const inner = src.slice(i + 1, close);
      if (c === '"' && /[$`\\]/.test(inner)) return undefined;
      word = (word ?? "") + inner;
      i = close;
    } else if (c === " " || c === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "|" || c === ";" || c === "\n" || c === "&") {
      const two = src.slice(i, i + 2);
      if (c === "&" && two !== "&&") return undefined;
      if (two === "||" || two === "&&") i++;
      if (!end(c === "|" && two !== "||")) return undefined;
    } else if (/[<>`$(){}\\*?[\]~!#]/.test(c)) {
      return undefined;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined || words.length) end(false);
  else if (piped) return undefined;
  return out;
}

/** True when a shell command only reports the computer's state (see STATUS). */
export function systemStatusOnly(command: string): boolean {
  const list = commands(command.trim());
  if (!list?.length) return false;
  return list.every(({ words: [name, ...args], piped }) => {
    // A path in an argument may name a file anywhere; `df` only reports the disk it is on.
    if (name !== "df" && args.some((x) => x.includes("/"))) return false;
    const check = Object.hasOwn(STATUS, name) ? STATUS[name] : piped && Object.hasOwn(FILTERS, name) ? FILTERS[name] : undefined;
    return !!check && check(args);
  });
}

/** The path a summary shows: relative to the home when it is inside it. */
export function shownPath(p: string, home = homedir()): string {
  return within(p, home) && p !== home ? `~${sep}${relative(home, p)}` : p;
}

/** Credentials and private stores in a home folder that no agent's tool reads (relative to the home). */
const PRIVATE = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".local/share/keyrings",
  ".codex",
  ".claude/.credentials.json",
  ".claude.json",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Messages",
  "Library/Mail",
  "Library/Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/1Password",
  "Library/Application Support/com.apple.TCC",
  "Library/Group Containers/group.com.apple.notes",
];

/**
 * What a sandboxed brain may not read: the person's credentials and private stores, and the hub's data folder (its
 * conversations, vault, memory and the other agents' folders), except the session's own workspace and `allow`.
 */
export function confinement(dataDir: string, workspace: string, allow: string[] = [], home = homedir()): { denyRead: string[]; allowRead: string[]; allowWrite: string[] } {
  return { denyRead: [...PRIVATE.map((p) => join(home, p)), dataDir], allowRead: [workspace, ...allow.filter((d) => within(d, dataDir))], allowWrite: userTemp() };
}

/**
 * The person's own temp folder (macOS: /var/folders/…/T, also seen as /private/var/…): system tools such as sips
 * write their scratch files there whatever TMPDIR says, and fail in the sandbox without it.
 */
function userTemp(): string[] {
  const t = tmpdir().replace(/\/+$/, "");
  return t.startsWith("/var/") ? [t, `/private${t}`] : [t];
}
