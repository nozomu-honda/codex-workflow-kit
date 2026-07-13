#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createReviewRoutingPlan, REVIEW_ROUTING_OUTPUT_NAMES } from '../packages/chatgpt-automation-core/src/review-routing/index.js';
import { DEFAULT_SECRET_LIKE_PATTERNS } from '../packages/chatgpt-automation-core/src/config/index.js';

const USER_AGENT = 'codex-workflow-kit-review-routing';

async function main() {
  const normalizedEvent = readJsonEnv('NORMALIZED_EVENT_JSON', {});
  const eventPayload = readJsonEnv('EVENT_PAYLOAD_JSON', {});
  const config = readJsonEnv('REPOSITORY_CONFIG_JSON', {});
  const repository = normalizedEvent.repository || process.env.GITHUB_REPOSITORY || '';
  const pullRequestNumber = normalizedEvent.pull_request_number;
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? '';
  const githubApiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const apiRead = process.env.GITHUB_API_READ !== 'false';
  let pullRequest = readJsonEnv('PULL_REQUEST_CONTEXT_JSON', null);
  let changedFiles = readJsonEnv('CHANGED_FILES_JSON', []);
  let actorInfo = readJsonEnv('ACTOR_INFO_JSON', {});
  let apiReadError = '';

  if (apiRead && githubToken && repository && pullRequestNumber) {
    try {
      pullRequest ??= await githubRequest({ githubApiUrl, githubToken, path: `/repos/${repository}/pulls/${pullRequestNumber}` });
      changedFiles = changedFiles.length > 0
        ? changedFiles
        : await listPaginated({ githubApiUrl, githubToken, path: `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100` });
      actorInfo = Object.keys(actorInfo).length > 0
        ? actorInfo
        : await getActorPermission({ githubApiUrl, githubToken, repository, actor: normalizedEvent.actor });
    } catch (error) {
      apiReadError = error.message || 'unknown';
    }
  } else if (apiRead && pullRequestNumber && !githubToken) {
    apiReadError = 'github_token_unavailable';
  }

  const plan = createReviewRoutingPlan({
    normalizedEvent,
    eventPayload,
    config,
    pullRequest,
    changedFiles,
    actorInfo,
    existingDedupeKeys: readCsvEnv('EXISTING_DEDUPE_KEYS'),
    lastRoutedAt: process.env.LAST_ROUTED_AT || '',
    now: process.env.NOW || '',
    secretLikePatterns: config.secretLike?.hardBlockPatterns ?? DEFAULT_SECRET_LIKE_PATTERNS,
    apiReadError
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

async function getActorPermission({ githubApiUrl, githubToken, repository, actor }) {
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

async function listPaginated({ githubApiUrl, githubToken, path }) {
  const results = [];
  let nextPath = path;

  while (nextPath) {
    const { data, next } = await githubRequestWithHeaders({ githubApiUrl, githubToken, path: nextPath });
    results.push(...(Array.isArray(data) ? data : []));
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
    data: await response.json(),
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
  const lines = REVIEW_ROUTING_OUTPUT_NAMES.map((name) => `${name}=${outputs[name] ?? ''}`);

  if (outputFile) {
    appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
    return;
  }

  for (const line of lines) {
    console.log(line);
  }
}

function logPlan(outputs) {
  const action = outputs.should_route === 'true' ? 'route' : 'skip';
  const reason = outputs.should_route === 'true' ? outputs.route_reason : outputs.skip_reason;

  console.log(`review-routing ${action}: repository=${outputs.repository} pr=${outputs.pull_request_number || '(none)'} trigger=${outputs.trigger_type || '(none)'} actor=${outputs.actor || '(none)'} trust=${outputs.actor_trust} dry_run=${outputs.dry_run} reason=${reason || '(none)'}`);
}

main().catch((error) => {
  console.error(`review-routing failed: ${error.message}`);
  process.exitCode = 1;
});
