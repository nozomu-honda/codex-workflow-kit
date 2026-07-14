import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS,
  binaryFile,
  dependencyChangeFile,
  generatedDistFile,
  submoduleFile,
  workflowChangeFile
} from '../github-events/index.js';
import { AUTO_MERGE_REGRESSION_SCENARIO_VERSION } from '../../packages/chatgpt-automation-core/src/auto-merge-regressions/index.js';

export const REGRESSION_NOW = '2026-01-01T00:00:00.000Z';
export const REGRESSION_REQUESTED_AT = '2026-01-01T00:00:00.000Z';

const BASE_SCENARIOS = [
  scenario({
    category: 'review',
    description: 'PR #130 regression: CI success but no review evidence and no reviewed label must not create a command.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['review_evidence_missing', 'reviewed_by_chatgpt_label_missing'],
    id: 'no-review-evidence-regression',
    overrides: {
      pullRequestSnapshot: pullRequest({ labels: ['auto-merge-after-ci'] }),
      reviewEvidenceSnapshot: reviewEvidence({
        issueComments: [],
        reviewThreads: [],
        reviews: []
      })
    }
  }),
  scenario({
    category: 'review',
    description: 'Missing review evidence is blocked even when the reviewed label remains present.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['chatgpt_review_missing', 'review_evidence_missing'],
    id: 'no-review-evidence',
    overrides: {
      reviewEvidenceSnapshot: reviewEvidence({
        issueComments: [],
        reviewThreads: [],
        reviews: []
      })
    }
  }),
  scenario({
    category: 'review',
    description: 'Stale human approval does not satisfy current-head review requirements.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['review_not_current'],
    id: 'stale-human-approval',
    overrides: {
      executionContext: executionContext({
        config: automationConfig({ autoMerge: { requireChatGPTReview: false } })
      }),
      reviewEvidenceSnapshot: reviewEvidence({
        issueComments: [],
        reviews: [review({ commit_id: FIXTURE_SHAS.before })]
      })
    }
  }),
  scenario({
    category: 'review',
    description: 'Stale ChatGPT marker is ignored for the current head.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['chatgpt_review_missing'],
    id: 'stale-chatgpt-marker',
    overrides: {
      reviewEvidenceSnapshot: reviewEvidence({
        issueComments: [chatGptMarker('approved', { headSha: FIXTURE_SHAS.before })],
        reviews: [review()]
      })
    }
  }),
  scenario({
    category: 'review',
    description: 'Same-run ChatGPT marker and human approval on the current head produce a write-disabled command candidate.',
    expectedDecision: successDecision(),
    expectedReasonCodes: ['eligible_enable_auto_merge', 'write_disabled'],
    id: 'same-run-review-evidence',
    overrides: {}
  }),
  scenario({
    category: 'review',
    description: 'Latest ChatGPT changes_requested marker blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['changes_requested'],
    id: 'changes-requested',
    overrides: {
      reviewEvidenceSnapshot: reviewEvidence({
        issueComments: [chatGptMarker('changes_requested')]
      })
    }
  }),
  scenario({
    category: 'review',
    description: 'Unresolved review thread blocks auto-merge even with approval.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['unresolved_review_threads'],
    id: 'unresolved-review-thread',
    overrides: {
      reviewEvidenceSnapshot: reviewEvidence({
        reviewThreads: [{ isResolved: false }]
      })
    }
  }),
  scenario({
    category: 'review',
    description: 'Remaining requested reviewer blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['requested_reviewers_remaining'],
    id: 'requested-reviewer-remaining',
    overrides: {
      pullRequestSnapshot: pullRequest({ requestedReviewers: 1 })
    }
  }),
  scenario({
    category: 'review',
    description: 'Current-head valid review remains eligible and dry-run only.',
    expectedDecision: successDecision(),
    expectedReasonCodes: ['eligible_enable_auto_merge', 'write_disabled'],
    id: 'current-head-valid-review',
    overrides: {}
  }),

  scenario({
    category: 'pr-state',
    description: 'Closed PR is not eligible.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['pr_not_open'],
    id: 'closed-pr',
    overrides: { pullRequestSnapshot: pullRequest({ state: 'closed' }) }
  }),
  scenario({
    category: 'pr-state',
    description: 'Draft PR is not eligible.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['draft_pr'],
    id: 'draft-pr',
    overrides: { pullRequestSnapshot: pullRequest({ draft: true }) }
  }),
  scenario({
    category: 'pr-state',
    description: 'Fork PR is fail-closed.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['not_same_repository'],
    id: 'fork-pr',
    overrides: {
      normalizedEvent: normalizedEvent({
        head_repository: 'fork-owner/example-repo',
        is_fork: 'true',
        is_same_repository: 'false'
      }),
      pullRequestSnapshot: pullRequest({
        fork: true,
        headRepository: 'fork-owner/example-repo'
      })
    }
  }),
  scenario({
    category: 'pr-state',
    description: 'External repository mismatch is fail-closed.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['not_same_repository'],
    id: 'external-repository',
    overrides: {
      normalizedEvent: normalizedEvent({
        is_same_repository: 'false',
        repository: 'external-owner/external-repo',
        repository_owner: 'external-owner'
      })
    }
  }),
  scenario({
    category: 'pr-state',
    description: 'Head SHA mismatch between event and PR snapshot blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['head_sha_mismatch'],
    id: 'head-sha-changed',
    overrides: {
      pullRequestSnapshot: pullRequest({ headSha: FIXTURE_SHAS.after })
    }
  }),
  scenario({
    category: 'pr-state',
    description: 'Base branch SHA mismatch is represented as stale head comparison.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['stale_head'],
    id: 'base-sha-changed',
    overrides: {
      pullRequestSnapshot: pullRequest({
        baseSha: FIXTURE_SHAS.after,
        comparison: { behind_by: 1, status: 'behind' }
      })
    }
  }),
  scenario({
    category: 'pr-state',
    description: 'Unknown mergeability blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['mergeable_unknown'],
    id: 'mergeability-unknown',
    overrides: {
      pullRequestSnapshot: pullRequest({ mergeable: null })
    }
  }),
  scenario({
    category: 'pr-state',
    description: 'Dirty merge state blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['merge_conflict'],
    id: 'conflict-dirty',
    overrides: {
      pullRequestSnapshot: pullRequest({ mergeable: false, mergeableStateStatus: 'dirty' })
    }
  }),

  scenario({
    category: 'ci',
    description: 'Pending CI blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['required_ci_pending'],
    id: 'ci-pending',
    overrides: { ciSnapshot: ci({ workflowRuns: [workflowRun({ status: 'in_progress', conclusion: '' })] }) }
  }),
  scenario({
    category: 'ci',
    description: 'Failing CI blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['required_ci_failed'],
    id: 'ci-failure',
    overrides: { ciSnapshot: ci({ workflowRuns: [workflowRun({ conclusion: 'failure' })] }) }
  }),
  scenario({
    category: 'ci',
    description: 'Missing required check blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['required_ci_pending'],
    id: 'required-check-missing',
    overrides: { ciSnapshot: ci({ workflowRuns: [] }) }
  }),
  scenario({
    category: 'ci',
    description: 'Review evidence gate missing is surfaced as required CI pending.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['required_ci_pending'],
    id: 'review-evidence-gate-missing',
    overrides: {
      ciSnapshot: ci({ workflowRuns: [workflowRun()] }),
      executionContext: executionContext({
        config: automationConfig({
          autoMerge: { requiredWorkflows: ['CI', 'Review evidence gate'] }
        })
      })
    }
  }),
  scenario({
    category: 'ci',
    description: 'Required check on a stale head SHA does not satisfy the current head.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['required_ci_pending'],
    id: 'check-head-sha-mismatch',
    overrides: {
      ciSnapshot: ci({ workflowRuns: [workflowRun({ headSha: FIXTURE_SHAS.before })] })
    }
  }),
  scenario({
    category: 'ci',
    description: 'Duplicate check name from policy audit blocks outside the plan layer.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['duplicate_check_name', 'protection_audit_failed'],
    id: 'duplicate-check-name',
    overrides: {
      protectionAuditSnapshot: protectionAudit({
        ready: false,
        reasonCodes: ['duplicate_check_name']
      })
    }
  }),

  scenario({
    category: 'audit',
    description: 'Consumer audit failure blocks replay before write command creation.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['consumer_audit_failed'],
    id: 'consumer-audit-failure',
    overrides: { consumerAuditSnapshot: consumerAudit({ ready: false }) }
  }),
  scenario({
    category: 'audit',
    description: 'Consumer audit SHA mismatch blocks replay.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['audited_sha_mismatch', 'consumer_audit_failed'],
    id: 'consumer-audit-sha-mismatch',
    overrides: { consumerAuditSnapshot: consumerAudit({ ready: false, reasonCodes: ['audited_sha_mismatch'] }) }
  }),
  scenario({
    category: 'audit',
    description: 'Protection audit failure blocks replay.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['protection_audit_failed'],
    id: 'protection-audit-failure',
    overrides: { protectionAuditSnapshot: protectionAudit({ ready: false }) }
  }),
  scenario({
    category: 'audit',
    description: 'Missing ruleset blocks replay through protection audit.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['protection_audit_failed', 'ruleset_missing'],
    id: 'ruleset-missing',
    overrides: { protectionAuditSnapshot: protectionAudit({ ready: false, reasonCodes: ['ruleset_missing'] }) }
  }),
  scenario({
    category: 'audit',
    description: 'Unknown bypass actor blocks replay.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['protection_audit_failed', 'unexpected_bypass_actor'],
    id: 'bypass-actor-unknown',
    overrides: { protectionAuditSnapshot: protectionAudit({ ready: false, reasonCodes: ['unexpected_bypass_actor'] }) }
  }),
  scenario({
    category: 'audit',
    description: 'Allowed force push blocks replay.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['force_push_allowed', 'protection_audit_failed'],
    id: 'force-push-allowed',
    overrides: { protectionAuditSnapshot: protectionAudit({ ready: false, reasonCodes: ['force_push_allowed'] }) }
  }),
  scenario({
    category: 'audit',
    description: 'Allowed branch deletion blocks replay.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['deletion_allowed', 'protection_audit_failed'],
    id: 'branch-deletion-allowed',
    overrides: { protectionAuditSnapshot: protectionAudit({ ready: false, reasonCodes: ['deletion_allowed'] }) }
  }),

  scenario({
    category: 'diff',
    description: 'Sensitive changed file blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['workflow_change_requires_manual_merge'],
    id: 'dangerous-file',
    overrides: { changedFilesSnapshot: changedFiles([workflowChangeFile()]) }
  }),
  scenario({
    category: 'diff',
    description: 'Workflow permission increase remains a workflow manual-merge change.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['workflow_change_requires_manual_merge'],
    id: 'workflow-permission-increase',
    overrides: { changedFilesSnapshot: changedFiles([workflowChangeFile({ patch: '+permissions:\n+  contents: write' })]) }
  }),
  scenario({
    category: 'diff',
    description: 'pull_request_target addition is blocked as a workflow change.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['workflow_change_requires_manual_merge'],
    id: 'pull-request-target',
    overrides: { changedFilesSnapshot: changedFiles([workflowChangeFile({ patch: '+on:\n+  pull_request_target:' })]) }
  }),
  scenario({
    category: 'diff',
    description: 'Secret-like added line blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['secret_like_added_line'],
    id: 'secret-like-addition',
    overrides: { changedFilesSnapshot: changedFiles([changedFile('docs/example.md', '+const token = "dummy";')]) }
  }),
  scenario({
    category: 'diff',
    description: 'Binary file blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['binary_change_requires_manual_merge'],
    id: 'binary-file',
    overrides: { changedFilesSnapshot: changedFiles([binaryFile()]) }
  }),
  scenario({
    category: 'diff',
    description: 'Submodule change blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['submodule_change_requires_manual_merge'],
    id: 'submodule-change',
    overrides: { changedFilesSnapshot: changedFiles([submoduleFile()]) }
  }),
  scenario({
    category: 'diff',
    description: 'Dependency change blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['dependency_change_requires_manual_merge'],
    id: 'dependency-change',
    overrides: { changedFilesSnapshot: changedFiles([dependencyChangeFile()]) }
  }),
  scenario({
    category: 'diff',
    description: 'Generated dist change blocks auto-merge.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['generated_dist_requires_manual_merge'],
    id: 'generated-dist-change',
    overrides: { changedFilesSnapshot: changedFiles([generatedDistFile()]) }
  }),

  scenario({
    category: 'replay-prevention',
    description: 'Duplicate dedupe key suppresses replay.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['duplicate_suppressed'],
    id: 'duplicate-idempotency-key',
    overrides: {
      executionContext: executionContext({
        existingDedupeKeys: [`${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:enable-auto-merge:v1`]
      })
    }
  }),
  scenario({
    category: 'replay-prevention',
    description: 'Cooldown suppresses replay.',
    expectedDecision: skippedDecision(),
    expectedReasonCodes: ['cooldown_active'],
    id: 'cooldown-active',
    overrides: {
      executionContext: executionContext({
        config: automationConfig({ autoMerge: { cooldownSeconds: 600 } }),
        lastPlannedAt: '2025-12-31T23:59:00.000Z'
      })
    }
  }),
  scenario({
    category: 'replay-prevention',
    description: 'Fake adapter attempt limit blocks command execution.',
    expectedDecision: {
      adapterCalled: true,
      commandCreated: true,
      dryRun: true,
      eligible: true,
      executed: false
    },
    expectedReasonCodes: ['attempt_limit_exceeded', 'eligible_enable_auto_merge'],
    id: 'attempt-limit-exceeded',
    overrides: {
      executionContext: executionContext({
        adapter: 'fake',
        fakeAdapter: { maxAttempts: 0 }
      })
    }
  }),
  scenario({
    category: 'replay-prevention',
    description: 'Expired command timestamp blocks adapter acceptance.',
    expectedDecision: {
      adapterCalled: true,
      commandCreated: true,
      dryRun: true,
      eligible: true,
      executed: false
    },
    expectedReasonCodes: ['command_expired', 'eligible_enable_auto_merge'],
    id: 'command-expired',
    overrides: {
      executionContext: executionContext({
        requestedAt: '2025-12-30T23:59:59.000Z'
      })
    }
  }),
  scenario({
    category: 'replay-prevention',
    description: 'Future command timestamp blocks adapter acceptance.',
    expectedDecision: {
      adapterCalled: true,
      commandCreated: true,
      dryRun: true,
      eligible: true,
      executed: false
    },
    expectedReasonCodes: ['command_from_future', 'eligible_enable_auto_merge'],
    id: 'future-timestamp',
    overrides: {
      executionContext: executionContext({
        requestedAt: '2026-01-01T00:05:01.000Z'
      })
    }
  }),
  scenario({
    category: 'success',
    description: 'Fully safe current-head reviewed candidate creates a command but Disabled adapter keeps write disabled.',
    expectedDecision: successDecision(),
    expectedReasonCodes: ['eligible_enable_auto_merge', 'write_disabled'],
    id: 'safe-candidate-write-disabled',
    overrides: {}
  })
];

export const AUTO_MERGE_REGRESSION_SCENARIOS = Object.freeze(BASE_SCENARIOS);

export function buildAutoMergeRegressionScenarios() {
  return BASE_SCENARIOS.map((entry) => structuredClone(entry));
}

export function scenario({ category, description, expectedDecision, expectedReasonCodes, id, overrides = {} }) {
  const base = {
    category,
    changedFilesSnapshot: changedFiles(),
    ciSnapshot: ci(),
    consumerAuditSnapshot: consumerAudit(),
    description,
    executionContext: executionContext(),
    expectedDecision,
    expectedReasonCodes,
    id,
    normalizedEvent: normalizedEvent(),
    protectionAuditSnapshot: protectionAudit(),
    pullRequestSnapshot: pullRequest(),
    reviewEvidenceSnapshot: reviewEvidence(),
    scenarioVersion: AUTO_MERGE_REGRESSION_SCENARIO_VERSION
  };

  return mergeScenario(base, overrides);
}

export function normalizedEvent(overrides = {}) {
  return {
    actor: 'github-actions[bot]',
    default_branch: 'main',
    eligible: 'true',
    event_action: 'completed',
    event_name: 'workflow_run',
    head_repository: FIXTURE_REPOSITORY.fullName,
    head_sha: FIXTURE_SHAS.head,
    is_fork: 'false',
    is_same_repository: 'true',
    pull_request_number: '42',
    repository: FIXTURE_REPOSITORY.fullName,
    repository_owner: FIXTURE_REPOSITORY.owner,
    workflow_conclusion: 'success',
    workflow_name: 'CI',
    ...overrides
  };
}

export function pullRequest(overrides = {}) {
  const labels = overrides.labels ?? ['auto-merge-after-ci', 'reviewed-by-chatgpt'];
  return {
    base: {
      ref: overrides.baseRef ?? 'main',
      repo: { full_name: FIXTURE_REPOSITORY.fullName },
      sha: overrides.baseSha ?? FIXTURE_SHAS.base
    },
    body: 'Fixture validation evidence',
    comparison: overrides.comparison ?? { behind_by: 0, status: 'ahead' },
    draft: overrides.draft ?? false,
    head: {
      ref: 'feature/example-change',
      repo: {
        fork: overrides.fork ?? false,
        full_name: overrides.headRepository ?? FIXTURE_REPOSITORY.fullName
      },
      sha: overrides.headSha ?? FIXTURE_SHAS.head
    },
    labels: labels.map((name) => ({ name })),
    mergeable: Object.hasOwn(overrides, 'mergeable') ? overrides.mergeable : true,
    mergeable_state: overrides.mergeableStateStatus ?? 'clean',
    merged: overrides.merged ?? false,
    number: 42,
    requested_reviewers: Array.from({ length: overrides.requestedReviewers ?? 0 }, (_, index) => ({ login: `example-reviewer-${index}` })),
    requested_teams: Array.from({ length: overrides.requestedTeams ?? 0 }, (_, index) => ({ slug: `example-team-${index}` })),
    state: overrides.state ?? 'open',
    title: 'Example fixture PR',
    user: { login: 'example-author' }
  };
}

export function reviewEvidence(overrides = {}) {
  return {
    issueComments: overrides.issueComments ?? [chatGptMarker('approved')],
    reviewThreads: overrides.reviewThreads ?? [],
    reviews: overrides.reviews ?? [review()]
  };
}

export function ci(overrides = {}) {
  return {
    checkRuns: overrides.checkRuns ?? [],
    commitStatuses: overrides.commitStatuses ?? [],
    workflowRuns: overrides.workflowRuns ?? [workflowRun()]
  };
}

export function changedFiles(files = [changedFile('docs/example.md')]) {
  return { files };
}

export function consumerAudit(overrides = {}) {
  return {
    ready: overrides.ready ?? true,
    reasonCodes: overrides.reasonCodes ?? []
  };
}

export function protectionAudit(overrides = {}) {
  return {
    ready: overrides.ready ?? true,
    reasonCodes: overrides.reasonCodes ?? [],
    repositorySettings: overrides.repositorySettings ?? {
      allow_auto_merge: true,
      allow_squash_merge: true
    }
  };
}

export function executionContext(overrides = {}) {
  return {
    actorContext: {
      actor: 'github-actions[bot]',
      isFork: false,
      isTrusted: true,
      source: 'plan'
    },
    adapter: 'disabled',
    config: automationConfig(),
    existingDedupeKeys: [],
    now: REGRESSION_NOW,
    requestedAt: REGRESSION_REQUESTED_AT,
    ...overrides
  };
}

export function automationConfig(overrides = {}) {
  const { autoMerge: autoMergeOverrides = {}, ...rootOverrides } = overrides;
  return {
    version: 1,
    baseBranch: 'main',
    ciWorkflowName: 'CI',
    dryRunDefault: true,
    features: {
      actionsApproval: false,
      autoMerge: true,
      autoRequest: false,
      mainFollowup: false,
      routeReview: false
    },
    labels: {
      autoMergeAfterCi: 'auto-merge-after-ci',
      codexFixInProgress: 'codex-fix-in-progress',
      codexMainFollowupInProgress: 'codex-main-followup-in-progress',
      doNotAutoApproveActions: 'do-not-auto-approve-actions',
      doNotAutoCodexFix: 'do-not-auto-codex-fix',
      doNotAutoCodexMainFollowup: 'do-not-auto-codex-main-followup',
      doNotAutoReviewRequest: 'do-not-auto-review-request',
      doNotMerge: 'do-not-merge',
      needsChatGptReview: 'needs-chatgpt-review',
      needsCodexFix: 'needs-codex-fix',
      reviewedByChatGpt: 'reviewed-by-chatgpt'
    },
    review: {
      decisionMode: 'marker-only',
      decisions: { stopOnLatestChangesRequested: true },
      markers: {
        approved: '<!-- chatgpt-review: approved -->',
        changesRequested: '<!-- chatgpt-review: changes_requested -->',
        excludeReviewRequestComments: true,
        ignoreInFencedCodeBlocks: true,
        reviewRequest: '<!-- chatgpt-review-request -->'
      },
      trustedActors: ['chatgpt-reviewer']
    },
    autoMerge: {
      allowBotApproval: false,
      allowDraft: false,
      allowFork: false,
      allowedBaseBranches: ['main'],
      cooldownSeconds: 0,
      deleteBranchAfterMerge: false,
      dryRun: true,
      duplicatePolicy: 'dedupe-key',
      enabled: true,
      manualMergePathPatterns: ['.github/**', 'package.json', 'package-lock.json', 'actions/**', 'scripts/**'],
      maxAdditions: 2000,
      maxChangedFiles: 100,
      maxDeletions: 2000,
      mergeMethod: 'squash',
      mode: 'enable-auto-merge',
      requireChatGPTReview: true,
      requireCurrentReview: true,
      requireHumanReview: false,
      requireResolvedThreads: true,
      requireSameRepository: true,
      requiredApprovals: 1,
      requiredWorkflows: ['CI'],
      sensitivePathPatterns: ['.github/**', 'package.json', 'package-lock.json', 'actions/**', 'scripts/**'],
      trustedReviewers: ['example-reviewer'],
      useMergeQueue: false,
      ...autoMergeOverrides
    },
    protectedFiles: {
      hardBlockPatterns: [],
      warningOnlyPatterns: []
    },
    secretLike: {
      hardBlockPatterns: ['secret', 'token', 'authorization', 'cookie', 'oauth', 'bearer'],
      warningOnlyPatterns: []
    },
    queues: {
      mainFollowup: { enabled: false },
      reviewFix: { enabled: false }
    },
    codex: {
      mainFollowup: { allowDraft: false, enabled: false, maxAttempts: 2, sameRepoOnly: true },
      reviewFix: { allowDraft: false, enabled: false, maxAttempts: 2, sameRepoOnly: true }
    },
    schedules: {
      actionsApproval: { enabled: false },
      autoMerge: { enabled: false },
      mainFollowup: { enabled: false },
      reviewRequest: { enabled: false }
    },
    secrets: {
      actionsApproverToken: 'ACTIONS_APPROVER_TOKEN',
      autoMergeToken: 'AUTO_MERGE_TOKEN',
      prBranchUpdateToken: 'PR_BRANCH_UPDATE_TOKEN',
      reviewRequestCommentToken: 'REVIEW_REQUEST_COMMENT_TOKEN'
    },
    variables: {
      codexTrigger: 'CODEX_TRIGGER_COMMENT',
      mainFollowupEnabled: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX',
      mainFollowupMaxAttempts: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX_MAX_ATTEMPTS',
      reviewFixMaxAttempts: 'CODEX_AUTO_FIX_MAX_ATTEMPTS'
    },
    ...rootOverrides
  };
}

export function chatGptMarker(status, overrides = {}) {
  return {
    body: `<!-- chatgpt-review: ${status} -->`,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    headSha: overrides.headSha ?? FIXTURE_SHAS.head,
    user: { login: overrides.actor ?? 'chatgpt-reviewer' }
  };
}

export function review(overrides = {}) {
  return {
    body: overrides.body ?? 'Fixture review approval',
    commit_id: overrides.commit_id ?? FIXTURE_SHAS.head,
    id: overrides.id ?? 'review-1',
    state: overrides.state ?? 'APPROVED',
    submitted_at: overrides.submitted_at ?? '2026-01-01T00:01:00.000Z',
    user: { login: overrides.actor ?? 'example-reviewer' }
  };
}

export function workflowRun(overrides = {}) {
  return {
    conclusion: overrides.conclusion ?? 'success',
    created_at: '2026-01-01T00:00:00.000Z',
    head_sha: overrides.headSha ?? FIXTURE_SHAS.head,
    id: overrides.id ?? 4001,
    name: overrides.name ?? 'CI',
    status: overrides.status ?? 'completed',
    updated_at: '2026-01-01T00:02:00.000Z'
  };
}

export function changedFile(filename, patch = '+ok', overrides = {}) {
  return {
    additions: overrides.additions ?? 1,
    changes: overrides.changes ?? 1,
    deletions: overrides.deletions ?? 0,
    filename,
    patch
  };
}

function successDecision() {
  return {
    adapterCalled: true,
    commandCreated: true,
    dryRun: true,
    eligible: true,
    executed: false
  };
}

function skippedDecision() {
  return {
    adapterCalled: false,
    commandCreated: false,
    dryRun: true,
    eligible: false,
    executed: false
  };
}

function mergeScenario(base, overrides) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? { ...result[key], ...value }
      : value;
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
