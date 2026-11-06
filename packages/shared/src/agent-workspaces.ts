// Only the hub supplies agent/workspace keys, from its conversation/task records. A path spelling is not ownership.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function realPath(path: string): string {
  let cur = resolve(path); const tail: string[] = [];
  for (;;) {
    try { lstatSync(cur); return join(realpathSync.native(cur), ...tail); }
    catch (e) {
      // A dangling symlink, inaccessible path or loop must never become a lexical permission.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      try { if (lstatSync(cur).isSymbolicLink()) throw new Error("Dangling workspace link"); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const parent = dirname(cur); if (parent === cur) throw e;
      tail.unshift(basename(cur)); cur = parent;
    }
  }
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
      try { return statSync(dest).isDirectory() ? [join(dest, basename(source))] : []; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    });
    return [...paths, ...destinations].every((p) => scopes.some((s) => inside(realPath(p), s)));
  } catch { return false; }
}
