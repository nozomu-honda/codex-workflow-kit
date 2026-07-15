import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  createReplaySnapshot,
  replayScenario,
  replayScenarios,
  sortScenarios,
  validateScenario,
  validateScenarioCollection
} from '../../../packages/chatgpt-automation-core/src/auto-merge-regressions/index.js';
import {
  AUTO_MERGE_REGRESSION_SCENARIOS,
  buildAutoMergeRegressionScenarios,
  scenario
} from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '../snapshots/auto-merge-regressions.snapshot.json');
const SCHEMA_PATH = resolve(__dirname, '../schema.json');
const CLI_PATH = resolve(__dirname, '../../../scripts/replay-auto-merge-scenarios.mjs');

test('scenario collection is valid and contains required regression coverage', async () => {
  const scenarios = buildAutoMergeRegressionScenarios();
  const validation = validateScenarioCollection(scenarios);
  assert.equal(validation.ok, true);
  assert.equal(scenarios.length >= 35, true);
  assertRequiredIds([
    'no-review-evidence-regression',
    'stale-human-approval',
    'stale-chatgpt-marker',
    'same-run-review-evidence',
    'same-run-review-evidence-after-run-start',
    'same-run-review-evidence-same-second',
    'same-run-review-evidence-id-mismatch',
    'same-run-review-evidence-actor-mismatch',
    'same-run-review-evidence-stale-head',
    'changes-requested',
    'unresolved-review-thread',
    'requested-reviewer-remaining',
    'current-head-valid-review',
    'closed-pr',
    'draft-pr',
    'fork-pr',
    'external-repository',
    'head-sha-changed',
    'base-sha-changed',
    'mergeability-unknown',
    'conflict-dirty',
    'ci-pending',
    'ci-failure',
    'required-check-missing',
    'review-evidence-gate-missing',
    'check-head-sha-mismatch',
    'duplicate-check-name',
    'consumer-audit-failure',
    'consumer-audit-sha-mismatch',
    'protection-audit-failure',
    'ruleset-missing',
    'bypass-actor-unknown',
    'force-push-allowed',
    'branch-deletion-allowed',
    'dangerous-file',
    'workflow-permission-increase',
    'pull-request-target',
    'secret-like-addition',
    'binary-file',
    'submodule-change',
    'duplicate-idempotency-key',
    'cooldown-active',
    'attempt-limit-exceeded',
    'command-expired',
    'future-timestamp',
    'safe-candidate-write-disabled'
  ], scenarios);

  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  for (const entry of scenarios) {
    assert.equal(validate(entry), true, `${entry.id}: ${ajv.errorsText(validate.errors)}`);
  }
});

test('replay scenarios are deterministic and match expected decisions', () => {
  const first = replayScenarios(buildAutoMergeRegressionScenarios());
  const second = replayScenarios(buildAutoMergeRegressionScenarios());

  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.scenarioResults.map((entry) => entry.id), sortScenarios(AUTO_MERGE_REGRESSION_SCENARIOS).map((entry) => entry.id));
  assert.equal(first.summary.failed, 0);
});

test('snapshot contains only stable replay fields', async () => {
  const replay = replayScenarios(buildAutoMergeRegressionScenarios());
  const snapshot = createReplaySnapshot(replay);
  const expected = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));

  assert.deepEqual(snapshot, expected);
  const serialized = JSON.stringify(snapshot);
  assert.equal(/elapsed|duration|C:\\|\/Users\/|GITHUB_TOKEN|Authorization|Cookie|github\.com/i.test(serialized), false);
});

test('specific review and safety regressions keep expected reason codes', () => {
  const byId = replayById();

  assertResult(byId['no-review-evidence-regression'], {
    adapterCalled: false,
    commandCreated: false,
    eligible: false,
    reasonCodes: ['review_evidence_missing', 'reviewed_by_chatgpt_label_missing']
  });
  assertResult(byId['stale-human-approval'], {
    eligible: false,
    reasonCodes: ['review_not_current']
  });
  assertResult(byId['same-run-review-evidence'], {
    adapterCalled: true,
    commandCreated: true,
    eligible: true,
    executed: false,
    reasonCodes: ['eligible_enable_auto_merge', 'write_disabled']
  });
  assertResult(byId['same-run-review-evidence-after-run-start'], {
    eligible: false,
    reasonCodes: ['same_run_review_evidence_after_run_start']
  });
  assertResult(byId['same-run-review-evidence-same-second'], {
    eligible: false,
    reasonCodes: ['same_run_review_evidence_indeterminate']
  });
  assertResult(byId['same-run-review-evidence-id-mismatch'], {
    eligible: false,
    reasonCodes: ['same_run_review_evidence_id_mismatch']
  });
  assertResult(byId['same-run-review-evidence-actor-mismatch'], {
    eligible: false,
    reasonCodes: ['same_run_review_evidence_actor_mismatch']
  });
  assertResult(byId['same-run-review-evidence-stale-head'], {
    eligible: false,
    reasonCodes: ['same_run_review_evidence_head_mismatch']
  });
  assertResult(byId['unresolved-review-thread'], {
    eligible: false,
    reasonCodes: ['unresolved_review_threads']
  });
  assertResult(byId['head-sha-changed'], {
    eligible: false,
    reasonCodes: ['head_sha_mismatch']
  });
  assertResult(byId['ci-failure'], {
    eligible: false,
    reasonCodes: ['required_ci_failed']
  });
  assertResult(byId['consumer-audit-failure'], {
    eligible: false,
    reasonCodes: ['consumer_audit_failed']
  });
  assertResult(byId['dangerous-file'], {
    eligible: false,
    reasonCodes: ['workflow_change_requires_manual_merge']
  });
  assertResult(byId['duplicate-idempotency-key'], {
    eligible: false,
    reasonCodes: ['duplicate_suppressed']
  });
  assertResult(byId['cooldown-active'], {
    eligible: false,
    reasonCodes: ['cooldown_active']
  });
  assertResult(byId['attempt-limit-exceeded'], {
    adapterCalled: true,
    commandCreated: true,
    eligible: true,
    reasonCodes: ['attempt_limit_exceeded']
  });
  assertResult(byId['safe-candidate-write-disabled'], {
    adapterCalled: true,
    commandCreated: true,
    eligible: true,
    executed: false,
    reasonCodes: ['write_disabled']
  });
});

test('same-run review evidence scenario uses distinct trigger input from current-head success', () => {
  const scenarios = Object.fromEntries(buildAutoMergeRegressionScenarios().map((entry) => [entry.id, entry]));
  const sameRun = scenarios['same-run-review-evidence'];
  const currentHead = scenarios['current-head-valid-review'];

  assert.notDeepEqual(sameRun.eventPayload, currentHead.eventPayload);
  assert.notDeepEqual(sameRun.normalizedEvent, currentHead.normalizedEvent);
  assert.notDeepEqual(sameRun.reviewEvidenceSnapshot, currentHead.reviewEvidenceSnapshot);
  assert.notDeepEqual(sameRun.executionContext, currentHead.executionContext);
  assert.equal(sameRun.normalizedEvent.event_name, 'pull_request_review');
  assert.equal(sameRun.executionContext.runStartedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(sameRun.eventPayload.review.id, sameRun.reviewEvidenceSnapshot.reviews[0].id);
  assert.equal(sameRun.eventPayload.review.user.login, sameRun.reviewEvidenceSnapshot.reviews[0].user.login);
  assert.equal(sameRun.eventPayload.review.commit_id, sameRun.reviewEvidenceSnapshot.reviews[0].commit_id);
  assert.equal(currentHead.normalizedEvent.event_name, 'workflow_run');
});

test('schema and collection validation fail closed on malformed scenarios', () => {
  const valid = buildAutoMergeRegressionScenarios()[0];
  assertInvalid({ ...valid, extra: true }, 'unknown_key');
  assertInvalid({ ...valid, scenarioVersion: 'auto-merge-regression.v0' }, 'unknown_scenario_version');
  assertInvalid({ ...valid, id: 'Invalid ID' }, 'invalid_scenario_id');
  assertInvalid({ ...valid, normalizedEvent: { ...valid.normalizedEvent, repository: 'bad repo' } }, 'invalid_repository');
  assertInvalid({ ...valid, normalizedEvent: { ...valid.normalizedEvent, head_sha: 'short' } }, 'invalid_sha');
  assertInvalid({ ...valid, executionContext: { ...valid.executionContext, now: 'not-a-date' } }, 'invalid_timestamp');
  assertInvalid({ ...valid, expectedDecision: { ...valid.expectedDecision, executed: true } }, 'success_scenario_must_not_execute');
  assertInvalid({ ...valid, description: 'https://github.com/owner/repo' }, 'fixture_forbidden_value');

  const duplicate = validateScenarioCollection([valid, { ...valid }]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.errors.some((error) => error.code === 'duplicate_scenario_id'), true);

  const missing = structuredClone(valid);
  delete missing.ciSnapshot;
  assertInvalid(missing, 'required_key_missing');
});

test('expected reason codes are enforced', () => {
  const valid = buildAutoMergeRegressionScenarios().find((entry) => entry.id === 'safe-candidate-write-disabled');
  const result = replayScenario({
    ...valid,
    expectedReasonCodes: ['nonexistent_reason']
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === 'expected_reason_code_missing'), true);
});

test('adapter result schema fails closed and scenario input is not mutated', () => {
  const valid = buildAutoMergeRegressionScenarios().find((entry) => entry.id === 'safe-candidate-write-disabled');
  const before = JSON.stringify(valid);
  const invalidAdapter = replayScenario(valid, {
    decide: () => ({ unexpected: true })
  });

  assert.equal(JSON.stringify(valid), before);
  assert.equal(invalidAdapter.ok, false);
  assert.equal(invalidAdapter.result.reasonCodes.includes('adapter_result_invalid'), true);
});

test('replay does not use network fetch, GitHub write, or environment token values', () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error('network disabled');
  };
  process.env.GITHUB_TOKEN = 'ghp_should_not_be_read';
  try {
    const replay = replayScenarios(buildAutoMergeRegressionScenarios());
    assert.equal(replay.ok, true);
    assert.equal(fetchCount, 0);
    assert.equal(JSON.stringify(replay).includes('ghp_should_not_be_read'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  }
});

test('CLI supports JSON output and scenario filtering without network access', () => {
  const output = execFileSync(process.execPath, [
    CLI_PATH,
    '--id',
    'safe-candidate-write-disabled',
    '--json'
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP
    }
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.total, 1);
  assert.equal(parsed.scenarioResults[0].id, 'safe-candidate-write-disabled');
  assert.equal(parsed.scenarioResults[0].result.executed, false);
});

test('CLI supports text output for the replay entrypoint used by npm scripts', () => {
  const output = execFileSync(process.execPath, [
    CLI_PATH,
    '--id',
    'safe-candidate-write-disabled'
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP
    }
  });

  assert.match(output, /Auto-merge regression replay: PASS/);
  assert.match(output, /safe-candidate-write-disabled: PASS/);
  assert.match(output, /executed=false/);
});

function replayById() {
  return Object.fromEntries(
    replayScenarios(buildAutoMergeRegressionScenarios()).scenarioResults
      .map((entry) => [entry.id, entry.result])
  );
}

function assertResult(result, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'reasonCodes') {
      for (const reasonCode of value) {
        assert.equal(result.reasonCodes.includes(reasonCode), true, `${reasonCode} missing in ${result.reasonCodes.join(',')}`);
      }
      continue;
    }
    assert.equal(result[key], value);
  }
}

function assertRequiredIds(ids, scenarios) {
  const actual = new Set(scenarios.map((entry) => entry.id));
  for (const id of ids) {
    assert.equal(actual.has(id), true, `missing scenario: ${id}`);
  }
}

function assertInvalid(value, code) {
  const result = validateScenario(value);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === code), true, `${code} not found in ${JSON.stringify(result.errors)}`);
}
