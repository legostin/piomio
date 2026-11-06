import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore: workflow helper is plain ESM.
import { releaseDecision, ships } from "../../../scripts/release-on-push.mjs";

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "release-policy-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (message: string, file = "docs/note.md") => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), message);
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "0.2.25" }));
  const released = commit("release");
  git("tag", "v0.2.25");
  return { cwd, git, commit, released };
}

describe("release on push", () => {
  it("defers a push with a marker in a non-HEAD commit, then includes its code in the next release", () => {
    const r = repo();
    r.commit("show version [skip release]", "packages/web/src/version.ts");
    const head = r.commit("fix test", "packages/core/test/example.test.ts");
    expect(releaseDecision({ cwd: r.cwd, before: r.released, sha: head }).release).toBe(false);
    const next = r.commit("documentation only");
    expect(releaseDecision({ cwd: r.cwd, before: head, sha: next }).release).toBe(true);
    r.git("tag", "-f", "v0.2.25", next);
    expect(releaseDecision({ cwd: r.cwd, before: head, sha: next }).release).toBe(false);
  });

  it("ignores tests, docs and release policy alone but releases shipped changes", () => {
    const r = repo();
    const docs = r.commit("docs");
    expect(releaseDecision({ cwd: r.cwd, before: r.released, sha: docs }).release).toBe(false);
    const code = r.commit("fix", "packages/core/src/fix.ts");
    expect(releaseDecision({ cwd: r.cwd, before: docs, sha: code }).release).toBe(true);
    expect(ships("scripts/release-on-push.mjs")).toBe(false);
    expect(ships("scripts/prepared-release.mjs")).toBe(false);
    expect(ships("scripts/version-pr.mjs")).toBe(false);
    expect(ships("scripts/new-integration.mjs")).toBe(true);
    expect(ships("packages/core/test/fix.test.ts")).toBe(false);
    expect(ships(".github/workflows/release.yml")).toBe(true);
    expect(ships("packages/web/src/demo/content.md")).toBe(true);
  });

  it("releases a push after a merged version PR whose tag is still on its way, but not that merge itself", () => {
    const r = repo();
    const feature = r.commit("feat", "packages/core/src/feature.ts");
    writeFileSync(join(r.cwd, "package.json"), JSON.stringify({ version: "0.2.26" }));
    r.git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qam", "Merge pull request #20 from legostin/release/0.2.26");
    const merge = r.git("rev-parse", "HEAD");
    expect(releaseDecision({ cwd: r.cwd, before: feature, sha: merge }).release).toBe(false);
    const docs = r.commit("docs after the version PR");
    expect(releaseDecision({ cwd: r.cwd, before: merge, sha: docs }).release).toBe(false);
    const fix = r.commit("fix after the version PR", "packages/core/src/fix.ts");
    expect(releaseDecision({ cwd: r.cwd, before: docs, sha: fix })).toMatchObject({ release: true, reason: expect.stringMatching(/prepared v0.2.26/) });
    const skipped = r.commit("fix [skip release]", "packages/core/src/skip.ts");
    expect(releaseDecision({ cwd: r.cwd, before: fix, sha: skipped }).release).toBe(false);
  });

  it("handles new-main pushes, manual version bumps and incomplete history", () => {
    const r = repo();
    const sha = r.commit("defer [SKIP RELEASE]", "packages/web/src/v.ts");
    expect(releaseDecision({ cwd: r.cwd, before: "0".repeat(40), sha }).release).toBe(false);
    expect(() => releaseDecision({ cwd: r.cwd, before: "f".repeat(40), sha })).toThrow();
    writeFileSync(join(r.cwd, "package.json"), JSON.stringify({ version: "0.2.26" }));
    expect(releaseDecision({ cwd: r.cwd, before: r.released, sha }).release).toBe(false);
  });
});
