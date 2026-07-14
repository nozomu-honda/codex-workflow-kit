import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const WORKFLOW_FILE = new URL('../../.github/workflows/auto-merge-dry-run-executor.yml', import.meta.url);
const EXPECTED_CHECKOUT_USES = 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5';
const EXPECTED_SETUP_NODE_USES = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const REQUIRED_CALL_INPUTS = [
  'auto-merge-plan-json',
  'changed-files-json',
  'checks-json',
  'consumer-audit-json',
  'execution-context-json',
  'kit-ref',
  'protection-audit-json',
  'pull-request-json',
  'review-evidence-json'
];

async function readWorkflow() {
  const source = await readFile(WORKFLOW_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

test('auto-merge dry-run executor workflowはworkflow_call / workflow_dispatchだけを入口にする', async () => {
  const { workflow } = await readWorkflow();

  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.schedule, undefined);
});

test('workflow_call inputs / outputsはdry-run decision契約どおり', async () => {
  const { workflow } = await readWorkflow();
  const call = workflow.on.workflow_call;

  assert.deepEqual(Object.keys(call.inputs).sort(), REQUIRED_CALL_INPUTS.toSorted());
  assert.deepEqual(Object.keys(call.outputs).sort(), [
    'adapter-accepted',
    'command-created',
    'eligible',
    'executed',
    'reason-codes-json',
    'result-json'
  ]);
  for (const input of REQUIRED_CALL_INPUTS) {
    assert.equal(call.inputs[input].required, true);
    assert.equal(call.inputs[input].type, 'string');
  }
  assert.equal(call.secrets, undefined);
});

test('workflow / job permissionsはread-onlyで、Secretやwrite permissionを持たない', async () => {
  const { source, workflow } = await readWorkflow();
  const job = workflow.jobs['auto-merge-dry-run-executor'];

  assert.deepEqual(workflow.permissions, readPermissions());
  assert.deepEqual(job.permissions, readPermissions());
  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(source.includes('secrets:'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(source.includes('contents: write'), false);
  assert.equal(source.includes('pull-requests: write'), false);
  assert.equal(source.includes('issues: write'), false);
  assert.equal(source.includes('actions: write'), false);
  assert.equal(source.includes('checks: write'), false);
  assert.equal(source.includes('statuses: write'), false);
});

test('workflowは固定ref検証、pinned action、dry-run executor CLIだけを実行する', async () => {
  const { workflow } = await readWorkflow();
  const job = workflow.jobs['auto-merge-dry-run-executor'];
  const checkout = job.steps.find((step) => step.name === 'Checkout shared kit');
  const setup = job.steps.find((step) => step.name === 'Setup Node.js');
  const execute = job.steps.find((step) => step.name === 'Execute auto-merge dry-run');

  assert.equal(job['timeout-minutes'], 10);
  assert.equal(checkout.uses, EXPECTED_CHECKOUT_USES);
  assert.deepEqual(checkout.with, {
    repository: 'nozomu-honda/codex-workflow-kit',
    ref: '${{ inputs.kit-ref || github.sha }}',
    path: '.codex-workflow-kit',
    'persist-credentials': false
  });
  assert.equal(setup.uses, EXPECTED_SETUP_NODE_USES);
  assert.match(job.steps[0].run, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(execute.run, /node scripts\/execute-auto-merge-dry-run\.mjs/);
  assert.match(execute.run, /--json/);
});

function readPermissions() {
  return {
    contents: 'read',
    'pull-requests': 'read',
    actions: 'read',
    checks: 'read',
    statuses: 'read'
  };
}
