import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('parseArgs validates repository and page limit', () => {
  assert.equal(parseArgs(['--repository', 'owner/example-repo']).ok, true);
  assert.equal(parseArgs(['--repository', 'owner']).ok, false);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--max-pages', '0']).ok, false);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--unknown']).ok, false);
});

test('fetchRepositoryProtectionAudit reads GitHub settings with GET only and returns sanitized ready report', async () => {
  const requests = [];
  const { result } = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch(requests),
    githubToken: 'secret-token-value',
    now: '2026-01-01T00:00:00.000Z',
    policy: policy(),
    repository: 'owner/example-repo'
  });

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(result.apiReadOk, true);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.checkedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(requests.length > 0, true);
  assert.equal(requests.every((request) => request.method === 'GET'), true);
  assert.equal(requests.filter((request) => request.path === '/repos/owner/example-repo/branches/master/protection').length, 2);
  assert.equal(JSON.stringify(result).includes('secret-token-value'), false);
});

test('fetchRepositoryProtectionAudit refetches branch protection and blocks TOCTOU changes', async () => {
  const requests = [];
  const { result } = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch(requests, { changedBranchProtectionOnSecondRead: true }),
    githubToken: 'secret-token-value',
    policy: policy(),
    repository: 'owner/example-repo'
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
    '--json'
  ], {
    stderr: (message) => { output.stderr += message; },
    stdout: (message) => { output.stdout += message; }
  }, {
    fetchImpl: fakeFetch([]),
    githubToken: 'another-secret-token',
    now: '2026-01-01T00:00:00.000Z',
    readFile: async () => POLICY_YAML
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
    repository: 'owner/example-repo'
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
    repository: 'owner/example-repo'
  });
  const forbidden = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { forbiddenRulesets: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo'
  });
  const missingRepo = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { missingRepository: true }),
    githubToken: 'token',
    policy: policy(),
    repository: 'owner/example-repo'
  });
  const pagination = await fetchRepositoryProtectionAudit({
    fetchImpl: fakeFetch([], { paginatedRulesets: true }),
    githubToken: 'token',
    maxPages: 1,
    policy: policy(),
    repository: 'owner/example-repo'
  });

  assert.equal(redirect.result.reasonCodes.includes('protection_api_failed'), true);
  assert.equal(forbidden.result.reasonCodes.includes('protection_api_forbidden'), true);
  assert.equal(missingRepo.result.reasonCodes.includes('protection_api_not_found'), true);
  assert.equal(pagination.result.reasonCodes.includes('ruleset_pagination_incomplete'), true);
});

test('CLI help and unexpected errors return documented exit codes', async () => {
  const help = { stderr: '', stdout: '' };
  const usage = { stderr: '', stdout: '' };
  const unexpected = { stderr: '', stdout: '' };

  assert.equal(await runAuditRepositoryProtectionCli(['--help'], {
    stderr: (message) => { help.stderr += message; },
    stdout: (message) => { help.stdout += message; }
  }), 0);
  assert.equal(await runAuditRepositoryProtectionCli(['--bad'], {
    stderr: (message) => { usage.stderr += message; },
    stdout: (message) => { usage.stdout += message; }
  }), 2);
  assert.equal(await runAuditRepositoryProtectionCli(['--repository', 'owner/example-repo'], {
    stderr: (message) => { unexpected.stderr += message; },
    stdout: (message) => { unexpected.stdout += message; }
  }, {
    fetchImpl: fakeFetch([]),
    githubToken: 'token',
    readFile: async () => { throw new Error('do not leak stack'); }
  }), 1);
  assert.match(help.stdout, /--repository/);
  assert.match(usage.stderr, /Unknown option/);
  assert.match(unexpected.stderr, /failed unexpectedly/);
  assert.equal(unexpected.stderr.includes('Error:'), false);
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
    if (options.paginatedRulesets && path === '/repos/owner/example-repo/rulesets?targets=branch&per_page=100') {
      return response([rulesetSummary()], 200, {
        link: '<https://api.github.com/repos/owner/example-repo/rulesets?page=2>; rel="next"'
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

function rulesetDetail() {
  return {
    ...rulesetSummary(),
    bypass_actors: [],
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
    ]
  };
}
