export const FIXTURE_REPOSITORY = Object.freeze({
  owner: 'owner',
  name: 'example-repo',
  fullName: 'owner/example-repo',
  defaultBranch: 'main'
});

export const FIXTURE_FORK_REPOSITORY = Object.freeze({
  owner: 'fork-owner',
  name: 'example-repo',
  fullName: 'fork-owner/example-repo',
  defaultBranch: 'main'
});

export const FIXTURE_EXTERNAL_REPOSITORY = Object.freeze({
  owner: 'external-owner',
  name: 'external-repo',
  fullName: 'external-owner/external-repo',
  defaultBranch: 'main'
});

export const FIXTURE_SHAS = Object.freeze({
  before: '0000000000000000000000000000000000000001',
  base: '0000000000000000000000000000000000000002',
  head: '0000000000000000000000000000000000000003',
  merge: '0000000000000000000000000000000000000004',
  after: '0000000000000000000000000000000000000005',
  workflow: '0000000000000000000000000000000000000006'
});

export const FIXTURE_ACTORS = Object.freeze({
  user: Object.freeze({
    login: 'fixture-user',
    type: 'User'
  }),
  unknown: Object.freeze({
    login: 'unknown-actor',
    type: 'User'
  }),
  githubActionsBot: Object.freeze({
    login: 'github-actions[bot]',
    type: 'Bot'
  }),
  chatgptBot: Object.freeze({
    login: 'chatgpt-review-bot',
    type: 'Bot'
  })
});

export const GITHUB_EVENT_FIXTURE_NAMES = Object.freeze([
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
  'push'
]);

export const MALFORMED_EVENT_PAYLOADS = Object.freeze({
  malformedJson: '{not-json}',
  nullPayload: null,
  arrayPayload: [],
  scalarPayload: 'not-an-object'
});

const FIXTURE_API_BASE_URL = 'https://example.invalid/api';
const FIXTURE_WEB_BASE_URL = 'https://example.invalid/web';

export function buildGithubEventPayload(eventName, options = {}) {
  switch (eventName) {
    case 'issue_comment':
      return buildIssueCommentPayload(options);
    case 'pull_request':
      return buildPullRequestPayload(options);
    case 'pull_request_review':
      return buildPullRequestReviewPayload(options);
    case 'pull_request_review_comment':
      return buildPullRequestReviewCommentPayload(options);
    case 'workflow_run':
      return buildWorkflowRunPayload(options);
    case 'push':
      return buildPushPayload(options);
    default:
      throw new Error(`Unsupported GitHub event fixture: ${eventName}`);
  }
}

export function githubEventFixture(eventName, options = {}) {
  const payload = buildGithubEventPayload(eventName, options);

  return {
    eventName,
    eventAction: payload.action ?? '',
    payload
  };
}

export function sameRepoIssueComment(options = {}) {
  return buildIssueCommentPayload({
    isPullRequest: false,
    ...options
  });
}

export function sameRepoReview(options = {}) {
  return buildPullRequestReviewPayload(options);
}

export function forkReview(options = {}) {
  return buildPullRequestReviewPayload({
    fork: true,
    ...options
  });
}

export function sameRepoReviewComment(options = {}) {
  return buildPullRequestReviewCommentPayload(options);
}

export function mergedPr(options = {}) {
  return buildPullRequestPayload({
    action: 'closed',
    merged: true,
    ...options
  });
}

export function draftPr(options = {}) {
  return buildPullRequestPayload({
    draft: true,
    ...options
  });
}

export function successfulWorkflowRun(options = {}) {
  return buildWorkflowRunPayload({
    conclusion: 'success',
    ...options
  });
}

export function failedWorkflowRun(options = {}) {
  return buildWorkflowRunPayload({
    conclusion: 'failure',
    ...options
  });
}

export function pushDefaultBranch(options = {}) {
  return buildPushPayload({
    ref: `refs/heads/${FIXTURE_REPOSITORY.defaultBranch}`,
    ...options
  });
}

export function pushFeatureBranch(options = {}) {
  return buildPushPayload({
    ref: 'refs/heads/feature/example-change',
    ...options
  });
}

export function invalidPayloadFixture(eventName, reason = 'missingRepository') {
  const payload = buildGithubEventPayload(eventName);

  switch (reason) {
    case 'missingRepository':
      delete payload.repository;
      return payload;
    case 'missingSender':
      delete payload.sender;
      return payload;
    case 'missingPullRequest':
      delete payload.pull_request;
      return payload;
    case 'missingHeadSha':
      if (payload.pull_request?.head) {
        delete payload.pull_request.head.sha;
      }
      if (payload.workflow_run) {
        delete payload.workflow_run.head_sha;
      }
      if (eventName === 'push') {
        delete payload.after;
      }
      return payload;
    case 'externalRepository':
      payload.repository = buildRepository({ repository: FIXTURE_EXTERNAL_REPOSITORY });
      return payload;
    default:
      throw new Error(`Unsupported invalid payload fixture reason: ${reason}`);
  }
}

export function buildIssueCommentPayload(options = {}) {
  const action = options.action ?? 'created';
  const actor = resolveActor(options.actor);
  const repository = resolveRepository(options.repository);
  const issue = {
    number: options.issueNumber ?? 42,
    title: 'Fixture issue title'
  };

  if (options.isPullRequest ?? true) {
    issue.pull_request = {
      url: fixtureApiUrl(`/repos/${repository.fullName}/pulls/${options.pullRequestNumber ?? issue.number}`)
    };
  }

  return removeUndefined({
    action,
    repository: buildRepository({ repository }),
    sender: buildSender(actor),
    issue,
    comment: buildComment({
      id: options.commentId ?? 1001,
      body: options.body ?? 'Fixture issue comment body',
      actor
    })
  });
}

export function buildPullRequestPayload(options = {}) {
  const action = options.action ?? 'opened';
  const actor = resolveActor(options.actor);
  const repository = resolveRepository(options.repository);
  const pullRequest = buildPullRequest(options);

  return removeUndefined({
    action,
    repository: buildRepository({ repository }),
    sender: buildSender(actor),
    number: pullRequest.number,
    pull_request: pullRequest
  });
}

export function buildPullRequestReviewPayload(options = {}) {
  const action = options.action ?? 'submitted';
  const actor = resolveActor(options.actor);
  const repository = resolveRepository(options.repository);

  return removeUndefined({
    action,
    repository: buildRepository({ repository }),
    sender: buildSender(actor),
    pull_request: buildPullRequest(options),
    review: buildReview({
      id: options.reviewId ?? 2001,
      state: options.reviewState ?? 'approved',
      body: options.body ?? 'Fixture review body',
      actor
    })
  });
}

export function buildPullRequestReviewCommentPayload(options = {}) {
  const action = options.action ?? 'created';
  const actor = resolveActor(options.actor);
  const repository = resolveRepository(options.repository);

  return removeUndefined({
    action,
    repository: buildRepository({ repository }),
    sender: buildSender(actor),
    pull_request: buildPullRequest(options),
    comment: buildComment({
      id: options.commentId ?? 3001,
      body: options.body ?? 'Fixture review comment body',
      actor
    })
  });
}

export function buildWorkflowRunPayload(options = {}) {
  const action = options.action ?? 'completed';
  const actor = resolveActor(options.actor ?? 'githubActionsBot');
  const repository = resolveRepository(options.repository);
  const headRepository = resolveHeadRepository(options);
  const pullRequestNumber = options.pullRequestNumber ?? 42;

  return removeUndefined({
    action,
    repository: buildRepository({ repository }),
    sender: buildSender(actor),
    workflow_run: {
      id: options.workflowRunId ?? 4001,
      name: options.workflowName ?? 'CI',
      event: options.workflowEvent ?? 'pull_request',
      status: options.status ?? 'completed',
      conclusion: options.conclusion ?? 'success',
      head_sha: options.headSha ?? FIXTURE_SHAS.head,
      head_branch: options.headBranch ?? 'feature/example-change',
      head_repository: buildRepository({
        repository: headRepository,
        fork: headRepository.fullName !== repository.fullName
      }),
      pull_requests: options.pullRequests ?? [
        {
          number: pullRequestNumber,
          head: {
            sha: options.headSha ?? FIXTURE_SHAS.head,
            repo: buildRepository({
              repository: headRepository,
              fork: headRepository.fullName !== repository.fullName
            })
          },
          base: {
            sha: options.baseSha ?? FIXTURE_SHAS.base,
            repo: buildRepository({ repository })
          }
        }
      ]
    }
  });
}

export function buildPushPayload(options = {}) {
  const actor = resolveActor(options.actor ?? 'githubActionsBot');
  const repository = resolveRepository(options.repository);

  return removeUndefined({
    ref: options.ref ?? `refs/heads/${repository.defaultBranch}`,
    before: options.before ?? FIXTURE_SHAS.before,
    after: options.after ?? FIXTURE_SHAS.after,
    deleted: options.deleted ?? false,
    forced: options.forced ?? false,
    repository: buildRepository({ repository }),
    sender: buildSender(actor),
    pusher: {
      name: actor.login
    },
    commits: options.commits ?? [
      {
        id: options.after ?? FIXTURE_SHAS.after,
        message: options.commitMessage ?? 'Fixture commit'
      }
    ]
  });
}

export function validateGithubEventPayload(eventName, payload) {
  const errors = [];

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      errors: [{ code: 'PAYLOAD_NOT_OBJECT', path: '$' }]
    };
  }

  requirePath(payload, ['repository', 'full_name'], errors, 'REPOSITORY_MISSING');
  requirePath(payload, ['sender', 'login'], errors, 'SENDER_MISSING');

  switch (eventName) {
    case 'issue_comment':
      requirePath(payload, ['issue', 'number'], errors, 'ISSUE_NUMBER_MISSING');
      requirePath(payload, ['comment', 'id'], errors, 'COMMENT_ID_MISSING');
      break;
    case 'pull_request':
      requirePullRequestShape(payload, errors);
      break;
    case 'pull_request_review':
      requirePullRequestShape(payload, errors);
      requirePath(payload, ['review', 'id'], errors, 'REVIEW_ID_MISSING');
      break;
    case 'pull_request_review_comment':
      requirePullRequestShape(payload, errors);
      requirePath(payload, ['comment', 'id'], errors, 'COMMENT_ID_MISSING');
      break;
    case 'workflow_run':
      requirePath(payload, ['workflow_run', 'id'], errors, 'WORKFLOW_RUN_ID_MISSING');
      requirePath(payload, ['workflow_run', 'head_sha'], errors, 'WORKFLOW_RUN_HEAD_SHA_MISSING');
      break;
    case 'push':
      requirePath(payload, ['ref'], errors, 'PUSH_REF_MISSING');
      requirePath(payload, ['before'], errors, 'PUSH_BEFORE_MISSING');
      requirePath(payload, ['after'], errors, 'PUSH_AFTER_MISSING');
      break;
    default:
      errors.push({ code: 'EVENT_UNSUPPORTED', path: '$' });
  }

  if (containsForbiddenFixtureValue(payload)) {
    errors.push({ code: 'FIXTURE_FORBIDDEN_VALUE', path: '$' });
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function requirePullRequestShape(payload, errors) {
  requirePath(payload, ['pull_request', 'number'], errors, 'PULL_REQUEST_NUMBER_MISSING');
  requirePath(payload, ['pull_request', 'head', 'sha'], errors, 'PULL_REQUEST_HEAD_SHA_MISSING');
  requirePath(payload, ['pull_request', 'head', 'repo', 'full_name'], errors, 'PULL_REQUEST_HEAD_REPO_MISSING');
  requirePath(payload, ['pull_request', 'base', 'sha'], errors, 'PULL_REQUEST_BASE_SHA_MISSING');
  requirePath(payload, ['pull_request', 'base', 'repo', 'full_name'], errors, 'PULL_REQUEST_BASE_REPO_MISSING');
}

function requirePath(value, path, errors, code) {
  let current = value;
  for (const part of path) {
    current = current?.[part];
  }
  if (current === undefined || current === null || current === '') {
    errors.push({
      code,
      path: `$.${path.join('.')}`
    });
  }
}

function buildPullRequest(options = {}) {
  const repository = resolveRepository(options.repository);
  const headRepository = resolveHeadRepository(options);
  const number = options.pullRequestNumber ?? 42;
  const merged = options.merged ?? false;

  return removeUndefined({
    number,
    title: options.title ?? 'Fixture pull request title',
    state: options.state ?? (merged ? 'closed' : 'open'),
    draft: options.draft ?? false,
    merged,
    merge_commit_sha: merged ? (options.mergeSha ?? FIXTURE_SHAS.merge) : null,
    head: {
      ref: options.headRef ?? 'feature/example-change',
      sha: options.headSha ?? FIXTURE_SHAS.head,
      repo: buildRepository({
        repository: headRepository,
        fork: headRepository.fullName !== repository.fullName
      })
    },
    base: {
      ref: options.baseRef ?? repository.defaultBranch,
      sha: options.baseSha ?? FIXTURE_SHAS.base,
      repo: buildRepository({ repository })
    },
    user: buildSender(resolveActor(options.actor))
  });
}

function buildRepository({ repository = FIXTURE_REPOSITORY, fork = false } = {}) {
  return {
    full_name: repository.fullName,
    name: repository.name,
    default_branch: repository.defaultBranch,
    fork,
    owner: {
      login: repository.owner
    },
    url: fixtureApiUrl(`/repos/${repository.fullName}`),
    html_url: fixtureWebUrl(`/${repository.fullName}`)
  };
}

function buildSender(actor = FIXTURE_ACTORS.user) {
  return {
    login: actor.login,
    type: actor.type
  };
}

function buildComment({ id, body, actor }) {
  return {
    id,
    body,
    user: buildSender(actor),
    url: fixtureApiUrl(`/comments/${id}`)
  };
}

function buildReview({ id, state, body, actor }) {
  return {
    id,
    state,
    body,
    user: buildSender(actor),
    html_url: fixtureWebUrl(`/reviews/${id}`)
  };
}

function resolveActor(actor = 'user') {
  if (typeof actor === 'string') {
    return FIXTURE_ACTORS[actor] ?? FIXTURE_ACTORS.user;
  }
  return actor;
}

function resolveRepository(repository = FIXTURE_REPOSITORY) {
  return repository;
}

function resolveHeadRepository(options = {}) {
  if (options.headRepository) {
    return options.headRepository;
  }
  if (options.fork) {
    return FIXTURE_FORK_REPOSITORY;
  }
  return resolveRepository(options.repository);
}

function containsForbiddenFixtureValue(value) {
  const serialized = JSON.stringify(value);
  return /github\.com|api\.github\.com|@|gho_|AKIA|BEGIN [A-Z ]*PRIVATE KEY/i.test(serialized);
}

function fixtureApiUrl(path) {
  return `${FIXTURE_API_BASE_URL}${path}`;
}

function fixtureWebUrl(path) {
  return `${FIXTURE_WEB_BASE_URL}${path}`;
}

function removeUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, removeUndefined(entry)])
  );
}
