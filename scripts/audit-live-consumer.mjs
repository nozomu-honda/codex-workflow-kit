#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import {
  DEFAULT_LIVE_CONSUMER_CONFIG_PATH,
  DEFAULT_KIT_REPOSITORY,
  LIVE_CONSUMER_WORKFLOW_SPECS,
  auditLiveConsumerInstallation,
  formatLiveConsumerAuditReport,
  validateLiveConsumerInventoryObject
} from '../packages/chatgpt-automation-core/src/consumer-audit/index.js';

const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_PAGES = 50;

const USAGE = `Usage:
  node scripts/audit-live-consumer.mjs --repository <owner/repo> --expected-kit-sha <sha> [options]
  node scripts/audit-live-consumer.mjs --inventory <path> --repository <owner/repo> [options]

Options:
  --repository <owner/repo>     Consumer repository to audit.
  --default-branch <name>       Expected default branch. Defaults to inventory or repository metadata.
  --kit-repository <owner/repo> Shared kit repository. Defaults to ${DEFAULT_KIT_REPOSITORY}.
  --expected-kit-sha <sha>      Expected reviewed 40-character kit commit SHA.
  --config <path>               Config path. Defaults to ${DEFAULT_LIVE_CONSUMER_CONFIG_PATH}.
  --workflow <path>             Caller workflow path. Can be repeated.
  --capability <name>           Desired capability. Can be repeated.
  --inventory <path>            Consumer audit inventory YAML.
  --github-api-url <url>        GitHub API URL. Defaults to ${DEFAULT_GITHUB_API_URL}.
  --allow-token-host <host>     Allow token forwarding to this GitHub API host. Repeatable.
  --dry-run                     Required read-only mode. Default.
  --json                        Emit deterministic JSON.
  --help, -h                    Show this help.

Environment:
  GITHUB_TOKEN or GH_TOKEN may be used for read-only REST API requests.

The live audit uses GET requests only. It does not write, dispatch workflows, read secrets,
create branches, create issues, create PRs, comment, label, deploy, tag, or release.
`;

export async function runAuditLiveConsumerCli(argv = process.argv.slice(2), io = defaultIo(), dependencies = {}) {
  const parsed = parseArgs(argv);
  const stdout = io.stdout ?? ((message) => process.stdout.write(message));
  const stderr = io.stderr ?? ((message) => process.stderr.write(message));

  if (parsed.help) {
    stdout(USAGE);
    return 0;
  }

  if (!parsed.ok) {
    stderr(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  try {
    const consumer = await resolveConsumerInventory(parsed);
    const token = dependencies.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
    const checkedAt = dependencies.now ?? new Date().toISOString();
    const snapshot = await collectLiveConsumerSnapshot({
      apiUrl: parsed.githubApiUrl,
      allowedTokenHosts: parsed.allowedTokenHosts,
      consumer,
      fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
      token
    });
    const report = auditLiveConsumerInstallation({
      checkedAt,
      consumer,
      snapshot,
      kitRepository: parsed.kitRepository
    });

    if (parsed.json) {
      stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      stdout(formatLiveConsumerAuditReport(report));
    }

    return report.ok ? 0 : 1;
  } catch {
    stderr('Live consumer audit failed without exposing stack trace.\n');
    return 1;
  }
}

export function parseArgs(argv) {
  const result = {
    ok: true,
    repository: undefined,
    defaultBranch: undefined,
    kitRepository: DEFAULT_KIT_REPOSITORY,
    expectedKitSha: undefined,
    configPath: DEFAULT_LIVE_CONSUMER_CONFIG_PATH,
    callerWorkflowPaths: [],
    desiredCapabilitySet: [],
    inventoryPath: undefined,
    githubApiUrl: DEFAULT_GITHUB_API_URL,
    allowedTokenHosts: [],
    dryRun: true,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      return result;
    }
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg === '--no-dry-run') {
      return { ok: false, error: '--no-dry-run is not supported; live consumer audit is read-only dry-run only.' };
    }
    if ([
      '--repository',
      '--default-branch',
      '--kit-repository',
      '--expected-kit-sha',
      '--config',
      '--workflow',
      '--capability',
      '--inventory',
      '--github-api-url',
      '--allow-token-host'
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, error: `${arg} requires a value.` };
      }
      index += 1;
      if (arg === '--repository') {
        result.repository = value;
      } else if (arg === '--default-branch') {
        result.defaultBranch = value;
      } else if (arg === '--kit-repository') {
        result.kitRepository = value;
      } else if (arg === '--expected-kit-sha') {
        result.expectedKitSha = value;
      } else if (arg === '--config') {
        result.configPath = value;
      } else if (arg === '--workflow') {
        result.callerWorkflowPaths.push(value);
      } else if (arg === '--capability') {
        result.desiredCapabilitySet.push(value);
      } else if (arg === '--inventory') {
        result.inventoryPath = value;
      } else if (arg === '--github-api-url') {
        result.githubApiUrl = value;
      } else if (arg === '--allow-token-host') {
        result.allowedTokenHosts.push(value);
      }
      continue;
    }
    return { ok: false, error: `Unknown option: ${arg}` };
  }

  if (!result.inventoryPath && (!result.repository || !result.expectedKitSha)) {
    return {
      ok: false,
      error: '--repository and --expected-kit-sha are required when --inventory is not provided.'
    };
  }

  return result;
}

export async function collectLiveConsumerSnapshot(options) {
  const api = createGitHubApiClient({
    apiUrl: options.apiUrl ?? DEFAULT_GITHUB_API_URL,
    allowedTokenHosts: options.allowedTokenHosts,
    fetchImpl: options.fetchImpl,
    token: options.token
  });
  const repository = options.consumer.repository;
  const files = {};
  const apiErrors = [];
  let paginationIncomplete = false;

  try {
    const metadata = await api.get(`/repos/${repository}`);
    const defaultBranch = options.consumer.defaultBranch || metadata.default_branch || '';
    const start = await getDefaultBranchSha(api, repository, defaultBranch);
    const tree = await api.get(`/repos/${repository}/git/trees/${start}?recursive=1`);
    if (tree.truncated === true) {
      paginationIncomplete = true;
      apiErrors.push({ code: 'pagination_incomplete', path: '/git/trees' });
    }

    const pathsToFetch = new Set([
      options.consumer.configPath,
      ...options.consumer.callerWorkflowPaths
    ]);

    for (const path of [...pathsToFetch].sort()) {
      files[path] = await fetchRepositoryFile(api, repository, path, start, tree.tree ?? []);
    }

    let workflowMetadata = [];
    try {
      workflowMetadata = await api.list(`/repos/${repository}/actions/workflows?per_page=100`);
    } catch (error) {
      const code = normalizeApiErrorCode(error);
      if (isPaginationCode(code)) {
        paginationIncomplete = true;
      }
      apiErrors.push({ code, path: '/actions/workflows' });
    }

    const end = await getDefaultBranchSha(api, repository, defaultBranch);
    return {
      repository,
      defaultBranch,
      defaultBranchStartSha: start,
      defaultBranchEndSha: end,
      files,
      workflowMetadata: sanitizeWorkflowMetadata(workflowMetadata),
      apiErrors,
      paginationIncomplete
    };
  } catch (error) {
    const code = normalizeApiErrorCode(error);
    if (isPaginationCode(code)) {
      paginationIncomplete = true;
    }
    apiErrors.push({ code, path: error?.path ?? 'repository' });
    return {
      repository,
      defaultBranch: options.consumer.defaultBranch ?? '',
      defaultBranchStartSha: '',
      defaultBranchEndSha: '',
      files,
      apiErrors,
      paginationIncomplete
    };
  }
}

export function createGitHubApiClient(options = {}) {
  const apiUrl = normalizeApiUrl(options.apiUrl ?? DEFAULT_GITHUB_API_URL);
  const fetchImpl = options.fetchImpl;
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const allowedTokenHosts = new Set([
    'api.github.com',
    ...(Array.isArray(options.allowedTokenHosts) ? options.allowedTokenHosts : [])
  ].map(normalizeTokenHost).filter(Boolean));
  const requestToken = token && allowedTokenHosts.has(apiUrl.hostname) ? token : '';

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required');
  }

  async function get(path) {
    const response = await githubRequest({
      apiUrl,
      fetchImpl,
      path,
      token: requestToken
    });
    return response.json;
  }

  async function list(path) {
    return githubRequestWithPagination({
      apiUrl,
      fetchImpl,
      path,
      token: requestToken
    });
  }

  return { get, list, apiUrl };
}

export async function githubRequestWithPagination(options) {
  const results = [];
  const visited = new Set();
  let path = options.path;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (visited.has(path)) {
      throw new GitHubApiError('GitHub API pagination cycle detected.', {
        status: 0,
        method: 'GET',
        path,
        code: 'pagination_cycle'
      });
    }
    visited.add(path);
    const response = await githubRequest({ ...options, path });
    const payload = response.json;
    const pageItems = Array.isArray(payload) ? payload : payload?.workflows;
    if (!Array.isArray(pageItems)) {
      throw new GitHubApiError('GitHub API pagination response must be an array.', {
        status: 0,
        method: 'GET',
        path,
        code: 'pagination_invalid_response'
      });
    }
    results.push(...pageItems);

    const nextPath = getNextPath(response.headers.get('link'), options.apiUrl);
    if (!nextPath) {
      return results;
    }
    path = nextPath;
  }

  throw new GitHubApiError('GitHub API pagination page limit exceeded.', {
    status: 0,
    method: 'GET',
    path,
    code: 'pagination_page_limit_exceeded'
  });
}

export function getNextPath(linkHeader, apiUrl = DEFAULT_GITHUB_API_URL) {
  if (!linkHeader) {
    return '';
  }
  const segments = linkHeader.split(',').map((segment) => segment.trim());
  const nextSegment = segments.find((segment) => /;\s*rel="?next"?/.test(segment));
  if (!nextSegment) {
    return '';
  }
  const match = nextSegment.match(/^<([^>]+)>/);
  if (!match) {
    throw new GitHubApiError('GitHub API Link header next URL is invalid.', {
      status: 0,
      method: 'GET',
      path: '',
      code: 'invalid_link_header'
    });
  }
  let url;
  try {
    url = new URL(match[1]);
  } catch {
    throw new GitHubApiError('GitHub API Link header next URL is malformed.', {
      status: 0,
      method: 'GET',
      path: '',
      code: 'pagination_invalid_next_url'
    });
  }

  const expected = normalizeApiUrl(apiUrl);
  if (url.origin !== expected.origin) {
    throw new GitHubApiError('GitHub API pagination next URL host is not allowed.', {
      status: 0,
      method: 'GET',
      path: url.pathname,
      code: 'pagination_external_host'
    });
  }
  if (url.hash || url.username || url.password) {
    throw new GitHubApiError('GitHub API pagination next URL is unsafe.', {
      status: 0,
      method: 'GET',
      path: url.pathname,
      code: 'pagination_invalid_next_url'
    });
  }
  return `${relativeApiPath(url, expected)}${url.search}`;
}

async function githubRequest(options) {
  const apiUrl = normalizeApiUrl(options.apiUrl);
  const url = buildApiUrl(apiUrl, options.path);
  if (url.origin !== apiUrl.origin) {
    throw new GitHubApiError('GitHub API host is not allowed.', {
      status: 0,
      method: 'GET',
      path: options.path,
      code: 'api_external_host'
    });
  }

  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'codex-workflow-kit-live-consumer-audit'
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const response = await options.fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'error'
  });
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new GitHubApiError('GitHub API response is too large.', {
      status: response.status,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      code: 'response_size_limit_exceeded'
    });
  }
  if (!response.ok) {
    throw new GitHubApiError(`GitHub API ${response.status}`, {
      status: response.status,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      code: statusCode(response.status)
    });
  }
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new GitHubApiError('GitHub API response JSON parse failed.', {
      status: response.status,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      code: 'api_read_failed'
    });
  }
  return {
    json,
    headers: response.headers
  };
}

export class GitHubApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = details.status;
    this.method = details.method;
    this.path = details.path;
    this.code = details.code;
  }
}

async function resolveConsumerInventory(parsed) {
  if (parsed.inventoryPath) {
    const source = await readFile(parsed.inventoryPath, 'utf8');
    const document = YAML.parseDocument(source, { prettyErrors: false });
    if (document.errors.length > 0) {
      throw new Error('Inventory YAML parse failed.');
    }
    const validation = validateLiveConsumerInventoryObject(document.toJS());
    if (!validation.ok) {
      throw new Error('Inventory validation failed.');
    }
    const selected = parsed.repository
      ? validation.consumers.find((entry) => entry.repository === parsed.repository)
      : validation.consumers[0];
    if (!selected) {
      throw new Error('Inventory consumer not found.');
    }
    return {
      ...selected,
      ...(parsed.defaultBranch ? { defaultBranch: parsed.defaultBranch } : {}),
      ...(parsed.expectedKitSha ? { expectedKitRef: parsed.expectedKitSha } : {})
    };
  }

  return {
    repository: parsed.repository,
    defaultBranch: parsed.defaultBranch ?? '',
    configPath: parsed.configPath,
    callerWorkflowPaths: parsed.callerWorkflowPaths.length > 0
      ? parsed.callerWorkflowPaths
      : Object.values(LIVE_CONSUMER_WORKFLOW_SPECS).map((spec) => spec.path),
    expectedKitRef: parsed.expectedKitSha,
    desiredCapabilitySet: parsed.desiredCapabilitySet.length > 0
      ? parsed.desiredCapabilitySet
      : Object.keys(LIVE_CONSUMER_WORKFLOW_SPECS),
    manualReviewRequired: false
  };
}

async function getDefaultBranchSha(api, repository, defaultBranch) {
  const ref = await api.get(`/repos/${repository}/git/ref/heads/${encodePath(defaultBranch)}`);
  return String(ref?.object?.sha ?? '').toLowerCase();
}

async function fetchRepositoryFile(api, repository, path, ref, tree) {
  const entry = tree.find((item) => item.path === path);
  if (entry?.type === 'commit' || entry?.mode === '160000') {
    return { status: 'submodule', content: '', sha: entry.sha ?? '', size: 0 };
  }
  if (entry?.mode === '120000') {
    return { status: 'symlink', content: '', sha: entry.sha ?? '', size: 0 };
  }
  if (entry && entry.type !== 'blob') {
    return { status: 'binary', content: '', sha: entry.sha ?? '', size: entry.size ?? 0 };
  }

  try {
    const file = await api.get(`/repos/${repository}/contents/${encodePath(path)}?ref=${ref}`);
    if (file.type !== 'file') {
      return { status: file.type === 'submodule' ? 'submodule' : 'binary', content: '', sha: file.sha ?? '', size: file.size ?? 0 };
    }
    if (Number(file.size ?? 0) > MAX_FILE_BYTES) {
      return { status: 'too_large', content: '', sha: file.sha ?? '', size: file.size ?? 0 };
    }
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      return { status: 'binary', content: '', sha: file.sha ?? '', size: file.size ?? 0 };
    }
    return {
      status: 'ok',
      content: Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'),
      sha: file.sha ?? '',
      size: file.size ?? 0
    };
  } catch (error) {
    if (error?.status === 404) {
      return { status: 'missing', content: '', sha: '', size: 0 };
    }
    return { status: 'read_failed', content: '', sha: '', size: 0 };
  }
}

function sanitizeWorkflowMetadata(workflows) {
  return workflows
    .map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state
    }))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

function normalizeApiErrorCode(error) {
  if (error?.code) {
    if (String(error.code).startsWith('pagination_')) {
      return error.code;
    }
    if (error.code === 'invalid_link_header') {
      return 'pagination_incomplete';
    }
    return error.code;
  }
  return statusCode(error?.status);
}

function isPaginationCode(code) {
  const normalized = String(code ?? '');
  return normalized === 'pagination_incomplete'
    || normalized === 'invalid_link_header'
    || normalized.startsWith('pagination_');
}

function statusCode(status) {
  if (status === 403) {
    return 'api_permission_denied';
  }
  if (status === 404) {
    return 'api_not_found';
  }
  if (status === 429) {
    return 'api_rate_limited';
  }
  return 'api_read_failed';
}

function normalizeApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubApiError('GitHub API URL is malformed.', {
      status: 0,
      method: 'GET',
      path: '',
      code: 'api_url_invalid'
    });
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new GitHubApiError('GitHub API URL is unsafe.', {
      status: 0,
      method: 'GET',
      path: '',
      code: 'api_url_invalid'
    });
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url;
}

function buildApiUrl(apiUrl, path) {
  const relativePath = String(path ?? '').replace(/^\/+/, '');
  const url = new URL(relativePath, apiUrl);
  if (url.origin !== apiUrl.origin || !isWithinApiBasePath(url, apiUrl)) {
    throw new GitHubApiError('GitHub API path is outside the configured base URL.', {
      status: 0,
      method: 'GET',
      path: sanitizePathForError(path),
      code: 'api_base_path_escape'
    });
  }
  return url;
}

function relativeApiPath(url, apiUrl) {
  if (!isWithinApiBasePath(url, apiUrl)) {
    throw new GitHubApiError('GitHub API pagination next URL leaves the configured base path.', {
      status: 0,
      method: 'GET',
      path: url.pathname,
      code: 'pagination_base_path_escape'
    });
  }
  if (apiUrl.pathname === '/') {
    return url.pathname;
  }
  return `/${url.pathname.slice(apiUrl.pathname.length)}`;
}

function isWithinApiBasePath(url, apiUrl) {
  return apiUrl.pathname === '/' || url.pathname.startsWith(apiUrl.pathname);
}

function normalizeTokenHost(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sanitizePathForError(path) {
  return String(path ?? '').replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//<redacted>@');
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function defaultIo() {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAuditLiveConsumerCli();
}
