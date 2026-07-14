import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createValidationContext,
  createWriteCommand,
  createWriteCommandCandidateFromAutoMergePlan,
  createWriteCommandCandidateFromMainFollowUpEntry,
  createWriteCommandCandidatesFromMainFollowUpPlan,
  createWriteIdempotencyKey,
  DisabledGitHubWriteAdapter,
  FakeGitHubWriteAdapter,
  sanitizeAuditRecord,
  validateWriteCommand,
  WRITE_OPERATION_ORDER,
  WRITE_REASON_CODES
} from '../src/github-write/index.js';
import { FIXTURE_REPOSITORY, FIXTURE_SHAS } from '../../../fixtures/github-events/index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const ACTOR_CONTEXT = Object.freeze({
  actor: 'github-actions[bot]',
  isFork: false,
  isTrusted: true,
  source: 'plan'
});

test('converter経由のvalid commandは外部trust contextとclock注入がある場合だけ検証できる', () => {
  const candidate = createWriteCommandCandidateFromAutoMergePlan(autoMergeOutputs(), {
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    requestedAt: NOW
  });
  const validation = validateWriteCommand(candidate.command, candidate.validationContext);

  assert.equal(validation.ok, true);
  assert.equal(candidate.command.commandVersion, 1);
  assert.match(candidate.command.idempotencyKey, /enable-auto-merge/);
  assert.match(candidate.command.idempotencyKey, /owner\/example-repo#42/);
  assert.match(candidate.command.idempotencyKey, new RegExp(FIXTURE_SHAS.head));
  assert.equal(candidate.command.idempotencyKey, createWriteIdempotencyKey(candidate.command));
});

test('createWriteCommand単独ではtrusted actor commandにならず、外部trust contextなしではfail closed', () => {
  const command = validCommand();
  const validation = validateWriteCommand(command, { now: NOW });

  assert.equal(validation.ok, false);
  assertBlock(validation, 'missing_safety_guard');
});

test('actorContext欠落、actor/source/trusted/fork欠落、trusted=false、fork=trueを拒否する', () => {
  for (const [actorContext, expected] of [
    [undefined, 'missing_safety_guard'],
    [{ source: 'plan', isTrusted: true, isFork: false }, 'missing_safety_guard'],
    [{ actor: 'github-actions[bot]', isTrusted: true, isFork: false }, 'missing_safety_guard'],
    [{ actor: 'github-actions[bot]', source: 'plan', isFork: false }, 'missing_safety_guard'],
    [{ actor: 'github-actions[bot]', source: 'plan', isTrusted: true }, 'missing_safety_guard'],
    [{ actor: 'github-actions[bot]', source: 'plan', isTrusted: false, isFork: false }, 'missing_safety_guard'],
    [{ actor: 'github-actions[bot]', source: 'plan', isTrusted: true, isFork: true }, 'missing_safety_guard']
  ]) {
    const command = validCommand({ actorContext });
    const validation = validateWriteCommand(command, validationContext({ trustedActorContext: actorContext ?? ACTOR_CONTEXT }));
    assert.equal(validation.ok, false);
    assertBlock(validation, expected);
  }
});

test('command payloadがtrustedを自己申告しても、外部trust contextと一致しなければ拒否する', () => {
  const command = validCommand({
    actorContext: { actor: 'external-actor', source: 'plan', isTrusted: true, isFork: false }
  });
  const validation = validateWriteCommand(command, validationContext());

  assert.equal(validation.ok, false);
  assertBlock(validation, 'missing_safety_guard');
});

test('invalid repository、PR番号、SHA、unknown operation、dryRun=falseはfail closed', () => {
  for (const [command, expected] of [
    [validCommand({ repository: 'bad repo' }), WRITE_REASON_CODES.invalidRepository],
    [validCommand({ pullRequestNumber: 0 }), WRITE_REASON_CODES.invalidPullRequestNumber],
    [validCommand({ expectedHeadSha: 'short' }), 'invalid_expected_head_sha'],
    [validCommand({ operation: 'unknown-write' }), WRITE_REASON_CODES.unsupportedOperation],
    [validCommand({ dryRun: false }), 'dry_run_required'],
    [validCommand({ requestedAt: 'not-a-date' }), 'invalid_requested_at']
  ]) {
    const validation = validateWriteCommand(command, validationContext());
    assert.equal(validation.ok, false);
    assertBlock(validation, expected);
  }
});

test('operationIdとidempotencyKeyが欠落または内容不一致ならfail closed', () => {
  const command = validCommand();

  for (const [patch, expected] of [
    [{ operationId: '' }, 'invalid_operation_id'],
    [{ idempotencyKey: '' }, WRITE_REASON_CODES.invalidIdempotencyKey],
    [{ operationId: 'write-v1:enable-auto-merge:owner/example-repo#42:wrong:command' }, 'invalid_operation_id'],
    [{ idempotencyKey: 'write-v1:enable-auto-merge:owner/example-repo#42:wrong' }, WRITE_REASON_CODES.invalidIdempotencyKey]
  ]) {
    const validation = validateWriteCommand({ ...command, ...patch }, validationContext());
    assert.equal(validation.ok, false);
    assertBlock(validation, expected);
  }
});

test('generic source、source欠落、unknown source、plan mismatchを拒否する', () => {
  for (const [snapshot, expected] of [
    [planSnapshot({ source: 'generic' }), WRITE_REASON_CODES.planSnapshotMismatch],
    [planSnapshot({ source: '' }), 'unknown_state'],
    [planSnapshot({ source: 'unknown' }), WRITE_REASON_CODES.planSnapshotMismatch],
    [planSnapshot({ head_sha: FIXTURE_SHAS.before }), WRITE_REASON_CODES.expectedHeadShaMismatch]
  ]) {
    const validation = validateWriteCommand(validCommand({ planSnapshot: snapshot }), validationContext());
    assert.equal(validation.ok, false);
    assertBlock(validation, expected);
  }
});

test('operationはplan sourceごとの対応だけを許可する', () => {
  assert.equal(validateWriteCommand(validCommand({
    operation: 'enable-auto-merge',
    planSnapshot: planSnapshot({ operation: 'enable-auto-merge', should_enable_auto_merge: true, source: 'auto-merge' })
  }), validationContext()).ok, true);

  assert.equal(validateWriteCommand(validCommand({
    operation: 'merge-pull-request',
    planSnapshot: planSnapshot({ operation: 'merge-pull-request', should_merge: true, should_enable_auto_merge: false, source: 'auto-merge' })
  }), validationContext()).ok, true);

  for (const [operation, snapshot] of [
    ['update-pull-request-branch', planSnapshot({ operation: 'update-pull-request-branch', source: 'auto-merge' })],
    ['merge-pull-request', mainFollowUpSnapshot({ operation: 'merge-pull-request' })],
    ['add-comment', planSnapshot({ operation: 'add-comment', source: 'auto-merge' })],
    ['remove-label', planSnapshot({ operation: 'remove-label', source: 'auto-merge' })],
    ['update-queue-record', mainFollowUpSnapshot({ operation: 'update-queue-record' })]
  ]) {
    const validation = validateWriteCommand(validCommand({ operation, planSnapshot: snapshot }), validationContext());
    assert.equal(validation.ok, false);
    assert.equal(validation.blockers.some((blocker) =>
      [WRITE_REASON_CODES.unsupportedOperation, WRITE_REASON_CODES.planSnapshotMismatch].includes(blocker.reasonCode)
    ), true);
  }

  assert.equal(validateWriteCommand(validCommand({
    operation: 'update-pull-request-branch',
    planSnapshot: mainFollowUpSnapshot()
  }), validationContext()).ok, true);
});

test('command freshnessは現在時刻、future skew、max age、invalid dateをfail closedで検証する', () => {
  assert.equal(validateWriteCommand(validCommand({ requestedAt: NOW }), validationContext()).ok, true);
  assertBlock(validateWriteCommand(validCommand({ requestedAt: '2026-01-01T00:05:00.001Z' }), validationContext()), WRITE_REASON_CODES.commandFromFuture);
  assertBlock(validateWriteCommand(validCommand({ requestedAt: '2026-01-01T01:00:00.000Z' }), validationContext()), WRITE_REASON_CODES.commandFromFuture);
  assertBlock(validateWriteCommand(validCommand({ requestedAt: '2025-12-30T23:59:59.999Z' }), validationContext()), WRITE_REASON_CODES.commandExpired);
  assertBlock(validateWriteCommand(validCommand({ requestedAt: '2025-12-25T00:00:00.000Z' }), validationContext()), WRITE_REASON_CODES.commandExpired);
  assertBlock(validateWriteCommand(validCommand({ requestedAt: '1970-01-01T00:00:00.000Z' }), validationContext()), WRITE_REASON_CODES.commandExpired);
  assertBlock(validateWriteCommand(validCommand({ requestedAt: 'not-a-date' }), validationContext()), 'invalid_requested_at');
  assertBlock(validateWriteCommand(validCommand({ requestedAt: NOW }), { trustedActorContext: ACTOR_CONTEXT }), WRITE_REASON_CODES.clockUnavailable);
  assert.equal(validateWriteCommand(validCommand({ requestedAt: NOW }), validationContext({ now: () => new Date(NOW) })).ok, true);
});

test('DisabledGitHubWriteAdapterはvalid commandもwrite_disabledで拒否し、実行しない', () => {
  const adapter = new DisabledGitHubWriteAdapter();
  const result = adapter.execute(validCommand(), validationContext());

  assert.equal(result.accepted, false);
  assert.equal(result.executed, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.reasonCode, WRITE_REASON_CODES.writeDisabled);
  assert.equal(result.auditRecord.operation, 'enable-auto-merge');
});

test('FakeGitHubWriteAdapterはfixture allowance内でdeterministicに記録し、実writeは行わない', () => {
  const adapter = new FakeGitHubWriteAdapter({ allowedOperations: ['enable-auto-merge'] });
  const command = validCommand();
  const result = adapter.execute(command, validationContext());

  assert.equal(result.accepted, true);
  assert.equal(result.executed, false);
  assert.equal(result.reasonCode, 'fake_recorded');
  assert.deepEqual(adapter.getRecords(), [result.auditRecord]);
});

test('FakeGitHubWriteAdapterはduplicate、attempt limit、cooldownをfail closedで扱う', () => {
  const duplicateAdapter = new FakeGitHubWriteAdapter();
  const command = validCommand();
  assert.equal(duplicateAdapter.execute(command, validationContext()).accepted, true);
  assert.equal(duplicateAdapter.execute(command, validationContext()).reasonCode, WRITE_REASON_CODES.duplicateOperation);

  const attemptAdapter = new FakeGitHubWriteAdapter({ maxAttempts: 1 });
  assert.equal(attemptAdapter.execute(command, validationContext()).accepted, true);
  const secondAttempt = validCommand({ expectedBaseSha: FIXTURE_SHAS.after });
  assert.equal(validateWriteCommand(secondAttempt, validationContext()).ok, true);
  assert.equal(attemptAdapter.execute(secondAttempt, validationContext()).reasonCode, WRITE_REASON_CODES.attemptLimitExceeded);

  const cooldownAdapter = new FakeGitHubWriteAdapter({
    cooldownMs: 10_000,
    maxAttempts: 10,
    now: () => new Date(NOW)
  });
  assert.equal(cooldownAdapter.execute(command, validationContext()).accepted, true);
  const cooldownCommand = validCommand({ expectedBaseSha: FIXTURE_SHAS.after });
  assert.equal(cooldownAdapter.execute(cooldownCommand, validationContext()).reasonCode, WRITE_REASON_CODES.cooldownActive);
});

test('FakeGitHubWriteAdapterはmaxAttempts=0で初回からattempt_limit_exceededにする', () => {
  const adapter = new FakeGitHubWriteAdapter({ maxAttempts: 0 });
  const result = adapter.execute(validCommand(), validationContext());

  assert.equal(result.accepted, false);
  assert.equal(result.reasonCode, WRITE_REASON_CODES.attemptLimitExceeded);
  assert.deepEqual(adapter.getRecords(), []);
});

test('audit recordは許可された最小フィールドだけを出し、secret-like値を含めない', () => {
  const command = validCommand({
    planSnapshot: planSnapshot({
      private_url: 'redacted-private-location',
      secretField: 'redacted-value'
    })
  });
  const result = new DisabledGitHubWriteAdapter().execute(command, validationContext());
  const serialized = JSON.stringify(result.auditRecord);

  assert.equal(serialized.includes('redacted-value'), false);
  assert.equal(serialized.includes('redacted-private-location'), false);
  assert.deepEqual(Object.keys(result.auditRecord).sort(), [
    'accepted',
    'dryRun',
    'executed',
    'expectedBaseSha',
    'expectedHeadSha',
    'operation',
    'operationId',
    'pullRequestNumber',
    'reasonCode',
    'repository'
  ].sort());

  assert.equal(JSON.stringify(sanitizeAuditRecord({ Authorization: 'redacted-value', operation: 'add-label' })).includes('redacted-value'), false);
});

test('operation ordering is stable and includes all planned operation types', () => {
  assert.deepEqual(WRITE_OPERATION_ORDER, [
    'enable-auto-merge',
    'merge-pull-request',
    'update-pull-request-branch',
    'add-comment',
    'add-label',
    'remove-label',
    'update-queue-record'
  ]);
});

test('auto-merge planからenable-auto-mergeまたはmerge command候補を生成し、非eligible planでは生成しない', () => {
  const enable = createWriteCommandCandidateFromAutoMergePlan(autoMergeOutputs(), {
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    requestedAt: NOW
  });
  assert.equal(validateWriteCommand(enable.command, enable.validationContext).ok, true);
  assert.equal(enable.command.operation, 'enable-auto-merge');

  const merge = createWriteCommandCandidateFromAutoMergePlan(autoMergeOutputs({
    should_enable_auto_merge: 'false',
    should_merge: 'true'
  }), {
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    requestedAt: NOW
  });
  assert.equal(validateWriteCommand(merge.command, merge.validationContext).ok, true);
  assert.equal(merge.command.operation, 'merge-pull-request');

  const skipped = createWriteCommandCandidateFromAutoMergePlan(autoMergeOutputs({
    eligible: 'false',
    skip_reason: 'manual_review_required'
  }), {
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    requestedAt: NOW
  });
  assert.equal(skipped.command, null);
  assert.equal(skipped.reasonCode, 'manual_review_required');
});

test('main-follow-up planからbehind update candidateだけをcommand候補にする', () => {
  const update = createWriteCommandCandidateFromMainFollowUpEntry(mainFollowUpEntry(), {
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    requestedAt: NOW
  });
  assert.equal(validateWriteCommand(update.command, update.validationContext).ok, true);
  assert.equal(update.command.operation, 'update-pull-request-branch');

  const manual = createWriteCommandCandidateFromMainFollowUpEntry(mainFollowUpEntry({
    action: 'manual-review-required',
    reason: 'workflow_change',
    should_update_branch: false
  }), {
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    requestedAt: NOW
  });
  assert.equal(manual.command, null);
  assert.equal(manual.reasonCode, 'workflow_change');

  const planCandidates = createWriteCommandCandidatesFromMainFollowUpPlan({
    outputs: {
      eligible: 'true',
      plans_json: JSON.stringify([
        mainFollowUpEntry(),
        mainFollowUpEntry({ action: 'up-to-date', pull_request_number: 43, should_update_branch: false })
      ])
    }
  }, {
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    requestedAt: NOW
  });
  assert.equal(planCandidates.length, 1);
  assert.equal(planCandidates[0].command.pullRequestNumber, 42);
});

function validCommand(overrides = {}) {
  const expectedBaseSha = overrides.expectedBaseSha ?? FIXTURE_SHAS.base;
  const expectedHeadSha = overrides.expectedHeadSha ?? FIXTURE_SHAS.head;
  const operation = overrides.operation ?? 'enable-auto-merge';
  const base = {
    actorContext: ACTOR_CONTEXT,
    dryRun: true,
    expectedBaseSha,
    expectedHeadSha,
    operation,
    planSnapshot: planSnapshot({
      base_sha: expectedBaseSha,
      head_sha: expectedHeadSha,
      operation,
      ...(overrides.planSnapshot ?? {})
    }),
    pullRequestNumber: 42,
    reasonCode: 'eligible_enable_auto_merge',
    repository: FIXTURE_REPOSITORY.fullName,
    requestedAt: NOW,
    ...overrides
  };

  return createWriteCommand(base);
}

function planSnapshot(overrides = {}) {
  return {
    base_sha: FIXTURE_SHAS.base,
    eligible: true,
    head_sha: FIXTURE_SHAS.head,
    operation: 'enable-auto-merge',
    pull_request_number: 42,
    repository: FIXTURE_REPOSITORY.fullName,
    should_enable_auto_merge: true,
    source: 'auto-merge',
    ...overrides
  };
}

function mainFollowUpSnapshot(overrides = {}) {
  return {
    action: 'behind-update-candidate',
    base_sha: FIXTURE_SHAS.base,
    head_sha: FIXTURE_SHAS.head,
    operation: 'update-pull-request-branch',
    pull_request_number: 42,
    repository: FIXTURE_REPOSITORY.fullName,
    should_update_branch: true,
    source: 'main-follow-up',
    ...overrides
  };
}

function autoMergeOutputs(overrides = {}) {
  return {
    outputs: {
      base_sha: FIXTURE_SHAS.base,
      dedupe_key: `${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:enable-auto-merge:v1`,
      eligible: 'true',
      head_sha: FIXTURE_SHAS.head,
      merge_reason: 'eligible_enable_auto_merge',
      pull_request_number: '42',
      repository: FIXTURE_REPOSITORY.fullName,
      should_enable_auto_merge: 'true',
      should_merge: 'false',
      ...overrides
    }
  };
}

function mainFollowUpEntry(overrides = {}) {
  return {
    action: 'behind-update-candidate',
    base_sha: FIXTURE_SHAS.base,
    dedupe_key: `${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:${FIXTURE_SHAS.base}:main-follow-up:v1`,
    head_sha: FIXTURE_SHAS.head,
    pull_request_number: 42,
    reason: 'behind_update_candidate',
    repository: FIXTURE_REPOSITORY.fullName,
    should_update_branch: true,
    ...overrides
  };
}

function validationContext(overrides = {}) {
  return createValidationContext({
    actorContext: ACTOR_CONTEXT,
    now: NOW,
    ...overrides
  });
}

function assertBlock(validation, reasonCode) {
  assert.equal(validation.blockers.some((blocker) => blocker.reasonCode === reasonCode), true);
}
