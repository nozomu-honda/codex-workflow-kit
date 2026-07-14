import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const WORKFLOW_FILE = new URL('../../.github/workflows/audit-repository-protection.yml', import.meta.url);
const PINNED_EXTERNAL_ACTIONS = new Set([
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

test('repository protection audit workflow is workflow_dispatch only', async () => {
  const { workflow } = await readWorkflow();

  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.schedule, undefined);
});

test('repository protection audit workflow is read-only and has no secrets', async () => {
  const { source, workflow } = await readWorkflow();

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(source.includes('secrets:'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(source.includes('contents: write'), false);
  assert.equal(source.includes('pull-requests: write'), false);
  assert.equal(source.includes('issues: write'), false);

  for (const job of Object.values(workflow.jobs)) {
    assert.deepEqual(job.permissions, { contents: 'read' });
  }
});

test('repository protection audit workflow uses pinned external actions and runs the read-only CLI', async () => {
  const { workflow } = await readWorkflow();
  const job = workflow.jobs['audit-repository-protection'];
  const usesValues = collectUses(workflow);
  const runCommands = job.steps.map((step) => step.run).filter(Boolean);

  for (const uses of usesValues) {
    assert.equal(PINNED_EXTERNAL_ACTIONS.has(uses), true, `${uses} must be reviewed and pinned`);
    assert.match(uses, /@[a-f0-9]{40}$/i);
  }

  assert.equal(job['timeout-minutes'], 10);
  assert.equal(runCommands[0], 'npm ci');
  assert.match(runCommands[1], /node scripts\/audit-repository-protection\.mjs/);
  assert.match(runCommands[1], /--repository/);
  assert.match(runCommands[1], /--policy/);
  assert.match(runCommands[1], /inputs\['policy-file'\]/);
  assert.match(runCommands[1], /--json/);
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
