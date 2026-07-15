import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('workflowはvalidなblock decisionでもsanitized outputsを公開する', async () => {
  const { workflow } = await readWorkflow();
  const publishScript = getPublishScript(workflow);
  const result = runPublishScript(publishScript, JSON.stringify({
    adapterAccepted: false,
    commandCreated: false,
    dryRun: true,
    eligible: false,
    executed: false,
    reasonCodes: ['report_from_future'],
    reportVersion: 'auto-merge-dry-run-executor.v1'
  }));

  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    const outputs = readFileSync(result.outputFile, 'utf8');
    assert.match(outputs, /^eligible=false$/m);
    assert.match(outputs, /^command_created=false$/m);
    assert.match(outputs, /^adapter_accepted=false$/m);
    assert.match(outputs, /^executed=false$/m);
    assert.match(outputs, /^reason_codes_json=\["report_from_future"\]$/m);
    assert.match(outputs, /^result_json<<JSON$/m);
    assert.match(outputs, /"eligible":false/);
  } finally {
    result.cleanup();
  }
});

test('workflowはresult file欠落・不正JSONをsystem errorとしてfail closedにする', async () => {
  const { workflow } = await readWorkflow();
  const publishScript = getPublishScript(workflow);

  for (const resultJson of [undefined, '{invalid-json']) {
    const result = runPublishScript(publishScript, resultJson);
    try {
      assert.notEqual(result.run.status, 0);
      assert.equal(readFileSync(result.outputFile, 'utf8'), '');
    } finally {
      result.cleanup();
    }
  }
});

test('workflowはblockなのにcommand-created=trueの不整合resultを拒否する', async () => {
  const { workflow } = await readWorkflow();
  const result = runPublishScript(getPublishScript(workflow), JSON.stringify({
    adapterAccepted: false,
    commandCreated: true,
    dryRun: true,
    eligible: false,
    executed: false,
    reasonCodes: ['write_command_invalid'],
    reportVersion: 'auto-merge-dry-run-executor.v1'
  }));

  try {
    assert.notEqual(result.run.status, 0);
    assert.equal(readFileSync(result.outputFile, 'utf8'), '');
  } finally {
    result.cleanup();
  }
});

function getPublishScript(workflow) {
  const publish = workflow.jobs['auto-merge-dry-run-executor'].steps.find(
    (step) => step.name === 'Publish sanitized outputs'
  );
  const match = publish.run.match(/^node <<'NODE'\n([\s\S]+)\nNODE\n?$/);
  assert.ok(match, 'Publish step must contain one Node heredoc.');
  return match[1];
}

function runPublishScript(script, resultJson) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-merge-dry-run-workflow-'));
  const resultFile = join(dir, 'auto-merge-dry-run-result.json');
  const outputFile = join(dir, 'github-output.txt');
  writeFileSync(outputFile, '');
  if (resultJson !== undefined) {
    writeFileSync(resultFile, resultJson);
  }
  const run = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: dir
    }
  });
  return {
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    outputFile,
    run
  };
}

function readPermissions() {
  return {
    contents: 'read',
    'pull-requests': 'read',
    actions: 'read',
    checks: 'read',
    statuses: 'read'
  };
}
