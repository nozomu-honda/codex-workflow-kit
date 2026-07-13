import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { NORMALIZED_EVENT_OUTPUT_NAMES, normalizeAutomationEvent } from '../src/events/index.js';

const PINNED_SHA = '0123456789abcdef0123456789abcdef01234567';
const TEMPLATE_REF = 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA';
const DEFAULT_BRANCH = 'master';
const EVENT_TEMPLATE = new URL('../../../templates/workflows/chatgpt-automation-events.yml', import.meta.url);
const REUSABLE_WORKFLOW = new URL('../../../.github/workflows/normalize-event.yml', import.meta.url);
const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';

test('consumer fixtureは固定SHAでcallerからreusable workflowを呼び出せる', async () => {
  await withEventConsumer(async (dir) => {
    const caller = YAML.parse(await readFile(join(dir, '.github/workflows/chatgpt-automation-events.yml'), 'utf8'));
    const reusable = YAML.parse(await readFile(REUSABLE_WORKFLOW, 'utf8'));
    const job = caller.jobs['normalize-event'];

    assert.equal(job.uses, `nozomu-honda/codex-workflow-kit/.github/workflows/normalize-event.yml@${PINNED_SHA}`);
    assert.equal(job.with['kit-ref'], PINNED_SHA);
    assert.deepEqual(Object.keys(reusable.on.workflow_call.outputs).sort(), NORMALIZED_EVENT_OUTPUT_NAMES.toSorted());
    assert.deepEqual(Object.keys(job.with).sort(), [
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
    ].toSorted());
    assert.equal(job.with['repository-config-json'], "${{ vars.CHATGPT_AUTOMATION_EVENT_CONFIG_JSON || '{}' }}");
  });
});

test('consumer event outputは後続jobが使える安定形になる', async () => {
  const result = normalizeAutomationEvent(consumerInput({
    eventName: 'pull_request',
    eventAction: 'closed',
    payload: pullRequestPayload({ merged: true })
  }));

  assert.equal(result.outputs.eligible, 'true');
  assert.equal(result.outputs.repository, 'owner/repo');
  assert.equal(result.outputs.repository_owner, 'owner');
  assert.equal(result.outputs.default_branch, DEFAULT_BRANCH);
  assert.equal(result.outputs.actor, 'octocat');
  assert.equal(result.outputs.pull_request_number, '42');
  assert.equal(result.outputs.head_sha, HEAD_SHA);
  assert.equal(result.outputs.base_sha, BASE_SHA);
  assert.equal(result.outputs.dry_run, 'true');
});

test('fork相当payloadはeligibleにならずSecret利用jobへ進めない', () => {
  const result = normalizeAutomationEvent(consumerInput({
    eventName: 'pull_request_review',
    eventAction: 'submitted',
    payload: pullRequestPayload({
      merged: false,
      headRepository: 'fork/repo',
      fork: true
    })
  }));

  assert.equal(result.outputs.eligible, 'false');
  assert.equal(result.outputs.is_fork, 'true');
  assert.match(result.outputs.ineligible_reason, /fork or external pull request/);
});

test('dry-runではwrite処理が発生せずwrite相当capabilityはfail closedになる', () => {
  const readOnly = normalizeAutomationEvent(consumerInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload({ isPullRequest: false }),
    dryRun: true
  }));
  const writeRequested = normalizeAutomationEvent(consumerInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload(),
    requestedCapability: 'write'
  }));

  assert.equal(readOnly.outputs.dry_run, 'true');
  assert.equal(readOnly.outputs.eligible, 'true');
  assert.equal(writeRequested.outputs.eligible, 'false');
  assert.match(writeRequested.outputs.ineligible_reason, /write capability is not implemented/);
});

test('PR上のissue_commentはPR provenance未検証のためconsumer E2Eでもfail closedになる', () => {
  const result = normalizeAutomationEvent(consumerInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload()
  }));

  assert.equal(result.outputs.eligible, 'false');
  assert.equal(result.outputs.pull_request_number, '42');
  assert.equal(result.outputs.is_same_repository, 'false');
  assert.match(result.outputs.ineligible_reason, /pull request issue_comment provenance is not verified/);
});

test('consumer templateはSecret、pull_request_target、inline write処理を含まない', async () => {
  await withEventConsumer(async (dir) => {
    const source = await readFile(join(dir, '.github/workflows/chatgpt-automation-events.yml'), 'utf8');
    const workflow = YAML.parse(source);

    assert.equal(source.includes('pull_request_target'), false);
    assert.equal(source.includes('secrets:'), false);
    assert.equal(source.includes('contents: write'), false);
    assert.equal(source.includes('pull-requests: write'), false);
    assert.equal(source.includes('issues: write'), false);
    assertNoForbiddenKeys(workflow);
  });
});

async function withEventConsumer(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'event-consumer-e2e-'));
  try {
    const source = await readFile(EVENT_TEMPLATE, 'utf8');
    await writeRepoFile(dir, '.github/workflows/chatgpt-automation-events.yml', source.replaceAll(TEMPLATE_REF, PINNED_SHA).replaceAll('REPLACE_WITH_DEFAULT_BRANCH', DEFAULT_BRANCH));
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeRepoFile(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function consumerInput(overrides = {}) {
  return {
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload(),
    repository: 'owner/repo',
    repositoryOwner: 'owner',
    defaultBranch: DEFAULT_BRANCH,
    actor: 'octocat',
    refName: DEFAULT_BRANCH,
    sha: HEAD_SHA,
    dryRun: true,
    permissionMode: 'read-only',
    requestedCapability: 'normalize-only',
    repositoryConfigJson: '{"labels":{"review":"needs-chatgpt-review"}}',
    ...overrides
  };
}

function repositoryPayload() {
  return {
    full_name: 'owner/repo',
    default_branch: DEFAULT_BRANCH,
    owner: { login: 'owner' }
  };
}

function issueCommentPayload(options = {}) {
  const issue = {
    number: 42
  };

  if (options.isPullRequest ?? true) {
    issue.pull_request = { url: 'https://api.example.invalid/repos/owner/repo/pulls/42' };
  }

  return {
    action: 'created',
    repository: repositoryPayload(),
    sender: { login: 'octocat' },
    issue
  };
}

function pullRequestPayload(options = {}) {
  const headRepository = options.headRepository ?? 'owner/repo';

  return {
    action: 'closed',
    repository: repositoryPayload(),
    sender: { login: 'octocat' },
    pull_request: {
      number: 42,
      merged: options.merged ?? false,
      head: {
        sha: HEAD_SHA,
        repo: {
          full_name: headRepository,
          fork: options.fork ?? false
        }
      },
      base: {
        sha: BASE_SHA,
        repo: {
          full_name: 'owner/repo'
        }
      }
    }
  };
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
