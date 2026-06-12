---
name: release
description: Cut a new fftracking release — bump version, tag, push, watch CI, verify published assets match the tag. Use when the user says "cut a release", "ship a version", "release fftracking", "/release", or asks to publish a new build.
---

# fftracking release

Tag-driven release. Pushing a `v*` tag triggers `.github/workflows/release.yml`,
which builds the Tauri bundles (macOS dmg, Linux AppImage, deb/rpm), the `fft`
CLI, and updates the Homebrew tap.

## Critical invariant

The git tag and the app version in `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`
**must match**. Tauri stamps bundle filenames from the config version
(`fftracking_<ver>_amd64.AppImage`). If config lags the tag, the published asset
name won't match what `scripts/install.sh` builds → `curl | sh` 404s.

Two safety nets already exist, but keep them honest:
- CI `Sync version from tag` step rewrites config from the tag before building.
- `install.sh` resolves the real asset name from the GitHub API (suffix match)
  before falling back to a constructed name.

This skill bumps config **in the commit** so the repo also reflects reality —
never rely on CI sync alone, or `main` drifts from its tags.

## Steps

1. **Preflight.** Run:
   ```sh
   git rev-parse --abbrev-ref HEAD   # must be main
   git status --porcelain            # must be empty
   git fetch origin && git status -sb # must be up to date with origin/main
   gh release list --repo mayckol/fftracking -L 3
   ```
   Abort if not on `main`, tree dirty, or behind origin. Note the latest tag.

2. **Pick the next version.** Read current from `src-tauri/tauri.conf.json`.
   Ask the user patch / minor / major if not specified. Compute `X.Y.Z` (no `v`).
   Confirm it's greater than the latest tag.

3. **Bump config** (no `v` prefix in files):
   - `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
   - `src-tauri/Cargo.toml` → `version = "X.Y.Z"` (the `[package]` line)
   - Refresh the lock: `cd src-tauri && cargo update -p fftracking --precise X.Y.Z 2>/dev/null || cargo build --offline 2>/dev/null; cd -`
     (Cargo.lock version line for the crate must match; a plain `cargo check` also rewrites it.)

4. **Commit + tag + push:**
   ```sh
   git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "chore(release): vX.Y.Z"
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```
   Push `main` before the tag so CI checks out a commit that already carries the
   matching version.

5. **Watch CI:**
   ```sh
   gh run watch --repo mayckol/fftracking $(gh run list --repo mayckol/fftracking --workflow release.yml -L1 --json databaseId --jq '.[0].databaseId') --exit-status
   ```
   If the build fails, report the failing job/log; do not proceed to verify.

6. **Verify assets match the tag.** The whole point — catch drift before users do:
   ```sh
   gh release view vX.Y.Z --repo mayckol/fftracking --json assets --jq '.assets[].name'
   ```
   Confirm these exist with the **exact** version in the name:
   - `fftracking_X.Y.Z_amd64.AppImage`
   - `fftracking_X.Y.Z_aarch64.dmg`
   - `fftracking_X.Y.Z_amd64.deb`
   - `fft-x86_64-unknown-linux-gnu`, `fft-aarch64-apple-darwin`
   If any name shows a different version than `X.Y.Z`, the sync step failed —
   stop and fix before announcing.

7. **Smoke-test the installer (optional, recommended):**
   ```sh
   curl -fsSL https://raw.githubusercontent.com/mayckol/fftracking/main/scripts/install.sh | FFTRACKING_VERSION=vX.Y.Z sh
   ```

## Notes

- The `cask` CI job needs `HOMEBREW_TAP_GITHUB_TOKEN`; it self-skips if unset.
- To re-release a botched tag: delete it remote + local, delete the GitHub
  release, fix config, re-tag. `gh release delete vX.Y.Z --cleanup-tag`.
- Never edit files under `docs/` as part of a release.
