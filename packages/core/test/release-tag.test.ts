import { describe, expect, it } from "vitest";
import { githubApi, publishTagRelease } from "../../../scripts/release-tag.mjs";

const plan = { tag: "v0.2.37", sha: "a".repeat(40) };
function service({ existing = false, target = plan.sha, race = false, denied = false, published = false, runs = [] as any[] } = {}) {
  let ref: any = existing ? { object: { type: "commit", sha: target } } : undefined;
  const writes: any[] = [];
  const api = async (path: string, options: any = {}) => {
    if (options.method === "POST") {
      writes.push({ path, body: options.body });
      if (path === "git/refs") {
        if (denied) throw Object.assign(new Error("denied"), { status: 403 });
        ref = { object: { type: "commit", sha: target } };
        if (race) throw Object.assign(new Error("exists"), { status: 422 });
      }
      return;
    }
    if (path.startsWith("git/ref/")) return ref;
    if (path.startsWith("releases/")) return published ? { draft: false } : undefined;
    return { workflow_runs: runs };
  };
  return { api, writes };
}

describe("tag creation and explicit release dispatch", () => {
  it("creates only the tag, then explicitly dispatches release.yml at that tag", async () => {
    const s = service(); expect(await publishTagRelease(plan, s.api)).toBe("dispatched");
    expect(s.writes).toEqual([
      { path: "git/refs", body: { ref: "refs/tags/v0.2.37", sha: plan.sha } },
      { path: "actions/workflows/release.yml/dispatches", body: { ref: plan.tag, inputs: { dry_run: "false" } } },
    ]);
  });
  it("accepts a concurrent creator of the exact same tag, rejects a different target", async () => {
    expect(await publishTagRelease(plan, service({ race: true }).api)).toBe("dispatched");
    const wrong = service({ race: true, target: "b".repeat(40) });
    await expect(publishTagRelease(plan, wrong.api)).rejects.toThrow(/refusing to move/);
    expect(wrong.writes).toHaveLength(1);
  });
  it("never moves an existing tag or retries a denied write", async () => {
    const wrong = service({ existing: true, target: "b".repeat(40) });
    await expect(publishTagRelease(plan, wrong.api)).rejects.toThrow(/refusing to move/); expect(wrong.writes).toHaveLength(0);
    const denied = service({ denied: true });
    await expect(publishTagRelease(plan, denied.api)).rejects.toThrow("denied"); expect(denied.writes).toHaveLength(1);
  });
  it("is a no-op for published releases, running builds and successful builds", async () => {
    const published = service({ existing: true, published: true });
    expect(await publishTagRelease(plan, published.api)).toBe("already published"); expect(published.writes).toHaveLength(0);
    for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "success"]]) {
      const s = service({ existing: true, runs: [{ head_sha: plan.sha, head_branch: plan.tag, display_title: `Publish ${plan.tag}`, status, conclusion }] });
      expect(await publishTagRelease(plan, s.api)).toBe("already dispatched"); expect(s.writes).toHaveLength(0);
    }
  });
  it("requires retrying a failed run instead of dispatching a second one", async () => {
    const s = service({ existing: true, runs: [{ id: 12, head_sha: plan.sha, head_branch: plan.tag, display_title: `Publish ${plan.tag}`, status: "completed", conclusion: "failure" }] });
    await expect(publishTagRelease(plan, s.api)).rejects.toThrow(/run 12 failed/); expect(s.writes).toHaveLength(0);
  });
  it("fails closed when listing runs is denied", async () => {
    const s = service({ existing: true });
    const api = async (path: string, options: any) => { if (path.startsWith("actions/")) throw new Error("denied"); return s.api(path, options); };
    await expect(publishTagRelease(plan, api)).rejects.toThrow("denied"); expect(s.writes).toHaveLength(0);
  });
  it("does not confuse a successful preview with a published build", async () => {
    const s = service({ existing: true, runs: [{ head_sha: plan.sha, head_branch: plan.tag, display_title: `Preview ${plan.tag}`, status: "completed", conclusion: "success" }] });
    expect(await publishTagRelease(plan, s.api)).toBe("dispatched");
    expect(s.writes).toEqual([{ path: "actions/workflows/release.yml/dispatches", body: { ref: plan.tag, inputs: { dry_run: "false" } } }]);
  });
  it("treats only an explicit 404 as absence, and does not leak the workflow token in an error", async () => {
    const api = githubApi("legostin/piomio", "private-token", async () => new Response("", { status: 403 }));
    await expect(api("git/ref/tags/v0.2.37", { optional: true })).rejects.toThrow(/HTTP 403/);
    await expect(api("git/ref/tags/v0.2.37")).rejects.not.toThrow(/private-token/);
    expect(await githubApi("legostin/piomio", "private-token", async () => new Response("", { status: 404 }))("git/ref/tags/v0.2.37", { optional: true })).toBeUndefined();
  });
});
