// main takes writes only from its owner, so a release's version arrives in a version-only PR (scripts/version-pr.mjs
// opens it; the owner merges it). Actions then only creates the merge's tag and dispatches the build.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export function preparedRelease({ before, sha, cwd = process.cwd() }) {
  if (![before, sha].every((s) => /^[a-f0-9]{40}$/.test(s) && !/^0+$/.test(s))) throw new Error("Expected complete before/after commit SHAs");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const read = (ref, file) => JSON.parse(git("show", `${ref}:${file}`));
  git("merge-base", "--is-ancestor", before, sha);
  if (/\[skip release\]/i.test(git("log", "--format=%B", `${before}..${sha}`))) return undefined;
  const old = read(before, "package.json").version;
  const version = read(sha, "package.json").version;
  if (old === version) return undefined;
  const parse = (v) => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw new Error("Expected a stable semantic version");
    const parts = v.split(".").map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error("Invalid version number");
    return parts;
  };
  const [major, minor, patch] = parse(old);
  const step = { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` };
  parse(version);
  const bump = Object.keys(step).find((k) => step[k] === version);
  if (!bump) throw new Error("A prepared release must advance the version by exactly one patch, minor or major step");
  // A new minor or major line also freezes the docs of the line before it (docs/guide/README.md).
  const frozen = bump === "patch" ? undefined : `docs/versions/${major}.${minor}/`;
  const files = git("diff", "--name-only", before, sha).split("\n");
  if (files.some((f) => !["package.json", "package-lock.json"].includes(f) && !(frozen && f.startsWith(frozen)))) throw new Error("A prepared release must change only the version files");
  const lock = read(sha, "package-lock.json");
  if (lock.version !== version || lock.packages?.[""]?.version !== version) throw new Error("The three root versions must agree");
  const withoutVersions = (v) => {
    delete v.version;
    if (v.packages?.[""]) delete v.packages[""].version;
    return v;
  };
  for (const file of ["package.json", "package-lock.json"]) {
    if (!isDeepStrictEqual(withoutVersions(read(before, file)), withoutVersions(read(sha, file)))) throw new Error("Only the three root version values may change");
  }
  git("merge-base", "--is-ancestor", `refs/tags/v${old}^{commit}`, before);
  return { tag: `v${version}`, sha };
}

/** Never updates a ref. A competing creator is accepted only if it created this exact lightweight tag. */
export async function publishPrepared(plan, api) {
  const checkTag = (ref) => {
    if (ref?.object?.type !== "commit" || ref.object.sha !== plan.sha) throw new Error(`${plan.tag} already exists at another target; refusing to move it`);
  };
  let ref = await api(`git/ref/tags/${plan.tag}`, { optional: true });
  if (ref) checkTag(ref);
  else {
    try {
      await api("git/refs", { method: "POST", body: { ref: `refs/tags/${plan.tag}`, sha: plan.sha } });
    } catch (e) {
      // A concurrent tag creation may return 422. Other errors (including denied access) are never retried.
      if (e.status !== 422) throw e;
      ref = await api(`git/ref/tags/${plan.tag}`);
      checkTag(ref);
    }
    checkTag(await api(`git/ref/tags/${plan.tag}`));
  }
  const release = await api(`releases/tags/${plan.tag}`, { optional: true });
  if (release && !release.draft) return "already published";
  // A GITHUB_TOKEN tag push does not start another workflow. Dispatch it explicitly, but do not duplicate a run.
  for (let page = 1; page <= 10; page++) {
    const { workflow_runs: runs } = await api(`actions/workflows/release.yml/runs?head_sha=${plan.sha}&event=workflow_dispatch&per_page=100&page=${page}`);
    const matching = runs.filter((r) => r.head_sha === plan.sha && r.head_branch === plan.tag);
    if (matching.some((r) => r.status !== "completed" || r.conclusion === "success")) return "already dispatched";
    if (matching.length) throw new Error(`Release run ${matching[0].id} failed; rerun that run instead of dispatching another`);
    if (runs.length < 100) break;
    if (page === 10) throw new Error("Cannot prove the release has not already been dispatched");
  }
  await api("actions/workflows/release.yml/dispatches", { method: "POST", body: { ref: plan.tag } });
  return "dispatched";
}

export function githubApi(repo, token, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error("Repository and workflow token are required");
  return async (path, { method = "GET", body, optional = false } = {}) => {
    const r = await fetcher(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "piomio-prepared-release" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (optional && r.status === 404) return undefined;
    if (!r.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${r.status}`), { status: r.status });
    return r.status === 204 ? undefined : r.json();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = preparedRelease({ before: process.env.BEFORE, sha: process.env.GITHUB_SHA });
  console.log(plan ? `${plan.tag} at ${plan.sha}: ${await publishPrepared(plan, githubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN))}` : "No prepared version in this push");
}
