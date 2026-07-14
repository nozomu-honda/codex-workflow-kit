import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  createMainFollowUpPlan,
  MAIN_FOLLOW_UP_OUTPUT_NAMES
} from '../src/main-follow-up/index.js';
import {
  behindPr,
  conflictPr,
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS,
  forkPr,
  pushDefaultBranch,
  secretLikeFile,
  upToDatePr
} from '../../../fixtures/github-events/index.js';

const PINNED_SHA = '0123456789abcdef0123456789abcdef01234567';
const TEMPLATE_REF = 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA';
const TEMPLATE = new URL('../../../templates/workflows/main-follow-up-events.yml', import.meta.url);
const REUSABLE_WORKFLOW = new URL('../../../.github/workflows/main-follow-up-plan.yml', import.meta.url);

test('consumerは固定SHAでmain-follow-up reusable workflowを呼び出せる', async () => {
  await withMainFollowUpConsumer(async (dir) => {
    const caller = YAML.parse(await readFile(join(dir, '.github/workflows/main-follow-up-events.yml'), 'utf8'));
    const reusable = YAML.parse(await readFile(REUSABLE_WORKFLOW, 'utf8'));
    const job = caller.jobs['main-follow-up-plan'];

    assert.equal(job.uses, `nozomu-honda/codex-workflow-kit/.github/workflows/main-follow-up-plan.yml@${PINNED_SHA}`);
    assert.equal(job.with['kit-ref'], PINNED_SHA);
    assert.deepEqual(Object.keys(reusable.on.workflow_call.outputs).sort(), MAIN_FOLLOW_UP_OUTPUT_NAMES.toSorted());
  });
});

test('consumer固有configでdry-run main follow-up planを再現できる', () => {
  const plan = createMainFollowUpPlan(consumerInput({
    openPullRequests: [
      upToDatePr({ pullRequestNumber: 41 }),
      behindPr({ pullRequestNumber: 42 }),
      conflictPr({ pullRequestNumber: 43 })
    ]
  }));
  const plans = JSON.parse(plan.outputs.plans_json);

  assert.equal(plan.outputs.eligible, 'true');
  assert.equal(plan.outputs.dry_run, 'true');
  assert.equal(plan.outputs.update_candidate_count, '1');
  assert.equal(plan.outputs.codex_follow_up_candidate_count, '1');
  assert.deepEqual(plans.map((entry) => entry.action), [
    'up-to-date',
    'behind-update-candidate',
    'conflict-follow-up-candidate'
  ]);
});

test('fork PRやsecret-like変更はconsumer E2Eでもfail closedになる', () => {
  const fork = createMainFollowUpPlan(consumerInput({
    openPullRequests: [forkPr()]
  }));
  const secretLike = createMainFollowUpPlan(consumerInput({
    openPullRequests: [behindPr({ changedFiles: [secretLikeFile()] })]
  }));

  assert.equal(JSON.parse(fork.outputs.plans_json)[0].action, 'ineligible');
  assert.match(JSON.parse(fork.outputs.plans_json)[0].skip_reason, /not_same_repository|fork_not_allowed/);
  assert.equal(JSON.parse(secretLike.outputs.plans_json)[0].action, 'manual-review-required');
  assert.equal(JSON.parse(secretLike.outputs.plans_json)[0].should_update_branch, false);
  assert.equal(JSON.parse(secretLike.outputs.plans_json)[0].should_request_codex_follow_up, false);
});

test('dry-runでwrite処理を発生させずoutputsを取得できる', async () => {
  await withMainFollowUpConsumer(async (dir) => {
    const source = await readFile(join(dir, '.github/workflows/main-follow-up-events.yml'), 'utf8');
    const workflow = YAML.parse(source);
    const plan = createMainFollowUpPlan(consumerInput());

    assert.equal(source.includes('pull_request_target'), false);
    assert.equal(source.includes('secrets:'), false);
    assert.equal(source.includes('contents: write'), false);
    assert.equal(workflow.jobs['main-follow-up-plan'].with['dry-run'], true);
    assert.equal(plan.outputs.dry_run, 'true');
    assert.deepEqual(Object.keys(plan.outputs).sort(), MAIN_FOLLOW_UP_OUTPUT_NAMES.toSorted());
  });
});

async function withMainFollowUpConsumer(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'main-follow-up-consumer-e2e-'));
  try {
    const source = await readFile(TEMPLATE, 'utf8');
    await writeRepoFile(
      dir,
      '.github/workflows/main-follow-up-events.yml',
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
    config: consumerConfig(),
    eventPayload: pushDefaultBranch(),
    existingDedupeKeys: [],
    normalizedEvent: normalizedEvent(),
    now: '2026-01-01T00:00:00.000Z',
    openPullRequests: [behindPr()],
    ...overrides
  };
}

function consumerConfig(overrides = {}) {
  const { mainFollowUp: mainFollowUpOverrides = {}, ...rootOverrides } = overrides;

  return {
    version: 1,
    baseBranch: 'main',
    ciWorkflowName: 'CI',
    dryRunDefault: true,
    features: { mainFollowup: true },
    mainFollowUp: {
      enabled: true,
      dryRun: true,
      allowedBaseBranches: ['main'],
      requiredLabels: ['auto-merge-after-ci'],
      blockedLabels: ['do-not-merge', 'needs-codex-fix', 'codex-fix-in-progress', 'do-not-auto-codex-main-followup', 'codex-main-followup-in-progress'],
      allowDraft: false,
      requireSameRepository: true,
      allowFork: false,
      maxAttempts: 2,
      cooldownSeconds: 0,
      maxOpenPullRequests: 100,
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      sensitivePathPatterns: ['.github/**', 'scripts/**', 'actions/**'],
      protectedPathPatterns: ['.github/**', 'scripts/**', 'actions/**'],
      workflowPathPatterns: ['.github/workflows/**', '.github/actions/**'],
      dependencyPathPatterns: ['package.json', 'package-lock.json'],
      generatedPathPatterns: ['actions/**/dist/**', '**/dist/**'],
      duplicatePolicy: 'dedupe-key',
      codexFollowUpEnabled: true,
      ...mainFollowUpOverrides
    },
    ...rootOverrides
  };
}

function normalizedEvent(overrides = {}) {
  return {
    default_branch: 'main',
    eligible: 'true',
    event_action: '',
    event_name: 'push',
    head_sha: FIXTURE_SHAS.after,
    repository: FIXTURE_REPOSITORY.fullName,
    ...overrides
  };
}
