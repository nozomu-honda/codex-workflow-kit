import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  fetchRepositoryProtectionAudit,
  parseArgs,
  runAuditRepositoryProtectionCli
} from './audit-repository-protection.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const POLICY_YAML = `defaultBranch: master
requiredStatusChecks:
  - CI
  - Review evidence gate
requirePullRequest: true
minimumApprovals: 1
dismissStaleApprovals: true
requireCodeOwnerReview: false
requireLastPushApproval: true
requireConversationResolution: true
requireLinearHistory: false
requireSignedCommits: false
blockForcePush: true
blockDeletion: true
enforceAdmins: true
allowedMergeMethods:
  - squash
allowedBypassActors: []
requireReviewEvidenceGate: true
requireRuleset: false
`;
const POLICY_SCHEMA_FILE = new URL('../schemas/protection-policy.schema.json', import.meta.url);

async function readPolicyFixture(path) {
  if (String(path).includes('protection-policy.schema.json')) {
    return readFile(POLICY_SCHEMA_FILE, 'utf8');
  }
  return POLICY_YAML;
}

function readPolicyFixtureWith(source) {
  return async (path) => {
    if (String(path).includes('protection-policy.schema.json')) {
      return readFile(POLICY_SCHEMA_FILE, 'utf8');
    }
    return source;
  };
}

test('parseArgs validates repository and page limit', () => {
  assert.equal(parseArgs(['--repository', 'owner/example-repo']).ok, true);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--token-source', 'external-read-token']).ok, true);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--token-source', 'unknown']).ok, false);
  assert.equal(parseArgs(['--repository', 'owner']).ok, false);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--max-pages', '0']).ok, false);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--unknown']).ok, false);
});

test('github-token source cannot produce a complete ready audit', async () => {
  const { result } = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([]),
    githubToken: 'secret-token-value',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'github-token'
  });

  assert.equal(result.ready, false);
  assert.equal(result.reasonCodes.includes('administration_read_token_required'), true);
  assert.equal(JSON.stringify(result).includes('secret-token-value'), false);
});

test('external token still fails closed when ruleset bypass actors are not visible', async () => {
  const requests = [];
  const { result } = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch(requests),
    githubToken: 'secret-token-value',
    now: '2026-01-01T00:00:00.000Z',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const defaultRulesetVisibility = result.bypassVisibility[0];

  assert.equal(result.ready, false, JSON.stringify(result, null, 2));
  assert.equal(result.reasonCodes.includes('ruleset_bypass_visibility_unknown'), true);
  assert.equal(result.requiredChecks.some((check) => check.name === 'CI'), true);
  assert.equal(result.effectiveProtections.branchProtectionPresent, true);
  assert.equal(defaultRulesetVisibility.bypassActorsVisible, false);
  assert.equal(Object.prototype.hasOwnProperty.call(defaultRulesetVisibility, 'bypassActorCount'), false);
  assert.equal(result.apiReadOk, true);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.checkedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(requests.length > 0, true);
  assert.equal(requests.every((request) => request.method === 'GET'), true);
  assert.equal(requests.filter((request) => request.path === '/repos/owner/example-repo/branches/master/protection').length, 2);
  assert.equal(JSON.stringify(result).includes('secret-token-value'), false);
});

test('fetchRepositoryProtectionAudit is ready only when bypass actors are explicitly visible', async () => {
  const requests = [];
  const { result } = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch(requests, { includeBypassActors: true }),
    githubToken: 'secret-token-value',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const defaultRulesetVisibility = result.bypassVisibility[0];

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(defaultRulesetVisibility.bypassActorsVisible, true);
  assert.equal(defaultRulesetVisibility.bypassActorCount, 0);
  assert.equal(result.bypassSummary.length, 0);
  assert.equal(requests.length > 0, true);
  assert.equal(requests.every((request) => request.method === 'GET'), true);
  assert.equal(JSON.stringify(result).includes('secret-token-value'), false);
});

test('fetchRepositoryProtectionAudit refetches branch protection and blocks TOCTOU changes', async () => {
  const requests = [];
  const { result } = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch(requests, { changedBranchProtectionOnSecondRead: true, includeBypassActors: true }),
    githubToken: 'secret-token-value',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ready, false);
  assert.equal(result.reasonCodes.includes('protection_changed_during_audit'), true);
  assert.equal(requests.filter((request) => request.path === '/repos/owner/example-repo/branches/master/protection').length, 2);
  assert.equal(serialized.includes('secret-token-value'), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('Cookie'), false);
});

test('CLI prints stable JSON and does not expose token values', async () => {
  const output = { stderr: '', stdout: '' };
  const exitCode = await runAuditRepositoryProtectionCli([
    '--repository',
    'owner/example-repo',
    '--token-source',
    'external-read-token',
    '--json'
  ], {
    stderr: (message) => { output.stderr += message; },
    stdout: (message) => { output.stdout += message; }
  }, {
    fetchImpl: fakeFetch([], { includeBypassActors: true }),
    githubToken: 'another-secret-token',
    now: '2026-01-01T00:00:00.000Z',
    readFile: readPolicyFixture
  });
  const parsed = JSON.parse(output.stdout);

  assert.equal(exitCode, 0);
  assert.equal(parsed.ready, true);
  assert.equal(parsed.checkedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(output.stdout.includes('another-secret-token'), false);
  assert.equal(output.stderr, '');
});

test('missing token fails closed without making API requests', async () => {
  const requests = [];
  const { result } = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch(requests),
    githubToken: '',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });

  assert.equal(result.ready, false);
  assert.equal(result.reasonCodes.includes('protection_api_failed'), true);
  assert.equal(requests.length, 0);
});

test('redirects, 403, 404, and pagination loops are normalized safely', async () => {
  const redirect = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { redirectRulesets: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const forbidden = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { forbiddenRulesets: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const missingRepo = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { missingRepository: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const pagination = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { paginatedRulesets: true }),
    githubToken: 'token',
    maxPages: 1,
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });

  assert.equal(redirect.result.reasonCodes.includes('protection_api_failed'), true);
  assert.equal(forbidden.result.reasonCodes.includes('protection_api_forbidden'), true);
  assert.equal(missingRepo.result.reasonCodes.includes('protection_api_not_found'), true);
  assert.equal(pagination.result.reasonCodes.includes('ruleset_pagination_incomplete'), true);
});

test('external token context still fails closed on hidden bypass actors and final pagination issues', async () => {
  const hiddenBypass = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([]),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const endPagination = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { includeBypassActors: true, paginatedRulesetsOnSecondRead: true }),
    githubToken: 'token',
    maxPages: 1,
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const endLoop = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { includeBypassActors: true, loopRulesetsOnSecondRead: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });

  assert.equal(hiddenBypass.result.reasonCodes.includes('ruleset_bypass_visibility_unknown'), true);
  assert.equal(endPagination.result.reasonCodes.includes('ruleset_pagination_incomplete'), true);
  assert.equal(endPagination.result.blockers.some((blocker) => blocker.path === 'rulesets.end'), true);
  assert.equal(endLoop.result.reasonCodes.includes('ruleset_pagination_incomplete'), true);
  assert.equal(JSON.stringify(endLoop.result).includes('rel="next"'), false);
});

test('fetchRepositoryProtectionAudit detects final ruleset detail TOCTOU changes', async () => {
  const changedRuleset = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { changedRulesetDetailOnSecondRead: true, includeBypassActors: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });
  const hiddenBypassAtEnd = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { includeBypassActors: true, omitBypassActorsOnSecondRead: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo',
    tokenSource: 'external-read-token'
  });

  assert.equal(changedRuleset.result.reasonCodes.includes('protection_changed_during_audit'), true);
  assert.equal(hiddenBypassAtEnd.result.reasonCodes.includes('protection_changed_during_audit'), true);
});

test('CLI help and usage errors return documented exit codes', async () => {
  const help = { stderr: '', stdout: '' };
  const usage = { stderr: '', stdout: '' };

  assert.equal(await runAuditRepositoryProtectionCli(['--help'], {
    stderr: (message) => { help.stderr += message; },
    stdout: (message) => { help.stdout += message; }
  }), 0);
  assert.equal(await runAuditRepositoryProtectionCli(['--bad'], {
    stderr: (message) => { usage.stderr += message; },
    stdout: (message) => { usage.stdout += message; }
  }), 2);
  assert.match(help.stdout, /--repository/);
  assert.match(usage.stderr, /Unknown option/);
});

test('invalid policy fails closed before API requests with sanitized paths', async () => {
  const cases = [
    {
      code: 'protection_policy_parse_failed',
      name: 'YAML syntax error',
      path: 'policy',
      source: 'requiredStatusChecks: ['
    },
    {
      code: 'protection_policy_validation_failed',
      name: 'root array',
      path: 'policy',
      source: '- CI'
    },
    {
      code: 'protection_policy_validation_failed',
      name: 'empty required checks',
      path: 'policy.requiredStatusChecks',
      source: POLICY_YAML.replace('  - CI\n  - Review evidence gate', '')
    },
    {
      code: 'protection_policy_validation_failed',
      name: 'minimum approval zero',
      path: 'policy.minimumApprovals',
      source: POLICY_YAML.replace('minimumApprovals: 1', 'minimumApprovals: 0')
    },
    {
      code: 'protection_policy_validation_failed',
      name: 'missing required field',
      path: 'policy.requirePullRequest',
      source: POLICY_YAML.replace('requirePullRequest: true\n', '')
    },
    {
      code: 'protection_policy_validation_failed',
      name: 'unknown property',
      path: 'policy.unexpectedField',
      source: `${POLICY_YAML}unexpectedField: redacted-placeholder-value\n`
    },
    {
      code: 'protection_policy_validation_failed',
      name: 'invalid merge method',
      path: 'policy.allowedMergeMethods.0',
      source: POLICY_YAML.replace('  - squash', '  - octopus')
    }
  ];

  for (const entry of cases) {
    const requests = [];
    const output = { stderr: '', stdout: '' };
    const exitCode = await runAuditRepositoryProtectionCli([
      '--repository',
      'owner/example-repo',
      '--token-source',
      'external-read-token',
      '--json'
    ], {
      stderr: (message) => { output.stderr += message; },
      stdout: (message) => { output.stdout += message; }
    }, {
      fetchImpl: fakeFetch(requests),
      githubToken: 'token',
      readFile: readPolicyFixtureWith(entry.source)
    });
    const parsed = JSON.parse(output.stdout);

    assert.equal(exitCode, 1, entry.name);
    assert.equal(requests.length, 0, entry.name);
    assert.equal(parsed.reasonCodes.includes(entry.code), true, entry.name);
    assert.equal(parsed.blockers.some((blocker) => blocker.path === entry.path), true, entry.name);
    assert.equal(output.stdout.includes('redacted-placeholder-value'), false, entry.name);
    assert.equal(output.stderr, '', entry.name);
  }
});

function policy() {
  return {
    allowedBypassActors: [],
    allowedMergeMethods: ['squash'],
    blockDeletion: true,
    blockForcePush: true,
    defaultBranch: 'master',
    dismissStaleApprovals: true,
    enforceAdmins: true,
    minimumApprovals: 1,
    requireCodeOwnerReview: false,
    requireConversationResolution: true,
    requireLastPushApproval: true,
    requireLinearHistory: false,
    requirePullRequest: true,
    requireReviewEvidenceGate: true,
    requireRuleset: false,
    requireSignedCommits: false,
    requiredStatusChecks: ['CI', 'Review evidence gate']
  };
}

function fakeFetch(requests, options = {}) {
  let branchProtectionReads = 0;
  let rulesetDetailReads = 0;
  let rulesetsListReads = 0;
  return async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({
      method: init.method,
      path: `${parsed.pathname}${parsed.search}`
    });
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);

    const path = `${parsed.pathname}${parsed.search}`;
    if (options.missingRepository && path === '/repos/owner/example-repo') {
      return response({}, 404);
    }
    if (options.redirectRulesets && path.startsWith('/repos/owner/example-repo/rulesets')) {
      return response({}, 302, { location: 'https://example.invalid/redirect' });
    }
    if (options.forbiddenRulesets && path.startsWith('/repos/owner/example-repo/rulesets')) {
      return response({}, 403);
    }
    if (path === '/repos/owner/example-repo/rulesets?targets=branch&per_page=100') {
      rulesetsListReads += 1;
    }
    if (options.paginatedRulesets && path === '/repos/owner/example-repo/rulesets?targets=branch&per_page=100') {
      return response([rulesetSummary()], 200, {
        link: '<https://api.github.com/repos/owner/example-repo/rulesets?page=2>; rel="next"'
      });
    }
    if (options.paginatedRulesetsOnSecondRead && rulesetsListReads === 2 && path === '/repos/owner/example-repo/rulesets?targets=branch&per_page=100') {
      return response([rulesetSummary()], 200, {
        link: '<https://api.github.com/repos/owner/example-repo/rulesets?page=2>; rel="next"'
      });
    }
    if (options.loopRulesetsOnSecondRead && rulesetsListReads === 2 && path === '/repos/owner/example-repo/rulesets?targets=branch&per_page=100') {
      return response([rulesetSummary()], 200, {
        link: '<https://api.github.com/repos/owner/example-repo/rulesets?targets=branch&per_page=100>; rel="next"'
      });
    }
    if (path === '/repos/owner/example-repo') {
      return response(repository());
    }
    if (path === '/repos/owner/example-repo/branches/master') {
      return response({ commit: { sha: SHA } });
    }
    if (path === '/repos/owner/example-repo/branches/master/protection') {
      branchProtectionReads += 1;
      if (options.changedBranchProtectionOnSecondRead && branchProtectionReads === 2) {
        return response(branchProtection({ allow_force_pushes: { enabled: true } }));
      }
      return response(branchProtection());
    }
    if (path === '/repos/owner/example-repo/rulesets?targets=branch&per_page=100') {
      return response([rulesetSummary()]);
    }
    if (path === '/repos/owner/example-repo/rulesets/101') {
      rulesetDetailReads += 1;
      if (options.changedRulesetDetailOnSecondRead && rulesetDetailReads === 2) {
        return response(rulesetDetail({
          ...(options.includeBypassActors ? { bypass_actors: [] } : {}),
          rules: rulesetDetail().rules.map((rule) => rule.type === 'pull_request'
            ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  required_approving_review_count: 2
                }
              }
            : rule)
        }));
      }
      if (options.includeBypassActors && !(options.omitBypassActorsOnSecondRead && rulesetDetailReads === 2)) {
        return response(rulesetDetail({ bypass_actors: [] }));
      }
      return response(rulesetDetail());
    }
    if (path === '/repos/owner/example-repo/rulesets?page=2') {
      return response([]);
    }
    throw new Error(`unexpected path ${path}`);
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    status
  });
}

function repository() {
  return {
    allow_auto_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_squash_merge: true,
    default_branch: 'master',
    delete_branch_on_merge: true,
    full_name: 'owner/example-repo',
    merge_queue_enabled: false
  };
}

function branchProtection(overrides = {}) {
  return {
    allow_deletions: { enabled: false },
    allow_force_pushes: { enabled: false },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_last_push_approval: true,
      required_approving_review_count: 1
    },
    required_status_checks: {
      contexts: ['CI', 'Review evidence gate'],
      strict: true
    },
    ...overrides
  };
}

function rulesetSummary() {
  return {
    enforcement: 'active',
    id: 101,
    name: 'protect-default-branch',
    target: 'branch',
    updated_at: '2026-01-01T00:00:00Z'
  };
}

function rulesetDetail(overrides = {}) {
  return {
    ...rulesetSummary(),
    conditions: {
      ref_name: {
        exclude: [],
        include: ['~DEFAULT_BRANCH']
      }
    },
    rules: [
      {
        parameters: {
          required_status_checks: [
            { context: 'CI', integration_id: 1 },
            { context: 'Review evidence gate', integration_id: 1 }
          ],
          strict_required_status_checks_policy: true
        },
        type: 'required_status_checks'
      },
      {
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: true
        },
        type: 'pull_request'
      },
      { type: 'deletion' },
      { type: 'non_fast_forward' }
    ],
    ...overrides
  };
}
