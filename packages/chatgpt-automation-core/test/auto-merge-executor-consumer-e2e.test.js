import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeAutoMergeDryRun,
  REVIEW_EVIDENCE_REPORT_VERSION
} from '../src/auto-merge-executor/index.js';
import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS
} from '../../../fixtures/github-events/index.js';

const NOW = '2026-01-01T00:10:00.000Z';

test('offline E2E: PR #130相当のreview evidenceなしはcommandを生成しない', () => {
  const decision = executeAutoMergeDryRun(input({ reviewEvidenceReport: { approved: false } }));

  assert.equal(decision.eligible, false);
  assert.equal(decision.commandCreated, false);
  assert.equal(decision.reasonCodes.includes('review_evidence_missing'), true);
  assert.equal(decision.executed, false);
});

test('offline E2E: 安全なcurrent-head reviewed PRはcommand生成後write_disabledになる', () => {
  const decision = executeAutoMergeDryRun(input());

  assert.equal(decision.eligible, true, JSON.stringify(decision, null, 2));
  assert.equal(decision.commandCreated, true);
  assert.equal(decision.adapterAccepted, false);
  assert.equal(decision.executed, false);
  assert.equal(decision.reasonCodes.includes('write_disabled'), true);
});

test('offline E2E: stale review / protection不足 / consumer audit失敗 / head変更 / duplicateはblockする', () => {
  for (const [overrides, reasonCode] of [
    [{ reviewEvidenceReport: { headSha: FIXTURE_SHAS.before } }, 'stale_review_head'],
    [{ protectionAuditReport: { ready: false } }, 'protection_audit_not_ready'],
    [{ consumerAuditReport: { ready: false } }, 'consumer_audit_not_ready'],
    [{ executionContext: { headShaAtStart: FIXTURE_SHAS.head, headShaAtEnd: FIXTURE_SHAS.after } }, 'report_head_sha_mismatch'],
    [{ executionContext: { existingIdempotencyKeys: [expectedWriteIdempotencyKey()] } }, 'duplicate_operation']
  ]) {
    const decision = executeAutoMergeDryRun(input(overrides));

    assert.equal(decision.eligible, false, JSON.stringify(decision, null, 2));
    assert.equal(decision.commandCreated, false);
    assert.equal(decision.reasonCodes.includes(reasonCode), true, JSON.stringify(decision, null, 2));
    assert.equal(decision.executed, false);
  }
});

function input(overrides = {}) {
  const base = {
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
        { conclusion: 'success', headSha: FIXTURE_SHAS.head, name: 'CI', status: 'completed' },
        { conclusion: 'success', headSha: FIXTURE_SHAS.head, name: 'Review evidence gate', status: 'completed' }
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
      warnings: []
    }
  };

  return merge(base, overrides);
}

function merge(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = {
      ...base[key],
      ...value
    };
  }
  return result;
}

function expectedWriteIdempotencyKey() {
  return `write-v1:enable-auto-merge:${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:${FIXTURE_SHAS.base}`;
}
