import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const WORKFLOW_FILE = new URL('../../.github/workflows/release-readiness.yml', import.meta.url);
const PINNED_ACTIONS = new Set([
  'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
]);

async function readWorkflow() {
  const source = await readFile(WORKFLOW_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

test('release-readiness workflowはworkflow_dispatchとrelease関連pull_requestだけで起動する', async () => {
  const { workflow } = await readWorkflow();

  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.ok(workflow.on.pull_request.paths.includes('release/**'));
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.schedule, undefined);
});

test('release-readiness workflowはcontents readだけでsecretやwrite permissionを持たない', async () => {
  const { source, workflow } = await readWorkflow();
  const job = workflow.jobs['release-readiness'];

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(source.includes('secrets:'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(source.includes('contents: write'), false);
  assert.equal(source.includes('pull-requests: write'), false);
  assert.equal(source.includes('issues: write'), false);
  assertNoForbiddenKeys(workflow);
});

test('release-readiness workflowの外部Actionは40桁SHA固定で、release readinessだけを実行する', async () => {
  const { workflow } = await readWorkflow();
  const steps = workflow.jobs['release-readiness'].steps;
  const usesValues = steps.map((step) => step.uses).filter(Boolean);
  const runs = steps.map((step) => step.run).filter(Boolean);

  assert.deepEqual(usesValues, [...PINNED_ACTIONS]);
  for (const uses of usesValues) {
    assert.match(uses, /@[a-f0-9]{40}$/);
  }
  assert.deepEqual(steps[0].with, { 'fetch-depth': 2 });
  assert.deepEqual(runs, ['npm ci', 'npm run release:readiness']);
});

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
    if (key === 'permissions') {
      for (const permission of Object.values(entry ?? {})) {
        assert.notEqual(permission, 'write');
      }
    }
    assertNoForbiddenKeys(entry);
  }
}
