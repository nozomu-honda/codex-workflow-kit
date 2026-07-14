import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoMergePlan, createAutoMergeDedupeKey, getChangeState, getCiState, getReviewState } from '../src/auto-merge/index.js';
import { listReviewThreads } from '../../../scripts/plan-auto-merge.mjs';
import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS,
  draftPr,
  failedWorkflowRun,
  forkReview,
  mergedPr,
  sameRepoReview,
  successfulWorkflowRun
} from '../../../fixtures/github-events/index.js';

test('same-repo open PR、current approval、CI successならdry-run merge planを生成する', () => {
  const plan = createAutoMergePlan(baseInput());

  assert.equal(plan.ok, true);
  assert.equal(plan.outputs.eligible, 'true');
  assert.equal(plan.outputs.should_enable_auto_merge, 'true');
  assert.equal(plan.outputs.should_merge, 'false');
  assert.equal(plan.outputs.merge_reason, 'eligible_enable_auto_merge');
  assert.equal(plan.outputs.review_is_current, 'true');
  assert.equal(plan.outputs.ci_satisfied, 'true');
  assert.equal(plan.outputs.dry_run, 'true');
  assert.equal(plan.outputs.dedupe_key, `${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:enable-auto-merge:v1`);
});

test('信頼済みChatGPT actorのcurrent-head markerだけをChatGPT承認にする', () => {
  assertSkip(createAutoMergePlan(baseInput({
    issueComments: [chatGptMarker('approved', { actor: 'external-user' })]
  })), /chatgpt_review_missing/);
  assertSkip(createAutoMergePlan(baseInput({
    issueComments: [chatGptMarker('approved', { headSha: FIXTURE_SHAS.before })]
  })), /chatgpt_review_missing|review_not_current|approval_missing/);

  const trusted = createAutoMergePlan(baseInput({
    issueComments: [chatGptMarker('approved')]
  }));
  assert.equal(trusted.outputs.eligible, 'true');
  assert.equal(trusted.outputs.review_is_current, 'true');
});

test('plan-only modeはeligibleでもwrite相当outputを出さない', () => {
  const plan = createAutoMergePlan(baseInput({
    config: automationConfig({ autoMerge: { mode: 'plan-only' } })
  }));

  assert.equal(plan.ok, true);
  assert.equal(plan.outputs.eligible, 'true');
  assert.equal(plan.outputs.should_enable_auto_merge, 'false');
  assert.equal(plan.outputs.should_merge, 'false');
  assert.equal(plan.outputs.merge_reason, 'eligible_plan_only');
});

test('immediate-merge modeはdry-run planとしてshould_mergeだけを示す', () => {
  const plan = createAutoMergePlan(baseInput({
    config: automationConfig({ autoMerge: { mode: 'immediate-merge' } })
  }));

  assert.equal(plan.ok, true);
  assert.equal(plan.outputs.should_merge, 'true');
  assert.equal(plan.outputs.dry_run, 'true');
});

test('fork、external、draft、closed、merged、base不一致、head mismatchはskipする', () => {
  assertSkip(createAutoMergePlan(baseInput({
    pullRequest: pullRequest({ headRepository: 'fork/repo', fork: true }),
    normalizedEvent: normalizedEvent({ head_repository: 'fork/repo', is_same_repository: 'false', is_fork: 'true' })
  })), /not_same_repository|fork_not_allowed/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ draft: true }) })), /draft_pr/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ state: 'closed' }) })), /pr_not_open/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ state: 'closed', merged: true }) })), /pr_already_merged/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ baseRef: 'develop' }) })), /base_branch_not_allowed/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) })), /head_sha_mismatch/);
});

test('stale head、stale approval、changes requested、approval不足、未解決threadをskipする', () => {
  assertSkip(createAutoMergePlan(baseInput({ comparison: { behind_by: 1, status: 'behind' } })), /stale_head/);
  assertSkip(createAutoMergePlan(baseInput({
    issueComments: [],
    reviews: [approvalReview({ commit_id: FIXTURE_SHAS.before })]
  })), /chatgpt_review_missing|review_not_current|approval_missing/);
  assertSkip(createAutoMergePlan(baseInput({ issueComments: [chatGptMarker('changes_requested')] })), /changes_requested/);
  assertSkip(createAutoMergePlan(baseInput({
    config: automationConfig({ autoMerge: { requiredApprovals: 3 } })
  })), /approval_missing/);
  assertSkip(createAutoMergePlan(baseInput({ reviewThreads: [{ isResolved: false }] })), /unresolved_review_threads/);
});

test('bot approval禁止、dismissed review、人間review必須を判定する', () => {
  assertSkip(createAutoMergePlan(baseInput({
    config: automationConfig({ autoMerge: { requireChatGPTReview: false } }),
    issueComments: [],
    reviews: [approvalReview({ actor: 'review-bot[bot]', commit_id: FIXTURE_SHAS.head })]
  })), /approval_missing|review_not_current/);
  assertSkip(createAutoMergePlan(baseInput({
    reviews: [approvalReview({ state: 'DISMISSED', commit_id: FIXTURE_SHAS.head })]
  })), /dismissed_review/);
  assertSkip(createAutoMergePlan(baseInput({
    config: automationConfig({ autoMerge: { requireHumanReview: true } }),
    reviews: []
  })), /human_review_missing/);
  assertSkip(createAutoMergePlan(baseInput({
    config: automationConfig({ autoMerge: { requireChatGPTReview: false } }),
    issueComments: [],
    reviews: [approvalReview({ actor: 'external-user' })]
  })), /approval_missing|review_not_current/);
});

test('reviewerごとの最新current-head reviewだけをapprovalとして数える', () => {
  const duplicateApprovals = getReviewState({
    autoMergeConfig: automationConfig().autoMerge,
    config: automationConfig(),
    headSha: FIXTURE_SHAS.head,
    issueComments: [],
    reviews: [
      approvalReview({ actor: 'owner', submitted_at: '2026-01-01T01:00:00.000Z' }),
      approvalReview({ actor: 'owner', submitted_at: '2026-01-01T02:00:00.000Z' })
    ]
  });
  assert.equal(duplicateApprovals.humanApprovalCount, 1);
  assert.equal(duplicateApprovals.approvalCount, 1);

  const differentReviewerDoesNotClearChanges = getReviewState({
    autoMergeConfig: automationConfig().autoMerge,
    config: automationConfig(),
    headSha: FIXTURE_SHAS.head,
    issueComments: [],
    reviews: [
      approvalReview({ actor: 'owner', state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T01:00:00.000Z' }),
      approvalReview({ actor: 'trusted-human', submitted_at: '2026-01-01T02:00:00.000Z' })
    ]
  });
  assert.equal(differentReviewerDoesNotClearChanges.changesRequested, true);

  const sameReviewerCurrentApprovalClearsChanges = getReviewState({
    autoMergeConfig: automationConfig().autoMerge,
    config: automationConfig(),
    headSha: FIXTURE_SHAS.head,
    issueComments: [],
    reviews: [
      approvalReview({ actor: 'owner', state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T01:00:00.000Z' }),
      approvalReview({ actor: 'owner', submitted_at: '2026-01-01T02:00:00.000Z' })
    ]
  });
  assert.equal(sameReviewerCurrentApprovalClearsChanges.changesRequested, false);
  assert.equal(sameReviewerCurrentApprovalClearsChanges.humanApprovalCount, 1);

  const staleApproval = getReviewState({
    autoMergeConfig: automationConfig().autoMerge,
    config: automationConfig(),
    headSha: FIXTURE_SHAS.head,
    issueComments: [],
    reviews: [approvalReview({ actor: 'owner', commit_id: FIXTURE_SHAS.before })]
  });
  assert.equal(staleApproval.humanApprovalCount, 0);
  assert.equal(staleApproval.reviewIsCurrent, false);
});

test('CI pending / failure / cancelled / skippedはfail closedにする', () => {
  assertSkip(createAutoMergePlan(baseInput({ workflowRuns: [] })), /required_ci_pending/);
  assertSkip(createAutoMergePlan(baseInput({ workflowRuns: [workflowRun({ conclusion: 'failure' })] })), /required_ci_failed/);
  assertSkip(createAutoMergePlan(baseInput({ workflowRuns: [workflowRun({ conclusion: 'cancelled' })] })), /required_ci_failed/);
  assertSkip(createAutoMergePlan(baseInput({ workflowRuns: [workflowRun({ conclusion: 'skipped' })] })), /required_ci_failed/);
});

test('merge conflict、mergeable unknown、repository method不許可をskipする', () => {
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ mergeable: false }) })), /merge_conflict/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ mergeable: null }) })), /mergeable_unknown/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ mergeableStateStatus: 'dirty' }) })), /merge_conflict/);
  assertSkip(createAutoMergePlan(baseInput({ pullRequest: pullRequest({ mergeableStateStatus: 'blocked' }) })), /merge_state_blocked/);
  assertSkip(createAutoMergePlan(baseInput({ repositorySettings: { allow_squash_merge: false } })), /repository_setting_disallows_merge_method/);
});

test('dangerous workflow、dependency、generated dist、secret-like、diff上限をskipする', () => {
  assertSkip(createAutoMergePlan(baseInput({ changedFiles: [file('.github/workflows/ci.yml')] })), /workflow_change_requires_manual_merge/);
  assertSkip(createAutoMergePlan(baseInput({ changedFiles: [file('package.json')] })), /dependency_change_requires_manual_merge/);
  assertSkip(createAutoMergePlan(baseInput({ changedFiles: [file('actions/example/dist/index.js')] })), /generated_dist_requires_manual_merge|sensitive_changed_file/);
  assertSkip(createAutoMergePlan(baseInput({ changedFiles: [file('docs/test.md', '+const token = "dummy";')] })), /secret_like_added_line/);
  assertSkip(createAutoMergePlan(baseInput({
    changedFiles: Array.from({ length: 101 }, (_, index) => file(`docs/${index}.md`))
  })), /changed_files_limit_exceeded/);
  assertSkip(createAutoMergePlan(baseInput({ changedFiles: [file('docs/large.md', '+ok', { additions: 2001 })] })), /diff_additions_limit_exceeded/);
});

test('duplicate、cooldown、config不正、API read失敗、label不足をskipする', () => {
  const dedupeKey = createAutoMergeDedupeKey({
    repository: FIXTURE_REPOSITORY.fullName,
    pullRequestNumber: '42',
    headSha: FIXTURE_SHAS.head,
    mergeMode: 'enable-auto-merge',
    configVersion: 1
  });

  assertSkip(createAutoMergePlan(baseInput({ existingDedupeKeys: [dedupeKey] })), /duplicate_suppressed/);
  assertSkip(createAutoMergePlan(baseInput({
    config: automationConfig({ autoMerge: { cooldownSeconds: 600 } }),
    lastPlannedAt: '2026-01-01T00:00:00.000Z',
    now: '2026-01-01T00:05:00.000Z'
  })), /cooldown_active/);
  assertSkip(createAutoMergePlan(baseInput({ config: { autoMerge: { enabled: true } } })), /config_invalid/);
  assertSkip(createAutoMergePlan(baseInput({ apiReadError: 'github_api_403' })), /github_api_read_failed/);
  assertSkip(createAutoMergePlan(baseInput({
    pullRequest: pullRequest({ labels: ['reviewed-by-chatgpt'] })
  })), /auto_merge_label_missing/);
  assertSkip(createAutoMergePlan(baseInput({
    pullRequest: pullRequest({ labels: ['auto-merge-after-ci'] })
  })), /reviewed_by_chatgpt_label_missing/);
});

test('review state helperはhuman / ChatGPT / stale / unresolvedを分類する', () => {
  const state = getReviewState({
    autoMergeConfig: automationConfig().autoMerge,
    config: automationConfig(),
    headSha: FIXTURE_SHAS.head,
    issueComments: [chatGptMarker('approved')],
    reviewThreads: [{ isResolved: false }],
    reviews: [approvalReview()]
  });

  assert.equal(state.approvalCount, 2);
  assert.equal(state.humanApprovalCount, 1);
  assert.equal(state.chatGptReviewCurrent, true);
  assert.equal(state.unresolvedReviewThreads, 1);
});

test('101件目以降の未解決threadとrequested team reviewerでblockする', () => {
  const reviewThreads = [
    ...Array.from({ length: 100 }, () => ({ isResolved: true })),
    { isResolved: false }
  ];

  assertSkip(createAutoMergePlan(baseInput({ reviewThreads })), /unresolved_review_threads/);
  assertSkip(createAutoMergePlan(baseInput({
    pullRequest: pullRequest({ requestedTeams: 1 })
  })), /requested_reviewers_remaining/);
});

test('GraphQL reviewThreads paginationを全ページ取得し、途中失敗はfail closedへ渡せる', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.variables.cursor ?? null);

    if (calls.length === 1) {
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: Array.from({ length: 100 }, () => ({ isResolved: true })),
                pageInfo: { hasNextPage: true, endCursor: 'cursor-100' }
              }
            }
          }
        }
      });
    }

    return jsonResponse({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: false }],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      }
    });
  };

  const threads = await listReviewThreads({
    fetchImpl,
    githubApiUrl: 'https://api.github.test',
    githubToken: 'test-token',
    pullRequestNumber: 42,
    repository: FIXTURE_REPOSITORY.fullName
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [null, 'cursor-100']);
  assert.equal(threads.length, 101);
  assert.equal(threads[100].isResolved, false);

  await assert.rejects(() => listReviewThreads({
    fetchImpl: async () => jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true, endCursor: '' } } } } } }),
    githubApiUrl: 'https://api.github.test',
    githubToken: 'test-token',
    pullRequestNumber: 42,
    repository: FIXTURE_REPOSITORY.fullName
  }), /github_graphql_missing_review_threads_cursor/);

  assertSkip(createAutoMergePlan(baseInput({ apiReadError: 'github_graphql_missing_review_threads_cursor' })), /github_api_read_failed/);
});

test('CI helperはworkflow run / check run / commit statusを同じheadで見る', () => {
  assert.equal(getCiState({
    config: automationConfig(),
    headSha: FIXTURE_SHAS.head,
    workflowRuns: [workflowRun()],
    checkRuns: [],
    commitStatuses: []
  }).satisfied, true);
  assert.equal(getCiState({
    config: automationConfig({ autoMerge: { requiredWorkflows: ['Required Check'] } }),
    headSha: FIXTURE_SHAS.head,
    workflowRuns: [],
    checkRuns: [{ name: 'Required Check', head_sha: FIXTURE_SHAS.head, status: 'completed', conclusion: 'success' }],
    commitStatuses: []
  }).satisfied, true);
  assert.equal(getCiState({
    config: automationConfig({ autoMerge: { requiredWorkflows: ['legacy/status'] } }),
    headSha: FIXTURE_SHAS.head,
    workflowRuns: [],
    checkRuns: [],
    commitStatuses: [{ context: 'legacy/status', state: 'success' }]
  }).satisfied, true);
});

test('change helperはsecret-likeとmanual merge対象を検出する', () => {
  const state = getChangeState({
    autoMergeConfig: automationConfig().autoMerge,
    changedFiles: [
      file('.github/workflows/ci.yml'),
      file('docs/test.md', '+authorization: "dummy"')
    ]
  });

  assert.equal(state.workflowChange, true);
  assert.equal(state.secretLikeChange, true);
  assert.equal(state.sensitiveChange, true);
});

test('fixture buildersをauto-merge判定入力に再利用できる', () => {
  const review = sameRepoReview({ body: '<!-- chatgpt-review: approved -->' });
  const fork = forkReview();
  const success = successfulWorkflowRun();
  const failure = failedWorkflowRun();
  const merged = mergedPr();
  const draft = draftPr();

  assert.equal(review.pull_request.head.sha, FIXTURE_SHAS.head);
  assert.equal(fork.pull_request.head.repo.full_name, 'fork-owner/example-repo');
  assert.equal(success.workflow_run.conclusion, 'success');
  assert.equal(failure.workflow_run.conclusion, 'failure');
  assert.equal(merged.pull_request.merged, true);
  assert.equal(draft.pull_request.draft, true);
});

function baseInput(overrides = {}) {
  return {
    changedFiles: [file('docs/change.md')],
    checkRuns: [],
    commitStatuses: [],
    comparison: { behind_by: 0, status: 'ahead' },
    config: automationConfig(),
    issueComments: [chatGptMarker('approved')],
    normalizedEvent: normalizedEvent(),
    pullRequest: pullRequest(),
    repositorySettings: { allow_squash_merge: true, allow_auto_merge: true },
    reviewThreads: [],
    reviews: [approvalReview()],
    workflowRuns: [workflowRun()],
    ...overrides
  };
}

function automationConfig(overrides = {}) {
  const { autoMerge: autoMergeOverrides = {}, ...rootOverrides } = overrides;

  return {
    version: 1,
    baseBranch: 'main',
    ciWorkflowName: 'CI',
    mergeMethod: 'squash',
    dryRunDefault: true,
    features: {
      autoRequest: false,
      routeReview: false,
      autoMerge: true,
      mainFollowup: false,
      actionsApproval: false
    },
    labels: {
      needsChatGptReview: 'needs-chatgpt-review',
      reviewedByChatGpt: 'reviewed-by-chatgpt',
      needsCodexFix: 'needs-codex-fix',
      codexFixInProgress: 'codex-fix-in-progress',
      autoMergeAfterCi: 'auto-merge-after-ci',
      doNotMerge: 'do-not-merge',
      doNotAutoReviewRequest: 'do-not-auto-review-request',
      doNotAutoCodexFix: 'do-not-auto-codex-fix',
      doNotAutoCodexMainFollowup: 'do-not-auto-codex-main-followup',
      codexMainFollowupInProgress: 'codex-main-followup-in-progress',
      doNotAutoApproveActions: 'do-not-auto-approve-actions'
    },
    review: {
      decisionMode: 'marker-only',
      trustedActors: ['chatgpt-reviewer'],
      markers: {
        approved: '<!-- chatgpt-review: approved -->',
        changesRequested: '<!-- chatgpt-review: changes_requested -->',
        reviewRequest: '<!-- chatgpt-review-request -->',
        ignoreInFencedCodeBlocks: true,
        excludeReviewRequestComments: true
      },
      decisions: {
        stopOnLatestChangesRequested: true
      }
    },
    reviewRouting: {
      enabled: false,
      dryRun: true,
      allowedBaseBranches: ['main'],
      acceptedTriggerTypes: ['ci-success'],
      commands: ['/chatgpt-review'],
      requestLabels: ['needs-chatgpt-review'],
      reviewerNames: [],
      trustedHumanActors: [],
      trustedBotActors: [],
      allowDraft: false,
      allowFork: false,
      requireSameRepository: true,
      requiredWorkflows: ['CI'],
      ignoredPathPatterns: [],
      sensitivePathPatterns: ['.github/**'],
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      cooldownSeconds: 0,
      duplicatePolicy: 'dedupe-key'
    },
    autoMerge: {
      enabled: true,
      dryRun: true,
      mode: 'enable-auto-merge',
      mergeMethod: 'squash',
      allowedBaseBranches: ['main'],
      requireSameRepository: true,
      allowFork: false,
      requiredApprovals: 1,
      allowBotApproval: false,
      trustedReviewers: ['owner', 'trusted-human'],
      requiredWorkflows: ['CI'],
      requireResolvedThreads: true,
      allowDraft: false,
      sensitivePathPatterns: ['.github/**', 'package.json', 'package-lock.json', 'actions/**', 'scripts/**'],
      manualMergePathPatterns: ['.github/**', 'package.json', 'package-lock.json', 'actions/**', 'scripts/**'],
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      requireChatGPTReview: true,
      requireHumanReview: false,
      requireCurrentReview: true,
      duplicatePolicy: 'dedupe-key',
      cooldownSeconds: 0,
      deleteBranchAfterMerge: false,
      useMergeQueue: false,
      ...autoMergeOverrides
    },
    protectedFiles: {
      hardBlockPatterns: [],
      warningOnlyPatterns: []
    },
    secretLike: {
      hardBlockPatterns: ['secret', 'token', 'authorization'],
      warningOnlyPatterns: []
    },
    queues: {
      reviewFix: { enabled: false },
      mainFollowup: { enabled: false }
    },
    codex: {
      reviewFix: { enabled: false, maxAttempts: 2, sameRepoOnly: true, allowDraft: false },
      mainFollowup: { enabled: false, maxAttempts: 2, sameRepoOnly: true, allowDraft: false }
    },
    schedules: {
      reviewRequest: { enabled: false },
      autoMerge: { enabled: false },
      mainFollowup: { enabled: false },
      actionsApproval: { enabled: false }
    },
    secrets: {
      reviewRequestCommentToken: 'REVIEW_REQUEST_COMMENT_TOKEN',
      prBranchUpdateToken: 'PR_BRANCH_UPDATE_TOKEN',
      autoMergeToken: 'AUTO_MERGE_TOKEN',
      actionsApproverToken: 'ACTIONS_APPROVER_TOKEN'
    },
    variables: {
      codexTrigger: 'CODEX_TRIGGER_COMMENT',
      mainFollowupEnabled: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX',
      reviewFixMaxAttempts: 'CODEX_AUTO_FIX_MAX_ATTEMPTS',
      mainFollowupMaxAttempts: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX_MAX_ATTEMPTS'
    },
    ...rootOverrides
  };
}

function normalizedEvent(overrides = {}) {
  return {
    actor: 'owner',
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

function pullRequest(overrides = {}) {
  const labels = overrides.labels ?? ['auto-merge-after-ci', 'reviewed-by-chatgpt'];
  return {
    base: {
      ref: overrides.baseRef ?? 'main',
      sha: FIXTURE_SHAS.base,
      repo: { full_name: FIXTURE_REPOSITORY.fullName }
    },
    body: '## Validation\n- npm test',
    draft: overrides.draft ?? false,
    head: {
      ref: 'feature/example',
      sha: overrides.headSha ?? FIXTURE_SHAS.head,
      repo: {
        fork: overrides.fork ?? false,
        full_name: overrides.headRepository ?? FIXTURE_REPOSITORY.fullName
      }
    },
    labels: labels.map((name) => ({ name })),
    mergeable: Object.hasOwn(overrides, 'mergeable') ? overrides.mergeable : true,
    mergeable_state: overrides.mergeableStateStatus ?? 'clean',
    merged: overrides.merged ?? false,
    number: 42,
    requested_reviewers: Array.from({ length: overrides.requestedReviewers ?? 0 }, (_, index) => ({ login: `reviewer-${index}` })),
    requested_teams: Array.from({ length: overrides.requestedTeams ?? 0 }, (_, index) => ({ slug: `team-${index}` })),
    state: overrides.state ?? 'open',
    title: 'Fixture PR',
    user: { login: 'author' }
  };
}

function approvalReview(overrides = {}) {
  return {
    body: overrides.body ?? 'Looks good',
    commit_id: overrides.commit_id ?? FIXTURE_SHAS.head,
    state: overrides.state ?? 'APPROVED',
    submitted_at: overrides.submitted_at ?? '2026-01-01T01:00:00.000Z',
    user: { login: overrides.actor ?? 'owner' }
  };
}

function chatGptMarker(status, overrides = {}) {
  return {
    body: `<!-- chatgpt-review: ${status} -->`,
    created_at: overrides.created_at ?? '2026-01-01T02:00:00.000Z',
    headSha: overrides.headSha ?? FIXTURE_SHAS.head,
    user: { login: overrides.actor ?? 'chatgpt-reviewer' }
  };
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload
  };
}

function workflowRun(overrides = {}) {
  return {
    conclusion: overrides.conclusion ?? 'success',
    created_at: '2026-01-01T00:00:00.000Z',
    head_sha: overrides.headSha ?? FIXTURE_SHAS.head,
    id: overrides.id ?? 1,
    name: overrides.name ?? 'CI',
    status: overrides.status ?? 'completed',
    updated_at: overrides.updated_at ?? '2026-01-01T00:10:00.000Z'
  };
}

function file(filename, patch = '+ok', overrides = {}) {
  return {
    additions: overrides.additions ?? 1,
    changes: overrides.changes ?? 1,
    deletions: overrides.deletions ?? 0,
    filename,
    patch
  };
}

function assertSkip(plan, pattern) {
  assert.equal(plan.ok, false);
  assert.equal(plan.outputs.eligible, 'false');
  assert.match(plan.outputs.skip_reason, pattern);
}
