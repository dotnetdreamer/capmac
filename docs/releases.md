# Releases

Use **Actions > Release CapMac Studio > Run workflow** on the repository's default branch. Choose `patch`, `minor` or `major`, or supply an exact stable `X.Y.Z` version. Start with `dry_run` enabled to inspect the build artifacts.

The workflow builds Windows x64 and ARM64 NSIS installers and portable executables, update metadata (`latest.yml` and blockmaps), and the `capmac` CLI npm tarball. A dry run prepares the proposed version only in the runner and uploads artifacts. It does not commit, tag, create a release or publish to npm.

A real run builds and checks the proposed version first, commits the version files, atomically pushes the default branch and `vX.Y.Z` tag, then creates a draft GitHub release, uploads the files and publishes it. It dispatches **Publish CLI to npm** on that tag after the release is published. If the branch changed during the build, the push fails; start a new run from the updated branch.

## Repository setup

1. Commit and push the workflows and release helper to the default branch.
2. Allow GitHub Actions read/write workflow permissions, and ensure branch rules allow `github-actions[bot]` to push the release version commit. The workflow needs permission to push the branch and tag, create releases and dispatch the npm workflow.
3. Create a GitHub environment named `npm`. Configure required reviewers and allow deployment from the default branch and `v*` tags.
4. Configure the `capmac` package's npm trusted publisher with user `dotnetdreamer`, repository `capmac`, workflow filename `npm.yml`, environment `npm`, and permission for direct `npm publish`. For the first publish of a new package, add `NPM_TOKEN` as a secret on the `npm` environment. Once trusted publishing is configured, remove that secret. See [npm's trusted publishing setup](https://docs.npmjs.com/trusted-publishers/).

The npm workflow runs manually or by desktop release dispatch. It accepts the default branch or a stable tag that matches `packages/cli/package.json`, and skips forks. Building and packing happen in a job without publish credentials; the `npm` environment gates a separate job that publishes the finished tarball with provenance. It never bumps versions.

## Release configuration

Set these repository variables when needed:

| Variable | Behavior |
| --- | --- |
| `CAPMAC_UPDATE_URL` | Defaults to `https://github.com/dotnetdreamer/capmac/releases/latest/download/`. A custom feed must host the installers, update metadata and blockmaps. |
| `CAPMAC_RELEASE_NOTES_URL` | Defaults to this repository's `/releases/tag/v{version}` URL. |
| `CAPMAC_DEFAULT_SIGNAL_URL` | Optional signaling server URL bundled into the app and CLI. |

Signing is optional. For Azure Trusted Signing, set repository variables `CAPMAC_AZURE_SIGNING_ENDPOINT`, `CAPMAC_AZURE_SIGNING_ACCOUNT`, `CAPMAC_AZURE_SIGNING_PROFILE` and `CAPMAC_SIGNING_PUBLISHER`, plus secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. Alternatively, set certificate secrets `CSC_LINK` and `CSC_KEY_PASSWORD` (or their `WIN_` aliases). `CAPMAC_SIGNING_PUBLISHER` and `CAPMAC_TIMESTAMP_URL` can also configure certificate signing. With no signing configuration, the installers are unsigned.

## Versions and retries

`node scripts/set-version.mjs <patch|minor|major|X.Y.Z>` keeps the root manifest, all four workspace manifests, their `@capmac/core` references and the root lockfile synchronized. The release workflow uses this helper; avoid changing version fields independently.

If upload or publication fails after the tag was pushed, rerun the failed release job using the same run and source version. Do not change or move the existing tag. If npm publication fails after the GitHub release is out, run **Publish CLI to npm** manually on that release tag. A version already published to npm cannot be published again; make a new release for changed package contents.
