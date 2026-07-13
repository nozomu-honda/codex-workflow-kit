import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_ACTORS,
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS,
  GITHUB_EVENT_FIXTURE_NAMES,
  MALFORMED_EVENT_PAYLOADS,
  buildGithubEventPayload,
  buildIssueCommentPayload,
  buildPullRequestPayload,
  draftPr,
  failedWorkflowRun,
  forkReview,
  githubEventFixture,
  invalidPayloadFixture,
  mergedPr,
  pushDefaultBranch,
  pushFeatureBranch,
  sameRepoIssueComment,
  sameRepoReview,
  sameRepoReviewComment,
  successfulWorkflowRun,
  validateGithubEventPayload
} from '../index.js';
import { normalizeAutomationEvent } from '../../../packages/chatgpt-automation-core/src/events/index.js';

const SNAPSHOT_PATH = new URL('../snapshots/github-events.snapshot.json', import.meta.url);

test('各GitHub event payload fixtureをdeterministicに生成できる', () => {
  for (const eventName of GITHUB_EVENT_FIXTURE_NAMES) {
    const first = buildGithubEventPayload(eventName);
    const second = buildGithubEventPayload(eventName);

    assert.deepEqual(first, second);
    assert.equal(validateGithubEventPayload(eventName, first).ok, true);
  }
});

test('主要scenario builderがsame repo / fork / merge / draft / CI状態を表現する', () => {
  assert.equal(sameRepoReview().pull_request.head.repo.full_name, FIXTURE_REPOSITORY.fullName);
  assert.equal(sameRepoReview().pull_request.head.repo.fork, false);
  assert.equal(forkReview().pull_request.head.repo.full_name, 'fork-owner/example-repo');
  assert.equal(forkReview().pull_request.head.repo.fork, true);
  assert.equal(mergedPr().pull_request.merged, true);
  assert.equal(mergedPr().pull_request.state, 'closed');
  assert.equal(draftPr().pull_request.draft, true);
  assert.equal(successfulWorkflowRun().workflow_run.conclusion, 'success');
  assert.equal(failedWorkflowRun().workflow_run.conclusion, 'failure');
  assert.equal(pushDefaultBranch().ref, 'refs/heads/main');
  assert.equal(pushFeatureBranch().ref, 'refs/heads/feature/example-change');
});

test('actor variationsを実値なしで生成できる', () => {
  assert.equal(
    buildPullRequestPayload({ actor: 'unknown' }).sender.login,
    FIXTURE_ACTORS.unknown.login
  );
  assert.equal(
    failedWorkflowRun().sender.login,
    FIXTURE_ACTORS.githubActionsBot.login
  );
  assert.equal(
    buildIssueCommentPayload({ actor: 'chatgptBot' }).sender.login,
    FIXTURE_ACTORS.chatgptBot.login
  );
});

test('invalid payload fixtureとmalformed payload fixtureを安全側に検証できる', () => {
  const invalid = invalidPayloadFixture('pull_request_review', 'missingHeadSha');

  assert.equal(validateGithubEventPayload('pull_request_review', invalid).ok, false);
  assert.deepEqual(validateGithubEventPayload('push', MALFORMED_EVENT_PAYLOADS.nullPayload), {
    ok: false,
    errors: [{ code: 'PAYLOAD_NOT_OBJECT', path: '$' }]
  });
  assert.equal(validateGithubEventPayload('push', MALFORMED_EVENT_PAYLOADS.arrayPayload).ok, false);
  assert.equal(validateGithubEventPayload('push', MALFORMED_EVENT_PAYLOADS.scalarPayload).ok, false);
  assert.throws(() => JSON.parse(MALFORMED_EVENT_PAYLOADS.malformedJson));
});

test('snapshot fixtureは安全な要約だけを固定する', async () => {
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));

  assert.deepEqual(snapshot, {
    sameRepoReview: summarizePayload(sameRepoReview()),
    forkReview: summarizePayload(forkReview()),
    mergedPr: summarizePayload(mergedPr()),
    failedWorkflowRun: summarizePayload(failedWorkflowRun()),
    pushDefaultBranch: summarizePayload(pushDefaultBranch()),
    issueComment: summarizePayload(sameRepoIssueComment()),
    reviewComment: summarizePayload(sameRepoReviewComment())
  });
});

test('fixture payloadは実Repository、実URL、実メール、実SHA、secret-like値を含まない', () => {
  const payloads = [
    sameRepoReview(),
    forkReview(),
    mergedPr(),
    draftPr(),
    failedWorkflowRun(),
    successfulWorkflowRun(),
    pushDefaultBranch(),
    pushFeatureBranch(),
    buildIssueCommentPayload({ actor: 'chatgptBot' })
  ];
  const allowedShas = new Set(Object.values(FIXTURE_SHAS));

  for (const payload of payloads) {
    const serialized = JSON.stringify(payload);
    assert.equal(/github\.com|api\.github\.com|gho_|AKIA|BEGIN [A-Z ]*PRIVATE KEY/i.test(serialized), false);
    assert.equal(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized), false);
    for (const [sha] of serialized.matchAll(/[a-f0-9]{40}/gi)) {
      assert.equal(allowedShas.has(sha), true);
    }
  }
});

test('event normalizer inputとして再利用できる', () => {
  const review = githubEventFixture('pull_request_review');
  const result = normalizeAutomationEvent({
    eventName: review.eventName,
    eventAction: review.eventAction,
    payload: review.payload,
    repository: FIXTURE_REPOSITORY.fullName,
    repositoryOwner: FIXTURE_REPOSITORY.owner,
    defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
    actor: review.payload.sender.login,
    dryRun: true,
    permissionMode: 'read-only',
    requestedCapability: 'normalize-only',
    repositoryConfigJson: '{}'
  });

  assert.equal(result.ok, true);
  assert.equal(result.outputs.pull_request_number, '42');
  assert.equal(result.outputs.head_sha, FIXTURE_SHAS.head);
});

function summarizePayload(payload) {
  const summary = {
    action: payload.action,
    repository: payload.repository?.full_name,
    actor: payload.sender?.login
  };

  if (payload.issue) {
    summary.issueNumber = payload.issue.number;
    summary.commentId = payload.comment?.id;
    summary.isPullRequest = Boolean(payload.issue.pull_request);
  }
  if (payload.pull_request) {
    summary.pullRequestNumber = payload.pull_request.number;
    summary.headSha = payload.pull_request.head?.sha;
    summary.headRepository = payload.pull_request.head?.repo?.full_name;
    summary.baseSha = payload.pull_request.base?.sha;
    summary.merged = payload.pull_request.merged;
    summary.draft = payload.pull_request.draft;
  }
  if (payload.review) {
    summary.reviewState = payload.review.state;
    summary.fork = payload.pull_request?.head?.repo?.fork;
  }
  if (payload.workflow_run) {
    summary.workflowRunId = payload.workflow_run.id;
    summary.workflowName = payload.workflow_run.name;
    summary.workflowConclusion = payload.workflow_run.conclusion;
    summary.headSha = payload.workflow_run.head_sha;
    summary.headRepository = payload.workflow_run.head_repository?.full_name;
  }
  if (payload.ref) {
    summary.ref = payload.ref;
    summary.before = payload.before;
    summary.after = payload.after;
    summary.deleted = payload.deleted;
    summary.forced = payload.forced;
  }
  if (payload.comment && payload.pull_request) {
    summary.commentId = payload.comment.id;
  }

  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined)
  );
}
