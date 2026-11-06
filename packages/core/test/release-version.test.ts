import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stampVersion } from "../../../scripts/release-version.mjs";
import { buildVersion } from "../../../scripts/release-build.mjs";
import { publicationPlan, verifyReleaseTag } from "../../../scripts/release-publish.mjs";

const root = resolve(import.meta.dirname, "../../..");
const files = ["package.json", "package-lock.json", "packages/desktop/src-tauri/tauri.conf.json", "packages/desktop/src-tauri/Cargo.toml", "packages/desktop/src-tauri/Cargo.lock"];
function checkout() {
  const cwd = mkdtempSync(join(tmpdir(), "release-stamp-"));
  for (const file of files) { mkdirSync(dirname(join(cwd, file)), { recursive: true }); copyFileSync(join(root, file), join(cwd, file)); }
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source");
  return { cwd, git, sha: git("rev-parse", "HEAD") };
}

describe("release versions in disposable checkouts", () => {
  it("stamps npm, Tauri and Cargo without changing refs or dependency versions", () => {
    const r = checkout(); const before = r.git("show", "HEAD:packages/desktop/src-tauri/Cargo.lock");
    expect(stampVersion("0.2.39", r.cwd)).toEqual(files);
    const json = (file: string) => JSON.parse(readFileSync(join(r.cwd, file), "utf8"));
    expect(json("package.json").version).toBe("0.2.39");
    expect(json("package-lock.json").version).toBe("0.2.39");
    expect(json("package-lock.json").packages[""].version).toBe("0.2.39");
    expect(json("packages/desktop/src-tauri/tauri.conf.json").version).toBe("0.2.39");
    const cargo = readFileSync(join(r.cwd, files[4]!), "utf8");
    expect(cargo.trim()).toBe(before.replace(/(name = "piomio"\nversion = )"[^"]+"/, '$1"0.2.39"'));
    expect(readFileSync(join(r.cwd, files[3]!), "utf8")).toMatch(/\[package\][\s\S]*?version = "0.2.39"/);
    expect(r.git("rev-parse", "HEAD")).toBe(r.sha);
    expect(r.git("tag", "--list")).toBe("");
    expect(stampVersion("0.2.39", r.cwd)).toEqual(files);
  });

  it("rejects invalid versions or broken manifests before any write", () => {
    const r = checkout();
    for (const v of ["v0.2.39", "0.2.39\nrelease=true", "01.2.3", "0.2.39-rc.1"]) expect(() => stampVersion(v, r.cwd)).toThrow();
    expect(r.git("status", "--porcelain")).toBe("");
    writeFileSync(join(r.cwd, files[4]!), "bad lock");
    const previous = readFileSync(join(r.cwd, "package.json"), "utf8");
    expect(() => stampVersion("9.8.7", r.cwd)).toThrow(/lock package missing/);
    expect(readFileSync(join(r.cwd, "package.json"), "utf8")).toBe(previous);
  });

  it("uses the tag even when package.json differs and refuses branch publication", () => {
    const r = checkout(); r.git("tag", "v0.2.39"); r.git("update-ref", "refs/remotes/origin/main", r.sha);
    expect(buildVersion({ ...r, ref: "refs/tags/v0.2.39", dryRun: false })).toEqual({ version: "0.2.39", publish: true });
    expect(buildVersion({ ...r, ref: "refs/tags/v0.2.39", dryRun: true }).publish).toBe(false);
    expect(buildVersion({ ...r, ref: "refs/heads/preview", dryRun: true }).publish).toBe(false);
    expect(() => buildVersion({ ...r, ref: "refs/heads/main", dryRun: false })).toThrow(/requires a stable version tag/);
    expect(() => buildVersion({ ...r, sha: "a".repeat(40), ref: "refs/tags/v0.2.39", dryRun: false })).toThrow(/exact tagged commit/);
  });
});

describe("publication retries and latest ordering", () => {
  const api = (existing: any, latest = "v0.2.38") => async (path: string) => path === "releases/latest" ? { tag_name: latest } : existing;
  it("publishes a newer tag as latest, but cannot roll latest backwards", async () => {
    expect(await publicationPlan("0.2.39", api(undefined))).toEqual({ publish: true, latest: true });
    expect(await publicationPlan("0.2.39", api(undefined, "v0.2.40"))).toEqual({ publish: true, latest: false });
  });
  it("does not overwrite a published release or an unexplained draft", async () => {
    expect(await publicationPlan("0.2.39", api({ draft: false }))).toEqual({ publish: false });
    await expect(publicationPlan("0.2.39", api({ draft: true }))).rejects.toThrow(/inspection/);
  });
  it("rechecks the tag target after building, including annotated tags", async () => {
    const sha = "a".repeat(40);
    await expect(verifyReleaseTag("0.2.39", sha, async () => ({ object: { type: "commit", sha } }))).resolves.toBeUndefined();
    await expect(verifyReleaseTag("0.2.39", sha, async (path: string) => ({ object: path.startsWith("git/ref/") ? { type: "tag", sha: "b".repeat(40) } : { type: "commit", sha } }))).resolves.toBeUndefined();
    await expect(verifyReleaseTag("0.2.39", sha, async () => ({ object: { type: "commit", sha: "c".repeat(40) } }))).rejects.toThrow(/changed during the build/);
  });
});
