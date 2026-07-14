export const WRITE_COMMAND_VERSION = 1;

export const WRITE_OPERATION_ORDER = Object.freeze([
  'enable-auto-merge',
  'merge-pull-request',
  'update-pull-request-branch',
  'add-comment',
  'add-label',
  'remove-label',
  'update-queue-record'
]);

export const WRITE_REASON_CODES = Object.freeze({
  attemptLimitExceeded: 'attempt_limit_exceeded',
  cooldownActive: 'cooldown_active',
  duplicateOperation: 'duplicate_operation',
  expectedBaseShaMissing: 'expected_base_sha_missing',
  expectedHeadShaMismatch: 'expected_head_sha_mismatch',
  expectedHeadShaMissing: 'expected_head_sha_missing',
  invalidIdempotencyKey: 'invalid_idempotency_key',
  invalidPullRequestNumber: 'invalid_pull_request_number',
  invalidRepository: 'invalid_repository',
  planSnapshotMismatch: 'plan_snapshot_mismatch',
  unsupportedOperation: 'unsupported_operation',
  writeDisabled: 'write_disabled'
});

const SUPPORTED_WRITE_OPERATIONS = new Set(WRITE_OPERATION_ORDER);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:/#-]{16,320}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:/#-]{8,320}$/;
const DEFAULT_REQUESTED_AT = '1970-01-01T00:00:00.000Z';
const DEFAULT_ACTOR_CONTEXT = Object.freeze({
  actor: 'local-plan',
  isFork: false,
  isTrusted: true,
  source: 'plan'
});

export class DisabledGitHubWriteAdapter {
  execute(command) {
    const validation = validateWriteCommand(command);
    return createWriteExecutionResult(command, {
      blockers: validation.blockers,
      reasonCode: validation.ok ? WRITE_REASON_CODES.writeDisabled : firstBlockerReason(validation.blockers)
    });
  }
}

export class FakeGitHubWriteAdapter {
  constructor({
    allowedOperations = WRITE_OPERATION_ORDER,
    cooldownMs = 0,
    maxAttempts = 10,
    now = () => new Date('2026-01-01T00:00:00.000Z')
  } = {}) {
    this.allowedOperations = new Set(allowedOperations);
    this.cooldownMs = Number.isInteger(cooldownMs) && cooldownMs > 0 ? cooldownMs : 0;
    this.maxAttempts = Number.isInteger(maxAttempts) ? maxAttempts : 10;
    this.now = now;
    this.records = [];
    this.seenIdempotencyKeys = new Set();
    this.attemptsByFingerprint = new Map();
    this.lastAttemptByFingerprint = new Map();
  }

  execute(command) {
    const validation = validateWriteCommand(command);
    if (!validation.ok) {
      return createWriteExecutionResult(command, {
        blockers: validation.blockers,
        reasonCode: firstBlockerReason(validation.blockers)
      });
    }

    if (!this.allowedOperations.has(command.operation)) {
      return createWriteExecutionResult(command, {
        blockers: [blocker(WRITE_REASON_CODES.unsupportedOperation)],
        reasonCode: WRITE_REASON_CODES.unsupportedOperation
      });
    }

    if (this.seenIdempotencyKeys.has(command.idempotencyKey)) {
      return createWriteExecutionResult(command, {
        blockers: [blocker(WRITE_REASON_CODES.duplicateOperation)],
        reasonCode: WRITE_REASON_CODES.duplicateOperation
      });
    }

    const fingerprint = operationFingerprint(command);
    const attempts = this.attemptsByFingerprint.get(fingerprint) ?? 0;
    if (attempts >= this.maxAttempts) {
      return createWriteExecutionResult(command, {
        blockers: [blocker(WRITE_REASON_CODES.attemptLimitExceeded)],
        reasonCode: WRITE_REASON_CODES.attemptLimitExceeded
      });
    }

    const nowMs = toTime(this.now());
    const lastAttemptMs = this.lastAttemptByFingerprint.get(fingerprint);
    if (this.cooldownMs > 0 && Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < this.cooldownMs) {
      return createWriteExecutionResult(command, {
        blockers: [blocker(WRITE_REASON_CODES.cooldownActive)],
        reasonCode: WRITE_REASON_CODES.cooldownActive
      });
    }

    this.seenIdempotencyKeys.add(command.idempotencyKey);
    this.attemptsByFingerprint.set(fingerprint, attempts + 1);
    this.lastAttemptByFingerprint.set(fingerprint, nowMs);

    const result = createWriteExecutionResult(command, {
      accepted: true,
      executed: false,
      reasonCode: 'fake_recorded'
    });
    this.records.push(result.auditRecord);
    return result;
  }

  getRecords() {
    return this.records.map((record) => ({ ...record }));
  }
}

export function createWriteCommand(input = {}) {
  const operation = cleanString(input.operation);
  const repository = cleanRepository(input.repository);
  const pullRequestNumber = normalizePullRequestNumber(input.pullRequestNumber ?? input.pull_request_number);
  const expectedHeadSha = cleanSha(input.expectedHeadSha ?? input.expected_head_sha);
  const expectedBaseSha = cleanSha(input.expectedBaseSha ?? input.expected_base_sha);
  const rawRequestedAt = input.requestedAt ?? input.requested_at;
  const requestedAt = rawRequestedAt === undefined ? DEFAULT_REQUESTED_AT : cleanString(rawRequestedAt);
  const dryRun = input.dryRun !== false;
  const reasonCode = cleanString(input.reasonCode ?? input.reason_code) || 'plan_candidate';
  const actorContext = normalizeActorContext(input.actorContext);
  const planSnapshot = normalizePlanSnapshot(input.planSnapshot ?? input.plan_snapshot);
  const base = {
    actorContext,
    commandVersion: WRITE_COMMAND_VERSION,
    dryRun,
    expectedBaseSha,
    expectedHeadSha,
    operation,
    planSnapshot,
    pullRequestNumber,
    reasonCode,
    repository,
    requestedAt
  };
  const operationId = cleanString(input.operationId ?? input.operation_id)
    || createWriteOperationId(base);
  const idempotencyKey = cleanString(input.idempotencyKey ?? input.idempotency_key)
    || createWriteIdempotencyKey(base);

  return {
    ...base,
    idempotencyKey,
    operationId
  };
}

export function createWriteCommandCandidateFromAutoMergePlan(plan, options = {}) {
  const outputs = plan?.outputs ?? plan ?? {};
  if (outputs.eligible !== 'true') {
    return { command: null, reasonCode: cleanString(outputs.skip_reason) || 'plan_not_eligible' };
  }

  const operation = cleanString(options.operation) || inferAutoMergeOperation(outputs);
  if (!operation) {
    return { command: null, reasonCode: 'plan_has_no_write_operation' };
  }

  if (
    (operation === 'merge-pull-request' && outputs.should_merge !== 'true')
    || (operation === 'enable-auto-merge' && outputs.should_enable_auto_merge !== 'true')
  ) {
    return { command: null, reasonCode: WRITE_REASON_CODES.planSnapshotMismatch };
  }

  return {
    command: createWriteCommand({
      actorContext: options.actorContext,
      dryRun: options.dryRun,
      expectedBaseSha: outputs.base_sha,
      expectedHeadSha: outputs.head_sha,
      operation,
      planSnapshot: {
        base_sha: outputs.base_sha,
        dedupe_key: outputs.dedupe_key,
        eligible: true,
        head_sha: outputs.head_sha,
        operation,
        pull_request_number: outputs.pull_request_number,
        repository: outputs.repository,
        should_enable_auto_merge: outputs.should_enable_auto_merge === 'true',
        should_merge: outputs.should_merge === 'true',
        source: 'auto-merge'
      },
      pullRequestNumber: outputs.pull_request_number,
      reasonCode: outputs.merge_reason || 'auto_merge_plan_candidate',
      repository: outputs.repository,
      requestedAt: options.requestedAt
    }),
    reasonCode: ''
  };
}

export function createWriteCommandCandidateFromMainFollowUpEntry(entry, options = {}) {
  const operation = cleanString(options.operation) || 'update-pull-request-branch';
  if (operation !== 'update-pull-request-branch') {
    return { command: null, reasonCode: WRITE_REASON_CODES.unsupportedOperation };
  }

  if (entry?.action !== 'behind-update-candidate' || entry?.should_update_branch !== true) {
    return { command: null, reasonCode: cleanString(entry?.skip_reason || entry?.reason) || 'plan_not_eligible' };
  }

  return {
    command: createWriteCommand({
      actorContext: options.actorContext,
      dryRun: options.dryRun,
      expectedBaseSha: entry.base_sha,
      expectedHeadSha: entry.head_sha,
      operation,
      planSnapshot: {
        action: entry.action,
        base_sha: entry.base_sha,
        dedupe_key: entry.dedupe_key,
        head_sha: entry.head_sha,
        operation,
        pull_request_number: entry.pull_request_number,
        repository: entry.repository,
        should_update_branch: true,
        source: 'main-follow-up'
      },
      pullRequestNumber: entry.pull_request_number,
      reasonCode: entry.reason || 'main_follow_up_plan_candidate',
      repository: entry.repository,
      requestedAt: options.requestedAt
    }),
    reasonCode: ''
  };
}

export function createWriteCommandCandidatesFromMainFollowUpPlan(plan, options = {}) {
  const outputs = plan?.outputs ?? plan ?? {};
  if (outputs.eligible !== 'true') {
    return [];
  }

  return parsePlansJson(outputs.plans_json)
    .map((entry) => createWriteCommandCandidateFromMainFollowUpEntry(entry, options))
    .filter((candidate) => candidate.command);
}

export function createWriteExecutionResult(command = {}, {
  accepted = false,
  blockers = [],
  executed = false,
  reasonCode = WRITE_REASON_CODES.writeDisabled
} = {}) {
  const result = {
    accepted: accepted === true,
    blockers: Array.isArray(blockers) ? blockers.map((entry) => ({ ...entry })) : [],
    dryRun: command?.dryRun === true,
    executed: executed === true,
    expectedHeadSha: cleanSha(command?.expectedHeadSha ?? command?.expected_head_sha),
    idempotencyKey: cleanString(command?.idempotencyKey ?? command?.idempotency_key),
    operation: cleanString(command?.operation),
    operationId: cleanString(command?.operationId ?? command?.operation_id),
    pullRequestNumber: normalizePullRequestNumber(command?.pullRequestNumber ?? command?.pull_request_number),
    reasonCode: cleanString(reasonCode) || WRITE_REASON_CODES.writeDisabled,
    repository: cleanRepository(command?.repository)
  };

  return {
    ...result,
    auditRecord: createAuditRecord(result, command)
  };
}

export function createWriteIdempotencyKey(input = {}) {
  const operation = cleanString(input.operation);
  const repository = cleanRepository(input.repository);
  const pullRequestNumber = normalizePullRequestNumber(input.pullRequestNumber ?? input.pull_request_number);
  const expectedHeadSha = cleanSha(input.expectedHeadSha ?? input.expected_head_sha);
  const expectedBaseSha = cleanSha(input.expectedBaseSha ?? input.expected_base_sha);

  if (!operation || !repository || !pullRequestNumber || !expectedHeadSha || !expectedBaseSha) {
    return '';
  }

  return `write-v${WRITE_COMMAND_VERSION}:${operation}:${repository}#${pullRequestNumber}:${expectedHeadSha}:${expectedBaseSha}`;
}

export function createWriteOperationId(input = {}) {
  const key = createWriteIdempotencyKey(input);
  return key ? `${key}:command` : '';
}

export function validateWriteCommand(command = {}) {
  const blockers = [];

  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return {
      blockers: [blocker('invalid_command')],
      ok: false
    };
  }

  const operation = cleanString(command.operation);
  const repository = cleanRepository(command.repository);
  const pullRequestNumber = normalizePullRequestNumber(command.pullRequestNumber ?? command.pull_request_number);
  const expectedHeadSha = cleanSha(command.expectedHeadSha ?? command.expected_head_sha);
  const expectedBaseSha = cleanSha(command.expectedBaseSha ?? command.expected_base_sha);
  const operationId = cleanString(command.operationId ?? command.operation_id);
  const idempotencyKey = cleanString(command.idempotencyKey ?? command.idempotency_key);

  if (command.commandVersion !== WRITE_COMMAND_VERSION) {
    blockers.push(blocker('invalid_command_version'));
  }
  if (!SUPPORTED_WRITE_OPERATIONS.has(operation)) {
    blockers.push(blocker(WRITE_REASON_CODES.unsupportedOperation));
  }
  if (!isValidRepository(repository)) {
    blockers.push(blocker(WRITE_REASON_CODES.invalidRepository));
  }
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    blockers.push(blocker(WRITE_REASON_CODES.invalidPullRequestNumber));
  }
  if (!expectedHeadSha) {
    blockers.push(blocker(WRITE_REASON_CODES.expectedHeadShaMissing));
  } else if (!isValidSha(expectedHeadSha)) {
    blockers.push(blocker('invalid_expected_head_sha'));
  }
  if (!expectedBaseSha) {
    blockers.push(blocker(WRITE_REASON_CODES.expectedBaseShaMissing));
  } else if (!isValidSha(expectedBaseSha)) {
    blockers.push(blocker('invalid_expected_base_sha'));
  }
  if (!operationId || !OPERATION_ID_PATTERN.test(operationId)) {
    blockers.push(blocker('invalid_operation_id'));
  }
  const expectedOperationId = createWriteOperationId({ expectedBaseSha, expectedHeadSha, operation, pullRequestNumber, repository });
  if (operationId && expectedOperationId && operationId !== expectedOperationId) {
    blockers.push(blocker('invalid_operation_id'));
  }
  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    blockers.push(blocker(WRITE_REASON_CODES.invalidIdempotencyKey));
  }
  const expectedIdempotencyKey = createWriteIdempotencyKey({ expectedBaseSha, expectedHeadSha, operation, pullRequestNumber, repository });
  if (idempotencyKey && expectedIdempotencyKey && idempotencyKey !== expectedIdempotencyKey) {
    blockers.push(blocker(WRITE_REASON_CODES.invalidIdempotencyKey));
  }
  if (command.dryRun !== true) {
    blockers.push(blocker('dry_run_required'));
  }
  if (!normalizeTimestamp(command.requestedAt ?? command.requested_at)) {
    blockers.push(blocker('invalid_requested_at'));
  }

  const actorBlocker = validateActorContext(command.actorContext);
  if (actorBlocker) {
    blockers.push(actorBlocker);
  }

  const snapshotBlocker = validatePlanSnapshot({
    expectedBaseSha,
    expectedHeadSha,
    operation,
    planSnapshot: command.planSnapshot ?? command.plan_snapshot,
    pullRequestNumber,
    repository
  });
  if (snapshotBlocker) {
    blockers.push(snapshotBlocker);
  }

  return {
    blockers,
    ok: blockers.length === 0
  };
}

export function sanitizeAuditRecord(value = {}) {
  return createAuditRecord(value, value);
}

function createAuditRecord(result, command = {}) {
  return {
    accepted: result.accepted === true,
    dryRun: command?.dryRun === true || result.dryRun === true,
    executed: result.executed === true,
    expectedBaseSha: cleanSha(command?.expectedBaseSha ?? command?.expected_base_sha),
    expectedHeadSha: cleanSha(command?.expectedHeadSha ?? command?.expected_head_sha ?? result.expectedHeadSha),
    operation: cleanString(command?.operation ?? result.operation),
    operationId: cleanString(command?.operationId ?? command?.operation_id ?? result.operationId),
    pullRequestNumber: normalizePullRequestNumber(command?.pullRequestNumber ?? command?.pull_request_number ?? result.pullRequestNumber),
    reasonCode: cleanString(result.reasonCode),
    repository: cleanRepository(command?.repository ?? result.repository)
  };
}

function validateActorContext(actorContext) {
  if (!actorContext || typeof actorContext !== 'object' || Array.isArray(actorContext)) {
    return blocker('missing_safety_guard');
  }
  const normalized = normalizeActorContext(actorContext);
  if (!normalized.actor || normalized.source !== 'plan' || normalized.isTrusted !== true || normalized.isFork === true) {
    return blocker('missing_safety_guard');
  }
  return null;
}

function validatePlanSnapshot({ expectedBaseSha, expectedHeadSha, operation, planSnapshot, pullRequestNumber, repository }) {
  const snapshot = normalizePlanSnapshot(planSnapshot);
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return blocker('missing_plan_snapshot');
  }

  if (
    snapshot.repository !== repository
    || snapshot.pull_request_number !== pullRequestNumber
    || snapshot.base_sha !== expectedBaseSha
    || (snapshot.operation && snapshot.operation !== operation)
  ) {
    return blocker(WRITE_REASON_CODES.planSnapshotMismatch);
  }
  if (snapshot.head_sha !== expectedHeadSha) {
    return blocker(WRITE_REASON_CODES.expectedHeadShaMismatch);
  }

  if (snapshot.source === 'auto-merge') {
    if (snapshot.eligible !== true) {
      return blocker(WRITE_REASON_CODES.planSnapshotMismatch);
    }
    if (operation === 'merge-pull-request' && snapshot.should_merge !== true) {
      return blocker(WRITE_REASON_CODES.planSnapshotMismatch);
    }
    if (operation === 'enable-auto-merge' && snapshot.should_enable_auto_merge !== true) {
      return blocker(WRITE_REASON_CODES.planSnapshotMismatch);
    }
    if (!['merge-pull-request', 'enable-auto-merge'].includes(operation)) {
      return blocker(WRITE_REASON_CODES.planSnapshotMismatch);
    }
    return null;
  }

  if (snapshot.source === 'main-follow-up') {
    if (operation !== 'update-pull-request-branch' || snapshot.action !== 'behind-update-candidate' || snapshot.should_update_branch !== true) {
      return blocker(WRITE_REASON_CODES.planSnapshotMismatch);
    }
    return null;
  }

  if (snapshot.source === 'generic') {
    return null;
  }

  return blocker('unknown_state');
}

function normalizeActorContext(value = {}) {
  const source = cleanString(value?.source) || DEFAULT_ACTOR_CONTEXT.source;
  return {
    actor: cleanString(value?.actor) || DEFAULT_ACTOR_CONTEXT.actor,
    isFork: value?.isFork === true,
    isTrusted: value?.isTrusted !== undefined ? value.isTrusted === true : DEFAULT_ACTOR_CONTEXT.isTrusted,
    source
  };
}

function normalizePlanSnapshot(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return {
    action: cleanString(value.action),
    base_sha: cleanSha(value.base_sha ?? value.baseSha),
    dedupe_key: cleanString(value.dedupe_key ?? value.dedupeKey),
    eligible: value.eligible === true || value.eligible === 'true',
    head_sha: cleanSha(value.head_sha ?? value.headSha),
    operation: cleanString(value.operation),
    pull_request_number: normalizePullRequestNumber(value.pull_request_number ?? value.pullRequestNumber),
    repository: cleanRepository(value.repository),
    should_enable_auto_merge: value.should_enable_auto_merge === true || value.shouldEnableAutoMerge === true,
    should_merge: value.should_merge === true || value.shouldMerge === true,
    should_update_branch: value.should_update_branch === true || value.shouldUpdateBranch === true,
    source: cleanString(value.source) || 'generic'
  };
}

function inferAutoMergeOperation(outputs) {
  if (outputs.should_merge === 'true') {
    return 'merge-pull-request';
  }
  if (outputs.should_enable_auto_merge === 'true') {
    return 'enable-auto-merge';
  }
  return '';
}

function parsePlansJson(value) {
  if (Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function operationFingerprint(command) {
  return [
    command.operation,
    command.repository,
    command.pullRequestNumber,
    command.expectedHeadSha
  ].join('|');
}

function normalizePullRequestNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeTimestamp(value) {
  const text = cleanString(value);
  if (!text) {
    return '';
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

function isValidRepository(value) {
  if (!REPOSITORY_PATTERN.test(value)) {
    return false;
  }
  return !value.split('/').some((part) => part === '.' || part === '..');
}

function isValidSha(value) {
  return SHA_PATTERN.test(value);
}

function cleanRepository(value) {
  return cleanString(value);
}

function cleanSha(value) {
  const text = cleanString(value).toLowerCase();
  return SHA_PATTERN.test(text) ? text : text;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function blocker(reasonCode) {
  return { reasonCode };
}

function firstBlockerReason(blockers = []) {
  return cleanString(blockers[0]?.reasonCode) || WRITE_REASON_CODES.writeDisabled;
}
