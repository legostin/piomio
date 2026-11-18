import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePolicy, type Policy } from "../src/policy.ts";
import { spawnSync } from "node:child_process";
import { ExecDenied, checkCommand, checkEnv, execRun, gitAskpass } from "../src/exec.ts";
import { PathDenied } from "../src/guard.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "obn-exec-")));
const allowed = join(root, "allowed");
const outside = join(root, "outside");
mkdirSync(allowed, { recursive: true });
mkdirSync(outside, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = (exec: Record<string, unknown>): Policy => normalizePolicy({ allowedDirs: [allowed], exec }, root);
const node = `"${process.execPath}"`;
/** `node -e <script>` as a shell command; the script must not contain double quotes. */
const nodeCmd = (script: string) => `${node} -e "${script}"`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("exec policy", () => {
  it("is refused while exec is disabled", async () => {
    await expect(execRun({ command: nodeCmd("1") }, policy({ enabled: false }), {})).rejects.toThrow(/exec.enabled = false/);
    await expect(execRun({ command: nodeCmd("1") }, normalizePolicy({ allowedDirs: [allowed] }, root), {})).rejects.toBeInstanceOf(ExecDenied);
  });

  it("checks the allowlist and refuses shell chaining when one is set", () => {
    const p = policy({ enabled: true, allowCommands: ["git status", "npm test*"] });
    expect(checkCommand("git status", p)).toBe("git status");
    expect(checkCommand("npm test -- --run", p)).toBe("npm test -- --run");
    expect(() => checkCommand("rm -rf /", p)).toThrow(/allowCommands/);
    expect(() => checkCommand("git status; rm -rf /", p)).toThrow(/are not allowed/);
    expect(() => checkCommand("git status && whoami", p)).toThrow(ExecDenied);
    expect(() => checkCommand("npm test $(whoami)", p)).toThrow(ExecDenied);
    expect(() => checkCommand("npm test\nwhoami", p)).toThrow(ExecDenied);
    expect(() => checkCommand("", p)).toThrow(/No command/);
    // No allowlist: any command, chaining included.
    expect(checkCommand("echo a && echo b", policy({ enabled: true }))).toBe("echo a && echo b");
  });

  it("keeps cwd inside the allowed dirs", async () => {
    const p = policy({ enabled: true });
    await expect(execRun({ command: nodeCmd("1"), cwd: outside }, p, {})).rejects.toBeInstanceOf(PathDenied);
    await expect(execRun({ command: nodeCmd("1"), cwd: join(allowed, "nope") }, p, {})).rejects.toThrow(/does not exist/);
  });
});

describe("exec.run", () => {
  const p = policy({ enabled: true });

  it("runs a command in the first allowed dir by default and returns code/stdout/stderr", async () => {
    const r = await execRun({ command: nodeCmd("console.log(process.cwd()); console.error('warn'); console.log('привет')"), timeoutMs: 20_000 }, p, {});
    expect(r.code).toBe(0);
    expect(r.stdout.split(/\r?\n/)[0].toLowerCase()).toBe(allowed.toLowerCase());
    expect(r.stdout).toContain("привет");
    expect(r.stderr.trim()).toBe("warn");
  });

  it("reports non-zero exit codes", async () => {
    const r = await execRun({ command: nodeCmd("process.exit(3)") }, p, {});
    expect(r.code).toBe(3);
  });

  it("caps output at 1 MB", async () => {
    const r = await execRun({ command: nodeCmd("process.stdout.write('x'.repeat(3*1024*1024))") }, p, {});
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(1024 * 1024);
    expect(r.stderr).toContain("truncated");
  });

  it("enforces the timeout and kills the whole process tree", async () => {
    const pidFile = join(allowed, "grandchild.pid");
    const grandchild = "setInterval(()=>{},1000)";
    const script =
      `const c=require('child_process').spawn(process.execPath,['-e','${grandchild}'],{stdio:'ignore'});` +
      `require('fs').writeFileSync('grandchild.pid',String(c.pid));setInterval(()=>{},1000)`;
    const started = Date.now();
    const r = await execRun({ command: nodeCmd(script), timeoutMs: 1500 }, p, {});
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it("caps the timeout with exec.maxTimeoutMs", async () => {
    const started = Date.now();
    const r = await execRun({ command: nodeCmd("setInterval(()=>{},1000)"), timeoutMs: 600_000 }, policy({ enabled: true, maxTimeoutMs: 1000 }), {});
    expect(r.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("a command's variables (secrets from the hub's vault)", () => {
  const p = policy({ enabled: true });
  const posix = process.platform !== "win32";
  const hasGit = posix && spawnSync("git", ["--version"]).status === 0;

  it("gives the command the variables on top of this machine's own", async () => {
    const r = await execRun({ command: nodeCmd("process.stdout.write(process.env.DEPLOY_TOKEN+' '+process.env.HOST_NAME+' '+!!process.env.PATH)"), env: { DEPLOY_TOKEN: "s3cret-value", HOST_NAME: "ghe.example.com" } }, p, {});
    expect(r).toMatchObject({ code: 0, stdout: "s3cret-value ghe.example.com true" });
    // Without env, nothing of an earlier command's is left.
    expect((await execRun({ command: nodeCmd("process.stdout.write(String(process.env.DEPLOY_TOKEN))") }, p, {})).stdout).toBe("undefined");
  });

  it("refuses variables that are not names and values", async () => {
    expect(checkEnv(undefined)).toEqual({});
    expect(checkEnv({ A_1: "x" })).toEqual({ A_1: "x" });
    for (const env of [[], "A=1", { "A B": "x" }, { "1A": "x" }, { PIOMIO_HOME: "x" }, { piomio_home: "x" }, { A: 1 }, { A: "x\0y" }, { A: "x".repeat(70_000) }, Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`V${n}`, "x"]))]) {
      expect(() => checkEnv(env), JSON.stringify(env).slice(0, 60)).toThrow(ExecDenied);
    }
    await expect(execRun({ command: nodeCmd("1"), env: { "A B": "x" } }, p, {})).rejects.toBeInstanceOf(ExecDenied);
  });

  it("leaves git alone without GIT_PASSWORD, on Windows, or when the command names its own helper", () => {
    expect(gitAskpass({ GH_TOKEN: "x" }).env).toEqual({});
    expect(gitAskpass({ GIT_PASSWORD: "x", GIT_ASKPASS: "/bin/true" }).env).toEqual({});
  });

  it.skipIf(!posix)("writes a helper for one command and removes it afterwards", () => {
    const a = gitAskpass({ GIT_PASSWORD: "x" }, { GIT_CONFIG_COUNT: "2" });
    try {
      expect(existsSync(a.env.GIT_ASKPASS)).toBe(true);
      // After the entries already in the environment: an empty helper empties the list of the person's own.
      expect(a.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "credential.helper", GIT_CONFIG_VALUE_2: "" });
      const ask = (prompt: string, env: Record<string, string>) => spawnSync(a.env.GIT_ASKPASS, [prompt], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }).stdout;
      expect(ask("Username for 'https://ghe.example.com': ", { GIT_PASSWORD: "pw" })).toBe("x-access-token\n");
      expect(ask("Username for 'https://ghe.example.com': ", { GIT_PASSWORD: "pw", GIT_USERNAME: "anna" })).toBe("anna\n");
      expect(ask("Password for 'https://anna@ghe.example.com': ", { GIT_PASSWORD: "p w$1" })).toBe("p w$1\n");
    } finally {
      a.cleanup();
    }
    expect(existsSync(a.env.GIT_ASKPASS)).toBe(false);
  });

  it.skipIf(!hasGit)("git signs in over HTTPS with GIT_PASSWORD, past the person's own credential helpers", async () => {
    // What git would send to the server, without a server: `git credential fill` asks the same helpers a push does.
    const home = join(root, "git-home");
    mkdirSync(home, { recursive: true });
    // The person's own helper, as their ~/.gitconfig has it (the keychain's, gh's).
    writeFileSync(join(home, ".gitconfig"), '[credential]\n\thelper = "!echo password=from-the-keychain; echo username=keychain-user;:"\n');
    const command = "printf 'protocol=https\\nhost=ghe.example.com\\n\\n' | git credential fill";
    const own = await execRun({ command, env: { HOME: home, GIT_CONFIG_NOSYSTEM: "1" } }, p, {});
    expect(own.stdout).toContain("password=from-the-keychain");
    const r = await execRun({ command, env: { GIT_PASSWORD: "ghp_token_from_the_vault", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } }, p, {});
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("username=x-access-token");
    expect(r.stdout).toContain("password=ghp_token_from_the_vault");
    expect(r.stdout).not.toContain("keychain");
    const named = await execRun({ command, env: { GIT_PASSWORD: "ghp_token_from_the_vault", GIT_USERNAME: "anna", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } }, p, {});
    expect(named.stdout).toContain("username=anna");
  });
});
