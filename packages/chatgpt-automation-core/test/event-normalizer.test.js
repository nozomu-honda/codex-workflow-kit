import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NORMALIZED_EVENT_OUTPUT_NAMES, normalizeAutomationEvent } from '../src/events/index.js';

const REPOSITORY = 'owner/repo';
const OWNER = 'owner';
const DEFAULT_BRANCH = 'master';
const ACTOR = 'octocat';
const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';
const BEFORE_SHA = '3333333333333333333333333333333333333333';

test('通常Issueへのissue_commentを正規化する', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload({ isPullRequest: false })
  }));

  assertEligible(result);
  assert.equal(result.outputs.issue_number, '42');
  assert.equal(result.outputs.pull_request_number, '');
  assert.equal(result.outputs.is_same_repository, 'true');
  assert.equal(result.outputs.is_fork, 'false');
});

test('same-repo PR上のissue_commentはPR provenance未検証のためeligibleにしない', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload()
  }));

  assertIneligible(result, /pull request issue_comment provenance is not verified/);
  assert.equal(result.outputs.issue_number, '42');
  assert.equal(result.outputs.pull_request_number, '42');
  assert.equal(result.outputs.is_same_repository, 'false');
  assert.equal(result.outputs.is_fork, 'false');
});

test('fork PR上のissue_commentもPR provenance未検証のためfail closedにする', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload()
  }));

  assertIneligible(result, /pull request issue_comment provenance is not verified/);
  assert.equal(result.outputs.pull_request_number, '42');
  assert.equal(result.outputs.is_same_repository, 'false');
  assert.equal(result.outputs.is_fork, 'false');
});

test('PR情報を検証できないissue_commentはfail closedにする', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload({
      pullRequest: { url: 'https://api.example.invalid/repos/owner/repo/pulls/42' }
    })
  }));

  assertIneligible(result, /pull request issue_comment provenance is not verified/);
  assert.equal(result.outputs.pull_request_number, '42');
  assert.equal(result.outputs.head_repository, '');
});

test('same-repo PR reviewを正規化する', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'pull_request_review',
    eventAction: 'submitted',
    payload: pullRequestPayload('pull_request_review')
  }));

  assertEligible(result);
  assert.equal(result.outputs.pull_request_number, '42');
  assert.equal(result.outputs.head_sha, HEAD_SHA);
  assert.equal(result.outputs.base_sha, BASE_SHA);
  assert.equal(result.outputs.head_repository, REPOSITORY);
});

test('same-repo review commentを正規化する', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'pull_request_review_comment',
    eventAction: 'created',
    payload: pullRequestPayload('pull_request_review_comment')
  }));

  assertEligible(result);
  assert.equal(result.outputs.pull_request_number, '42');
});

test('成功したworkflow_runを正規化する', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'workflow_run',
    eventAction: 'completed',
    payload: workflowRunPayload({ conclusion: 'success' })
  }));

  assertEligible(result);
  assert.equal(result.outputs.workflow_name, 'CI');
  assert.equal(result.outputs.workflow_conclusion, 'success');
  assert.equal(result.outputs.head_sha, HEAD_SHA);
});

test('mergedされたpull_request.closedを正規化する', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'pull_request',
    eventAction: 'closed',
    payload: pullRequestPayload('pull_request', { merged: true })
  }));

  assertEligible(result);
  assert.equal(result.outputs.pull_request_number, '42');
});

test('default branchへのpushを正規化する', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'push',
    eventAction: '',
    payload: pushPayload({ ref: 'refs/heads/master' })
  }));

  assertEligible(result);
  assert.equal(result.outputs.head_sha, HEAD_SHA);
  assert.equal(result.outputs.base_sha, BEFORE_SHA);
  assert.equal(result.outputs.head_repository, REPOSITORY);
});

test('fork PRはeligibleにしない', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'pull_request_review',
    eventAction: 'submitted',
    payload: pullRequestPayload('pull_request_review', {
      headRepository: 'fork/repo',
      fork: true
    })
  }));

  assertIneligible(result, /fork or external pull request/);
  assert.equal(result.outputs.is_same_repository, 'false');
  assert.equal(result.outputs.is_fork, 'true');
});

test('external repository payloadはeligibleにしない', () => {
  const payload = issueCommentPayload();
  payload.repository.full_name = 'other/repo';
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload
  }));

  assertIneligible(result, /repository mismatch/);
});

test('必要なPR番号がないpayloadはeligibleにしない', () => {
  const payload = pullRequestPayload('pull_request_review');
  delete payload.pull_request.number;
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'pull_request_review',
    eventAction: 'submitted',
    payload
  }));

  assertIneligible(result, /missing pull request number/);
});

test('想定外actionはeligibleにしない', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'pull_request_review',
    eventAction: 'dismissed',
    payload: pullRequestPayload('pull_request_review')
  }));

  assertIneligible(result, /unsupported action/);
});

test('失敗またはキャンセルされたworkflow_runはeligibleにしない', () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const result = normalizeAutomationEvent(baseInput({
      eventName: 'workflow_run',
      eventAction: 'completed',
      payload: workflowRunPayload({ conclusion })
    }));

    assertIneligible(result, /workflow_run conclusion is not success/);
  }
});

test('default branch以外へのpushはeligibleにしない', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'push',
    eventAction: '',
    payload: pushPayload({ ref: 'refs/heads/feature/test' })
  }));

  assertIneligible(result, /push target is not default branch/);
});

test('必須input不足、不正boolean、不正enumはfail closedになる', () => {
  const payloadWithoutRepository = pushPayload({ ref: 'refs/heads/master' });
  delete payloadWithoutRepository.repository;
  const missingInput = normalizeAutomationEvent({
    eventName: 'push',
    payload: payloadWithoutRepository,
    dryRun: true,
    permissionMode: 'read-only',
    requestedCapability: 'normalize-only'
  });
  assertIneligible(missingInput, /missing required input: repository/);

  const invalidBoolean = normalizeAutomationEvent(baseInput({
    eventName: 'push',
    payload: pushPayload({ ref: 'refs/heads/master' }),
    dryRun: 'maybe'
  }));
  assertIneligible(invalidBoolean, /dry-run input must be true or false/);

  const invalidPermission = normalizeAutomationEvent(baseInput({
    eventName: 'push',
    payload: pushPayload({ ref: 'refs/heads/master' }),
    permissionMode: 'contents-write'
  }));
  assertIneligible(invalidPermission, /permission mode is not read-only/);
});

test('write相当capabilityやSecret不足を必要とする経路へ進まない', () => {
  const result = normalizeAutomationEvent(baseInput({
    eventName: 'issue_comment',
    eventAction: 'created',
    payload: issueCommentPayload(),
    requestedCapability: 'write'
  }));

  assertIneligible(result, /write capability is not implemented/);
});

test('不明payloadと不正repository config jsonはfail openしない', () => {
  const badPayload = normalizeAutomationEvent(baseInput({
    eventName: 'push',
    payload: '{not-json}'
  }));
  assertIneligible(badPayload, /event payload json is invalid/);

  const badConfig = normalizeAutomationEvent(baseInput({
    eventName: 'push',
    payload: pushPayload({ ref: 'refs/heads/master' }),
    repositoryConfigJson: '[]'
  }));
  assertIneligible(badConfig, /repository config json must be an object/);
});

function assertEligible(result) {
  assert.equal(result.ok, true);
  assert.equal(result.outputs.eligible, 'true');
  assert.equal(result.outputs.ineligible_reason, '');
  assert.deepEqual(Object.keys(result.outputs).sort(), NORMALIZED_EVENT_OUTPUT_NAMES.toSorted());
}

function assertIneligible(result, reasonPattern) {
  assert.equal(result.ok, false);
  assert.equal(result.outputs.eligible, 'false');
  assert.match(result.outputs.ineligible_reason, reasonPattern);
  assert.deepEqual(Object.keys(result.outputs).sort(), NORMALIZED_EVENT_OUTPUT_NAMES.toSorted());
}

function baseInput(overrides = {}) {
  return {
    eventName: 'push',
    eventAction: '',
    payload: pushPayload({ ref: 'refs/heads/master' }),
    repository: REPOSITORY,
    repositoryOwner: OWNER,
    defaultBranch: DEFAULT_BRANCH,
    actor: ACTOR,
    refName: DEFAULT_BRANCH,
    sha: HEAD_SHA,
    dryRun: true,
    permissionMode: 'read-only',
    requestedCapability: 'normalize-only',
    repositoryConfigJson: '{}',
    ...overrides
  };
}

function repositoryPayload() {
  return {
    full_name: REPOSITORY,
    default_branch: DEFAULT_BRANCH,
    owner: { login: OWNER }
  };
}

function senderPayload() {
  return { login: ACTOR };
}

function issueCommentPayload(options = {}) {
  const isPullRequest = options.isPullRequest ?? true;
  const issue = {
    number: 42
  };

  if (isPullRequest) {
    issue.pull_request = options.pullRequest ?? { url: 'https://api.example.invalid/repos/owner/repo/pulls/42' };
  }

  return {
    action: 'created',
    repository: repositoryPayload(),
    sender: senderPayload(),
    issue,
    comment: {
      body: 'review marker'
    }
  };
}

function pullRequestPayload(action, options = {}) {
  const headRepository = options.headRepository ?? REPOSITORY;

  return {
    action,
    repository: repositoryPayload(),
    sender: senderPayload(),
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
          full_name: REPOSITORY
        }
      }
    }
  };
}

function workflowRunPayload(options = {}) {
  return {
    action: 'completed',
    repository: repositoryPayload(),
    sender: senderPayload(),
    workflow_run: {
      name: 'CI',
      conclusion: options.conclusion ?? 'success',
      head_sha: HEAD_SHA,
      head_repository: {
        full_name: options.headRepository ?? REPOSITORY
      },
      pull_requests: [
        { number: 42 }
      ]
    }
  };
}

function pushPayload(options = {}) {
  return {
    repository: repositoryPayload(),
    sender: senderPayload(),
    ref: options.ref,
    before: BEFORE_SHA,
    after: HEAD_SHA
  };
}
