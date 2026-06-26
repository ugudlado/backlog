---
name: release
description: Cut a release of backlog.md to npm. Use when the user says "release", "publish", "cut a release", "ship a new version", or "bump the version". Covers the pre-flight checks and the tag that triggers the automated publish pipeline.
---

# Release

Releasing backlog.md is **tag-driven and CI-automated**. Pushing a `v*.*.*` tag
triggers `.github/workflows/release.yml`, which builds every platform binary,
publishes the npm packages, creates the GitHub release, and syncs the version
back to `main`. Your job is only the local pre-flight and cutting the tag —
**do not** run `npm publish` or `bun run build` to publish by hand; CI owns that.

The web UI service (`backlog service start`) is unrelated to releasing. It runs
on an end-user's machine after install. Never couple it to a release.

## Steps

1. **Confirm intent and bump level.** Ask the user for `patch` / `minor` /
   `major` (or an explicit version) if not stated. Default to `patch`.

2. **Refuse to release from a bad state** — a tag is permanent:
   - On `main`: `git rev-parse --abbrev-ref HEAD` must be `main`.
   - Clean tree: `git status --porcelain` must be empty.
   - Up to date: `git pull --ff-only`.
   If any fails, stop and tell the user what to fix.

3. **Run the green-tree gate.** All must pass before tagging:
   ```bash
   bun test
   bunx tsc --noEmit
   bun run check .
   ```
   If anything fails, stop. Do not tag a red tree.

4. **Bump and tag.** This commit + tag is what CI waits for:
   ```bash
   npm version <patch|minor|major|x.y.z> -m "chore: release %s"
   ```
   `npm version` updates `package.json`, commits, and creates the `vX.Y.Z` tag.

5. **Push to trigger the pipeline:**
   ```bash
   git push --follow-tags
   ```

6. **Report the run** so the user can watch it:
   ```bash
   gh run list --workflow=release.yml -L1
   ```
   Tell the user CI is now building and publishing; nothing else is needed locally.

## What CI does (so you don't)

`release.yml` on a `v*` tag: compiles binaries for linux/darwin/windows × x64/arm64,
publishes the `backlog.md` shim + per-platform packages to npm, runs install-sanity
checks, creates the GitHub release with binaries attached, and commits the synced
version to `main`. If a release fails, read the failing job in that workflow run —
do not try to publish manually as a workaround.

## Local install (NOT a release)

To test a build locally without publishing, use `scripts/local-install.sh` — it
packs and globally installs from the current checkout as `0.0.0-local`. This never
touches npm or tags.
