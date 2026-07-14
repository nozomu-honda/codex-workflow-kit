import {
  DEFAULT_REVIEW_ROUTING,
  validateAutomationConfigObject
} from '../config/index.js';

export const REVIEW_ROUTING_OUTPUT_NAMES = Object.freeze([
  'should_route',
  'route_reason',
  'skip_reason',
  'repository',
  'pull_request_number',
  'head_sha',
  'base_sha',
  'head_repository',
  'base_repository',
  'is_same_repository',
  'is_fork',
  'actor',
  'actor_trust',
  'trigger_type',
  'trigger_source',
  'review_mode',
  'requested_reviewer',
  'requested_label',
  'requested_command',
  'is_draft',
  'ci_required',
  'ci_satisfied',
  'duplicate_suppressed',
  'cooldown_active',
  'dry_run',
  'eligible',
  'dedupe_key'
]);

const EMPTY_OUTPUTS = Object.freeze({
  should_route: 'false',
  route_reason: '',
  skip_reason: '',
  repository: '',
  pull_request_number: '',
  head_sha: '',
  base_sha: '',
  head_repository: '',
  base_repository: '',
  is_same_repository: 'false',
  is_fork: 'false',
  actor: '',
  actor_trust: 'unknown',
  trigger_type: '',
  trigger_source: '',
  review_mode: 'dry-run',
  requested_reviewer: '',
  requested_label: '',
  requested_command: '',
  is_draft: 'false',
  ci_required: 'false',
  ci_satisfied: 'false',
  duplicate_suppressed: 'false',
  cooldown_active: 'false',
  dry_run: 'true',
  eligible: 'false',
  dedupe_key: ''
});

const ROUTE_TRUST_LEVELS = new Set([
  'repository-owner',
  'collaborator',
  'organization-member',
  'allowlisted-human',
  'allowlisted-bot'
]);

const BOT_LOOP_ACTORS = new Set([
  'github-actions[bot]',
  'dependabot[bot]'
]);

export function detectReviewDecision(source = {}, reviewConfig = {}) {
  const body = cleanString(source.body);
  const actor = cleanString(source.actor);
  const markers = {
    approved: '<!-- chatgpt-review: approved -->',
    changesRequested: '<!-- chatgpt-review: changes_requested -->',
    reviewRequest: '<!-- chatgpt-review-request -->',
    ignoreInFencedCodeBlocks: true,
    excludeReviewRequestComments: true,
    ...reviewConfig.markers
  };
  const decisions = {
    stopOnLatestChangesRequested: true,
    ...reviewConfig.decisions
  };

  if (!decisions.stopOnLatestChangesRequested) {
    return null;
  }

  if (markers.excludeReviewRequestComments && body.includes(markers.reviewRequest)) {
    return null;
  }

  const reviewBody = markers.ignoreInFencedCodeBlocks ? stripFencedCodeBlocks(body) : body;

  if (markers.approved && reviewBody.includes(markers.approved)) {
    return createDecision(source, 'approved', 'marker');
  }

  if (markers.changesRequested && reviewBody.includes(markers.changesRequested)) {
    return createDecision(source, 'changes_requested', 'marker');
  }

  if (reviewConfig.decisionMode !== 'trusted-actors' || !reviewConfig.trustedActors?.includes(actor)) {
    return null;
  }

  if (source.reviewState === 'APPROVED') {
    return createDecision(source, 'approved', 'trusted-review-state');
  }

  if (source.reviewState === 'CHANGES_REQUESTED') {
    return createDecision(source, 'changes_requested', 'trusted-review-state');
  }

  const headingStatus = reviewBody.match(/##\s*ChatGPT Review[\s\S]*?status:\s*(approved|changes_requested)/i);
  if (headingStatus) {
    return createDecision(source, headingStatus[1].toLowerCase(), 'trusted-status-heading');
  }

  return null;
}

export function getLatestReviewDecision(sources = [], reviewConfig = {}) {
  return sources
    .map((source) => detectReviewDecision(source, reviewConfig))
    .filter(Boolean)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
}

export function stripFencedCodeBlocks(markdown = '') {
  return String(markdown).replace(/```[\s\S]*?```/g, '');
}

export function createReviewRoutingPlan(input = {}) {
  const rawConfig = input.config ?? {};
  const configResult = rawConfig.reviewRouting
    ? validateAutomationConfigObject(rawConfig)
    : { ok: true, config: { reviewRouting: { ...DEFAULT_REVIEW_ROUTING }, review: {}, ciWorkflowName: input.ciWorkflowName ?? '' } };
  const config = configResult.config ?? { reviewRouting: { ...DEFAULT_REVIEW_ROUTING } };
  const routingConfig = config.reviewRouting ?? DEFAULT_REVIEW_ROUTING;
  const normalizedEvent = normalizeEventOutputs(input.normalizedEvent);
  const eventPayload = readPayload(input.eventPayload);
  const pullRequest = normalizePullRequest(input.pullRequest, normalizedEvent);
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const actorTrust = classifyActorTrust({
    actor: normalizedEvent.actor,
    repositoryOwner: normalizedEvent.repository_owner,
    pullRequest,
    actorInfo: input.actorInfo,
    config: routingConfig
  });
  const trigger = classifyTrigger({
    normalizedEvent,
    eventPayload,
    config: routingConfig,
    ciWorkflowName: config.ciWorkflowName
  });
  const dedupeKey = createDedupeKey({
    repository: normalizedEvent.repository,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    triggerType: trigger.type,
    configVersion: config.version ?? 1
  });
  const duplicateSuppressed = isDuplicateSuppressed({
    dedupeKey,
    existingDedupeKeys: input.existingDedupeKeys,
    duplicatePolicy: routingConfig.duplicatePolicy
  });
  const cooldownActive = isCooldownActive({
    now: input.now,
    lastRoutedAt: input.lastRoutedAt,
    cooldownSeconds: routingConfig.cooldownSeconds
  });
  const outputs = {
    ...EMPTY_OUTPUTS,
    repository: normalizedEvent.repository,
    pull_request_number: pullRequest.number,
    head_sha: pullRequest.headSha,
    base_sha: pullRequest.baseSha,
    head_repository: pullRequest.headRepository,
    base_repository: pullRequest.baseRepository,
    is_same_repository: pullRequest.isSameRepository ? 'true' : 'false',
    is_fork: pullRequest.isFork ? 'true' : 'false',
    actor: normalizedEvent.actor,
    actor_trust: actorTrust,
    trigger_type: trigger.type,
    trigger_source: trigger.source,
    review_mode: routingConfig.dryRun ? 'dry-run' : 'active',
    requested_reviewer: trigger.requestedReviewer,
    requested_label: trigger.requestedLabel,
    requested_command: trigger.requestedCommand,
    is_draft: pullRequest.draft ? 'true' : 'false',
    ci_required: trigger.ciRequired ? 'true' : 'false',
    ci_satisfied: trigger.ciSatisfied ? 'true' : 'false',
    duplicate_suppressed: duplicateSuppressed ? 'true' : 'false',
    cooldown_active: cooldownActive ? 'true' : 'false',
    dry_run: routingConfig.dryRun ? 'true' : 'false',
    dedupe_key: dedupeKey
  };

  const skipReason = firstSkipReason([
    !configResult.ok && 'config_invalid',
    input.apiReadError && `github_api_read_failed:${input.apiReadError}`,
    !routingConfig.enabled && 'review_routing_disabled',
    normalizedEvent.eligible !== 'true' && `normalized_event_ineligible:${normalizedEvent.ineligible_reason || 'unknown'}`,
    !trigger.type && 'unsupported_trigger',
    trigger.type && !routingConfig.acceptedTriggerTypes.includes(trigger.type) && `trigger_not_allowed:${trigger.type}`,
    !pullRequest.number && 'pull_request_number_missing',
    pullRequest.state && pullRequest.state !== 'open' && `pull_request_not_open:${pullRequest.state}`,
    pullRequest.draft && !routingConfig.allowDraft && 'draft_not_allowed',
    routingConfig.requireSameRepository && !pullRequest.isSameRepository && 'not_same_repository',
    pullRequest.isFork && 'fork_not_allowed',
    pullRequest.baseRepository && normalizedEvent.repository && pullRequest.baseRepository !== normalizedEvent.repository && 'base_repository_mismatch',
    pullRequest.baseRef && !allowedBaseBranches(routingConfig, config.baseBranch).includes(pullRequest.baseRef) && `base_branch_not_allowed:${pullRequest.baseRef}`,
    !pullRequest.headSha && 'head_sha_missing',
    normalizedEvent.head_sha && pullRequest.headSha && normalizedEvent.head_sha !== pullRequest.headSha && 'head_sha_mismatch',
    !ROUTE_TRUST_LEVELS.has(actorTrust) && `actor_not_trusted:${actorTrust}`,
    isBotLoopActor(normalizedEvent.actor, routingConfig) && 'bot_loop_actor',
    trigger.ciRequired && !trigger.ciSatisfied && 'required_ci_not_satisfied',
    hasSensitiveChangedFile(changedFiles, routingConfig) && 'sensitive_changed_file',
    hasSecretLikeAddedLine(changedFiles, input.secretLikePatterns) && 'secret_like_added_line',
    changedFiles.length > routingConfig.maxChangedFiles && 'changed_files_limit_exceeded',
    total(changedFiles, 'additions') > routingConfig.maxAdditions && 'diff_additions_limit_exceeded',
    total(changedFiles, 'deletions') > routingConfig.maxDeletions && 'diff_deletions_limit_exceeded',
    duplicateSuppressed && 'duplicate_suppressed',
    cooldownActive && 'cooldown_active'
  ]);

  if (skipReason) {
    return finalize({
      ...outputs,
      skip_reason: skipReason
    });
  }

  return finalize({
    ...outputs,
    should_route: 'true',
    route_reason: trigger.reason,
    eligible: 'true'
  });
}

function createDecision(source, decision, reason) {
  return {
    decision,
    reason,
    actor: cleanString(source.actor),
    url: cleanString(source.url),
    timestamp: cleanString(source.updatedAt ?? source.submittedAt ?? source.createdAt)
  };
}

export function classifyActorTrust({ actor, repositoryOwner, pullRequest, actorInfo = {}, config = DEFAULT_REVIEW_ROUTING }) {
  const login = cleanString(actor);

  if (!login) {
    return 'unknown';
  }

  if (config.trustedBotActors?.includes(login)) {
    return 'allowlisted-bot';
  }

  if (BOT_LOOP_ACTORS.has(login)) {
    return 'github-actions-bot';
  }

  if (config.trustedHumanActors?.includes(login)) {
    return 'allowlisted-human';
  }

  if (login === repositoryOwner) {
    return 'repository-owner';
  }

  if (actorInfo.permission && ['admin', 'maintain', 'write'].includes(actorInfo.permission)) {
    return 'collaborator';
  }

  if (actorInfo.isOrganizationMember === true) {
    return 'organization-member';
  }

  if (pullRequest?.isFork && login === pullRequest.author) {
    return 'fork-author';
  }

  return 'external-actor';
}

export function classifyTrigger({ normalizedEvent, eventPayload = {}, config = DEFAULT_REVIEW_ROUTING, ciWorkflowName = '' }) {
  const base = {
    type: '',
    source: normalizedEvent.event_name,
    reason: '',
    requestedReviewer: '',
    requestedLabel: '',
    requestedCommand: '',
    ciRequired: false,
    ciSatisfied: false
  };

  if (normalizedEvent.event_name === 'workflow_run') {
    const requiredWorkflows = config.requiredWorkflows?.length ? config.requiredWorkflows : [ciWorkflowName].filter(Boolean);
    const workflowName = normalizedEvent.workflow_name;
    const ciSatisfied = normalizedEvent.workflow_conclusion === 'success'
      && workflowName
      && (requiredWorkflows.length === 0 || requiredWorkflows.includes(workflowName));

    return {
      ...base,
      type: 'ci-success',
      reason: 'ci_success',
      ciRequired: true,
      ciSatisfied
    };
  }

  if (normalizedEvent.event_name === 'pull_request_review' || normalizedEvent.event_name === 'pull_request_review_comment') {
    const body = normalizedEvent.event_name === 'pull_request_review'
      ? eventPayload.review?.body
      : eventPayload.comment?.body;
    const command = findCommand(body, config.commands);

    if (command) {
      return {
        ...base,
        type: 'trusted-review-command',
        reason: 'trusted_review_command',
        requestedCommand: command
      };
    }

    const reviewer = cleanString(eventPayload.requested_reviewer?.login);
    if (reviewer && config.reviewerNames?.includes(reviewer)) {
      return {
        ...base,
        type: 'trusted-review-request',
        reason: 'trusted_review_request',
        requestedReviewer: reviewer
      };
    }
  }

  if (normalizedEvent.event_name === 'pull_request' && eventPayload.action === 'labeled') {
    const label = cleanString(eventPayload.label?.name);
    if (label && config.requestLabels?.includes(label)) {
      return {
        ...base,
        type: 'label-request',
        reason: 'label_request',
        requestedLabel: label
      };
    }
  }

  if (normalizedEvent.event_name === 'workflow_dispatch') {
    return {
      ...base,
      type: 'manual-review-request',
      reason: 'manual_review_request'
    };
  }

  return base;
}

export function createDedupeKey({ repository, pullRequestNumber, headSha, triggerType, configVersion = 1 }) {
  if (!repository || !pullRequestNumber || !headSha || !triggerType) {
    return '';
  }

  return `${repository}#${pullRequestNumber}:${headSha}:${triggerType}:v${configVersion}`;
}

export function hasSecretLikeAddedLine(changedFiles = [], secretLikePatterns = []) {
  const patterns = secretLikePatterns.length
    ? secretLikePatterns
    : ['secret', 'token', 'cookie', 'oauth', 'authorization', 'bearer', 'script.google.com/macros/s/', 'GAS_EVENTS_API_TOKEN', 'GAS_EVENTS_API_URL', '.env.local', '.clasp.json'];

  return changedFiles.some((file) => {
    const patch = typeof file.patch === 'string' ? file.patch : '';
    return patch.split(/\r?\n/).some((line) => {
      if (!line.startsWith('+') || line.startsWith('+++')) {
        return false;
      }
      return patterns.some((pattern) => line.toLowerCase().includes(String(pattern).toLowerCase()));
    });
  });
}

export function hasSensitiveChangedFile(changedFiles = [], config = DEFAULT_REVIEW_ROUTING) {
  const patterns = config.sensitivePathPatterns?.length ? config.sensitivePathPatterns : DEFAULT_REVIEW_ROUTING.sensitivePathPatterns;

  return changedFiles.some((file) => {
    const filename = cleanString(file.filename);
    return filename && patterns.some((pattern) => matchesGlob(filename, pattern));
  });
}

function normalizeEventOutputs(value = {}) {
  return {
    event_name: cleanString(value.event_name ?? value.eventName),
    event_action: cleanString(value.event_action ?? value.eventAction),
    repository: cleanString(value.repository),
    repository_owner: cleanString(value.repository_owner ?? value.repositoryOwner),
    default_branch: cleanString(value.default_branch ?? value.defaultBranch),
    actor: cleanString(value.actor),
    issue_number: cleanString(value.issue_number ?? value.issueNumber),
    pull_request_number: cleanString(value.pull_request_number ?? value.pullRequestNumber),
    head_sha: cleanString(value.head_sha ?? value.headSha),
    base_sha: cleanString(value.base_sha ?? value.baseSha),
    head_repository: cleanString(value.head_repository ?? value.headRepository),
    is_same_repository: boolOutput(value.is_same_repository ?? value.isSameRepository),
    is_fork: boolOutput(value.is_fork ?? value.isFork),
    workflow_name: cleanString(value.workflow_name ?? value.workflowName),
    workflow_conclusion: cleanString(value.workflow_conclusion ?? value.workflowConclusion),
    dry_run: boolOutput(value.dry_run ?? value.dryRun, 'true'),
    eligible: boolOutput(value.eligible),
    ineligible_reason: cleanString(value.ineligible_reason ?? value.ineligibleReason)
  };
}

function normalizePullRequest(value = {}, normalizedEvent) {
  value ??= {};
  const headRepository = cleanString(value.head?.repo?.full_name ?? value.headRepository ?? normalizedEvent.head_repository);
  const baseRepository = cleanString(value.base?.repo?.full_name ?? value.baseRepository ?? normalizedEvent.repository);
  const headSha = cleanSha(value.head?.sha ?? value.headSha ?? normalizedEvent.head_sha);
  const baseSha = cleanSha(value.base?.sha ?? value.baseSha ?? normalizedEvent.base_sha);
  const number = numberToOutput(value.number) || normalizedEvent.pull_request_number;
  const isFork = value.head?.repo?.fork === true || value.isFork === true || normalizedEvent.is_fork === 'true';
  const isSameRepository = (headRepository && baseRepository && headRepository === baseRepository && baseRepository === normalizedEvent.repository)
    || normalizedEvent.is_same_repository === 'true';

  return {
    number,
    state: cleanString(value.state) || 'open',
    draft: value.draft === true,
    author: cleanString(value.user?.login ?? value.author),
    baseRef: cleanString(value.base?.ref ?? value.baseRef ?? normalizedEvent.default_branch),
    baseRepository,
    headRepository,
    headSha,
    baseSha,
    isFork,
    isSameRepository
  };
}

function allowedBaseBranches(config, defaultBaseBranch) {
  return config.allowedBaseBranches?.length ? config.allowedBaseBranches : [defaultBaseBranch].filter(Boolean);
}

function findCommand(body, commands = []) {
  const text = typeof body === 'string' ? body : '';
  return commands.find((command) => new RegExp(`(^|\\s)${escapeRegExp(command)}(\\s|$)`).test(text)) ?? '';
}

function isDuplicateSuppressed({ dedupeKey, existingDedupeKeys = [], duplicatePolicy }) {
  return duplicatePolicy !== 'allow-rerun' && dedupeKey && existingDedupeKeys.includes(dedupeKey);
}

function isCooldownActive({ now, lastRoutedAt, cooldownSeconds = 0 }) {
  if (!cooldownSeconds || !lastRoutedAt) {
    return false;
  }

  const nowTime = now ? new Date(now).getTime() : Date.now();
  const lastTime = new Date(lastRoutedAt).getTime();

  return Number.isFinite(nowTime) && Number.isFinite(lastTime) && nowTime - lastTime < cooldownSeconds * 1000;
}

function isBotLoopActor(actor, config) {
  const login = cleanString(actor);
  return BOT_LOOP_ACTORS.has(login) && !config.trustedBotActors?.includes(login);
}

function total(changedFiles, key) {
  return changedFiles.reduce((sum, file) => sum + (Number.isInteger(file[key]) ? file[key] : 0), 0);
}

function firstSkipReason(reasons) {
  return reasons.find(Boolean) || '';
}

function finalize(outputs) {
  return {
    ok: outputs.should_route === 'true',
    outputs: {
      ...EMPTY_OUTPUTS,
      ...outputs
    }
  };
}

function matchesGlob(filename, pattern) {
  const regex = new RegExp(`^${escapeRegExp(pattern).replaceAll('\\*\\*', '.*').replaceAll('\\*', '[^/]*')}$`, 'i');
  return regex.test(filename);
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
