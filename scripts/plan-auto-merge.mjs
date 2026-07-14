#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAutoMergePlan, AUTO_MERGE_OUTPUT_NAMES } from '../packages/chatgpt-automation-core/src/auto-merge/index.js';
import { DEFAULT_SECRET_LIKE_PATTERNS } from '../packages/chatgpt-automation-core/src/config/index.js';

const USER_AGENT = 'codex-workflow-kit-auto-merge-plan';

async function main() {
  const normalizedEvent = readJsonEnv('NORMALIZED_EVENT_JSON', {});
  const eventPayload = readJsonEnv('EVENT_PAYLOAD_JSON', {});
  const config = readJsonEnv('REPOSITORY_CONFIG_JSON', {});
  const repository = normalizedEvent.repository || process.env.GITHUB_REPOSITORY || '';
  const pullRequestNumber = normalizedEvent.pull_request_number || process.env.PULL_REQUEST_NUMBER || '';
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? '';
  const githubApiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const apiRead = process.env.GITHUB_API_READ !== 'false';
  let pullRequest = readJsonEnv('PULL_REQUEST_CONTEXT_JSON', null);
  let changedFiles = readJsonEnv('CHANGED_FILES_JSON', []);
  let reviews = readJsonEnv('REVIEWS_JSON', []);
  let issueComments = readJsonEnv('ISSUE_COMMENTS_JSON', []);
  let reviewThreads = readJsonEnv('REVIEW_THREADS_JSON', []);
  let workflowRuns = readJsonEnv('WORKFLOW_RUNS_JSON', []);
  let checkRuns = readJsonEnv('CHECK_RUNS_JSON', []);
  let commitStatuses = readJsonEnv('COMMIT_STATUSES_JSON', []);
  let repositorySettings = readJsonEnv('REPOSITORY_SETTINGS_JSON', {});
  let comparison = readJsonEnv('COMPARE_JSON', {});
  let actorInfo = readJsonEnv('ACTOR_INFO_JSON', {});
  let apiReadError = '';

  if (apiRead && githubToken && repository && pullRequestNumber) {
    try {
      pullRequest ??= await githubRequest({ githubApiUrl, githubToken, path: `/repos/${repository}/pulls/${pullRequestNumber}` });
      const headSha = pullRequest?.head?.sha || normalizedEvent.head_sha;
      changedFiles = changedFiles.length > 0
        ? changedFiles
        : await listPaginated({ githubApiUrl, githubToken, path: `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100` });
      reviews = reviews.length > 0
        ? reviews
        : await listPaginated({ githubApiUrl, githubToken, path: `/repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100` });
      issueComments = issueComments.length > 0
        ? issueComments
        : await listPaginated({ githubApiUrl, githubToken, path: `/repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100` });
      reviewThreads = reviewThreads.length > 0
        ? reviewThreads
        : await listReviewThreads({ githubApiUrl, githubToken, repository, pullRequestNumber });
      workflowRuns = workflowRuns.length > 0 && headSha
        ? workflowRuns
        : await listWorkflowRuns({ githubApiUrl, githubToken, repository, headSha });
      checkRuns = checkRuns.length > 0 && headSha
        ? checkRuns
        : await listCheckRuns({ githubApiUrl, githubToken, repository, headSha });
      commitStatuses = commitStatuses.length > 0 && headSha
        ? commitStatuses
        : await listCommitStatuses({ githubApiUrl, githubToken, repository, headSha });
      repositorySettings = Object.keys(repositorySettings).length > 0
        ? repositorySettings
        : await githubRequest({ githubApiUrl, githubToken, path: `/repos/${repository}` });
      comparison = Object.keys(comparison).length > 0 && headSha && pullRequest?.base?.ref
        ? comparison
        : await compareBaseWithHead({ baseRef: pullRequest?.base?.ref, githubApiUrl, githubToken, headSha, repository });
      actorInfo = Object.keys(actorInfo).length > 0
        ? actorInfo
        : await getActorPermission({ actor: normalizedEvent.actor, githubApiUrl, githubToken, repository });
    } catch (error) {
      apiReadError = error.message || 'unknown';
    }
  } else if (apiRead && pullRequestNumber && !githubToken) {
    apiReadError = 'github_token_unavailable';
  }

  const plan = createAutoMergePlan({
    actorInfo,
    apiReadError,
    changedFiles,
    checkRuns,
    commitStatuses,
    comparison,
    config,
    eventPayload,
    existingDedupeKeys: readCsvEnv('EXISTING_DEDUPE_KEYS'),
    issueComments,
    lastPlannedAt: process.env.LAST_PLANNED_AT || '',
    normalizedEvent,
    now: process.env.NOW || '',
    pullRequest,
    repositorySettings,
    reviewThreads,
    reviews,
    secretLikePatterns: config.secretLike?.hardBlockPatterns ?? DEFAULT_SECRET_LIKE_PATTERNS,
    workflowRuns
  });

  writeOutputs(plan.outputs);
  logPlan(plan.outputs);
}

function readJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readCsvEnv(name) {
  const raw = process.env[name];
  return raw ? raw.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
}

async function getActorPermission({ actor, githubApiUrl, githubToken, repository }) {
  if (!actor) {
    return {};
  }

  try {
    const data = await githubRequest({
      githubApiUrl,
      githubToken,
      path: `/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`
    });
    return {
      permission: typeof data?.permission === 'string' ? data.permission : '',
      isOrganizationMember: false
    };
  } catch {
    return {};
  }
}

async function listWorkflowRuns({ githubApiUrl, githubToken, repository, headSha }) {
  if (!headSha) {
    return [];
  }
  const data = await listPaginated({
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`
  });
  return data;
}

async function listCheckRuns({ githubApiUrl, githubToken, repository, headSha }) {
  if (!headSha) {
    return [];
  }
  const data = await githubRequest({
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs`
  });
  return Array.isArray(data?.check_runs) ? data.check_runs : [];
}

async function listCommitStatuses({ githubApiUrl, githubToken, repository, headSha }) {
  if (!headSha) {
    return [];
  }
  const data = await githubRequest({
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/commits/${encodeURIComponent(headSha)}/status`
  });
  return Array.isArray(data?.statuses) ? data.statuses : [];
}

export async function listReviewThreads({ fetchImpl = fetch, githubApiUrl, githubToken, maxPages = 100, pullRequestNumber, repository }) {
  const [owner, name] = repository.split('/');
  const query = `query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        reviewThreads(first:100, after:$cursor) {
          nodes { isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  const threads = [];
  const seenCursors = new Set();
  let cursor = null;
  let pageCount = 0;

  if (!owner || !name || !Number.isInteger(Number(pullRequestNumber))) {
    throw new Error('github_graphql_invalid_review_thread_input');
  }

  do {
    pageCount += 1;
    if (pageCount > maxPages) {
      throw new Error('github_graphql_review_threads_page_limit_exceeded');
    }

    if (cursor) {
      seenCursors.add(cursor);
    }

    const data = await githubGraphql({
      fetchImpl,
      githubApiUrl,
      githubToken,
      query,
      variables: { cursor, owner, name, number: Number(pullRequestNumber) }
    });
    const connection = data?.repository?.pullRequest?.reviewThreads;

    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean') {
      throw new Error('github_graphql_unexpected_review_threads_response');
    }

    threads.push(...connection.nodes);

    if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) {
      throw new Error('github_graphql_missing_review_threads_cursor');
    }

    if (connection.pageInfo.hasNextPage) {
      if (connection.pageInfo.endCursor === cursor || seenCursors.has(connection.pageInfo.endCursor)) {
        throw new Error('github_graphql_review_threads_cursor_cycle');
      }
      cursor = connection.pageInfo.endCursor;
    } else {
      cursor = null;
    }
  } while (cursor);

  return threads;
}

async function compareBaseWithHead({ baseRef, githubApiUrl, githubToken, headSha, repository }) {
  if (!baseRef || !headSha) {
    return {};
  }
  return githubRequest({
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headSha)}`
  });
}

async function listPaginated({ githubApiUrl, githubToken, path }) {
  const results = [];
  let nextPath = path;

  while (nextPath) {
    const { data, next } = await githubRequestWithHeaders({ githubApiUrl, githubToken, path: nextPath });
    results.push(...(Array.isArray(data) ? data : data?.workflow_runs ?? []));
    nextPath = next;
  }

  return results;
}

async function githubRequest({ githubApiUrl, githubToken, path }) {
  const { data } = await githubRequestWithHeaders({ githubApiUrl, githubToken, path });
  return data;
}

async function githubGraphql({ fetchImpl = fetch, githubApiUrl, githubToken, query, variables }) {
  const apiBase = githubApiUrl.replace(/\/$/, '');
  const response = await fetchImpl(`${apiBase}/graphql`, {
    body: JSON.stringify({ query, variables }),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28'
    },
    method: 'POST'
  });

  if (!response.ok) {
    throw new Error(`github_api_${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error('github_graphql_error');
  }
  return payload.data;
}

async function githubRequestWithHeaders({ githubApiUrl, githubToken, path }) {
  const response = await fetch(`${githubApiUrl}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28'
    }
  });

  if (!response.ok) {
    throw new Error(`github_api_${response.status}`);
  }

  return {
    data: response.status === 204 ? null : await response.json(),
    next: getNextPath(response.headers.get('link'))
  };
}

function getNextPath(linkHeader) {
  if (!linkHeader) {
    return '';
  }

  const next = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));

  if (!next) {
    return '';
  }

  const match = next.match(/<([^>]+)>/);
  if (!match) {
    return '';
  }

  try {
    const url = new URL(match[1]);
    return `${url.pathname}${url.search}`;
  } catch {
    return '';
  }
}

function writeOutputs(outputs) {
  const outputFile = process.env.GITHUB_OUTPUT;
  const lines = AUTO_MERGE_OUTPUT_NAMES.map((name) => `${name}=${outputs[name] ?? ''}`);

  if (outputFile) {
    appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
    return;
  }

  for (const line of lines) {
    console.log(line);
  }
}

function logPlan(outputs) {
  const action = outputs.eligible === 'true' ? 'eligible' : 'skip';
  const reason = outputs.eligible === 'true' ? outputs.merge_reason : outputs.skip_reason;

  console.log(`auto-merge-plan ${action}: repository=${outputs.repository} pr=${outputs.pull_request_number || '(none)'} head=${outputs.head_sha || '(none)'} mode=${outputs.merge_mode} method=${outputs.merge_method} dry_run=${outputs.dry_run} reason=${reason || '(none)'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`auto-merge-plan failed: ${error.message}`);
    process.exitCode = 1;
  });
}
