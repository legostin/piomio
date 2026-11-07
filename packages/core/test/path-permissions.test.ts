import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsWorkspacePaths, realPath } from "@piomio/shared/agent-workspaces";
import { ordinaryFilePaths } from "../src/access/owned-files.ts";
import { checkLocalFolder } from "../src/agent-folders.ts";
import { classifyClaudeTool, classifyKimiTool, decideNative, expandHome } from "../src/native-permissions.ts";

// Every protected path here is a fixture, never the developer's actual credentials.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "path-permissions-")));
const home = join(root, "home");
const data = join(home, "hub");
const wsRoot = join(data, "workspaces");
const workspace = join(wsRoot, "dev", "task");
const foreign = join(wsRoot, "other", "task");
const mountedKeys = join(root, "mounted-keys");
for (const p of [workspace, join(foreign, "deep"), mountedKeys]) mkdirSync(p, { recursive: true });
const dirLink = (target: string, link: string) => symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
dirLink(join(foreign, "deep"), join(workspace, "link"));
dirLink(mountedKeys, join(home, ".ssh"));
dirLink(data, join(home, "hub-alias"));
writeFileSync(join(workspace, "source"), "own content");
writeFileSync(join(workspace, "victim"), "lexical decoy");
writeFileSync(join(foreign, "victim"), "foreign content");
writeFileSync(join(mountedKeys, "key"), "fixture key");
const traversal = `${workspace}/link/../victim`;
const scope = { workspace, home, denied: [data, join(home, ".ssh")] };
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("symlink traversal before ownership checks", () => {
  it("does not auto-approve a copy that physically overwrites another agent's file", () => {
    copyFileSync(join(workspace, "source"), traversal);
    expect(readFileSync(join(foreign, "victim"), "utf8")).toBe("own content");
    expect(readFileSync(join(workspace, "victim"), "utf8")).toBe("lexical decoy");
    for (const dest of [traversal, "link/../victim"]) {
      const op = ordinaryFilePaths({ kind: "command", tool: "Bash", input: { command: `cp source '${dest}'` }, summary: "copy", why: "test" }, workspace);
      expect(op && ownsWorkspacePaths([wsRoot], "dev", ["task"], op.paths, op.copies), dest).not.toBe(true);
    }
  });

  it("preserves traversal in an explicit command working directory and file-tool inputs", () => {
    const op = ordinaryFilePaths({ kind: "command", tool: "machine_exec", input: { cwd: `${workspace}/link/..`, command: "touch victim" }, summary: "touch", why: "test" }, workspace);
    expect(op && ownsWorkspacePaths([wsRoot], "dev", ["task"], op.paths)).not.toBe(true);
    for (const tool of ["Read", "machine_write_file"]) {
      const file = ordinaryFilePaths({ kind: "write", tool, input: { path: traversal }, summary: "file", why: "test" }, workspace);
      expect(file && ownsWorkspacePaths([wsRoot], "dev", ["task"], file.paths)).not.toBe(true);
    }
  });

  it.each(["victim", "new/deep/file"])("resolves link/../%s before checking ownership", (tail) => {
    const path = `${workspace}/link/../${tail}`;
    expect(realPath(path)).toBe(join(foreign, tail));
    expect(ownsWorkspacePaths([wsRoot], "dev", ["task"], [path])).toBe(false);
  });

  it("checks the actual copy destination when the directory operand contains traversal", () => {
    const dest = `${workspace}/link/..`;
    expect(ownsWorkspacePaths([wsRoot], "dev", ["task"], [join(workspace, "source"), dest], [[join(workspace, "source"), dest]])).toBe(false);
  });

  it.each([classifyClaudeTool, classifyKimiTool])("keeps traversal in native file classifiers (%#)", (classify) => {
    for (const tool of ["Read", "Write"]) {
      const action = classify(tool, { path: "link/../victim", file_path: "link/../victim" }, workspace);
      expect(decideNative(action, scope).decision).toBe("deny");
    }
  });

  it("checks a command's physical path before its read-only shortcut", () => {
    expect(decideNative({ kind: "command", tool: "Bash", command: "cat link/../victim", cwd: workspace }, scope).decision).toBe("deny");
  });

  it("does not collapse traversal while expanding the home", () => {
    const path = expandHome("~/hub/workspaces/dev/task/link/../victim", home);
    expect(decideNative({ kind: "read", tool: "Read", path }, scope).decision).toBe("deny");
  });

  it("checks a destination child after resolving its directory's traversal", () => {
    const parent = join(workspace, "copy-parent");
    mkdirSync(join(parent, "deep"), { recursive: true });
    dirLink(join(parent, "deep"), join(workspace, "copy-link"));
    symlinkSync(join(foreign, "victim"), join(parent, "source"));
    const dest = `${workspace}/copy-link/..`;
    const source = join(workspace, "source");
    expect(ownsWorkspacePaths([wsRoot], "dev", ["task"], [source, dest], [[source, dest]])).toBe(false);
  });

  it("leaves remote Windows traversal to normal review", () => {
    const op = ordinaryFilePaths({ kind: "write", tool: "machine_write_file", input: { path: "C:\\work\\link\\..\\victim" }, summary: "write", why: "test" }, "C:\\work");
    expect(op).toBeUndefined();
  });

  it("does not turn broken links, loops or missing parent traversal into ownership", () => {
    dirLink(join(root, "missing"), join(workspace, "broken"));
    dirLink(join(workspace, "loop"), join(workspace, "loop"));
    for (const part of ["broken", "loop", "missing/.."]) {
      const path = `${workspace}/${part}/file`;
      expect(() => realPath(path)).toThrow();
      expect(ownsWorkspacePaths([wsRoot], "dev", ["task"], [path])).toBe(false);
    }
  });
});

describe("canonical scope roots", () => {
  it.each(["read", "write"] as const)("denies %s through a protected directory symlink and its target", (kind) => {
    for (const path of [join(home, ".ssh", "key"), join(mountedKeys, "key")]) {
      expect(decideNative({ kind, tool: "file", path }, scope).decision, path).toBe("deny");
    }
  });

  it("protects a symlinked hub while still opening its own workspace and read roots", () => {
    const alias = join(home, "hub-alias");
    const linkedScope = { workspace: join(alias, "workspaces/dev/task"), home, denied: [alias], readRoots: [join(alias, "workspaces/dev/earlier")] };
    for (const base of [data, alias]) {
      expect(decideNative({ kind: "read", tool: "Read", path: join(base, "vault.db") }, linkedScope).decision).toBe("deny");
      expect(decideNative({ kind: "read", tool: "Read", path: join(base, "workspaces/other/task/victim") }, linkedScope).decision).toBe("deny");
      expect(decideNative({ kind: "write", tool: "Write", path: join(base, "workspaces/dev/task/new") }, linkedScope).decision).toBe("allow");
      expect(decideNative({ kind: "read", tool: "Read", path: join(base, "workspaces/dev/earlier/file") }, linkedScope).decision).toBe("allow");
      expect(decideNative({ kind: "write", tool: "Write", path: join(base, "workspaces/dev/earlier/file") }, linkedScope).decision).toBe("deny");
    }
  });

  it("denies commands naming the canonical target of a protected root", () => {
    expect(decideNative({ kind: "command", tool: "Bash", command: `cat '${mountedKeys}/key'`, cwd: workspace }, scope).decision).toBe("deny");
  });

  it("also preserves a lexical denial when a child of a protected root links out", () => {
    symlinkSync(join(workspace, "source"), join(mountedKeys, "link-out"));
    for (const kind of ["read", "write"] as const) {
      expect(decideNative({ kind, tool: "file", path: join(home, ".ssh", "link-out") }, scope).decision).toBe("deny");
    }
  });
});

describe("project folder validation", () => {
  it("never opens a symlinked credential root or a parent of its target", () => {
    for (const path of [join(home, ".ssh"), mountedKeys]) expect(checkLocalFolder(path, { home, dataDir: data })).toHaveProperty("error");
    const mounted = join(root, "another-volume");
    mkdirSync(join(mounted, "keys"), { recursive: true });
    dirLink(join(mounted, "keys"), join(home, ".aws"));
    expect(checkLocalFolder(mounted, { home, dataDir: data })).toHaveProperty("error");
  });

  it("fails closed when a protected root cannot be resolved", () => {
    const brokenHome = join(root, "broken-home");
    const project = join(brokenHome, "project");
    mkdirSync(project, { recursive: true });
    dirLink(join(root, "missing-protected"), join(brokenHome, ".ssh"));
    expect(checkLocalFolder(project, { home: brokenHome, dataDir: data })).toHaveProperty("error");
  });
});
