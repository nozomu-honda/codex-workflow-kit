# Changelog

## Unreleased

### Added

- Added release readiness planning for `auto-merge-plan`, `auto-merge-dry-run-executor`, `main-follow-up-plan`, and `repository-protection-audit`.
- Added the read-only `auto-merge-dry-run-executor` capability to aggregate auto-merge plan, review evidence, consumer audit, protection audit, checks, and Disabled adapter results.
- Added read-only repository protection audit coverage for Branch protection, Rulesets, required checks, required reviews, bypass actors, and merge settings.
- Added read-only release manifest and consumer inventory examples for fixed-SHA rollout planning.
- Added fixed ref audit coverage for reusable workflows, caller templates, docs examples, and fixtures.
- Added read-only live consumer audit planning for fixed SHA, config, trigger, permission, and Secret-like workflow checks.

### Changed

- Documented that consumer execution refs are reviewed 40-character commit SHA values.
- Clarified that version tags such as `v1.2.3` are human-facing release identifiers, not consumer rollout refs.
- Release readiness now rejects `--no-dry-run`; planning remains dry-run only.

### Fixed

- Recorded PR #32 and PR #33 plan-only capabilities in the release process before enabling any write workflow.
- Release readiness now blocks nonexistent or mismatched manifest SHAs, non-ancestor rollback/previous SHAs, and manifest file lists that differ from repository inventory.

### Security

- Release readiness remains read-only and does not create tags, releases, PRs, branch updates, queue updates, deploys, or GitHub API writes.

### Migration

- No migration is required for this unreleased release readiness foundation.

### Deprecated

- Consumer rollout by mutable refs, version tags, short SHAs, `main`, `master`, `latest`, or `HEAD` is not supported.

### Removed

- No runtime capability was removed.
