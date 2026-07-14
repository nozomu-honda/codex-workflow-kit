import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { REVIEW_ROUTING_OUTPUT_NAMES } from '../../packages/chatgpt-automation-core/src/review-routing/index.js';

const WORKFLOW_FILE = new URL('../../.github/workflows/review-routing.yml', import.meta.url);
const EXPECTED_CHECKOUT_USES = 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5';
const REQUIRED_INPUTS = [
  'actor',
  'default-branch',
  'dry-run',
  'event-action',
  'event-name',
  'event-payload-json',
  'existing-dedupe-keys',
  'kit-ref',
  'last-routed-at',
  'ref-name',
  'repository',
  'repository-config-json',
  'repository-owner',
  'sha'
];

async function readWorkflow() {
  const source = await readFile(WORKFLOW_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

test('review-routing reusable workflowはworkflow_callのみを入口にする', async () => {
  const { workflow } = await readWorkflow();

  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
});

test('workflow_call inputs / outputsがrouting契約どおり', async () => {
  const { workflow } = await readWorkflow();
  const call = workflow.on.workflow_call;

  assert.deepEqual(Object.keys(call.inputs).sort(), REQUIRED_INPUTS.toSorted());
  assert.deepEqual(Object.keys(call.outputs).sort(), REVIEW_ROUTING_OUTPUT_NAMES.toSorted());
  assert.equal(call.inputs['event-name'].required, true);
  assert.equal(call.inputs['event-payload-json'].required, true);
  assert.equal(call.inputs.repository.required, true);
  assert.equal(call.inputs['kit-ref'].required, true);
  assert.deepEqual(call.inputs['dry-run'], {
    description: 'Dry-run flag. Defaults to true and does not enable write processing.',
    type: 'boolean',
    required: false,
    default: true
  });
  assert.equal(call.secrets, undefined);
});

test('workflow / job permissionsはread-onlyだけ', async () => {
  const { workflow } = await readWorkflow();
  const normalize = workflow.jobs['normalize-event'];
  const routing = workflow.jobs['review-routing'];

  assert.deepEqual(workflow.permissions, readOnlyPermissions());
  assert.deepEqual(normalize.permissions, { contents: 'read' });
  assert.deepEqual(routing.permissions, readOnlyPermissions());
  assertNoWritePermission(workflow.permissions);
  assertNoWritePermission(routing.permissions);
});

test('Issue #23 normalizerを呼び出し、そのoutputsからrouting planを作る', async () => {
  const { workflow } = await readWorkflow();
  const normalize = workflow.jobs['normalize-event'];
  const routing = workflow.jobs['review-routing'];
  const step = routing.steps.find((entry) => entry.id === 'review-routing');

  assert.equal(normalize.uses, './.github/workflows/normalize-event.yml');
  assert.equal(normalize.with['requested-capability'], 'normalize-only');
  assert.equal(normalize.with['permission-mode'], 'read-only');
  assert.equal(step.run, 'node .codex-workflow-kit/scripts/route-review.mjs');
  assert.match(step.env.NORMALIZED_EVENT_JSON, /needs\.normalize-event\.outputs\.event_name/);
  assert.equal(step.env.GITHUB_TOKEN, '${{ github.token }}');
});

test('共有kitを固定refでcheckoutし、kit-ref検証を持つ', async () => {
  const { workflow } = await readWorkflow();
  const steps = workflow.jobs['review-routing'].steps;
  const checkout = steps.find((step) => step.name === 'Checkout shared kit');
  const validate = steps.find((step) => step.name === 'Validate kit ref');

  assert.match(validate.run, /\^\[a-f0-9\]\{40\}\$/i);
  assert.equal(checkout.uses, EXPECTED_CHECKOUT_USES);
  assert.deepEqual(checkout.with, {
    repository: 'nozomu-honda/codex-workflow-kit',
    ref: '${{ inputs.kit-ref }}',
    path: '.codex-workflow-kit',
    'persist-credentials': false
  });
});

test('Secret、write permission、pull_request_target、write処理を含まない', async () => {
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

function readOnlyPermissions() {
  return {
    contents: 'read',
    'pull-requests': 'read',
    issues: 'read',
    actions: 'read',
    checks: 'read',
    statuses: 'read'
  };
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
