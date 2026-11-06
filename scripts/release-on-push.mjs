// Release policy for main. CI always runs; [skip release] defers the WHOLE push if any of its commits asks for it.
// Compare shipped files with the current release tag, not BEFORE: earlier deferred work must not disappear.
// A release is a version PR (version-pr.mjs) the owner merges; its merge is tagged by prepared-release.mjs.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function ships(file) {
  if (!file) return false;
  if (/^(packages\/(site|testkit)\/|docs\/)/.test(file)) return false;
  if ([".github/workflows/site.yml", ".github/workflows/release-on-push.yml", ".github/workflows/checks.yml"].includes(file)) return false;
  if (["scripts/release-on-push.mjs", "scripts/prepared-release.mjs", "scripts/version-pr.mjs"].includes(file)) return false;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith(".github/") || /\/test\/|\.test\.tsx?$/.test(file)) return false;
  return file.includes("/") || (!file.endsWith(".md") && file !== "LICENSE");
}

export function releaseDecision({ before, sha, cwd = process.cwd() }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const version = JSON.parse(readFileSync(`${cwd}/package.json`, "utf8")).version;
  const decide = (since, name) => {
    const base = /^0+$/.test(before) ? since : before;
    git("rev-parse", "--verify", `${base}^{commit}`);
    const messages = git("log", "--format=%B", `${base}..${sha}`);
    if (/\[skip release\]/i.test(messages)) return { release: false, reason: "[skip release] defers this push; checks still run" };
    const file = git("diff", "--name-only", since, sha).split("\n").find(ships);
    return { release: !!file, reason: file ? `ships since ${name}: ${file}` : "nothing that ships changed" };
  };
  let tag;
  try { tag = git("rev-parse", "--verify", `refs/tags/v${version}^{commit}`); }
  catch {
    // The version is new and its tag is on its way: this push raised it (prepared-release.mjs tags it), or it came
    // after a merged version PR whose tag is not made yet and releases its own changes in the next version.
    if (/^0+$/.test(before) || JSON.parse(git("show", `${before}:package.json`)).version !== version) {
      return { release: false, reason: `v${version} is this push's own release (not tagged yet)` };
    }
    return decide(before, `the prepared v${version}`);
  }
  if (tag === sha) return { release: false, reason: `v${version} is this push's own release` };
  // Refuse an incomplete history rather than silently miss a marker or release changes from an unrelated tag.
  git("merge-base", "--is-ancestor", tag, sha);
  return decide(tag, `v${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const decision = releaseDecision({ before: process.env.BEFORE, sha: process.env.GITHUB_SHA });
  console.log(decision.reason);
  appendFileSync(process.env.GITHUB_OUTPUT, `release=${decision.release}\n`);
}
