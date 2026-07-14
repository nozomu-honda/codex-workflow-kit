import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { createReviewRoutingPlan, REVIEW_ROUTING_OUTPUT_NAMES } from '../src/review-routing/index.js';

const PINNED_SHA = '0123456789abcdef0123456789abcdef01234567';
const TEMPLATE_REF = 'REPLACE_WITH_40_CHAR_COMMIT_SHA';
const TEMPLATE = new URL('../../../templates/workflows/chatgpt-review-routing-events.yml', import.meta.url);
const REUSABLE_WORKFLOW = new URL('../../../.github/workflows/review-routing.yml', import.meta.url);
const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';

test('consumerは固定SHAでreview-routing reusable workflowを呼び出せる', async () => {
  await withReviewRoutingConsumer(async (dir) => {
    const caller = YAML.parse(await readFile(join(dir, '.github/workflows/chatgpt-review-routing-events.yml'), 'utf8'));
    const reusable = YAML.parse(await readFile(REUSABLE_WORKFLOW, 'utf8'));
    const job = caller.jobs['review-routing'];

    assert.equal(job.uses, `nozomu-honda/codex-workflow-kit/.github/workflows/review-routing.yml@${PINNED_SHA}`);
    assert.equal(job.with['kit-ref'], PINNED_SHA);
    assert.deepEqual(Object.keys(reusable.on.workflow_call.outputs).sort(), REVIEW_ROUTING_OUTPUT_NAMES.toSorted());
  });
});

test('consumer固有command / workflow設定でrouting planを再現できる', () => {
  const plan = createReviewRoutingPlan(consumerInput({
    normalizedEvent: normalizedEvent(),
    config: consumerConfig({
      reviewRouting: {
        commands: ['/review-now'],
        requiredWorkflows: ['CI']
      }
    })
  }));

  assert.equal(plan.outputs.should_route, 'true');
  assert.equal(plan.outputs.trigger_type, 'ci-success');
  assert.equal(plan.outputs.dedupe_key, `owner/repo#42:${HEAD_SHA}:ci-success:v1`);
});

test('fork相当payloadとunknown actorはconsumer E2Eでもfail closedになる', () => {
  const fork = createReviewRoutingPlan(consumerInput({
    normalizedEvent: normalizedEvent({ head_repository: 'fork/repo', is_same_repository: 'false', is_fork: 'true' }),
    pullRequest: pullRequest({ headRepository: 'fork/repo', fork: true })
  }));
  const actor = createReviewRoutingPlan(consumerInput({
    normalizedEvent: normalizedEvent({ actor: 'unknown-user' })
  }));

  assert.equal(fork.outputs.should_route, 'false');
  assert.match(fork.outputs.skip_reason, /not_same_repository|fork_not_allowed/);
  assert.equal(actor.outputs.should_route, 'false');
  assert.match(actor.outputs.skip_reason, /actor_not_trusted/);
});

test('dry-runでwrite処理を発生させずoutputsを取得できる', async () => {
  await withReviewRoutingConsumer(async (dir) => {
    const source = await readFile(join(dir, '.github/workflows/chatgpt-review-routing-events.yml'), 'utf8');
    const workflow = YAML.parse(source);
    const plan = createReviewRoutingPlan(consumerInput());

    assert.equal(source.includes('pull_request_target'), false);
    assert.equal(source.includes('secrets:'), false);
    assert.equal(source.includes('contents: write'), false);
    assert.equal(workflow.jobs['review-routing'].with['dry-run'], true);
    assert.equal(plan.outputs.dry_run, 'true');
    assert.deepEqual(Object.keys(plan.outputs).sort(), REVIEW_ROUTING_OUTPUT_NAMES.toSorted());
  });
});

async function withReviewRoutingConsumer(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'review-routing-consumer-e2e-'));
  try {
    const source = await readFile(TEMPLATE, 'utf8');
    await writeRepoFile(
      dir,
      '.github/workflows/chatgpt-review-routing-events.yml',
      source.replaceAll(TEMPLATE_REF, PINNED_SHA).replaceAll('REPLACE_WITH_DEFAULT_BRANCH', 'master')
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
    changedFiles: [{ filename: 'docs/review.md', additions: 1, deletions: 0, patch: '+ok' }],
    ...overrides
  };
}

function consumerConfig(overrides = {}) {
  return {
    version: 1,
    baseBranch: 'master',
    ciWorkflowName: 'CI',
    dryRunDefault: true,
    features: { routeReview: true },
    reviewRouting: {
      enabled: true,
      dryRun: true,
      allowedBaseBranches: ['master'],
      acceptedTriggerTypes: ['ci-success', 'trusted-review-command'],
      commands: ['/chatgpt-review'],
      requestLabels: ['needs-chatgpt-review'],
      trustedHumanActors: [],
      trustedBotActors: [],
      allowDraft: false,
      allowFork: false,
      requireSameRepository: true,
      requiredWorkflows: ['CI'],
      sensitivePathPatterns: ['.github/**', 'scripts/**'],
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      cooldownSeconds: 0,
      duplicatePolicy: 'dedupe-key',
      ...overrides.reviewRouting
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
    dry_run: 'true',
    eligible: 'true',
    ineligible_reason: '',
    ...overrides
  };
}

function pullRequest(overrides = {}) {
  const headRepository = overrides.headRepository ?? 'owner/repo';

  return {
    number: 42,
    state: 'open',
    draft: false,
    user: { login: 'owner' },
    head: {
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
