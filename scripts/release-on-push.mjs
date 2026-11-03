// Release policy for main. CI always runs; [skip release] defers the WHOLE push if any of its commits asks for it.
// Compare shipped files with the current release tag, not BEFORE: earlier deferred work must not disappear.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function ships(file) {
  if (!file) return false;
  if (/^(packages\/(site|testkit)\/|docs\/)/.test(file)) return false;
  if ([".github/workflows/site.yml", ".github/workflows/release-on-push.yml", ".github/workflows/checks.yml", "scripts/release-on-push.mjs"].includes(file)) return false;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith(".github/") || /\/test\/|\.test\.tsx?$/.test(file)) return false;
  return file.includes("/") || (!file.endsWith(".md") && file !== "LICENSE");
}

export function releaseDecision({ before, sha, cwd = process.cwd() }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const version = JSON.parse(readFileSync(`${cwd}/package.json`, "utf8")).version;
  let tag;
  try { tag = git("rev-parse", "--verify", `refs/tags/v${version}^{commit}`); }
  catch { return { release: false, reason: `v${version} is this push's own release (not tagged yet)` }; }
  if (tag === sha) return { release: false, reason: `v${version} is this push's own release` };
  // Refuse an incomplete history rather than silently miss a marker or release changes from an unrelated tag.
  git("merge-base", "--is-ancestor", tag, sha);
  const base = /^0+$/.test(before) ? tag : before;
  git("rev-parse", "--verify", `${base}^{commit}`);
  const messages = git("log", "--format=%B", `${base}..${sha}`);
  if (/\[skip release\]/i.test(messages)) return { release: false, reason: "[skip release] defers this push; checks still run" };
  const files = git("diff", "--name-only", tag, sha).split("\n");
  const file = files.find(ships);
  return { release: !!file, reason: file ? `ships since v${version}: ${file}` : "nothing that ships changed" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const decision = releaseDecision({ before: process.env.BEFORE, sha: process.env.GITHUB_SHA });
  console.log(decision.reason);
  appendFileSync(process.env.GITHUB_OUTPUT, `release=${decision.release}\n`);
}
