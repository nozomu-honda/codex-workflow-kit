import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { NORMALIZED_EVENT_OUTPUT_NAMES } from '../../packages/chatgpt-automation-core/src/events/index.js';

const WORKFLOW_FILE = new URL('../../.github/workflows/normalize-event.yml', import.meta.url);
const EXPECTED_CHECKOUT_USES = 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5';
const REQUIRED_INPUTS = [
  'actor',
  'default-branch',
  'dry-run',
  'event-action',
  'event-name',
  'event-payload-json',
  'kit-ref',
  'permission-mode',
  'ref-name',
  'repository',
  'repository-config-json',
  'repository-owner',
  'requested-capability',
  'sha'
];

async function readWorkflow() {
  const source = await readFile(WORKFLOW_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

test('normalize-event reusable workflowはworkflow_callのみを入口にする', async () => {
  const { workflow } = await readWorkflow();

  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
});

test('workflow_call inputs / outputsが契約どおり', async () => {
  const { workflow } = await readWorkflow();
  const call = workflow.on.workflow_call;

  assert.deepEqual(Object.keys(call.inputs).sort(), REQUIRED_INPUTS.toSorted());
  assert.equal(call.inputs['event-name'].required, true);
  assert.equal(call.inputs['event-payload-json'].required, true);
  assert.equal(call.inputs.repository.required, true);
  assert.equal(call.inputs['repository-owner'].required, true);
  assert.equal(call.inputs['default-branch'].required, true);
  assert.equal(call.inputs.actor.required, true);
  assert.equal(call.inputs['kit-ref'].required, true);
  assert.deepEqual(call.inputs['dry-run'], {
    description: 'Dry-run flag. Defaults to true and does not enable write processing.',
    type: 'boolean',
    required: false,
    default: true
  });
  assert.equal(call.inputs['permission-mode'].default, 'read-only');
  assert.equal(call.inputs['requested-capability'].default, 'normalize-only');
  assert.equal(call.inputs['repository-config-json'].default, '{}');
  assert.equal(call.secrets, undefined);
  assert.deepEqual(Object.keys(call.outputs).sort(), NORMALIZED_EVENT_OUTPUT_NAMES.toSorted());
});

test('workflow / job permissionsはcontents readだけ', async () => {
  const { workflow } = await readWorkflow();
  const job = workflow.jobs['normalize-event'];

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(job.permissions, { contents: 'read' });
  assertNoWritePermission(workflow.permissions);
  assertNoWritePermission(job.permissions);
});

test('outputsはnormalize-event stepからのみ公開される', async () => {
  const { workflow } = await readWorkflow();
  const callOutputs = workflow.on.workflow_call.outputs;
  const jobOutputs = workflow.jobs['normalize-event'].outputs;

  assert.deepEqual(Object.keys(jobOutputs).sort(), NORMALIZED_EVENT_OUTPUT_NAMES.toSorted());

  for (const name of NORMALIZED_EVENT_OUTPUT_NAMES) {
    assert.equal(callOutputs[name].value, `\${{ jobs.normalize-event.outputs.${name} }}`);
    assert.equal(jobOutputs[name], `\${{ steps.normalize-event.outputs.${name} }}`);
  }
});

test('共有kitを固定refでcheckoutし、正規化scriptだけを実行する', async () => {
  const { workflow } = await readWorkflow();
  const steps = workflow.jobs['normalize-event'].steps;
  const checkout = steps.find((step) => step.name === 'Checkout shared kit');
  const normalize = steps.find((step) => step.id === 'normalize-event');

  assert.equal(checkout.uses, EXPECTED_CHECKOUT_USES);
  assert.deepEqual(checkout.with, {
    repository: 'nozomu-honda/codex-workflow-kit',
    ref: '${{ inputs.kit-ref }}',
    path: '.codex-workflow-kit',
    'persist-credentials': false
  });
  assert.equal(normalize.run, 'node .codex-workflow-kit/scripts/normalize-event.mjs');
  assert.equal(normalize.uses, undefined);
  assert.equal(normalize.env.EVENT_NAME, '${{ inputs.event-name }}');
  assert.equal(normalize.env.EVENT_PAYLOAD_JSON, '${{ inputs.event-payload-json }}');
});

test('kit-ref検証は40桁SHAだけを許可する', async () => {
  const { source, workflow } = await readWorkflow();
  const validate = workflow.jobs['normalize-event'].steps.find((step) => step.name === 'Validate kit ref');

  assert.match(validate.run, /\^\[a-f0-9\]\{40\}\$/i);
  assert.equal(isAllowedKitRef('0123456789abcdef0123456789abcdef01234567'), true);
  assert.equal(isAllowedKitRef('v1.2.3'), false);
  assert.equal(isAllowedKitRef('master'), false);
  assert.equal(isAllowedKitRef('main'), false);
  assert.equal(isAllowedKitRef('0123456'), false);
  assert.equal(isAllowedKitRef('REPLACE_WITH_40_CHAR_COMMIT_SHA'), false);
  assert.equal(source.includes('REPLACE_WITH_40_CHAR_COMMIT_SHA'), false);
});

test('Secret、write permission、pull_request_target、外部write処理を含まない', async () => {
  const { source, workflow } = await readWorkflow();

  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(source.includes('secrets:'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(source.includes('contents: write'), false);
  assert.equal(source.includes('pull-requests: write'), false);
  assert.equal(source.includes('issues: write'), false);
  assert.equal(source.includes('actions: write'), false);
  assertNoForbiddenKeys(workflow);
});

function isAllowedKitRef(ref) {
  return /^[a-f0-9]{40}$/.test(ref);
}

function assertNoWritePermission(permissions) {
  for (const value of Object.values(permissions ?? {})) {
    assert.notEqual(value, 'write');
  }
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
    assertNoForbiddenKeys(entry);
  }
}
