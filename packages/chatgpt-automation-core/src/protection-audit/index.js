export const PROTECTION_AUDIT_REPORT_VERSION = 1;

export const DEFAULT_PROTECTION_POLICY = Object.freeze({
  allowedBypassActors: [],
  allowedMergeMethods: ['squash'],
  blockDeletion: true,
  blockForcePush: true,
  defaultBranch: '',
  dismissStaleApprovals: true,
  enforceAdmins: true,
  minimumApprovals: 1,
  requireCodeOwnerReview: false,
  requireConversationResolution: true,
  requireLastPushApproval: true,
  requireLinearHistory: false,
  requirePullRequest: true,
  requireReviewEvidenceGate: true,
  requireRuleset: false,
  requireSignedCommits: false,
  requiredStatusChecks: ['CI', 'Review evidence gate']
});

const REVIEW_EVIDENCE_GATE_NAMES = new Set(['review evidence gate', 'review-evidence-gate']);
const DEFAULT_BRANCH_TOKEN = '~DEFAULT_BRANCH';
const VALID_TOKEN_SOURCES = new Set(['github-token', 'external-read-token']);
const PROTECTION_POLICY_REQUIRED_FIELDS = Object.freeze([
  'requiredStatusChecks',
  'requirePullRequest',
  'minimumApprovals',
  'dismissStaleApprovals',
  'requireConversationResolution',
  'blockForcePush',
  'blockDeletion',
  'allowedMergeMethods',
  'requireReviewEvidenceGate'
]);
const PROTECTION_POLICY_ALLOWED_FIELDS = new Set([
  ...PROTECTION_POLICY_REQUIRED_FIELDS,
  'allowedBypassActors',
  'defaultBranch',
  'enforceAdmins',
  'requireCodeOwnerReview',
  'requireLastPushApproval',
  'requireLinearHistory',
  'requireRuleset',
  'requireSignedCommits'
]);
const ALLOWED_MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const POLICY_ERROR_CODES = new Set([
  'protection_policy_parse_failed',
  'protection_policy_validation_failed'
]);
const SAFE_POLICY_PATH_PATTERN = /^policy(?:\.[A-Za-z0-9_-]+)*$/;
const SECRET_LIKE_PATTERN = /ghp_|github_pat_|ghs_|gho_|authorization|cookie|begin .*private key|client_secret|private_key|\btoken\b/i;
const BOOLEAN_POLICY_FIELDS = Object.freeze([
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
]);

export function auditRepositoryProtection(input = {}) {
  const rawPolicy = input.expectedPolicy ?? DEFAULT_PROTECTION_POLICY;
  const corePolicyValidation = validateProtectionPolicyObject(rawPolicy);
  const externalPolicyErrors = normalizeExternalPolicyErrors(input.policyValidationErrors);
  const policyErrors = mergePolicyErrors(corePolicyValidation.errors, externalPolicyErrors);
  const expectedPolicy = corePolicyValidation.errors.length === 0
    ? normalizePolicy(rawPolicy)
    : normalizePolicy(DEFAULT_PROTECTION_POLICY);
  const repository = normalizeRepository(input.repository);
  const defaultBranch = cleanString(input.defaultBranch ?? repository.defaultBranch ?? expectedPolicy.defaultBranch);
  const auditedSha = cleanSha(input.defaultBranchSha ?? repository.defaultBranchSha ?? input.branch?.commit?.sha);
  const tokenSource = normalizeTokenSource(input.tokenSource);
  const branchProtection = normalizeBranchProtection(input.branchProtection);
  const rulesets = normalizeRulesets({
    defaultBranch,
    details: input.rulesetDetails,
    summaries: input.rulesets
  });
  const activeRulesets = rulesets.filter((ruleset) => ruleset.active && ruleset.matchesDefaultBranch);
  const inactiveMatchingRulesets = rulesets.filter((ruleset) => !ruleset.active && ruleset.matchesDefaultBranch);
  const requiredChecks = collectRequiredChecks({ activeRulesets, branchProtection });
  const effectiveProtections = collectEffectiveProtections({ activeRulesets, branchProtection });
  const requiredReviews = collectRequiredReviews({ effectiveProtections });
  const bypassSummary = collectBypassSummary(activeRulesets);
  const bypassVisibility = collectBypassVisibility(activeRulesets);
  const mergeSettings = normalizeMergeSettings(input.mergeSettings ?? input.repository);
  const blockers = [];
  const warnings = [];

  addPolicyValidationFailures(blockers, policyErrors);
  addTokenCapabilityFailures(blockers, tokenSource);
  addApiFailures(blockers, input.apiErrors);
  addPaginationFailures(blockers, input.pagination);
  addTocTouFailures(blockers, input);
  evaluateProtectionPresence({
    activeRulesets,
    branchProtection,
    blockers,
    expectedPolicy,
    inactiveMatchingRulesets,
    rulesets,
    warnings
  });
  evaluateRequiredChecks({
    blockers,
    expectedPolicy,
    requiredChecks,
    warnings
  });
  evaluateRequiredReviews({
    blockers,
    effectiveProtections,
    expectedPolicy,
    warnings
  });
  evaluateBypassActors({
    blockers,
    bypassSummary,
    bypassVisibility,
    expectedPolicy,
    warnings
  });
  evaluateMergeSettings({
    blockers,
    expectedPolicy,
    mergeSettings,
    warnings
  });

  const sortedBlockers = sortIssues(blockers);
  const sortedWarnings = sortIssues(warnings);
  const manualReviewRequired = sortedBlockers.length > 0 || sortedWarnings.some((warning) => warning.manualReviewRequired === true);
  const ready = sortedBlockers.length === 0 && !manualReviewRequired;

  return {
    ok: ready,
    ready,
    manualReviewRequired,
    reportVersion: PROTECTION_AUDIT_REPORT_VERSION,
    repository: repository.fullName,
    defaultBranch,
    auditedSha,
    effectiveProtections,
    requiredChecks,
    requiredReviews,
    bypassSummary,
    bypassVisibility,
    mergeSettings,
    ...(tokenSource ? { tokenSource } : {}),
    blockers: sortedBlockers,
    warnings: sortedWarnings,
    reasonCodes: [...new Set([...sortedBlockers, ...sortedWarnings].map((issue) => issue.code))].sort()
  };
}

export function formatProtectionAuditResult(result) {
  const lines = [];
  const bypassVisibility = Array.isArray(result.bypassVisibility) ? result.bypassVisibility : [];
  const unknownBypassRulesets = bypassVisibility.filter((entry) => entry.bypassActorsVisible === false).length;
  const visibleBypassActorCount = bypassVisibility
    .filter((entry) => entry.bypassActorsVisible === true)
    .reduce((total, entry) => total + (Number(entry.bypassActorCount) || 0), 0);
  lines.push(`Repository protection audit: ${result.ready ? 'READY' : 'NOT READY'}`);
  lines.push(`repository: ${result.repository || '(unknown)'}`);
  lines.push(`defaultBranch: ${result.defaultBranch || '(unknown)'}`);
  lines.push(`auditedSha: ${result.auditedSha || '(unknown)'}`);
  lines.push(`manualReviewRequired: ${result.manualReviewRequired}`);
  lines.push(`activeRulesets: ${result.effectiveProtections.activeRulesetCount}`);
  lines.push(`requiredChecks: ${result.requiredChecks.map((check) => check.name).join(', ') || '(none)'}`);
  lines.push(`minimumApprovals: ${result.requiredReviews.minimumApprovals}`);
  lines.push(`bypassActorsVisible: ${unknownBypassRulesets === 0 ? 'confirmed' : 'unknown'}`);
  lines.push(`visibleBypassActorCount: ${visibleBypassActorCount}`);
  lines.push(`reasonCodes: ${result.reasonCodes.join(', ') || '(none)'}`);

  if (result.blockers.length > 0) {
    lines.push(`blockers: ${result.blockers.length}`);
    for (const blocker of result.blockers) {
      lines.push(`- ${blocker.code}: ${blocker.message}${formatIssuePath(blocker)}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push(`warnings: ${result.warnings.length}`);
    for (const warning of result.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}${formatIssuePath(warning)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function validateProtectionPolicyObject(value) {
  const errors = [];

  if (!isPlainObject(value)) {
    errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy root must be an object.', 'policy'));
    return { ok: false, errors };
  }

  for (const key of Object.keys(value)) {
    if (!PROTECTION_POLICY_ALLOWED_FIELDS.has(key)) {
      errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy contains an unknown field.', `policy.${key}`));
    }
  }

  for (const field of PROTECTION_POLICY_REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy is missing a required field.', `policy.${field}`));
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'requiredStatusChecks')) {
    if (!Array.isArray(value.requiredStatusChecks) || value.requiredStatusChecks.length === 0) {
      errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy requiredStatusChecks must contain at least one check.', 'policy.requiredStatusChecks'));
    } else {
      for (const [index, check] of value.requiredStatusChecks.entries()) {
        if (typeof check !== 'string' || check.length === 0) {
          errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy requiredStatusChecks entries must be non-empty strings.', `policy.requiredStatusChecks.${index}`));
        }
      }
      if (hasDuplicateItems(value.requiredStatusChecks)) {
        errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy requiredStatusChecks entries must be unique.', 'policy.requiredStatusChecks'));
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'minimumApprovals') && (!Number.isInteger(value.minimumApprovals) || !Number.isFinite(value.minimumApprovals) || value.minimumApprovals < 1)) {
    errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy minimumApprovals must be at least 1.', 'policy.minimumApprovals'));
  }

  if (Object.prototype.hasOwnProperty.call(value, 'allowedMergeMethods')) {
    if (!Array.isArray(value.allowedMergeMethods) || value.allowedMergeMethods.length === 0) {
      errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy allowedMergeMethods must contain at least one method.', 'policy.allowedMergeMethods'));
    } else {
      for (const [index, method] of value.allowedMergeMethods.entries()) {
        if (typeof method !== 'string' || !ALLOWED_MERGE_METHODS.has(method)) {
          errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy allowedMergeMethods contains an unsupported method.', `policy.allowedMergeMethods.${index}`));
        }
      }
      if (hasDuplicateItems(value.allowedMergeMethods)) {
        errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy allowedMergeMethods entries must be unique.', 'policy.allowedMergeMethods'));
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'allowedBypassActors')) {
    if (!Array.isArray(value.allowedBypassActors)) {
      errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy allowedBypassActors must be an array.', 'policy.allowedBypassActors'));
    } else {
      for (const [index, actor] of value.allowedBypassActors.entries()) {
        if (typeof actor !== 'string' || actor.length === 0) {
          errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy allowedBypassActors entries must be non-empty strings.', `policy.allowedBypassActors.${index}`));
        }
      }
      if (hasDuplicateItems(value.allowedBypassActors)) {
        errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy allowedBypassActors entries must be unique.', 'policy.allowedBypassActors'));
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'defaultBranch') && typeof value.defaultBranch !== 'string') {
    errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy defaultBranch must be a string.', 'policy.defaultBranch'));
  }

  for (const field of BOOLEAN_POLICY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field) && typeof value[field] !== 'boolean') {
      errors.push(policyIssue('protection_policy_validation_failed', 'Protection policy boolean field is invalid.', `policy.${field}`));
    }
  }

  const sortedErrors = sortIssues(errors);
  return {
    ok: sortedErrors.length === 0,
    errors: sortedErrors
  };
}

function normalizePolicy(value = {}) {
  const policy = isPlainObject(value) ? value : {};
  const requiredStatusChecks = normalizeStringArray(policy.requiredStatusChecks, DEFAULT_PROTECTION_POLICY.requiredStatusChecks);
  const allowedMergeMethods = normalizeStringArray(policy.allowedMergeMethods, DEFAULT_PROTECTION_POLICY.allowedMergeMethods)
    .map((method) => method.toLowerCase());

  return {
    ...DEFAULT_PROTECTION_POLICY,
    ...policy,
    allowedBypassActors: normalizeStringArray(policy.allowedBypassActors, DEFAULT_PROTECTION_POLICY.allowedBypassActors),
    allowedMergeMethods,
    defaultBranch: cleanString(policy.defaultBranch),
    minimumApprovals: Math.max(0, Number(policy.minimumApprovals ?? DEFAULT_PROTECTION_POLICY.minimumApprovals) || 0),
    requiredStatusChecks
  };
}

function normalizeRepository(value = {}) {
  const fullName = cleanString(value.full_name ?? value.fullName ?? value.repository);
  const defaultBranch = cleanString(value.default_branch ?? value.defaultBranch);
  const defaultBranchSha = cleanSha(value.default_branch_sha ?? value.defaultBranchSha ?? value.defaultBranchCommit?.sha);

  return {
    fullName,
    defaultBranch,
    defaultBranchSha,
    allowAutoMerge: value.allow_auto_merge ?? value.allowAutoMerge,
    allowMergeCommit: value.allow_merge_commit ?? value.allowMergeCommit,
    allowRebaseMerge: value.allow_rebase_merge ?? value.allowRebaseMerge,
    allowSquashMerge: value.allow_squash_merge ?? value.allowSquashMerge,
    deleteBranchOnMerge: value.delete_branch_on_merge ?? value.deleteBranchOnMerge,
    mergeQueueEnabled: value.merge_queue_enabled ?? value.mergeQueueEnabled
  };
}

function normalizeBranchProtection(value) {
  if (!isPlainObject(value)) {
    return {
      present: false,
      requiredChecks: [],
      requiredReviews: null,
      strictStatusChecks: false,
      requireConversationResolution: false,
      requireLinearHistory: false,
      requireSignedCommits: false,
      enforceAdmins: false,
      forcePushBlocked: false,
      deletionBlocked: false
    };
  }

  const requiredStatusChecks = value.required_status_checks ?? value.requiredStatusChecks;
  const requiredReviews = value.required_pull_request_reviews ?? value.requiredPullRequestReviews;

  return {
    present: true,
    requiredChecks: normalizeBranchProtectionChecks(requiredStatusChecks),
    requiredReviews: isPlainObject(requiredReviews) ? requiredReviews : null,
    strictStatusChecks: requiredStatusChecks?.strict === true,
    requireConversationResolution: enabled(value.required_conversation_resolution ?? value.requiredConversationResolution),
    requireLinearHistory: enabled(value.required_linear_history ?? value.requiredLinearHistory),
    requireSignedCommits: enabled(value.required_signatures ?? value.requiredSignatures),
    enforceAdmins: enabled(value.enforce_admins ?? value.enforceAdmins),
    forcePushBlocked: !enabled(value.allow_force_pushes ?? value.allowForcePushes),
    deletionBlocked: !enabled(value.allow_deletions ?? value.allowDeletions)
  };
}

function normalizeBranchProtectionChecks(value) {
  if (!isPlainObject(value)) {
    return [];
  }

  const contexts = normalizeStringArray(value.contexts);
  const checks = Array.isArray(value.checks) ? value.checks : [];
  const normalized = [
    ...contexts.map((name) => ({
      appId: null,
      name,
      source: 'branch-protection'
    })),
    ...checks.map((check) => ({
      appId: check.app_id ?? check.appId ?? null,
      name: cleanString(check.context ?? check.name),
      source: 'branch-protection'
    }))
  ].filter((check) => check.name);

  return sortByName(normalized);
}

function normalizeRulesets({ defaultBranch, details = [], summaries = [] }) {
  const byId = new Map();

  for (const summary of Array.isArray(summaries) ? summaries : []) {
    const id = String(summary.id ?? summary.node_id ?? summary.name ?? '');
    if (id) {
      byId.set(id, summary);
    }
  }

  for (const detail of Array.isArray(details) ? details : []) {
    const id = String(detail.id ?? detail.node_id ?? detail.name ?? '');
    if (id) {
      byId.set(id, { ...(byId.get(id) ?? {}), ...detail });
    }
  }

  return [...byId.values()]
    .map((ruleset) => normalizeRuleset(ruleset, defaultBranch))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

function normalizeRuleset(value, defaultBranch) {
  const target = cleanString(value.target).toLowerCase();
  const enforcement = cleanString(value.enforcement).toLowerCase();
  const conditions = value.conditions ?? {};
  const refName = conditions.ref_name ?? conditions.refName ?? {};
  const includes = normalizeStringArray(refName.include, ['refs/heads/*']);
  const excludes = normalizeStringArray(refName.exclude);
  const rules = Array.isArray(value.rules) ? value.rules : [];
  const bypassActors = normalizeRulesetBypassActors(value);

  return {
    id: String(value.id ?? value.node_id ?? value.name ?? ''),
    active: enforcement === 'active',
    bypassActors: bypassActors.items,
    ...(bypassActors.visible ? { bypassActorCount: bypassActors.items.length } : {}),
    bypassActorsVisible: bypassActors.visible,
    conditions: {
      include: includes,
      exclude: excludes
    },
    enforcement,
    matchesDefaultBranch: target === 'branch' && matchesBranchPatterns({ defaultBranch, excludes, includes }),
    name: cleanString(value.name),
    rules,
    sourceType: cleanString(value.source_type ?? value.sourceType),
    target,
    updatedAt: cleanString(value.updated_at ?? value.updatedAt)
  };
}

function normalizeRulesetBypassActors(value) {
  if (Object.prototype.hasOwnProperty.call(value, 'bypass_actors') && Array.isArray(value.bypass_actors)) {
    return {
      items: value.bypass_actors,
      visible: true
    };
  }

  if (Object.prototype.hasOwnProperty.call(value, 'bypassActors') && Array.isArray(value.bypassActors)) {
    return {
      items: value.bypassActors,
      visible: true
    };
  }

  return {
    items: [],
    visible: false
  };
}

function matchesBranchPatterns({ defaultBranch, excludes, includes }) {
  const branchRef = `refs/heads/${defaultBranch}`;
  const normalizedIncludes = includes.length > 0 ? includes : ['refs/heads/*'];
  const included = normalizedIncludes.some((pattern) => matchesBranchPattern(branchRef, defaultBranch, pattern));
  const excluded = excludes.some((pattern) => matchesBranchPattern(branchRef, defaultBranch, pattern));
  return included && !excluded;
}

function matchesBranchPattern(branchRef, defaultBranch, pattern) {
  const normalized = cleanString(pattern)
    .replace(DEFAULT_BRANCH_TOKEN, defaultBranch)
    .replace(/^~ALL$/, 'refs/heads/*');

  if (!normalized) {
    return false;
  }

  if (normalized === defaultBranch || normalized === branchRef) {
    return true;
  }

  const candidate = normalized.startsWith('refs/heads/') ? normalized : `refs/heads/${normalized}`;
  return globToRegExp(candidate).test(branchRef);
}

function collectRequiredChecks({ activeRulesets, branchProtection }) {
  const entries = [];

  for (const check of branchProtection.requiredChecks) {
    entries.push({
      ...check,
      ruleset: '',
      strict: branchProtection.strictStatusChecks
    });
  }

  for (const ruleset of activeRulesets) {
    for (const rule of ruleset.rules) {
      if (cleanString(rule.type) !== 'required_status_checks') {
        continue;
      }
      const parameters = rule.parameters ?? {};
      const strict = parameters.strict_required_status_checks_policy === true || parameters.strictRequiredStatusChecksPolicy === true;
      const checks = Array.isArray(parameters.required_status_checks)
        ? parameters.required_status_checks
        : Array.isArray(parameters.requiredStatusChecks)
          ? parameters.requiredStatusChecks
          : [];

      for (const check of checks) {
        entries.push({
          appId: check.integration_id ?? check.integrationId ?? check.app_id ?? check.appId ?? null,
          name: cleanString(check.context ?? check.name),
          ruleset: ruleset.name,
          source: 'ruleset',
          strict
        });
      }
    }
  }

  const byName = new Map();
  for (const entry of entries.filter((check) => check.name)) {
    const current = byName.get(entry.name) ?? {
      appIds: [],
      name: entry.name,
      required: true,
      sources: [],
      strict: false
    };
    if (entry.appId !== null && entry.appId !== undefined && !current.appIds.includes(String(entry.appId))) {
      current.appIds.push(String(entry.appId));
    }
    const source = entry.ruleset ? `${entry.source}:${entry.ruleset}` : entry.source;
    if (!current.sources.includes(source)) {
      current.sources.push(source);
    }
    current.strict = current.strict || entry.strict === true;
    byName.set(entry.name, current);
  }

  return [...byName.values()]
    .map((check) => ({
      ...check,
      appIds: check.appIds.sort(),
      sources: check.sources.sort()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function collectEffectiveProtections({ activeRulesets, branchProtection }) {
  const rulesetProtection = collectRulesetProtections(activeRulesets);
  const reviewSettings = branchProtection.requiredReviews ?? {};

  return {
    activeRulesetCount: activeRulesets.length,
    branchProtectionPresent: branchProtection.present,
    deletionBlocked: branchProtection.deletionBlocked || rulesetProtection.deletionBlocked,
    dismissStaleApprovals: reviewSettings.dismiss_stale_reviews === true || reviewSettings.dismissStaleReviews === true || rulesetProtection.dismissStaleApprovals,
    enforceAdmins: branchProtection.enforceAdmins,
    forcePushBlocked: branchProtection.forcePushBlocked || rulesetProtection.nonFastForward,
    minimumApprovals: Math.max(
      Number(reviewSettings.required_approving_review_count ?? reviewSettings.requiredApprovingReviewCount ?? 0) || 0,
      rulesetProtection.minimumApprovals
    ),
    pullRequestRequired: Boolean(branchProtection.requiredReviews) || rulesetProtection.pullRequestRequired,
    requireCodeOwnerReview: reviewSettings.require_code_owner_reviews === true || reviewSettings.requireCodeOwnerReviews === true || rulesetProtection.requireCodeOwnerReview,
    requireConversationResolution: branchProtection.requireConversationResolution || rulesetProtection.requireConversationResolution,
    requireLastPushApproval: reviewSettings.require_last_push_approval === true || reviewSettings.requireLastPushApproval === true || rulesetProtection.requireLastPushApproval,
    requireLinearHistory: branchProtection.requireLinearHistory || rulesetProtection.requireLinearHistory,
    requireSignedCommits: branchProtection.requireSignedCommits || rulesetProtection.requireSignedCommits,
    strictStatusChecks: branchProtection.strictStatusChecks || rulesetProtection.strictStatusChecks
  };
}

function collectRulesetProtections(activeRulesets) {
  const result = {
    deletionBlocked: false,
    dismissStaleApprovals: false,
    minimumApprovals: 0,
    nonFastForward: false,
    pullRequestRequired: false,
    requireCodeOwnerReview: false,
    requireConversationResolution: false,
    requireLastPushApproval: false,
    requireLinearHistory: false,
    requireSignedCommits: false,
    strictStatusChecks: false
  };

  for (const ruleset of activeRulesets) {
    for (const rule of ruleset.rules) {
      const type = cleanString(rule.type);
      const parameters = rule.parameters ?? {};
      if (type === 'deletion') {
        result.deletionBlocked = true;
      } else if (type === 'non_fast_forward') {
        result.nonFastForward = true;
      } else if (type === 'required_linear_history') {
        result.requireLinearHistory = true;
      } else if (type === 'required_signatures') {
        result.requireSignedCommits = true;
      } else if (type === 'required_status_checks') {
        result.strictStatusChecks = result.strictStatusChecks || parameters.strict_required_status_checks_policy === true || parameters.strictRequiredStatusChecksPolicy === true;
      } else if (type === 'pull_request') {
        result.pullRequestRequired = true;
        result.dismissStaleApprovals = result.dismissStaleApprovals || parameters.dismiss_stale_reviews_on_push === true || parameters.dismissStaleReviewsOnPush === true;
        result.minimumApprovals = Math.max(result.minimumApprovals, Number(parameters.required_approving_review_count ?? parameters.requiredApprovingReviewCount ?? 0) || 0);
        result.requireCodeOwnerReview = result.requireCodeOwnerReview || parameters.require_code_owner_review === true || parameters.requireCodeOwnerReview === true;
        result.requireConversationResolution = result.requireConversationResolution || parameters.required_review_thread_resolution === true || parameters.requiredReviewThreadResolution === true;
        result.requireLastPushApproval = result.requireLastPushApproval || parameters.require_last_push_approval === true || parameters.requireLastPushApproval === true;
      }
    }
  }

  return result;
}

function collectRequiredReviews({ effectiveProtections }) {
  return {
    dismissStaleApprovals: effectiveProtections.dismissStaleApprovals,
    minimumApprovals: effectiveProtections.minimumApprovals,
    pullRequestRequired: effectiveProtections.pullRequestRequired,
    requireCodeOwnerReview: effectiveProtections.requireCodeOwnerReview,
    requireConversationResolution: effectiveProtections.requireConversationResolution,
    requireLastPushApproval: effectiveProtections.requireLastPushApproval
  };
}

function collectBypassSummary(activeRulesets) {
  const entries = [];

  for (const ruleset of activeRulesets) {
    if (ruleset.bypassActorsVisible !== true) {
      continue;
    }
    for (const actor of ruleset.bypassActors) {
      entries.push({
        actorType: cleanString(actor.actor_type ?? actor.actorType) || 'unknown',
        bypassMode: cleanString(actor.bypass_mode ?? actor.bypassMode) || 'unknown',
        ruleset: ruleset.name || 'unnamed-ruleset'
      });
    }
  }

  return entries.sort((a, b) =>
    a.ruleset.localeCompare(b.ruleset)
    || a.actorType.localeCompare(b.actorType)
    || a.bypassMode.localeCompare(b.bypassMode));
}

function collectBypassVisibility(activeRulesets) {
  return activeRulesets
    .map((ruleset) => ({
      bypassActorsVisible: ruleset.bypassActorsVisible === true,
      ...(ruleset.bypassActorsVisible === true ? { bypassActorCount: ruleset.bypassActors.length } : {}),
      ruleset: ruleset.name || 'unnamed-ruleset'
    }))
    .sort((a, b) => a.ruleset.localeCompare(b.ruleset));
}

function normalizeMergeSettings(value = {}) {
  return {
    autoMergeAllowed: value.allow_auto_merge ?? value.allowAutoMerge ?? false,
    branchAutoDelete: value.delete_branch_on_merge ?? value.deleteBranchOnMerge ?? false,
    mergeCommitAllowed: value.allow_merge_commit ?? value.allowMergeCommit ?? false,
    mergeQueueEnabled: value.merge_queue_enabled ?? value.mergeQueueEnabled ?? false,
    rebaseMergeAllowed: value.allow_rebase_merge ?? value.allowRebaseMerge ?? false,
    squashMergeAllowed: value.allow_squash_merge ?? value.allowSquashMerge ?? false
  };
}

function evaluateProtectionPresence({ activeRulesets, branchProtection, blockers, expectedPolicy, inactiveMatchingRulesets, rulesets, warnings }) {
  if (!branchProtection.present) {
    addBlocker(blockers, 'branch_protection_missing', 'Default branch protection was not found.', 'branchProtection');
  }

  if (activeRulesets.length === 0) {
    const issue = expectedPolicy.requireRuleset
      ? addBlocker
      : addWarning;
    issue(expectedPolicy.requireRuleset ? blockers : warnings, 'ruleset_missing', 'No active branch ruleset targets the default branch.', 'rulesets', true);
  }

  if (inactiveMatchingRulesets.length > 0) {
    addWarning(warnings, 'expected_ruleset_not_active', 'A default-branch ruleset exists but is not active.', 'rulesets', true);
  }

  if (rulesets.some((ruleset) => ruleset.target === 'branch' && !ruleset.matchesDefaultBranch)) {
    addWarning(warnings, 'ruleset_target_mismatch', 'A branch ruleset does not target the default branch.', 'rulesets.conditions', true);
  }
}

function evaluateRequiredChecks({ blockers, expectedPolicy, requiredChecks, warnings }) {
  const byName = new Map(requiredChecks.map((check) => [check.name, check]));

  for (const expected of expectedPolicy.requiredStatusChecks) {
    const check = byName.get(expected);
    if (!check) {
      const code = isReviewEvidenceGateName(expected)
        ? 'review_evidence_gate_not_required'
        : isCiName(expected)
          ? 'ci_check_not_required'
          : 'required_check_missing';
      addBlocker(blockers, code, `Required check is missing: ${expected}.`, `requiredStatusChecks.${expected}`);
      continue;
    }

    if (!check.strict) {
      addWarning(warnings, 'required_check_strict_mode_disabled', `Required check does not require an up-to-date branch: ${expected}.`, `requiredStatusChecks.${expected}`, true);
    }

    if (check.appIds.length > 1) {
      addWarning(warnings, 'duplicate_check_name', `Required check has multiple integration IDs: ${expected}.`, `requiredStatusChecks.${expected}`, true);
    }
  }

  if (expectedPolicy.requireReviewEvidenceGate && !requiredChecks.some((check) => isReviewEvidenceGateName(check.name))) {
    addBlocker(blockers, 'review_evidence_gate_not_required', 'Review evidence gate is not required on the default branch.', 'requiredStatusChecks');
  }
}

function evaluateRequiredReviews({ blockers, effectiveProtections, expectedPolicy, warnings }) {
  if (expectedPolicy.requirePullRequest && !effectiveProtections.pullRequestRequired) {
    addBlocker(blockers, 'pull_request_review_not_required', 'Pull request review is not required before merging.', 'requiredReviews');
  }

  if (effectiveProtections.minimumApprovals < expectedPolicy.minimumApprovals) {
    addBlocker(blockers, 'minimum_approvals_too_low', 'Minimum approval count is lower than expected.', 'requiredReviews.minimumApprovals');
  }

  if (expectedPolicy.dismissStaleApprovals && !effectiveProtections.dismissStaleApprovals) {
    addBlocker(blockers, 'stale_approvals_not_dismissed', 'Stale approvals are not dismissed when new commits are pushed.', 'requiredReviews.dismissStaleApprovals');
  }

  if (expectedPolicy.requireConversationResolution && !effectiveProtections.requireConversationResolution) {
    addBlocker(blockers, 'conversation_resolution_not_required', 'Conversation resolution is not required.', 'requiredReviews.requireConversationResolution');
  }

  if (expectedPolicy.requireLastPushApproval && !effectiveProtections.requireLastPushApproval) {
    addWarning(warnings, 'last_push_approval_not_required', 'Last push approval is not required or could not be confirmed.', 'requiredReviews.requireLastPushApproval', true);
  }

  if (expectedPolicy.requireCodeOwnerReview && !effectiveProtections.requireCodeOwnerReview) {
    addBlocker(blockers, 'code_owner_review_not_required', 'Code owner review is not required.', 'requiredReviews.requireCodeOwnerReview');
  }

  if (expectedPolicy.enforceAdmins && !effectiveProtections.enforceAdmins) {
    addWarning(warnings, 'admin_bypass_allowed', 'Admin enforcement is disabled or could not be confirmed.', 'requiredReviews.enforceAdmins', true);
  }

  if (expectedPolicy.blockForcePush && !effectiveProtections.forcePushBlocked) {
    addBlocker(blockers, 'force_push_allowed', 'Force pushes are not blocked.', 'branchSafety.forcePush');
  }

  if (expectedPolicy.blockDeletion && !effectiveProtections.deletionBlocked) {
    addBlocker(blockers, 'deletion_allowed', 'Branch deletion is not blocked.', 'branchSafety.deletion');
  }

  if (expectedPolicy.requireLinearHistory && !effectiveProtections.requireLinearHistory) {
    addWarning(warnings, 'linear_history_not_required', 'Linear history is not required.', 'branchSafety.linearHistory', true);
  }

  if (expectedPolicy.requireSignedCommits && !effectiveProtections.requireSignedCommits) {
    addWarning(warnings, 'signed_commits_not_required', 'Signed commits are not required.', 'branchSafety.signedCommits', true);
  }
}

function evaluateBypassActors({ blockers, bypassSummary, bypassVisibility, expectedPolicy }) {
  const allowed = new Set(expectedPolicy.allowedBypassActors);

  for (const visibility of bypassVisibility) {
    if (visibility.bypassActorsVisible !== true) {
      addBlocker(
        blockers,
        'ruleset_bypass_visibility_unknown',
        'Ruleset bypass actor visibility could not be confirmed.',
        `rulesets.bypassVisibility.${visibility.ruleset}`
      );
    }
  }

  for (const bypass of bypassSummary) {
    const key = `${bypass.actorType}:${bypass.bypassMode}`;
    if (allowed.has(key)) {
      continue;
    }
    const adminLike = /admin/i.test(bypass.actorType) || bypass.actorType === 'RepositoryRole';
    addBlocker(
      blockers,
      adminLike ? 'admin_bypass_allowed' : 'unexpected_bypass_actor',
      `Unexpected ruleset bypass actor is configured: ${bypass.actorType}/${bypass.bypassMode}.`,
      `bypass.${bypass.ruleset}`
    );
  }
}

function evaluateMergeSettings({ blockers, expectedPolicy, mergeSettings, warnings }) {
  const enabledMethods = [
    mergeSettings.mergeCommitAllowed && 'merge',
    mergeSettings.squashMergeAllowed && 'squash',
    mergeSettings.rebaseMergeAllowed && 'rebase'
  ].filter(Boolean);

  for (const method of enabledMethods) {
    if (!expectedPolicy.allowedMergeMethods.includes(method)) {
      addBlocker(blockers, 'merge_method_not_allowed', `Repository allows an unexpected merge method: ${method}.`, `mergeSettings.${method}`);
    }
  }

  if (mergeSettings.mergeQueueEnabled) {
    addWarning(warnings, 'merge_queue_enabled', 'Merge queue is enabled; future write workflows may need queue-aware behavior.', 'mergeSettings.mergeQueue', true);
  }
}

function addApiFailures(blockers, apiErrors = []) {
  for (const error of Array.isArray(apiErrors) ? apiErrors : []) {
    addBlocker(
      blockers,
      cleanString(error.code) || 'protection_api_failed',
      cleanString(error.message) || 'GitHub repository protection API read failed.',
      cleanString(error.path) || 'githubApi'
    );
  }
}

function addPolicyValidationFailures(blockers, errors = []) {
  for (const error of Array.isArray(errors) ? errors : []) {
    addBlocker(
      blockers,
      normalizePolicyErrorCode(error.code),
      normalizePolicyErrorMessage(error.code),
      sanitizePolicyPath(error.path)
    );
  }
}

function normalizeExternalPolicyErrors(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (!isPlainObject(entry)) {
      return policyIssue('protection_policy_validation_failed', normalizePolicyErrorMessage('protection_policy_validation_failed'), 'policy');
    }

    const code = normalizePolicyErrorCode(entry.code);
    return policyIssue(code, normalizePolicyErrorMessage(code), sanitizePolicyPath(entry.path));
  });
}

function mergePolicyErrors(coreErrors = [], externalErrors = []) {
  const deduped = new Map();
  for (const error of [...coreErrors, ...externalErrors]) {
    const code = normalizePolicyErrorCode(error.code);
    const path = sanitizePolicyPath(error.path);
    const key = `${code}\0${path}`;
    if (!deduped.has(key)) {
      deduped.set(key, policyIssue(code, normalizePolicyErrorMessage(code), path));
    }
  }
  return sortIssues([...deduped.values()]);
}

function normalizePolicyErrorCode(value) {
  const code = cleanString(value);
  return POLICY_ERROR_CODES.has(code) ? code : 'protection_policy_validation_failed';
}

function normalizePolicyErrorMessage(code) {
  return normalizePolicyErrorCode(code) === 'protection_policy_parse_failed'
    ? 'Protection policy could not be parsed.'
    : 'Protection policy validation failed.';
}

function sanitizePolicyPath(value) {
  const path = cleanString(value);
  if (!path || !SAFE_POLICY_PATH_PATTERN.test(path) || SECRET_LIKE_PATTERN.test(path)) {
    return 'policy';
  }
  return path;
}

function addTokenCapabilityFailures(blockers, tokenSource) {
  if (!tokenSource) {
    return;
  }

  if (tokenSource === 'github-token') {
    addBlocker(
      blockers,
      'administration_read_token_required',
      'Repository protection audit requires an explicit Administration read token for complete live verification.',
      'githubToken'
    );
    return;
  }

  if (!VALID_TOKEN_SOURCES.has(tokenSource)) {
    addBlocker(
      blockers,
      'repository_protection_audit_token_insufficient',
      'Repository protection audit token source is not recognized for complete live verification.',
      'githubToken'
    );
  }
}

function addPaginationFailures(blockers, pagination = {}) {
  if (pagination.rulesetsComplete === false || pagination.rulesetsStartComplete === false) {
    addBlocker(blockers, 'ruleset_pagination_incomplete', 'Ruleset pagination did not complete at audit start.', 'rulesets.start');
  }

  if (pagination.rulesetsEndComplete === false) {
    addBlocker(blockers, 'ruleset_pagination_incomplete', 'Ruleset pagination did not complete at audit end.', 'rulesets.end');
  }
}

function addTocTouFailures(blockers, input) {
  if (input.protectionChangedDuringAudit === true || input.rulesetsChangedDuringAudit === true) {
    addBlocker(blockers, 'protection_changed_during_audit', 'Repository protection settings changed during the audit.', 'tocTou');
  }

  if (Object.prototype.hasOwnProperty.call(input, 'endBranchProtection')) {
    const startFingerprint = branchProtectionFingerprint(input.branchProtection);
    const endFingerprint = branchProtectionFingerprint(input.endBranchProtection);
    if (startFingerprint !== endFingerprint) {
      addBlocker(blockers, 'protection_changed_during_audit', 'Branch protection settings changed during the audit.', 'tocTou.branchProtection');
    }
  }

  const start = input.startSnapshot;
  const end = input.endSnapshot;
  if (!isPlainObject(start) || !isPlainObject(end)) {
    return;
  }

  if (cleanString(start.defaultBranch) !== cleanString(end.defaultBranch) || cleanSha(start.defaultBranchSha) !== cleanSha(end.defaultBranchSha)) {
    addBlocker(blockers, 'protection_changed_during_audit', 'Default branch or default branch SHA changed during the audit.', 'tocTou.defaultBranch');
  }

  if (Object.prototype.hasOwnProperty.call(input, 'endRulesets') || Object.prototype.hasOwnProperty.call(input, 'endRulesetDetails')) {
    const defaultBranch = cleanString(input.defaultBranch ?? input.repository?.default_branch ?? input.repository?.defaultBranch ?? input.expectedPolicy?.defaultBranch);
    const startRulesetFingerprint = rulesetAuditFingerprint({
      defaultBranch,
      details: input.rulesetDetails,
      summaries: input.rulesets
    });
    const endRulesetFingerprint = rulesetAuditFingerprint({
      defaultBranch: cleanString(end.defaultBranch) || defaultBranch,
      details: input.endRulesetDetails,
      summaries: input.endRulesets
    });
    if (startRulesetFingerprint !== endRulesetFingerprint) {
      addBlocker(blockers, 'protection_changed_during_audit', 'Ruleset settings changed during the audit.', 'tocTou.rulesets');
    }
  }
}

function branchProtectionFingerprint(value) {
  const normalized = normalizeBranchProtection(value);
  const reviews = normalized.requiredReviews ?? {};

  return JSON.stringify({
    deletionBlocked: normalized.deletionBlocked,
    enforceAdmins: normalized.enforceAdmins,
    forcePushBlocked: normalized.forcePushBlocked,
    present: normalized.present,
    requireConversationResolution: normalized.requireConversationResolution,
    requireLinearHistory: normalized.requireLinearHistory,
    requireSignedCommits: normalized.requireSignedCommits,
    requiredChecks: normalized.requiredChecks
      .map((check) => ({
        appId: check.appId === undefined || check.appId === null ? null : String(check.appId),
        name: check.name
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || String(a.appId ?? '').localeCompare(String(b.appId ?? ''))),
    requiredReviews: normalized.requiredReviews
      ? {
          dismissStaleApprovals: reviews.dismiss_stale_reviews === true || reviews.dismissStaleReviews === true,
          minimumApprovals: Number(reviews.required_approving_review_count ?? reviews.requiredApprovingReviewCount ?? 0) || 0,
          requireCodeOwnerReview: reviews.require_code_owner_reviews === true || reviews.requireCodeOwnerReviews === true,
          requireLastPushApproval: reviews.require_last_push_approval === true || reviews.requireLastPushApproval === true
        }
      : null,
    strictStatusChecks: normalized.strictStatusChecks
  });
}

function rulesetAuditFingerprint({ defaultBranch, details, summaries }) {
  return JSON.stringify(normalizeRulesets({ defaultBranch, details, summaries }).map((ruleset) => ({
    active: ruleset.active,
    bypassActors: ruleset.bypassActorsVisible === true
      ? ruleset.bypassActors
        .map((actor) => ({
          actorType: cleanString(actor.actor_type ?? actor.actorType) || 'unknown',
          bypassMode: cleanString(actor.bypass_mode ?? actor.bypassMode) || 'unknown'
        }))
        .sort((a, b) => a.actorType.localeCompare(b.actorType) || a.bypassMode.localeCompare(b.bypassMode))
      : null,
    bypassActorsVisible: ruleset.bypassActorsVisible,
    conditions: {
      exclude: stableStringArray(ruleset.conditions.exclude),
      include: stableStringArray(ruleset.conditions.include)
    },
    enforcement: ruleset.enforcement,
    matchesDefaultBranch: ruleset.matchesDefaultBranch,
    name: ruleset.name,
    rules: sanitizeRulesetRulesForFingerprint(ruleset.rules),
    target: ruleset.target
  })));
}

function sanitizeRulesetRulesForFingerprint(rules = []) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => {
      const type = cleanString(rule.type);
      const parameters = isPlainObject(rule.parameters) ? rule.parameters : {};

      if (type === 'required_status_checks') {
        const checks = Array.isArray(parameters.required_status_checks)
          ? parameters.required_status_checks
          : Array.isArray(parameters.requiredStatusChecks)
            ? parameters.requiredStatusChecks
            : [];
        return {
          checks: checks
            .map((check) => ({
              integrationId: check.integration_id ?? check.integrationId ?? check.app_id ?? check.appId ?? null,
              name: cleanString(check.context ?? check.name)
            }))
            .filter((check) => check.name)
            .sort((a, b) => a.name.localeCompare(b.name) || String(a.integrationId ?? '').localeCompare(String(b.integrationId ?? ''))),
          strict: parameters.strict_required_status_checks_policy === true || parameters.strictRequiredStatusChecksPolicy === true,
          type
        };
      }

      if (type === 'pull_request') {
        return {
          dismissStaleApprovals: parameters.dismiss_stale_reviews_on_push === true || parameters.dismissStaleReviewsOnPush === true,
          minimumApprovals: Number(parameters.required_approving_review_count ?? parameters.requiredApprovingReviewCount ?? 0) || 0,
          requireCodeOwnerReview: parameters.require_code_owner_review === true || parameters.requireCodeOwnerReview === true,
          requireConversationResolution: parameters.required_review_thread_resolution === true || parameters.requiredReviewThreadResolution === true,
          requireLastPushApproval: parameters.require_last_push_approval === true || parameters.requireLastPushApproval === true,
          type
        };
      }

      return {
        parameters: stableSanitizedValue(parameters),
        type
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function stableSanitizedValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSanitizedValue(entry));
  }

  if (!isPlainObject(value)) {
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) {
      return value;
    }
    return null;
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (/actor|authorization|cookie|secret|token/i.test(key)) {
      continue;
    }
    result[key] = stableSanitizedValue(value[key]);
  }
  return result;
}

function addBlocker(blockers, code, message, path = '') {
  blockers.push(issue(code, message, path, true));
}

function addWarning(warnings, code, message, path = '', manualReviewRequired = false) {
  warnings.push(issue(code, message, path, manualReviewRequired));
}

function issue(code, message, path, manualReviewRequired) {
  return {
    code,
    message,
    ...(path ? { path } : {}),
    ...(manualReviewRequired ? { manualReviewRequired: true } : {})
  };
}

function policyIssue(code, message, path) {
  return issue(normalizePolicyErrorCode(code), message, sanitizePolicyPath(path), true);
}

function sortIssues(issues) {
  return [...issues].sort((a, b) =>
    a.code.localeCompare(b.code)
    || String(a.path ?? '').localeCompare(String(b.path ?? ''))
    || a.message.localeCompare(b.message));
}

function formatIssuePath(issueEntry) {
  return issueEntry.path ? ` (${issueEntry.path})` : '';
}

function enabled(value) {
  if (value === true) {
    return true;
  }
  if (isPlainObject(value)) {
    return value.enabled === true;
  }
  return false;
}

function normalizeStringArray(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return source
    .map((entry) => cleanString(entry))
    .filter(Boolean);
}

function stableStringArray(value) {
  return normalizeStringArray(value).sort();
}

function hasDuplicateItems(value) {
  return Array.isArray(value) && new Set(value).size !== value.length;
}

function normalizeTokenSource(value) {
  const tokenSource = cleanString(value);
  return tokenSource ? tokenSource : '';
}

function isReviewEvidenceGateName(value) {
  return REVIEW_EVIDENCE_GATE_NAMES.has(cleanString(value).toLowerCase());
}

function isCiName(value) {
  return cleanString(value).toLowerCase() === 'ci';
}

function sortByName(values) {
  return [...values].sort((a, b) => a.name.localeCompare(b.name));
}

function globToRegExp(pattern) {
  const escaped = escapeRegExp(pattern)
    .replaceAll('\\*\\*', '.*')
    .replaceAll('\\*', '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanSha(value) {
  const text = cleanString(value);
  return /^[a-f0-9]{40}$/i.test(text) ? text.toLowerCase() : '';
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
