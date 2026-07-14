import {
  DEFAULT_LABELS,
  DEFAULT_MAIN_FOLLOW_UP,
  DEFAULT_SECRET_LIKE_PATTERNS,
  validateAutomationConfigObject
} from '../config/index.js';
import { hasSecretLikeAddedLine } from '../review-routing/index.js';

export const MAIN_FOLLOW_UP_OUTPUT_NAMES = Object.freeze([
  'eligible',
  'repository',
  'default_branch',
  'base_sha',
  'trigger_type',
  'scanned_pull_request_count',
  'up_to_date_count',
  'update_candidate_count',
  'codex_follow_up_candidate_count',
  'manual_review_count',
  'skipped_count',
  'plans_json',
  'skip_reason',
  'dry_run'
]);

const EMPTY_OUTPUTS = Object.freeze({
  eligible: 'false',
  repository: '',
  default_branch: '',
  base_sha: '',
  trigger_type: '',
  scanned_pull_request_count: '0',
  up_to_date_count: '0',
  update_candidate_count: '0',
  codex_follow_up_candidate_count: '0',
  manual_review_count: '0',
  skipped_count: '0',
  plans_json: '[]',
  skip_reason: '',
  dry_run: 'true'
});

const SUPPORTED_TRIGGER_EVENTS = new Set(['push', 'pull_request', 'workflow_dispatch']);
const MANUAL_CHANGE_REASONS = new Set([
  'binary_or_submodule_change',
  'dependency_change',
  'generated_dist_change',
  'protected_path_change',
  'secret_like_added_line',
  'sensitive_path_change',
  'workflow_change'
]);

export function createMainFollowUpPlan(input = {}) {
  const rawConfig = input.config ?? {};
  const configResult = rawConfig.mainFollowUp
    ? validateAutomationConfigObject(rawConfig)
    : {
        ok: true,
        config: {
          version: 1,
          baseBranch: input.baseBranch ?? '',
          ciWorkflowName: input.ciWorkflowName ?? '',
          labels: { ...DEFAULT_LABELS },
          mainFollowUp: { ...DEFAULT_MAIN_FOLLOW_UP }
        }
      };
  const config = configResult.config ?? {
    version: 1,
    baseBranch: '',
    ciWorkflowName: '',
    labels: { ...DEFAULT_LABELS },
    mainFollowUp: { ...DEFAULT_MAIN_FOLLOW_UP }
  };
  const mainConfig = config.mainFollowUp ?? DEFAULT_MAIN_FOLLOW_UP;
  const normalizedEvent = normalizeEventOutputs(input.normalizedEvent);
  const eventPayload = readPayload(input.eventPayload);
  const defaultBranch = cleanString(normalizedEvent.default_branch || config.baseBranch);
  const repository = cleanRepository(normalizedEvent.repository);
  const targetBaseBranch = getTargetBaseBranch({ defaultBranch, eventPayload, normalizedEvent });
  const targetBase = resolveTargetBase({
    eventPayload,
    normalizedEvent,
    targetBaseSha: input.targetBaseSha
  });
  const targetBaseSha = targetBase.baseSha;
  const triggerType = getTriggerType(normalizedEvent.event_name);
  const openPullRequests = Array.isArray(input.openPullRequests) ? input.openPullRequests : [];
  const existingDedupeKeys = Array.isArray(input.existingDedupeKeys) ? input.existingDedupeKeys : [];
  const outputs = {
    ...EMPTY_OUTPUTS,
    repository,
    default_branch: defaultBranch,
    base_sha: targetBaseSha,
    trigger_type: triggerType,
    dry_run: mainConfig.dryRun ? 'true' : 'false'
  };
  const globalSkipReason = firstSkipReason([
    !configResult.ok && 'config_invalid',
    input.scanError && cleanString(input.scanError),
    input.apiReadError && `github_api_read_failed:${input.apiReadError}`,
    !mainConfig.enabled && 'main_follow_up_disabled',
    !SUPPORTED_TRIGGER_EVENTS.has(normalizedEvent.event_name) && `unsupported_event:${normalizedEvent.event_name || 'unknown'}`,
    normalizedEvent.event_name !== 'workflow_dispatch' && normalizedEvent.eligible !== 'true' && `normalized_event_ineligible:${normalizedEvent.ineligible_reason || 'unknown'}`,
    targetBase.error,
    !repository && 'repository_missing',
    !defaultBranch && 'default_branch_missing',
    !targetBaseBranch && 'base_branch_missing',
    !allowedBaseBranches(mainConfig, defaultBranch).includes(targetBaseBranch) && `base_branch_not_allowed:${targetBaseBranch || 'unknown'}`,
    normalizedEvent.event_name === 'push' && targetBaseBranch !== defaultBranch && 'push_target_not_default_branch',
    normalizedEvent.event_name === 'pull_request' && !isMergedPullRequestEvent(eventPayload) && 'pull_request_not_merged',
    openPullRequests.length > mainConfig.maxOpenPullRequests && 'open_pull_requests_limit_exceeded'
  ]);

  if (globalSkipReason) {
    return finalize({ ...outputs, skip_reason: globalSkipReason });
  }

  const plans = buildPlans({
    config,
    defaultBranch,
    existingDedupeKeys,
    mainConfig,
    now: input.now,
    openPullRequests,
    repository,
    targetBaseBranch,
    targetBaseSha
  });
  const counts = summarizePlans(plans);

  return finalize({
    ...outputs,
    eligible: 'true',
    scanned_pull_request_count: String(plans.length),
    up_to_date_count: String(counts.upToDate),
    update_candidate_count: String(counts.updateCandidate),
    codex_follow_up_candidate_count: String(counts.codexFollowUpCandidate),
    manual_review_count: String(counts.manualReview),
    skipped_count: String(counts.skipped),
    plans_json: JSON.stringify(plans)
  });
}

export function createMainFollowUpDedupeKey({
  baseSha,
  configVersion = 1,
  headSha,
  pullRequestNumber,
  repository
}) {
  if (!repository || !pullRequestNumber || !headSha || !baseSha) {
    return '';
  }

  return `${repository}#${pullRequestNumber}:${headSha}:${baseSha}:main-follow-up:v${configVersion}`;
}

export function getMainFollowUpChangeState({ changedFiles = [], config = DEFAULT_MAIN_FOLLOW_UP, secretLikePatterns = DEFAULT_SECRET_LIKE_PATTERNS } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const workflowChange = files.some((file) => matchesAny(file.filename, config.workflowPathPatterns));
  const dependencyChange = files.some((file) => matchesAny(file.filename, config.dependencyPathPatterns));
  const generatedDistChange = files.some((file) => matchesAny(file.filename, config.generatedPathPatterns));
  const protectedPathChange = files.some((file) => matchesAny(file.filename, config.protectedPathPatterns));
  const sensitivePathChange = files.some((file) => matchesAny(file.filename, config.sensitivePathPatterns));
  const secretLikeChange = hasSecretLikeAddedLine(files, secretLikePatterns);
  const binaryOrSubmoduleChange = files.some((file) => file.patch === undefined && Number(file.changes ?? 0) > 0)
    || files.some((file) => file.filename === '.gitmodules' || String(file.patch ?? '').includes('Subproject commit'));

  return {
    binaryOrSubmoduleChange,
    dependencyChange,
    generatedDistChange,
    protectedPathChange,
    secretLikeChange,
    sensitivePathChange,
    workflowChange
  };
}

function buildPlans({ config, defaultBranch, existingDedupeKeys, mainConfig, now, openPullRequests, repository, targetBaseBranch, targetBaseSha }) {
  const uniquePullRequests = new Map();

  for (const pullRequest of openPullRequests) {
    const normalized = normalizePullRequest(pullRequest, repository, defaultBranch);
    if (!normalized.number || uniquePullRequests.has(normalized.number)) {
      continue;
    }
    uniquePullRequests.set(normalized.number, normalized);
  }

  return [...uniquePullRequests.values()]
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map((pullRequest) => classifyPullRequest({
      config,
      existingDedupeKeys,
      mainConfig,
      now,
      pullRequest,
      repository,
      targetBaseBranch,
      targetBaseSha
    }));
}

function classifyPullRequest({ config, existingDedupeKeys, mainConfig, now, pullRequest, repository, targetBaseBranch, targetBaseSha }) {
  const changedFiles = Array.isArray(pullRequest.changedFiles) ? pullRequest.changedFiles : [];
  const compare = normalizeComparison(pullRequest.compare ?? pullRequest.comparison);
  const changeState = getMainFollowUpChangeState({
    changedFiles,
    config: mainConfig,
    secretLikePatterns: config.secretLike?.hardBlockPatterns ?? DEFAULT_SECRET_LIKE_PATTERNS
  });
  const dedupeKey = createMainFollowUpDedupeKey({
    baseSha: targetBaseSha,
    configVersion: config.version ?? 1,
    headSha: pullRequest.headSha,
    pullRequestNumber: pullRequest.number,
    repository
  });
  const attemptCount = Number.isInteger(pullRequest.attemptCount) ? pullRequest.attemptCount : 0;
  const cooldownActive = isCooldownActive({
    cooldownSeconds: mainConfig.cooldownSeconds,
    lastAttemptedAt: pullRequest.lastAttemptedAt,
    now
  });
  const duplicateSuppressed = mainConfig.duplicatePolicy !== 'allow-rerun' && dedupeKey && existingDedupeKeys.includes(dedupeKey);
  const basePlan = {
    repository,
    pull_request_number: pullRequest.number,
    base_branch: pullRequest.baseRef,
    head_branch: pullRequest.headRef,
    base_sha: targetBaseSha,
    head_sha: pullRequest.headSha,
    merge_base_sha: compare.mergeBaseSha,
    compare_status: compare.status,
    mergeable: stringifyMergeable(pullRequest.mergeable),
    merge_state_status: pullRequest.mergeStateStatus,
    action: 'ineligible',
    should_update_branch: false,
    should_request_codex_follow_up: false,
    requires_manual_review: false,
    reason: '',
    skip_reason: '',
    attempt_count: attemptCount,
    cooldown_active: cooldownActive,
    duplicate_suppressed: duplicateSuppressed,
    dedupe_key: dedupeKey
  };
  const ineligibleReason = firstSkipReason([
    pullRequest.state !== 'open' && `pull_request_not_open:${pullRequest.state || 'unknown'}`,
    mainConfig.requireSameRepository && !pullRequest.isSameRepository && 'not_same_repository',
    pullRequest.isFork && 'fork_not_allowed',
    pullRequest.baseRef !== targetBaseBranch && `base_branch_not_allowed:${pullRequest.baseRef || 'unknown'}`,
    !targetBaseSha && 'base_sha_missing',
    !pullRequest.headSha && 'head_sha_missing',
    !pullRequest.headRef && 'head_branch_missing',
    pullRequest.headBranchExists === false && 'head_branch_missing',
    pullRequest.draft && !mainConfig.allowDraft && 'draft_pr',
    missingRequiredLabel(pullRequest, mainConfig.requiredLabels),
    blockedLabel(pullRequest, mainConfig.blockedLabels),
    attemptCount >= mainConfig.maxAttempts && 'attempt_limit_exceeded',
    duplicateSuppressed && 'duplicate_suppressed',
    cooldownActive && 'cooldown_active'
  ]);

  if (ineligibleReason) {
    return {
      ...basePlan,
      action: 'ineligible',
      skip_reason: ineligibleReason
    };
  }

  const manualReason = firstSkipReason([
    pullRequest.snapshotError,
    pullRequest.baseSha && pullRequest.baseSha !== targetBaseSha && 'pull_request_base_changed_during_scan',
    changeState.secretLikeChange && 'secret_like_added_line',
    changeState.workflowChange && 'workflow_change',
    changeState.dependencyChange && 'dependency_change',
    changeState.generatedDistChange && 'generated_dist_change',
    changeState.binaryOrSubmoduleChange && 'binary_or_submodule_change',
    changeState.protectedPathChange && 'protected_path_change',
    changeState.sensitivePathChange && 'sensitive_path_change',
    changedFiles.length > mainConfig.maxChangedFiles && 'changed_files_limit_exceeded',
    total(changedFiles, 'additions') > mainConfig.maxAdditions && 'diff_additions_limit_exceeded',
    total(changedFiles, 'deletions') > mainConfig.maxDeletions && 'diff_deletions_limit_exceeded',
    !compare.status && 'compare_status_unknown',
    pullRequest.mergeable === null && 'mergeable_unknown',
    ['unknown', 'blocked'].includes(pullRequest.mergeStateStatus) && `merge_state_unknown:${pullRequest.mergeStateStatus}`
  ]);

  if (manualReason) {
    return {
      ...basePlan,
      action: 'manual-review-required',
      requires_manual_review: true,
      reason: manualReason,
      skip_reason: manualReason
    };
  }

  if (isConflictState({ compare, pullRequest })) {
    return codexOrManual({
      basePlan,
      enabled: mainConfig.codexFollowUpEnabled,
      reason: 'conflict_follow_up_candidate'
    });
  }

  if (pullRequest.updateFailed === true) {
    return codexOrManual({
      basePlan,
      enabled: mainConfig.codexFollowUpEnabled,
      reason: 'update_failed_follow_up_candidate'
    });
  }

  if (isBehindState(compare)) {
    return {
      ...basePlan,
      action: 'behind-update-candidate',
      should_update_branch: true,
      reason: 'behind_update_candidate'
    };
  }

  if (isUpToDateState(compare)) {
    return {
      ...basePlan,
      action: 'up-to-date',
      reason: 'up_to_date'
    };
  }

  return {
    ...basePlan,
    action: 'manual-review-required',
    requires_manual_review: true,
    reason: 'branch_state_unknown',
    skip_reason: 'branch_state_unknown'
  };
}

function codexOrManual({ basePlan, enabled, reason }) {
  if (!enabled) {
    return {
      ...basePlan,
      action: 'manual-review-required',
      requires_manual_review: true,
      reason: `${reason}_codex_disabled`,
      skip_reason: `${reason}_codex_disabled`
    };
  }

  return {
    ...basePlan,
    action: reason === 'conflict_follow_up_candidate' ? 'conflict-follow-up-candidate' : 'update-failed-follow-up-candidate',
    should_request_codex_follow_up: true,
    reason
  };
}

function normalizePullRequest(value = {}, repository, defaultBranch) {
  const headRepository = cleanRepository(value.head?.repo?.full_name ?? value.headRepository);
  const baseRepository = cleanRepository(value.base?.repo?.full_name ?? value.baseRepository ?? repository);
  const headSha = cleanSha(value.head?.sha ?? value.headSha);
  const baseSha = cleanSha(value.base?.sha ?? value.baseSha);
  const labels = normalizeLabels(value.labels);

  return {
    attemptCount: Number.isInteger(value.attemptCount) ? value.attemptCount : 0,
    baseRef: cleanString(value.base?.ref ?? value.baseRef ?? defaultBranch),
    baseRepository,
    baseSha,
    changedFiles: Array.isArray(value.changedFiles) ? value.changedFiles : [],
    compare: value.compare ?? value.comparison,
    draft: value.draft === true,
    headBranchExists: value.headBranchExists ?? value.head?.repo !== null,
    headRef: cleanString(value.head?.ref ?? value.headRef),
    headRepository,
    headSha,
    isFork: value.head?.repo?.fork === true || value.isFork === true || (headRepository && headRepository !== repository),
    isSameRepository: (headRepository && baseRepository && headRepository === repository && baseRepository === repository) || value.isSameRepository === true,
    labels,
    lastAttemptedAt: cleanString(value.lastAttemptedAt),
    mergeStateStatus: cleanString(value.mergeable_state ?? value.mergeStateStatus).toLowerCase() || 'unknown',
    mergeable: normalizeMergeable(value.mergeable),
    number: numberToOutput(value.number),
    snapshotError: cleanString(value.snapshotError),
    state: cleanString(value.state) || 'open',
    updateFailed: value.updateFailed === true
  };
}

function normalizeComparison(value = {}) {
  return {
    aheadBy: Number(value.ahead_by ?? value.aheadBy ?? 0),
    behindBy: Number(value.behind_by ?? value.behindBy ?? 0),
    mergeBaseSha: cleanSha(value.merge_base_commit?.sha ?? value.mergeBaseSha),
    status: cleanString(value.status).toLowerCase()
  };
}

function getTargetBaseBranch({ defaultBranch, eventPayload, normalizedEvent }) {
  if (normalizedEvent.event_name === 'pull_request') {
    return cleanString(eventPayload?.pull_request?.base?.ref);
  }
  if (normalizedEvent.event_name === 'workflow_dispatch') {
    return cleanString(eventPayload?.inputs?.base_branch) || defaultBranch;
  }
  return defaultBranch;
}

function resolveTargetBase({ eventPayload, normalizedEvent, targetBaseSha }) {
  const explicitTarget = cleanSha(targetBaseSha);
  const triggerBase = getBaseSha({ eventPayload, normalizedEvent });

  if (normalizedEvent.event_name === 'push') {
    const eventAfter = cleanSha(eventPayload?.after);
    const normalizedHead = cleanSha(normalizedEvent.head_sha);
    if (eventAfter && normalizedHead && eventAfter !== normalizedHead) {
      return { baseSha: '', error: 'base_sha_mismatch' };
    }
  }

  if (normalizedEvent.event_name === 'workflow_dispatch') {
    const requestedBaseSha = cleanSha(eventPayload?.inputs?.base_sha);
    if (explicitTarget && requestedBaseSha && explicitTarget !== requestedBaseSha) {
      return { baseSha: explicitTarget, error: 'base_sha_mismatch' };
    }
  }

  if (explicitTarget && triggerBase && normalizedEvent.event_name !== 'workflow_dispatch' && explicitTarget !== triggerBase) {
    return { baseSha: explicitTarget, error: 'base_sha_mismatch' };
  }

  const baseSha = explicitTarget || triggerBase;
  return {
    baseSha,
    error: baseSha ? '' : 'base_sha_missing'
  };
}

function getBaseSha({ eventPayload, normalizedEvent }) {
  if (normalizedEvent.event_name === 'push') {
    return cleanSha(normalizedEvent.head_sha || eventPayload?.after);
  }
  if (normalizedEvent.event_name === 'pull_request') {
    return cleanSha(eventPayload?.pull_request?.merge_commit_sha ?? normalizedEvent.head_sha);
  }
  return cleanSha(normalizedEvent.head_sha || eventPayload?.after);
}

function getTriggerType(eventName) {
  if (eventName === 'push') {
    return 'default-branch-push';
  }
  if (eventName === 'pull_request') {
    return 'merged-pull-request';
  }
  if (eventName === 'workflow_dispatch') {
    return 'manual-dispatch';
  }
  return '';
}

function isMergedPullRequestEvent(eventPayload) {
  return eventPayload?.action === 'closed' && eventPayload?.pull_request?.merged === true;
}

function isBehindState(compare) {
  return compare.status === 'behind' || compare.behindBy > 0;
}

function isConflictState({ compare, pullRequest }) {
  return compare.status === 'diverged' || pullRequest.mergeable === false || pullRequest.mergeStateStatus === 'dirty';
}

function isUpToDateState(compare) {
  return ['ahead', 'identical'].includes(compare.status) || (compare.status && compare.behindBy === 0);
}

function summarizePlans(plans) {
  return plans.reduce((counts, plan) => {
    if (plan.action === 'up-to-date') {
      counts.upToDate += 1;
    } else if (plan.action === 'behind-update-candidate') {
      counts.updateCandidate += 1;
    } else if (['conflict-follow-up-candidate', 'update-failed-follow-up-candidate'].includes(plan.action)) {
      counts.codexFollowUpCandidate += 1;
    } else if (plan.action === 'manual-review-required') {
      counts.manualReview += 1;
    } else {
      counts.skipped += 1;
    }
    return counts;
  }, {
    codexFollowUpCandidate: 0,
    manualReview: 0,
    skipped: 0,
    upToDate: 0,
    updateCandidate: 0
  });
}

function missingRequiredLabel(pullRequest, requiredLabels) {
  const missing = (Array.isArray(requiredLabels) ? requiredLabels : []).find((label) => label && !pullRequest.labels.includes(label));
  return missing ? `required_label_missing:${missing}` : '';
}

function blockedLabel(pullRequest, blockedLabels) {
  const blocked = (Array.isArray(blockedLabels) ? blockedLabels : []).find((label) => label && pullRequest.labels.includes(label));
  return blocked ? `blocked_label:${blocked}` : '';
}

function isCooldownActive({ cooldownSeconds = 0, lastAttemptedAt, now }) {
  if (!cooldownSeconds || !lastAttemptedAt) {
    return false;
  }

  const nowTime = now ? Date.parse(now) : Date.now();
  const lastTime = Date.parse(lastAttemptedAt);

  if (!Number.isFinite(nowTime) || !Number.isFinite(lastTime)) {
    return true;
  }

  return nowTime - lastTime < cooldownSeconds * 1000;
}

function allowedBaseBranches(config, defaultBaseBranch) {
  return config.allowedBaseBranches?.length ? config.allowedBaseBranches : [defaultBaseBranch].filter(Boolean);
}

function normalizeEventOutputs(value = {}) {
  return {
    default_branch: cleanString(value.default_branch ?? value.defaultBranch),
    eligible: boolOutput(value.eligible),
    event_action: cleanString(value.event_action ?? value.eventAction),
    event_name: cleanString(value.event_name ?? value.eventName),
    head_sha: cleanSha(value.head_sha ?? value.headSha),
    ineligible_reason: cleanString(value.ineligible_reason ?? value.ineligibleReason),
    repository: cleanRepository(value.repository)
  };
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

function cleanRepository(value) {
  const text = cleanString(value);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : '';
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
