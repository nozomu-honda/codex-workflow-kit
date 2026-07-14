# Changelog

## Unreleased

### Added

- Added release readiness planning for `auto-merge-plan` and `main-follow-up-plan`.
- Added read-only release manifest and consumer inventory examples for fixed-SHA rollout planning.
- Added fixed ref audit coverage for reusable workflows, caller templates, docs examples, and fixtures.

### Changed

- Documented that consumer execution refs are reviewed 40-character commit SHA values.
- Clarified that version tags such as `v1.2.3` are human-facing release identifiers, not consumer rollout refs.

### Fixed

- Recorded PR #32 and PR #33 plan-only capabilities in the release process before enabling any write workflow.

### Security

- Release readiness remains read-only and does not create tags, releases, PRs, branch updates, queue updates, deploys, or GitHub API writes.

### Migration

- No migration is required for this unreleased release readiness foundation.

### Deprecated

- Consumer rollout by mutable refs, version tags, short SHAs, `main`, `master`, `latest`, or `HEAD` is not supported.

### Removed

- No runtime capability was removed.
