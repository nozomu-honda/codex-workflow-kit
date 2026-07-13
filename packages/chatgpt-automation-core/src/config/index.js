import YAML from 'yaml';

export const CONFIG_VERSION = 1;

export const DEFAULT_LABELS = Object.freeze({
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
});

export const DEFAULT_HARD_BLOCK_FILE_PATTERNS = Object.freeze([
  '.github/**',
  'gas/**',
  '.env*',
  '.clasp.json',
  'appsscript.json',
  'package.json',
  'package-lock.json',
  '**/*auth*',
  '**/*oauth*',
  '**/*token*',
  '**/*secret*',
  '**/*cookie*',
  '**/*credential*'
]);

export const DEFAULT_SECRET_LIKE_PATTERNS = Object.freeze([
  'secret',
  'token',
  'cookie',
  'oauth',
  'authorization',
  'bearer',
  'script.google.com/macros/s/',
  'GAS_EVENTS_API_TOKEN',
  'GAS_EVENTS_API_URL',
  '.env.local',
  '.clasp.json'
]);

export const DEFAULT_MARKERS = Object.freeze({
  approved: '<!-- chatgpt-review: approved -->',
  changesRequested: '<!-- chatgpt-review: changes_requested -->',
  reviewRequest: '<!-- chatgpt-review-request -->'
});

const DEFAULT_FEATURES = Object.freeze({
  autoRequest: false,
  routeReview: false,
  autoMerge: false,
  mainFollowup: false,
  actionsApproval: false
});

const DEFAULT_SECRETS = Object.freeze({
  reviewRequestCommentToken: 'REVIEW_REQUEST_COMMENT_TOKEN',
  prBranchUpdateToken: 'PR_BRANCH_UPDATE_TOKEN',
  autoMergeToken: 'AUTO_MERGE_TOKEN',
  actionsApproverToken: 'ACTIONS_APPROVER_TOKEN'
});

const DEFAULT_VARIABLES = Object.freeze({
  codexTrigger: 'CODEX_TRIGGER_COMMENT',
  mainFollowupEnabled: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX',
  maxAttempts: 'CODEX_AUTO_FIX_MAX_ATTEMPTS'
});

const DEFAULT_CAPABILITIES = Object.freeze({
  autoRequest: false,
  routeReview: false,
  autoMerge: false,
  mainFollowup: false,
  actionsApproval: false
});

const ROOT_KEYS = [
  'version',
  'baseBranch',
  'ciWorkflowName',
  'mergeMethod',
  'dryRunDefault',
  'features',
  'labels',
  'review',
  'protectedFiles',
  'secretLike',
  'queues',
  'codex',
  'schedules',
  'secrets',
  'variables'
];

const LABEL_KEYS = Object.keys(DEFAULT_LABELS);
const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES);
const SECRET_KEYS = Object.keys(DEFAULT_SECRETS);
const VARIABLE_KEYS = Object.keys(DEFAULT_VARIABLES);
const QUEUE_KEYS = ['reviewFix', 'mainFollowup'];
const CODEX_KEYS = ['reviewFix', 'mainFollowup'];
const SCHEDULE_KEYS = ['reviewRequest', 'autoMerge', 'mainFollowup', 'actionsApproval'];
const MERGE_METHODS = ['squash', 'merge', 'rebase'];
const REVIEW_DECISION_MODES = ['marker-only', 'trusted-actors'];
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CRON_TOKEN_PATTERN = /^[A-Za-z0-9*/,\-?]+$/;

export function validateAutomationConfig(input) {
  const parseResult = parseConfigInput(input);

  if (!parseResult.ok) {
    return fail(parseResult.errors);
  }

  return validateAutomationConfigObject(parseResult.value);
}

export function parseConfigInput(input) {
  if (typeof input === 'string') {
    const document = YAML.parseDocument(input, { prettyErrors: false });

    if (document.errors.length > 0) {
      return {
        ok: false,
        value: null,
        errors: [
          issue('root', 'YAML_PARSE_ERROR', 'Config YAML could not be parsed.')
        ]
      };
    }

    return {
      ok: true,
      value: document.toJS()
    };
  }

  return {
    ok: true,
    value: input
  };
}

export function validateAutomationConfigObject(rawConfig) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(rawConfig)) {
    errors.push(issue('root', 'ROOT_OBJECT_REQUIRED', 'Config root must be an object.'));
    return fail(errors, warnings);
  }

  warnUnknownKeys(rawConfig, 'root', ROOT_KEYS, warnings);

  const normalized = {
    version: normalizeVersion(rawConfig.version, errors),
    baseBranch: normalizeBaseBranch(rawConfig.baseBranch, errors),
    ciWorkflowName: normalizeCiWorkflowName(rawConfig.ciWorkflowName, errors),
    mergeMethod: normalizeMergeMethod(rawConfig.mergeMethod, errors),
    dryRunDefault: normalizeOptionalBoolean(rawConfig.dryRunDefault, true, 'dryRunDefault', errors),
    features: normalizeFeatureFlags(rawConfig.features, errors, warnings),
    labels: normalizeLabels(rawConfig.labels, errors, warnings),
    review: normalizeReview(rawConfig.review, errors, warnings),
    protectedFiles: normalizeProtectedFiles(rawConfig.protectedFiles, errors, warnings),
    secretLike: normalizeSecretLike(rawConfig.secretLike, errors, warnings),
    queues: normalizeQueues(rawConfig.queues, errors, warnings),
    codex: normalizeCodex(rawConfig.codex, errors, warnings),
    schedules: normalizeSchedules(rawConfig.schedules, errors, warnings),
    secrets: normalizeNamedMap(rawConfig.secrets, DEFAULT_SECRETS, SECRET_KEYS, 'secrets', errors, warnings),
    variables: normalizeNamedMap(rawConfig.variables, DEFAULT_VARIABLES, VARIABLE_KEYS, 'variables', errors, warnings)
  };

  validateCrossFieldRules(normalized, errors);

  if (errors.length > 0) {
    return fail(errors, warnings);
  }

  return {
    ok: true,
    config: normalized,
    errors,
    warnings,
    capabilities: { ...normalized.features }
  };
}

function normalizeVersion(value, errors) {
  if (value === CONFIG_VERSION || value === String(CONFIG_VERSION)) {
    return CONFIG_VERSION;
  }

  errors.push(issue('version', 'UNSUPPORTED_VERSION', 'Config version is required and must be supported.'));
  return null;
}

function normalizeBaseBranch(value, errors) {
  if (!isNonEmptyString(value) || !BRANCH_PATTERN.test(value)) {
    errors.push(issue('baseBranch', 'INVALID_BASE_BRANCH', 'Base branch is required and must use a safe branch name.'));
    return null;
  }

  return value;
}

function normalizeCiWorkflowName(value, errors) {
  if (!isNonEmptyString(value) || value.includes('\n') || value.includes('\r')) {
    errors.push(issue('ciWorkflowName', 'INVALID_CI_WORKFLOW_NAME', 'CI workflow name is required and must be a single line.'));
    return null;
  }

  return value;
}

function normalizeMergeMethod(value, errors) {
  const mergeMethod = value ?? 'squash';

  if (!MERGE_METHODS.includes(mergeMethod)) {
    errors.push(issue('mergeMethod', 'INVALID_MERGE_METHOD', 'Merge method must be one of the supported values.'));
    return null;
  }

  return mergeMethod;
}

function normalizeFeatureFlags(value, errors, warnings) {
  const normalized = { ...DEFAULT_FEATURES };

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('features', 'OBJECT_REQUIRED', 'Feature flags must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, 'features', FEATURE_KEYS, warnings);

  for (const key of FEATURE_KEYS) {
    if (value[key] === undefined) {
      continue;
    }

    if (typeof value[key] !== 'boolean') {
      errors.push(issue(`features.${key}`, 'BOOLEAN_REQUIRED', 'Feature flags must be boolean values.'));
      continue;
    }

    normalized[key] = value[key];
  }

  return normalized;
}

function normalizeLabels(value, errors, warnings) {
  const normalized = { ...DEFAULT_LABELS };

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('labels', 'OBJECT_REQUIRED', 'Labels must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, 'labels', LABEL_KEYS, warnings);

  for (const key of LABEL_KEYS) {
    if (value[key] === undefined) {
      continue;
    }

    if (!isNonEmptyString(value[key])) {
      errors.push(issue(`labels.${key}`, 'LABEL_REQUIRED', 'Label names must be non-empty strings.'));
      continue;
    }

    normalized[key] = value[key];
  }

  return normalized;
}

function normalizeReview(value, errors, warnings) {
  const review = {
    decisionMode: 'marker-only',
    trustedActors: [],
    markers: {
      ...DEFAULT_MARKERS,
      ignoreInFencedCodeBlocks: true,
      excludeReviewRequestComments: true
    },
    decisions: {
      stopOnLatestChangesRequested: true
    }
  };

  if (value === undefined) {
    return review;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('review', 'OBJECT_REQUIRED', 'Review config must be an object.'));
    return review;
  }

  warnUnknownKeys(value, 'review', ['decisionMode', 'trustedActors', 'markers', 'decisions'], warnings);

  if (value.decisionMode !== undefined) {
    if (!REVIEW_DECISION_MODES.includes(value.decisionMode)) {
      errors.push(issue('review.decisionMode', 'INVALID_REVIEW_DECISION_MODE', 'Review decision mode is not supported.'));
    } else {
      review.decisionMode = value.decisionMode;
    }
  }

  if (value.trustedActors !== undefined) {
    if (!Array.isArray(value.trustedActors)) {
      errors.push(issue('review.trustedActors', 'ARRAY_REQUIRED', 'Trusted actors must be an array.'));
    } else {
      review.trustedActors = normalizeStringArray(value.trustedActors, 'review.trustedActors', errors);
    }
  }

  if (value.markers !== undefined) {
    normalizeReviewMarkers(value.markers, review.markers, errors, warnings);
  }

  if (value.decisions !== undefined) {
    normalizeReviewDecisions(value.decisions, review.decisions, errors, warnings);
  }

  return review;
}

function normalizeReviewMarkers(value, markers, errors, warnings) {
  if (!isPlainObject(value)) {
    errors.push(issue('review.markers', 'OBJECT_REQUIRED', 'Review markers must be an object.'));
    return;
  }

  warnUnknownKeys(value, 'review.markers', [
    'approved',
    'changesRequested',
    'reviewRequest',
    'ignoreInFencedCodeBlocks',
    'excludeReviewRequestComments'
  ], warnings);

  for (const key of ['approved', 'changesRequested', 'reviewRequest']) {
    if (value[key] === undefined) {
      continue;
    }

    if (!isNonEmptyString(value[key])) {
      errors.push(issue(`review.markers.${key}`, 'MARKER_REQUIRED', 'Review markers must be non-empty strings.'));
      continue;
    }

    markers[key] = value[key];
  }

  if (value.ignoreInFencedCodeBlocks !== undefined) {
    if (value.ignoreInFencedCodeBlocks !== true) {
      errors.push(issue('review.markers.ignoreInFencedCodeBlocks', 'FENCED_MARKER_IGNORE_REQUIRED', 'Markers inside fenced code blocks must remain ignored.'));
    }
    markers.ignoreInFencedCodeBlocks = true;
  }

  if (value.excludeReviewRequestComments !== undefined) {
    if (value.excludeReviewRequestComments !== true) {
      errors.push(issue('review.markers.excludeReviewRequestComments', 'REVIEW_REQUEST_EXCLUSION_REQUIRED', 'Review request comments must remain excluded.'));
    }
    markers.excludeReviewRequestComments = true;
  }
}

function normalizeReviewDecisions(value, decisions, errors, warnings) {
  if (!isPlainObject(value)) {
    errors.push(issue('review.decisions', 'OBJECT_REQUIRED', 'Review decision config must be an object.'));
    return;
  }

  warnUnknownKeys(value, 'review.decisions', ['stopOnLatestChangesRequested'], warnings);

  if (value.stopOnLatestChangesRequested !== undefined) {
    if (value.stopOnLatestChangesRequested !== true) {
      errors.push(issue('review.decisions.stopOnLatestChangesRequested', 'LATEST_CHANGES_REQUESTED_REQUIRED', 'Latest changes_requested must remain a stop condition.'));
    }
    decisions.stopOnLatestChangesRequested = true;
  }
}

function normalizeProtectedFiles(value, errors, warnings) {
  const normalized = {
    hardBlockDefaults: [...DEFAULT_HARD_BLOCK_FILE_PATTERNS],
    hardBlockPatterns: [...DEFAULT_HARD_BLOCK_FILE_PATTERNS],
    additionalHardBlockPatterns: [],
    warningOnlyPatterns: []
  };

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('protectedFiles', 'OBJECT_REQUIRED', 'Protected files config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, 'protectedFiles', [
    'disableDefaults',
    'defaultHardBlockPatterns',
    'hardBlockPatterns',
    'warningOnlyPatterns'
  ], warnings);

  if (value.disableDefaults === true) {
    errors.push(issue('protectedFiles.disableDefaults', 'HARD_BLOCK_DEFAULTS_REQUIRED', 'Hard-block defaults cannot be disabled.'));
  } else if (value.disableDefaults !== undefined && typeof value.disableDefaults !== 'boolean') {
    errors.push(issue('protectedFiles.disableDefaults', 'BOOLEAN_REQUIRED', 'disableDefaults must be a boolean value.'));
  }

  if (value.defaultHardBlockPatterns !== undefined) {
    errors.push(issue('protectedFiles.defaultHardBlockPatterns', 'READONLY_HARD_BLOCK_DEFAULTS', 'Hard-block defaults are read-only.'));
  }

  const additionalHardBlockPatterns = normalizeOptionalPatternArray(value.hardBlockPatterns, 'protectedFiles.hardBlockPatterns', errors);
  const warningOnlyPatterns = normalizeOptionalPatternArray(value.warningOnlyPatterns, 'protectedFiles.warningOnlyPatterns', errors);

  for (const pattern of warningOnlyPatterns) {
    if (DEFAULT_HARD_BLOCK_FILE_PATTERNS.includes(pattern) || isSecretLikePattern(pattern)) {
      errors.push(issue('protectedFiles.warningOnlyPatterns', 'HARD_BLOCK_DOWNGRADE_FORBIDDEN', 'Hard-blocked or secret-like patterns cannot become warning-only.'));
      break;
    }
  }

  normalized.additionalHardBlockPatterns = additionalHardBlockPatterns;
  normalized.hardBlockPatterns = unique([...normalized.hardBlockPatterns, ...additionalHardBlockPatterns]);
  normalized.warningOnlyPatterns = warningOnlyPatterns;

  return normalized;
}

function normalizeSecretLike(value, errors, warnings) {
  const normalized = {
    hardBlockDefaults: [...DEFAULT_SECRET_LIKE_PATTERNS],
    hardBlockPatterns: [...DEFAULT_SECRET_LIKE_PATTERNS],
    additionalHardBlockPatterns: [],
    warningOnlyPatterns: []
  };

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('secretLike', 'OBJECT_REQUIRED', 'Secret-like config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, 'secretLike', [
    'disableDefaults',
    'defaultHardBlockPatterns',
    'hardBlockPatterns',
    'warningOnlyPatterns'
  ], warnings);

  if (value.disableDefaults === true) {
    errors.push(issue('secretLike.disableDefaults', 'SECRET_HARD_BLOCK_REQUIRED', 'Secret-like hard-block defaults cannot be disabled.'));
  } else if (value.disableDefaults !== undefined && typeof value.disableDefaults !== 'boolean') {
    errors.push(issue('secretLike.disableDefaults', 'BOOLEAN_REQUIRED', 'disableDefaults must be a boolean value.'));
  }

  if (value.defaultHardBlockPatterns !== undefined) {
    errors.push(issue('secretLike.defaultHardBlockPatterns', 'READONLY_SECRET_HARD_BLOCK_DEFAULTS', 'Secret-like hard-block defaults are read-only.'));
  }

  const additionalHardBlockPatterns = normalizeOptionalPatternArray(value.hardBlockPatterns, 'secretLike.hardBlockPatterns', errors);
  const warningOnlyPatterns = normalizeOptionalPatternArray(value.warningOnlyPatterns, 'secretLike.warningOnlyPatterns', errors);

  for (const pattern of warningOnlyPatterns) {
    if (isSecretLikePattern(pattern)) {
      errors.push(issue('secretLike.warningOnlyPatterns', 'SECRET_HARD_BLOCK_DOWNGRADE_FORBIDDEN', 'Secret-like patterns cannot become warning-only.'));
      break;
    }
  }

  normalized.additionalHardBlockPatterns = additionalHardBlockPatterns;
  normalized.hardBlockPatterns = unique([...normalized.hardBlockPatterns, ...additionalHardBlockPatterns]);
  normalized.warningOnlyPatterns = warningOnlyPatterns;

  return normalized;
}

function normalizeQueues(value, errors, warnings) {
  const normalized = {
    reviewFix: defaultQueue(),
    mainFollowup: defaultQueue()
  };

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('queues', 'OBJECT_REQUIRED', 'Queues config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, 'queues', QUEUE_KEYS, warnings);

  for (const key of QUEUE_KEYS) {
    if (value[key] !== undefined) {
      normalized[key] = normalizeQueue(value[key], `queues.${key}`, errors, warnings);
    }
  }

  return normalized;
}

function normalizeQueue(value, path, errors, warnings) {
  const normalized = defaultQueue();

  if (!isPlainObject(value)) {
    errors.push(issue(path, 'OBJECT_REQUIRED', 'Queue config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, path, ['enabled', 'issueNumber', 'issueTitle'], warnings);
  normalized.enabled = normalizeOptionalBoolean(value.enabled, false, `${path}.enabled`, errors);

  if (value.issueNumber !== undefined) {
    if (!Number.isInteger(value.issueNumber) || value.issueNumber < 1) {
      errors.push(issue(`${path}.issueNumber`, 'INVALID_ISSUE_NUMBER', 'Queue issue number must be a positive integer.'));
    } else {
      normalized.issueNumber = value.issueNumber;
    }
  }

  if (value.issueTitle !== undefined) {
    if (!isNonEmptyString(value.issueTitle)) {
      errors.push(issue(`${path}.issueTitle`, 'ISSUE_TITLE_REQUIRED', 'Queue issue title must be a non-empty string.'));
    } else {
      normalized.issueTitle = value.issueTitle;
    }
  }

  if (normalized.enabled && normalized.issueNumber === null && normalized.issueTitle === null) {
    errors.push(issue(path, 'QUEUE_TARGET_REQUIRED', 'Enabled queues must define an issue number or issue title.'));
  }

  return normalized;
}

function normalizeCodex(value, errors, warnings) {
  const normalized = {
    reviewFix: defaultCodexAutoFix(DEFAULT_LABELS.doNotAutoCodexFix, DEFAULT_LABELS.codexFixInProgress),
    mainFollowup: defaultCodexAutoFix(DEFAULT_LABELS.doNotAutoCodexMainFollowup, DEFAULT_LABELS.codexMainFollowupInProgress)
  };

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('codex', 'OBJECT_REQUIRED', 'Codex config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, 'codex', CODEX_KEYS, warnings);

  if (value.reviewFix !== undefined) {
    normalized.reviewFix = normalizeCodexAutoFix(value.reviewFix, 'codex.reviewFix', normalized.reviewFix, errors, warnings);
  }

  if (value.mainFollowup !== undefined) {
    normalized.mainFollowup = normalizeCodexAutoFix(value.mainFollowup, 'codex.mainFollowup', normalized.mainFollowup, errors, warnings);
  }

  return normalized;
}

function normalizeCodexAutoFix(value, path, defaults, errors, warnings) {
  const normalized = { ...defaults };

  if (!isPlainObject(value)) {
    errors.push(issue(path, 'OBJECT_REQUIRED', 'Codex auto-fix config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, path, [
    'enabled',
    'maxAttempts',
    'sameRepoOnly',
    'allowDraft',
    'blockedLabel',
    'inProgressLabel',
    'triggerVariableName'
  ], warnings);

  normalized.enabled = normalizeOptionalBoolean(value.enabled, false, `${path}.enabled`, errors);
  normalized.allowDraft = normalizeOptionalBoolean(value.allowDraft, false, `${path}.allowDraft`, errors);

  if (value.sameRepoOnly !== undefined) {
    if (value.sameRepoOnly !== true) {
      errors.push(issue(`${path}.sameRepoOnly`, 'SAME_REPO_ONLY_REQUIRED', 'Codex auto-fix must remain same-repository only.'));
    }
    normalized.sameRepoOnly = true;
  }

  if (value.maxAttempts !== undefined) {
    if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 10) {
      errors.push(issue(`${path}.maxAttempts`, 'INVALID_MAX_ATTEMPTS', 'maxAttempts must be an integer between 1 and 10.'));
    } else {
      normalized.maxAttempts = value.maxAttempts;
    }
  }

  if (value.blockedLabel !== undefined) {
    if (!isNonEmptyString(value.blockedLabel)) {
      errors.push(issue(`${path}.blockedLabel`, 'LABEL_REQUIRED', 'Blocked label must be a non-empty string.'));
    } else {
      normalized.blockedLabel = value.blockedLabel;
    }
  }

  if (value.inProgressLabel !== undefined) {
    if (!isNonEmptyString(value.inProgressLabel)) {
      errors.push(issue(`${path}.inProgressLabel`, 'LABEL_REQUIRED', 'In-progress label must be a non-empty string.'));
    } else {
      normalized.inProgressLabel = value.inProgressLabel;
    }
  }

  if (value.triggerVariableName !== undefined) {
    if (!isSafeEnvName(value.triggerVariableName)) {
      errors.push(issue(`${path}.triggerVariableName`, 'INVALID_VARIABLE_NAME', 'Trigger variable name must be a safe environment variable name.'));
    } else {
      normalized.triggerVariableName = value.triggerVariableName;
    }
  }

  return normalized;
}

function normalizeSchedules(value, errors, warnings) {
  const normalized = Object.fromEntries(SCHEDULE_KEYS.map((key) => [key, defaultSchedule()]));

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue('schedules', 'OBJECT_REQUIRED', 'Schedules config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, 'schedules', SCHEDULE_KEYS, warnings);

  for (const key of SCHEDULE_KEYS) {
    if (value[key] !== undefined) {
      normalized[key] = normalizeSchedule(value[key], `schedules.${key}`, errors, warnings);
    }
  }

  return normalized;
}

function normalizeSchedule(value, path, errors, warnings) {
  const normalized = defaultSchedule();

  if (!isPlainObject(value)) {
    errors.push(issue(path, 'OBJECT_REQUIRED', 'Schedule config must be an object.'));
    return normalized;
  }

  warnUnknownKeys(value, path, ['enabled', 'cron'], warnings);
  normalized.enabled = normalizeOptionalBoolean(value.enabled, false, `${path}.enabled`, errors);

  if (value.cron !== undefined) {
    if (!isSafeCron(value.cron)) {
      errors.push(issue(`${path}.cron`, 'INVALID_CRON', 'Cron must use a safe five-field cron expression.'));
    } else {
      normalized.cron = value.cron;
    }
  }

  if (normalized.enabled && normalized.cron === null) {
    errors.push(issue(path, 'CRON_REQUIRED', 'Enabled schedules must define cron.'));
  }

  return normalized;
}

function normalizeNamedMap(value, defaults, allowedKeys, path, errors, warnings) {
  const normalized = { ...defaults };

  if (value === undefined) {
    return normalized;
  }

  if (!isPlainObject(value)) {
    errors.push(issue(path, 'OBJECT_REQUIRED', `${path} must be an object.`));
    return normalized;
  }

  warnUnknownKeys(value, path, allowedKeys, warnings);

  for (const key of allowedKeys) {
    if (value[key] === undefined) {
      continue;
    }

    if (!isSafeEnvName(value[key])) {
      errors.push(issue(`${path}.${key}`, path === 'secrets' ? 'INVALID_SECRET_NAME' : 'INVALID_VARIABLE_NAME', `${path} entries must be safe environment variable names.`));
      continue;
    }

    normalized[key] = value[key];
  }

  return normalized;
}

function validateCrossFieldRules(config, errors) {
  if (config.review.markers.approved && config.review.markers.approved === config.review.markers.changesRequested) {
    errors.push(issue('review.markers', 'DUPLICATE_REVIEW_MARKERS', 'Approved and changes requested markers must be different.'));
  }

  if (config.review.markers.reviewRequest) {
    if (config.review.markers.reviewRequest === config.review.markers.approved || config.review.markers.reviewRequest === config.review.markers.changesRequested) {
      errors.push(issue('review.markers.reviewRequest', 'DUPLICATE_REVIEW_MARKERS', 'Review request marker must be distinct from decision markers.'));
    }
  }
}

function normalizeOptionalBoolean(value, defaultValue, path, errors) {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== 'boolean') {
    errors.push(issue(path, 'BOOLEAN_REQUIRED', 'Value must be a boolean.'));
    return defaultValue;
  }

  return value;
}

function normalizeOptionalPatternArray(value, path, errors) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push(issue(path, 'ARRAY_REQUIRED', 'Pattern lists must be arrays.'));
    return [];
  }

  return normalizeStringArray(value, path, errors);
}

function normalizeStringArray(value, path, errors) {
  const normalized = [];

  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      errors.push(issue(`${path}.${index}`, 'STRING_REQUIRED', 'Array entries must be non-empty strings.'));
      return;
    }

    normalized.push(entry);
  });

  return normalized;
}

function warnUnknownKeys(value, path, allowedKeys, warnings) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      warnings.push(issue(`${path}.${key}`, 'UNKNOWN_KEY', 'Unknown config keys are ignored.'));
    }
  }
}

function issue(path, code, message) {
  return { path, code, message };
}

function fail(errors, warnings = []) {
  return {
    ok: false,
    config: null,
    errors,
    warnings,
    capabilities: { ...DEFAULT_CAPABILITIES }
  };
}

function defaultQueue() {
  return {
    enabled: false,
    issueNumber: null,
    issueTitle: null
  };
}

function defaultCodexAutoFix(blockedLabel, inProgressLabel) {
  return {
    enabled: false,
    maxAttempts: 2,
    sameRepoOnly: true,
    allowDraft: false,
    blockedLabel,
    inProgressLabel,
    triggerVariableName: DEFAULT_VARIABLES.codexTrigger
  };
}

function defaultSchedule() {
  return {
    enabled: false,
    cron: null
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeEnvName(value) {
  return typeof value === 'string' && ENV_NAME_PATTERN.test(value);
}

function isSafeCron(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const fields = value.trim().split(/\s+/);

  return fields.length === 5 && fields.every((field) => CRON_TOKEN_PATTERN.test(field));
}

function isSecretLikePattern(pattern) {
  return DEFAULT_SECRET_LIKE_PATTERNS.some((blocked) => pattern.toLowerCase().includes(blocked.toLowerCase()));
}

function unique(values) {
  return [...new Set(values)];
}
