// Publish only a verified, existing tag. A retry never overwrites published assets.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { githubApi } from "./release-tag.mjs";
import { parseVersion } from "./release-version.mjs";

export function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export async function publicationPlan(version, api) {
  parseVersion(version);
  const existing = await api(`releases/tags/v${version}`, { optional: true });
  if (existing && !existing.draft) return { publish: false };
  if (existing) throw new Error("An existing draft needs inspection; refusing to overwrite it");
  const latest = await api("releases/latest", { optional: true });
  return { publish: true, latest: !latest || isNewer(version, latest.tag_name.replace(/^v/, "")) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.env.RELEASE_VERSION;
  const tag = `v${version}`;
  if (process.env.GITHUB_REF !== `refs/tags/${tag}`) throw new Error("Publishing requires the version tag");
  const api = githubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  const plan = await publicationPlan(version, api);
  if (plan.publish) {
    const { readdirSync } = await import("node:fs");
    execFileSync("gh", ["release", "create", tag, ...readdirSync("dist").map((f) => `dist/${f}`), "--repo", process.env.GITHUB_REPOSITORY, "--verify-tag", "--title", `Piomio ${version}`, "--generate-notes", `--latest=${plan.latest}`], { stdio: "inherit" });
  } else console.log(`${tag} is already published; leaving it intact`);
}
