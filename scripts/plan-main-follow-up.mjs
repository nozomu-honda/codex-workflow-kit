#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createMainFollowUpPlan,
  MAIN_FOLLOW_UP_OUTPUT_NAMES
} from '../packages/chatgpt-automation-core/src/main-follow-up/index.js';

const USER_AGENT = 'codex-workflow-kit-main-follow-up-plan';
const MAX_PAGINATION_PAGES = 100;
const MAX_MERGEABLE_RETRIES = 3;
const MERGEABLE_RETRY_DELAYS_MS = Object.freeze([250, 500, 500]);
const SCAN_ERROR_CODES = new Set([
  'base_sha_missing',
  'base_sha_mismatch',
  'base_sha_changed_during_scan',
  'pull_request_head_changed_during_scan',
  'pull_request_base_changed_during_scan'
]);

async function main() {
  const normalizedEvent = readJsonEnv('NORMALIZED_EVENT_JSON', {});
  const eventPayload = readJsonEnv('EVENT_PAYLOAD_JSON', {});
  const config = readJsonEnv('REPOSITORY_CONFIG_JSON', {});
  const mainConfig = config.mainFollowUp ?? {};
  const repository = normalizedEvent.repository || process.env.GITHUB_REPOSITORY || '';
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? '';
  const githubApiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const apiRead = process.env.GITHUB_API_READ !== 'false';
  const defaultBranch = normalizedEvent.default_branch || config.baseBranch || '';
  const baseBranch = readBaseBranch({ defaultBranch, eventPayload, normalizedEvent });
  let openPullRequests = readJsonEnv('OPEN_PULL_REQUESTS_JSON', []);
  let targetBaseSha = '';
  let apiReadError = '';
  let scanError = '';

  if (apiRead && githubToken && repository && baseBranch) {
    try {
      const context = await readGithubMainFollowUpContext({
        baseBranch,
        defaultBranch,
        eventPayload,
        githubApiUrl,
        githubToken,
        mainConfig,
        normalizedEvent,
        openPullRequests,
        repository
      });
      openPullRequests = context.openPullRequests;
      targetBaseSha = context.targetBaseSha;
    } catch (error) {
      if (SCAN_ERROR_CODES.has(error.message)) {
        scanError = error.message;
      } else {
        apiReadError = error.message || 'unknown';
      }
    }
  } else if (apiRead && !githubToken) {
    apiReadError = 'github_token_unavailable';
  }

  const plan = createMainFollowUpPlan({
    apiReadError,
    config,
    eventPayload,
    existingDedupeKeys: readCsvEnv('EXISTING_DEDUPE_KEYS'),
    normalizedEvent,
    now: process.env.NOW || '',
    openPullRequests: applyAttemptState({
      attempts: readJsonEnv('ATTEMPT_COUNTS_JSON', {}),
      lastAttemptedAt: readJsonEnv('LAST_ATTEMPTED_AT_JSON', {}),
      pullRequests: openPullRequests
    }),
    scanError,
    targetBaseSha
  });

  writeOutputs(plan.outputs);
  logPlan(plan.outputs);
}

export async function readGithubMainFollowUpContext({
  baseBranch,
  defaultBranch,
  eventPayload,
  fetchImpl = fetch,
  githubApiUrl,
  githubToken,
  mainConfig = {},
  normalizedEvent,
  openPullRequests = [],
  repository,
  sleep = wait
}) {
  const initialDefaultBranchSha = await getDefaultBranchSha({
    branch: defaultBranch,
    fetchImpl,
    githubApiUrl,
    githubToken,
    repository
  });
  const targetBaseSha = resolveTargetBaseShaForScan({
    currentDefaultBranchSha: initialDefaultBranchSha,
    eventPayload,
    normalizedEvent
  });
  const sourcePullRequests = openPullRequests.length > 0
    ? openPullRequests
    : await listOpenPullRequests({ baseBranch, fetchImpl, githubApiUrl, githubToken, repository });
  const hydrated = await hydratePullRequests({
    baseBranch,
    fetchImpl,
    githubApiUrl,
    githubToken,
    pullRequests: sourcePullRequests.slice(0, Number(mainConfig.maxOpenPullRequests ?? 100) + 1),
    repository,
    sleep,
    targetBaseSha
  });
  const finalDefaultBranchSha = await getDefaultBranchSha({
    branch: defaultBranch,
    fetchImpl,
    githubApiUrl,
    githubToken,
    repository
  });

  if (finalDefaultBranchSha !== targetBaseSha) {
    throw new Error('base_sha_changed_during_scan');
  }

  return {
    openPullRequests: hydrated,
    targetBaseSha
  };
}

export async function hydratePullRequests({
  baseBranch,
  fetchImpl = fetch,
  githubApiUrl,
  githubToken,
  pullRequests,
  repository,
  sleep = wait,
  targetBaseSha
}) {
  const hydrated = [];

  for (const pullRequest of pullRequests) {
    const number = pullRequest.number;
    if (!Number.isInteger(number)) {
      continue;
    }
    const detail = await fetchPullRequestDetailWithMergeabilityRetry({
      fetchImpl,
      githubApiUrl,
      githubToken,
      number,
      repository,
      sleep
    });
    if (detail.state !== 'open' || detail.merged === true) {
      continue;
    }
    assertPullRequestBaseSnapshot(detail, {
      baseBranch,
      repository,
      targetBaseSha
    });

    const changedFiles = await listPaginated({
      fetchImpl,
      githubApiUrl,
      githubToken,
      path: `/repos/${repository}/pulls/${number}/files?per_page=100`
    });
    const compare = await compareBaseWithHead({
      fetchImpl,
      githubApiUrl,
      githubToken,
      headSha: detail.head?.sha,
      repository,
      targetBaseSha
    });
    const headBranchExists = await branchExists({
      fetchImpl,
      githubApiUrl,
      githubToken,
      ref: detail.head?.ref,
      repository
    });
    const verification = await getPullRequestDetail({
      fetchImpl,
      githubApiUrl,
      githubToken,
      number,
      repository
    });

    assertPullRequestSnapshotStable(toPullRequestSnapshot(detail), toPullRequestSnapshot(verification));
    if (verification.state !== 'open' || verification.merged === true) {
      throw new Error('pull_request_head_changed_during_scan');
    }

    hydrated.push({
      ...detail,
      changedFiles,
      compare,
      headBranchExists
    });
  }

  return hydrated;
}

export async function fetchPullRequestDetailWithMergeabilityRetry({
  fetchImpl = fetch,
  githubApiUrl,
  githubToken,
  maxRetries = MAX_MERGEABLE_RETRIES,
  number,
  repository,
  retryDelaysMs = MERGEABLE_RETRY_DELAYS_MS,
  sleep = wait
}) {
  let firstSnapshot = null;
  let current = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    current = await getPullRequestDetail({
      fetchImpl,
      githubApiUrl,
      githubToken,
      number,
      repository
    });
    const snapshot = toPullRequestSnapshot(current);

    if (firstSnapshot) {
      assertPullRequestSnapshotStable(firstSnapshot, snapshot);
    } else {
      firstSnapshot = snapshot;
    }

    if (current.state !== 'open' || current.merged === true || current.mergeable !== null) {
      return current;
    }

    if (attempt < maxRetries) {
      await sleep(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? retryDelaysMs.at(-1) ?? 0);
    }
  }

  return current;
}

export async function listOpenPullRequests({ baseBranch, fetchImpl = fetch, githubApiUrl, githubToken, repository }) {
  return listPaginated({
    fetchImpl,
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&sort=created&direction=asc&per_page=100`
  });
}

export async function getDefaultBranchSha({ branch, fetchImpl = fetch, githubApiUrl, githubToken, repository }) {
  if (!branch) {
    throw new Error('base_sha_missing');
  }
  const data = await githubRequest({
    fetchImpl,
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/git/ref/heads/${encodeGitRef(branch)}`
  });
  const sha = cleanSha(data?.object?.sha);
  if (!sha) {
    throw new Error('base_sha_missing');
  }
  return sha;
}

export function resolveTargetBaseShaForScan({ currentDefaultBranchSha, eventPayload = {}, normalizedEvent = {} }) {
  const current = cleanSha(currentDefaultBranchSha);
  if (!current) {
    throw new Error('base_sha_missing');
  }

  if (normalizedEvent.event_name === 'push') {
    const eventAfter = cleanSha(eventPayload?.after);
    const normalizedHead = cleanSha(normalizedEvent.head_sha);
    if (eventAfter && normalizedHead && eventAfter !== normalizedHead) {
      throw new Error('base_sha_mismatch');
    }
    const triggerSha = normalizedHead || eventAfter;
    if (!triggerSha) {
      throw new Error('base_sha_missing');
    }
    if (triggerSha !== current) {
      throw new Error('base_sha_changed_during_scan');
    }
    return current;
  }

  if (normalizedEvent.event_name === 'pull_request') {
    const mergeCommitSha = cleanSha(eventPayload?.pull_request?.merge_commit_sha);
    if (!mergeCommitSha) {
      throw new Error('base_sha_missing');
    }
    if (mergeCommitSha !== current) {
      throw new Error('base_sha_changed_during_scan');
    }
    return current;
  }

  if (normalizedEvent.event_name === 'workflow_dispatch') {
    const requestedBaseSha = cleanSha(eventPayload?.inputs?.base_sha);
    if (requestedBaseSha && requestedBaseSha !== current) {
      throw new Error('base_sha_mismatch');
    }
    return current;
  }

  return current;
}

export async function compareBaseWithHead({ fetchImpl = fetch, githubApiUrl, githubToken, headSha, repository, targetBaseSha }) {
  if (!targetBaseSha || !headSha) {
    return {};
  }
  const compare = await githubRequest({
    fetchImpl,
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/compare/${encodeURIComponent(targetBaseSha)}...${encodeURIComponent(headSha)}`
  });
  const baseCommitSha = cleanSha(compare?.base_commit?.sha);
  if (baseCommitSha !== targetBaseSha) {
    throw new Error('base_sha_mismatch');
  }
  return compare;
}

export async function branchExists({ fetchImpl = fetch, githubApiUrl, githubToken, ref, repository }) {
  if (!ref) {
    return false;
  }
  try {
    await githubRequest({
      fetchImpl,
      githubApiUrl,
      githubToken,
      path: `/repos/${repository}/git/ref/heads/${encodeGitRef(ref)}`
    });
    return true;
  } catch (error) {
    if (error.message === 'github_api_404') {
      return false;
    }
    throw error;
  }
}

function applyAttemptState({ attempts, lastAttemptedAt, pullRequests }) {
  return (Array.isArray(pullRequests) ? pullRequests : []).map((pullRequest) => ({
    ...pullRequest,
    attemptCount: Number.isInteger(attempts?.[pullRequest.number]) ? attempts[pullRequest.number] : pullRequest.attemptCount,
    lastAttemptedAt: typeof lastAttemptedAt?.[pullRequest.number] === 'string' ? lastAttemptedAt[pullRequest.number] : pullRequest.lastAttemptedAt
  }));
}

export async function listPaginated({
  fetchImpl = fetch,
  githubApiUrl,
  githubToken,
  maxPages = MAX_PAGINATION_PAGES,
  path
}) {
  const results = [];
  const visited = new Set();
  const expectedPathname = pathnameFor(githubApiUrl, path);
  let nextPath = path;
  let pageCount = 0;

  while (nextPath) {
    const normalizedPath = normalizeApiPath(nextPath);
    if (visited.has(normalizedPath)) {
      throw new Error('github_api_pagination_cycle');
    }
    visited.add(normalizedPath);
    pageCount += 1;
    if (pageCount > maxPages) {
      throw new Error('github_api_pagination_page_limit_exceeded');
    }

    const { data, next } = await githubRequestWithHeaders({
      expectedPathname,
      fetchImpl,
      githubApiUrl,
      githubToken,
      path: normalizedPath
    });
    if (!Array.isArray(data)) {
      throw new Error('github_api_unexpected_list_response');
    }
    results.push(...data);
    nextPath = next;
  }

  return results;
}

export async function githubRequest({ fetchImpl = fetch, githubApiUrl, githubToken, path }) {
  const { data } = await githubRequestWithHeaders({ fetchImpl, githubApiUrl, githubToken, path });
  return data;
}

export async function githubRequestWithHeaders({
  expectedPathname,
  fetchImpl = fetch,
  githubApiUrl,
  githubToken,
  path
}) {
  const normalizedPath = normalizeApiPath(path);
  const response = await fetchImpl(`${githubApiUrl}${normalizedPath}`, {
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
    next: getNextPath(response.headers.get('link'), {
      expectedPathname,
      githubApiUrl
    })
  };
}

export function getNextPath(linkHeader, { expectedPathname = '', githubApiUrl = 'https://api.github.com' } = {}) {
  if (!linkHeader) {
    return '';
  }

  const parts = linkHeader.split(',').map((part) => part.trim()).filter(Boolean);
  const nextParts = parts.filter((part) => /\brel\s*=\s*"next"/.test(part));

  if (nextParts.length === 0) {
    return '';
  }

  const match = nextParts[0].match(/<([^>]+)>/);
  if (!match) {
    throw new Error('github_api_invalid_link_header');
  }

  let url;
  try {
    url = new URL(match[1]);
  } catch {
    throw new Error('github_api_pagination_invalid_next_url');
  }

  const apiBase = new URL(githubApiUrl);
  if (url.username || url.password || url.hash) {
    throw new Error('github_api_pagination_invalid_next_url');
  }
  if (url.origin !== apiBase.origin) {
    throw new Error('github_api_pagination_external_host');
  }
  if (expectedPathname && url.pathname !== expectedPathname) {
    throw new Error('github_api_pagination_invalid_next_url');
  }

  return `${url.pathname}${url.search}`;
}

function getPullRequestDetail({ fetchImpl = fetch, githubApiUrl, githubToken, number, repository }) {
  return githubRequest({
    fetchImpl,
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/pulls/${number}`
  });
}

function assertPullRequestBaseSnapshot(detail, { baseBranch, repository, targetBaseSha }) {
  const snapshot = toPullRequestSnapshot(detail);

  if (!snapshot.baseSha || snapshot.baseSha !== targetBaseSha) {
    throw new Error('pull_request_base_changed_during_scan');
  }
  if (snapshot.baseRef !== baseBranch || snapshot.baseRepository !== repository) {
    throw new Error('pull_request_base_changed_during_scan');
  }
}

function assertPullRequestSnapshotStable(previous, current) {
  if (previous.headSha !== current.headSha || previous.headRef !== current.headRef || previous.headRepository !== current.headRepository) {
    throw new Error('pull_request_head_changed_during_scan');
  }
  if (previous.baseSha !== current.baseSha || previous.baseRef !== current.baseRef || previous.baseRepository !== current.baseRepository) {
    throw new Error('pull_request_base_changed_during_scan');
  }
}

function toPullRequestSnapshot(pullRequest = {}) {
  return {
    baseRef: cleanString(pullRequest.base?.ref),
    baseRepository: cleanRepository(pullRequest.base?.repo?.full_name),
    baseSha: cleanSha(pullRequest.base?.sha),
    headRef: cleanString(pullRequest.head?.ref),
    headRepository: cleanRepository(pullRequest.head?.repo?.full_name),
    headSha: cleanSha(pullRequest.head?.sha)
  };
}

function readBaseBranch({ defaultBranch, eventPayload, normalizedEvent }) {
  if (normalizedEvent.event_name === 'pull_request') {
    return eventPayload?.pull_request?.base?.ref || defaultBranch;
  }
  if (normalizedEvent.event_name === 'workflow_dispatch') {
    return eventPayload?.inputs?.base_branch || defaultBranch;
  }
  return defaultBranch;
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

function writeOutputs(outputs) {
  const outputFile = process.env.GITHUB_OUTPUT;
  const lines = MAIN_FOLLOW_UP_OUTPUT_NAMES.map((name) => `${name}=${outputs[name] ?? ''}`);

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
  const reason = outputs.eligible === 'true'
    ? `plans=${outputs.scanned_pull_request_count} update=${outputs.update_candidate_count} codex=${outputs.codex_follow_up_candidate_count} manual=${outputs.manual_review_count}`
    : outputs.skip_reason;

  console.log(`main-follow-up-plan ${action}: repository=${outputs.repository || '(none)'} base=${outputs.default_branch || '(none)'} trigger=${outputs.trigger_type || '(none)'} dry_run=${outputs.dry_run} reason=${reason || '(none)'}`);
}

function pathnameFor(githubApiUrl, path) {
  return new URL(`${githubApiUrl}${normalizeApiPath(path)}`).pathname;
}

function normalizeApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('github_api_pagination_invalid_next_url');
  }
  return path;
}

function encodeGitRef(ref) {
  return cleanString(ref)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function cleanRepository(value) {
  const text = cleanString(value);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : '';
}

function cleanSha(value) {
  const text = cleanString(value);
  return /^[a-f0-9]{40}$/i.test(text) ? text : '';
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`main-follow-up-plan failed: ${error.message}`);
    process.exitCode = 1;
  });
}
