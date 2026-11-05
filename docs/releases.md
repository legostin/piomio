# Releases and repository protection

## Source of truth

Stable tags `vMAJOR.MINOR.PATCH` are the release ledger. The highest stable version is incremented; prerelease and
non-semver tags are ignored. A release tag points to the **exact main event commit that passed checks**. Neither a
version commit nor a rebase onto a newer, unchecked main is part of releasing. Source `package.json` can stay at an
older development version. Do not merge the old version-only release branches to produce another release.

`release-on-push.yml` runs `checks.yml`, computes the plan without writes, then recomputes it in the serialized tag
job with fresh tags. It creates only a new lightweight `refs/tags/vX.Y.Z` through the GitHub API. Its `GITHUB_TOKEN`
has `contents: write` and `actions: write`; it explicitly dispatches `release.yml` **on that tag**, with
`dry_run=false`. The token's tag creation does not itself start a tag-push workflow. No owner token or new secret is
needed. The owner's manually created stable tag also starts `release.yml` through its tag-push event.

Every push to main runs checks. A push with `[skip release]` in any commit defers its release without skipping CI.
A later push compares shipped files against the newest stable tag, so deferred changes are included. Site, docs,
root Markdown and tests alone do not release. A stale run whose commit is already contained in a newer tag stops.
A highest stable tag outside the commit's ancestry is an error, not a reason to select an older version.

## Build versions and consumers

Before compiling or staging a release, `scripts/release-version.mjs` stamps only the runner's disposable checkout:

- root `package.json`, both root versions in `package-lock.json`;
- `packages/desktop/src-tauri/tauri.conf.json`;
- the Piomio package in `Cargo.toml` and `Cargo.lock` (dependency versions stay unchanged).

The same tag version flows into the staged hub, `desktop-version.json`, the bundled node, macOS metadata, Windows
installer names, Linux archives and the hub's `/api/auth/state` and download links. Tauri's current app version and
`latest.json` therefore agree. `latest.json` still references signed assets under `/releases/download/vX.Y.Z/`.
The publishing job requires Windows, macOS DMG/PKG, both Linux architectures, signatures and checksums before
creating the release. A late older build is published with `--latest=false`, never downgrading the updater feed.

The website's download version and assets already come from GitHub's latest published release. The docs now use
that same release to select their current major/minor line, even when main's package version is stale. The source
manifest is only the offline fallback. `site.yml` rebuilds after a successful tag release; PR preview runs do not
trigger a deployment. Source checkouts used for local development retain their manifest version; for a local
release build, check out the tag in a disposable worktree and run `node scripts/release-version.mjs X.Y.Z` first.

There is no tracked CHANGELOG file or winget automation in this repository. GitHub release notes are generated
from tag history (`--generate-notes`). A winget update is a separate, reviewed submission using the published tag,
installer URL and SHA-256, not the version in main. This change does not submit to winget.

## Checks, previews and recovery

Required PR check contexts from `checks.yml` are exactly `typecheck`, `test`, `site`, `panel-layout`, provided by
GitHub Actions (integration `15368`). Typecheck has its own job. Called workflows show `checks / …` in release runs;
those nested names are not the contexts required on the PR. There are no path filters on these four PR checks.

PRs touching packaging or release code automatically run `release.yml` as a preview: resolve the next version,
stamp it, run checks, build/install/test Windows, universal macOS, Linux x64 and arm64. The publish job is disabled
for every PR. No tag or release is created. The artifacts are for CI validation, not distribution.

Manual dry runs (safe defaults):

- `release on push` on a branch, `dry_run=true`: checks and a version plan, no tag or dispatch.
- `release` on a branch, `dry_run=true`: full installer preview, no publication. Non-tag publication is rejected.
- Local policy preview: `GITHUB_SHA=$(git rev-parse HEAD) node scripts/release-on-push.mjs` (no network writes).

Production runs require explicit authorization. For an existing tag whose build failed, rerun the failed release
run. If tag creation succeeded but dispatch failed, rerun the main workflow: it reuses that exact tag. It does not
move a tag, reserve another patch on the same commit, or duplicate an in-progress/successful build. A tag at a
different SHA or a permission error stops the run. Published assets are never overwritten on a retry; an existing
draft requires inspection. Never delete a tag or disable protection to get past an error.

Before a manual minor/major release, archive `docs/guide` **from the last stable tag** into
`docs/versions/<old-major.minor>/` in a PR. Add `release.json` with that version and keep `nav.json`. Merge that PR
with `[skip release]` if a patch must be deferred. Then run `release on push` on main with the requested bump and
`dry_run=true`; after reviewing its plan, authorize `dry_run=false`. The workflow validates the archived line but
never commits it. Updating current docs for the next line belongs in the same reviewed change.

## Rulesets prepared for approval

The JSON bodies in [main.json](../.github/rulesets/main.json) and
[release-tags.json](../.github/rulesets/release-tags.json) are proposals, not applied settings.

For existing ruleset `26559216`, PUT `repos/legostin/piomio/rulesets/26559216` with `main.json`:

- target `~DEFAULT_BRANCH` instead of the literal `refs/heads/main`;
- preserve deletion and force-push protection;
- replace the blanket `update` restriction with PR + four required checks, strict branch freshness;
- require zero approvals, no code-owner or last-pusher approval;
- keep only User `7765236` (legostin), `always`, as the explicitly requested owner exception. Do not broaden it to
  all future admins. An `always` bypass applies to the whole ruleset; agents must still use green PRs and must
  never force-push. GitHub cannot distinguish a person from an agent using that person's token.

Remove these three bypass entries (identified with GitHub's public Apps API on 2026-11-05):

| App ID | App | Main bypass needed? |
| --- | --- | --- |
| 1144995 | [ChatGPT Codex Connector](https://api.github.com/apps/chatgpt-codex-connector) | No; use PRs |
| 1210556 | [Cursor](https://api.github.com/apps/cursor) | No; use PRs |
| 1236702 | [Claude](https://api.github.com/apps/claude) | No; use PRs |

For release tags, POST `repos/legostin/piomio/rulesets` with `release-tags.json`: match `refs/tags/v*`, restrict
`update`, `deletion`, `non_fast_forward`; only the owner's User ID bypasses. **Do not add `creation` or an Actions
bypass.** New tags remain possible with `contents: write`, but Actions cannot move or delete existing ones.

This conclusion follows GitHub's documented separation of [creation, update and deletion rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-creations)
and the [create-reference API's Contents: write permission](https://docs.github.com/en/rest/git/refs#create-a-reference).
[`GITHUB_TOKEN` can authenticate these API calls](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).
The [token's event suppression](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)
is why the explicit dispatch is required.

Creation is deliberately **not limited to a list of actors**: any account or installed app with effective contents
write access can create a new matching tag. The three apps above advertise contents-write permissions, though the
public API does not establish their current installation grants on this repository. Removing their bypass does
not revoke their write grants. Future hardening: a dedicated release GitHub App with a `creation` restriction and
bypass only for that app and the owner; creating/installing such an app needs a separate founder decision. No
owner PAT is proposed.

## Application plan (only after founder approval)

1. Refresh main, the existing rulesets and effective branch rules. Confirm `v0.2.39` does not exist and the latest
   stable tag is still `v0.2.38`. If main/tags advanced before approval, review the new version plan first.
2. Merge [PR #20](https://github.com/legostin/piomio/pull/20) first, after its CI is green and the founder has
   approved it. Preserve `[skip release]` in the merge/squash message. It fixes the gateway test's port-allocation
   race and activity callbacks after shutdown; these fixes must precede making `test` mandatory.
3. Refresh [PR #19](https://github.com/legostin/piomio/pull/19) against the new main without force-pushing (merge
   main into its existing branch), then wait for all checks and the four preview platforms. Merge the reviewed
   head through GitHub with `[skip release]` in the merge message. Do not bypass failing checks. The header fix
   from PR #16 (`e6e1db5`) remains included. This controlled first rollout defers tagging until protection is ready.
4. Apply the main PUT and tag POST above. Read both back and inspect effective rules. Do not weaken or delete an
   unrelated ruleset.
5. Run `release on push` on main with `dry_run=true`, review the exact merge SHA and `v0.2.39` plan, then dispatch
   it with `dry_run=false` under the founder's release approval: checks → plan → tag creation → release dispatch.
   Do not rerun the old GH013 workflow. Subsequent ordinary main merges release automatically.
6. Verify the tag SHA, green macOS/Windows/Linux x64/Linux arm64 jobs and their install/uninstall checks; inspect
   published asset names, Linux checksums, updater signatures and `latest.json` version/URLs. Verify the published
   GitHub release and the refreshed site. Confirm no version-bump commit appeared in main.

Preparation and PR preview do not apply rulesets, merge main, create a production tag or publish a release.
