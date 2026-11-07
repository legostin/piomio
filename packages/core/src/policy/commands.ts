// Shell lines a brain wants to run outside its sandbox (native-permissions.ts, policy/auto.ts): which only read (they
// need nobody's yes), which name a path no agent may touch (refused), and which publish (always the person's call).
// The words are read the way a shell would, quotes and escapes included; anything that could hide another command
// (a substitution, a redirection into a file, a heredoc, a background job, a subshell, an unknown variable) is not
// read at all, and such a line is never "only reading".
import { isAbsolute, normalize, relative } from "node:path";

export interface ShellEnv {
  home: string;
  /** What $TMPDIR is for the brain. */
  tmp: string;
}

/** `$HOME`, `${HOME}`, `$TMPDIR`, `${TMPDIR}` at `src[at]`: its value and where it ends; undefined for any other. */
function variable(src: string, at: number, env: ShellEnv): { value: string; end: number } | undefined {
  const m = /^\$(?:\{(HOME|TMPDIR)\}|(HOME|TMPDIR)(?![A-Za-z0-9_]))/.exec(src.slice(at));
  if (!m) return undefined;
  return { value: (m[1] ?? m[2]) === "HOME" ? env.home : env.tmp, end: at + m[0].length };
}

/**
 * The words of each command of a line, split on `;`, `&&`, `||`, `|` and new lines; undefined when the line has
 * anything a plain command does not need. Output thrown away (`2>&1`, `>/dev/null`) is fine.
 */
export function shellParts(line: string, env: ShellEnv): string[][] | undefined {
  const out: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  /** A pipe or `&&`/`||` was seen: a command must follow. */
  let needed = false;
  const push = (): boolean => {
    if (word === undefined) return true;
    // `FOO=1 git log` runs with something in its environment (a pager, a hook): not a plain command.
    if (!words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return false;
    words.push(word);
    word = undefined;
    return true;
  };
  const end = (): boolean | undefined => {
    if (!push()) return undefined;
    if (!words.length) return false;
    out.push(words);
    words = [];
    return true;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word = (word ?? "") + line.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      let buf = "";
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j];
        if (d === "\\" && j + 1 < line.length && '"\\$`\n'.includes(line[j + 1])) {
          if (line[j + 1] !== "\n") buf += line[j + 1];
          j++;
        } else if (d === "`") return undefined;
        else if (d === "$") {
          const v = variable(line, j, env);
          if (!v) return undefined;
          buf += v.value;
          j = v.end - 1;
        } else buf += d;
      }
      if (j >= line.length) return undefined;
      word = (word ?? "") + buf;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= line.length) return undefined;
      if (line[i + 1] !== "\n") word = (word ?? "") + line[i + 1];
      i++;
    } else if (c === " " || c === "\t") {
      if (!push()) return undefined;
    } else if (c === "\n" || c === ";") {
      const done = end();
      if (done === undefined || (!done && needed)) return undefined;
      if (done) needed = false;
    } else if (c === "|" || (c === "&" && line[i + 1] === "&")) {
      if (c === "|" && line[i + 1] === "&") return undefined;
      if (line[i + 1] === c) i++;
      if (!end()) return undefined;
      needed = true;
    } else if (c === ">" || (c === "&" && line[i + 1] === ">")) {
      // Only output thrown away: `>/dev/null`, `2>/dev/null`, `&>/dev/null`, `2>&1`, `>&2`.
      if (word !== undefined && word !== "1" && word !== "2") return undefined;
      word = undefined;
      let j = c === "&" ? i + 2 : i + 1;
      if (line[j] === ">") j++;
      if (line[j] === "&" && /[012]/.test(line[j + 1] ?? "")) {
        i = j + 1;
        continue;
      }
      while (line[j] === " ") j++;
      if (!line.startsWith("/dev/null", j) || !/^(?:[\s;|&]|$)/.test(line.slice(j + 9))) return undefined;
      i = j + 8;
    } else if (c === "$") {
      const v = variable(line, i, env);
      if (!v) return undefined;
      word = (word ?? "") + v.value;
      i = v.end - 1;
    } else if (c === "~" && word === undefined) {
      if (!/^(?:[/\s;|&]|$)/.test(line.slice(i + 1))) return undefined;
      word = env.home;
    } else if (c === "#" && word === undefined) {
      const nl = line.indexOf("\n", i);
      i = (nl < 0 ? line.length : nl) - 1;
    } else if ("&<`(){}".includes(c)) {
      return undefined;
    } else {
      word = (word ?? "") + c;
    }
  }
  const done = end();
  if (done === undefined || (!done && needed) || !out.length) return undefined;
  return out;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/**
 * The script a line hands to a shell (`/bin/zsh -lc '<script>'`: how Codex runs every command, and a way round a
 * check for anyone), or undefined when the line is not one shell with `-c`.
 */
function shellScript(words: string[]): string | undefined {
  const [name, ...args] = words;
  if (!SHELLS.has(name.slice(name.lastIndexOf("/") + 1))) return undefined;
  const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
  // Flags before it may only make it a login or interactive shell; nothing may follow the script ($0, $1…).
  if (flag < 0 || flag !== args.length - 2 || !/^-[lice]+$/.test(args[flag])) return undefined;
  return args.slice(0, flag).every((a) => /^-[lie]+$|^--login$/.test(a)) ? args[flag + 1] : undefined;
}

/** shellParts with what a shell's `-c` script runs in place of the shell; undefined when any of it is not plain. */
export function commandParts(line: string, env: ShellEnv, depth = 0): string[][] | undefined {
  const parts = shellParts(line, env);
  if (!parts) return undefined;
  const out: string[][] = [];
  for (const words of parts) {
    const script = shellScript(words);
    if (script === undefined) {
      // A shell given anything else (a script file, flags we do not know) runs what nobody here can see.
      if (SHELLS.has(words[0].slice(words[0].lastIndexOf("/") + 1)) && words.length > 1) return undefined;
      out.push(words);
      continue;
    }
    const inner = depth < 3 ? commandParts(script, env, depth + 1) : undefined;
    if (!inner) return undefined;
    out.push(...inner);
  }
  return out;
}

/** The line as the person would type it: a single `zsh -lc '<script>'` shows as its script. */
export function shownCommand(line: string): string {
  const parts = shellParts(line, { home: "~", tmp: "$TMPDIR" });
  const script = parts?.length === 1 ? shellScript(parts[0]) : undefined;
  return script === undefined ? line : shownCommand(script);
}

const any = () => true;
const without = (bad: RegExp) => (args: string[]) => !args.some((a) => bad.test(a));
/**
 * A long option that is, or abbreviates, one of `names`: git and getopt_long take any unique prefix (`--open` is
 * `--open-files-in-pager`, `--com` is `--compress-program`), so a prefix counts as the option itself.
 */
export function longOption(a: string, names: string[]): boolean {
  if (!a.startsWith("--") || a === "--") return false;
  const key = a.slice(2).split("=")[0]!;
  return !!key && names.some((n) => n.startsWith(key));
}
const withoutLong = (names: string[], short?: RegExp) => (args: string[]) => !args.some((a) => longOption(a, names) || (!!short && !a.startsWith("--") && short.test(a)));
const positional = (args: string[]) => args.filter((a) => !a.startsWith("-"));

/** Programs that only read (files, the repository, the computer), with what would make one write or run something. */
const READERS: Record<string, (args: string[]) => boolean> = {
  ls: any,
  cat: any,
  head: any,
  tail: any,
  wc: any,
  nl: any,
  rev: any,
  fold: any,
  fmt: any,
  expand: any,
  paste: any,
  comm: any,
  column: any,
  tr: any,
  cut: any,
  strings: any,
  od: any,
  hexdump: any,
  // -C compiles a magic file: it writes one.
  file: withoutLong(["compile"], /^-[A-Za-z]*C/),
  stat: any,
  du: any,
  df: any,
  grep: any,
  egrep: any,
  fgrep: any,
  // A preprocessor runs a program on every file.
  rg: withoutLong(["pre"]),
  find: without(/^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/),
  tree: without(/^-o$/),
  diff: withoutLong(["output"]),
  cmp: any,
  jq: any,
  // --compress-program runs a program on what it sorts.
  sort: withoutLong(["output", "compress-program"], /^-[A-Za-z]*o/),
  // A second name is the file it writes.
  uniq: (args) => positional(args).length <= 1,
  xxd: (args) => !args.some((a) => /^-r/.test(a)) && positional(args).length <= 1,
  shasum: any,
  sha256sum: any,
  md5: any,
  md5sum: any,
  cd: any,
  pwd: any,
  echo: any,
  printf: any,
  true: any,
  false: any,
  which: any,
  type: any,
  basename: any,
  dirname: any,
  realpath: any,
  readlink: any,
  seq: any,
  whoami: any,
  id: any,
  uname: any,
  uptime: any,
  sw_vers: any,
  nproc: any,
  date: withoutLong(["set", "file"], /^-[A-Za-z]*[sf]/),
  git: gitReads,
};

/** git subcommands that only read the repository. */
const GIT_READ = new Set([
  "log",
  "show",
  "status",
  "diff",
  "ls-files",
  "ls-tree",
  "grep",
  "rev-parse",
  "describe",
  "blame",
  "shortlog",
  "cat-file",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "merge-base",
  "name-rev",
  "whatchanged",
  "count-objects",
  "version",
  "check-ignore",
]);

function gitReads(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C") i += 2;
    else if (args[i] === "--no-pager" || args[i] === "--no-optional-locks") i++;
    // `-c core.pager=…` or an alias could run anything.
    else return false;
  }
  const [sub, ...rest] = args.slice(i);
  if (!sub) return false;
  // What runs a program of the caller's choosing (a pager, an external diff), or writes a file. ls-remote and
  // `remote show` are gone too: they reach the network, and ls-remote's --upload-pack runs any command.
  if (rest.some((a) => /^-O/.test(a) || longOption(a, ["output", "open-files-in-pager", "ext-diff", "upload-pack", "receive-pack", "exec"]))) return false;
  if (GIT_READ.has(sub)) return true;
  switch (sub) {
    case "branch":
      return !positional(rest).length && !rest.some((a) => /^-[dDmMcCuf]$|^--(?:delete|move|copy|force|set-upstream|unset-upstream|edit-description|track|no-track)/.test(a));
    case "tag":
      return (!rest.length || rest.some((a) => a === "-l" || a.startsWith("--list"))) && !rest.some((a) => /^-[dasfmFu]$|^--(?:delete|annotate|sign|force|message|file)/.test(a));
    case "remote":
      return !rest.length || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) || rest[0] === "get-url";
    case "config":
      return rest.some((a) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a)) && !rest.some((a) => /^--(?:add|unset|replace|rename|remove|edit)|^-e$/.test(a));
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    default:
      return false;
  }
}

/** True when every command of the line only reads (see READERS); paths are checked apart (deniedPathIn). */
export function readOnlyCommand(line: string, env: ShellEnv): boolean {
  const parts = commandParts(line, env);
  return !!parts && parts.every(([name, ...args]) => !name.includes("/") && Object.hasOwn(READERS, name) && READERS[name](args));
}

function inside(p: string, dir: string): boolean {
  const rel = relative(normalize(dir), normalize(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Rough words of a line the shell reader refused: enough to find a path in it. */
function roughWords(line: string, env: ShellEnv): string[] {
  return line
    .replace(/\\ /g, "\u0000")
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, env.home)
    .replace(/\$\{TMPDIR\}|\$TMPDIR(?![A-Za-z0-9_])/g, env.tmp)
    .split(/[\s'"`;|&<>()=]+/)
    .map((w) => w.replace(/\u0000/g, " ").replace(/^~(?=\/|$)/, env.home));
}

/**
 * The first of `denied` a command names (outside `exempt`, folders or a check of the path named), however it is
 * written: `~`, `$HOME`, quotes, escapes. Letter case does not count (macOS disks ignore it).
 */
export function deniedPathIn(line: string, denied: string[], exempt: string[] | ((path: string) => boolean), env: ShellEnv): string | undefined {
  const open = typeof exempt === "function" ? exempt : (path: string) => exempt.some((e) => inside(path.toLowerCase(), e.toLowerCase()));
  const words = (commandParts(line, env) ?? [roughWords(line, env)]).flat();
  for (const w of words) {
    const low = w.toLowerCase();
    for (const d of denied) {
      const dl = d.toLowerCase().replace(/\/+$/, "");
      for (let at = low.indexOf(dl); at >= 0; at = low.indexOf(dl, at + 1)) {
        const next = low[at + dl.length];
        if (next !== undefined && next !== "/") continue;
        if (!open(w.slice(at))) return d;
      }
    }
  }
  return undefined;
}

/** Commands that publish or reach production: always the person's call. What it is, in English. */
const PUBLISH: [RegExp, string][] = [
  [/\bgh\s+release\b/, "a GitHub release"],
  [/\bgh\s+pr\s+merge\b/, "merging a pull request"],
  [/\bgh\s+(?:pr|issue)\s+(?:comment|review)\b/, "a comment on GitHub"],
  [/\bgh\s+workflow\s+run\b/, "running a workflow"],
  [/\b(?:npm|pnpm|yarn(?:\s+npm)?|cargo|gem|poetry)\s+publish\b|\btwine\s+upload\b/, "publishing a package"],
  [/\bdocker\s+push\b|\bdocker\s+buildx\s+build\b.*--push\b/, "pushing an image"],
  [/\bvercel\b.*--prod\b|\bnetlify\s+deploy\b.*--prod\b|\bfly(?:ctl)?\s+deploy\b|\bwrangler\s+(?:deploy|publish)\b/, "a deploy"],
  [/\bkubectl\s+(?:apply|delete|rollout|scale|set)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bterraform\s+(?:apply|destroy)\b|\bpulumi\s+(?:up|destroy)\b/, "changing infrastructure"],
];

/**
 * A push that publishes: to main or master (a push to piomio's main is a release), a tag, forced, or with no branch
 * named (it may well be main). A working branch named outright is not.
 */
function publishingPush(args: string[]): string | undefined {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  if (args[i] !== "push") return undefined;
  const rest = args.slice(i + 1);
  if (rest.some((a) => /^(?:-f|--force.*|--mirror|--tags|--all|--delete|-d)$/.test(a))) return "a forced push, or one of tags or every branch";
  const refs = positional(rest).slice(1);
  if (!refs.length) return "a push that may update main";
  for (const r of refs) {
    if (r.startsWith("+")) return "a forced push";
    const dest = (r.includes(":") ? r.slice(r.indexOf(":") + 1) : r).replace(/^refs\/heads\//, "");
    if (/^(?:main|master)$/.test(dest)) return "a push to main";
    if (/^(?:refs\/tags\/|v\d)/.test(dest)) return "a push of a release tag";
  }
  return undefined;
}

export function publishingCommand(line: string): string | undefined {
  for (const [re, what] of PUBLISH) if (re.test(line)) return what;
  const parts = commandParts(line, { home: "~", tmp: "/tmp" });
  if (!parts) return /\bgit\b[^;&|\n]*\bpush\b/.test(line) ? "a push" : undefined;
  for (const [name, ...args] of parts) {
    if (name === "git") {
      const push = publishingPush(args);
      if (push) return push;
    }
  }
  return undefined;
}
