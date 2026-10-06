# Releasing `@pmndrs/sky`

Releases are automated with [release-please](https://github.com/googleapis/release-please)
and published from CI with npm Trusted Publishing. Nobody runs `npm publish` by
hand.

## How a release happens

1. **Pull requests are squash-merged into `main`.** The PR title becomes the
   commit, so it must be a [Conventional Commit](https://www.conventionalcommits.org/).
   The `PR title` check enforces this.

   | Title prefix                                    | Version bump (pre-1.0)           | Changelog section                  |
   | ----------------------------------------------- | -------------------------------- | ---------------------------------- |
   | `feat:` / `feat(scope):`                        | minor (0.4.0 → 0.5.0)            | Features                           |
   | `feat!:` or a `BREAKING CHANGE:` footer         | minor (pre-1.0), major after 1.0 | Features, flagged breaking         |
   | `fix:`, `perf:`                                 | patch (0.4.0 → 0.4.1)            | Bug Fixes / Performance            |
   | `docs:`, `examples:`, `revert:`                 | none on its own                  | Documentation / Examples / Reverts |
   | `chore:`, `ci:`, `test:`, `build:`, `refactor:` | none                             | hidden                             |

2. **Every push to `main` updates one standing release PR**, titled
   `chore: release X.Y.Z`. It bumps `package.json` and
   `.release-please-manifest.json`, and prepends the generated notes to
   `CHANGELOG.md`. Unreleased changes keep accumulating in it.

3. **Merging the release PR ships it.** release-please tags `vX.Y.Z` and
   creates the GitHub release. The `publish` job in
   [`publish.yml`](.github/workflows/publish.yml) then checks out the tag,
   builds, typechecks, tests, and runs `npm publish --provenance`.

Edit the release PR's `CHANGELOG.md` before merging if the generated notes
need polish. A later push to `main` regenerates it, so edit just before you
merge.

### Publishing is gated

`npm publish` only runs when the repository **variable** `NPM_PUBLISH_ENABLED`
is `true` (Settings → Secrets and variables → Actions → Variables). While it's
unset, merging a release PR still tags, creates the GitHub release, and builds
and tests the package, but stops before publishing. To publish such a release
later, turn the gate on and run `publish.yml` manually on the tag (Actions →
Release & publish → Run workflow → "Use workflow from" → Tags → `vX.Y.Z`).

### Manual cut (escape hatch)

Bump `package.json`, merge that, then `git tag vX.Y.Z && git push --tags`. The
tag path of `publish.yml` checks the tag matches `package.json`. Versions that
are already on npm are always skipped, so re-running is safe.

A manual (`workflow_dispatch`) run of `publish.yml` on a branch is a dry run:
install, build, test and the registry check. On a tag, it publishes that tag
if the gate is on.

## One-time setup (maintainers)

These are repository and npm settings, not code. Check them off before the
first automated release:

- [ ] **npm Trusted Publisher.** On npmjs.com: `@pmndrs/sky` → Settings →
      Publishing → Trusted Publishers → GitHub Actions, repository
      `pmndrs/sky`, workflow `publish.yml`. 0.2.0 and 0.3.0 were published by
      hand, so this path hasn't been proven end to end yet. Do a first
      `workflow_dispatch` dry run, then the first real release, and watch it.
- [ ] **Allow Actions to open PRs.** Settings → Actions → General → "Allow
      GitHub Actions to create and approve pull requests" (needed for the
      release PR). It's currently enabled.
- [ ] **Squash merge uses the PR title.** Settings → General → Pull Requests:
      allow squash merging, with the default commit message "Pull request
      title" (or "title and description"). Consider disabling merge commits
      and rebase merging so every commit on `main` is a PR title.
- [ ] **Protect `main`** with a ruleset: require a pull request, require the
      `ci` and `conventional-title` status checks, and block force pushes.
      Until then, direct pushes still work. They're picked up by release-please
      only if their own message is a Conventional Commit.
- [ ] **CI on the release PR (optional).** PRs opened with the default
      `GITHUB_TOKEN` don't trigger workflows, so the release PR shows no `ci`
      check. If `ci` is a required check, add a `RELEASE_PLEASE_TOKEN` secret
      (a fine-grained PAT or GitHub App token with contents and pull-requests
      write access); `publish.yml` uses it automatically.
- [x] **Turn publishing on:** set `NPM_PUBLISH_ENABLED=true` (done for 0.4.0).

## Editing the release notes

0.4.0 (2026-10-06) was the first release cut this way, published from CI with
npm Trusted Publishing and provenance. 0.3.0 had no tag at the time, so the
config pinned it with `last-release-sha` until v0.4.0 existed; the `v0.3.0`
tag was added afterwards for the changelog's compare link.

release-please regenerates the release PR's `CHANGELOG.md` and description on
every push to `main`, so hand edits are lost if anything merges after them.
Make them last, right before merging the release PR, and edit both: the
GitHub release is created from the PR description.

Commits from before this setup that aren't Conventional (`stars wip`, `Fix
noon whiteout…` (#23)) don't make it into the generated notes. Cover them by
editing the release PR's `CHANGELOG.md` before merging, or with a
`BEGIN_COMMIT_OVERRIDE … END_COMMIT_OVERRIDE` block in the merged PR's
description, which release-please reads instead of the title.
