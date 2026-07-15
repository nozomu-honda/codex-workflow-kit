import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS
} from '../fixtures/github-events/index.js';
import { REVIEW_EVIDENCE_REPORT_VERSION } from '../packages/chatgpt-automation-core/src/auto-merge-executor/index.js';

const SCRIPT = 'scripts/execute-auto-merge-dry-run.mjs';
const NOW = '2026-01-01T00:10:00.000Z';

test('execute-auto-merge-dry-run CLIはfile入力からdeterministic JSONを返す', () => {
  const temp = writeInputs(baseInput());
  try {
    const result = runCli([
      ...fileArgs(temp.files),
      '--json'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.eligible, true);
    assert.equal(parsed.commandCreated, true);
    assert.equal(parsed.executed, false);
    assert.equal(parsed.reasonCodes.includes('write_disabled'), true);
  } finally {
    temp.cleanup();
  }
});

test('execute-auto-merge-dry-run CLIはvalidなblock decisionをexit 0でsanitized JSONとして返す', () => {
  const temp = writeInputs(baseInput({
    reviewEvidenceReport: {
      approved: false
    }
  }));
  try {
    const result = runCli([
      ...fileArgs(temp.files),
      '--json'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.eligible, false);
    assert.equal(parsed.reasonCodes.includes('review_evidence_missing'), true);
    assert.equal(parsed.commandCreated, false);
    assert.equal(parsed.adapterAccepted, false);
    assert.equal(parsed.executed, false);
  } finally {
    temp.cleanup();
  }
});

test('execute-auto-merge-dry-run CLIはJSON parse failureをsystem errorとしてnon-zeroにする', () => {
  const temp = writeInputs(baseInput());
  try {
    writeFileSync(temp.files['review-evidence'], '{invalid-json');
    const result = runCli([
      ...fileArgs(temp.files),
      '--json'
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /failed without exposing stack trace/);
  } finally {
    temp.cleanup();
  }
});

test('execute-auto-merge-dry-run CLIは--no-dry-runを拒否する', () => {
  const result = runCli(['--no-dry-run']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--no-dry-run is not supported/);
});

function writeInputs(input) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-merge-dry-run-'));
  const files = {
    'auto-merge-plan': writeJson(dir, 'auto-merge-plan.json', input.autoMergePlan),
    'changed-files': writeJson(dir, 'changed-files.json', input.changedFilesSnapshot),
    checks: writeJson(dir, 'checks.json', input.checkSnapshot),
    'consumer-audit': writeJson(dir, 'consumer-audit.json', input.consumerAuditReport),
    'execution-context': writeJson(dir, 'execution-context.json', input.executionContext),
    'protection-audit': writeJson(dir, 'protection-audit.json', input.protectionAuditReport),
    'pull-request': writeJson(dir, 'pull-request.json', input.pullRequestSnapshot),
    'review-evidence': writeJson(dir, 'review-evidence.json', input.reviewEvidenceReport)
  };
  return {
    files,
    cleanup: () => rmSync(dir, { force: true, recursive: true })
  };
}

function writeJson(dir, name, value) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function fileArgs(files) {
  return Object.entries(files).flatMap(([name, file]) => [`--${name}`, file]);
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
}

function baseInput(overrides = {}) {
  return {
    autoMergePlan: {
      outputs: {
        base_sha: FIXTURE_SHAS.base,
        dedupe_key: `${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:enable-auto-merge:v1`,
        dry_run: 'true',
        eligible: 'true',
        head_sha: FIXTURE_SHAS.head,
        merge_reason: 'eligible_enable_auto_merge',
        pull_request_number: '42',
        repository: FIXTURE_REPOSITORY.fullName,
        should_enable_auto_merge: 'true',
        should_merge: 'false'
      }
    },
    changedFilesSnapshot: {
      apiReadOk: true,
      dangerousChange: false,
      files: [],
      headSha: FIXTURE_SHAS.head,
      pullRequestTarget: false,
      secretLikeChange: false,
      workflowPermissionIncrease: false
    },
    checkSnapshot: {
      apiReadOk: true,
      ciSuccessful: true,
      duplicateChecks: false,
      headSha: FIXTURE_SHAS.head,
      paginationComplete: true,
      requiredChecks: [
        {
          conclusion: 'success',
          headSha: FIXTURE_SHAS.head,
          name: 'CI',
          status: 'completed'
        },
        {
          conclusion: 'success',
          headSha: FIXTURE_SHAS.head,
          name: 'Review evidence gate',
          status: 'completed'
        }
      ],
      requiredChecksSuccessful: true,
      reviewEvidenceGateSuccessful: true
    },
    consumerAuditReport: {
      apiReadOk: true,
      blockers: [],
      checkedAt: '2026-01-01T00:08:30.000Z',
      manualReviewRequired: false,
      paginationComplete: true,
      pullRequestNumber: 42,
      ready: true,
      repository: FIXTURE_REPOSITORY.fullName,
      reportVersion: 'live-consumer-audit.v1',
      targetHeadSha: FIXTURE_SHAS.head,
      warnings: []
    },
    executionContext: {
      actorContext: {
        actor: 'github-actions[bot]',
        isFork: false,
        isTrusted: true,
        source: 'auto-merge-dry-run'
      },
      allowedBaseBranches: [FIXTURE_REPOSITORY.defaultBranch],
      attemptCount: 0,
      cooldownSeconds: 0,
      currentBaseSha: FIXTURE_SHAS.base,
      currentHeadSha: FIXTURE_SHAS.head,
      existingIdempotencyKeys: [],
      maxAttempts: 3,
      now: NOW,
      pullRequestNumber: 42,
      repository: FIXTURE_REPOSITORY.fullName,
      requestedAt: NOW,
      requiredChecks: ['CI', 'Review evidence gate'],
      runStartedAt: '2026-01-01T00:09:00.000Z'
    },
    protectionAuditReport: {
      apiReadOk: true,
      auditedSha: FIXTURE_SHAS.base,
      blockers: [],
      checkedAt: '2026-01-01T00:08:30.000Z',
      defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
      manualReviewRequired: false,
      paginationComplete: true,
      pullRequestNumber: 42,
      ready: true,
      repository: FIXTURE_REPOSITORY.fullName,
      reportVersion: 1,
      warnings: []
    },
    pullRequestSnapshot: {
      baseBranch: FIXTURE_REPOSITORY.defaultBranch,
      baseSha: FIXTURE_SHAS.base,
      draft: false,
      headSha: FIXTURE_SHAS.head,
      isFork: false,
      isSameRepository: true,
      mergeStateStatus: 'clean',
      mergeable: true,
      pullRequestNumber: 42,
      repository: FIXTURE_REPOSITORY.fullName,
      requestedReviewers: 0,
      requestedTeams: 0,
      state: 'open'
    },
    reviewEvidenceReport: {
      apiReadOk: true,
      approved: true,
      baseSha: FIXTURE_SHAS.base,
      blockers: [],
      changesRequested: false,
      checkedAt: '2026-01-01T00:08:30.000Z',
      currentRunEvidence: false,
      evidenceType: 'chatgpt-marker',
      headSha: FIXTURE_SHAS.head,
      paginationComplete: true,
      pullRequestNumber: 42,
      reportVersion: REVIEW_EVIDENCE_REPORT_VERSION,
      repository: FIXTURE_REPOSITORY.fullName,
      requestedReviewers: 0,
      requestedTeams: 0,
      reviewedAt: '2026-01-01T00:08:00.000Z',
      unresolvedReviewThreads: 0,
      warnings: [],
      ...(overrides.reviewEvidenceReport ?? {})
    }
  };
}
