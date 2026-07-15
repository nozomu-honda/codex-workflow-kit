import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_MERGE_OUTPUT_NAMES } from '../packages/chatgpt-automation-core/src/auto-merge/index.js';
import {
  SAME_RUN_STARTED_AT,
  sameRunReviewEvidenceOverrides,
  scenario
} from '../fixtures/auto-merge-regressions/index.js';

const SCRIPT = fileURLToPath(new URL('./plan-auto-merge.mjs', import.meta.url));

test('CLIはpull_request_review triggerとAPI reviewのID、actor、head SHA一致を要求する', () => {
  const accepted = runCli({
    reviewSubmittedAt: '2025-12-31T23:59:59.000Z',
    runStartedAt: SAME_RUN_STARTED_AT
  });
  assert.equal(accepted.eligible, 'true');

  for (const [overrides, expectedReason] of [
    [{ apiReviewId: 'same-run-review-9002' }, 'same_run_review_evidence_id_mismatch'],
    [{ apiActor: 'other-chatgpt-reviewer' }, 'same_run_review_evidence_actor_mismatch'],
    [{ evidenceHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 'same_run_review_evidence_head_mismatch']
  ]) {
    const outputs = runCli({
      ...overrides,
      reviewSubmittedAt: '2025-12-31T23:59:59.000Z',
      runStartedAt: SAME_RUN_STARTED_AT
    });
    assert.equal(outputs.eligible, 'false');
    assert.match(outputs.skip_reason, new RegExp(expectedReason));
  }
});

test('CLIはrun開始前だけを採用し、開始後と同一秒を拒否する', () => {
  const before = runCli({
    reviewSubmittedAt: '2025-12-31T23:59:59.000Z',
    runStartedAt: '2026-01-01T00:00:00.000Z'
  });
  const after = runCli({
    reviewSubmittedAt: '2026-01-01T00:00:01.000Z',
    runStartedAt: '2026-01-01T00:00:00.000Z'
  });
  const sameSecond = runCli({
    reviewSubmittedAt: '2026-01-01T00:00:00.100Z',
    runStartedAt: '2026-01-01T00:00:00.900Z'
  });

  assert.equal(before.eligible, 'true');
  assert.equal(after.eligible, 'false');
  assert.match(after.skip_reason, /same_run_review_evidence_after_run_start/);
  assert.equal(sameSecond.eligible, 'false');
  assert.match(sameSecond.skip_reason, /same_run_review_evidence_indeterminate/);
});

test('CLIはrun開始時刻の欠落、空文字、不正値をfail closedにする', () => {
  const missing = runCli({ includeRunStartedAt: false });
  const empty = runCli({ runStartedAt: '' });
  const invalid = runCli({ runStartedAt: 'not-a-timestamp' });

  for (const outputs of [missing, empty, invalid]) {
    assert.equal(outputs.eligible, 'false');
    assert.match(outputs.skip_reason, /same_run_review_evidence_indeterminate/);
  }
});

test('CLIはevent payload内の時刻をruntime run開始時刻として代用しない', () => {
  const outputs = runCli({
    eventPayloadOverrides: {
      workflow_run: { run_started_at: SAME_RUN_STARTED_AT }
    },
    includeRunStartedAt: false
  });

  assert.equal(outputs.eligible, 'false');
  assert.match(outputs.skip_reason, /same_run_review_evidence_indeterminate/);
});

function runCli({
  eventPayloadOverrides = {},
  includeRunStartedAt = true,
  runStartedAt = SAME_RUN_STARTED_AT,
  ...sameRunOverrides
} = {}) {
  const fixture = scenario({
    category: 'review',
    description: 'CLI boundary fixture for runtime-owned run start.',
    expectedDecision: {},
    expectedReasonCodes: [],
    id: 'cli-run-start-boundary',
    overrides: sameRunReviewEvidenceOverrides(sameRunOverrides)
  });
  const eventPayload = {
    ...fixture.eventPayload,
    ...eventPayloadOverrides
  };
  const env = {
    ...process.env,
    ACTOR_INFO_JSON: JSON.stringify({ isOrganizationMember: true, permission: 'write' }),
    CHANGED_FILES_JSON: JSON.stringify(fixture.changedFilesSnapshot.files),
    CHECK_RUNS_JSON: JSON.stringify(fixture.ciSnapshot.checkRuns),
    COMMIT_STATUSES_JSON: JSON.stringify(fixture.ciSnapshot.commitStatuses),
    COMPARE_JSON: JSON.stringify(fixture.pullRequestSnapshot.comparison),
    EVENT_PAYLOAD_JSON: JSON.stringify(eventPayload),
    EXISTING_DEDUPE_KEYS: '',
    GITHUB_API_READ: 'false',
    GITHUB_OUTPUT: '',
    GITHUB_TOKEN: '',
    ISSUE_COMMENTS_JSON: JSON.stringify(fixture.reviewEvidenceSnapshot.issueComments),
    LAST_PLANNED_AT: '',
    NORMALIZED_EVENT_JSON: JSON.stringify(fixture.normalizedEvent),
    NOW: fixture.executionContext.now,
    PULL_REQUEST_CONTEXT_JSON: JSON.stringify(fixture.pullRequestSnapshot),
    REPOSITORY_CONFIG_JSON: JSON.stringify(fixture.executionContext.config),
    REPOSITORY_SETTINGS_JSON: JSON.stringify(fixture.protectionAuditSnapshot.repositorySettings),
    REVIEWS_JSON: JSON.stringify(fixture.reviewEvidenceSnapshot.reviews),
    REVIEW_THREADS_JSON: JSON.stringify(fixture.reviewEvidenceSnapshot.reviewThreads),
    WORKFLOW_RUNS_JSON: JSON.stringify(fixture.ciSnapshot.workflowRuns)
  };

  if (includeRunStartedAt) {
    env.RUN_STARTED_AT = runStartedAt;
  } else {
    delete env.RUN_STARTED_AT;
  }

  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseOutputs(result.stdout);
}

function parseOutputs(stdout) {
  const outputNames = new Set(AUTO_MERGE_OUTPUT_NAMES);
  const outputs = {};

  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const name = line.slice(0, separator);
    if (outputNames.has(name)) {
      outputs[name] = line.slice(separator + 1);
    }
  }

  assert.deepEqual(Object.keys(outputs).sort(), AUTO_MERGE_OUTPUT_NAMES.toSorted());
  return outputs;
}
