import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparedRelease } from "../../../scripts/prepared-release.mjs";
import { BOT, due, openVersionPr, targetVersion, writeVersion } from "../../../scripts/version-pr.mjs";

const REPO = "legostin/piomio";

/** main at 0.2.38, tagged, with a bare origin like the checkout in release-on-push.yml. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "version-pr-"));
  const cwd = join(root, "main");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", join(root, "origin.git")]);
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false"); git("remote", "add", "origin", join(root, "origin.git"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "piomio", version: "0.2.38", private: true }, null, 2) + "\n");
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ name: "piomio", version: "0.2.38", lockfileVersion: 3, packages: { "": { name: "piomio", version: "0.2.38" }, "node_modules/x": { version: "1.0.0" } } }, null, 2) + "\n");
  mkdirSync(join(cwd, "docs/guide/en"), { recursive: true });
  writeFileSync(join(cwd, "docs/guide/nav.json"), "[]\n");
  writeFileSync(join(cwd, "docs/guide/README.md"), "how to write the docs\n");
  writeFileSync(join(cwd, "docs/guide/en/updates.md"), "# Updates\n");
  const commit = (message: string, file?: string) => {
    if (file) { mkdirSync(join(cwd, file, ".."), { recursive: true }); writeFileSync(join(cwd, file), message); }
    git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD");
  };
  const released = commit("Piomio 0.2.38");
  git("tag", "v0.2.38");
  const feature = commit("feat: something that ships", "packages/core/src/feature.ts");
  const publish = () => { git("push", "-q", "origin", "main", "--tags"); git("fetch", "-q", "origin"); };
  publish();
  return { root, cwd, git, commit, released, feature, publish };
}

/** GitHub's REST API as far as version-pr.mjs uses it. */
function github(pulls: any[] = [], closed: any[] = []) {
  const writes: { method: string; path: string; body?: any }[] = [];
  let next = 100;
  const api = async (path: string, { method = "GET", body }: any = {}) => {
    if (method === "GET") return path.startsWith("pulls?state=closed") ? closed : pulls;
    writes.push({ method, path, ...(body ? { body } : {}) });
    if (method === "POST" && path === "pulls") return { number: next, html_url: `https://github.com/${REPO}/pull/${next++}`, ...body };
    if (method === "PATCH" && path.startsWith("pulls/")) return { number: Number(path.split("/")[1]), html_url: `https://github.com/${REPO}/${path}`, ...body };
  };
  return { api, writes };
}
const botPr = (number: number, version: string) => ({ number, html_url: `https://github.com/${REPO}/pull/${number}`, user: { login: BOT.name }, head: { ref: `release/${version}`, repo: { full_name: REPO } } });
const quiet = () => {};

describe("the version a version PR raises main to", () => {
  it("is the next patch on a push, or the step asked for by hand", () => {
    expect(targetVersion({ current: "0.2.38" })).toBe("0.2.39");
    expect(targetVersion({ current: "0.2.38", bump: "minor" })).toBe("0.3.0");
    expect(targetVersion({ current: "0.2.38", bump: "major" })).toBe("1.0.0");
  });
  it("keeps an open PR's own version on later pushes (a minor one asked for by hand), but not a stale one", () => {
    expect(targetVersion({ current: "0.2.38", open: ["release/0.3.0"] })).toBe("0.3.0");
    expect(targetVersion({ current: "0.2.38", open: ["release/0.2.38", "release/0.2.41"] })).toBe("0.2.39");
    expect(targetVersion({ current: "0.2.38", bump: "patch", open: ["release/0.3.0"] })).toBe("0.2.39");
  });
});

describe("the version files a version PR changes", () => {
  it("raise the three root versions, which a prepared release then accepts", () => {
    const r = repo();
    expect(writeVersion(r.cwd, "0.2.39")).toEqual(["package.json", "package-lock.json"]);
    const lock = JSON.parse(readFileSync(join(r.cwd, "package-lock.json"), "utf8"));
    expect([lock.version, lock.packages[""].version, lock.packages["node_modules/x"].version]).toEqual(["0.2.39", "0.2.39", "1.0.0"]);
    expect(readFileSync(join(r.cwd, "package.json"), "utf8")).toMatch(/^\{\n {2}"name": "piomio",\n {2}"version": "0.2.39"[\s\S]*\}\n$/);
    const sha = r.commit("Piomio 0.2.39");
    expect(preparedRelease({ cwd: r.cwd, before: r.feature, sha })).toEqual({ tag: "v0.2.39", sha });
  });
  it("for a new line also freeze the docs of the line before it, which a prepared release then accepts", () => {
    const r = repo();
    expect(writeVersion(r.cwd, "0.3.0")).toEqual(["package.json", "package-lock.json", "docs/versions/0.2"]);
    expect(readFileSync(join(r.cwd, "docs/versions/0.2/en/updates.md"), "utf8")).toBe("# Updates\n");
    expect(JSON.parse(readFileSync(join(r.cwd, "docs/versions/0.2/release.json"), "utf8"))).toEqual({ release: "0.2.38" });
    expect(existsSync(join(r.cwd, "docs/versions/0.2/README.md"))).toBe(false);
    const sha = r.commit("Piomio 0.3.0");
    expect(preparedRelease({ cwd: r.cwd, before: r.feature, sha })).toEqual({ tag: "v0.3.0", sha });
  });
});

describe("whether a push still needs a version PR", () => {
  it("not when its version's tag holds it, or a version PR merged after it does", () => {
    const r = repo();
    expect(due({ cwd: r.cwd, event: "push", sha: r.released }).due).toBe(false);
    expect(due({ cwd: r.cwd, event: "push", sha: r.feature }).due).toBe(true);
    writeVersion(r.cwd, "0.2.39"); r.commit("Merge pull request #20 from legostin/release/0.2.39");
    expect(due({ cwd: r.cwd, event: "push", sha: r.feature })).toMatchObject({ due: false, reason: expect.stringMatching(/prepared v0.2.39/) });
    const after = r.commit("fix: after the version PR", "packages/core/src/after.ts");
    expect(due({ cwd: r.cwd, event: "push", sha: after }).due).toBe(true);
    expect(due({ cwd: r.cwd, event: "workflow_dispatch", sha: r.released }).due).toBe(true);
  });
});

describe("opening the version PR", () => {
  it("pushes one version commit on top of main to release/X.Y.Z, opens the PR and starts its checks", async () => {
    const r = repo(); const gh = github();
    const pr = await openVersionPr({ cwd: r.cwd, repo: REPO, api: gh.api, checkedIn: "https://example.invalid/run/1", log: quiet });
    expect(pr).toMatchObject({ version: "0.2.39", number: 100 });
    r.git("fetch", "-q", "origin");
    expect(r.git("rev-parse", "origin/release/0.2.39^")).toBe(r.feature);
    expect(r.git("log", "-1", "--format=%s|%ae", "origin/release/0.2.39")).toBe(`Piomio 0.2.39|${BOT.email}`);
    expect(r.git("diff", "--name-only", r.feature, "origin/release/0.2.39").split("\n")).toEqual(["package-lock.json", "package.json"]);
    expect(r.git("rev-parse", "origin/main")).toBe(r.feature);
    const [create, dispatch] = gh.writes;
    expect(create).toMatchObject({ method: "POST", path: "pulls", body: { title: "Piomio 0.2.39", head: "release/0.2.39", base: "main" } });
    expect(create.body.body).toContain("Changes since v0.2.38:");
    expect(create.body.body).toContain("feat: something that ships");
    expect(create.body.body).not.toContain("Piomio 0.2.38\n");
    expect(dispatch).toEqual({ method: "POST", path: "actions/workflows/checks.yml/dispatches", body: { ref: "release/0.2.39" } });
    expect(gh.writes).toHaveLength(2);
  });

  it("rebuilds an open PR on a newer main, and leaves one already built on this main alone", async () => {
    const r = repo();
    await openVersionPr({ cwd: r.cwd, repo: REPO, api: github().api, log: quiet });
    r.git("switch", "-q", "main");
    const newer = r.commit("fix: lands while the PR is open", "packages/core/src/newer.ts"); r.publish();
    const rebuilt = github([botPr(7, "0.2.39")]);
    expect(await openVersionPr({ cwd: r.cwd, repo: REPO, api: rebuilt.api, log: quiet })).toMatchObject({ version: "0.2.39", number: 7 });
    expect(rebuilt.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH pulls/7", "POST actions/workflows/checks.yml/dispatches"]);
    r.git("fetch", "-q", "origin");
    expect(r.git("rev-parse", "origin/release/0.2.39^")).toBe(newer);
    r.git("switch", "-q", "main");
    const same = github([botPr(7, "0.2.39")]);
    expect(await openVersionPr({ cwd: r.cwd, repo: REPO, api: same.api, log: quiet })).toMatchObject({ current: true });
    expect(same.writes).toEqual([]);
  });

  it("replaces an open patch PR with a minor one asked for by hand, then keeps the minor one on pushes", async () => {
    const r = repo(); const gh = github([botPr(7, "0.2.39")]);
    expect(await openVersionPr({ cwd: r.cwd, repo: REPO, api: gh.api, bump: "minor", log: quiet })).toMatchObject({ version: "0.3.0", number: 100 });
    expect(gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST pulls", "POST issues/7/comments", "PATCH pulls/7", "DELETE git/refs/heads/release/0.2.39", "POST actions/workflows/checks.yml/dispatches",
    ]);
    expect(gh.writes[2].body).toEqual({ state: "closed" });
    r.git("fetch", "-q", "origin");
    expect(r.git("diff", "--name-only", r.feature, "origin/release/0.3.0")).toContain("docs/versions/0.2/release.json");
    r.git("switch", "-q", "main");
    r.commit("fix: lands while the minor PR is open", "packages/core/src/minor.ts"); r.publish();
    expect(await openVersionPr({ cwd: r.cwd, repo: REPO, api: github([botPr(100, "0.3.0")]).api, log: quiet })).toMatchObject({ version: "0.3.0" });
  });

  it("leaves a version PR someone opened by hand to them, and tidies the merged branch it made", async () => {
    const r = repo();
    const theirs = github([{ ...botPr(9, "0.2.39"), user: { login: "legostin" } }]);
    expect(await openVersionPr({ cwd: r.cwd, repo: REPO, api: theirs.api, log: quiet })).toMatchObject({ number: 9, theirs: true });
    expect(theirs.writes).toEqual([]);
    r.git("fetch", "-q", "origin");
    expect(() => r.git("rev-parse", "--verify", "-q", "origin/release/0.2.39")).toThrow();
    const merged = github([], [{ ...botPr(5, "0.2.38"), merged_at: "2026-11-05T00:00:00Z" }]);
    await openVersionPr({ cwd: r.cwd, repo: REPO, api: merged.api, log: quiet });
    expect(merged.writes.map((w) => `${w.method} ${w.path}`)).toContain("DELETE git/refs/heads/release/0.2.38");
    const human = github([], [{ ...botPr(5, "0.2.38"), merged_at: "2026-11-05T00:00:00Z", user: { login: "legostin" } }]);
    r.git("switch", "-q", "main"); r.commit("fix: one more", "packages/core/src/more.ts"); r.publish();
    await openVersionPr({ cwd: r.cwd, repo: REPO, api: human.api, log: quiet });
    expect(human.writes.map((w) => w.path)).not.toContain("git/refs/heads/release/0.2.38");
  });
});
