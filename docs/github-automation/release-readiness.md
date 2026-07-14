# Release readiness and consumer rollout planning

Issue #27 adds a read-only release readiness layer for `codex-workflow-kit`.
It prepares a reviewed fixed-SHA release plan and a consumer update plan, but it does not create tags, GitHub Releases, npm packages, pull requests, branch updates, queue updates, deployments, or GitHub API writes.

## Ref policy

Consumer execution refs use reviewed 40-character lowercase commit SHA values as the source of truth.

Allowed:

- package version: `1.2.3`
- human-facing release tag: `v1.2.3`
- consumer release ref: `0123456789abcdef0123456789abcdef01234567`

Rejected for consumer execution:

- `v1`
- `v1.2`
- `v1.2.3`
- `latest`
- `main`
- `master`
- `develop`
- `HEAD`
- shortened SHA values
- placeholder refs outside caller templates

Version tags are release identifiers for people. They are not the rollout target for caller workflows or `kit-ref`.

## Version policy

- Patch: bug fixes, docs, tests, or backward-compatible validation additions.
- Minor: new read-only capability, new optional config, or additional plan-only output.
- Major: schema breaking changes, output removal, required input changes, or migration-required behavior.

This repository does not bump versions, create tags, or publish npm packages from the release readiness workflow.

## Release manifest

The release manifest schema lives at `schemas/release-manifest.schema.json`.
The example manifest lives at `release/release-manifest.example.yml`.
The example manifest is a fixture: its committed SHA fields are dummy values and must not be treated as a production-ready release manifest as-is.

The manifest records:

- `schemaVersion`
- `releaseVersion`
- `releaseCommitSha`
- `previousReleaseCommitSha`
- `releaseDate`
- released capabilities
- changed capabilities
- breaking changes
- migration requirement
- Action artifacts
- reusable workflows
- caller templates
- schemas
- `rollbackCommitSha`
- validation commands

The manifest must not list unimplemented write capabilities as released capabilities.
For Issue #27, these remain explicitly out of scope:

- `auto-merge-write`
- `branch-update-write`
- `codex-launch`
- `queue-issue-update`

Issue #25 real auto-merge write remains blocked until the review-evidence gate in `oshi-management-app` Issue #133 is complete.

Release readiness also checks the manifest against the checked-out Git repository:

- `releaseCommitSha` must exist as a commit object in the checked-out repository.
- `releaseCommitSha` must match the checked-out `HEAD`.
- `previousReleaseCommitSha` must exist, must not equal `releaseCommitSha`, and must be an ancestor of `releaseCommitSha`.
- `rollbackCommitSha` must exist and must be an ancestor of `releaseCommitSha`.
- Git initialization failures, unreadable commits, missing objects, and `merge-base --is-ancestor` failures block readiness.

Because a file committed to the repository cannot contain the SHA of the commit that contains that file, the committed example manifest is used as a fixture. Local CI commands pass `--use-current-git-shas` so the planner replaces fixture SHAs with the checked-out `HEAD` and its first parent for dry-run validation. Real release gates should pass a manifest generated for the already reviewed release commit.

Manifest file lists are compared with repository inventory:

- `actionArtifacts` must match the expected Shared Action artifacts.
- `reusableWorkflows` must match the current `workflow_call` workflows.
- `callerTemplates` must match `templates/workflows/**/*.yml`.
- `schemas` must match `schemas/**/*.json`.
- Missing files, duplicate entries, extra entries, omitted inventory files, and unknown capabilities block readiness.

## Source and dist

Release readiness requires the Shared Action source and committed dist to match.

Required checks:

- `npm run build:action` can regenerate the bundle deterministically.
- `npm run check:action-dist` succeeds.
- Missing dist, stale dist, dist-only changes, and secret-like values in dist block release readiness.

If Action source changes, rebuild `actions/validate-config/dist/` with the normal build command and commit both source and generated dist together.

## Fixed ref audit

The release audit scans:

- `.github/workflows/**/*.yml`
- `reusable-workflows/**/*.yml`
- `templates/workflows/**/*.yml`
- `docs/**/*.md`
- `fixtures/**/*.yml`

Rules:

- External `uses:` refs must be reviewed 40-character lowercase commit SHA values.
- Local `./` reusable workflow refs are allowed.
- `REPLACE_WITH_40_CHAR_COMMIT_SHA` is allowed only inside caller templates.
- Production workflows must not contain placeholders.
- `@main`, `@master`, `@latest`, tags, shortened SHAs, and malformed `uses:` values fail closed.
- YAML comments and Markdown prose are not treated as executable refs.
- YAML examples in Markdown use fixed dummy SHA values so the audit remains deterministic.

## Consumer inventory and update plan

The consumer inventory example lives at `release/consumers.example.yml`.
It contains no secrets and no private consumer values.

Each consumer plan records:

- repository
- current ref
- target ref
- whether an update is needed
- changed capabilities
- migration requirement
- files to update
- validation commands
- manual review requirement
- blockers
- rollback ref

The target ref must exactly match `releaseCommitSha`.
If a consumer already uses that SHA, the plan skips the update.
Downgrades, mixed refs inside one consumer, mutable refs, path traversal, duplicate repositories, and breaking changes require manual review or block the plan.

The planner may generate PR body text in a later issue, but Issue #27 does not create consumer PRs or push to consumer repositories.

Live consumer audit is the read-only follow-up check for real consumers. It verifies that a consumer repository actually uses reviewed 40-character kit refs, matching capabilities, read-only permissions, safe triggers, and no Secret-bearing workflow structure. It does not update the consumer and is documented in [live-consumer-audit.md](live-consumer-audit.md).

## Release readiness workflow

`.github/workflows/release-readiness.yml` is read-only.

It uses:

- `workflow_dispatch`
- `pull_request` for release-related files
- `contents: read`
- no secrets
- no `pull_request_target`
- no write permissions

The workflow runs:

```bash
npm ci
npm run release:readiness
```

`npm run release:readiness` performs a dry-run plan only.

## CLI usage

Human-readable output:

```bash
npm run release:readiness
```

JSON output:

```bash
npm run plan:release
```

Direct CLI:

```bash
node scripts/plan-release.mjs \
  --manifest release/release-manifest.example.yml \
  --consumers release/consumers.example.yml \
  --use-current-git-shas \
  --json
```

The CLI exits non-zero when readiness blockers exist.
It does not call the GitHub API, create tags, create releases, create PRs, push, deploy, or read secrets.
`--no-dry-run` is rejected. The CLI is dry-run only until a later issue explicitly implements a write path.

## Rollback policy

Rollback means updating consumers back to a previous reviewed 40-character commit SHA.

Do not:

- move tags
- reassign the same version tag
- force push
- switch consumers to mutable branches
- skip consumer CI

Rollback still uses a normal consumer update PR and consumer CI before merge.

## Validation

Release-specific commands:

```bash
npm run test:release
npm run lint:release
npm run validate:release-manifest
npm run audit:release-refs
npm run plan:consumer-updates
npm run release:readiness
```

Full repository validation:

```bash
npm run ci
```

## Safety

Release readiness is deliberately fail-closed.
Unknown fields, invalid refs, missing files, source/dist mismatch, schema mismatch, changelog mismatch, consumer path traversal, mixed refs, and unreadable planning inputs block readiness.

No release readiness path performs:

- GitHub API write
- tag creation
- GitHub Release creation
- npm publish
- consumer repository changes
- branch updates
- queue updates
- Codex launch
- deploy
