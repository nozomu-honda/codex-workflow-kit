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

export function auditRepositoryProtection(input = {}) {
  const expectedPolicy = normalizePolicy(input.expectedPolicy);
  const repository = normalizeRepository(input.repository);
  const defaultBranch = cleanString(input.defaultBranch ?? repository.defaultBranch ?? expectedPolicy.defaultBranch);
  const auditedSha = cleanSha(input.defaultBranchSha ?? repository.defaultBranchSha ?? input.branch?.commit?.sha);
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
  const mergeSettings = normalizeMergeSettings(input.mergeSettings ?? input.repository);
  const blockers = [];
  const warnings = [];

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
    mergeSettings,
    blockers: sortedBlockers,
    warnings: sortedWarnings,
    reasonCodes: [...new Set([...sortedBlockers, ...sortedWarnings].map((issue) => issue.code))].sort()
  };
}

export function formatProtectionAuditResult(result) {
  const lines = [];
  lines.push(`Repository protection audit: ${result.ready ? 'READY' : 'NOT READY'}`);
  lines.push(`repository: ${result.repository || '(unknown)'}`);
  lines.push(`defaultBranch: ${result.defaultBranch || '(unknown)'}`);
  lines.push(`auditedSha: ${result.auditedSha || '(unknown)'}`);
  lines.push(`manualReviewRequired: ${result.manualReviewRequired}`);
  lines.push(`activeRulesets: ${result.effectiveProtections.activeRulesetCount}`);
  lines.push(`requiredChecks: ${result.requiredChecks.map((check) => check.name).join(', ') || '(none)'}`);
  lines.push(`minimumApprovals: ${result.requiredReviews.minimumApprovals}`);
  lines.push(`bypassActors: ${result.bypassSummary.length}`);
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

  return {
    id: String(value.id ?? value.node_id ?? value.name ?? ''),
    active: enforcement === 'active',
    bypassActors: Array.isArray(value.bypass_actors) ? value.bypass_actors : Array.isArray(value.bypassActors) ? value.bypassActors : [],
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

function evaluateBypassActors({ blockers, bypassSummary, expectedPolicy }) {
  const allowed = new Set(expectedPolicy.allowedBypassActors);

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

function addPaginationFailures(blockers, pagination = {}) {
  if (pagination.rulesetsComplete === false) {
    addBlocker(blockers, 'ruleset_pagination_incomplete', 'Ruleset pagination did not complete.', 'rulesets');
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
