import { isAbsolute, win32 } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { AutoAction } from "../policy/auto.ts";
import { absolutePath, type WorkspaceFileOperation } from "@piomio/shared/agent-workspaces";
import { shellParts } from "../policy/commands.ts";

/** Small, completely parsed file operations. Shell programs, recursion and side effects still get normal review. */
export function ordinaryFilePaths(a: AutoAction, workspace: string): (WorkspaceFileOperation & { review?: boolean }) | undefined {
  const i = (a.input && typeof a.input === "object" ? a.input : {}) as Record<string, unknown>;
  const at = typeof i.cwd === "string" ? i.cwd : workspace;
  const windows = (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
  // Remote Windows paths cannot be inspected on this hub. Leave parent traversal to normal review.
  if (windows(at) && at.split(/[\\/]+/).includes("..")) return undefined;
  const path = (p: string) => (windows(p) || windows(at))
    ? p.split(/[\\/]+/).includes("..") ? undefined : windows(p) ? win32.normalize(p) : win32.resolve(at, p)
    : absolutePath(p, at);
  if (a.kind === "read" || a.kind === "write" || /^(?:machine_read_file|machine_write_file|machine_list_dir)$/.test(a.tool)) {
    const p = i.path ?? i.file_path ?? i.notebook_path ?? i.grantRoot;
    if (a.tool.startsWith("machine_") && (typeof p !== "string" || (!isAbsolute(p) && !windows(p)))) return undefined;
    const full = typeof p === "string" && p ? path(p) : undefined;
    return full ? { paths: [full], write: a.kind === "write" || a.tool === "machine_write_file" } : undefined;
  }
  if (a.kind !== "command" && a.tool !== "machine_exec") return undefined;
  if (a.tool === "machine_exec" && (typeof i.cwd !== "string" || (!isAbsolute(i.cwd) && !windows(i.cwd)))) return undefined;
  if (typeof i.command !== "string" || i.network) return undefined;
  const parts = shellParts(i.command, { home: homedir(), tmp: tmpdir() });
  if (!parts?.length) return undefined;
  const flags: Record<string, RegExp> = { ls: /^(?:-[lahd1]+|--directory)$/, cat: /^-[nbsuETAv]+$/, cp: /^-[fp]+$/, mv: /^-[f]+$/, mkdir: /^-p$/, touch: /^-c$/ };
  const paths: string[] = []; const copies: [string, string][] = []; let write = false;
  for (const [program, ...args] of parts) {
    // An absolute program name could be a script made by the agent.
    if (program === "pwd" && !args.length) { paths.push(at); continue; }
    if (isAbsolute(program) || !Object.hasOwn(flags, program)) return undefined;
    const files: string[] = []; let positional = false;
    for (const word of args) {
      if (word === "--" && !positional) { positional = true; continue; }
      if (!positional && word.startsWith("-")) { if (!flags[program].test(word)) return undefined; }
      else { if (/[?*\[\]{}~]/.test(word)) return undefined; const full = path(word); if (!full) return undefined; files.push(full); }
    }
    if (!files.length) { if (program !== "ls") return undefined; files.push(at); }
    if ((program === "cp" || program === "mv") && files.length !== 2) return undefined;
    if (program === "cp" || program === "mv") copies.push([files[0]!, files[1]!]);
    write ||= !["ls", "cat"].includes(program);
    paths.push(...files);
  }
  return { paths, write, ...(copies.length ? { copies } : {}), ...(parts.length > 1 ? { review: true } : {}) };
}
