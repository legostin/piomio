import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseVersion } from "./release-version.mjs";
import { releaseDecision } from "./release-on-push.mjs";

export function buildVersion({ ref, sha, dryRun, cwd = process.cwd() }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (ref.startsWith("refs/tags/v")) {
    const version = ref.slice("refs/tags/v".length);
    parseVersion(version);
    if (git("rev-parse", `${ref}^{commit}`) !== sha || git("rev-parse", "HEAD") !== sha) throw new Error("The build must check out the exact tagged commit");
    git("merge-base", "--is-ancestor", sha, "origin/main");
    return { version, publish: !dryRun };
  }
  if (!dryRun) throw new Error("Publishing requires a stable version tag; branch runs must be dry runs");
  const plan = releaseDecision({ sha, manual: true, cwd });
  if (!plan.version) throw new Error("This preview is behind a newer release; update the branch first");
  return { version: plan.version, publish: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildVersion({ ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, dryRun: process.env.DRY_RUN === "true" });
  console.log(JSON.stringify(result));
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\npublish=${result.publish}\n`);
}
