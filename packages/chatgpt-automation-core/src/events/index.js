export const SUPPORTED_EVENT_NAMES = Object.freeze([
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
  'pull_request',
  'push',
  'check_suite',
  'check_run',
  'workflow_dispatch'
]);

export const NORMALIZED_EVENT_OUTPUT_NAMES = Object.freeze([
  'event_name',
  'event_action',
  'repository',
  'repository_owner',
  'default_branch',
  'actor',
  'issue_number',
  'pull_request_number',
  'head_sha',
  'base_sha',
  'head_repository',
  'is_same_repository',
  'is_fork',
  'workflow_name',
  'workflow_conclusion',
  'dry_run',
  'eligible',
  'ineligible_reason'
]);

const EMPTY_OUTPUTS = Object.freeze({
  event_name: '',
  event_action: '',
  repository: '',
  repository_owner: '',
  default_branch: '',
  actor: '',
  issue_number: '',
  pull_request_number: '',
  head_sha: '',
  base_sha: '',
  head_repository: '',
  is_same_repository: 'false',
  is_fork: 'false',
  workflow_name: '',
  workflow_conclusion: '',
  dry_run: 'true',
  eligible: 'false',
  ineligible_reason: ''
});

const ALLOWED_ACTIONS = Object.freeze({
  issue_comment: new Set(['created', 'edited']),
  pull_request_review: new Set(['submitted']),
  pull_request_review_comment: new Set(['created', 'edited']),
  workflow_run: new Set(['completed']),
  pull_request: new Set(['closed', 'ready_for_review', 'synchronize']),
  check_suite: new Set(['completed']),
  check_run: new Set(['completed'])
});

export function normalizeAutomationEvent(input = {}) {
  const errors = [];
  const payloadResult = readPayload(input.payload);
  const dryRunResult = readBooleanInput(input.dryRun, true);
  const repositoryConfigResult = readRepositoryConfig(input.repositoryConfigJson);
  const payload = payloadResult.value;
  const eventName = cleanString(input.eventName);
  const eventAction = cleanString(input.eventAction) || cleanString(payload?.action);
  const repository = cleanRepository(input.repository) || cleanRepository(payload?.repository?.full_name);
  const repositoryOwner = cleanString(input.repositoryOwner) || repository.split('/')[0] || cleanString(payload?.repository?.owner?.login);
  const defaultBranch = cleanBranch(input.defaultBranch) || cleanBranch(payload?.repository?.default_branch);
  const actor = cleanString(input.actor) || cleanString(payload?.sender?.login);
  const permissionMode = cleanString(input.permissionMode) || 'read-only';
  const requestedCapability = cleanString(input.requestedCapability) || 'normalize-only';
  const baseOutputs = {
    ...EMPTY_OUTPUTS,
    event_name: eventName,
    event_action: eventAction,
    repository,
    repository_owner: repositoryOwner,
    default_branch: defaultBranch,
    actor,
    dry_run: dryRunResult.value ? 'true' : 'false'
  };

  if (!payloadResult.ok) {
    errors.push('event payload json is invalid');
  }
  if (!dryRunResult.ok) {
    errors.push('dry-run input must be true or false');
  }
  if (!repositoryConfigResult.ok) {
    errors.push('repository config json must be an object');
  }
  if (!eventName) {
    errors.push('missing required input: event-name');
  }
  if (!repository) {
    errors.push('missing required input: repository');
  }
  if (!SUPPORTED_EVENT_NAMES.includes(eventName)) {
    errors.push('unsupported event');
  }
  if (permissionMode !== 'read-only') {
    errors.push('permission mode is not read-only');
  }
  if (!['normalize-only', 'main-follow-up-plan'].includes(requestedCapability)) {
    errors.push('write capability is not implemented');
  }
  if (repository && cleanRepository(payload?.repository?.full_name) && cleanRepository(payload.repository.full_name) !== repository) {
    errors.push('repository mismatch');
  }

  if (errors.length > 0) {
    return finalize(baseOutputs, errors);
  }

  switch (eventName) {
    case 'issue_comment':
      return normalizeIssueComment({ payload, eventAction, repository, baseOutputs });
    case 'pull_request_review':
      return normalizePullRequestPayload({
        payload,
        eventAction,
        repository,
        baseOutputs,
        allowedActions: ALLOWED_ACTIONS.pull_request_review,
        payloadName: 'pull_request_review'
      });
    case 'pull_request_review_comment':
      return normalizePullRequestPayload({
        payload,
        eventAction,
        repository,
        baseOutputs,
        allowedActions: ALLOWED_ACTIONS.pull_request_review_comment,
        payloadName: 'pull_request_review_comment'
      });
    case 'workflow_run':
      return normalizeWorkflowRun({ payload, eventAction, repository, baseOutputs });
    case 'pull_request':
      return normalizePullRequestClosed({ payload, eventAction, repository, baseOutputs });
    case 'push':
      return normalizePush({ payload, repository, defaultBranch, baseOutputs, fallbackSha: input.sha, fallbackRefName: input.refName });
    case 'check_suite':
      return normalizeCheckSuite({ payload, eventAction, repository, baseOutputs });
    case 'check_run':
      return normalizeCheckRun({ payload, eventAction, repository, baseOutputs });
    case 'workflow_dispatch':
      return normalizeWorkflowDispatch({ payload, repository, baseOutputs, fallbackSha: input.sha, requestedCapability });
    default:
      return finalize(baseOutputs, ['unsupported event']);
  }
}

function normalizeIssueComment({ payload, eventAction, repository, baseOutputs }) {
  const issueNumber = numberToOutput(payload?.issue?.number);
  const isPullRequestComment = Boolean(payload?.issue?.pull_request);
  const errors = [];

  if (!ALLOWED_ACTIONS.issue_comment.has(eventAction)) {
    errors.push('unsupported action for issue_comment');
  }
  if (!issueNumber) {
    errors.push('missing issue number');
  }
  if (isPullRequestComment) {
    errors.push('pull request issue_comment provenance is not verified');
  }

  return finalize({
    ...baseOutputs,
    issue_number: issueNumber,
    pull_request_number: isPullRequestComment ? issueNumber : '',
    is_same_repository: isPullRequestComment ? 'false' : 'true',
    is_fork: 'false'
  }, errors);
}

function normalizePullRequestPayload({ payload, eventAction, repository, baseOutputs, allowedActions, payloadName }) {
  const pullRequest = payload?.pull_request;
  const outputs = pullRequestOutputs(baseOutputs, pullRequest, repository);
  const errors = [];

  if (!allowedActions.has(eventAction)) {
    errors.push(`unsupported action for ${payloadName}`);
  }
  if (!outputs.pull_request_number) {
    errors.push('missing pull request number');
  }
  appendForkErrors(outputs, errors);

  return finalize(outputs, errors);
}

function normalizeWorkflowRun({ payload, eventAction, repository, baseOutputs }) {
  const workflowRun = payload?.workflow_run;
  const headRepository = cleanRepository(workflowRun?.head_repository?.full_name);
  const pullRequestNumber = numberToOutput(workflowRun?.pull_requests?.[0]?.number);
  const outputs = {
    ...baseOutputs,
    pull_request_number: pullRequestNumber,
    head_sha: cleanSha(workflowRun?.head_sha),
    head_repository: headRepository,
    is_same_repository: headRepository === repository ? 'true' : 'false',
    is_fork: headRepository && headRepository !== repository ? 'true' : 'false',
    workflow_name: cleanString(workflowRun?.name),
    workflow_conclusion: cleanString(workflowRun?.conclusion)
  };
  const errors = [];

  if (!ALLOWED_ACTIONS.workflow_run.has(eventAction)) {
    errors.push('unsupported action for workflow_run');
  }
  if (outputs.workflow_conclusion !== 'success') {
    errors.push('workflow_run conclusion is not success');
  }
  if (!outputs.head_sha) {
    errors.push('missing head sha');
  }
  appendForkErrors(outputs, errors);

  return finalize(outputs, errors);
}

function normalizePullRequestClosed({ payload, eventAction, repository, baseOutputs }) {
  const outputs = pullRequestOutputs(baseOutputs, payload?.pull_request, repository);
  const errors = [];

  if (!ALLOWED_ACTIONS.pull_request.has(eventAction)) {
    errors.push('unsupported action for pull_request');
  }
  if (!outputs.pull_request_number) {
    errors.push('missing pull request number');
  }
  if (eventAction === 'closed' && payload?.pull_request?.merged !== true) {
    errors.push('pull request was not merged');
  }
  appendForkErrors(outputs, errors);

  return finalize(outputs, errors);
}

function normalizeCheckSuite({ payload, eventAction, repository, baseOutputs }) {
  const checkSuite = payload?.check_suite;
  const headRepository = cleanRepository(checkSuite?.head_repository?.full_name) || repository;
  const pullRequest = checkSuite?.pull_requests?.[0];
  const outputs = {
    ...baseOutputs,
    pull_request_number: numberToOutput(pullRequest?.number),
    head_sha: cleanSha(checkSuite?.head_sha),
    base_sha: cleanSha(pullRequest?.base?.sha),
    head_repository: headRepository,
    is_same_repository: headRepository === repository ? 'true' : 'false',
    is_fork: headRepository && headRepository !== repository ? 'true' : 'false',
    workflow_name: cleanString(checkSuite?.app?.name || checkSuite?.name || 'check_suite'),
    workflow_conclusion: cleanString(checkSuite?.conclusion)
  };
  const errors = [];

  if (!ALLOWED_ACTIONS.check_suite.has(eventAction)) {
    errors.push('unsupported action for check_suite');
  }
  if (outputs.workflow_conclusion !== 'success') {
    errors.push('check_suite conclusion is not success');
  }
  if (!outputs.pull_request_number) {
    errors.push('missing pull request number');
  }
  if (!outputs.head_sha) {
    errors.push('missing head sha');
  }
  appendForkErrors(outputs, errors);

  return finalize(outputs, errors);
}

function normalizeCheckRun({ payload, eventAction, repository, baseOutputs }) {
  const checkRun = payload?.check_run;
  const pullRequest = checkRun?.pull_requests?.[0];
  const headRepository = cleanRepository(pullRequest?.head?.repo?.full_name) || repository;
  const outputs = {
    ...baseOutputs,
    pull_request_number: numberToOutput(pullRequest?.number),
    head_sha: cleanSha(checkRun?.head_sha),
    base_sha: cleanSha(pullRequest?.base?.sha),
    head_repository: headRepository,
    is_same_repository: headRepository === repository ? 'true' : 'false',
    is_fork: headRepository && headRepository !== repository ? 'true' : 'false',
    workflow_name: cleanString(checkRun?.name),
    workflow_conclusion: cleanString(checkRun?.conclusion)
  };
  const errors = [];

  if (!ALLOWED_ACTIONS.check_run.has(eventAction)) {
    errors.push('unsupported action for check_run');
  }
  if (outputs.workflow_conclusion !== 'success') {
    errors.push('check_run conclusion is not success');
  }
  if (!outputs.pull_request_number) {
    errors.push('missing pull request number');
  }
  if (!outputs.head_sha) {
    errors.push('missing head sha');
  }
  appendForkErrors(outputs, errors);

  return finalize(outputs, errors);
}

function normalizePush({ payload, repository, defaultBranch, baseOutputs, fallbackSha, fallbackRefName }) {
  const ref = cleanString(payload?.ref);
  const branch = branchFromRef(ref) || cleanBranch(fallbackRefName);
  const outputs = {
    ...baseOutputs,
    head_sha: cleanSha(payload?.after) || cleanSha(fallbackSha),
    base_sha: cleanSha(payload?.before),
    head_repository: repository,
    is_same_repository: 'true',
    is_fork: 'false'
  };
  const errors = [];

  if (!defaultBranch) {
    errors.push('missing default branch');
  }
  if (!branch) {
    errors.push('missing push branch');
  }
  if (defaultBranch && branch && branch !== defaultBranch) {
    errors.push('push target is not default branch');
  }
  if (!outputs.head_sha) {
    errors.push('missing head sha');
  }

  return finalize(outputs, errors);
}

function normalizeWorkflowDispatch({ payload, repository, baseOutputs, fallbackSha, requestedCapability }) {
  const pullRequestNumber = numberToOutput(Number.parseInt(cleanString(payload?.inputs?.pull_request_number ?? payload?.inputs?.pr_number), 10));
  const outputs = {
    ...baseOutputs,
    pull_request_number: pullRequestNumber,
    head_sha: cleanSha(payload?.inputs?.head_sha) || cleanSha(fallbackSha),
    head_repository: repository,
    is_same_repository: 'true',
    is_fork: 'false'
  };
  const errors = [];

  if (!pullRequestNumber && requestedCapability !== 'main-follow-up-plan') {
    errors.push('missing manual pull request number');
  }

  return finalize(outputs, errors);
}

function pullRequestOutputs(baseOutputs, pullRequest, repository) {
  const headRepository = cleanRepository(pullRequest?.head?.repo?.full_name);
  const baseRepository = cleanRepository(pullRequest?.base?.repo?.full_name) || repository;
  const isSameRepository = headRepository === repository && baseRepository === repository;
  const isFork = pullRequest?.head?.repo?.fork === true || (headRepository !== '' && headRepository !== repository);

  return {
    ...baseOutputs,
    issue_number: numberToOutput(pullRequest?.number),
    pull_request_number: numberToOutput(pullRequest?.number),
    head_sha: cleanSha(pullRequest?.head?.sha),
    base_sha: cleanSha(pullRequest?.base?.sha),
    head_repository: headRepository,
    is_same_repository: isSameRepository ? 'true' : 'false',
    is_fork: isFork ? 'true' : 'false'
  };
}

function appendForkErrors(outputs, errors) {
  if (outputs.is_same_repository !== 'true' || outputs.is_fork === 'true') {
    errors.push('fork or external pull request');
  }
}

function finalize(outputs, errors) {
  const normalized = {
    ...EMPTY_OUTPUTS,
    ...outputs,
    eligible: errors.length === 0 ? 'true' : 'false',
    ineligible_reason: errors.join('; ')
  };

  return {
    ok: errors.length === 0,
    outputs: normalized,
    errors: errors.map((message) => ({ code: toErrorCode(message), message }))
  };
}

function readPayload(value) {
  if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value !== 'string') {
    return { ok: false, value: {} };
  }
  try {
    const parsed = JSON.parse(value);
    return {
      ok: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      value: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    };
  } catch {
    return { ok: false, value: {} };
  }
}

function readRepositoryConfig(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: {} };
  }
  if (typeof value !== 'string') {
    return { ok: false, value: {} };
  }
  try {
    const parsed = JSON.parse(value);
    return {
      ok: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      value: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    };
  } catch {
    return { ok: false, value: {} };
  }
}

function readBooleanInput(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: defaultValue };
  }
  if (value === true || value === 'true') {
    return { ok: true, value: true };
  }
  if (value === false || value === 'false') {
    return { ok: true, value: false };
  }
  return { ok: false, value: defaultValue };
}

function branchFromRef(ref) {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
}

function numberToOutput(value) {
  return Number.isInteger(value) && value > 0 ? String(value) : '';
}

function cleanRepository(value) {
  const text = cleanString(value);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : '';
}

function cleanBranch(value) {
  return cleanString(value).replace(/^refs\/heads\//, '');
}

function cleanSha(value) {
  const text = cleanString(value);
  return /^[a-f0-9]{40}$/i.test(text) ? text : '';
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toErrorCode(message) {
  return message
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
