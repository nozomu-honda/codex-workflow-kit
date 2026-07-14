import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMainFollowUpDedupeKey,
  createMainFollowUpPlan,
  getMainFollowUpChangeState,
  MAIN_FOLLOW_UP_OUTPUT_NAMES
} from '../src/main-follow-up/index.js';
import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS,
  behindPr,
  binaryFile,
  conflictPr,
  deletedHeadBranchPr,
  dependencyChangeFile,
  divergedPr,
  forkPr,
  generatedDistFile,
  mergedPr,
  openSameRepoPr,
  protectedPathFile,
  pushDefaultBranch,
  pushFeatureBranch,
  secretLikeFile,
  submoduleFile,
  unknownMergeStatePr,
  upToDatePr,
  workflowChangeFile
} from '../../../fixtures/github-events/index.js';

test('default branch push後にopen PRをdeterministicに分類する', () => {
  const plan = createMainFollowUpPlan(baseInput({
    openPullRequests: [
      conflictPr({ pullRequestNumber: 44 }),
      upToDatePr({ pullRequestNumber: 42 }),
      behindPr({ pullRequestNumber: 43 })
    ]
  }));
  const plans = parsePlans(plan);

  assert.equal(plan.ok, true);
  assert.equal(plan.outputs.eligible, 'true');
  assert.equal(plan.outputs.trigger_type, 'default-branch-push');
  assert.equal(plan.outputs.scanned_pull_request_count, '3');
  assert.equal(plan.outputs.up_to_date_count, '1');
  assert.equal(plan.outputs.update_candidate_count, '1');
  assert.equal(plan.outputs.codex_follow_up_candidate_count, '1');
  assert.deepEqual(plans.map((entry) => entry.pull_request_number), ['42', '43', '44']);
  assert.equal(plans[0].action, 'up-to-date');
  assert.equal(plans[1].action, 'behind-update-candidate');
  assert.equal(plans[1].should_update_branch, true);
  assert.equal(plans[2].action, 'conflict-follow-up-candidate');
  assert.equal(plans[2].should_request_codex_follow_up, true);
  assert.deepEqual(Object.keys(plan.outputs).sort(), MAIN_FOLLOW_UP_OUTPUT_NAMES.toSorted());
});

test('merged pull_request.closedとworkflow_dispatchをmain follow-up triggerとして扱う', () => {
  const merged = createMainFollowUpPlan(baseInput({
    eventPayload: mergedPr({ baseRef: 'main' }),
    normalizedEvent: normalizedEvent({ event_name: 'pull_request', event_action: 'closed', head_sha: FIXTURE_SHAS.merge }),
    targetBaseSha: FIXTURE_SHAS.merge
  }));
  assert.equal(merged.outputs.eligible, 'true');
  assert.equal(merged.outputs.trigger_type, 'merged-pull-request');

  const manual = createMainFollowUpPlan(baseInput({
    eventPayload: { inputs: { base_branch: 'main' } },
    normalizedEvent: normalizedEvent({ event_name: 'workflow_dispatch', event_action: '', eligible: 'false', head_sha: '', ineligible_reason: 'missing manual pull request number' })
  }));
  assert.equal(manual.outputs.eligible, 'true');
  assert.equal(manual.outputs.trigger_type, 'manual-dispatch');

  assertSkip(createMainFollowUpPlan(baseInput({
    eventPayload: pushFeatureBranch(),
    normalizedEvent: normalizedEvent({ event_name: 'push', eligible: 'false', ineligible_reason: 'push target is not default branch' })
  })), /normalized_event_ineligible/);

  assertSkip(createMainFollowUpPlan(baseInput({
    eventPayload: mergedPr({ merged: false }),
    normalizedEvent: normalizedEvent({ event_name: 'pull_request', event_action: 'closed' })
  })), /pull_request_not_merged/);
});

test('safe update candidateはrequired label、same repo、head branch、attempt条件を満たす場合だけになる', () => {
  assert.equal(parsePlans(createMainFollowUpPlan(baseInput({
    openPullRequests: [behindPr()]
  })))[0].action, 'behind-update-candidate');

  for (const [pullRequest, pattern] of [
    [forkPr(), /not_same_repository|fork_not_allowed/],
    [behindPr({ labels: [] }), /required_label_missing/],
    [behindPr({ labels: ['auto-merge-after-ci', 'do-not-merge'] }), /blocked_label:do-not-merge/],
    [behindPr({ draft: true }), /draft_pr/],
    [deletedHeadBranchPr(), /head_branch_missing/],
    [behindPr({ attemptCount: 2 }), /attempt_limit_exceeded/]
  ]) {
    const entry = parsePlans(createMainFollowUpPlan(baseInput({ openPullRequests: [pullRequest] })))[0];
    assert.equal(entry.action, 'ineligible');
    assert.match(entry.skip_reason, pattern);
    assert.equal(entry.should_update_branch, false);
  }
});

test('dangerous changesはmanual review requiredになりCodex候補にしない', () => {
  for (const [changedFiles, expected] of [
    [[protectedPathFile()], 'workflow_change'],
    [[workflowChangeFile()], 'workflow_change'],
    [[dependencyChangeFile()], 'dependency_change'],
    [[generatedDistFile()], 'generated_dist_change'],
    [[binaryFile()], 'binary_or_submodule_change'],
    [[submoduleFile()], 'binary_or_submodule_change'],
    [[secretLikeFile()], 'secret_like_added_line']
  ]) {
    const entry = parsePlans(createMainFollowUpPlan(baseInput({
      openPullRequests: [behindPr({ changedFiles })]
    })))[0];
    assert.equal(entry.action, 'manual-review-required');
    assert.equal(entry.requires_manual_review, true);
    assert.equal(entry.should_request_codex_follow_up, false);
    assert.equal(entry.skip_reason, expected);
  }
});

test('conflictやupdate failureは安全条件内でCodex follow-up候補になる', () => {
  const conflict = parsePlans(createMainFollowUpPlan(baseInput({
    openPullRequests: [conflictPr()]
  })))[0];
  assert.equal(conflict.action, 'conflict-follow-up-candidate');
  assert.equal(conflict.should_request_codex_follow_up, true);

  const failed = parsePlans(createMainFollowUpPlan(baseInput({
    openPullRequests: [behindPr({ updateFailed: true })]
  })))[0];
  assert.equal(failed.action, 'update-failed-follow-up-candidate');
  assert.equal(failed.should_request_codex_follow_up, true);

  const disabled = parsePlans(createMainFollowUpPlan(baseInput({
    config: automationConfig({ mainFollowUp: { codexFollowUpEnabled: false } }),
    openPullRequests: [conflictPr()]
  })))[0];
  assert.equal(disabled.action, 'manual-review-required');
  assert.equal(disabled.should_request_codex_follow_up, false);
});

test('unknown mergeability、unknown compare、diff上限はmanual review required', () => {
  for (const pullRequest of [
    unknownMergeStatePr(),
    behindPr({ compare: {} }),
    behindPr({ changedFiles: Array.from({ length: 101 }, (_, index) => file(`docs/${index}.md`)) }),
    behindPr({ changedFiles: [file('docs/large.md', '+ok', { additions: 2001 })] })
  ]) {
    const entry = parsePlans(createMainFollowUpPlan(baseInput({ openPullRequests: [pullRequest] })))[0];
    assert.equal(entry.action, 'manual-review-required');
    assert.equal(entry.requires_manual_review, true);
  }
});

test('dedupe、cooldown、timestamp不正、API read failureはfail closed', () => {
  const dedupeKey = createMainFollowUpDedupeKey({
    baseSha: FIXTURE_SHAS.base,
    headSha: FIXTURE_SHAS.head,
    pullRequestNumber: '42',
    repository: FIXTURE_REPOSITORY.fullName
  });
  const duplicate = parsePlans(createMainFollowUpPlan(baseInput({
    existingDedupeKeys: [dedupeKey],
    openPullRequests: [behindPr()]
  })))[0];
  assert.equal(duplicate.action, 'ineligible');
  assert.equal(duplicate.duplicate_suppressed, true);

  const cooldown = parsePlans(createMainFollowUpPlan(baseInput({
    config: automationConfig({ mainFollowUp: { cooldownSeconds: 600 } }),
    now: '2026-01-01T00:05:00.000Z',
    openPullRequests: [behindPr({ lastAttemptedAt: '2026-01-01T00:00:00.000Z' })]
  })))[0];
  assert.equal(cooldown.action, 'ineligible');
  assert.equal(cooldown.cooldown_active, true);

  const invalidTimestamp = parsePlans(createMainFollowUpPlan(baseInput({
    config: automationConfig({ mainFollowUp: { cooldownSeconds: 600 } }),
    openPullRequests: [behindPr({ lastAttemptedAt: 'not-a-date' })]
  })))[0];
  assert.equal(invalidTimestamp.action, 'ineligible');
  assert.equal(invalidTimestamp.cooldown_active, true);

  assertSkip(createMainFollowUpPlan(baseInput({ apiReadError: 'github_api_403' })), /github_api_read_failed/);
});

test('config invalid、disabled、base不一致、open PR上限超過はglobal skip', () => {
  assertSkip(createMainFollowUpPlan(baseInput({ config: { mainFollowUp: { enabled: true } } })), /config_invalid/);
  assertSkip(createMainFollowUpPlan(baseInput({
    config: automationConfig({ mainFollowUp: { enabled: false } })
  })), /main_follow_up_disabled/);
  assertSkip(createMainFollowUpPlan(baseInput({
    config: automationConfig({ mainFollowUp: { allowedBaseBranches: ['develop'] } })
  })), /base_branch_not_allowed/);
  assertSkip(createMainFollowUpPlan(baseInput({
    openPullRequests: Array.from({ length: 101 }, (_, index) => behindPr({ pullRequestNumber: index + 1 }))
  })), /open_pull_requests_limit_exceeded/);
});

test('target base SHA不一致やscan race reasonはfail closedになる', () => {
  assertSkip(createMainFollowUpPlan(baseInput({
    eventPayload: pushDefaultBranch({ after: FIXTURE_SHAS.after }),
    normalizedEvent: normalizedEvent({ head_sha: FIXTURE_SHAS.base }),
    targetBaseSha: ''
  })), /base_sha_mismatch/);

  assertSkip(createMainFollowUpPlan(baseInput({
    scanError: 'base_sha_changed_during_scan'
  })), /base_sha_changed_during_scan/);

  const entry = parsePlans(createMainFollowUpPlan(baseInput({
    openPullRequests: [{
      ...behindPr({ baseSha: FIXTURE_SHAS.after }),
      snapshotError: 'pull_request_head_changed_during_scan'
    }]
  })))[0];
  assert.equal(entry.action, 'manual-review-required');
  assert.equal(entry.skip_reason, 'pull_request_head_changed_during_scan');
});

test('plan、global output、dedupe keyはtarget base SHAを共有する', () => {
  const plan = createMainFollowUpPlan(baseInput({
    eventPayload: pushDefaultBranch({ after: FIXTURE_SHAS.after }),
    normalizedEvent: normalizedEvent({ head_sha: FIXTURE_SHAS.after }),
    openPullRequests: [behindPr({ baseSha: FIXTURE_SHAS.after })],
    targetBaseSha: FIXTURE_SHAS.after
  }));
  const entry = parsePlans(plan)[0];

  assert.equal(plan.outputs.base_sha, FIXTURE_SHAS.after);
  assert.equal(entry.base_sha, FIXTURE_SHAS.after);
  assert.equal(entry.dedupe_key.includes(`:${FIXTURE_SHAS.after}:main-follow-up`), true);
});

test('change helperは危険変更を分類しtoken実値を出さない', () => {
  const state = getMainFollowUpChangeState({
    changedFiles: [
      workflowChangeFile(),
      dependencyChangeFile(),
      generatedDistFile(),
      binaryFile(),
      secretLikeFile()
    ],
    config: automationConfig().mainFollowUp
  });

  assert.equal(state.workflowChange, true);
  assert.equal(state.dependencyChange, true);
  assert.equal(state.generatedDistChange, true);
  assert.equal(state.binaryOrSubmoduleChange, true);
  assert.equal(state.secretLikeChange, true);
  assert.equal(JSON.stringify(createMainFollowUpPlan(baseInput())).includes('gho_'), false);
});

function baseInput(overrides = {}) {
  return {
    config: automationConfig(),
    eventPayload: pushDefaultBranch({ after: FIXTURE_SHAS.base }),
    existingDedupeKeys: [],
    normalizedEvent: normalizedEvent(),
    now: '2026-01-01T00:00:00.000Z',
    openPullRequests: [behindPr()],
    targetBaseSha: FIXTURE_SHAS.base,
    ...overrides
  };
}

function automationConfig(overrides = {}) {
  const { mainFollowUp: mainFollowUpOverrides = {}, ...rootOverrides } = overrides;

  return {
    version: 1,
    baseBranch: 'main',
    ciWorkflowName: 'CI',
    dryRunDefault: true,
    features: {
      autoRequest: false,
      routeReview: false,
      autoMerge: false,
      mainFollowup: true,
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
    mainFollowUp: {
      enabled: true,
      dryRun: true,
      allowedBaseBranches: ['main'],
      requiredLabels: ['auto-merge-after-ci'],
      blockedLabels: ['do-not-merge', 'needs-codex-fix', 'codex-fix-in-progress', 'do-not-auto-codex-main-followup', 'codex-main-followup-in-progress'],
      allowDraft: false,
      requireSameRepository: true,
      allowFork: false,
      maxAttempts: 2,
      cooldownSeconds: 0,
      maxOpenPullRequests: 100,
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      sensitivePathPatterns: ['.github/**', 'scripts/**', 'actions/**'],
      protectedPathPatterns: ['.github/**', 'scripts/**', 'actions/**'],
      workflowPathPatterns: ['.github/workflows/**', '.github/actions/**'],
      dependencyPathPatterns: ['package.json', 'package-lock.json'],
      generatedPathPatterns: ['actions/**/dist/**', '**/dist/**'],
      duplicatePolicy: 'dedupe-key',
      codexFollowUpEnabled: true,
      ...mainFollowUpOverrides
    },
    review: {
      markers: {
        approved: '<!-- chatgpt-review: approved -->',
        changesRequested: '<!-- chatgpt-review: changes_requested -->',
        reviewRequest: '<!-- chatgpt-review-request -->',
        ignoreInFencedCodeBlocks: true,
        excludeReviewRequestComments: true
      }
    },
    protectedFiles: { hardBlockPatterns: [], warningOnlyPatterns: [] },
    secretLike: { hardBlockPatterns: ['secret', 'token', 'authorization'], warningOnlyPatterns: [] },
    queues: { reviewFix: { enabled: false }, mainFollowup: { enabled: false } },
    codex: { reviewFix: { enabled: false }, mainFollowup: { enabled: false } },
    schedules: { reviewRequest: { enabled: false }, autoMerge: { enabled: false }, mainFollowup: { enabled: false }, actionsApproval: { enabled: false } },
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
    default_branch: 'main',
    eligible: 'true',
    event_action: '',
    event_name: 'push',
    head_sha: FIXTURE_SHAS.base,
    repository: FIXTURE_REPOSITORY.fullName,
    ...overrides
  };
}

function parsePlans(plan) {
  return JSON.parse(plan.outputs.plans_json);
}

function assertSkip(plan, pattern) {
  assert.equal(plan.ok, false);
  assert.equal(plan.outputs.eligible, 'false');
  assert.match(plan.outputs.skip_reason, pattern);
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
