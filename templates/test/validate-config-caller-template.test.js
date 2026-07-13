import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const TEMPLATE_PATH = 'templates/workflows/validate-config.yml';
const TEMPLATE_FILE = new URL('../workflows/validate-config.yml', import.meta.url);
const TEMPLATES_README = new URL('../README.md', import.meta.url);
const INSTALLATION_DOC = new URL('../../docs/github-automation/installation.md', import.meta.url);
const REUSABLE_WORKFLOW_PATH = '.github/workflows/validate-config.yml';
const EXPECTED_USES = `nozomu-honda/codex-workflow-kit/${REUSABLE_WORKFLOW_PATH}@REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA`;

async function readTemplate() {
  const source = await readFile(TEMPLATE_FILE, 'utf8');
  return {
    source,
    workflow: YAML.parse(source)
  };
}

test('caller workflow templateはtemplates配下に1つ存在する', async () => {
  await assert.doesNotReject(access(TEMPLATE_FILE));
});

test('triggerはworkflow_dispatchのみ', async () => {
  const { workflow } = await readTemplate();

  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_dispatch, null);
});

test('jobは1つだけでreusable workflowをjob-level usesで呼ぶ', async () => {
  const { workflow } = await readTemplate();
  const jobKeys = Object.keys(workflow.jobs);
  const job = workflow.jobs['validate-config'];

  assert.deepEqual(jobKeys, ['validate-config']);
  assert.equal(job.uses, EXPECTED_USES);
  assert.equal(job['runs-on'], undefined);
  assert.equal(job.steps, undefined);
  assert.equal(job.run, undefined);
});

test('permissionsはcontents readだけでwrite権限を持たない', async () => {
  const { workflow } = await readTemplate();
  const job = workflow.jobs['validate-config'];

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(job.permissions, { contents: 'read' });
  assertNoWritePermission(workflow.permissions);
  assertNoWritePermission(job.permissions);
});

test('withは固定config pathとdry-run trueだけを渡す', async () => {
  const { workflow } = await readTemplate();
  const job = workflow.jobs['validate-config'];

  assert.deepEqual(job.with, {
    'config-file': '.github/chatgpt-automation.yml',
    'dry-run': true
  });
});

test('Secretや禁止trigger、実行stepを含まない', async () => {
  const { source, workflow } = await readTemplate();

  assert.equal(source.includes('pull_request_target'), false);
  assert.equal(source.includes('issue_comment'), false);
  assert.equal(source.includes('pull_request_review'), false);
  assert.equal(source.includes('pull_request_review_comment'), false);
  assert.equal(source.includes('workflow_run'), false);
  assert.equal(hasYamlKey(source, 'push'), false);
  assert.equal(hasYamlKey(source, 'schedule'), false);
  assert.equal(hasYamlKey(source, 'secrets'), false);
  assert.equal(source.includes('secrets: inherit'), false);
  assert.equal(hasYamlKey(source, 'runs-on'), false);
  assert.equal(hasYamlKey(source, 'steps'), false);
  assert.equal(hasYamlKey(source, 'run'), false);
  assert.equal(hasYamlKey(source, 'environment'), false);
  assert.equal(source.includes('id-token: write'), false);
  assertNoForbiddenKeys(workflow);
});

test('reusable workflow参照はpath一致かつ可変branchを使わない', async () => {
  const { workflow } = await readTemplate();
  const ref = workflow.jobs['validate-config'].uses.split('@').at(-1);

  assert.equal(workflow.jobs['validate-config'].uses.startsWith(`nozomu-honda/codex-workflow-kit/${REUSABLE_WORKFLOW_PATH}@`), true);
  assert.equal(ref, 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA');
  assert.equal(isAllowedFixedRef(ref), true);
  assert.notEqual(ref, 'master');
  assert.notEqual(ref, 'main');
});

test('reusable workflow参照refは完全なversion tag、40桁SHA、placeholderだけを許可する', () => {
  const validRefs = [
    'v1.2.3',
    'v10.20.30',
    '0123456789abcdef0123456789abcdef01234567',
    'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA'
  ];
  const invalidRefs = [
    'v1',
    'v1.2',
    'master',
    'main',
    'develop',
    'feature/test',
    '0123456',
    '',
    '   '
  ];

  for (const ref of validRefs) {
    assert.equal(isAllowedFixedRef(ref), true, `${ref} should be valid`);
  }

  for (const ref of invalidRefs) {
    assert.equal(isAllowedFixedRef(ref), false, `${JSON.stringify(ref)} should be invalid`);
  }
});

test('docsのコピー先とテンプレート実体pathが一致する', async () => {
  const readme = await readFile(TEMPLATES_README, 'utf8');
  const installation = await readFile(INSTALLATION_DOC, 'utf8');

  assert.match(readme, new RegExp(escapeRegExp(TEMPLATE_PATH)));
  assert.match(readme, /\.github\/workflows\/validate-config\.yml/);
  assert.match(installation, new RegExp(escapeRegExp(TEMPLATE_PATH)));
  assert.match(installation, /\.github\/workflows\/validate-config\.yml/);
});

function isAllowedFixedRef(ref) {
  return /^v\d+\.\d+\.\d+$/.test(ref)
    || /^[a-f0-9]{40}$/i.test(ref)
    || ref === 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA';
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
    assert.notEqual(key, 'runs-on');
    assert.notEqual(key, 'steps');
    assert.notEqual(key, 'run');
    assertNoForbiddenKeys(entry);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasYamlKey(source, key) {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, 'm').test(source);
}
