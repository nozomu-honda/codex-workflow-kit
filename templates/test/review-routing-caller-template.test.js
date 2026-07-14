import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const TEMPLATE_FILE = new URL('../workflows/chatgpt-review-routing-events.yml', import.meta.url);
const REUSABLE_WORKFLOW_USES = 'nozomu-honda/codex-workflow-kit/.github/workflows/review-routing.yml@REPLACE_WITH_40_CHAR_COMMIT_SHA';
const EXPECTED_EVENTS = [
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
  'pull_request',
  'push',
  'workflow_dispatch'
];

async function readTemplate() {
  const source = await readFile(TEMPLATE_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

test('review routing caller templateは対象イベントと手動dispatchだけを受ける', async () => {
  const { workflow } = await readTemplate();

  assert.deepEqual(Object.keys(workflow.on).sort(), EXPECTED_EVENTS.toSorted());
  assert.deepEqual(workflow.on.issue_comment.types, ['created', 'edited']);
  assert.deepEqual(workflow.on.pull_request_review.types, ['submitted']);
  assert.deepEqual(workflow.on.pull_request_review_comment.types, ['created', 'edited']);
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.deepEqual(workflow.on.pull_request.types, ['closed']);
  assert.deepEqual(workflow.on.push.branches, ['REPLACE_WITH_DEFAULT_BRANCH']);
  assert.equal(workflow.on.workflow_dispatch.inputs.pull_request_number.type, 'string');
});

test('callerは薄いjob-level reusable workflow呼び出しだけを持つ', async () => {
  const { workflow } = await readTemplate();
  const jobs = workflow.jobs;
  const job = jobs['review-routing'];

  assert.deepEqual(Object.keys(jobs), ['review-routing']);
  assert.equal(job.uses, REUSABLE_WORKFLOW_USES);
  assert.equal(job['runs-on'], undefined);
  assert.equal(job.steps, undefined);
  assert.equal(job.run, undefined);
  assert.deepEqual(workflow.permissions, readOnlyPermissions());
  assert.deepEqual(job.permissions, readOnlyPermissions());
});

test('callerはpayload、導入先Variables、固定refだけを渡す', async () => {
  const { workflow } = await readTemplate();
  const withInputs = workflow.jobs['review-routing'].with;

  assert.deepEqual(withInputs, {
    'event-name': '${{ github.event_name }}',
    'event-action': "${{ github.event.action || '' }}",
    'event-payload-json': '${{ toJson(github.event) }}',
    repository: '${{ github.repository }}',
    'repository-owner': '${{ github.repository_owner }}',
    'default-branch': '${{ github.event.repository.default_branch }}',
    actor: '${{ github.actor }}',
    'ref-name': '${{ github.ref_name }}',
    sha: '${{ github.sha }}',
    'dry-run': true,
    'repository-config-json': "${{ vars.CHATGPT_AUTOMATION_REVIEW_ROUTING_CONFIG_JSON || '{}' }}",
    'existing-dedupe-keys': "${{ vars.CHATGPT_AUTOMATION_REVIEW_ROUTING_DEDUPE_KEYS || '' }}",
    'last-routed-at': "${{ vars.CHATGPT_AUTOMATION_REVIEW_ROUTING_LAST_ROUTED_AT || '' }}",
    'kit-ref': 'REPLACE_WITH_40_CHAR_COMMIT_SHA'
  });
});

test('Secretやwrite権限、pull_request_target、inline処理を含まない', async () => {
  const { source, workflow } = await readTemplate();

  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(hasYamlKey(source, 'secrets'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(source.includes('contents: write'), false);
  assert.equal(source.includes('pull-requests: write'), false);
  assert.equal(source.includes('issues: write'), false);
  assert.equal(hasYamlKey(source, 'runs-on'), false);
  assert.equal(hasYamlKey(source, 'steps'), false);
  assert.equal(hasYamlKey(source, 'run'), false);
  assertNoForbiddenKeys(workflow);
});

test('reusable workflow refとkit-refは同じ固定refへ置換する契約にする', async () => {
  const { workflow } = await readTemplate();
  const job = workflow.jobs['review-routing'];
  const ref = job.uses.split('@').at(-1);

  assert.equal(ref, 'REPLACE_WITH_40_CHAR_COMMIT_SHA');
  assert.equal(job.with['kit-ref'], ref);
  assert.equal(isAllowedTemplateRef(ref), true);
  assert.equal(isAllowedTemplateRef('v1.2.3'), false);
  assert.equal(isAllowedTemplateRef('0123456789abcdef0123456789abcdef01234567'), true);
  assert.equal(isAllowedTemplateRef('v1'), false);
  assert.equal(isAllowedTemplateRef('v1.2'), false);
  assert.equal(isAllowedTemplateRef('master'), false);
  assert.equal(isAllowedTemplateRef('main'), false);
  assert.equal(isAllowedTemplateRef('0123456'), false);
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

function isAllowedTemplateRef(ref) {
  return /^[a-f0-9]{40}$/i.test(ref)
    || ref === 'REPLACE_WITH_40_CHAR_COMMIT_SHA';
}

function hasYamlKey(source, key) {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, 'm').test(source);
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
    assert.notEqual(key, 'runs-on');
    assert.notEqual(key, 'steps');
    assert.notEqual(key, 'run');
    assertNoForbiddenKeys(entry);
  }
}
