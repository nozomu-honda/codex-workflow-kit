import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const WORKFLOW_PATH = '.github/workflows/validate-config.yml';
const OLD_WORKFLOW_PATH = 'reusable-workflows/validate-config.yml';
const WORKFLOW_FILE = new URL(`../../${WORKFLOW_PATH}`, import.meta.url);
const OLD_WORKFLOW_FILE = new URL(`../../${OLD_WORKFLOW_PATH}`, import.meta.url);
const REUSABLE_WORKFLOWS_README = new URL('../README.md', import.meta.url);
const ACTION_METADATA_FILE = new URL('../../actions/validate-config/action.yml', import.meta.url);
const EXPECTED_OUTPUTS = ['ok', 'error-count', 'warning-count', 'capabilities-json', 'dry-run'];

async function readWorkflow() {
  const source = await readFile(WORKFLOW_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

async function readActionMetadata() {
  return YAML.parse(await readFile(ACTION_METADATA_FILE, 'utf8'));
}

test('workflow実体はGitHub Actionsが認識する場所にあり旧pathは存在しない', async () => {
  await assert.doesNotReject(access(WORKFLOW_FILE));
  await assert.rejects(access(OLD_WORKFLOW_FILE));
});

test('workflow YAMLがparse可能でworkflow_callだけを入口にする', async () => {
  const { workflow } = await readWorkflow();

  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.equal(workflow.on.workflow_call, workflow['on'].workflow_call);
});

test('workflow_call inputsが要件どおり', async () => {
  const { workflow } = await readWorkflow();
  const inputs = workflow.on.workflow_call.inputs;

  assert.deepEqual(Object.keys(inputs).sort(), ['config-file', 'dry-run']);
  assert.deepEqual(inputs['config-file'], {
    description: '検証するChatGPT automation設定ファイルのパス。',
    type: 'string',
    required: false,
    default: '.github/chatgpt-automation.yml'
  });
  assert.deepEqual(inputs['dry-run'], {
    description: 'dry-run指定。設定検証だけを行い、write処理は実行しません。',
    type: 'boolean',
    required: false,
    default: true
  });
  assert.equal(workflow.on.workflow_call.secrets, undefined);
});

test('permissionsはcontents readだけでwrite権限を持たない', async () => {
  const { workflow } = await readWorkflow();
  const job = workflow.jobs['validate-config'];

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(job.permissions, { contents: 'read' });
  assertNoWritePermission(workflow.permissions);
  assertNoWritePermission(job.permissions);
});

test('workflow outputsとAction outputsが一致する', async () => {
  const { workflow } = await readWorkflow();
  const action = await readActionMetadata();
  const workflowOutputs = workflow.on.workflow_call.outputs;
  const jobOutputs = workflow.jobs['validate-config'].outputs;

  assert.deepEqual(Object.keys(workflowOutputs).sort(), EXPECTED_OUTPUTS.toSorted());
  assert.deepEqual(Object.keys(jobOutputs).sort(), EXPECTED_OUTPUTS.toSorted());
  assert.deepEqual(Object.keys(action.outputs).sort(), EXPECTED_OUTPUTS.toSorted());

  for (const name of EXPECTED_OUTPUTS) {
    assert.equal(workflowOutputs[name].value, `\${{ jobs.validate-config.outputs.${name} }}`);
    assert.equal(jobOutputs[name], `\${{ steps.validate-config.outputs.${name} }}`);
  }
});

test('checkoutとvalidate-config Action以外の外部処理を持たない', async () => {
  const { workflow } = await readWorkflow();
  const steps = workflow.jobs['validate-config'].steps;

  assert.equal(steps.length, 2);
  assert.equal(steps[0].uses, 'actions/checkout@v4');
  assert.equal(steps[0].run, undefined);
  assert.equal(steps[1].id, 'validate-config');
  assert.equal(steps[1].uses, 'nozomu-honda/codex-workflow-kit/actions/validate-config@master');
  assert.equal(steps[1].uses.startsWith('./'), false);
  assert.deepEqual(steps[1].with, {
    'config-file': '${{ inputs.config-file }}',
    'dry-run': '${{ inputs.dry-run }}'
  });
  assert.equal(steps[1].run, undefined);
});

test('外部呼び出し例のpathと実体ファイルpathが一致する', async () => {
  const readme = await readFile(REUSABLE_WORKFLOWS_README, 'utf8');

  assert.match(readme, new RegExp(`uses: nozomu-honda/codex-workflow-kit/${escapeRegExp(WORKFLOW_PATH)}@<tag-or-commit-sha>`));
  assert.equal(readme.includes(`uses: nozomu-honda/codex-workflow-kit/${OLD_WORKFLOW_PATH}`), false);
});

test('禁止設定を含まない', async () => {
  const { source, workflow } = await readWorkflow();

  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(source.includes('contents: write'), false);
  assert.equal(source.includes('pull-requests: write'), false);
  assert.equal(source.includes('issues: write'), false);
  assert.equal(source.includes('actions: write'), false);
  assert.equal(source.includes('checks: write'), false);
  assert.equal(source.includes('statuses: write'), false);
  assert.equal(source.includes('id-token: write'), false);
  assertNoForbiddenKeys(workflow);
});

function assertNoWritePermission(permissions) {
  for (const value of Object.values(permissions ?? {})) {
    assert.notEqual(value, 'write');
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
