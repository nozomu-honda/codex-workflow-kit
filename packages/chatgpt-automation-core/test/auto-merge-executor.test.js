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
const RUN_STARTED_AT = '2026-01-01T00:09:00.000Z';
const REVIEWED_AT = '2026-01-01T00:08:00.000Z';
const CHECKED_AT = '2026-01-01T00:08:30.000Z';
const ACTOR_CONTEXT = Object.freeze({
  actor: 'github-actions[bot]',
  isFork: false,
  isTrusted: true,
  source: 'auto-merge-dry-run'
});

test('全read-only条件成功時はcommandを生成し、Disabled adapterでwrite_disabledにする', () => {
  const decision = executeAutoMergeDryRun(baseInput());

  assert.equal(decision.ok, true, JSON.stringify(decision, null, 2));
  assert.equal(decision.eligible, true);
  assert.equal(decision.shouldCreateWriteCommand, true);
  assert.equal(decision.commandCreated, true);
  assert.equal(decision.commandValid, true);
  assert.equal(decision.adapterAccepted, false);
  assert.equal(decision.executed, false);
  assert.equal(decision.command.operation, 'enable-auto-merge');
  assert.equal(decision.reasonCodes.includes('write_disabled'), true);
  assert.equal(JSON.stringify(decision).includes('Authorization'), false);
});

test('review evidenceなし、stale head、changes requested、未解決thread、同一run内evidenceはcommandを生成しない', () => {
  assertBlocked(
    baseInput({ reviewEvidenceReport: { approved: false } }),
    'review_evidence_missing'
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { headSha: FIXTURE_SHAS.before } }),
    'stale_review_head'
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { changesRequested: true } }),
    'changes_requested'
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { unresolvedReviewThreads: 1 } }),
    'unresolved_review_thread'
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { reviewedAt: RUN_STARTED_AT } }),
    'review_evidence_from_current_run'
  );
});

test('current-headの有効review evidenceだけを許可する', () => {
  const decision = executeAutoMergeDryRun(baseInput({
    reviewEvidenceReport: {
      approved: true,
      headSha: FIXTURE_SHAS.head,
      reviewedAt: REVIEWED_AT
    }
  }));

  assert.equal(decision.eligible, true, JSON.stringify(decision, null, 2));
  assert.deepEqual(decision.blockers, []);
});

test('plan / consumer / protection / base SHAの不一致をfail closedにする', () => {
  assertBlocked(
    baseInput({ autoMergePlanOutputs: { head_sha: FIXTURE_SHAS.after } }),
    'report_head_sha_mismatch'
  );
  assertBlocked(
    baseInput({ consumerAuditReport: { targetHeadSha: FIXTURE_SHAS.after } }),
    'report_head_sha_mismatch'
  );
  assertBlocked(
    baseInput({ protectionAuditReport: { auditedSha: FIXTURE_SHAS.after } }),
    'report_base_sha_mismatch'
  );
  assertBlocked(
    baseInput({ pullRequestSnapshot: { baseSha: FIXTURE_SHAS.after } }),
    'report_base_sha_mismatch'
  );
  assertBlocked(
    baseInput({ executionContext: { headShaAtStart: FIXTURE_SHAS.head, headShaAtEnd: FIXTURE_SHAS.after } }),
    'report_head_sha_mismatch'
  );
});

test('CI失敗、pending、required check不足、Review evidence gate不足、duplicate checkをblockする', () => {
  assertBlocked(
    baseInput({ checkSnapshot: { ciSuccessful: false } }),
    'ci_not_successful'
  );
  assertBlocked(
    baseInput({ checkSnapshot: { requiredChecks: checks([{ name: 'CI', conclusion: 'pending', status: 'in_progress' }]) } }),
    'ci_not_successful'
  );
  assertBlocked(
    baseInput({ checkSnapshot: { requiredChecks: checks([{ name: 'CI' }]).filter((check) => check.name !== 'Review evidence gate') } }),
    'required_check_missing'
  );
  assertBlocked(
    baseInput({ checkSnapshot: { reviewEvidenceGateSuccessful: false } }),
    'required_check_missing'
  );
  assertBlocked(
    baseInput({ checkSnapshot: { duplicateChecks: true } }),
    'required_check_missing'
  );
});

test('consumer / protection audit block、schema不正、期限切れ、pagination不完了、API read failureをblockする', () => {
  assertBlocked(
    baseInput({ consumerAuditReport: { ready: false } }),
    'consumer_audit_not_ready'
  );
  assertBlocked(
    baseInput({ protectionAuditReport: { ready: false } }),
    'protection_audit_not_ready'
  );
  assertBlocked(
    baseInput({ consumerAuditReport: { unexpected: true } }),
    'report_schema_invalid'
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { checkedAt: '2025-12-30T00:00:00.000Z' } }),
    'report_expired'
  );
  assertBlocked(
    baseInput({ consumerAuditReport: { paginationComplete: false } }),
    'consumer_audit_not_ready'
  );
  assertBlocked(
    baseInput({ protectionAuditReport: { apiReadOk: false } }),
    'protection_audit_not_ready'
  );
});

test('fork、draft、closed PR、dangerous files、workflow権限増加、pull_request_target、Secret-like追加をblockする', () => {
  assertBlocked(
    baseInput({ pullRequestSnapshot: { isFork: true, isSameRepository: false } }),
    'unknown_state'
  );
  assertBlocked(
    baseInput({ pullRequestSnapshot: { draft: true } }),
    'unknown_state'
  );
  assertBlocked(
    baseInput({ pullRequestSnapshot: { state: 'closed' } }),
    'unknown_state'
  );
  assertBlocked(
    baseInput({ changedFilesSnapshot: { dangerousChange: true } }),
    'dangerous_change_detected'
  );
  assertBlocked(
    baseInput({ changedFilesSnapshot: { workflowPermissionIncrease: true } }),
    'dangerous_change_detected'
  );
  assertBlocked(
    baseInput({ changedFilesSnapshot: { pullRequestTarget: true } }),
    'dangerous_change_detected'
  );
  assertBlocked(
    baseInput({ changedFilesSnapshot: { secretLikeChange: true } }),
    'secret_like_change_detected'
  );
});

test('duplicate、attempt limit、cooldown、actor trust欠落、command validation失敗をfail closedにする', () => {
  assertBlocked(
    baseInput({ executionContext: { existingIdempotencyKeys: [expectedWriteIdempotencyKey()] } }),
    'duplicate_operation'
  );
  assertBlocked(
    baseInput({ executionContext: { attemptCount: 3, maxAttempts: 3 } }),
    'attempt_limit_exceeded'
  );
  assertBlocked(
    baseInput({ executionContext: { cooldownSeconds: 600, lastAttemptedAt: '2026-01-01T00:05:00.000Z' } }),
    'cooldown_active'
  );
  assertBlocked(
    baseInput({ executionContext: { actorContext: { ...ACTOR_CONTEXT, isTrusted: false } } }),
    'unknown_state'
  );
  assertBlocked(
    baseInput({ executionContext: { requestedAt: '1970-01-01T00:00:00.000Z' } }),
    'write_command_invalid',
    { commandCreated: true }
  );
});

test('sanitized audit recordは許可fieldだけを出し、report全文やsecret-like値を含めない', () => {
  const decision = executeAutoMergeDryRun(baseInput({
    changedFilesSnapshot: {
      files: [
        {
          filename: 'docs/example.md',
          patch: '+Authorization: Bearer example-token'
        }
      ]
    }
  }));
  const text = JSON.stringify(decision);

  assert.equal(decision.auditRecord.commandOperation, 'enable-auto-merge');
  assert.equal(text.includes('Bearer example-token'), false);
  assert.deepEqual(Object.keys(decision.auditRecord).sort(), [
    'accepted',
    'blockerReasonCodes',
    'commandOperation',
    'dryRun',
    'executed',
    'expectedBaseSha',
    'expectedHeadSha',
    'pullRequestNumber',
    'reasonCodes',
    'reportVersion',
    'repository',
    'result'
  ].sort());
});

function baseInput(overrides = {}) {
  const autoMergePlanOutputs = {
    base_sha: FIXTURE_SHAS.base,
    dedupe_key: `${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:enable-auto-merge:v1`,
    dry_run: 'true',
    eligible: 'true',
    head_sha: FIXTURE_SHAS.head,
    merge_reason: 'eligible_enable_auto_merge',
    pull_request_number: '42',
    repository: FIXTURE_REPOSITORY.fullName,
    should_enable_auto_merge: 'true',
    should_merge: 'false',
    ...(overrides.autoMergePlanOutputs ?? {})
  };
  const executionContext = {
    actorContext: ACTOR_CONTEXT,
    allowedBaseBranches: [FIXTURE_REPOSITORY.defaultBranch],
    attemptCount: 0,
    cooldownSeconds: 0,
    currentBaseSha: FIXTURE_SHAS.base,
    currentHeadSha: FIXTURE_SHAS.head,
    existingIdempotencyKeys: [],
    maxAttempts: 3,
    now: NOW,
    pullRequestNumber: 42,
    reportMaxAgeMs: 24 * 60 * 60 * 1000,
    repository: FIXTURE_REPOSITORY.fullName,
    requestedAt: NOW,
    requiredChecks: ['CI', 'Review evidence gate'],
    runStartedAt: RUN_STARTED_AT,
    ...(overrides.executionContext ?? {})
  };

  return {
    autoMergePlan: {
      outputs: autoMergePlanOutputs
    },
    changedFilesSnapshot: {
      apiReadOk: true,
      dangerousChange: false,
      files: [],
      headSha: FIXTURE_SHAS.head,
      pullRequestTarget: false,
      secretLikeChange: false,
      workflowPermissionIncrease: false,
      ...(overrides.changedFilesSnapshot ?? {})
    },
    checkSnapshot: {
      apiReadOk: true,
      ciSuccessful: true,
      duplicateChecks: false,
      headSha: FIXTURE_SHAS.head,
      paginationComplete: true,
      requiredChecks: checks(),
      requiredChecksSuccessful: true,
      reviewEvidenceGateSuccessful: true,
      ...(overrides.checkSnapshot ?? {})
    },
    consumerAuditReport: {
      apiReadOk: true,
      checkedAt: CHECKED_AT,
      manualReviewRequired: false,
      paginationComplete: true,
      pullRequestNumber: 42,
      ready: true,
      repository: FIXTURE_REPOSITORY.fullName,
      reportVersion: 'live-consumer-audit.v1',
      targetHeadSha: FIXTURE_SHAS.head,
      blockers: [],
      warnings: [],
      ...(overrides.consumerAuditReport ?? {})
    },
    executionContext,
    protectionAuditReport: {
      apiReadOk: true,
      auditedSha: FIXTURE_SHAS.base,
      checkedAt: CHECKED_AT,
      defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
      manualReviewRequired: false,
      paginationComplete: true,
      pullRequestNumber: 42,
      ready: true,
      repository: FIXTURE_REPOSITORY.fullName,
      reportVersion: 1,
      blockers: [],
      warnings: [],
      ...(overrides.protectionAuditReport ?? {})
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
      state: 'open',
      ...(overrides.pullRequestSnapshot ?? {})
    },
    reviewEvidenceReport: {
      apiReadOk: true,
      approved: true,
      baseSha: FIXTURE_SHAS.base,
      checkedAt: CHECKED_AT,
      currentRunEvidence: false,
      evidenceType: 'chatgpt-marker',
      headSha: FIXTURE_SHAS.head,
      paginationComplete: true,
      pullRequestNumber: 42,
      reportVersion: REVIEW_EVIDENCE_REPORT_VERSION,
      repository: FIXTURE_REPOSITORY.fullName,
      requestedReviewers: 0,
      requestedTeams: 0,
      reviewedAt: REVIEWED_AT,
      unresolvedReviewThreads: 0,
      blockers: [],
      warnings: [],
      ...(overrides.reviewEvidenceReport ?? {})
    }
  };
}

function checks(overrides = []) {
  const byName = new Map([
    ['CI', {
      conclusion: 'success',
      headSha: FIXTURE_SHAS.head,
      name: 'CI',
      status: 'completed'
    }],
    ['Review evidence gate', {
      conclusion: 'success',
      headSha: FIXTURE_SHAS.head,
      name: 'Review evidence gate',
      status: 'completed'
    }]
  ]);
  for (const override of overrides) {
    byName.set(override.name, {
      ...(byName.get(override.name) ?? {}),
      ...override
    });
  }
  return [...byName.values()];
}

function expectedWriteIdempotencyKey() {
  return `write-v1:enable-auto-merge:${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:${FIXTURE_SHAS.base}`;
}

function assertBlocked(input, reasonCode, expectations = {}) {
  const decision = executeAutoMergeDryRun(input);
  assert.equal(decision.eligible, false, JSON.stringify(decision, null, 2));
  assert.equal(decision.reasonCodes.includes(reasonCode), true, JSON.stringify(decision, null, 2));
  assert.equal(decision.executed, false);
  if (expectations.commandCreated !== undefined) {
    assert.equal(decision.commandCreated, expectations.commandCreated);
  } else {
    assert.equal(decision.commandCreated, false);
  }
}
