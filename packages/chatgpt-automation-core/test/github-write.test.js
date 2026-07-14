import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('valid write commandはdry-run commandとして検証でき、idempotency keyが安全境界を含む', () => {
  const command = validCommand();
  const validation = validateWriteCommand(command);

  assert.equal(validation.ok, true);
  assert.equal(command.commandVersion, 1);
  assert.match(command.idempotencyKey, /enable-auto-merge/);
  assert.match(command.idempotencyKey, /owner\/example-repo#42/);
  assert.match(command.idempotencyKey, new RegExp(FIXTURE_SHAS.head));
  assert.equal(command.idempotencyKey, createWriteIdempotencyKey(command));
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
    const validation = validateWriteCommand(command);
    assert.equal(validation.ok, false);
    assert.equal(validation.blockers.some((blocker) => blocker.reasonCode === expected), true);
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
    const validation = validateWriteCommand({ ...command, ...patch });
    assert.equal(validation.ok, false);
    assert.equal(validation.blockers.some((blocker) => blocker.reasonCode === expected), true);
  }
});

test('missing guard、fork actor context、plan mismatch、unknown stateを拒否する', () => {
  for (const [command, expected] of [
    [{ ...validCommand(), actorContext: undefined }, 'missing_safety_guard'],
    [validCommand({ actorContext: { actor: 'bot', isFork: true, isTrusted: true, source: 'plan' } }), 'missing_safety_guard'],
    [validCommand({ planSnapshot: planSnapshot({ head_sha: FIXTURE_SHAS.before }) }), WRITE_REASON_CODES.expectedHeadShaMismatch],
    [validCommand({ planSnapshot: planSnapshot({ source: 'unknown' }) }), 'unknown_state']
  ]) {
    const validation = validateWriteCommand(command);
    assert.equal(validation.ok, false);
    assert.equal(validation.blockers.some((blocker) => blocker.reasonCode === expected), true);
  }
});

test('DisabledGitHubWriteAdapterはvalid commandもwrite_disabledで拒否し、実行しない', () => {
  const adapter = new DisabledGitHubWriteAdapter();
  const result = adapter.execute(validCommand());

  assert.equal(result.accepted, false);
  assert.equal(result.executed, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.reasonCode, WRITE_REASON_CODES.writeDisabled);
  assert.equal(result.auditRecord.operation, 'enable-auto-merge');
});

test('FakeGitHubWriteAdapterはfixture allowance内でdeterministicに記録し、実writeは行わない', () => {
  const adapter = new FakeGitHubWriteAdapter({ allowedOperations: ['enable-auto-merge'] });
  const command = validCommand();
  const result = adapter.execute(command);

  assert.equal(result.accepted, true);
  assert.equal(result.executed, false);
  assert.equal(result.reasonCode, 'fake_recorded');
  assert.deepEqual(adapter.getRecords(), [result.auditRecord]);
});

test('FakeGitHubWriteAdapterはduplicate、attempt limit、cooldownをfail closedで扱う', () => {
  const duplicateAdapter = new FakeGitHubWriteAdapter();
  const command = validCommand();
  assert.equal(duplicateAdapter.execute(command).accepted, true);
  assert.equal(duplicateAdapter.execute(command).reasonCode, WRITE_REASON_CODES.duplicateOperation);

  const attemptAdapter = new FakeGitHubWriteAdapter({ maxAttempts: 1 });
  assert.equal(attemptAdapter.execute(command).accepted, true);
  const secondAttempt = validCommand({ expectedBaseSha: FIXTURE_SHAS.after });
  assert.equal(validateWriteCommand(secondAttempt).ok, true);
  assert.equal(attemptAdapter.execute(secondAttempt).reasonCode, WRITE_REASON_CODES.attemptLimitExceeded);

  const cooldownAdapter = new FakeGitHubWriteAdapter({
    cooldownMs: 10_000,
    maxAttempts: 10,
    now: () => new Date('2026-01-01T00:00:00.000Z')
  });
  assert.equal(cooldownAdapter.execute(command).accepted, true);
  const cooldownCommand = validCommand({ expectedBaseSha: FIXTURE_SHAS.after });
  assert.equal(cooldownAdapter.execute(cooldownCommand).reasonCode, WRITE_REASON_CODES.cooldownActive);
});

test('FakeGitHubWriteAdapterはmaxAttempts=0で初回からattempt_limit_exceededにする', () => {
  const adapter = new FakeGitHubWriteAdapter({ maxAttempts: 0 });
  const result = adapter.execute(validCommand());

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
  const result = new DisabledGitHubWriteAdapter().execute(command);
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
  const enable = createWriteCommandCandidateFromAutoMergePlan(autoMergeOutputs());
  assert.equal(validateWriteCommand(enable.command).ok, true);
  assert.equal(enable.command.operation, 'enable-auto-merge');

  const merge = createWriteCommandCandidateFromAutoMergePlan(autoMergeOutputs({
    should_enable_auto_merge: 'false',
    should_merge: 'true'
  }));
  assert.equal(merge.command.operation, 'merge-pull-request');

  const skipped = createWriteCommandCandidateFromAutoMergePlan(autoMergeOutputs({
    eligible: 'false',
    skip_reason: 'manual_review_required'
  }));
  assert.equal(skipped.command, null);
  assert.equal(skipped.reasonCode, 'manual_review_required');
});

test('main-follow-up planからbehind update candidateだけをcommand候補にする', () => {
  const update = createWriteCommandCandidateFromMainFollowUpEntry(mainFollowUpEntry());
  assert.equal(validateWriteCommand(update.command).ok, true);
  assert.equal(update.command.operation, 'update-pull-request-branch');

  const manual = createWriteCommandCandidateFromMainFollowUpEntry(mainFollowUpEntry({
    action: 'manual-review-required',
    reason: 'workflow_change',
    should_update_branch: false
  }));
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
  });
  assert.equal(planCandidates.length, 1);
  assert.equal(planCandidates[0].command.pullRequestNumber, 42);
});

function validCommand(overrides = {}) {
  const expectedBaseSha = overrides.expectedBaseSha ?? FIXTURE_SHAS.base;
  const expectedHeadSha = overrides.expectedHeadSha ?? FIXTURE_SHAS.head;
  const base = {
    actorContext: { actor: 'github-actions[bot]', isFork: false, isTrusted: true, source: 'plan' },
    dryRun: true,
    expectedBaseSha,
    expectedHeadSha,
    operation: 'enable-auto-merge',
    planSnapshot: planSnapshot({
      base_sha: expectedBaseSha,
      head_sha: expectedHeadSha,
      ...(overrides.planSnapshot ?? {})
    }),
    pullRequestNumber: 42,
    reasonCode: 'eligible_enable_auto_merge',
    repository: FIXTURE_REPOSITORY.fullName,
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };

  if (overrides.operation && !overrides.planSnapshot) {
    base.planSnapshot = planSnapshot({ operation: overrides.operation, source: 'generic' });
  }

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
