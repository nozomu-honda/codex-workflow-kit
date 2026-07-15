import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import {
  DEFAULT_PROTECTION_POLICY,
  auditRepositoryProtection,
  formatProtectionAuditResult,
  validateProtectionPolicyObject
} from '../src/protection-audit/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEXT_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

function safeInput(overrides = {}) {
  const defaultBranch = overrides.defaultBranch ?? 'master';
  return {
    branchProtection: safeBranchProtection(overrides.branchProtection),
    defaultBranch,
    defaultBranchSha: SHA,
    expectedPolicy: {
      ...DEFAULT_PROTECTION_POLICY,
      defaultBranch
    },
    mergeSettings: {
      allow_auto_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      delete_branch_on_merge: true,
      merge_queue_enabled: false
    },
    repository: {
      default_branch: defaultBranch,
      full_name: 'owner/example-repo'
    },
    rulesetDetails: [safeRuleset(overrides.ruleset)],
    rulesets: [],
    startSnapshot: {
      defaultBranch,
      defaultBranchSha: SHA
    },
    endSnapshot: {
      defaultBranch,
      defaultBranchSha: SHA
    },
    ...overrides
  };
}

function safeBranchProtection(overrides = {}) {
  return {
    allow_deletions: { enabled: false },
    allow_force_pushes: { enabled: false },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    required_linear_history: { enabled: false },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: true,
      required_approving_review_count: 1
    },
    required_signatures: { enabled: false },
    required_status_checks: {
      checks: [],
      contexts: ['CI', 'Review evidence gate'],
      strict: true
    },
    ...overrides
  };
}

function safeRuleset(overrides = {}) {
  return {
    bypass_actors: [],
    conditions: {
      ref_name: {
        exclude: [],
        include: ['~DEFAULT_BRANCH']
      }
    },
    enforcement: 'active',
    id: 101,
    name: 'protect-default-branch',
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
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: true
        },
        type: 'pull_request'
      },
      { type: 'deletion' },
      { type: 'non_fast_forward' }
    ],
    target: 'branch',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function resultCodes(result) {
  return result.reasonCodes;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withPolicyChange(basePolicy, mutate) {
  const next = clone(basePolicy);
  mutate(next);
  return next;
}

function ajvPolicyPaths(errors = []) {
  return errors.map((error) => {
    const parts = error.instancePath
      .split('/')
      .filter(Boolean)
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));

    if (error.keyword === 'required' && error.params?.missingProperty) {
      parts.push(error.params.missingProperty);
    }
    if (error.keyword === 'additionalProperties' && error.params?.additionalProperty) {
      parts.push(error.params.additionalProperty);
    }

    return ['policy', ...parts].join('.');
  }).sort();
}

test('safe protection is ready with deterministic sanitized report', () => {
  const result = auditRepositoryProtection(safeInput());

  assert.equal(result.ready, true);
  assert.equal(result.manualReviewRequired, false);
  assert.equal(result.repository, 'owner/example-repo');
  assert.equal(result.auditedSha, SHA);
  assert.equal(result.effectiveProtections.branchProtectionPresent, true);
  assert.equal(result.effectiveProtections.activeRulesetCount, 1);
  assert.deepEqual(result.reasonCodes, []);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
  assert.equal(JSON.stringify(result).includes('Authorization'), false);
});

test('branch protection and ruleset requirements are composed effectively', () => {
  const result = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({
      required_status_checks: {
        contexts: ['CI'],
        strict: true
      }
    })
  }));

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(result.requiredChecks.some((check) => check.name === 'Review evidence gate'), true);
});

test('missing branch protection and missing ruleset fail closed or require manual review', () => {
  const noProtection = auditRepositoryProtection(safeInput({ branchProtection: null }));
  const noRuleset = auditRepositoryProtection(safeInput({ rulesetDetails: [] }));

  assert.equal(noProtection.ready, false);
  assert.equal(resultCodes(noProtection).includes('branch_protection_missing'), true);
  assert.equal(noRuleset.ready, false);
  assert.equal(noRuleset.manualReviewRequired, true);
  assert.equal(resultCodes(noRuleset).includes('ruleset_missing'), true);
});

test('required CI and Review evidence gate checks are enforced', () => {
  const missingCi = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({
      required_status_checks: { contexts: ['Review evidence gate'], strict: true }
    }),
    rulesetDetails: [safeRuleset({
      rules: safeRuleset().rules.map((rule) => rule.type === 'required_status_checks'
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: [{ context: 'Review evidence gate', integration_id: 1 }]
            }
          }
        : rule)
    })]
  }));
  const missingGate = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({
      required_status_checks: { contexts: ['CI'], strict: true }
    }),
    rulesetDetails: [safeRuleset({
      rules: safeRuleset().rules.map((rule) => rule.type === 'required_status_checks'
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: [{ context: 'CI', integration_id: 1 }]
            }
          }
        : rule)
    })]
  }));

  assert.equal(resultCodes(missingCi).includes('ci_check_not_required'), true);
  assert.equal(resultCodes(missingGate).includes('review_evidence_gate_not_required'), true);
});

test('review settings block unsafe approval policies', () => {
  const approvalZero = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_last_push_approval: true,
        required_approving_review_count: 0
      }
    }),
    rulesetDetails: [safeRuleset({ rules: safeRuleset().rules.filter((rule) => rule.type !== 'pull_request') })]
  }));
  const staleNotDismissed = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({
      required_pull_request_reviews: {
        dismiss_stale_reviews: false,
        require_last_push_approval: true,
        required_approving_review_count: 1
      }
    }),
    rulesetDetails: [safeRuleset({ rules: safeRuleset().rules.filter((rule) => rule.type !== 'pull_request') })]
  }));
  const conversationMissing = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({
      required_conversation_resolution: { enabled: false }
    }),
    rulesetDetails: [safeRuleset({ rules: safeRuleset().rules.filter((rule) => rule.type !== 'pull_request') })]
  }));

  assert.equal(resultCodes(approvalZero).includes('minimum_approvals_too_low'), true);
  assert.equal(resultCodes(staleNotDismissed).includes('stale_approvals_not_dismissed'), true);
  assert.equal(resultCodes(conversationMissing).includes('conversation_resolution_not_required'), true);
});

test('force push and branch deletion are blocked by policy', () => {
  const forcePush = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({ allow_force_pushes: { enabled: true } }),
    rulesetDetails: [safeRuleset({ rules: safeRuleset().rules.filter((rule) => rule.type !== 'non_fast_forward') })]
  }));
  const deletion = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({ allow_deletions: { enabled: true } }),
    rulesetDetails: [safeRuleset({ rules: safeRuleset().rules.filter((rule) => rule.type !== 'deletion') })]
  }));

  assert.equal(resultCodes(forcePush).includes('force_push_allowed'), true);
  assert.equal(resultCodes(deletion).includes('deletion_allowed'), true);
});

test('bypass actors are sanitized and unsafe actors block readiness', () => {
  const admin = auditRepositoryProtection(safeInput({
    rulesetDetails: [safeRuleset({
      bypass_actors: [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }]
    })]
  }));
  const team = auditRepositoryProtection(safeInput({
    rulesetDetails: [safeRuleset({
      bypass_actors: [{ actor_id: 2, actor_type: 'Team', bypass_mode: 'pull_request' }]
    })]
  }));
  const unknown = auditRepositoryProtection(safeInput({
    rulesetDetails: [safeRuleset({
      bypass_actors: [{ actor_id: 3, actor_type: 'MysteryActor', bypass_mode: 'always' }]
    })]
  }));

  assert.equal(resultCodes(admin).includes('admin_bypass_allowed'), true);
  assert.equal(resultCodes(team).includes('unexpected_bypass_actor'), true);
  assert.equal(resultCodes(unknown).includes('unexpected_bypass_actor'), true);
  assert.equal(JSON.stringify(admin).includes('actor_id'), false);
  assert.equal(JSON.stringify(admin).includes('"actorId"'), false);
});

test('ruleset bypass actor visibility is tracked separately from zero actors', () => {
  const visibleZero = auditRepositoryProtection(safeInput({
    rulesetDetails: [safeRuleset({ bypass_actors: [] })]
  }));
  const omitted = safeRuleset();
  delete omitted.bypass_actors;
  const unknown = auditRepositoryProtection(safeInput({
    rulesetDetails: [omitted]
  }));

  assert.equal(visibleZero.ready, true, JSON.stringify(visibleZero, null, 2));
  assert.deepEqual(visibleZero.bypassVisibility, [{
    bypassActorsVisible: true,
    bypassActorCount: 0,
    ruleset: 'protect-default-branch'
  }]);
  assert.equal(unknown.ready, false);
  assert.equal(resultCodes(unknown).includes('ruleset_bypass_visibility_unknown'), true);
  assert.deepEqual(unknown.bypassVisibility, [{
    bypassActorsVisible: false,
    ruleset: 'protect-default-branch'
  }]);
  assert.equal(JSON.stringify(unknown).includes('"bypassActorCount":0'), false);
});

test('ruleset bypass visibility unknown fails only for active default branch rulesets', () => {
  const nonTarget = safeRuleset({
    conditions: { ref_name: { exclude: [], include: ['refs/heads/release/*'] } }
  });
  const inactive = safeRuleset({ enforcement: 'evaluate' });
  delete nonTarget.bypass_actors;
  delete inactive.bypass_actors;

  const nonTargetResult = auditRepositoryProtection(safeInput({ rulesetDetails: [nonTarget] }));
  const inactiveResult = auditRepositoryProtection(safeInput({ rulesetDetails: [inactive] }));

  assert.equal(resultCodes(nonTargetResult).includes('ruleset_bypass_visibility_unknown'), false);
  assert.equal(resultCodes(nonTargetResult).includes('ruleset_target_mismatch'), true);
  assert.equal(resultCodes(inactiveResult).includes('ruleset_bypass_visibility_unknown'), false);
  assert.equal(resultCodes(inactiveResult).includes('expected_ruleset_not_active'), true);
});

test('one hidden bypass actor list among multiple active rulesets fails closed even when allowed actors are configured', () => {
  const hidden = safeRuleset({ id: 202, name: 'hidden-bypass' });
  delete hidden.bypass_actors;
  const result = auditRepositoryProtection(safeInput({
    expectedPolicy: {
      ...DEFAULT_PROTECTION_POLICY,
      allowedBypassActors: ['Team:pull_request'],
      defaultBranch: 'master'
    },
    rulesetDetails: [
      safeRuleset({ id: 101, name: 'visible-bypass', bypass_actors: [] }),
      hidden
    ]
  }));
  const serialized = JSON.stringify(result);

  assert.equal(result.ready, false);
  assert.equal(resultCodes(result).includes('ruleset_bypass_visibility_unknown'), true);
  assert.equal(serialized.includes('actor_id'), false);
  assert.equal(serialized.includes('api.github.com'), false);
});

test('inactive or non-target rulesets require manual review', () => {
  const inactive = auditRepositoryProtection(safeInput({
    rulesetDetails: [safeRuleset({ enforcement: 'evaluate' })]
  }));
  const targetMismatch = auditRepositoryProtection(safeInput({
    rulesetDetails: [safeRuleset({
      conditions: { ref_name: { exclude: [], include: ['refs/heads/release/*'] } }
    })]
  }));

  assert.equal(resultCodes(inactive).includes('expected_ruleset_not_active'), true);
  assert.equal(resultCodes(targetMismatch).includes('ruleset_missing'), true);
  assert.equal(resultCodes(targetMismatch).includes('ruleset_target_mismatch'), true);
});

test('duplicate check names, disabled strict mode, and merge queue require manual review', () => {
  const duplicate = auditRepositoryProtection(safeInput({
    branchProtection: safeBranchProtection({
      required_status_checks: {
        checks: [
          { app_id: 1, context: 'CI' },
          { app_id: 2, context: 'CI' }
        ],
        contexts: ['Review evidence gate'],
        strict: false
      }
    }),
    rulesetDetails: [safeRuleset({
      rules: safeRuleset().rules.map((rule) => rule.type === 'required_status_checks'
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              strict_required_status_checks_policy: false
            }
          }
        : rule)
    })]
  }));
  const mergeQueue = auditRepositoryProtection(safeInput({
    mergeSettings: {
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      merge_queue_enabled: true
    }
  }));

  assert.equal(resultCodes(duplicate).includes('duplicate_check_name'), true);
  assert.equal(resultCodes(duplicate).includes('required_check_strict_mode_disabled'), true);
  assert.equal(resultCodes(mergeQueue).includes('merge_queue_enabled'), true);
  assert.equal(duplicate.manualReviewRequired, true);
});

test('merge method outside policy blocks readiness', () => {
  const result = auditRepositoryProtection(safeInput({
    mergeSettings: {
      allow_merge_commit: true,
      allow_rebase_merge: false,
      allow_squash_merge: true
    }
  }));

  assert.equal(resultCodes(result).includes('merge_method_not_allowed'), true);
});

test('API failures, pagination failure, and TOCTOU changes fail closed', () => {
  const api403 = auditRepositoryProtection(safeInput({
    apiErrors: [{ code: 'protection_api_forbidden', message: 'forbidden', path: 'rulesets' }]
  }));
  const api404 = auditRepositoryProtection(safeInput({
    apiErrors: [{ code: 'protection_api_not_found', message: 'not found', path: 'repository' }]
  }));
  const pagination = auditRepositoryProtection(safeInput({ pagination: { rulesetsComplete: false } }));
  const endPagination = auditRepositoryProtection(safeInput({ pagination: { rulesetsEndComplete: false } }));
  const changed = auditRepositoryProtection(safeInput({
    endSnapshot: {
      defaultBranch: 'master',
      defaultBranchSha: NEXT_SHA
    }
  }));

  assert.equal(resultCodes(api403).includes('protection_api_forbidden'), true);
  assert.equal(resultCodes(api404).includes('protection_api_not_found'), true);
  assert.equal(resultCodes(pagination).includes('ruleset_pagination_incomplete'), true);
  assert.equal(endPagination.blockers.some((blocker) => blocker.path === 'rulesets.end'), true);
  assert.equal(resultCodes(changed).includes('protection_changed_during_audit'), true);
});

test('ruleset TOCTOU fingerprint detects detail and bypass visibility changes', () => {
  const changedRule = auditRepositoryProtection(safeInput({
    endRulesetDetails: [safeRuleset({
      rules: safeRuleset().rules.map((rule) => rule.type === 'pull_request'
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_approving_review_count: 2
            }
          }
        : rule)
    })],
    endRulesets: []
  }));
  const hiddenBypass = safeRuleset();
  delete hiddenBypass.bypass_actors;
  const changedBypassVisibility = auditRepositoryProtection(safeInput({
    endRulesetDetails: [hiddenBypass],
    endRulesets: []
  }));
  const unchanged = auditRepositoryProtection(safeInput({
    endRulesetDetails: [safeRuleset()],
    endRulesets: []
  }));

  assert.equal(resultCodes(changedRule).includes('protection_changed_during_audit'), true);
  assert.equal(resultCodes(changedBypassVisibility).includes('protection_changed_during_audit'), true);
  assert.equal(resultCodes(unchanged).includes('protection_changed_during_audit'), false);
});

test('github-token source and weak direct policy inputs fail closed', () => {
  const githubToken = auditRepositoryProtection(safeInput({ tokenSource: 'github-token' }));
  const weakPolicy = auditRepositoryProtection(safeInput({
    expectedPolicy: {
      ...DEFAULT_PROTECTION_POLICY,
      minimumApprovals: 0
    }
  }));

  assert.equal(githubToken.ready, false);
  assert.equal(resultCodes(githubToken).includes('administration_read_token_required'), true);
  assert.equal(weakPolicy.ready, false);
  assert.equal(resultCodes(weakPolicy).includes('protection_policy_validation_failed'), true);
});

test('branch protection fingerprint detects TOCTOU changes and keeps reports sanitized', () => {
  const cases = [
    {
      name: 'required status checks changed',
      endBranchProtection: safeBranchProtection({
        required_status_checks: {
          contexts: ['CI'],
          strict: true
        }
      })
    },
    {
      name: 'required reviews changed',
      endBranchProtection: safeBranchProtection({
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          require_last_push_approval: true,
          required_approving_review_count: 2
        }
      })
    },
    {
      name: 'admin enforcement changed',
      endBranchProtection: safeBranchProtection({
        enforce_admins: { enabled: false }
      })
    },
    {
      name: 'force push allowance changed',
      endBranchProtection: safeBranchProtection({
        allow_force_pushes: { enabled: true }
      })
    },
    {
      name: 'branch deletion allowance changed',
      endBranchProtection: safeBranchProtection({
        allow_deletions: { enabled: true }
      })
    },
    {
      name: 'conversation resolution changed',
      endBranchProtection: safeBranchProtection({
        required_conversation_resolution: { enabled: false }
      })
    }
  ];

  for (const entry of cases) {
    const result = auditRepositoryProtection(safeInput({
      endBranchProtection: entry.endBranchProtection
    }));
    const serialized = JSON.stringify(result);

    assert.equal(result.ready, false, entry.name);
    assert.equal(resultCodes(result).includes('protection_changed_during_audit'), true, entry.name);
    assert.equal(serialized.includes('Authorization'), false, entry.name);
    assert.equal(serialized.includes('Bearer'), false, entry.name);
    assert.equal(serialized.includes('actor_id'), false, entry.name);
    assert.equal(serialized.includes('secret-token-value'), false, entry.name);
  }
});

test('branch protection fingerprint detects presence changes', () => {
  const missingToPresent = auditRepositoryProtection(safeInput({
    branchProtection: null,
    endBranchProtection: safeBranchProtection()
  }));
  const presentToMissing = auditRepositoryProtection(safeInput({
    endBranchProtection: null
  }));

  assert.equal(missingToPresent.ready, false);
  assert.equal(resultCodes(missingToPresent).includes('protection_changed_during_audit'), true);
  assert.equal(resultCodes(missingToPresent).includes('branch_protection_missing'), true);
  assert.equal(presentToMissing.ready, false);
  assert.equal(resultCodes(presentToMissing).includes('protection_changed_during_audit'), true);
});

test('unchanged branch protection fingerprint allows audit to continue', () => {
  const result = auditRepositoryProtection(safeInput({
    endBranchProtection: safeBranchProtection()
  }));

  assert.equal(result.ready, true, JSON.stringify(result, null, 2));
  assert.equal(resultCodes(result).includes('protection_changed_during_audit'), false);
});

test('core policy validator matches JSON Schema for valid and invalid policies', async () => {
  const schema = JSON.parse(await readFile(new URL('../../../schemas/protection-policy.schema.json', import.meta.url), 'utf8'));
  const basePolicy = YAML.parse(await readFile(new URL('../../../release/protection-policy.example.yml', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const booleanFields = [
    'blockDeletion',
    'blockForcePush',
    'dismissStaleApprovals',
    'enforceAdmins',
    'requireCodeOwnerReview',
    'requireConversationResolution',
    'requireLastPushApproval',
    'requireLinearHistory',
    'requirePullRequest',
    'requireReviewEvidenceGate',
    'requireRuleset',
    'requireSignedCommits'
  ];
  const requiredFields = [
    'allowedMergeMethods',
    'blockDeletion',
    'blockForcePush',
    'dismissStaleApprovals',
    'minimumApprovals',
    'requireConversationResolution',
    'requirePullRequest',
    'requireReviewEvidenceGate',
    'requiredStatusChecks'
  ];
  const validPolicies = [
    { name: 'example policy', policy: basePolicy },
    { name: 'empty default branch is valid', policy: withPolicyChange(basePolicy, (policy) => { policy.defaultBranch = ''; }) },
    { name: 'allowed bypass actors may be omitted', policy: withPolicyChange(basePolicy, (policy) => { delete policy.allowedBypassActors; }) },
    { name: 'empty allowed bypass actors is valid', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedBypassActors = []; }) }
  ];
  const invalidPolicies = [
    { name: 'root array', path: 'policy', policy: [] },
    { name: 'defaultBranch non-string', path: 'policy.defaultBranch', policy: withPolicyChange(basePolicy, (policy) => { policy.defaultBranch = 123; }) },
    { name: 'requiredStatusChecks non-array', path: 'policy.requiredStatusChecks', policy: withPolicyChange(basePolicy, (policy) => { policy.requiredStatusChecks = 'CI'; }) },
    { name: 'requiredStatusChecks empty', path: 'policy.requiredStatusChecks', policy: withPolicyChange(basePolicy, (policy) => { policy.requiredStatusChecks = []; }) },
    { name: 'requiredStatusChecks non-string entry', path: 'policy.requiredStatusChecks.0', policy: withPolicyChange(basePolicy, (policy) => { policy.requiredStatusChecks = [1]; }) },
    { name: 'requiredStatusChecks empty string entry', path: 'policy.requiredStatusChecks.0', policy: withPolicyChange(basePolicy, (policy) => { policy.requiredStatusChecks = ['']; }) },
    { name: 'requiredStatusChecks duplicate', path: 'policy.requiredStatusChecks', policy: withPolicyChange(basePolicy, (policy) => { policy.requiredStatusChecks = ['CI', 'CI']; }) },
    { name: 'minimumApprovals numeric string', path: 'policy.minimumApprovals', policy: withPolicyChange(basePolicy, (policy) => { policy.minimumApprovals = '1'; }) },
    { name: 'minimumApprovals decimal', path: 'policy.minimumApprovals', policy: withPolicyChange(basePolicy, (policy) => { policy.minimumApprovals = 1.5; }) },
    { name: 'minimumApprovals NaN', path: 'policy.minimumApprovals', policy: withPolicyChange(basePolicy, (policy) => { policy.minimumApprovals = Number.NaN; }) },
    { name: 'minimumApprovals Infinity', path: 'policy.minimumApprovals', policy: withPolicyChange(basePolicy, (policy) => { policy.minimumApprovals = Number.POSITIVE_INFINITY; }) },
    { name: 'allowedMergeMethods non-array', path: 'policy.allowedMergeMethods', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedMergeMethods = 'squash'; }) },
    { name: 'allowedMergeMethods empty', path: 'policy.allowedMergeMethods', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedMergeMethods = []; }) },
    { name: 'allowedMergeMethods enum', path: 'policy.allowedMergeMethods.0', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedMergeMethods = ['octopus']; }) },
    { name: 'allowedMergeMethods duplicate', path: 'policy.allowedMergeMethods', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedMergeMethods = ['squash', 'squash']; }) },
    { name: 'allowedBypassActors non-array', path: 'policy.allowedBypassActors', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedBypassActors = 'team/release'; }) },
    { name: 'allowedBypassActors non-string entry', path: 'policy.allowedBypassActors.0', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedBypassActors = [1]; }) },
    { name: 'allowedBypassActors empty string entry', path: 'policy.allowedBypassActors.0', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedBypassActors = ['']; }) },
    { name: 'allowedBypassActors duplicate', path: 'policy.allowedBypassActors', policy: withPolicyChange(basePolicy, (policy) => { policy.allowedBypassActors = ['Team:release', 'Team:release']; }) },
    { name: 'unknown field', path: 'policy.unexpectedField', policy: withPolicyChange(basePolicy, (policy) => { policy.unexpectedField = 'redacted-placeholder-value'; }) }
  ];

  for (const field of booleanFields) {
    invalidPolicies.push({
      name: `${field} non-boolean`,
      path: `policy.${field}`,
      policy: withPolicyChange(basePolicy, (policy) => { policy[field] = 'true'; })
    });
  }

  for (const field of requiredFields) {
    invalidPolicies.push({
      name: `${field} missing`,
      path: `policy.${field}`,
      policy: withPolicyChange(basePolicy, (policy) => { delete policy[field]; })
    });
  }

  for (const entry of validPolicies) {
    const core = validateProtectionPolicyObject(entry.policy);
    const schemaOk = validate(entry.policy);

    assert.equal(schemaOk, true, entry.name);
    assert.equal(core.ok, true, `${entry.name}: ${JSON.stringify(core.errors, null, 2)}`);
    assert.deepEqual(core.errors, [], entry.name);
  }

  for (const entry of invalidPolicies) {
    const core = validateProtectionPolicyObject(entry.policy);
    const schemaOk = validate(entry.policy);
    const schemaPaths = ajvPolicyPaths(validate.errors);
    const corePaths = core.errors.map((error) => error.path).sort();

    assert.equal(schemaOk, false, entry.name);
    assert.equal(core.ok, false, entry.name);
    assert.equal(schemaPaths.includes(entry.path), true, `${entry.name}: ${JSON.stringify(validate.errors, null, 2)}`);
    assert.equal(corePaths.includes(entry.path), true, `${entry.name}: ${JSON.stringify(core.errors, null, 2)}`);
    assert.equal(core.errors.every((error) => error.code === 'protection_policy_validation_failed'), true, entry.name);
    assert.deepEqual(validateProtectionPolicyObject(entry.policy).errors, core.errors, entry.name);
  }
});

test('invalid direct policy is fail-closed and does not influence audit output', () => {
  const invalidPolicy = withPolicyChange(DEFAULT_PROTECTION_POLICY, (policy) => {
    policy.defaultBranch = 'leaky-branch-name';
    policy.minimumApprovals = '2';
    policy.unexpectedField = 'redacted-placeholder-value';
  });
  const result = auditRepositoryProtection(safeInput({ expectedPolicy: invalidPolicy }));
  const serialized = JSON.stringify(result);

  assert.equal(result.ready, false);
  assert.equal(resultCodes(result).includes('protection_policy_validation_failed'), true);
  assert.equal(serialized.includes('redacted-placeholder-value'), false);
  assert.equal(serialized.includes('leaky-branch-name'), false);
});

test('policy schema validates the example policy', async () => {
  const schema = JSON.parse(await readFile(new URL('../../../schemas/protection-policy.schema.json', import.meta.url), 'utf8'));
  const policy = YAML.parse(await readFile(new URL('../../../release/protection-policy.example.yml', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(schema);

  assert.equal(validate(policy), true, JSON.stringify(validate.errors, null, 2));
});

test('formatted report is stable and does not include secret-like values', () => {
  const result = auditRepositoryProtection(safeInput({
    apiErrors: [{ code: 'protection_api_failed', message: 'Authorization failed with token', path: 'githubApi' }]
  }));
  const output = formatProtectionAuditResult(result);

  assert.match(output, /Repository protection audit: NOT READY/);
  assert.match(output, /protection_api_failed/);
  assert.equal(output.includes('Bearer'), false);
});
