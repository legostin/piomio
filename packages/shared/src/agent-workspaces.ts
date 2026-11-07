// Only the hub supplies agent/workspace keys, from its conversation/task records. A path spelling is not ownership.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";

/** Make a local path absolute without erasing symlink/.. traversal before the filesystem sees it. */
export function absolutePath(path: string, cwd = process.cwd()): string {
  if (isAbsolute(path)) return path;
  // Drive-relative Windows paths depend on hidden per-drive working directories.
  if (process.platform === "win32" && parse(path).root) throw new Error("Drive-relative paths are not supported");
  const base = isAbsolute(cwd) ? cwd : absolutePath(cwd);
  return `${base}${sep}${path}`;
}

export function realPath(path: string): string {
  const abs = absolutePath(path);
  const root = parse(abs).root;
  let cur = realpathSync.native(root);
  let missing = false;
  const parts = abs.slice(root.length).split(process.platform === "win32" ? /[\\/]+/ : /\/+/);
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      // A not-yet-created parent has no physical traversal semantics to grant yet.
      if (missing || !statSync(cur).isDirectory()) throw new Error("Cannot resolve parent traversal");
      cur = dirname(cur);
      continue;
    }
    cur = join(cur, part);
    if (missing) continue;
    try { lstatSync(cur); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      missing = true;
      continue;
    }
    // Deliberately outside the ENOENT fallback: dangling links and loops fail closed.
    cur = realpathSync.native(cur);
  }
  return cur;
}
function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}
const key = (s: string) => !!s && s !== "." && s !== ".." && !/[\\/\0]/.test(s);
export function ownedWorkspaces(roots: string[], agentId: string, keys: string[]): string[] {
  if (!key(agentId)) return [];
  return roots.flatMap((root) => {
    try {
      const agent = join(realpathSync.native(root), agentId);
      // An agent-root symlink to somebody else's folder grants nothing.
      if (realpathSync.native(agent) !== agent) return [];
      return keys.filter(key).flatMap((k) => {
        try { const path = realPath(join(agent, k)); return inside(path, agent) ? [path] : []; } catch { return []; }
      });
    } catch { return []; }
  });
}
export interface WorkspaceFileOperation { paths: string[]; write: boolean; copies?: [string, string][] }
export function ownsWorkspacePaths(roots: string[], agentId: string, keys: string[], paths: string[], copies: [string, string][] = []): boolean {
  if (!paths.length) return false;
  const scopes = ownedWorkspaces(roots, agentId, keys);
  try {
    // cp source directory writes directory/basename(source), possibly through an existing destination symlink.
    const destinations = copies.flatMap(([source, dest]) => {
      try { return statSync(dest).isDirectory() ? [join(realPath(dest), basename(source))] : []; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    });
    return [...paths, ...destinations].every((p) => scopes.some((s) => inside(realPath(p), s)));
  } catch { return false; }
}
