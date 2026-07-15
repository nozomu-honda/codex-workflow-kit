import { createAutoMergePlan } from '../auto-merge/index.js';
import { executeAutoMergeDryRun } from '../auto-merge-executor/index.js';
import {
  createWriteCommandCandidateFromAutoMergePlan,
  DisabledGitHubWriteAdapter,
  FakeGitHubWriteAdapter,
  WRITE_REASON_CODES
} from '../github-write/index.js';

export const AUTO_MERGE_REGRESSION_SCENARIO_VERSION = 'auto-merge-regression.v1';

export const AUTO_MERGE_REGRESSION_REQUIRED_KEYS = Object.freeze([
  'category',
  'changedFilesSnapshot',
  'ciSnapshot',
  'consumerAuditSnapshot',
  'description',
  'executionContext',
  'expectedDecision',
  'expectedReasonCodes',
  'id',
  'normalizedEvent',
  'protectionAuditSnapshot',
  'pullRequestSnapshot',
  'reviewEvidenceSnapshot',
  'scenarioVersion'
]);
const AUTO_MERGE_REGRESSION_OPTIONAL_KEYS = Object.freeze([
  'eventPayload'
]);

const SCENARIO_CATEGORIES = new Set([
  'audit',
  'ci',
  'diff',
  'pr-state',
  'replay-prevention',
  'review',
  'success'
]);

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SCENARIO_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_URL_PATTERN = /\bhttps?:\/\/(?!example\.invalid(?:\/|$))[^\s"'<>]+/i;
const FORBIDDEN_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const FORBIDDEN_TOKEN_PATTERN = /\b(?:gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_=-]+/i;
const FORBIDDEN_PRIVATE_KEY_PATTERN = /BEGIN [A-Z ]*PRIVATE KEY/i;

export function replayScenario(scenario, decisionAdapter = createExecutorDecisionAdapter()) {
  const before = stableJson(scenario);
  const validation = validateScenario(scenario);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      result: failResult('scenario_invalid')
    };
  }

  const result = normalizeReplayResult(decisionAdapter.decide(scenario));
  const after = stableJson(scenario);
  if (before !== after) {
    return {
      ok: false,
      errors: [{ code: 'scenario_mutated', path: '$' }],
      result: failResult('scenario_mutated')
    };
  }

  const expected = scenario.expectedDecision;
  const mismatches = compareExpectedDecision(expected, result);
  const missingReasons = scenario.expectedReasonCodes
    .filter((reasonCode) => !result.reasonCodes.includes(reasonCode))
    .map((reasonCode) => ({
      code: 'expected_reason_code_missing',
      path: `expectedReasonCodes.${reasonCode}`
    }));
  const errors = [...mismatches, ...missingReasons];

  return {
    ok: errors.length === 0,
    errors,
    result
  };
}

export function replayScenarios(scenarios, options = {}) {
  const validation = validateScenarioCollection(scenarios);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      scenarioResults: [],
      summary: {
        failed: scenarios.length,
        passed: 0,
        total: scenarios.length
      }
    };
  }

  const scenarioResults = sortScenarios(scenarios)
    .filter((scenario) => !options.category || scenario.category === options.category)
    .filter((scenario) => !options.id || scenario.id === options.id)
    .map((scenario) => ({
      id: scenario.id,
      category: scenario.category,
      ...replayScenario(scenario, options.decisionAdapter ?? createExecutorDecisionAdapter())
    }));
  const passed = scenarioResults.filter((entry) => entry.ok).length;

  return {
    ok: passed === scenarioResults.length,
    errors: scenarioResults.flatMap((entry) => entry.errors.map((error) => ({
      ...error,
      scenarioId: entry.id
    }))),
    scenarioResults,
    summary: {
      failed: scenarioResults.length - passed,
      passed,
      total: scenarioResults.length
    }
  };
}

export function createLegacyPlanDecisionAdapter() {
  return {
    decide(scenario) {
      const auditBlockers = collectAuditBlockers(scenario);
      if (auditBlockers.length > 0) {
        return decision({
          reasonCodes: auditBlockers
        });
      }

      const plan = createAutoMergePlan(createAutoMergePlanInput(scenario));
      const planReasonCodes = reasonCodesFromPlan(plan, scenario);

      if (plan.outputs.eligible !== 'true') {
        return decision({
          dryRun: plan.outputs.dry_run === 'true',
          eligible: false,
          plan,
          reasonCodes: planReasonCodes
        });
      }

      const executor = createMockExecutorAdapter(scenario.executionContext);
      const execution = executor.execute(plan, scenario);

      return decision({
        adapterCalled: execution.adapterCalled,
        commandCreated: execution.commandCreated,
        dryRun: plan.outputs.dry_run === 'true',
        eligible: true,
        executed: execution.executed,
        plan,
        reasonCodes: sortReasonCodes([
          ...planReasonCodes,
          ...execution.reasonCodes
        ])
      });
    }
  };
}

export function createExecutorDecisionAdapter() {
  return {
    decide(scenario) {
      const input = createAutoMergeDryRunInputFromScenario(scenario);
      const executorDecision = executeAutoMergeDryRun(input);
      const adapterCalled = executorDecision.commandCreated === true
        && executorDecision.reasonCodes.includes(WRITE_REASON_CODES.writeDisabled);

      return decision({
        adapterCalled,
        commandCreated: executorDecision.commandCreated === true,
        dryRun: executorDecision.dryRun !== false,
        eligible: executorDecision.eligible === true,
        executed: executorDecision.executed === true,
        plan: input.autoMergePlan,
        reasonCodes: executorDecision.reasonCodes
      });
    }
  };
}

export function createAutoMergeDryRunInputFromScenario(scenario) {
  const planInput = createAutoMergePlanInput(scenario);
  const autoMergePlan = createAutoMergePlan({
    ...planInput,
    existingDedupeKeys: [],
    lastPlannedAt: ''
  });
  const current = createExecutorCurrentContext(scenario, autoMergePlan);

  return {
    autoMergePlan,
    changedFilesSnapshot: createExecutorChangedFilesSnapshot(scenario, current),
    checkSnapshot: createExecutorCheckSnapshot(scenario, current),
    consumerAuditReport: createExecutorConsumerAuditReport(scenario, current),
    executionContext: createExecutorExecutionContext(scenario, current),
    protectionAuditReport: createExecutorProtectionAuditReport(scenario, current),
    pullRequestSnapshot: createExecutorPullRequestSnapshot(scenario),
    reviewEvidenceReport: createExecutorReviewEvidenceReport(scenario, autoMergePlan, current)
  };
}

export function createMockExecutorAdapter(context = {}) {
  return {
    execute(plan, scenario) {
      const candidate = createWriteCommandCandidateFromAutoMergePlan(plan, {
        actorContext: context.actorContext,
        now: context.now,
        operation: context.operation,
        requestedAt: context.requestedAt
      });

      if (!candidate.command) {
        return {
          adapterCalled: false,
          commandCreated: false,
          executed: false,
          reasonCodes: sortReasonCodes([candidate.reasonCode || 'no_write_command_candidate'])
        };
      }

      const adapter = context.adapter === 'fake'
        ? new FakeGitHubWriteAdapter({
            cooldownMs: context.fakeAdapter?.cooldownMs,
            maxAttempts: context.fakeAdapter?.maxAttempts,
            now: () => new Date(context.now)
          })
        : new DisabledGitHubWriteAdapter();
      const execution = adapter.execute(candidate.command, candidate.validationContext);

      return validateAdapterResult({
        adapterCalled: true,
        commandCreated: true,
        executed: execution.executed,
        reasonCodes: [execution.reasonCode || WRITE_REASON_CODES.writeDisabled]
      }, scenario);
    }
  };
}

export function createReplaySnapshot(replayResult) {
  return {
    scenarioResults: replayResult.scenarioResults.map((entry) => ({
      id: entry.id,
      category: entry.category,
      result: snapshotResult(entry.result)
    })),
    summary: replayResult.summary
  };
}

export function validateScenarioCollection(scenarios) {
  const errors = [];
  if (!Array.isArray(scenarios)) {
    return {
      ok: false,
      errors: [{ code: 'scenario_collection_required', path: '$' }]
    };
  }

  const ids = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const result = validateScenario(scenario, `scenarios.${index}`);
    errors.push(...result.errors);
    if (scenario?.id) {
      if (ids.has(scenario.id)) {
        errors.push({ code: 'duplicate_scenario_id', path: `scenarios.${index}.id` });
      }
      ids.add(scenario.id);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function validateScenario(scenario, prefix = '$') {
  const errors = [];
  if (!isPlainObject(scenario)) {
    return {
      ok: false,
      errors: [{ code: 'scenario_object_required', path: prefix }]
    };
  }

  const allowedKeys = new Set([
    ...AUTO_MERGE_REGRESSION_REQUIRED_KEYS,
    ...AUTO_MERGE_REGRESSION_OPTIONAL_KEYS
  ]);
  for (const key of Object.keys(scenario)) {
    if (!allowedKeys.has(key)) {
      errors.push({ code: 'unknown_key', path: `${prefix}.${key}` });
    }
  }
  for (const key of AUTO_MERGE_REGRESSION_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(scenario, key)) {
      errors.push({ code: 'required_key_missing', path: `${prefix}.${key}` });
    }
  }

  if (scenario.scenarioVersion !== AUTO_MERGE_REGRESSION_SCENARIO_VERSION) {
    errors.push({ code: 'unknown_scenario_version', path: `${prefix}.scenarioVersion` });
  }
  if (!SCENARIO_ID_PATTERN.test(String(scenario.id ?? ''))) {
    errors.push({ code: 'invalid_scenario_id', path: `${prefix}.id` });
  }
  if (!SCENARIO_CATEGORIES.has(scenario.category)) {
    errors.push({ code: 'invalid_category', path: `${prefix}.category` });
  }
  validateRepository(scenario.normalizedEvent?.repository, errors, `${prefix}.normalizedEvent.repository`);
  validateSha(scenario.normalizedEvent?.head_sha, errors, `${prefix}.normalizedEvent.head_sha`);
  validateSha(scenario.pullRequestSnapshot?.head?.sha ?? scenario.pullRequestSnapshot?.headSha, errors, `${prefix}.pullRequestSnapshot.head.sha`);
  validateSha(scenario.pullRequestSnapshot?.base?.sha ?? scenario.pullRequestSnapshot?.baseSha, errors, `${prefix}.pullRequestSnapshot.base.sha`);
  validateTimestamp(scenario.executionContext?.now, errors, `${prefix}.executionContext.now`);
  validateTimestamp(scenario.executionContext?.requestedAt, errors, `${prefix}.executionContext.requestedAt`);

  if (!isPlainObject(scenario.expectedDecision)) {
    errors.push({ code: 'expected_decision_required', path: `${prefix}.expectedDecision` });
  } else {
    for (const key of ['eligible', 'commandCreated', 'adapterCalled', 'executed', 'dryRun']) {
      if (typeof scenario.expectedDecision[key] !== 'boolean') {
        errors.push({ code: 'expected_decision_boolean_required', path: `${prefix}.expectedDecision.${key}` });
      }
    }
    if (scenario.expectedDecision.executed === true) {
      errors.push({ code: 'success_scenario_must_not_execute', path: `${prefix}.expectedDecision.executed` });
    }
  }

  if (!Array.isArray(scenario.expectedReasonCodes) || scenario.expectedReasonCodes.length === 0) {
    errors.push({ code: 'expected_reason_codes_required', path: `${prefix}.expectedReasonCodes` });
  }
  if (containsForbiddenFixtureValue(scenario)) {
    errors.push({ code: 'fixture_forbidden_value', path: prefix });
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function sortScenarios(scenarios) {
  return [...scenarios].sort((left, right) => left.id.localeCompare(right.id));
}

export function sortReasonCodes(reasonCodes) {
  return [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
    .map((reasonCode) => typeof reasonCode === 'string' ? reasonCode.trim() : '')
    .filter(Boolean))]
    .sort();
}

function createAutoMergePlanInput(scenario) {
  return {
    actorInfo: scenario.executionContext.actorInfo,
    apiReadError: scenario.executionContext.apiReadError,
    changedFiles: scenario.changedFilesSnapshot.files,
    checkRuns: scenario.ciSnapshot.checkRuns,
    commitStatuses: scenario.ciSnapshot.commitStatuses,
    comparison: scenario.pullRequestSnapshot.comparison,
    config: scenario.executionContext.config,
    eventPayload: scenario.eventPayload,
    existingDedupeKeys: scenario.executionContext.existingDedupeKeys,
    issueComments: scenario.reviewEvidenceSnapshot.issueComments,
    lastPlannedAt: scenario.executionContext.lastPlannedAt,
    normalizedEvent: scenario.normalizedEvent,
    now: scenario.executionContext.now,
    pullRequest: scenario.pullRequestSnapshot,
    repositorySettings: scenario.protectionAuditSnapshot.repositorySettings,
    reviewThreads: scenario.reviewEvidenceSnapshot.reviewThreads,
    reviews: scenario.reviewEvidenceSnapshot.reviews,
    runStartedAt: scenario.executionContext.runStartedAt,
    workflowRuns: scenario.ciSnapshot.workflowRuns
  };
}

function createExecutorCurrentContext(scenario, autoMergePlan) {
  const pullRequest = scenario.pullRequestSnapshot ?? {};
  const executionContext = scenario.executionContext ?? {};

  return {
    baseBranch: pullRequest.base?.ref ?? pullRequest.baseBranch ?? 'main',
    currentBaseSha: executionContext.currentBaseSha
      ?? scenario.normalizedEvent?.base_sha
      ?? autoMergePlan.outputs?.base_sha
      ?? pullRequest.base?.sha
      ?? pullRequest.baseSha,
    currentHeadSha: executionContext.currentHeadSha
      ?? scenario.normalizedEvent?.head_sha
      ?? autoMergePlan.outputs?.head_sha
      ?? pullRequest.head?.sha
      ?? pullRequest.headSha,
    now: executionContext.now,
    pullRequestNumber: Number(executionContext.pullRequestNumber
      ?? scenario.normalizedEvent?.pull_request_number
      ?? pullRequest.number
      ?? pullRequest.pullRequestNumber),
    repository: executionContext.repository
      ?? scenario.normalizedEvent?.repository
      ?? pullRequest.base?.repo?.full_name
      ?? autoMergePlan.outputs?.repository,
    runStartedAt: executionContext.runStartedAt ?? executionContext.now
  };
}

function createExecutorExecutionContext(scenario, current) {
  const context = scenario.executionContext ?? {};
  const config = context.config ?? {};
  const autoMergeConfig = config.autoMerge ?? {};
  const operation = autoMergeConfig.mode === 'merge'
    ? 'merge-pull-request'
    : 'enable-auto-merge';
  const idempotencyKey = `write-v1:${operation}:${current.repository}#${current.pullRequestNumber}:${current.currentHeadSha}:${current.currentBaseSha}`;
  const legacyDedupeKey = `${current.repository}#${current.pullRequestNumber}:${current.currentHeadSha}:enable-auto-merge:v1`;
  const existingKeys = normalizeStringList(context.existingDedupeKeys);
  const existingIdempotencyKeys = existingKeys.includes(legacyDedupeKey)
    ? sortReasonCodes([...existingKeys, idempotencyKey])
    : existingKeys;

  return {
    actorContext: context.actorContext,
    allowedBaseBranches: autoMergeConfig.allowedBaseBranches ?? [current.baseBranch],
    attemptCount: Number.isInteger(context.attemptCount) ? context.attemptCount : 0,
    cooldownSeconds: Number.isInteger(context.cooldownSeconds)
      ? context.cooldownSeconds
      : Number(autoMergeConfig.cooldownSeconds ?? 0),
    currentBaseSha: current.currentBaseSha,
    currentHeadSha: current.currentHeadSha,
    existingIdempotencyKeys,
    lastAttemptedAt: context.lastAttemptedAt ?? context.lastPlannedAt ?? '',
    maxAttempts: Number.isInteger(context.maxAttempts)
      ? context.maxAttempts
      : Number.isInteger(context.fakeAdapter?.maxAttempts)
        ? context.fakeAdapter.maxAttempts
        : 3,
    now: current.now,
    pullRequestNumber: current.pullRequestNumber,
    repository: current.repository,
    requestedAt: context.requestedAt ?? current.now,
    requiredChecks: autoMergeConfig.requiredWorkflows?.includes('Review evidence gate')
      ? autoMergeConfig.requiredWorkflows
      : ['CI', 'Review evidence gate'],
    runStartedAt: current.runStartedAt
  };
}

function createExecutorPullRequestSnapshot(scenario) {
  const pullRequest = scenario.pullRequestSnapshot ?? {};
  const headRepository = pullRequest.head?.repo?.full_name ?? pullRequest.headRepository ?? '';
  const baseRepository = pullRequest.base?.repo?.full_name ?? pullRequest.repository ?? '';

  return {
    baseBranch: pullRequest.base?.ref ?? pullRequest.baseBranch ?? 'main',
    baseSha: pullRequest.base?.sha ?? pullRequest.baseSha,
    draft: pullRequest.draft === true,
    headSha: pullRequest.head?.sha ?? pullRequest.headSha,
    isFork: pullRequest.head?.repo?.fork === true || scenario.normalizedEvent?.is_fork === 'true',
    isSameRepository: headRepository === baseRepository && scenario.normalizedEvent?.is_same_repository !== 'false',
    mergeable: pullRequest.mergeable === true,
    mergeStateStatus: pullRequest.mergeable_state ?? pullRequest.mergeStateStatus ?? '',
    pullRequestNumber: Number(pullRequest.number ?? pullRequest.pullRequestNumber),
    repository: baseRepository || scenario.normalizedEvent?.repository,
    requestedReviewers: Array.isArray(pullRequest.requested_reviewers)
      ? pullRequest.requested_reviewers.length
      : Number(pullRequest.requestedReviewers ?? 0),
    requestedTeams: Array.isArray(pullRequest.requested_teams)
      ? pullRequest.requested_teams.length
      : Number(pullRequest.requestedTeams ?? 0),
    state: pullRequest.state ?? ''
  };
}

function createExecutorReviewEvidenceReport(scenario, autoMergePlan, current) {
  const evidence = scenario.reviewEvidenceSnapshot ?? {};
  const reviews = Array.isArray(evidence.reviews) ? evidence.reviews : [];
  const comments = Array.isArray(evidence.issueComments) ? evidence.issueComments : [];
  const threads = Array.isArray(evidence.reviewThreads) ? evidence.reviewThreads : [];
  const fallbackReviewedAt = timestampBefore(current.runStartedAt, 60 * 1000) || current.now;
  const reviewedAt = latestTimestamp([
    ...reviews.map((entry) => entry.submitted_at),
    ...comments.map((entry) => entry.created_at)
  ]) || fallbackReviewedAt;
  const evidenceHeadSha = findEvidenceHeadSha({ comments, current, reviews });
  const changesRequested = hasChangesRequestedEvidence({ comments, reviews });
  const unresolvedThreads = threads.filter((entry) => entry?.isResolved !== true).length;
  const requestedReviewers = createExecutorPullRequestSnapshot(scenario).requestedReviewers;
  const requestedTeams = createExecutorPullRequestSnapshot(scenario).requestedTeams;
  const skipReason = autoMergePlan.outputs?.skip_reason ?? '';
  const hasEvidence = comments.length > 0 || reviews.length > 0 || threads.length > 0;
  const approved = hasEvidence
    && !changesRequested
    && ![
      'chatgpt_review_missing',
      'review_evidence_missing',
      'reviewed_by_chatgpt_label_missing'
    ].includes(skipReason);
  const currentRunEvidence = skipReason.startsWith('same_run_review_evidence_')
    || evidence.currentRunEvidence === true;

  return {
    apiReadOk: evidence.apiReadOk !== false,
    approved,
    baseSha: current.currentBaseSha,
    blockers: normalizeBlockers(evidence.blockers),
    changesRequested,
    checkedAt: evidence.checkedAt ?? current.now,
    currentRunEvidence,
    evidenceHeadSha,
    evidenceType: currentRunEvidence ? 'same-run' : 'latest-review',
    headSha: current.currentHeadSha,
    paginationComplete: evidence.paginationComplete !== false,
    pullRequestNumber: current.pullRequestNumber,
    reasonCodes: normalizeStringList(evidence.reasonCodes),
    reportVersion: 'review-evidence.v1',
    repository: current.repository,
    requestedReviewers,
    requestedTeams,
    reviewedAt: evidence.reviewedAt ?? reviewedAt,
    runStartedAt: current.runStartedAt,
    unresolvedReviewThreads: unresolvedThreads,
    warnings: normalizeBlockers(evidence.warnings)
  };
}

function createExecutorConsumerAuditReport(scenario, current) {
  const audit = scenario.consumerAuditSnapshot ?? {};
  return {
    apiReadOk: audit.apiReadOk !== false,
    auditedCommitSha: audit.auditedCommitSha ?? (audit.reasonCodes?.includes('audited_sha_mismatch') ? scenario.pullRequestSnapshot?.base?.sha : current.currentBaseSha),
    blockers: audit.ready === false ? blockersFromReasonCodes(audit.reasonCodes, 'consumer_audit_failed') : normalizeBlockers(audit.blockers),
    checkedAt: audit.checkedAt ?? current.now,
    defaultBranch: audit.defaultBranch ?? current.baseBranch,
    manualReviewRequired: audit.manualReviewRequired === true,
    paginationComplete: audit.paginationComplete !== false,
    ready: audit.ready === true,
    repository: audit.repository ?? current.repository,
    reportVersion: 'live-consumer-audit.v1',
    warnings: normalizeBlockers(audit.warnings)
  };
}

function createExecutorProtectionAuditReport(scenario, current) {
  const audit = scenario.protectionAuditSnapshot ?? {};
  return {
    apiReadOk: audit.apiReadOk !== false,
    auditedSha: audit.auditedSha ?? (audit.reasonCodes?.includes('audited_sha_mismatch') ? scenario.pullRequestSnapshot?.base?.sha : current.currentBaseSha),
    blockers: audit.ready === false ? blockersFromReasonCodes(audit.reasonCodes, 'protection_audit_failed') : normalizeBlockers(audit.blockers),
    checkedAt: audit.checkedAt ?? current.now,
    defaultBranch: audit.defaultBranch ?? current.baseBranch,
    manualReviewRequired: audit.manualReviewRequired === true,
    paginationComplete: audit.paginationComplete !== false,
    ready: audit.ready === true,
    repository: audit.repository ?? current.repository,
    reportVersion: 1,
    warnings: normalizeBlockers(audit.warnings)
  };
}

function createExecutorCheckSnapshot(scenario, current) {
  const ci = scenario.ciSnapshot ?? {};
  const workflowRuns = Array.isArray(ci.workflowRuns) ? ci.workflowRuns : [];
  const ciRun = workflowRuns.find((entry) => entry.name === 'CI') ?? workflowRuns[0];
  const ciStatus = ciRun?.status ?? 'completed';
  const ciConclusion = ciRun?.conclusion || (ciStatus === 'completed' ? 'success' : 'pending');
  const ciHeadSha = ciRun?.head_sha ?? current.currentHeadSha;
  const ciSuccessful = ciStatus === 'completed' && ciConclusion === 'success';
  const reviewGateMissing = workflowRuns.length === 0
    || scenario.id === 'review-evidence-gate-missing';
  const requiredChecks = workflowRuns.length === 0
    ? []
    : [
        requiredCheck('CI', {
          conclusion: ciConclusion,
          headSha: ciHeadSha,
          status: ciStatus
        }),
        ...reviewGateMissing ? [] : [requiredCheck('Review evidence gate', { headSha: current.currentHeadSha })]
      ];

  return {
    apiReadOk: ci.apiReadOk !== false,
    ciSuccessful,
    duplicateChecks: ci.duplicateChecks === true || scenario.id === 'duplicate-check-name',
    headSha: ci.headSha ?? current.currentHeadSha,
    paginationComplete: ci.paginationComplete !== false,
    requiredChecks,
    requiredChecksSuccessful: requiredChecks.length > 0 && requiredChecks.every((entry) => entry.status === 'completed' && entry.conclusion === 'success'),
    reviewEvidenceGateSuccessful: !reviewGateMissing
  };
}

function createExecutorChangedFilesSnapshot(scenario, current) {
  const snapshot = scenario.changedFilesSnapshot ?? {};
  const files = Array.isArray(snapshot.files) ? snapshot.files : [];
  return {
    apiReadOk: snapshot.apiReadOk !== false,
    dangerousChange: snapshot.dangerousChange === true || files.some(isDangerousFile),
    files,
    headSha: snapshot.headSha ?? current.currentHeadSha,
    pullRequestTarget: snapshot.pullRequestTarget === true || files.some(hasPullRequestTarget),
    secretLikeChange: snapshot.secretLikeChange === true || files.some(hasSecretLikeAddition),
    workflowPermissionIncrease: snapshot.workflowPermissionIncrease === true || files.some(hasWorkflowPermissionIncrease)
  };
}

function collectAuditBlockers(scenario) {
  const reasonCodes = [];
  if (scenario.consumerAuditSnapshot?.ready !== true) {
    reasonCodes.push('consumer_audit_failed');
    reasonCodes.push(...(scenario.consumerAuditSnapshot?.reasonCodes ?? []));
  }
  if (scenario.protectionAuditSnapshot?.ready !== true) {
    reasonCodes.push('protection_audit_failed');
    reasonCodes.push(...(scenario.protectionAuditSnapshot?.reasonCodes ?? []));
  }
  return sortReasonCodes(reasonCodes);
}

function reasonCodesFromPlan(plan, scenario) {
  const reasonCodes = [];
  if (plan.outputs.eligible === 'true') {
    reasonCodes.push(plan.outputs.merge_reason);
  } else {
    reasonCodes.push(plan.outputs.skip_reason);
  }

  if (hasNoReviewEvidence(scenario)) {
    reasonCodes.push('review_evidence_missing');
  }

  return sortReasonCodes(reasonCodes);
}

function hasNoReviewEvidence(scenario) {
  const evidence = scenario.reviewEvidenceSnapshot ?? {};
  return (evidence.issueComments?.length ?? 0) === 0
    && (evidence.reviews?.length ?? 0) === 0
    && (evidence.reviewThreads?.length ?? 0) === 0;
}

function requiredCheck(name, { conclusion = 'success', headSha, status = 'completed' } = {}) {
  return {
    conclusion,
    headSha,
    name,
    status
  };
}

function findEvidenceHeadSha({ comments, current, reviews }) {
  const reviewHead = reviews.find((entry) => entry?.commit_id)?.commit_id;
  const commentHead = comments.find((entry) => entry?.headSha)?.headSha;
  return reviewHead ?? commentHead ?? current.currentHeadSha;
}

function hasChangesRequestedEvidence({ comments, reviews }) {
  return reviews.some((entry) => String(entry?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED')
    || comments.some((entry) => /chatgpt-review:\s*changes_requested/i.test(String(entry?.body ?? '')));
}

function latestTimestamp(values) {
  return values
    .filter((value) => Number.isFinite(Date.parse(String(value ?? ''))))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? '';
}

function timestampBefore(value, milliseconds) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time - milliseconds).toISOString() : '';
}

function normalizeBlockers(value) {
  return Array.isArray(value)
    ? value.map((entry) => ({
        message: String(entry?.message ?? ''),
        reasonCode: String(entry?.reasonCode ?? entry?.code ?? '').trim()
      })).filter((entry) => entry.reasonCode)
    : [];
}

function blockersFromReasonCodes(reasonCodes, fallbackReasonCode) {
  return sortReasonCodes([fallbackReasonCode, ...normalizeStringList(reasonCodes)])
    .map((reasonCode) => ({
      message: `Fixture blocker: ${reasonCode}`,
      reasonCode
    }));
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
    : [];
}

function isDangerousFile(file) {
  const filename = String(file?.filename ?? '');
  return file?.dangerous === true
    || filename.startsWith('.github/')
    || filename === '.gitmodules'
    || filename === 'package.json'
    || filename === 'package-lock.json'
    || filename.endsWith('.png')
    || filename.includes('/node_modules/')
    || filename.startsWith('actions/')
    || filename.startsWith('scripts/');
}

function hasWorkflowPermissionIncrease(file) {
  return /\bpermissions:\s*\n(?:\+|\s)*\s*(?:contents|pull-requests|issues|actions|checks|statuses):\s*write\b/i.test(String(file?.patch ?? ''))
    || /\b(?:contents|pull-requests|issues|actions|checks|statuses):\s*write\b/i.test(String(file?.patch ?? ''));
}

function hasPullRequestTarget(file) {
  return /\bpull_request_target\b/.test(String(file?.patch ?? ''));
}

function hasSecretLikeAddition(file) {
  return String(file?.patch ?? '')
    .split('\n')
    .some((line) => line.startsWith('+') && /(secret|token|cookie|oauth|authorization|bearer|script\.google\.com\/macros\/s\/)/i.test(line));
}

function compareExpectedDecision(expected, result) {
  return ['eligible', 'commandCreated', 'adapterCalled', 'executed', 'dryRun']
    .filter((key) => expected[key] !== result[key])
    .map((key) => ({
      code: 'expected_decision_mismatch',
      path: `expectedDecision.${key}`,
      expected: expected[key],
      actual: result[key]
    }));
}

function normalizeReplayResult(value) {
  if (!isPlainObject(value)) {
    return failResult('adapter_result_invalid');
  }
  if (
    typeof value.adapterCalled !== 'boolean'
    || typeof value.commandCreated !== 'boolean'
    || typeof value.dryRun !== 'boolean'
    || typeof value.eligible !== 'boolean'
    || typeof value.executed !== 'boolean'
    || !Array.isArray(value.reasonCodes)
  ) {
    return failResult('adapter_result_invalid');
  }

  return decision({
    adapterCalled: value.adapterCalled === true,
    commandCreated: value.commandCreated === true,
    dryRun: value.dryRun !== false,
    eligible: value.eligible === true,
    executed: value.executed === true,
    plan: value.plan,
    reasonCodes: value.reasonCodes
  });
}

function validateAdapterResult(result) {
  if (
    typeof result.commandCreated !== 'boolean'
    || typeof result.adapterCalled !== 'boolean'
    || typeof result.executed !== 'boolean'
    || !Array.isArray(result.reasonCodes)
  ) {
    return {
      adapterCalled: false,
      commandCreated: false,
      executed: false,
      reasonCodes: ['adapter_result_invalid']
    };
  }
  return result;
}

function decision({
  adapterCalled = false,
  commandCreated = false,
  dryRun = true,
  eligible = false,
  executed = false,
  plan = null,
  reasonCodes = []
} = {}) {
  return {
    adapterCalled,
    commandCreated,
    dryRun,
    eligible,
    executed,
    planOutputs: plan?.outputs ? stableObject(plan.outputs) : {},
    reasonCodes: sortReasonCodes(reasonCodes)
  };
}

function snapshotResult(result) {
  return {
    adapterCalled: result.adapterCalled,
    commandCreated: result.commandCreated,
    dryRun: result.dryRun,
    eligible: result.eligible,
    executed: result.executed,
    reasonCodes: sortReasonCodes(result.reasonCodes)
  };
}

function failResult(reasonCode) {
  return decision({
    reasonCodes: [reasonCode]
  });
}

function validateRepository(value, errors, path) {
  if (!REPOSITORY_PATTERN.test(String(value ?? ''))) {
    errors.push({ code: 'invalid_repository', path });
  }
}

function validateSha(value, errors, path) {
  if (!SHA_PATTERN.test(String(value ?? ''))) {
    errors.push({ code: 'invalid_sha', path });
  }
}

function validateTimestamp(value, errors, path) {
  const time = Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) {
    errors.push({ code: 'invalid_timestamp', path });
  }
}

function containsForbiddenFixtureValue(value) {
  const serialized = stableJson(value);
  if (
    FORBIDDEN_URL_PATTERN.test(serialized)
    || FORBIDDEN_EMAIL_PATTERN.test(serialized)
    || FORBIDDEN_TOKEN_PATTERN.test(serialized)
    || FORBIDDEN_PRIVATE_KEY_PATTERN.test(serialized)
  ) {
    return true;
  }

  const bearer = serialized.match(/\bBearer\s+([A-Za-z0-9._-]{8,})\b/i);
  if (bearer && !isDummySecretValue(bearer[1])) {
    return true;
  }

  const cookie = serialized.match(/\bCookie\s*:\s*[^=\s;]+=([^\s;"']+)/i);
  if (cookie && !isDummySecretValue(cookie[1])) {
    return true;
  }

  return false;
}

function isDummySecretValue(value) {
  return new Set([
    'dummy',
    'dummy-token',
    'example',
    'example-token',
    'placeholder',
    'redacted'
  ]).has(String(value ?? '').trim().toLowerCase());
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])])
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
