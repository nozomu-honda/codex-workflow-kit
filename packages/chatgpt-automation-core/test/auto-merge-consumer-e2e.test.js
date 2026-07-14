import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { AUTO_MERGE_OUTPUT_NAMES, createAutoMergePlan } from '../src/auto-merge/index.js';

const PINNED_SHA = '0123456789abcdef0123456789abcdef01234567';
const TEMPLATE_REF = 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA';
const TEMPLATE = new URL('../../../templates/workflows/reviewed-pr-auto-merge-events.yml', import.meta.url);
const REUSABLE_WORKFLOW = new URL('../../../.github/workflows/auto-merge-plan.yml', import.meta.url);
const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';

test('consumerは固定SHAでauto-merge reusable workflowを呼び出せる', async () => {
  await withAutoMergeConsumer(async (dir) => {
    const caller = YAML.parse(await readFile(join(dir, '.github/workflows/reviewed-pr-auto-merge-events.yml'), 'utf8'));
    const reusable = YAML.parse(await readFile(REUSABLE_WORKFLOW, 'utf8'));
    const job = caller.jobs['auto-merge-plan'];

    assert.equal(job.uses, `nozomu-honda/codex-workflow-kit/.github/workflows/auto-merge-plan.yml@${PINNED_SHA}`);
    assert.equal(job.with['kit-ref'], PINNED_SHA);
    assert.deepEqual(Object.keys(reusable.on.workflow_call.outputs).sort(), AUTO_MERGE_OUTPUT_NAMES.toSorted());
  });
});

test('consumer固有configでdry-run auto-merge planを再現できる', () => {
  const plan = createAutoMergePlan(consumerInput({
    config: consumerConfig({
      autoMerge: {
        mode: 'enable-auto-merge',
        requiredWorkflows: ['CI']
      }
    })
  }));

  assert.equal(plan.outputs.eligible, 'true');
  assert.equal(plan.outputs.should_enable_auto_merge, 'true');
  assert.equal(plan.outputs.should_merge, 'false');
  assert.equal(plan.outputs.dedupe_key, `owner/repo#42:${HEAD_SHA}:enable-auto-merge:v1`);
});

test('fork相当payload、unknown actor、dangerous changeはconsumer E2Eでもfail closedになる', () => {
  const fork = createAutoMergePlan(consumerInput({
    normalizedEvent: normalizedEvent({ head_repository: 'fork/repo', is_same_repository: 'false', is_fork: 'true' }),
    pullRequest: pullRequest({ headRepository: 'fork/repo', fork: true })
  }));
  const actor = createAutoMergePlan(consumerInput({
    normalizedEvent: normalizedEvent({
      actor: 'unknown-user',
      event_action: 'submitted',
      event_name: 'pull_request_review',
      workflow_conclusion: '',
      workflow_name: ''
    }),
    config: consumerConfig({
      autoMerge: {
        mode: 'enable-auto-merge'
      }
    })
  }));
  const workflowChange = createAutoMergePlan(consumerInput({
    changedFiles: [{ filename: '.github/workflows/ci.yml', additions: 1, deletions: 0, patch: '+ok' }]
  }));

  assert.equal(fork.outputs.eligible, 'false');
  assert.match(fork.outputs.skip_reason, /not_same_repository|fork_not_allowed/);
  assert.equal(actor.outputs.eligible, 'false');
  assert.match(actor.outputs.skip_reason, /actor_not_trusted/);
  assert.equal(workflowChange.outputs.eligible, 'false');
  assert.match(workflowChange.outputs.skip_reason, /workflow_change_requires_manual_merge/);
});

test('dry-runでwrite処理を発生させずoutputsを取得できる', async () => {
  await withAutoMergeConsumer(async (dir) => {
    const source = await readFile(join(dir, '.github/workflows/reviewed-pr-auto-merge-events.yml'), 'utf8');
    const workflow = YAML.parse(source);
    const plan = createAutoMergePlan(consumerInput());

    assert.equal(source.includes('pull_request_target'), false);
    assert.equal(source.includes('secrets:'), false);
    assert.equal(source.includes('contents: write'), false);
    assert.equal(workflow.jobs['auto-merge-plan'].with['dry-run'], true);
    assert.equal(plan.outputs.dry_run, 'true');
    assert.deepEqual(Object.keys(plan.outputs).sort(), AUTO_MERGE_OUTPUT_NAMES.toSorted());
  });
});

async function withAutoMergeConsumer(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'auto-merge-consumer-e2e-'));
  try {
    const source = await readFile(TEMPLATE, 'utf8');
    await writeRepoFile(
      dir,
      '.github/workflows/reviewed-pr-auto-merge-events.yml',
      source.replaceAll(TEMPLATE_REF, PINNED_SHA)
    );
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeRepoFile(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function consumerInput(overrides = {}) {
  return {
    normalizedEvent: normalizedEvent(),
    config: consumerConfig(),
    pullRequest: pullRequest(),
    changedFiles: [{ filename: 'docs/auto-merge.md', additions: 1, deletions: 0, patch: '+ok' }],
    comparison: { behind_by: 0, status: 'ahead' },
    issueComments: [chatGptMarker('approved')],
    reviewThreads: [],
    reviews: [approvalReview()],
    workflowRuns: [workflowRun()],
    checkRuns: [],
    commitStatuses: [],
    repositorySettings: { allow_squash_merge: true, allow_auto_merge: true },
    ...overrides
  };
}

function consumerConfig(overrides = {}) {
  return {
    version: 1,
    baseBranch: 'master',
    ciWorkflowName: 'CI',
    dryRunDefault: true,
    features: { autoMerge: true },
    labels: {
      needsChatGptReview: 'needs-chatgpt-review',
      reviewedByChatGpt: 'reviewed-by-chatgpt',
      needsCodexFix: 'needs-codex-fix',
      codexFixInProgress: 'codex-fix-in-progress',
      autoMergeAfterCi: 'auto-merge-after-ci',
      doNotMerge: 'do-not-merge',
      doNotAutoReviewRequest: 'do-not-auto-review-request',
      doNotAutoCodexFix: 'do-not-auto-codex-fix',
      doNotAutoCodexMainFollowup: 'do-not-auto-codex-main-followup',
      codexMainFollowupInProgress: 'codex-main-followup-in-progress',
      doNotAutoApproveActions: 'do-not-auto-approve-actions'
    },
    review: {
      decisionMode: 'marker-only',
      markers: {
        approved: '<!-- chatgpt-review: approved -->',
        changesRequested: '<!-- chatgpt-review: changes_requested -->',
        reviewRequest: '<!-- chatgpt-review-request -->',
        ignoreInFencedCodeBlocks: true,
        excludeReviewRequestComments: true
      },
      decisions: {
        stopOnLatestChangesRequested: true
      }
    },
    autoMerge: {
      enabled: true,
      dryRun: true,
      mode: 'plan-only',
      mergeMethod: 'squash',
      allowedBaseBranches: ['master'],
      requireSameRepository: true,
      allowFork: false,
      requiredApprovals: 1,
      allowBotApproval: false,
      trustedReviewers: ['owner'],
      requiredWorkflows: ['CI'],
      requireResolvedThreads: true,
      allowDraft: false,
      sensitivePathPatterns: ['.github/**', 'package.json', 'package-lock.json'],
      manualMergePathPatterns: ['.github/**', 'package.json', 'package-lock.json'],
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      requireChatGPTReview: true,
      requireHumanReview: false,
      requireCurrentReview: true,
      duplicatePolicy: 'dedupe-key',
      cooldownSeconds: 0,
      deleteBranchAfterMerge: false,
      useMergeQueue: false,
      ...overrides.autoMerge
    }
  };
}

function normalizedEvent(overrides = {}) {
  return {
    event_name: 'workflow_run',
    event_action: 'completed',
    repository: 'owner/repo',
    repository_owner: 'owner',
    default_branch: 'master',
    actor: 'owner',
    pull_request_number: '42',
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
    head_repository: 'owner/repo',
    is_same_repository: 'true',
    is_fork: 'false',
    workflow_name: 'CI',
    workflow_conclusion: 'success',
    eligible: 'true',
    ineligible_reason: '',
    ...overrides
  };
}

function pullRequest(overrides = {}) {
  const headRepository = overrides.headRepository ?? 'owner/repo';
  const labels = overrides.labels ?? ['auto-merge-after-ci', 'reviewed-by-chatgpt'];

  return {
    number: 42,
    state: 'open',
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    user: { login: 'owner' },
    labels: labels.map((name) => ({ name })),
    head: {
      ref: 'feature/example',
      sha: HEAD_SHA,
      repo: {
        full_name: headRepository,
        fork: overrides.fork ?? false
      }
    },
    base: {
      ref: 'master',
      sha: BASE_SHA,
      repo: {
        full_name: 'owner/repo'
      }
    }
  };
}

function approvalReview() {
  return {
    body: 'Approved',
    commit_id: HEAD_SHA,
    state: 'APPROVED',
    submitted_at: '2026-01-01T01:00:00.000Z',
    user: { login: 'reviewer' }
  };
}

function chatGptMarker(status) {
  return {
    body: `<!-- chatgpt-review: ${status} -->`,
    created_at: '2026-01-01T02:00:00.000Z',
    headSha: HEAD_SHA,
    user: { login: 'chatgpt-reviewer' }
  };
}

function workflowRun() {
  return {
    conclusion: 'success',
    head_sha: HEAD_SHA,
    id: 1,
    name: 'CI',
    status: 'completed',
    updated_at: '2026-01-01T00:10:00.000Z'
  };
}
