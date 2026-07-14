#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import {
  DEFAULT_PROTECTION_POLICY,
  auditRepositoryProtection,
  formatProtectionAuditResult
} from '../packages/chatgpt-automation-core/src/protection-audit/index.js';

const USER_AGENT = 'codex-workflow-kit-protection-audit';
const DEFAULT_POLICY_FILE = 'release/protection-policy.example.yml';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

const USAGE = `Usage:
  node scripts/audit-repository-protection.mjs --repository <owner/repo> [options]

Options:
  --repository <owner/repo>  Repository to audit.
  --policy <path>           Expected policy YAML. Defaults to ${DEFAULT_POLICY_FILE}.
  --github-api-url <url>    GitHub API URL. Defaults to ${DEFAULT_GITHUB_API_URL}.
  --max-pages <number>      Pagination page limit. Defaults to 10.
  --json                    Print stable sanitized JSON.
  --help, -h                Show this help.

Environment:
  GITHUB_TOKEN or GH_TOKEN is used for GitHub API read. Token values are never printed.

The audit uses GET requests only, does not follow redirects, does not call write APIs,
does not modify Branch protection, Rulesets, checks, labels, comments, Secrets, releases, or deployments.
`;

export async function runAuditRepositoryProtectionCli(argv = process.argv.slice(2), io = defaultIo(), deps = {}) {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    io.stderr(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }

  try {
    const policy = await readPolicyFile(parsed.policy, deps.readFile ?? readFile);
    const token = deps.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
    const { result } = await fetchRepositoryProtectionAudit({
      fetchImpl: deps.fetchImpl ?? fetch,
      githubApiUrl: parsed.githubApiUrl,
      githubToken: token,
      maxPages: parsed.maxPages,
      policy,
      repository: parsed.repository
    });

    if (parsed.json) {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout(formatProtectionAuditResult(result));
    }

    return result.ready ? 0 : 1;
  } catch {
    io.stderr('Repository protection audit failed unexpectedly without exposing stack trace.\n');
    return 1;
  }
}

export async function fetchRepositoryProtectionAudit({
  fetchImpl = fetch,
  githubApiUrl = DEFAULT_GITHUB_API_URL,
  githubToken = '',
  maxPages = 10,
  policy = DEFAULT_PROTECTION_POLICY,
  repository
}) {
  const apiErrors = [];
  const pagination = { rulesetsComplete: true };
  const baseUrl = validateGitHubApiUrl(githubApiUrl);
  const normalizedRepository = normalizeRepositoryName(repository);

  if (!normalizedRepository) {
    const result = auditRepositoryProtection({
      apiErrors: [{ code: 'protection_api_failed', message: 'Repository must be owner/repo.', path: 'repository' }],
      expectedPolicy: policy,
      repository: { full_name: '' }
    });
    return { result };
  }

  if (!githubToken) {
    const result = auditRepositoryProtection({
      apiErrors: [{ code: 'protection_api_failed', message: 'GitHub token for read-only API access is unavailable.', path: 'githubToken' }],
      expectedPolicy: policy,
      repository: { full_name: normalizedRepository }
    });
    return { result };
  }

  if (!baseUrl.ok) {
    const result = auditRepositoryProtection({
      apiErrors: [{ code: 'protection_api_failed', message: baseUrl.message, path: 'githubApiUrl' }],
      expectedPolicy: policy,
      repository: { full_name: normalizedRepository }
    });
    return { result };
  }

  const client = {
    baseUrl: baseUrl.value,
    fetchImpl,
    githubToken,
    maxPages
  };
  const startSnapshot = {};
  let repositoryMetadata = { full_name: normalizedRepository };
  let branch = {};
  let branchProtection = null;
  let endBranchProtection = null;
  let endBranchProtectionRead = false;
  let rulesets = [];
  let rulesetDetails = [];
  let endSnapshot = {};
  let rulesetsChangedDuringAudit = false;

  try {
    repositoryMetadata = await githubGet(client, `/repos/${normalizedRepository}`);
    startSnapshot.defaultBranch = repositoryMetadata.default_branch;
    branch = await githubGet(client, `/repos/${normalizedRepository}/branches/${encodeURIComponent(repositoryMetadata.default_branch)}`);
    startSnapshot.defaultBranchSha = branch?.commit?.sha;
  } catch (error) {
    apiErrors.push(toApiIssue(error, 'repository'));
  }

  if (apiErrors.length === 0) {
    try {
      branchProtection = await githubGet(client, `/repos/${normalizedRepository}/branches/${encodeURIComponent(repositoryMetadata.default_branch)}/protection`, {
        allowNotFound: true
      });
    } catch (error) {
      apiErrors.push(toApiIssue(error, 'branchProtection'));
    }

    try {
      const list = await githubList(client, `/repos/${normalizedRepository}/rulesets?targets=branch&per_page=100`);
      rulesets = list.items;
      pagination.rulesetsComplete = list.complete;
    } catch (error) {
      apiErrors.push(toApiIssue(error, 'rulesets'));
    }

    for (const ruleset of rulesets) {
      const id = ruleset.id;
      if (id === undefined || id === null) {
        continue;
      }
      try {
        rulesetDetails.push(await githubGet(client, `/repos/${normalizedRepository}/rulesets/${encodeURIComponent(id)}`));
      } catch (error) {
        apiErrors.push(toApiIssue(error, 'rulesets'));
      }
    }

    try {
      const finalRepository = await githubGet(client, `/repos/${normalizedRepository}`);
      const finalBranch = await githubGet(client, `/repos/${normalizedRepository}/branches/${encodeURIComponent(finalRepository.default_branch)}`);
      endBranchProtection = await githubGet(client, `/repos/${normalizedRepository}/branches/${encodeURIComponent(finalRepository.default_branch)}/protection`, {
        allowNotFound: true
      });
      endBranchProtectionRead = true;
      const finalRulesets = await githubList(client, `/repos/${normalizedRepository}/rulesets?targets=branch&per_page=100`);
      endSnapshot = {
        defaultBranch: finalRepository.default_branch,
        defaultBranchSha: finalBranch?.commit?.sha
      };
      rulesetsChangedDuringAudit = rulesetFingerprint(rulesets) !== rulesetFingerprint(finalRulesets.items);
    } catch (error) {
      apiErrors.push(toApiIssue(error, 'tocTou'));
    }
  }

  const result = auditRepositoryProtection({
    apiErrors,
    branch,
    branchProtection,
    defaultBranch: repositoryMetadata.default_branch,
    defaultBranchSha: branch?.commit?.sha,
    endSnapshot,
    expectedPolicy: policy,
    mergeSettings: repositoryMetadata,
    pagination,
    repository: repositoryMetadata,
    rulesetDetails,
    rulesets,
    rulesetsChangedDuringAudit,
    startSnapshot,
    ...(endBranchProtectionRead ? { endBranchProtection } : {})
  });

  return { result };
}

export function parseArgs(argv) {
  const options = {
    ok: true,
    githubApiUrl: process.env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL,
    help: false,
    json: false,
    maxPages: 10,
    policy: DEFAULT_POLICY_FILE,
    repository: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (['--repository', '--policy', '--github-api-url', '--max-pages'].includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: `${arg} requires a value.` };
      }
      index += 1;
      if (arg === '--repository') {
        options.repository = value;
      } else if (arg === '--policy') {
        options.policy = value;
      } else if (arg === '--github-api-url') {
        options.githubApiUrl = value;
      } else {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 100) {
          return { ok: false, message: '--max-pages must be an integer from 1 to 100.' };
        }
        options.maxPages = number;
      }
      continue;
    }

    return { ok: false, message: `Unknown option: ${arg}` };
  }

  if (options.help) {
    return options;
  }

  if (!normalizeRepositoryName(options.repository)) {
    return { ok: false, message: '--repository must be owner/repo.' };
  }

  return options;
}

async function readPolicyFile(path, readFileImpl) {
  const source = await readFileImpl(path, 'utf8');
  const parsed = YAML.parse(source);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : DEFAULT_PROTECTION_POLICY;
}

async function githubGet(client, path, options = {}) {
  const { data } = await githubRequest(client, path, options);
  return data;
}

async function githubList(client, path) {
  const items = [];
  let nextPath = path;
  let pageCount = 0;
  const seen = new Set();

  while (nextPath) {
    pageCount += 1;
    if (pageCount > client.maxPages || seen.has(nextPath)) {
      return { complete: false, items };
    }
    seen.add(nextPath);

    const { data, next } = await githubRequest(client, nextPath);
    items.push(...(Array.isArray(data) ? data : []));
    nextPath = next;
  }

  return { complete: true, items };
}

async function githubRequest(client, path, options = {}) {
  const response = await client.fetchImpl(`${client.baseUrl}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${client.githubToken}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28'
    },
    method: 'GET',
    redirect: 'manual'
  });

  if (response.status >= 300 && response.status < 400) {
    throw apiError('github_api_redirect_forbidden', response.status);
  }

  if (options.allowNotFound && response.status === 404) {
    return { data: null, next: '' };
  }

  if (!response.ok) {
    throw apiError(`github_api_${response.status}`, response.status);
  }

  return {
    data: response.status === 204 ? null : await response.json(),
    next: getNextPath(response.headers?.get?.('link'))
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

function validateGitHubApiUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.username || url.password || url.search || url.hash) {
      return { ok: false, message: 'GitHub API URL must be https://api.github.com.' };
    }
    return { ok: true, value: url.origin };
  } catch {
    return { ok: false, message: 'GitHub API URL is invalid.' };
  }
}

function normalizeRepositoryName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : '';
}

function rulesetFingerprint(rulesets) {
  return (Array.isArray(rulesets) ? rulesets : [])
    .map((ruleset) => [
      ruleset.id ?? '',
      ruleset.name ?? '',
      ruleset.enforcement ?? '',
      ruleset.updated_at ?? ruleset.updatedAt ?? ''
    ].join(':'))
    .sort()
    .join('|');
}

function toApiIssue(error, path) {
  return {
    code: error?.code === 'github_api_403'
      ? 'protection_api_forbidden'
      : error?.code === 'github_api_404'
        ? 'protection_api_not_found'
        : 'protection_api_failed',
    message: 'GitHub repository protection API read failed.',
    path
  };
}

function apiError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function defaultIo() {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAuditRepositoryProtectionCli();
}
