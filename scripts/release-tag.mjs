// Tag creation and explicit dispatch. No branch writes, force updates, or permission-error retries.
import { parseVersion } from "./release-version.mjs";
/** Never updates a ref. A competing creator is accepted only if it created this exact lightweight tag. */
export async function publishTagRelease(plan, api) {
  parseVersion(plan.tag.slice(1));
  if (!plan.tag.startsWith("v") || !/^[a-f0-9]{40}$/.test(plan.sha)) throw new Error("Invalid release tag or SHA");
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
    const { workflow_runs: runs } = await api(`actions/workflows/release.yml/runs?head_sha=${plan.sha}&per_page=100&page=${page}`);
    // A successful dry run on this tag is not a publication. Include tag-push runs made by the owner, too.
    const matching = runs.filter((r) => r.head_sha === plan.sha && r.head_branch === plan.tag && r.display_title === `Publish ${plan.tag}`);
    if (matching.some((r) => r.status !== "completed" || r.conclusion === "success")) return "already dispatched";
    if (matching.length) throw new Error(`Release run ${matching[0].id} failed; rerun that run instead of dispatching another`);
    if (runs.length < 100) break;
    if (page === 10) throw new Error("Cannot prove the release has not already been dispatched");
  }
  await api("actions/workflows/release.yml/dispatches", { method: "POST", body: { ref: plan.tag, inputs: { dry_run: "false" } } });
  return "dispatched";
}

export function githubApi(repo, token, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error("Repository and workflow token are required");
  return async (path, { method = "GET", body, optional = false } = {}) => {
    const r = await fetcher(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "piomio-tag-release" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (optional && r.status === 404) return undefined;
    if (!r.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: HTTP ${r.status}`), { status: r.status });
    return r.status === 204 ? undefined : r.json();
  };
}

