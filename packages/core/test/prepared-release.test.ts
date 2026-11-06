import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubApi, preparedRelease, publishPrepared } from "../../../scripts/prepared-release.mjs";

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "prepared-release-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  const version = (v: string, mismatch = false, dependency = false) => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: v, dependencies: { x: dependency ? "2" : "1" } }));
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ version: v, packages: { "": { version: mismatch ? "0.2.36" : v } } }));
  };
  const commit = () => { git("add", "."); git("commit", "-qm", "test"); return git("rev-parse", "HEAD"); };
  version("0.2.36"); const before = commit(); git("tag", "v0.2.36");
  return { cwd, git, version, commit, before };
}

describe("a version prepared through a PR", () => {
  it("pins the version to the checked event SHA even if HEAD has since advanced", () => {
    const r = repo(); r.version("0.2.37"); const sha = r.commit();
    writeFileSync(join(r.cwd, "later.txt"), "later"); r.commit();
    expect(preparedRelease({ ...r, sha })).toEqual({ tag: "v0.2.37", sha });
  });
  it("ignores code-only pushes", () => {
    const r = repo(); writeFileSync(join(r.cwd, "code.txt"), "code");
    expect(preparedRelease({ ...r, sha: r.commit() })).toBeUndefined();
  });
  it("honors a skip-release marker on a version push", () => {
    const r = repo(); r.version("0.2.37"); r.commit(); r.git("commit", "--allow-empty", "-qm", "[skip release]");
    expect(preparedRelease({ ...r, sha: r.git("rev-parse", "HEAD") })).toBeUndefined();
  });
  for (const v of ["0.2.38", "0.2.35", "0.3.1", "1.0.1", "1.1.0", "0.2.37-rc.1"]) it(`refuses an unexpected version ${v}`, () => {
    const r = repo(); r.version(v);
    expect(() => preparedRelease({ ...r, sha: r.commit() })).toThrow();
  });
  for (const v of ["0.3.0", "1.0.0"]) it(`accepts a new line ${v} with the frozen docs of the one before it`, () => {
    const r = repo(); r.version(v);
    mkdirSync(join(r.cwd, "docs/versions/0.2/en"), { recursive: true });
    writeFileSync(join(r.cwd, "docs/versions/0.2/en/updates.md"), "frozen");
    const sha = r.commit();
    expect(preparedRelease({ ...r, sha })).toEqual({ tag: `v${v}`, sha });
  });
  it("refuses frozen docs in a patch release, and another line's docs in a new one", () => {
    const r = repo(); r.version("0.2.37");
    mkdirSync(join(r.cwd, "docs/versions/0.2"), { recursive: true }); writeFileSync(join(r.cwd, "docs/versions/0.2/x.md"), "x");
    expect(() => preparedRelease({ ...r, sha: r.commit() })).toThrow(/only the version files/);
    const n = repo(); n.version("0.3.0");
    mkdirSync(join(n.cwd, "docs/versions/0.1"), { recursive: true }); writeFileSync(join(n.cwd, "docs/versions/0.1/x.md"), "x");
    expect(() => preparedRelease({ ...n, sha: n.commit() })).toThrow(/only the version files/);
  });
  it("refuses mixed code/version pushes and inconsistent lockfiles", () => {
    const r = repo(); r.version("0.2.37", true);
    expect(() => preparedRelease({ ...r, sha: r.commit() })).toThrow(/versions must agree/);
    r.version("0.2.37"); writeFileSync(join(r.cwd, "code.txt"), "code");
    expect(() => preparedRelease({ ...r, sha: r.commit() })).toThrow(/only the version files/);
  });
  it("refuses dependency changes hidden in the version files", () => {
    const r = repo(); r.version("0.2.37", false, true);
    expect(() => preparedRelease({ ...r, sha: r.commit() })).toThrow(/Only the three root version values/);
  });
  it("requires the previous release tag and an ancestor before SHA", () => {
    const r = repo(); r.version("0.2.37"); const sha = r.commit(); r.git("tag", "-d", "v0.2.36");
    expect(() => preparedRelease({ ...r, sha })).toThrow();
    expect(() => preparedRelease({ ...r, before: "0".repeat(40), sha })).toThrow(/SHAs/);
  });
});

const plan = { tag: "v0.2.37", sha: "a".repeat(40) };
function service({ existing = false, target = plan.sha, race = false, denied = false, published = false, runs = [] as any[] } = {}) {
  let ref: any = existing ? { object: { type: "commit", sha: target } } : undefined;
  const writes: any[] = [];
  const api = async (path: string, options: any = {}) => {
    if (options.method === "POST") {
      writes.push({ path, body: options.body });
      if (path === "git/refs") {
        if (denied) throw Object.assign(new Error("denied"), { status: 403 });
        ref = { object: { type: "commit", sha: target } };
        if (race) throw Object.assign(new Error("exists"), { status: 422 });
      }
      return;
    }
    if (path.startsWith("git/ref/")) return ref;
    if (path.startsWith("releases/")) return published ? { draft: false } : undefined;
    return { workflow_runs: runs };
  };
  return { api, writes };
}

describe("tag creation and explicit release dispatch", () => {
  it("creates only the tag, then explicitly dispatches release.yml at that tag", async () => {
    const s = service(); expect(await publishPrepared(plan, s.api)).toBe("dispatched");
    expect(s.writes).toEqual([
      { path: "git/refs", body: { ref: "refs/tags/v0.2.37", sha: plan.sha } },
      { path: "actions/workflows/release.yml/dispatches", body: { ref: plan.tag } },
    ]);
  });
  it("accepts a concurrent creator of the exact same tag, rejects a different target", async () => {
    expect(await publishPrepared(plan, service({ race: true }).api)).toBe("dispatched");
    const wrong = service({ race: true, target: "b".repeat(40) });
    await expect(publishPrepared(plan, wrong.api)).rejects.toThrow(/refusing to move/);
    expect(wrong.writes).toHaveLength(1);
  });
  it("never moves an existing tag or retries a denied write", async () => {
    const wrong = service({ existing: true, target: "b".repeat(40) });
    await expect(publishPrepared(plan, wrong.api)).rejects.toThrow(/refusing to move/); expect(wrong.writes).toHaveLength(0);
    const denied = service({ denied: true });
    await expect(publishPrepared(plan, denied.api)).rejects.toThrow("denied"); expect(denied.writes).toHaveLength(1);
  });
  it("is a no-op for published releases, running builds and successful builds", async () => {
    const published = service({ existing: true, published: true });
    expect(await publishPrepared(plan, published.api)).toBe("already published"); expect(published.writes).toHaveLength(0);
    for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "success"]]) {
      const s = service({ existing: true, runs: [{ head_sha: plan.sha, head_branch: plan.tag, status, conclusion }] });
      expect(await publishPrepared(plan, s.api)).toBe("already dispatched"); expect(s.writes).toHaveLength(0);
    }
  });
  it("requires retrying a failed run instead of dispatching a second one", async () => {
    const s = service({ existing: true, runs: [{ id: 12, head_sha: plan.sha, head_branch: plan.tag, status: "completed", conclusion: "failure" }] });
    await expect(publishPrepared(plan, s.api)).rejects.toThrow(/run 12 failed/); expect(s.writes).toHaveLength(0);
  });
  it("fails closed when listing runs is denied", async () => {
    const s = service({ existing: true });
    const api = async (path: string, options: any) => { if (path.startsWith("actions/")) throw new Error("denied"); return s.api(path, options); };
    await expect(publishPrepared(plan, api)).rejects.toThrow("denied"); expect(s.writes).toHaveLength(0);
  });
  it("treats only an explicit 404 as absence, and does not leak the workflow token in an error", async () => {
    const api = githubApi("legostin/piomio", "private-token", async () => new Response("", { status: 403 }));
    await expect(api("git/ref/tags/v0.2.37", { optional: true })).rejects.toThrow(/HTTP 403/);
    await expect(api("git/ref/tags/v0.2.37")).rejects.not.toThrow(/private-token/);
    expect(await githubApi("legostin/piomio", "private-token", async () => new Response("", { status: 404 }))("git/ref/tags/v0.2.37", { optional: true })).toBeUndefined();
  });
});
