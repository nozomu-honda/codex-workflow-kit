import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import {
  DEFAULT_PROTECTION_POLICY,
  auditRepositoryProtection,
  formatProtectionAuditResult
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
  const changed = auditRepositoryProtection(safeInput({
    endSnapshot: {
      defaultBranch: 'master',
      defaultBranchSha: NEXT_SHA
    }
  }));

  assert.equal(resultCodes(api403).includes('protection_api_forbidden'), true);
  assert.equal(resultCodes(api404).includes('protection_api_not_found'), true);
  assert.equal(resultCodes(pagination).includes('ruleset_pagination_incomplete'), true);
  assert.equal(resultCodes(changed).includes('protection_changed_during_audit'), true);
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
