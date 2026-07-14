import { createAutoMergePlan } from '../auto-merge/index.js';
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

export function replayScenario(scenario, decisionAdapter = createLegacyPlanDecisionAdapter()) {
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
      ...replayScenario(scenario, options.decisionAdapter ?? createLegacyPlanDecisionAdapter())
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

  const allowedKeys = new Set(AUTO_MERGE_REGRESSION_REQUIRED_KEYS);
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
    existingDedupeKeys: scenario.executionContext.existingDedupeKeys,
    issueComments: scenario.reviewEvidenceSnapshot.issueComments,
    lastPlannedAt: scenario.executionContext.lastPlannedAt,
    normalizedEvent: scenario.normalizedEvent,
    now: scenario.executionContext.now,
    pullRequest: scenario.pullRequestSnapshot,
    repositorySettings: scenario.protectionAuditSnapshot.repositorySettings,
    reviewThreads: scenario.reviewEvidenceSnapshot.reviewThreads,
    reviews: scenario.reviewEvidenceSnapshot.reviews,
    workflowRuns: scenario.ciSnapshot.workflowRuns
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
