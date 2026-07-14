import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

  const noDryRun = { stdout: '', stderr: '' };
  assert.equal(await runPlanReleaseCli(['--no-dry-run'], {
    stdout: (message) => { noDryRun.stdout += message; },
    stderr: (message) => { noDryRun.stderr += message; }
  }), 2);
  assert.match(noDryRun.stderr, /not supported/);
});

test('plan-release CLI default and --dry-run JSON output stays parseable and dry-run only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-plan-cli-'));
  try {
    await writeMinimalReleaseFixture(root);

    const defaultIo = { stdout: '', stderr: '' };
    const dryRunIo = { stdout: '', stderr: '' };
    const defaultExit = await runPlanReleaseCli(['--root', root, '--json'], {
      stdout: (message) => { defaultIo.stdout += message; },
      stderr: (message) => { defaultIo.stderr += message; }
    });
    const dryRunExit = await runPlanReleaseCli(['--root', root, '--dry-run', '--json'], {
      stdout: (message) => { dryRunIo.stdout += message; },
      stderr: (message) => { dryRunIo.stderr += message; }
    });
    const defaultPlan = JSON.parse(defaultIo.stdout);
    const dryRunPlan = JSON.parse(dryRunIo.stdout);

    assert.equal(defaultExit, 1);
    assert.equal(dryRunExit, 1);
    assert.equal(defaultPlan.dryRun, true);
    assert.equal(dryRunPlan.dryRun, true);
    assert.equal(defaultPlan.ready, false);
    assert.equal(defaultPlan.blockers.some((entry) => entry.code === 'RELEASE_GIT_STATE_UNAVAILABLE'), true);
    assert.equal(defaultIo.stdout.includes(root), false);
    assert.equal(`${defaultIo.stdout}\n${defaultIo.stderr}`.includes('Error:'), false);
    assert.equal(`${defaultIo.stdout}\n${defaultIo.stderr}`.includes('at '), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan-release CLI can replace fixture SHAs with checked-out git state for dry-run planning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-plan-cli-git-'));
  try {
    await writeMinimalReleaseFixture(root);
    initializeGitRepository(root);

    const fixtureOnly = { stdout: '', stderr: '' };
    const fixtureExit = await runPlanReleaseCli(['--root', root, '--json'], {
      stdout: (message) => { fixtureOnly.stdout += message; },
      stderr: (message) => { fixtureOnly.stderr += message; }
    });
    const fixturePlan = JSON.parse(fixtureOnly.stdout);
    const io = { stdout: '', stderr: '' };
    const exitCode = await runPlanReleaseCli(['--root', root, '--use-current-git-shas', '--json'], {
      stdout: (message) => { io.stdout += message; },
      stderr: (message) => { io.stderr += message; }
    });
    const parsed = JSON.parse(io.stdout);

    assert.equal(fixtureExit, 1);
    assert.equal(fixturePlan.ready, false);
    assert.equal(fixturePlan.blockers.some((entry) => entry.code === 'RELEASE_COMMIT_NOT_FOUND'), true);
    assert.equal(exitCode, 1);
    assert.equal(parsed.dryRun, true);
    assert.match(parsed.releaseCommitSha, /^[a-f0-9]{40}$/);
    assert.notEqual(parsed.releaseCommitSha, RELEASE_SHA);
    assert.equal(parsed.blockers.some((entry) => entry.code === 'RELEASE_COMMIT_HEAD_MISMATCH'), false);
    assert.equal(parsed.blockers.some((entry) => entry.code === 'SOURCE_DIST_MISMATCH' || entry.code === 'SOURCE_DIST_STATUS_MISSING'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan-release CLI JSON output does not expose absolute paths or stack traces on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-plan-cli-output-'));
  try {
    await writeMinimalReleaseFixture(root);
    const io = { stdout: '', stderr: '' };
    const exitCode = await runPlanReleaseCli(['--root', root, '--json'], {
      stdout: (message) => { io.stdout += message; },
      stderr: (message) => { io.stderr += message; }
    });
    const parsed = JSON.parse(io.stdout);

    assert.equal(exitCode, 1);
    assert.equal(parsed.ready, false);
    assert.equal(io.stdout.includes(root), false);
    assert.equal(`${io.stdout}\n${io.stderr}`.includes('Error:'), false);
    assert.equal(`${io.stdout}\n${io.stderr}`.includes('at '), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeMinimalReleaseFixture(root) {
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
  await writeRepoFile(root, '.github/workflows/validate-config.yml', `on:
  workflow_call:
jobs:
  check:
    steps:
      - uses: actions/checkout@${RELEASE_SHA}
`);
  await writeRepoFile(root, '.github/workflows/example.yml', `jobs:
  check:
    steps:
      - uses: actions/checkout@${RELEASE_SHA}
`);
  await writeRepoFile(root, 'templates/workflows/validate-config.yml', 'name: Validate config\n');
  await writeRepoFile(root, 'schemas/release-manifest.schema.json', '{}\n');
  await writeRepoFile(root, 'actions/validate-config/dist/index.js', 'console.log("fixture");\n');
}

function initializeGitRepository(root) {
  run(root, ['init']);
  run(root, ['add', '.']);
  run(root, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'initial']);
  writeFileSyncFixture(root, 'fixture.txt', 'second\n');
  run(root, ['add', '.']);
  run(root, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'second']);
}

function run(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
}

function writeFileSyncFixture(root, relativePath, content) {
  writeFileSync(join(root, relativePath), content);
}

async function writeRepoFile(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}
