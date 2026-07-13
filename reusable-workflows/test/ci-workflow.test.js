import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { validateAutomationConfig } from '../../packages/chatgpt-automation-core/src/config/index.js';

const CI_WORKFLOW_FILE = new URL('../../.github/workflows/ci.yml', import.meta.url);
const SMOKE_FIXTURE_FILE = new URL('../fixtures/valid-chatgpt-automation.yml', import.meta.url);
const PINNED_EXTERNAL_ACTIONS = new Set([
  'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
]);
const EXPECTED_OUTPUTS = {
  SMOKE_OK: '${{ needs.validate-config-smoke.outputs.ok }}',
  SMOKE_ERROR_COUNT: '${{ needs.validate-config-smoke.outputs.error-count }}',
  SMOKE_WARNING_COUNT: '${{ needs.validate-config-smoke.outputs.warning-count }}',
  SMOKE_CAPABILITIES_JSON: '${{ needs.validate-config-smoke.outputs.capabilities-json }}',
  SMOKE_DRY_RUN: '${{ needs.validate-config-smoke.outputs.dry-run }}'
};

async function readCiWorkflow() {
  const source = await readFile(CI_WORKFLOW_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

test('CI workflowはpull_request、master push、workflow_dispatchだけで起動する', async () => {
  const { workflow } = await readCiWorkflow();

  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['master']);
  assert.equal(workflow.on.pull_request, null);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(workflow.on.workflow_run, undefined);
});

test('CI workflowはcontents readだけを使いwrite権限やsecretを持たない', async () => {
  const { source, workflow } = await readCiWorkflow();

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assertNoForbiddenKeys(workflow);
  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(source.includes('secrets:'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(source.includes('contents: write'), false);
  assert.equal(source.includes('pull-requests: write'), false);
  assert.equal(source.includes('issues: write'), false);
  assert.equal(source.includes('actions: write'), false);

  for (const job of Object.values(workflow.jobs)) {
    assert.deepEqual(job.permissions, { contents: 'read' });
  }
});

test('CI workflowは重複実行抑制とjob timeoutを持つ', async () => {
  const { workflow } = await readCiWorkflow();

  assert.deepEqual(workflow.concurrency, {
    group: 'ci-${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': true
  });
  assert.equal(workflow.jobs.node20['timeout-minutes'], 15);
  assert.equal(workflow.jobs.node24['timeout-minutes'], 10);
  assert.equal(workflow.jobs['validate-config-smoke-assertions']['timeout-minutes'], 5);
});

test('CI workflowの外部Action参照は40桁commit SHAだけを使う', async () => {
  const { workflow } = await readCiWorkflow();
  const usesValues = collectUses(workflow);

  assert.equal(usesValues.includes('actions/checkout@v4'), false);
  assert.equal(usesValues.includes('actions/setup-node@v4'), false);

  for (const uses of usesValues) {
    if (uses.startsWith('./')) {
      assert.equal(uses, './.github/workflows/validate-config.yml');
      continue;
    }

    assert.equal(PINNED_EXTERNAL_ACTIONS.has(uses), true, `${uses} must be reviewed and pinned`);
    assert.match(uses, /@[a-f0-9]{40}$/i);
  }
});

test('CI workflowはNode 20 full validationとNode 24 Action検証を分離する', async () => {
  const { workflow } = await readCiWorkflow();
  const node20Runs = workflow.jobs.node20.steps.map((step) => step.run).filter(Boolean);
  const node24Runs = workflow.jobs.node24.steps.map((step) => step.run).filter(Boolean);

  assert.equal(workflow.jobs.node20.steps[1].with['node-version'], '20.19.0');
  assert.equal(workflow.jobs.node24.steps[1].with['node-version'], 24);
  assert.deepEqual(node20Runs, ['npm ci', 'npm run ci']);
  assert.deepEqual(node24Runs, ['npm ci', 'npm run test:action', 'npm run check:action-dist']);
});

test('CI workflowはreusable workflow smokeとoutputs assertionを持つ', async () => {
  const { workflow } = await readCiWorkflow();
  const smoke = workflow.jobs['validate-config-smoke'];
  const assertions = workflow.jobs['validate-config-smoke-assertions'];

  assert.equal(smoke.uses, './.github/workflows/validate-config.yml');
  assert.deepEqual(smoke.with, {
    'config-file': 'reusable-workflows/fixtures/valid-chatgpt-automation.yml',
    'dry-run': true
  });
  assert.deepEqual(assertions.needs, ['validate-config-smoke']);
  assert.deepEqual(assertions.steps[0].env, EXPECTED_OUTPUTS);
  assert.match(assertions.steps[0].run, /SMOKE_OK/);
  assert.match(assertions.steps[0].run, /actionsApproval: false/);
});

test('CI workflow smoke専用fixtureはvalidで全capability disabledになる', async () => {
  const source = await readFile(SMOKE_FIXTURE_FILE, 'utf8');
  const result = validateAutomationConfig(source);

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.capabilities, {
    autoRequest: false,
    routeReview: false,
    autoMerge: false,
    mainFollowup: false,
    actionsApproval: false
  });
  assert.equal(result.config.dryRunDefault, true);
});

function collectUses(value, results = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectUses(entry, results);
    }
    return results;
  }

  if (value === null || typeof value !== 'object') {
    return results;
  }

  if (typeof value.uses === 'string') {
    results.push(value.uses);
  }

  for (const entry of Object.values(value)) {
    collectUses(entry, results);
  }

  return results;
}

function assertNoForbiddenKeys(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoForbiddenKeys(entry);
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    assert.notEqual(key, 'pull_request_target');
    assert.notEqual(key, 'secrets');
    assert.notEqual(entry, 'inherit');
    if (key === 'permissions' && typeof entry === 'object' && entry !== null) {
      for (const permission of Object.values(entry)) {
        assert.notEqual(permission, 'write');
      }
    }
    assertNoForbiddenKeys(entry);
  }
}
