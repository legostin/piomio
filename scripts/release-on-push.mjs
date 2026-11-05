// Plan against immutable release tags and the checked event commit, never package.json or a moving main.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseVersion } from "./release-version.mjs";
import { githubApi, publishTagRelease } from "./release-tag.mjs";

export function ships(file) {
  if (!file) return false;
  if (/^(packages\/(site|testkit)\/|docs\/)/.test(file)) return false;
  if ([".github/workflows/site.yml", ".github/workflows/release-on-push.yml", ".github/workflows/checks.yml", "scripts/release-on-push.mjs", "scripts/release-tag.mjs"].includes(file)) return false;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith(".github/") || /\/test\/|\.test\.tsx?$/.test(file)) return false;
  return file.includes("/") || (!file.endsWith(".md") && file !== "LICENSE");
}

export function releaseDecision({ before, sha, bump = "patch", manual = false, cwd = process.cwd() }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected the checked commit SHA");
  if (!["patch", "minor", "major"].includes(bump)) throw new Error("Invalid version bump");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const ancestor = (a, b) => {
    try { git("merge-base", "--is-ancestor", a, b); return true; }
    catch (e) { if (e.status === 1) return false; throw e; }
  };
  const tags = git("tag", "--list", "v*", "--sort=-version:refname").split("\n").filter((t) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(t));
  const last = tags[0];
  if (!last) throw new Error("No stable release tag; refusing to guess a starting version");
  const version = last.slice(1);
  const parts = parseVersion(version);
  const target = git("rev-parse", "--verify", `${last}^{commit}`);
  git("rev-parse", "--verify", `${sha}^{commit}`);
  // A retry after tag creation resumes dispatch for the SAME tag, not the next version.
  if (target === sha) return { release: true, tag: last, version, sha, reason: `resume ${last} on this commit` };
  if (ancestor(sha, target)) return { release: false, reason: `${last} already contains this commit` };
  if (!ancestor(target, sha)) throw new Error(`${last} is not an ancestor of the checked commit`);
  const base = !before || /^0+$/.test(before) ? target : before;
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Expected a complete before SHA");
  if (!ancestor(base, sha)) throw new Error("Before SHA is not an ancestor of the checked commit");
  const messages = git("log", "--format=%B", `${base}..${sha}`);
  if (!manual && /\[skip release\]/i.test(messages)) return { release: false, reason: "[skip release] defers this push; checks still run" };
  const file = git("diff", "--name-only", target, sha).split("\n").find(ships);
  if (!manual && !file) return { release: false, reason: "nothing that ships changed" };
  if (bump !== "patch") {
    // Freeze docs through a reviewed PR, not a workflow-authored commit on protected main.
    const archive = `docs/versions/${parts.slice(0, 2).join(".")}`;
    const metadata = JSON.parse(git("show", `${sha}:${archive}/release.json`));
    if (metadata.release !== version) throw new Error(`Archive ${last}'s docs in ${archive} before changing release lines`);
    git("cat-file", "-e", `${sha}:${archive}/nav.json`);
  }
  const [major, minor, patch] = parts;
  const next = { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[bump];
  parseVersion(next);
  return { release: true, tag: `v${next}`, version: next, sha, reason: manual ? `manual ${bump} after ${last}` : `ships since ${last}: ${file}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const publish = process.argv.includes("--publish");
  const plan = releaseDecision({ before: process.env.BEFORE, sha: process.env.GITHUB_SHA, bump: process.env.BUMP || "patch", manual: process.env.MANUAL === "true" });
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, ["release", "tag", "version", "sha"].filter((k) => plan[k] !== undefined).map((k) => `${k}=${plan[k]}\n`).join(""));
  if (publish) {
    if (process.env.GITHUB_REF !== "refs/heads/main" || !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)) throw new Error("Only a checked main run may create a release tag");
    if (plan.release) console.log(await publishTagRelease(plan, githubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN)));
  }
}
