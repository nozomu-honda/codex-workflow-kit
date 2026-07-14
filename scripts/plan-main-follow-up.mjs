#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createMainFollowUpPlan,
  MAIN_FOLLOW_UP_OUTPUT_NAMES
} from '../packages/chatgpt-automation-core/src/main-follow-up/index.js';

const USER_AGENT = 'codex-workflow-kit-main-follow-up-plan';

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
  let apiReadError = '';

  if (apiRead && githubToken && repository && baseBranch) {
    try {
      openPullRequests = openPullRequests.length > 0
        ? openPullRequests
        : await listOpenPullRequests({ baseBranch, githubApiUrl, githubToken, repository });
      openPullRequests = await hydratePullRequests({
        githubApiUrl,
        githubToken,
        pullRequests: openPullRequests.slice(0, Number(mainConfig.maxOpenPullRequests ?? 100) + 1),
        repository
      });
    } catch (error) {
      apiReadError = error.message || 'unknown';
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
    })
  });

  writeOutputs(plan.outputs);
  logPlan(plan.outputs);
}

async function hydratePullRequests({ githubApiUrl, githubToken, pullRequests, repository }) {
  const hydrated = [];

  for (const pullRequest of pullRequests) {
    const number = pullRequest.number;
    if (!Number.isInteger(number)) {
      continue;
    }
    const changedFiles = await listPaginated({
      githubApiUrl,
      githubToken,
      path: `/repos/${repository}/pulls/${number}/files?per_page=100`
    });
    const compare = await compareBaseWithHead({
      baseRef: pullRequest.base?.ref,
      githubApiUrl,
      githubToken,
      headSha: pullRequest.head?.sha,
      repository
    });
    const headBranchExists = await branchExists({
      githubApiUrl,
      githubToken,
      ref: pullRequest.head?.ref,
      repository
    });

    hydrated.push({
      ...pullRequest,
      changedFiles,
      compare,
      headBranchExists
    });
  }

  return hydrated;
}

async function listOpenPullRequests({ baseBranch, githubApiUrl, githubToken, repository }) {
  return listPaginated({
    githubApiUrl,
    githubToken,
    path: `/repos/${repository}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&sort=created&direction=asc&per_page=100`
  });
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

async function branchExists({ githubApiUrl, githubToken, ref, repository }) {
  if (!ref) {
    return false;
  }
  try {
    await githubRequest({
      githubApiUrl,
      githubToken,
      path: `/repos/${repository}/git/ref/heads/${encodeURI(ref)}`
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

async function listPaginated({ githubApiUrl, githubToken, path }) {
  const results = [];
  let nextPath = path;

  while (nextPath) {
    const { data, next } = await githubRequestWithHeaders({ githubApiUrl, githubToken, path: nextPath });
    if (!Array.isArray(data)) {
      throw new Error('github_api_unexpected_list_response');
    }
    results.push(...data);
    nextPath = next;
  }

  return results;
}

async function githubRequest({ githubApiUrl, githubToken, path }) {
  const { data } = await githubRequestWithHeaders({ githubApiUrl, githubToken, path });
  return data;
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`main-follow-up-plan failed: ${error.message}`);
    process.exitCode = 1;
  });
}
