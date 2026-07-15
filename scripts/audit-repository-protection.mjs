#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import {
  DEFAULT_PROTECTION_POLICY,
  PROTECTION_AUDIT_REPORT_VERSION,
  auditRepositoryProtection,
  formatProtectionAuditResult
} from '../packages/chatgpt-automation-core/src/protection-audit/index.js';

const USER_AGENT = 'codex-workflow-kit-protection-audit';
const DEFAULT_POLICY_FILE = 'release/protection-policy.example.yml';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const PROTECTION_POLICY_SCHEMA_FILE = new URL('../schemas/protection-policy.schema.json', import.meta.url);
const TOKEN_SOURCES = new Set(['github-token', 'external-read-token']);

const USAGE = `Usage:
  node scripts/audit-repository-protection.mjs --repository <owner/repo> [options]

Options:
  --repository <owner/repo>  Repository to audit.
  --policy <path>           Expected policy YAML. Defaults to ${DEFAULT_POLICY_FILE}.
  --github-api-url <url>    GitHub API URL. Defaults to ${DEFAULT_GITHUB_API_URL}.
  --max-pages <number>      Pagination page limit. Defaults to 10.
  --token-source <source>   github-token or external-read-token. Defaults to github-token.
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

  let policy;
  try {
    policy = await readPolicyFile(parsed.policy, deps.readFile ?? readFile);
  } catch (error) {
    const result = createPolicyFailureResult({
      error,
      repository: parsed.repository
    });
    if (parsed.json) {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout(formatProtectionAuditResult(result));
    }
    return 1;
  }

  try {
    const token = deps.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
    const { result } = await fetchRepositoryProtectionAudit({
      fetchImpl: deps.fetchImpl ?? fetch,
      githubApiUrl: parsed.githubApiUrl,
      githubToken: token,
      maxPages: parsed.maxPages,
      policy,
      repository: parsed.repository,
      tokenSource: parsed.tokenSource
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
  repository,
  tokenSource = 'github-token'
}) {
  const apiErrors = [];
  const pagination = {
    rulesetsComplete: true,
    rulesetsEndComplete: true,
    rulesetsStartComplete: true
  };
  const baseUrl = validateGitHubApiUrl(githubApiUrl);
  const normalizedRepository = normalizeRepositoryName(repository);
  const normalizedTokenSource = normalizeTokenSource(tokenSource);

  if (!normalizedRepository) {
    const result = auditRepositoryProtection({
      apiErrors: [{ code: 'protection_api_failed', message: 'Repository must be owner/repo.', path: 'repository' }],
      expectedPolicy: policy,
      repository: { full_name: '' },
      tokenSource: normalizedTokenSource
    });
    return { result };
  }

  if (!githubToken) {
    const result = auditRepositoryProtection({
      apiErrors: [{ code: 'protection_api_failed', message: 'GitHub token for read-only API access is unavailable.', path: 'githubToken' }],
      expectedPolicy: policy,
      repository: { full_name: normalizedRepository },
      tokenSource: normalizedTokenSource
    });
    return { result };
  }

  if (!baseUrl.ok) {
    const result = auditRepositoryProtection({
      apiErrors: [{ code: 'protection_api_failed', message: baseUrl.message, path: 'githubApiUrl' }],
      expectedPolicy: policy,
      repository: { full_name: normalizedRepository },
      tokenSource: normalizedTokenSource
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
  let endRulesets = [];
  let endRulesetDetails = [];
  let endSnapshot = {};

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
      pagination.rulesetsStartComplete = list.complete;
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
      endRulesets = finalRulesets.items;
      pagination.rulesetsEndComplete = finalRulesets.complete;
      for (const ruleset of endRulesets) {
        const id = ruleset.id;
        if (id === undefined || id === null) {
          continue;
        }
        try {
          endRulesetDetails.push(await githubGet(client, `/repos/${normalizedRepository}/rulesets/${encodeURIComponent(id)}`));
        } catch (error) {
          apiErrors.push(toApiIssue(error, 'rulesets.end'));
        }
      }
      endSnapshot = {
        defaultBranch: finalRepository.default_branch,
        defaultBranchSha: finalBranch?.commit?.sha
      };
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
    endRulesetDetails,
    endRulesets,
    mergeSettings: repositoryMetadata,
    pagination,
    repository: repositoryMetadata,
    rulesetDetails,
    rulesets,
    startSnapshot,
    tokenSource: normalizedTokenSource,
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
    repository: '',
    tokenSource: 'github-token'
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

    if (['--repository', '--policy', '--github-api-url', '--max-pages', '--token-source'].includes(arg)) {
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
      } else if (arg === '--token-source') {
        if (!TOKEN_SOURCES.has(value)) {
          return { ok: false, message: '--token-source must be github-token or external-read-token.' };
        }
        options.tokenSource = value;
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
  let source;
  try {
    source = await readFileImpl(path, 'utf8');
  } catch {
    throw policyError('protection_policy_parse_failed', 'Protection policy could not be read.', ['policy']);
  }

  let parsed;
  try {
    parsed = YAML.parse(source);
  } catch {
    throw policyError('protection_policy_parse_failed', 'Protection policy YAML could not be parsed.', ['policy']);
  }

  if (!isPlainObject(parsed)) {
    throw policyError('protection_policy_validation_failed', 'Protection policy root must be an object.', ['policy']);
  }

  const schema = JSON.parse(await readFileImpl(PROTECTION_POLICY_SCHEMA_FILE, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(parsed)) {
    throw policyError(
      'protection_policy_validation_failed',
      'Protection policy schema validation failed.',
      sanitizeAjvErrors(validate.errors)
    );
  }

  return parsed;
}

function createPolicyFailureResult({ error, repository }) {
  const blockers = (Array.isArray(error?.issues) && error.issues.length > 0
    ? error.issues
    : [{
        code: 'protection_policy_validation_failed',
        manualReviewRequired: true,
        message: 'Protection policy validation failed.',
        path: 'policy'
      }])
    .map((issue) => ({
      code: cleanString(issue.code) || 'protection_policy_validation_failed',
      manualReviewRequired: true,
      message: cleanString(issue.message) || 'Protection policy validation failed.',
      path: cleanString(issue.path) || 'policy'
    }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.path.localeCompare(b.path));

  return {
    auditedSha: '',
    blockers,
    bypassSummary: [],
    bypassVisibility: [],
    defaultBranch: '',
    effectiveProtections: {
      activeRulesetCount: 0,
      branchProtectionPresent: false,
      deletionBlocked: false,
      dismissStaleApprovals: false,
      enforceAdmins: false,
      forcePushBlocked: false,
      minimumApprovals: 0,
      pullRequestRequired: false,
      requireCodeOwnerReview: false,
      requireConversationResolution: false,
      requireLastPushApproval: false,
      requireLinearHistory: false,
      requireSignedCommits: false,
      strictStatusChecks: false
    },
    manualReviewRequired: true,
    mergeSettings: {
      autoMergeAllowed: false,
      branchAutoDelete: false,
      mergeCommitAllowed: false,
      mergeQueueEnabled: false,
      rebaseMergeAllowed: false,
      squashMergeAllowed: false
    },
    ok: false,
    ready: false,
    reasonCodes: [...new Set(blockers.map((issue) => issue.code))].sort(),
    reportVersion: PROTECTION_AUDIT_REPORT_VERSION,
    repository: normalizeRepositoryName(repository),
    requiredChecks: [],
    requiredReviews: {
      dismissStaleApprovals: false,
      minimumApprovals: 0,
      pullRequestRequired: false,
      requireCodeOwnerReview: false,
      requireConversationResolution: false,
      requireLastPushApproval: false
    },
    warnings: []
  };
}

function policyError(code, message, paths) {
  const error = new Error(code);
  error.code = code;
  error.issues = (Array.isArray(paths) && paths.length > 0 ? paths : ['policy'])
    .map((path) => ({
      code,
      manualReviewRequired: true,
      message,
      path: sanitizePolicyPath(path)
    }));
  return error;
}

function sanitizeAjvErrors(errors = []) {
  return (Array.isArray(errors) ? errors : [])
    .map((error) => {
      const base = jsonPointerToPolicyPath(error.instancePath);
      if (error.keyword === 'required' && typeof error.params?.missingProperty === 'string') {
        return `${base}.${sanitizePathSegment(error.params.missingProperty)}`;
      }
      if (error.keyword === 'additionalProperties' && typeof error.params?.additionalProperty === 'string') {
        return `${base}.${sanitizePathSegment(error.params.additionalProperty)}`;
      }
      return base;
    })
    .map(sanitizePolicyPath)
    .filter(Boolean)
    .sort();
}

function jsonPointerToPolicyPath(pointer) {
  const text = cleanString(pointer);
  if (!text || text === '/') {
    return 'policy';
  }
  const segments = text
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map(sanitizePathSegment);
  return ['policy', ...segments].filter(Boolean).join('.');
}

function sanitizePolicyPath(path) {
  const text = cleanString(path).replaceAll('[', '.').replaceAll(']', '');
  const parts = text
    .split('.')
    .map(sanitizePathSegment)
    .filter(Boolean);
  return parts.length > 0 ? parts.join('.') : 'policy';
}

function sanitizePathSegment(value) {
  const text = cleanString(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : 'field';
}

function normalizeTokenSource(value) {
  const tokenSource = cleanString(value);
  return TOKEN_SOURCES.has(tokenSource) ? tokenSource : 'github-token';
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

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
