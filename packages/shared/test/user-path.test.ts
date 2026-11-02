// Where the user's own CLIs live: the PATH of their login shell (macOS, Linux) or of their account (Windows registry).
import { describe, expect, it } from "vitest";
import { expandWinVars, mergeDirs, parseRegPath, parseShellPath, PATH_MARK, readUserPath, UserPath, type Run } from "../src/user-path.ts";

describe("parsing", () => {
  it("reads only the marked line of the shell output", () => {
    const out = `Welcome back!\nnvm: using node v24\n${PATH_MARK}/Users/me/.npm-global/bin:/opt/homebrew/bin:/usr/bin\nbye\n`;
    expect(parseShellPath(out)).toEqual(["/Users/me/.npm-global/bin", "/opt/homebrew/bin", "/usr/bin"]);
    expect(parseShellPath("no mark here\n")).toBeUndefined();
  });

  it("reads the Path value of a reg query", () => {
    const user = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;C:\\Tools\r\n\r\n";
    expect(parseRegPath(user)).toBe("%USERPROFILE%\\AppData\\Roaming\\npm;C:\\Tools");
    expect(parseRegPath("    Path    REG_SZ    C:\\Windows\r\n")).toBe("C:\\Windows");
    expect(parseRegPath("ERROR: The system was unable to find the specified registry key or value.")).toBeUndefined();
  });

  it("expands %VARS% case-insensitively and keeps unknown ones", () => {
    expect(expandWinVars("%UserProfile%\\bin;%NOPE%\\x", { USERPROFILE: "C:\\Users\\me" })).toBe("C:\\Users\\me\\bin;%NOPE%\\x");
  });

  it("keeps only directories the current PATH lacks, once each", () => {
    expect(mergeDirs("/usr/bin:/bin", ["/usr/bin", "/a", "", "/a", "/b"], ":")).toEqual(["/a", "/b"]);
    expect(mergeDirs(undefined, ["/a"], ":")).toEqual(["/a"]);
  });
});

describe("readUserPath", () => {
  it("asks the login shell on macOS and Linux", async () => {
    const calls: string[][] = [];
    const run: Run = async (file, args) => {
      calls.push([file, ...args]);
      return `banner\n${PATH_MARK}/home/me/.local/bin:/usr/bin\n`;
    };
    expect(await readUserPath({ platform: "darwin", env: { SHELL: "/bin/zsh", PATH: "/usr/bin" }, run })).toEqual(["/home/me/.local/bin"]);
    expect(calls[0].slice(0, 4)).toEqual(["/bin/zsh", "-l", "-i", "-c"]);
    // No SHELL (launchd): the platform's default shell.
    await readUserPath({ platform: "darwin", env: { PATH: "/usr/bin" }, run });
    expect(calls[1][0]).toBe("/bin/zsh");
    await readUserPath({ platform: "linux", env: { PATH: "/usr/bin" }, run });
    expect(calls[2][0]).toBe("/bin/sh");
  });

  it("joins the user and machine Path from the registry on Windows", async () => {
    const run: Run = async (_file, args) =>
      args[1].startsWith("HKCU") ? "    Path    REG_EXPAND_SZ    %USERPROFILE%\\npm;C:\\Shared\r\n" : "    Path    REG_EXPAND_SZ    C:\\Windows;C:\\Shared\r\n";
    const dirs = await readUserPath({ platform: "win32", env: { USERPROFILE: "C:\\Users\\me", Path: "C:\\Windows" }, run });
    expect(dirs).toEqual(["C:\\Users\\me\\npm", "C:\\Shared"]);
  });

  it("gives nothing when the shell fails or hangs", async () => {
    const run: Run = async () => {
      throw new Error("timed out");
    };
    expect(await readUserPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, run })).toEqual([]);
  });
});

describe("UserPath", () => {
  it("caches the directories and says when they changed", async () => {
    let out = `${PATH_MARK}/a:/usr/bin\n`;
    const p = new UserPath({ platform: "darwin", env: { SHELL: "/bin/zsh", PATH: "/usr/bin" }, run: async () => out });
    expect(p.dirs()).toEqual([]);
    expect(await p.refresh()).toBe(true);
    expect(p.dirs()).toEqual(["/a"]);
    expect(await p.refresh()).toBe(false);
    out = `${PATH_MARK}/a:/b\n`;
    expect(await p.refresh()).toBe(true);
    expect(p.dirs()).toEqual(["/a", "/b"]);
  });
});
