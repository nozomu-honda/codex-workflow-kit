import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanReleaseCli } from './plan-release.mjs';

const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PREVIOUS_SHA = '1111111111111111111111111111111111111111';

test('plan-release CLI help and usage errors are stable', async () => {
  const help = { stdout: '', stderr: '' };
  const usage = { stdout: '', stderr: '' };

  assert.equal(await runPlanReleaseCli(['--help'], {
    stdout: (message) => { help.stdout += message; },
    stderr: (message) => { usage.stderr += message; }
  }), 0);
  assert.match(help.stdout, /--manifest/);

  assert.equal(await runPlanReleaseCli(['--unknown'], {
    stdout: (message) => { usage.stdout += message; },
    stderr: (message) => { usage.stderr += message; }
  }), 2);
  assert.match(usage.stderr, /Unknown option/);
});

test('plan-release CLI JSON output is parseable and does not expose absolute paths or stack traces on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-plan-cli-'));
  try {
    await writeRepoFile(root, 'package.json', '{"version":"0.1.0","type":"module","scripts":{}}\n');
    await writeRepoFile(root, 'CHANGELOG.md', `# Changelog

## Unreleased

### Added

- Added release readiness planning for auto-merge-plan and main-follow-up-plan.

### Migration

- No migration is required.
`);
    await writeRepoFile(root, 'release/release-manifest.example.yml', `schemaVersion: 1
releaseVersion: 0.1.0
releaseCommitSha: ${RELEASE_SHA}
previousReleaseCommitSha: ${PREVIOUS_SHA}
releaseDate: 2026-07-14
capabilities:
  - config-validation
  - auto-merge-plan
  - main-follow-up-plan
changedCapabilities:
  - auto-merge-plan
  - main-follow-up-plan
breakingChanges: []
migrationRequired: false
actionArtifacts:
  - actions/validate-config/dist/index.js
reusableWorkflows:
  - .github/workflows/validate-config.yml
callerTemplates:
  - templates/workflows/validate-config.yml
schemas:
  - schemas/release-manifest.schema.json
rollbackCommitSha: ${PREVIOUS_SHA}
validationCommands:
  - npm run ci
`);
    await writeRepoFile(root, 'release/consumers.example.yml', `schemaVersion: 1
consumers:
  - repository: owner/example-repo
    defaultBranch: main
    configPath: .github/chatgpt-automation.yml
    callerWorkflowPaths:
      - .github/workflows/validate-config.yml
    currentKitRef: ${PREVIOUS_SHA}
    desiredCapabilitySet:
      - config-validation
    updatePolicy:
      allowDowngrade: false
      direction: forward
    manualReviewRequired: false
`);
    await writeRepoFile(root, '.github/workflows/example.yml', `jobs:
  check:
    steps:
      - uses: actions/checkout@${RELEASE_SHA}
`);

    const io = { stdout: '', stderr: '' };
    const exitCode = await runPlanReleaseCli(['--root', root, '--json'], {
      stdout: (message) => { io.stdout += message; },
      stderr: (message) => { io.stderr += message; }
    });
    const parsed = JSON.parse(io.stdout);

    assert.equal(exitCode, 1);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.blockers.some((entry) => entry.code === 'SOURCE_DIST_MISMATCH' || entry.code === 'SOURCE_DIST_STATUS_MISSING'), true);
    assert.equal(io.stdout.includes(root), false);
    assert.equal(`${io.stdout}\n${io.stderr}`.includes('Error:'), false);
    assert.equal(`${io.stdout}\n${io.stderr}`.includes('at '), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeRepoFile(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}
