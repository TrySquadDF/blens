# Releasing blens

Changesets manages versions and `packages/blens/CHANGELOG.md`. GitHub Actions
checks every pull request and publishes new versions after the release PR is
merged into `main`. Infrastructure-only changes do not need a changeset.

## One-time setup

The npm package is `@trysquaddf/blens`; the project and GitHub repository remain
`blens`. npm rejected the unscoped name as too similar to an existing package.

The GitHub repository is `https://github.com/TrySquadDF/blens`.
The npm package metadata and trusted publisher settings below use this address.
Create the repository under the `TrySquadDF` account and use
`https://github.com/TrySquadDF/blens.git` as the Git remote URL.

1. Commit and push the project, including `.github`, `.changeset`, the package,
   and `bun.lock` to GitHub. In **Settings → Actions → General**, enable
   **Allow GitHub Actions to create and approve pull requests**.
2. If `@trysquaddf/blens` has never been published, create a short-lived granular npm access
   token authorized to publish the new package, with **Bypass 2FA** enabled for
   noninteractive publication. Save it as the GitHub Actions secret
   `NPM_BOOTSTRAP_TOKEN`. Run **Actions → Release → Run workflow**, select `main`,
   and enable **First npm publication only**. With no pending changesets this
   publishes the current version, initially `0.1.0`, and creates a GitHub release.
   If there are pending changesets, merge the generated release PR and run the
   bootstrap again. The name must be available or owned by your npm account.
3. In npm, open **@trysquaddf/blens → Settings → Trusted publishing** and add GitHub Actions:

   | Field | Value |
   | --- | --- |
   | Organization or user | `TrySquadDF` |
   | Repository | `blens` |
   | Workflow filename | `release.yml` |
   | Environment | Leave empty |
   | Allowed actions | Enable direct `npm publish` |

   The workflow runs on GitHub-hosted runners with `id-token: write`. Publication
   uses npm 11 on Node 24. No npm token is needed for subsequent releases.
4. Revoke the temporary npm token and delete `NPM_BOOTSTRAP_TOKEN` from GitHub.
   If the package already exists, skip the bootstrap and configure the trusted
   publisher directly.

Before the package exists on npm, automatic Release runs still execute CI but
skip release PR creation and publication, with setup instructions in the run
summary. Start the first publication with the manual bootstrap run above.
Once the package exists, automatic releases use Trusted Publishing. Registry
outages and authentication failures for an existing package remain errors.
Nothing is published by the CI workflow or by local verification commands.

## Regular releases

1. Make the code change and run `bun run changeset` from the repository root.
2. Select `@trysquaddf/blens`, choose `patch`, `minor`, or `major`, and write a short note
   describing the change for package users. Commit the generated file with the
   code. For this pre-1.0 library, use a minor bump for breaking changes and
   describe the migration in the note; choose a major bump when ready for 1.0.
3. Merge the change into `main`. The Release action checks the code and opens or
   updates **chore: release blens** with the new version, changelog and lockfile.
4. Review and merge that PR. The next successful Release run publishes the npm
   version, adds a Git tag, and creates a GitHub release.

GitHub's built-in token does not trigger new workflows when the bot opens or
updates a release PR. If branch protection requires CI checks on that PR,
manually run **Actions → CI → Run workflow** on `changeset-release/main` after
its latest update. The release workflow also checks the merged commit before
publishing. A separate personal access token is not required for this setup.

For CI-only or test-only changes, omit the changeset; an already published
version is skipped. Never change versions or create release tags manually in
the regular flow. To retry, rerun the Release workflow on `main` with bootstrap
unchecked; Changesets checks the registry and skips published versions.
If npm succeeded but GitHub release creation failed, restore the missing GitHub
release from the package changelog; a retry may have no new publications.

## Local verification

```sh
bun install --frozen-lockfile
bun run check
bun run test:package
bun run changeset status
```

CI runs the build, tests and package checks on Node 22, 24 and 26 with Bun
pinned in `packageManager`. Pull requests run CI directly; pushes to `main` run
the same CI workflow through Release before publication. `changeset status`
is a local inspection command; on a feature branch it can report missing
release notes for changed packages. It is not a required CI check.
The package check installs the actual npm archive into a temporary project and
runs the Node integration suite against that installed copy. No package is
published by these commands.

`bun run version-packages` consumes pending changesets and refreshes `bun.lock`;
the release Action normally runs it in its PR branch. `bun run release` is a
real publishing command intended for the authenticated Release Action.

See the official [Changesets automation guide](https://changesets.dev/guide/automating)
and [npm Trusted Publishing guide](https://docs.npmjs.com/trusted-publishers/).
