// main takes writes only from its owner (the repository ruleset), so Actions never commits a release's version there.
// It raises the version on top of main on the branch release/X.Y.Z instead, opens (or updates) the PR "Piomio X.Y.Z"
// and starts its checks. Merging that PR is the release: its push tags the merge and starts release.yml
// (prepared-release.mjs, which tags only a version-only merge).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { githubApi } from "./prepared-release.mjs";

export const BOT = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };
const VERSION_BRANCH = /^release\/(\d+\.\d+\.\d+)$/;

export function raise(version, bump) {
  const [major, minor, patch] = version.split(".").map(Number);
  const next = { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` }[bump];
  if (!next) throw new Error(`Unknown version step ${bump}`);
  return next;
}

const line = (v) => v.split(".").slice(0, 2).join(".");

/**
 * The version the PR raises main to: the step asked for by hand, or for a push the open version PR's own (a minor
 * version asked for by hand stays a minor one while later pushes go into it), else the next patch.
 */
export function targetVersion({ current, bump, open = [] }) {
  if (bump) return raise(current, bump);
  const steps = ["patch", "minor", "major"].map((s) => raise(current, s));
  return open.map((b) => VERSION_BRANCH.exec(b)?.[1]).find((v) => steps.includes(v)) ?? raise(current, "patch");
}

const gitIn = (cwd) => (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const versionAt = (git, ref) => JSON.parse(git("show", `${ref}:package.json`)).version;

/**
 * Whether this run still has a version to propose. A push already in main's version has none: in its tag, or in a
 * version PR merged before it whose tag is still on its way (prepared-release.mjs tags that merge).
 */
export function due({ cwd, event, sha }) {
  if (event !== "push") return { due: true, reason: "a version asked for by hand" };
  const git = gitIn(cwd);
  const current = versionAt(git, "HEAD");
  let tag;
  try { tag = git("rev-parse", "--verify", `refs/tags/v${current}^{commit}`); } catch {}
  if (tag) {
    try { git("merge-base", "--is-ancestor", sha, tag); return { due: false, reason: `v${current} already holds ${sha}` }; } catch {}
    return { due: true, reason: `v${current} does not hold ${sha}` };
  }
  if (versionAt(git, sha) !== current) return { due: false, reason: `the prepared v${current} (tag on its way) holds ${sha}` };
  return { due: true, reason: `${sha} came after the prepared v${current}` };
}

/**
 * Writes the version into the root package.json and package-lock.json (its two root versions) and, for a new minor or
 * major line, freezes the docs of the line before it into docs/versions/<major.minor> (docs/guide/README.md).
 * Returns the paths to commit.
 */
export function writeVersion(cwd, version) {
  const old = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version;
  for (const file of ["package.json", "package-lock.json"]) {
    const json = JSON.parse(readFileSync(join(cwd, file), "utf8"));
    json.version = version;
    if (json.packages?.[""]) json.packages[""].version = version;
    writeFileSync(join(cwd, file), JSON.stringify(json, null, 2) + "\n");
  }
  const paths = ["package.json", "package-lock.json"];
  if (line(old) !== line(version) && existsSync(join(cwd, "docs/guide/nav.json"))) {
    const dir = `docs/versions/${line(old)}`;
    rmSync(join(cwd, dir), { recursive: true, force: true });
    cpSync(join(cwd, "docs/guide"), join(cwd, dir), { recursive: true });
    rmSync(join(cwd, dir, "README.md"), { force: true });
    writeFileSync(join(cwd, dir, "release.json"), `{ "release": "${old}" }\n`);
    paths.push(dir);
  }
  return paths;
}

function describe({ version, current, base, since, log, frozen, checkedIn }) {
  return [
    `Releases main at ${base} as Piomio ${version}. Only the root versions in package.json and package-lock.json change${frozen ? `, and ${frozen} keeps the docs of the ${line(current)} line as they are now` : ""}.`,
    "",
    `Merge it to publish the release: the merge's own push tags it v${version}, then release.yml builds the installers and publishes them. A push to main that ships before then rebuilds this PR on top of it, so it goes into this release too.`,
    "",
    `${checkedIn ? `The checks passed in ${checkedIn}; they run` : "The checks run"} again on this branch, on the merge and on the tag before anything is published.`,
    "",
    since ? `Changes since ${since}:` : "Changes:",
    "",
    "~~~",
    log || "(none)",
    "~~~",
    "",
    "Opened by .github/workflows/release-on-push.yml (scripts/version-pr.mjs).",
  ].join("\n");
}

/** Opens or updates the version PR for main as it is checked out in cwd; returns its number and version. */
export async function openVersionPr({ cwd, repo, api, bump, checkedIn, log = console.log }) {
  const git = gitIn(cwd);
  const base = git("rev-parse", "HEAD");
  const current = versionAt(git, base);
  const pulls = await api(`pulls?state=open&base=main&per_page=100`);
  const ours = pulls.filter((p) => p.user?.login === BOT.name && p.head?.repo?.full_name === repo && VERSION_BRANCH.test(p.head.ref));
  const version = targetVersion({ current, bump, open: ours.map((p) => p.head.ref) });
  const branch = `release/${version}`;
  const theirs = pulls.find((p) => p.head?.repo?.full_name === repo && p.head.ref === branch && p.user?.login !== BOT.name);
  if (theirs) {
    log(`#${theirs.number} by ${theirs.user?.login} already prepares ${version} from ${branch}; leaving it to them`);
    return { version, number: theirs.number, url: theirs.html_url, theirs: true };
  }
  let pr = ours.find((p) => p.head.ref === branch);
  // A later push whose checks finished first has rebuilt the PR on this main already.
  let built;
  try { built = git("rev-parse", "--verify", `refs/remotes/origin/${branch}^1`); } catch {}
  if (pr && built === base) {
    log(`#${pr.number} already raises main at ${base} to ${version}`);
    return { version, number: pr.number, url: pr.html_url, current: true };
  }

  let since;
  try { since = git("describe", "--tags", "--abbrev=0", "--match", "v*", base); } catch {}
  const changes = git("log", "--no-merges", "--format=%h %s", "-n", "100", ...(since ? [`${since}..${base}`] : [base]));

  git("switch", "-q", "-C", branch);
  const paths = writeVersion(cwd, version);
  git("add", "-A", "--", ...paths);
  git("-c", `user.name=${BOT.name}`, "-c", `user.email=${BOT.email}`, "-c", "commit.gpgsign=false", "commit", "-qm", `Piomio ${version}`);
  git("push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);

  const frozen = paths.find((p) => p.startsWith("docs/versions/"));
  const body = describe({ version, current, base, since, log: changes, frozen, checkedIn });
  if (pr) pr = await api(`pulls/${pr.number}`, { method: "PATCH", body: { title: `Piomio ${version}`, body } });
  else pr = await api("pulls", { method: "POST", body: { title: `Piomio ${version}`, head: branch, base: "main", body } });
  log(`${pr.html_url}: Piomio ${version} on ${branch}, main at ${base}`);

  // Deleting a branch is tidying up: one already gone (HTTP 422) or refused costs nothing.
  const drop = async (ref) => {
    try { await api(`git/refs/heads/${ref}`, { method: "DELETE" }); log(`deleted ${ref}`); }
    catch (e) { log(`${ref} not deleted: ${e.message}`); }
  };
  // Another version asked for meanwhile (a minor one by hand, say) replaces the older PR: main holds that PR's changes.
  for (const old of ours.filter((p) => p.head.ref !== branch)) {
    await api(`issues/${old.number}/comments`, { method: "POST", body: { body: `Superseded by #${pr.number} (Piomio ${version}).` } });
    await api(`pulls/${old.number}`, { method: "PATCH", body: { state: "closed" } });
    log(`closed #${old.number} (${old.head.ref})`);
    await drop(old.head.ref);
  }
  // The branch of the version PR that made main's version, once merged (only a PR this workflow opened).
  const [owner] = repo.split("/");
  const done = await api(`pulls?state=closed&base=main&head=${owner}:release/${current}&per_page=20`);
  if (done.some((p) => p.merged_at && p.user?.login === BOT.name && p.head?.ref === `release/${current}`)) await drop(`release/${current}`);
  // A branch pushed with the workflow token starts no workflow by itself: start its checks explicitly.
  await api("actions/workflows/checks.yml/dispatches", { method: "POST", body: { ref: branch } });
  return { version, number: pr.number, url: pr.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.cwd();
  const env = process.env;
  const decision = due({ cwd, event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA });
  console.log(decision.reason);
  if (decision.due) {
    const checkedIn = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    const pr = await openVersionPr({ cwd, repo: env.GITHUB_REPOSITORY, api: githubApi(env.GITHUB_REPOSITORY, env.GH_TOKEN), bump: env.BUMP || undefined, checkedIn });
    if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `Version PR: [Piomio ${pr.version}](${pr.url})\n`, { flag: "a" });
  }
}
