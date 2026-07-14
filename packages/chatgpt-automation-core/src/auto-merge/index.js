import {
  DEFAULT_AUTO_MERGE,
  DEFAULT_LABELS,
  DEFAULT_SECRET_LIKE_PATTERNS,
  validateAutomationConfigObject
} from '../config/index.js';
import {
  classifyActorTrust,
  detectReviewDecision,
  hasSecretLikeAddedLine
} from '../review-routing/index.js';

export const AUTO_MERGE_OUTPUT_NAMES = Object.freeze([
  'should_merge',
  'should_enable_auto_merge',
  'merge_mode',
  'merge_method',
  'merge_reason',
  'skip_reason',
  'repository',
  'pull_request_number',
  'base_branch',
  'head_branch',
  'head_sha',
  'base_sha',
  'is_same_repository',
  'is_fork',
  'is_draft',
  'mergeable',
  'merge_state_status',
  'approval_count',
  'required_approval_count',
  'changes_requested',
  'unresolved_review_threads',
  'review_is_current',
  'ci_required',
  'ci_satisfied',
  'required_checks',
  'sensitive_change',
  'secret_like_change',
  'workflow_change',
  'dependency_change',
  'duplicate_suppressed',
  'dry_run',
  'eligible',
  'dedupe_key'
]);

const EMPTY_OUTPUTS = Object.freeze({
  should_merge: 'false',
  should_enable_auto_merge: 'false',
  merge_mode: 'plan-only',
  merge_method: 'squash',
  merge_reason: '',
  skip_reason: '',
  repository: '',
  pull_request_number: '',
  base_branch: '',
  head_branch: '',
  head_sha: '',
  base_sha: '',
  is_same_repository: 'false',
  is_fork: 'false',
  is_draft: 'false',
  mergeable: 'unknown',
  merge_state_status: 'unknown',
  approval_count: '0',
  required_approval_count: '1',
  changes_requested: 'false',
  unresolved_review_threads: '0',
  review_is_current: 'false',
  ci_required: 'true',
  ci_satisfied: 'false',
  required_checks: '[]',
  sensitive_change: 'false',
  secret_like_change: 'false',
  workflow_change: 'false',
  dependency_change: 'false',
  duplicate_suppressed: 'false',
  dry_run: 'true',
  eligible: 'false',
  dedupe_key: ''
});

const BLOCKED_MERGE_STATES = new Set(['dirty', 'blocked', 'unknown']);
const SUPPORTED_TRIGGER_EVENTS = new Set([
  'workflow_run',
  'check_suite',
  'check_run',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request',
  'workflow_dispatch'
]);

export function createAutoMergePlan(input = {}) {
  const rawConfig = input.config ?? {};
  const configResult = rawConfig.autoMerge
    ? validateAutomationConfigObject(rawConfig)
    : {
        ok: true,
        config: {
          version: 1,
          baseBranch: input.baseBranch ?? '',
          ciWorkflowName: input.ciWorkflowName ?? '',
          labels: { ...DEFAULT_LABELS },
          review: {},
          autoMerge: { ...DEFAULT_AUTO_MERGE }
        }
      };
  const config = configResult.config ?? {
    version: 1,
    baseBranch: '',
    ciWorkflowName: '',
    labels: { ...DEFAULT_LABELS },
    review: {},
    autoMerge: { ...DEFAULT_AUTO_MERGE }
  };
  const autoMergeConfig = config.autoMerge ?? DEFAULT_AUTO_MERGE;
  const normalizedEvent = normalizeEventOutputs(input.normalizedEvent);
  const eventPayload = readPayload(input.eventPayload);
  const pullRequest = normalizePullRequest(input.pullRequest, normalizedEvent);
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const reviewState = getReviewState({
    autoMergeConfig,
    config,
    headSha: pullRequest.headSha,
    issueComments: input.issueComments,
    pullRequest,
    reviewThreads: input.reviewThreads,
    reviews: input.reviews
  });
  const ciState = getCiState({
    checkRuns: input.checkRuns,
    commitStatuses: input.commitStatuses,
    config,
    headSha: pullRequest.headSha,
    workflowRuns: input.workflowRuns
  });
  const changeState = getChangeState({
    autoMergeConfig,
    changedFiles,
    secretLikePatterns: input.secretLikePatterns ?? config.secretLike?.hardBlockPatterns ?? DEFAULT_SECRET_LIKE_PATTERNS
  });
  const repositorySettings = normalizeRepositorySettings(input.repositorySettings);
  const comparison = normalizeComparison(input.comparison);
  const actorTrust = classifyActorTrust({
    actor: normalizedEvent.actor,
    repositoryOwner: normalizedEvent.repository_owner,
    pullRequest,
    actorInfo: input.actorInfo,
    config: {
      trustedHumanActors: autoMergeConfig.trustedReviewers,
      trustedBotActors: []
    }
  });
  const dedupeKey = createAutoMergeDedupeKey({
    repository: normalizedEvent.repository,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    mergeMode: autoMergeConfig.mode,
    configVersion: config.version ?? 1
  });
  const duplicateSuppressed = isDuplicateSuppressed({
    dedupeKey,
    duplicatePolicy: autoMergeConfig.duplicatePolicy,
    existingDedupeKeys: input.existingDedupeKeys
  });
  const cooldownActive = isCooldownActive({
    cooldownSeconds: autoMergeConfig.cooldownSeconds,
    lastPlannedAt: input.lastPlannedAt,
    now: input.now
  });
  const outputs = {
    ...EMPTY_OUTPUTS,
    merge_mode: autoMergeConfig.mode,
    merge_method: autoMergeConfig.mergeMethod,
    repository: normalizedEvent.repository,
    pull_request_number: pullRequest.number,
    base_branch: pullRequest.baseRef,
    head_branch: pullRequest.headRef,
    head_sha: pullRequest.headSha,
    base_sha: pullRequest.baseSha,
    is_same_repository: pullRequest.isSameRepository ? 'true' : 'false',
    is_fork: pullRequest.isFork ? 'true' : 'false',
    is_draft: pullRequest.draft ? 'true' : 'false',
    mergeable: stringifyMergeable(pullRequest.mergeable),
    merge_state_status: pullRequest.mergeStateStatus,
    approval_count: String(reviewState.approvalCount),
    required_approval_count: String(autoMergeConfig.requiredApprovals),
    changes_requested: reviewState.changesRequested ? 'true' : 'false',
    unresolved_review_threads: String(reviewState.unresolvedReviewThreads),
    review_is_current: reviewState.reviewIsCurrent ? 'true' : 'false',
    ci_required: ciState.required ? 'true' : 'false',
    ci_satisfied: ciState.satisfied ? 'true' : 'false',
    required_checks: JSON.stringify(ciState.checks),
    sensitive_change: changeState.sensitiveChange ? 'true' : 'false',
    secret_like_change: changeState.secretLikeChange ? 'true' : 'false',
    workflow_change: changeState.workflowChange ? 'true' : 'false',
    dependency_change: changeState.dependencyChange ? 'true' : 'false',
    duplicate_suppressed: duplicateSuppressed ? 'true' : 'false',
    dry_run: autoMergeConfig.dryRun ? 'true' : 'false',
    dedupe_key: dedupeKey
  };

  const skipReason = firstSkipReason([
    !configResult.ok && 'config_invalid',
    input.apiReadError && `github_api_read_failed:${input.apiReadError}`,
    !autoMergeConfig.enabled && 'auto_merge_disabled',
    !SUPPORTED_TRIGGER_EVENTS.has(normalizedEvent.event_name) && `unsupported_event:${normalizedEvent.event_name || 'unknown'}`,
    normalizedEvent.eligible !== 'true' && `normalized_event_ineligible:${normalizedEvent.ineligible_reason || 'unknown'}`,
    pullRequest.state !== 'open' && (pullRequest.merged ? 'pr_already_merged' : 'pr_not_open'),
    pullRequest.draft && !autoMergeConfig.allowDraft && 'draft_pr',
    autoMergeConfig.requireSameRepository && !pullRequest.isSameRepository && 'not_same_repository',
    pullRequest.isFork && 'fork_not_allowed',
    !allowedBaseBranches(autoMergeConfig, config.baseBranch).includes(pullRequest.baseRef) && `base_branch_not_allowed:${pullRequest.baseRef || 'unknown'}`,
    !pullRequest.headSha && 'head_sha_missing',
    normalizedEvent.head_sha && pullRequest.headSha && normalizedEvent.head_sha !== pullRequest.headSha && 'head_sha_mismatch',
    comparison.behindBy > 0 && 'stale_head',
    ['behind', 'diverged'].includes(comparison.status) && 'stale_head',
    hasLabel(pullRequest, config.labels?.doNotMerge) && 'do_not_merge_label',
    hasLabel(pullRequest, config.labels?.needsCodexFix) && 'needs_codex_fix_label',
    hasLabel(pullRequest, config.labels?.codexFixInProgress) && 'codex_fix_in_progress_label',
    !hasLabel(pullRequest, config.labels?.autoMergeAfterCi) && 'auto_merge_label_missing',
    !hasLabel(pullRequest, config.labels?.reviewedByChatGpt) && 'reviewed_by_chatgpt_label_missing',
    reviewState.changesRequested && 'changes_requested',
    reviewState.dismissedReview && 'dismissed_review',
    autoMergeConfig.requireChatGPTReview && !reviewState.chatGptReviewCurrent && 'chatgpt_review_missing',
    autoMergeConfig.requireHumanReview && reviewState.humanApprovalCount === 0 && 'human_review_missing',
    autoMergeConfig.requireCurrentReview && !reviewState.reviewIsCurrent && 'review_not_current',
    reviewState.approvalCount < autoMergeConfig.requiredApprovals && 'approval_missing',
    autoMergeConfig.requireResolvedThreads && reviewState.unresolvedReviewThreads > 0 && 'unresolved_review_threads',
    (pullRequest.requestedReviewers > 0 || pullRequest.requestedTeams > 0) && 'requested_reviewers_remaining',
    !ciState.satisfied && ciState.reason,
    pullRequest.mergeable === null && 'mergeable_unknown',
    pullRequest.mergeable === false && 'merge_conflict',
    BLOCKED_MERGE_STATES.has(pullRequest.mergeStateStatus) && mergeStateReason(pullRequest.mergeStateStatus),
    !isMergeMethodAllowed(autoMergeConfig.mergeMethod, repositorySettings) && 'repository_setting_disallows_merge_method',
    changeState.secretLikeChange && 'secret_like_added_line',
    changeState.workflowChange && 'workflow_change_requires_manual_merge',
    changeState.dependencyChange && 'dependency_change_requires_manual_merge',
    changeState.generatedDistChange && 'generated_dist_requires_manual_merge',
    changeState.binaryChange && 'binary_change_requires_manual_merge',
    changeState.submoduleChange && 'submodule_change_requires_manual_merge',
    changeState.sensitiveChange && 'sensitive_changed_file',
    changedFiles.length > autoMergeConfig.maxChangedFiles && 'changed_files_limit_exceeded',
    total(changedFiles, 'additions') > autoMergeConfig.maxAdditions && 'diff_additions_limit_exceeded',
    total(changedFiles, 'deletions') > autoMergeConfig.maxDeletions && 'diff_deletions_limit_exceeded',
    duplicateSuppressed && 'duplicate_suppressed',
    cooldownActive && 'cooldown_active',
    autoMergeConfig.mode === 'merge-queue' && !repositorySettings.mergeQueueEnabled && 'merge_queue_unavailable',
    autoMergeConfig.mode === 'enable-auto-merge' && repositorySettings.autoMergeAllowed === false && 'auto_merge_unavailable',
    !canTriggerWritePlan(actorTrust, normalizedEvent.event_name) && autoMergeConfig.mode !== 'plan-only' && `actor_not_trusted:${actorTrust}`
  ]);

  if (skipReason) {
    return finalize({
      ...outputs,
      skip_reason: skipReason
    });
  }

  return finalize({
    ...outputs,
    eligible: 'true',
    should_merge: autoMergeConfig.mode === 'immediate-merge' ? 'true' : 'false',
    should_enable_auto_merge: ['enable-auto-merge', 'merge-queue'].includes(autoMergeConfig.mode) ? 'true' : 'false',
    merge_reason: mergeReason(autoMergeConfig.mode)
  });
}

export function createAutoMergeDedupeKey({ repository, pullRequestNumber, headSha, mergeMode, configVersion = 1 }) {
  if (!repository || !pullRequestNumber || !headSha || !mergeMode) {
    return '';
  }

  return `${repository}#${pullRequestNumber}:${headSha}:${mergeMode}:v${configVersion}`;
}

export function getReviewState({ autoMergeConfig = DEFAULT_AUTO_MERGE, config = {}, headSha = '', issueComments = [], pullRequest = {}, reviewThreads = [], reviews = [] } = {}) {
  const reviewConfig = config.review ?? {};
  const trustedChatGptActors = new Set(Array.isArray(reviewConfig.trustedActors) ? reviewConfig.trustedActors : []);
  const trustedHumanReviewers = new Set(Array.isArray(autoMergeConfig.trustedReviewers) ? autoMergeConfig.trustedReviewers : []);
  const sources = [
    ...normalizeIssueComments(issueComments),
    ...normalizeReviews(reviews)
  ];
  const chatGptDecisions = sources
    .filter((source) => trustedChatGptActors.has(source.actor))
    .map((source) => {
      const decision = detectReviewDecision(source, reviewConfig);
      return decision ? {
        ...decision,
        headSha: source.headSha,
        sourceKey: source.sourceKey,
        sourceType: source.sourceType,
        timestamp: decision.timestamp || source.submittedAt || source.updatedAt || source.createdAt || ''
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const chatGptState = getChatGptStatesByActor(chatGptDecisions, headSha);
  const reviewEvents = normalizeReviews(reviews)
    .map((review) => ({
      actor: review.actor,
      headSha: review.headSha,
      state: review.reviewState,
      sourceKey: review.sourceKey,
      timestamp: review.submittedAt || review.updatedAt || review.createdAt || ''
    }))
    .filter((review) => review.state)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const reviewerStates = latestReviewStatesByActor(reviewEvents, headSha);
  const currentHumanApprovals = [...reviewerStates.values()].filter((state) =>
    state.currentApproval?.state === 'APPROVED'
    && !state.unresolvedChangesRequested
    && !state.timestampInvalid
    && (!autoMergeConfig.requireCurrentReview || state.currentApproval.headSha === headSha)
    && trustedHumanReviewers.has(state.actor)
    && (autoMergeConfig.allowBotApproval || !isBotActor(state.actor))
    && !chatGptState.sourceKeys.has(state.currentApproval.sourceKey)
  );
  const chatGptReviewCurrent = chatGptState.approvalCount > 0;
  const changesRequested = chatGptState.changesRequested
    || [...reviewerStates.values()].some((state) => state.unresolvedChangesRequested || state.timestampInvalid);
  const approvalCount = currentHumanApprovals.length + chatGptState.approvalCount;
  const staleApproval = reviewEvents.some((review) => review.state === 'APPROVED' && review.headSha && review.headSha !== headSha);
  const unresolvedReviewThreads = (Array.isArray(reviewThreads) ? reviewThreads : [])
    .filter((thread) => thread?.isResolved === false || thread?.resolved === false)
    .length;

  return {
    approvalCount,
    humanApprovalCount: currentHumanApprovals.length,
    chatGptReviewCurrent,
    changesRequested,
    dismissedReview: [...reviewerStates.values()].some((state) => state.dismissedReview),
    reviewIsCurrent: approvalCount > 0 && (!staleApproval || currentHumanApprovals.length > 0 || chatGptReviewCurrent),
    staleApproval,
    unresolvedReviewThreads,
    requestedReviewers: pullRequest.requestedReviewers ?? 0,
    requestedTeams: pullRequest.requestedTeams ?? 0
  };
}

export function getCiState({ checkRuns = [], commitStatuses = [], config = {}, headSha = '', workflowRuns = [] } = {}) {
  const requiredChecks = (config.autoMerge?.requiredWorkflows?.length ? config.autoMerge.requiredWorkflows : [config.ciWorkflowName])
    .filter(Boolean);

  if (requiredChecks.length === 0) {
    return {
      checks: [],
      reason: '',
      required: false,
      satisfied: true
    };
  }

  const checks = requiredChecks.map((name) => getRequiredCheck({ checkRuns, commitStatuses, headSha, name, workflowRuns }));
  const failed = checks.find((check) => ['failure', 'cancelled', 'timed_out', 'skipped', 'action_required', 'error'].includes(check.conclusion));
  const pending = checks.find((check) => check.conclusion !== 'success');

  return {
    checks,
    reason: failed ? 'required_ci_failed' : pending ? 'required_ci_pending' : '',
    required: true,
    satisfied: checks.every((check) => check.conclusion === 'success')
  };
}

export function getChangeState({ autoMergeConfig = DEFAULT_AUTO_MERGE, changedFiles = [], secretLikePatterns = DEFAULT_SECRET_LIKE_PATTERNS } = {}) {
  const workflowChange = changedFiles.some((file) => matchesAny(file.filename, ['.github/workflows/**', '.github/actions/**']));
  const dependencyChange = changedFiles.some((file) => matchesAny(file.filename, ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']));
  const generatedDistChange = changedFiles.some((file) => matchesAny(file.filename, ['actions/**/dist/**', '**/dist/**']));
  const submoduleChange = changedFiles.some((file) => file.filename === '.gitmodules' || String(file.patch ?? '').includes('Subproject commit'));
  const binaryChange = changedFiles.some((file) => file.patch === undefined && Number(file.changes ?? 0) > 0);
  const sensitiveChange = changedFiles.some((file) => matchesAny(file.filename, autoMergeConfig.sensitivePathPatterns))
    || changedFiles.some((file) => matchesAny(file.filename, autoMergeConfig.manualMergePathPatterns));
  const secretLikeChange = hasSecretLikeAddedLine(changedFiles, secretLikePatterns);

  return {
    binaryChange,
    dependencyChange,
    generatedDistChange,
    secretLikeChange,
    sensitiveChange,
    submoduleChange,
    workflowChange
  };
}

function normalizeEventOutputs(value = {}) {
  return {
    event_name: cleanString(value.event_name ?? value.eventName),
    event_action: cleanString(value.event_action ?? value.eventAction),
    repository: cleanString(value.repository),
    repository_owner: cleanString(value.repository_owner ?? value.repositoryOwner),
    default_branch: cleanString(value.default_branch ?? value.defaultBranch),
    actor: cleanString(value.actor),
    pull_request_number: cleanString(value.pull_request_number ?? value.pullRequestNumber),
    head_sha: cleanSha(value.head_sha ?? value.headSha),
    base_sha: cleanSha(value.base_sha ?? value.baseSha),
    head_repository: cleanString(value.head_repository ?? value.headRepository),
    is_same_repository: boolOutput(value.is_same_repository ?? value.isSameRepository),
    is_fork: boolOutput(value.is_fork ?? value.isFork),
    workflow_name: cleanString(value.workflow_name ?? value.workflowName),
    workflow_conclusion: cleanString(value.workflow_conclusion ?? value.workflowConclusion),
    eligible: boolOutput(value.eligible),
    ineligible_reason: cleanString(value.ineligible_reason ?? value.ineligibleReason)
  };
}

function normalizePullRequest(value = {}, normalizedEvent) {
  value ??= {};
  const labels = normalizeLabels(value.labels);
  const headRepository = cleanString(value.head?.repo?.full_name ?? value.headRepository ?? normalizedEvent.head_repository);
  const baseRepository = cleanString(value.base?.repo?.full_name ?? value.baseRepository ?? normalizedEvent.repository);
  const number = numberToOutput(value.number) || normalizedEvent.pull_request_number;
  const isFork = value.head?.repo?.fork === true || value.isFork === true || normalizedEvent.is_fork === 'true';
  const isSameRepository = (headRepository && baseRepository && headRepository === baseRepository && baseRepository === normalizedEvent.repository)
    || normalizedEvent.is_same_repository === 'true';

  return {
    number,
    state: cleanString(value.state) || 'open',
    merged: value.merged === true,
    draft: value.draft === true,
    author: cleanString(value.user?.login ?? value.author),
    baseRef: cleanString(value.base?.ref ?? value.baseRef ?? normalizedEvent.default_branch),
    headRef: cleanString(value.head?.ref ?? value.headRef),
    baseRepository,
    headRepository,
    headSha: cleanSha(value.head?.sha ?? value.headSha ?? normalizedEvent.head_sha),
    baseSha: cleanSha(value.base?.sha ?? value.baseSha ?? normalizedEvent.base_sha),
    isFork,
    isSameRepository,
    labels,
    mergeable: normalizeMergeable(value.mergeable),
    mergeStateStatus: cleanString(value.mergeable_state ?? value.mergeStateStatus).toLowerCase() || 'unknown',
    requestedReviewers: Array.isArray(value.requested_reviewers) ? value.requested_reviewers.length : Number(value.requestedReviewers ?? 0),
    requestedTeams: Array.isArray(value.requested_teams) ? value.requested_teams.length : Number(value.requestedTeams ?? 0)
  };
}

function getChatGptStatesByActor(decisions, headSha) {
  const states = new Map();
  const sourceKeys = new Set();

  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!decision.actor || decision.headSha !== headSha) {
      continue;
    }

    sourceKeys.add(decision.sourceKey);

    const state = states.get(decision.actor) ?? { actor: decision.actor, decisions: [] };
    state.decisions.push({
      sourceKey: decision.sourceKey,
      state: decision.decision === 'changes_requested' ? 'CHANGES_REQUESTED' : 'APPROVED',
      timestamp: decision.timestamp
    });
    states.set(decision.actor, state);
  }

  let approvalCount = 0;
  let changesRequested = false;

  for (const state of states.values()) {
    const latest = selectLatestState(state.decisions);

    if (latest?.state === 'CHANGES_REQUESTED') {
      changesRequested = true;
      continue;
    }

    if (latest?.state === 'APPROVED') {
      approvalCount += 1;
    }
  }

  return {
    approvalCount,
    changesRequested,
    sourceKeys
  };
}

function latestReviewStatesByActor(reviewEvents, headSha) {
  const states = new Map();

  for (const review of reviewEvents) {
    if (!review.actor) {
      continue;
    }

    const current = states.get(review.actor) ?? { actor: review.actor, events: [] };

    current.events.push(review);

    states.set(review.actor, current);
  }

  for (const state of states.values()) {
    const reduced = reduceReviewerState(state.actor, state.events, headSha);
    Object.assign(state, reduced);
    delete state.events;
  }

  return states;
}

function reduceReviewerState(actor, events, headSha) {
  const parsed = (Array.isArray(events) ? events : []).map((event) => ({
    ...event,
    timestampMs: parseTimestamp(event.timestamp)
  }));
  const dismissedReview = parsed.some((event) => event.state === 'DISMISSED');

  if (parsed.some((event) => !Number.isFinite(event.timestampMs))) {
    return {
      actor,
      current: null,
      currentApproval: null,
      dismissedReview,
      latest: null,
      timestampInvalid: true,
      unresolvedChangesRequested: true
    };
  }

  const ordered = parsed.toSorted((a, b) =>
    a.timestampMs - b.timestampMs
    || reviewStatePriority(a.state) - reviewStatePriority(b.state)
    || String(a.sourceKey).localeCompare(String(b.sourceKey))
  );
  let currentApproval = null;
  let unresolvedChangesRequested = null;

  for (const event of ordered) {
    if (event.state === 'CHANGES_REQUESTED') {
      unresolvedChangesRequested = event;
      continue;
    }

    if (event.state === 'APPROVED') {
      if (event.headSha === headSha) {
        currentApproval = event;
        unresolvedChangesRequested = null;
      }
      continue;
    }
  }

  return {
    actor,
    current: selectLatestState(parsed.filter((event) => event.headSha === headSha)),
    currentApproval,
    dismissedReview,
    latest: ordered.at(-1) ?? null,
    timestampInvalid: false,
    unresolvedChangesRequested
  };
}

function selectLatestState(events) {
  const current = Array.isArray(events) ? events : [];

  if (current.length === 0) {
    return null;
  }

  const parsed = current.map((event) => ({
    ...event,
    timestampMs: parseTimestamp(event.timestamp)
  }));

  if (parsed.some((event) => !Number.isFinite(event.timestampMs))) {
    return {
      ...(parsed.find((event) => event.state === 'CHANGES_REQUESTED') ?? parsed[0]),
      state: 'CHANGES_REQUESTED'
    };
  }

  const latestTimestamp = Math.max(...parsed.map((event) => event.timestampMs));
  const latest = parsed.filter((event) => event.timestampMs === latestTimestamp);

  return latest.find((event) => event.state === 'CHANGES_REQUESTED')
    ?? latest.find((event) => event.state === 'DISMISSED')
    ?? latest.find((event) => event.state === 'APPROVED')
    ?? latest[0];
}

function reviewStatePriority(state) {
  if (state === 'CHANGES_REQUESTED') {
    return 4;
  }
  if (state === 'DISMISSED') {
    return 3;
  }
  if (state === 'APPROVED') {
    return 2;
  }
  return 1;
}

function parseTimestamp(value) {
  const time = Date.parse(cleanString(value));
  return Number.isFinite(time) ? time : Number.NaN;
}

function normalizeIssueComments(issueComments = []) {
  return (Array.isArray(issueComments) ? issueComments : []).map((comment, index) => {
    const actor = cleanString(comment.user?.login ?? comment.actor);
    const createdAt = cleanString(comment.created_at ?? comment.createdAt);
    const updatedAt = cleanString(comment.updated_at ?? comment.updatedAt);
    const url = cleanString(comment.html_url ?? comment.url);

    return {
      actor,
      body: cleanString(comment.body),
      createdAt,
      updatedAt,
      url,
      headSha: cleanSha(comment.headSha ?? comment.head_sha),
      sourceKey: sourceKey('issue_comment', comment, { actor, index, timestamp: updatedAt || createdAt, url }),
      sourceType: 'issue_comment'
    };
  });
}

function normalizeReviews(reviews = []) {
  return (Array.isArray(reviews) ? reviews : []).map((review, index) => {
    const actor = cleanString(review.user?.login ?? review.actor);
    const createdAt = cleanString(review.created_at ?? review.createdAt);
    const updatedAt = cleanString(review.updated_at ?? review.updatedAt);
    const submittedAt = cleanString(review.submitted_at ?? review.submittedAt);
    const url = cleanString(review.html_url ?? review.url);

    return {
      actor,
      body: cleanString(review.body),
      createdAt,
      updatedAt,
      submittedAt,
      reviewState: cleanString(review.state ?? review.reviewState).toUpperCase(),
      url,
      headSha: cleanSha(review.commit_id ?? review.commitId ?? review.headSha ?? review.head_sha),
      sourceKey: sourceKey('review', review, { actor, index, timestamp: submittedAt || updatedAt || createdAt, url }),
      sourceType: 'review'
    };
  });
}

function getRequiredCheck({ checkRuns = [], commitStatuses = [], headSha, name, workflowRuns = [] }) {
  const runs = [
    ...workflowRuns.map((run) => ({
      conclusion: cleanString(run.conclusion),
      name: cleanString(run.name),
      sha: cleanSha(run.head_sha ?? run.headSha),
      status: cleanString(run.status),
      timestamp: cleanString(run.updated_at ?? run.run_started_at ?? run.created_at)
    })),
    ...checkRuns.map((run) => ({
      conclusion: cleanString(run.conclusion),
      name: cleanString(run.name),
      sha: cleanSha(run.head_sha ?? run.headSha),
      status: cleanString(run.status),
      timestamp: cleanString(run.completed_at ?? run.started_at ?? run.created_at)
    })),
    ...commitStatuses.map((status) => ({
      conclusion: cleanString(status.state) === 'success' ? 'success' : cleanString(status.state),
      name: cleanString(status.context),
      sha: headSha,
      status: cleanString(status.state) === 'success' ? 'completed' : 'pending',
      timestamp: cleanString(status.updated_at ?? status.created_at)
    }))
  ]
    .filter((run) => run.name === name && run.sha === headSha)
    .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
  const latest = runs[0];

  if (!latest) {
    return { name, conclusion: 'pending', source: 'missing' };
  }

  if (latest.status && latest.status !== 'completed') {
    return { name, conclusion: 'pending', source: 'pending' };
  }

  return {
    name,
    conclusion: latest.conclusion || 'pending',
    source: 'github'
  };
}

function normalizeRepositorySettings(value = {}) {
  return {
    autoMergeAllowed: value.allow_auto_merge ?? value.autoMergeAllowed,
    mergeCommitAllowed: value.allow_merge_commit ?? value.mergeCommitAllowed,
    mergeQueueEnabled: value.merge_queue_enabled ?? value.mergeQueueEnabled ?? false,
    rebaseMergeAllowed: value.allow_rebase_merge ?? value.rebaseMergeAllowed,
    squashMergeAllowed: value.allow_squash_merge ?? value.squashMergeAllowed
  };
}

function normalizeComparison(value = {}) {
  return {
    behindBy: Number(value.behind_by ?? value.behindBy ?? 0),
    status: cleanString(value.status)
  };
}

function allowedBaseBranches(config, defaultBaseBranch) {
  return config.allowedBaseBranches?.length ? config.allowedBaseBranches : [defaultBaseBranch].filter(Boolean);
}

function hasLabel(pullRequest, labelName) {
  return Boolean(labelName && pullRequest.labels.includes(labelName));
}

function normalizeLabels(labels = []) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => cleanString(label.name ?? label))
    .filter(Boolean);
}

function normalizeMergeable(value) {
  if (value === true || value === false || value === null) {
    return value;
  }
  return null;
}

function stringifyMergeable(value) {
  if (value === true) {
    return 'true';
  }
  if (value === false) {
    return 'false';
  }
  return 'unknown';
}

function isMergeMethodAllowed(method, settings) {
  if (method === 'squash') {
    return settings.squashMergeAllowed !== false;
  }
  if (method === 'merge') {
    return settings.mergeCommitAllowed !== false;
  }
  if (method === 'rebase') {
    return settings.rebaseMergeAllowed !== false;
  }
  return false;
}

function mergeStateReason(value) {
  if (value === 'dirty') {
    return 'merge_conflict';
  }
  if (value === 'unknown') {
    return 'mergeable_unknown';
  }
  return `merge_state_blocked:${value}`;
}

function mergeReason(mode) {
  if (mode === 'plan-only') {
    return 'eligible_plan_only';
  }
  if (mode === 'enable-auto-merge') {
    return 'eligible_enable_auto_merge';
  }
  if (mode === 'merge-queue') {
    return 'eligible_merge_queue';
  }
  return 'eligible_immediate_merge';
}

function canTriggerWritePlan(actorTrust, eventName) {
  if (['workflow_run', 'check_suite', 'check_run'].includes(eventName)) {
    return true;
  }
  return ['repository-owner', 'collaborator', 'organization-member', 'allowlisted-human', 'allowlisted-bot'].includes(actorTrust);
}

function isDuplicateSuppressed({ dedupeKey, duplicatePolicy, existingDedupeKeys = [] }) {
  return duplicatePolicy !== 'allow-rerun' && dedupeKey && existingDedupeKeys.includes(dedupeKey);
}

function isCooldownActive({ cooldownSeconds = 0, lastPlannedAt, now }) {
  if (!cooldownSeconds || !lastPlannedAt) {
    return false;
  }

  const nowTime = now ? Date.parse(now) : Date.now();
  const lastTime = Date.parse(lastPlannedAt);

  return Number.isFinite(nowTime) && Number.isFinite(lastTime) && nowTime - lastTime < cooldownSeconds * 1000;
}

function isBotActor(actor) {
  const login = cleanString(actor).toLowerCase();
  return login.endsWith('[bot]') || login === 'github-actions[bot]';
}

function matchesAny(filename, patterns = []) {
  const normalized = cleanString(filename).replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalized && patterns.some((pattern) => matchesGlob(normalized, pattern));
}

function matchesGlob(filename, pattern) {
  const regex = new RegExp(`^${escapeRegExp(pattern).replaceAll('\\*\\*', '.*').replaceAll('\\*', '[^/]*')}$`, 'i');
  return regex.test(filename);
}

function total(changedFiles, key) {
  return changedFiles.reduce((sum, file) => sum + (Number.isInteger(file[key]) ? file[key] : 0), 0);
}

function firstSkipReason(reasons) {
  return reasons.find(Boolean) || '';
}

function finalize(outputs) {
  return {
    ok: outputs.eligible === 'true',
    outputs: {
      ...EMPTY_OUTPUTS,
      ...outputs
    }
  };
}

function readPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function boolOutput(value, defaultValue = 'false') {
  if (value === true || value === 'true') {
    return 'true';
  }
  if (value === false || value === 'false') {
    return 'false';
  }
  return defaultValue;
}

function numberToOutput(value) {
  return Number.isInteger(value) && value > 0 ? String(value) : cleanString(value);
}

function sourceKey(type, value, fallback) {
  const rawId = value.id ?? value.node_id ?? value.nodeId;
  const id = typeof rawId === 'number' || typeof rawId === 'bigint'
    ? String(rawId)
    : cleanString(rawId);
  if (id) {
    return `${type}:${id}`;
  }

  const url = cleanString(fallback.url);
  if (url) {
    return `${type}:${url}`;
  }

  return `${type}:${cleanString(fallback.actor) || 'unknown'}:${cleanString(fallback.timestamp) || 'unknown'}:${fallback.index}`;
}

function cleanSha(value) {
  const text = cleanString(value);
  return /^[a-f0-9]{40}$/i.test(text) ? text : '';
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
