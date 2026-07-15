import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  executeAutoMergeDryRun,
  REPORT_FUTURE_CLOCK_SKEW_MS,
  REVIEW_EVIDENCE_REPORT_VERSION
} from '../src/auto-merge-executor/index.js';
import {
  LIVE_CONSUMER_WORKFLOW_SPECS,
  auditLiveConsumerInstallation
} from '../src/consumer-audit/index.js';
import {
  DEFAULT_PROTECTION_POLICY,
  auditRepositoryProtection
} from '../src/protection-audit/index.js';
import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS
} from '../../../fixtures/github-events/index.js';

const NOW = '2026-01-01T00:10:00.000Z';
const RUN_STARTED_AT = '2026-01-01T00:09:00.000Z';
const REVIEWED_AT = '2026-01-01T00:08:00.000Z';
const CHECKED_AT = '2026-01-01T00:08:30.000Z';
const KIT_REF = FIXTURE_SHAS.base;
const CONFIG_SOURCE = readFileSync(new URL('../../../templates/chatgpt-automation.yml', import.meta.url), 'utf8');
const VALIDATE_CONFIG_WORKFLOW_SOURCE = readFileSync(new URL('../../../templates/workflows/validate-config.yml', import.meta.url), 'utf8')
  .replaceAll('REPLACE_WITH_40_CHAR_COMMIT_SHA', KIT_REF);
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
    baseInput({ reviewEvidenceReport: { checkedAt: RUN_STARTED_AT, reviewedAt: RUN_STARTED_AT } }),
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

test('changed-files reportはcurrent headと完全一致する完全なschemaだけを許可する', () => {
  assertBlocked(
    baseInput({ changedFilesSnapshot: { headSha: FIXTURE_SHAS.before } }),
    'report_head_sha_mismatch'
  );
  assertBlocked(
    withoutField(baseInput(), 'changedFilesSnapshot', 'headSha'),
    'report_schema_invalid'
  );
  assertBlocked(
    withoutField(baseInput(), 'changedFilesSnapshot', 'apiReadOk'),
    'report_schema_invalid'
  );

  const emptyChangedFiles = baseInput();
  emptyChangedFiles.changedFilesSnapshot = {};
  assertBlocked(emptyChangedFiles, 'report_schema_invalid');

  assertBlocked(
    baseInput({ changedFilesSnapshot: { apiReadOk: 'true' } }),
    'report_schema_invalid'
  );
});

test('review evidence reportのread・pagination・timestamp・blockersをfail closedに検証する', () => {
  for (const field of ['apiReadOk', 'paginationComplete', 'checkedAt', 'reviewedAt']) {
    assertBlocked(
      withoutField(baseInput(), 'reviewEvidenceReport', field),
      'report_schema_invalid'
    );
  }
  assertBlocked(
    baseInput({
      reviewEvidenceReport: {
        blockers: [{ reasonCode: 'changes_requested', message: 'Review remains unresolved.' }]
      }
    }),
    'review_evidence_missing'
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { paginationComplete: 'true' } }),
    'report_schema_invalid'
  );
});

test('consumer audit reportのread・pagination・timestamp・manual review・blockersをrequiredにする', () => {
  for (const field of [
    'apiReadOk',
    'paginationComplete',
    'checkedAt',
    'manualReviewRequired',
    'blockers'
  ]) {
    assertBlocked(
      withoutField(baseInput(), 'consumerAuditReport', field),
      'report_schema_invalid'
    );
  }
  assertBlocked(
    baseInput({ consumerAuditReport: { apiReadOk: 'true' } }),
    'report_schema_invalid'
  );
  assertBlocked(
    baseInput({ consumerAuditReport: { manualReviewRequired: true } }),
    'consumer_audit_not_ready'
  );
  assertBlocked(
    baseInput({
      consumerAuditReport: {
        blockers: [{ reasonCode: 'consumer_config_invalid', message: 'Consumer audit is blocked.' }]
      }
    }),
    'consumer_audit_not_ready'
  );
});

test('protection audit reportのread・pagination・timestamp・manual review・blockersをrequiredにする', () => {
  for (const field of [
    'apiReadOk',
    'paginationComplete',
    'checkedAt',
    'manualReviewRequired',
    'blockers'
  ]) {
    assertBlocked(
      withoutField(baseInput(), 'protectionAuditReport', field),
      'report_schema_invalid'
    );
  }
  assertBlocked(
    baseInput({ protectionAuditReport: { paginationComplete: 1 } }),
    'report_schema_invalid'
  );
  assertBlocked(
    baseInput({ protectionAuditReport: { manualReviewRequired: true } }),
    'protection_audit_not_ready'
  );
  assertBlocked(
    baseInput({
      protectionAuditReport: {
        blockers: [{ reasonCode: 'required_check_missing', message: 'Protection audit is blocked.' }]
      }
    }),
    'protection_audit_not_ready'
  );
});

test('current headに一致する完全なreportだけがeligibleになる', () => {
  const decision = executeAutoMergeDryRun(baseInput());

  assert.equal(decision.eligible, true, JSON.stringify(decision, null, 2));
  assert.deepEqual(decision.blockers, []);
  assert.equal(decision.currentHeadSha, FIXTURE_SHAS.head);
});

test('producer由来のconsumer/protection audit reportをexecutorへ直接渡せる', () => {
  const input = baseInput({
    consumerAuditReport: producerConsumerAuditReport(),
    protectionAuditReport: producerProtectionAuditReport()
  });
  const decision = executeAutoMergeDryRun(input);

  assert.equal(input.consumerAuditReport.apiReadOk, true);
  assert.equal(input.consumerAuditReport.paginationComplete, true);
  assert.equal(input.consumerAuditReport.auditedCommitSha, FIXTURE_SHAS.base);
  assert.equal(input.protectionAuditReport.apiReadOk, true);
  assert.equal(input.protectionAuditReport.paginationComplete, true);
  assert.equal(input.protectionAuditReport.auditedSha, FIXTURE_SHAS.base);
  assert.equal(decision.eligible, true, JSON.stringify(decision, null, 2));
  assert.equal(decision.reasonCodes.includes('write_disabled'), true);
});

test('producer由来audit reportのAPI failure、pagination、audited SHA不一致をblockする', () => {
  assertBlocked(
    baseInput({
      consumerAuditReport: producerConsumerAuditReport({
        snapshot: { apiErrors: [{ code: 'api_permission_denied', path: '/actions/workflows' }] }
      })
    }),
    'consumer_audit_not_ready'
  );
  assertBlocked(
    baseInput({
      consumerAuditReport: producerConsumerAuditReport({
        snapshot: { paginationIncomplete: true }
      })
    }),
    'consumer_audit_not_ready'
  );
  assertBlocked(
    baseInput({
      consumerAuditReport: producerConsumerAuditReport({
        auditedCommitSha: FIXTURE_SHAS.after
      })
    }),
    'report_base_sha_mismatch'
  );
  assertBlocked(
    baseInput({
      protectionAuditReport: producerProtectionAuditReport({
        apiErrors: [{ code: 'protection_api_forbidden', message: 'forbidden', path: 'rulesets' }]
      })
    }),
    'protection_audit_not_ready'
  );
  assertBlocked(
    baseInput({
      protectionAuditReport: producerProtectionAuditReport({
        pagination: { rulesetsComplete: false }
      })
    }),
    'protection_audit_not_ready'
  );
  assertBlocked(
    baseInput({
      protectionAuditReport: producerProtectionAuditReport({
        defaultBranchSha: FIXTURE_SHAS.after
      })
    }),
    'report_base_sha_mismatch'
  );
});

test('plan / consumer / protection / base SHAの不一致をfail closedにする', () => {
  assertBlocked(
    baseInput({ autoMergePlanOutputs: { head_sha: FIXTURE_SHAS.after } }),
    'report_head_sha_mismatch'
  );
  assertBlocked(
    baseInput({ consumerAuditReport: { auditedCommitSha: FIXTURE_SHAS.after } }),
    'report_base_sha_mismatch'
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

test('report timestampはexecution時刻より未来すぎる場合にfail closedになる', () => {
  assertBlocked(
    baseInput({ consumerAuditReport: { checkedAt: plusMs(NOW, REPORT_FUTURE_CLOCK_SKEW_MS + 1) } }),
    'report_from_future',
    { commandCreated: false }
  );
  assertBlocked(
    baseInput({ protectionAuditReport: { checkedAt: plusMs(NOW, REPORT_FUTURE_CLOCK_SKEW_MS + 1) } }),
    'report_from_future',
    { commandCreated: false }
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { checkedAt: plusMs(NOW, REPORT_FUTURE_CLOCK_SKEW_MS + 1) } }),
    'report_from_future',
    { commandCreated: false }
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { reviewedAt: plusMs(NOW, REPORT_FUTURE_CLOCK_SKEW_MS + 1) } }),
    'report_from_future',
    { commandCreated: false }
  );
  assertBlocked(
    baseInput({ reviewEvidenceReport: { reviewedAt: plusMs(CHECKED_AT, 1) } }),
    'report_from_future',
    { commandCreated: false }
  );
});

test('report timestampのclock skew境界と通常timestampをdeterministicに扱う', () => {
  const withinSkew = executeAutoMergeDryRun(baseInput({
    consumerAuditReport: { checkedAt: plusMs(NOW, REPORT_FUTURE_CLOCK_SKEW_MS - 1) }
  }));
  const exactSkew = executeAutoMergeDryRun(baseInput({
    consumerAuditReport: { checkedAt: plusMs(NOW, REPORT_FUTURE_CLOCK_SKEW_MS) }
  }));
  const nowTimestamp = executeAutoMergeDryRun(baseInput({
    consumerAuditReport: { checkedAt: NOW }
  }));
  const normalPast = executeAutoMergeDryRun(baseInput({
    consumerAuditReport: { checkedAt: CHECKED_AT }
  }));

  assert.equal(withinSkew.eligible, true, JSON.stringify(withinSkew, null, 2));
  assert.equal(exactSkew.eligible, true, JSON.stringify(exactSkew, null, 2));
  assert.equal(nowTimestamp.eligible, true, JSON.stringify(nowTimestamp, null, 2));
  assert.equal(normalPast.eligible, true, JSON.stringify(normalPast, null, 2));
  assertBlocked(
    baseInput({ consumerAuditReport: { checkedAt: plusMs(NOW, REPORT_FUTURE_CLOCK_SKEW_MS + 1) } }),
    'report_from_future'
  );
  assertBlocked(
    baseInput({ consumerAuditReport: { checkedAt: '2025-12-30T00:00:00.000Z' } }),
    'report_expired'
  );
  assertBlocked(
    baseInput({ consumerAuditReport: { checkedAt: 'not-a-date' } }),
    'report_schema_invalid'
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
    'write_command_invalid'
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
      auditedCommitSha: FIXTURE_SHAS.base,
      checkedAt: CHECKED_AT,
      defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
      manualReviewRequired: false,
      paginationComplete: true,
      ready: true,
      repository: FIXTURE_REPOSITORY.fullName,
      reportVersion: 'live-consumer-audit.v1',
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
      blockers: [],
      changesRequested: false,
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
      warnings: [],
      ...(overrides.reviewEvidenceReport ?? {})
    }
  };
}

function producerConsumerAuditReport(options = {}) {
  const auditedCommitSha = options.auditedCommitSha ?? FIXTURE_SHAS.base;
  const consumer = {
    repository: FIXTURE_REPOSITORY.fullName,
    defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
    configPath: '.github/chatgpt-automation.yml',
    callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
    expectedKitRef: KIT_REF,
    desiredCapabilitySet: ['config-validation'],
    expectedWorkflowNames: ['Validate ChatGPT automation config'],
    manualReviewRequired: false
  };
  const snapshot = {
    repository: FIXTURE_REPOSITORY.fullName,
    defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
    defaultBranchStartSha: auditedCommitSha,
    defaultBranchEndSha: auditedCommitSha,
    files: {
      '.github/chatgpt-automation.yml': {
        status: 'ok',
        content: CONFIG_SOURCE,
        sha: 'configsha',
        size: CONFIG_SOURCE.length
      },
      '.github/workflows/validate-config.yml': {
        status: 'ok',
        content: VALIDATE_CONFIG_WORKFLOW_SOURCE,
        sha: 'workflowsha',
        size: VALIDATE_CONFIG_WORKFLOW_SOURCE.length
      }
    },
    workflowMetadata: [
      {
        id: 1,
        name: 'Validate ChatGPT automation config',
        path: LIVE_CONSUMER_WORKFLOW_SPECS['config-validation'].path,
        state: 'active'
      }
    ],
    apiErrors: [],
    ...(options.snapshot ?? {})
  };
  return auditLiveConsumerInstallation({
    checkedAt: CHECKED_AT,
    consumer,
    snapshot
  });
}

function producerProtectionAuditReport(options = {}) {
  const defaultBranch = options.defaultBranch ?? FIXTURE_REPOSITORY.defaultBranch;
  const defaultBranchSha = options.defaultBranchSha ?? FIXTURE_SHAS.base;
  return auditRepositoryProtection({
    branchProtection: safeBranchProtection(options.branchProtection),
    checkedAt: CHECKED_AT,
    defaultBranch,
    defaultBranchSha,
    expectedPolicy: {
      ...DEFAULT_PROTECTION_POLICY,
      defaultBranch
    },
    mergeSettings: {
      allow_auto_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      delete_branch_on_merge: true,
      merge_queue_enabled: false
    },
    repository: {
      default_branch: defaultBranch,
      full_name: FIXTURE_REPOSITORY.fullName
    },
    rulesetDetails: [safeRuleset(options.ruleset)],
    rulesets: [],
    startSnapshot: {
      defaultBranch,
      defaultBranchSha
    },
    endSnapshot: {
      defaultBranch,
      defaultBranchSha
    },
    ...options
  });
}

function safeBranchProtection(overrides = {}) {
  return {
    allow_deletions: { enabled: false },
    allow_force_pushes: { enabled: false },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    required_linear_history: { enabled: false },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: true,
      required_approving_review_count: 1
    },
    required_signatures: { enabled: false },
    required_status_checks: {
      checks: [],
      contexts: ['CI', 'Review evidence gate'],
      strict: true
    },
    ...overrides
  };
}

function safeRuleset(overrides = {}) {
  return {
    bypass_actors: [],
    conditions: {
      ref_name: {
        exclude: [],
        include: ['~DEFAULT_BRANCH']
      }
    },
    enforcement: 'active',
    id: 101,
    name: 'protect-default-branch',
    rules: [
      {
        parameters: {
          required_status_checks: [
            { context: 'CI', integration_id: 1 },
            { context: 'Review evidence gate', integration_id: 1 }
          ],
          strict_required_status_checks_policy: true
        },
        type: 'required_status_checks'
      },
      {
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: true
        },
        type: 'pull_request'
      },
      { type: 'deletion' },
      { type: 'non_fast_forward' }
    ],
    target: 'branch',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
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

function plusMs(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function withoutField(input, reportName, field) {
  const result = structuredClone(input);
  delete result[reportName][field];
  return result;
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
