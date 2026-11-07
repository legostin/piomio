// An agent's project folders (AgentDef.folders): where the person keeps a project the agent works on ("the site is in
// ~/code/site"). Its brains on that computer read and write them like their own folder (the sandbox's allowRead and
// allowWrite, native_permission's roots), and its prompt lists them. A session still starts in its own folder, so the
// hub's files (skills, attachments, downloads) never land in the project. A folder opens only with the person's yes on
// a card (hub_agent_folder_add), and never one that holds their credentials, the hub's data, the whole home or the system.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import type { AgentFolder } from "@piomio/shared";
import { realPath } from "@piomio/shared/agent-workspaces";
import { expandHome, privateDirs, shownPath, within } from "./native-permissions.ts";

/** Most folders an agent keeps. */
export const MAX_FOLDERS = 30;

/** System folders no project lives in (macOS, Linux, Windows); temp folders are writable anyway. */
const SYSTEM = [
  "/System",
  "/Library",
  "/Applications",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/private/etc",
  "/var/db",
  "/private/var/db",
  "/var/root",
  "/private/var/root",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "C:\\Windows",
  "C:\\Program Files",
];

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The folders in an agent file's frontmatter: entries without a name or a path are dropped. */
export function parseFolders(v: unknown): AgentFolder[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AgentFolder[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const name = str(o.name);
    const path = str(o.path);
    if (!name || !path) continue;
    const machine = str(o.machine);
    const note = str(o.note);
    out.push({ name, path, ...(machine ? { machine } : {}), ...(note ? { note } : {}) });
  }
  return out.length ? out.slice(0, MAX_FOLDERS) : undefined;
}

/** Same project: the same name (any case) or the same path on the same computer. */
export function sameFolder(a: AgentFolder, b: AgentFolder): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase() || ((a.machine ?? "") === (b.machine ?? "") && a.path === b.path);
}

/**
 * A folder on the hub's own computer as it is kept: its real absolute path, or what is wrong with it (English, for
 * the agent). `~/…` is the person's home.
 */
export function checkLocalFolder(path: string, o: { dataDir: string; home?: string }): { path: string } | { error: string } {
  const home = o.home ?? homedir();
  const asked = expandHome(path.trim(), home);
  if (!isAbsolute(asked)) return { error: `${path}: give the full path (like ~/code/site or /Volumes/Work/site).` };
  let real: string;
  try {
    real = realPath(asked);
    if (!statSync(real).isDirectory()) return { error: `${path} is a file, not a folder.` };
  } catch {
    return { error: `There is no folder ${path} on this computer.` };
  }
  let realHome: string;
  let dataDir: string;
  let secrets: string[];
  try {
    realHome = realPath(home);
    dataDir = realPath(o.dataDir);
    secrets = privateDirs(realHome).map(realPath);
  } catch { return { error: "Cannot resolve the protected folders on this computer." }; }
  if (real === dirname(real) || within(realHome, real)) return { error: `${shownPath(real, realHome)} is too wide: name the project's own folder.` };
  if (within(real, dataDir) || within(dataDir, real)) return { error: `${shownPath(real, realHome)} holds the hub's own data, which no agent opens.` };
  const secret = secrets.find((d) => within(real, d) || within(d, real));
  if (secret) return { error: `${shownPath(real, realHome)} holds the person's credentials (${shownPath(secret, realHome)}), which no agent opens.` };
  if (SYSTEM.some((d) => within(real, d) && !within(real, realHome))) return { error: `${real} is a system folder, not a project.` };
  return { path: real };
}

/**
 * The agent's folders on the computer a session runs on: `machine` as a brain ref names it ("local" is the hub's),
 * `here` the hub's own id in a cluster ("local" otherwise).
 */
export function foldersOn(folders: AgentFolder[] | undefined, machine: string, here: string): AgentFolder[] {
  return (folders ?? []).filter((f) => {
    const on = f.machine ?? "local";
    return on === machine || (machine === "local" && (on === "local" || on === here));
  });
}

/** The paths a session on the hub's own computer opens: what is there now (a folder moved away opens nothing). */
export function localFolderPaths(folders: AgentFolder[], o: { dataDir: string; home?: string }): string[] {
  return folders.flatMap((f) => {
    const r = checkLocalFolder(f.path, o);
    return "path" in r ? [r.path] : [];
  });
}

/** "Site: /Users/me/code/site (the site's code)" for the prompt and the tools' answers: the path as the agent uses it. */
export function folderLine(f: AgentFolder): string {
  return `${f.name}: ${f.path}${f.note ? ` (${f.note})` : ""}`;
}
