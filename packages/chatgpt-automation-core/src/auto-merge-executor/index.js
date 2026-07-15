import { AUTO_MERGE_OUTPUT_NAMES } from '../auto-merge/index.js';
import {
  createWriteCommandCandidateFromAutoMergePlan,
  DisabledGitHubWriteAdapter,
  validateWriteCommand,
  WRITE_REASON_CODES
} from '../github-write/index.js';

export const AUTO_MERGE_DRY_RUN_EXECUTOR_REPORT_VERSION = 'auto-merge-dry-run-executor.v1';
export const REVIEW_EVIDENCE_REPORT_VERSION = 'review-evidence.v1';

export const AUTO_MERGE_DRY_RUN_REASON_CODES = Object.freeze([
  'review_evidence_missing',
  'stale_review_head',
  'review_evidence_from_current_run',
  'report_schema_invalid',
  'report_repository_mismatch',
  'report_pull_request_mismatch',
  'report_head_sha_mismatch',
  'report_base_sha_mismatch',
  'report_expired',
  'ci_not_successful',
  'required_check_missing',
  'protection_audit_not_ready',
  'consumer_audit_not_ready',
  'dangerous_change_detected',
  'secret_like_change_detected',
  'unresolved_review_thread',
  'requested_reviewer_remaining',
  'duplicate_operation',
  'attempt_limit_exceeded',
  'cooldown_active',
  'write_command_invalid',
  'write_disabled',
  'unknown_state'
]);

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REQUIRED_CHECKS = Object.freeze(['CI', 'Review evidence gate']);
const SAFE_MERGE_STATES = new Set(['clean', 'has_hooks', 'unstable']);
const AUTO_MERGE_PLAN_ROOT_KEYS = new Set(['ok', 'outputs']);
const REVIEW_EVIDENCE_KEYS = new Set([
  'apiReadOk',
  'approved',
  'baseSha',
  'blockers',
  'changesRequested',
  'checkedAt',
  'createdAt',
  'currentRunEvidence',
  'evidenceHeadSha',
  'evidenceType',
  'headSha',
  'paginationComplete',
  'pullRequestNumber',
  'reasonCodes',
  'reportVersion',
  'repository',
  'requestedReviewers',
  'requestedTeams',
  'reviewedAt',
  'runStartedAt',
  'unresolvedReviewThreads',
  'warnings'
]);
const CONSUMER_AUDIT_KEYS = new Set([
  'apiReadOk',
  'auditedCommitSha',
  'blockers',
  'capabilities',
  'checkedAt',
  'checks',
  'configStatus',
  'defaultBranch',
  'detectedKitRefs',
  'dryRun',
  'expectedKitRef',
  'manualReviewRequired',
  'ok',
  'paginationComplete',
  'permissionSummary',
  'ready',
  'reasonCodes',
  'repository',
  'reportVersion',
  'triggerSummary',
  'warnings',
  'workflowsAudited'
]);
const PROTECTION_AUDIT_KEYS = new Set([
  'apiReadOk',
  'auditedSha',
  'baseSha',
  'blockers',
  'bypassSummary',
  'checkedAt',
  'defaultBranch',
  'dryRun',
  'effectiveProtections',
  'manualReviewRequired',
  'mergeSettings',
  'ok',
  'paginationComplete',
  'ready',
  'reasonCodes',
  'repository',
  'reportVersion',
  'requiredChecks',
  'requiredReviews',
  'warnings'
]);
const PULL_REQUEST_KEYS = new Set([
  'baseBranch',
  'baseSha',
  'draft',
  'headSha',
  'isFork',
  'isSameRepository',
  'mergeStateStatus',
  'mergeable',
  'pullRequestNumber',
  'repository',
  'requestedReviewers',
  'requestedTeams',
  'state'
]);
const CHECK_SNAPSHOT_KEYS = new Set([
  'apiReadOk',
  'ciSuccessful',
  'duplicateChecks',
  'headSha',
  'paginationComplete',
  'requiredChecks',
  'requiredChecksSuccessful',
  'reviewEvidenceGateSuccessful'
]);
const CHANGED_FILES_KEYS = new Set([
  'apiReadOk',
  'dangerousChange',
  'files',
  'headSha',
  'pullRequestTarget',
  'secretLikeChange',
  'workflowPermissionIncrease'
]);
const EXECUTION_CONTEXT_KEYS = new Set([
  'actorContext',
  'allowedBaseBranches',
  'attemptCount',
  'cooldownSeconds',
  'currentBaseSha',
  'currentHeadSha',
  'existingIdempotencyKeys',
  'headShaAtEnd',
  'headShaAtStart',
  'lastAttemptedAt',
  'maxAttempts',
  'now',
  'pullRequestNumber',
  'reportMaxAgeMs',
  'repository',
  'requestedAt',
  'requiredChecks',
  'runStartedAt'
]);

export function executeAutoMergeDryRun(input = {}) {
  const blockers = [];
  const warnings = [];

  if (!isPlainObject(input)) {
    addBlocker(blockers, 'report_schema_invalid', 'Executor input must be an object.', '$');
    return finalizeDecision({ blockers, warnings });
  }

  validateUnknownKeys(input, new Set([
    'autoMergePlan',
    'changedFilesSnapshot',
    'checkSnapshot',
    'consumerAuditReport',
    'executionContext',
    'protectionAuditReport',
    'pullRequestSnapshot',
    'reviewEvidenceReport'
  ]), blockers, '$');

  const executionContext = normalizeExecutionContext(input.executionContext);
  const autoMergePlan = normalizeAutoMergePlan(input.autoMergePlan);
  const pullRequest = normalizePullRequestSnapshot(input.pullRequestSnapshot);
  const checks = normalizeCheckSnapshot(input.checkSnapshot);
  const changedFiles = normalizeChangedFilesSnapshot(input.changedFilesSnapshot);
  const reviewEvidence = normalizeReviewEvidenceReport(input.reviewEvidenceReport);
  const consumerAudit = normalizeConsumerAuditReport(input.consumerAuditReport);
  const protectionAudit = normalizeProtectionAuditReport(input.protectionAuditReport);

  validateSchema({
    autoMergePlan,
    blockers,
    changedFiles,
    checks,
    consumerAudit,
    executionContext,
    protectionAudit,
    pullRequest,
    reviewEvidence
  });

  const current = resolveCurrentContext({ autoMergePlan, executionContext, pullRequest });
  validateCurrentContext(current, blockers);

  if (blockers.length === 0) {
    validateReportFreshness({ current, report: reviewEvidence, reportName: 'reviewEvidenceReport', blockers });
    validateReportFreshness({ current, report: consumerAudit, reportName: 'consumerAuditReport', blockers });
    validateReportFreshness({ current, report: protectionAudit, reportName: 'protectionAuditReport', blockers });
    validateReportIdentity({ current, report: autoMergePlan, reportName: 'autoMergePlan', blockers });
    validateReportIdentity({ current, report: reviewEvidence, reportName: 'reviewEvidenceReport', blockers, staleReview: true });
    validateDefaultBranchAuditIdentity({
      auditedSha: consumerAudit.auditedCommitSha,
      blockers,
      current,
      defaultBranch: consumerAudit.defaultBranch,
      report: consumerAudit,
      reportName: 'consumerAuditReport',
      shaPath: 'auditedCommitSha'
    });
    validateDefaultBranchAuditIdentity({
      auditedSha: protectionAudit.auditedSha,
      blockers,
      current,
      defaultBranch: protectionAudit.defaultBranch,
      report: protectionAudit,
      reportName: 'protectionAuditReport',
      shaPath: 'auditedSha'
    });
    validatePullRequestSnapshot({ current, pullRequest, executionContext, blockers });
    validateReviewEvidence({ current, reviewEvidence, blockers });
    validateChecks({ checks, current, executionContext, blockers });
    validateChangedFiles({ changedFiles, current, blockers });
    validateAudits({ consumerAudit, protectionAudit, blockers });
    validateIdempotencyAndCooldown({ autoMergePlan, current, executionContext, blockers });
  }

  let command = null;
  let commandValidation = null;
  let adapterResult = null;
  let commandCandidateReason = '';

  if (blockers.length === 0) {
    const candidate = createWriteCommandCandidateFromAutoMergePlan(autoMergePlan.raw, {
      actorContext: executionContext.actorContext,
      now: executionContext.now,
      requestedAt: executionContext.requestedAt || executionContext.now
    });
    command = candidate.command;
    commandCandidateReason = candidate.reasonCode || '';

    if (!command) {
      addBlocker(blockers, commandCandidateReason || 'write_command_invalid', 'Write command candidate could not be created.', 'autoMergePlan');
    } else {
      commandValidation = validateWriteCommand(command, candidate.validationContext);
      if (!commandValidation.ok) {
        addBlocker(blockers, 'write_command_invalid', 'Write command candidate failed fail-closed validation.', 'writeCommand');
        command = null;
        commandValidation = null;
      } else {
        adapterResult = new DisabledGitHubWriteAdapter().execute(command, candidate.validationContext);
      }
    }
  }

  return finalizeDecision({
    adapterResult,
    blockers,
    command,
    commandValidation,
    current,
    warnings
  });
}

export function formatAutoMergeDryRunDecision(decision) {
  const lines = [];
  lines.push(`Auto-merge dry-run executor: ${decision.eligible ? 'ELIGIBLE' : 'BLOCKED'}`);
  lines.push(`repository: ${decision.repository || '(unknown)'}`);
  lines.push(`pullRequestNumber: ${decision.pullRequestNumber || '(unknown)'}`);
  lines.push(`currentHeadSha: ${decision.currentHeadSha || '(unknown)'}`);
  lines.push(`currentBaseSha: ${decision.currentBaseSha || '(unknown)'}`);
  lines.push(`commandCreated: ${decision.commandCreated}`);
  lines.push(`commandValid: ${decision.commandValid}`);
  lines.push(`adapterAccepted: ${decision.adapterAccepted}`);
  lines.push(`executed: ${decision.executed}`);
  lines.push(`reasonCodes: ${decision.reasonCodes.join(', ') || '(none)'}`);
  if (decision.blockers.length > 0) {
    lines.push(`blockers: ${decision.blockers.length}`);
    for (const blocker of decision.blockers) {
      lines.push(`- ${blocker.reasonCode}: ${blocker.message}${blocker.path ? ` (${blocker.path})` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function validateSchema(context) {
  const {
    autoMergePlan,
    blockers,
    changedFiles,
    checks,
    consumerAudit,
    executionContext,
    protectionAudit,
    pullRequest,
    reviewEvidence
  } = context;

  validateUnknownKeys(executionContext.raw, EXECUTION_CONTEXT_KEYS, blockers, 'executionContext');
  validateUnknownKeys(autoMergePlan.raw, AUTO_MERGE_PLAN_ROOT_KEYS, blockers, 'autoMergePlan');
  validateUnknownKeys(autoMergePlan.outputs, new Set(AUTO_MERGE_OUTPUT_NAMES), blockers, 'autoMergePlan.outputs');
  validateUnknownKeys(reviewEvidence.raw, REVIEW_EVIDENCE_KEYS, blockers, 'reviewEvidenceReport');
  validateUnknownKeys(consumerAudit.raw, CONSUMER_AUDIT_KEYS, blockers, 'consumerAuditReport');
  validateUnknownKeys(protectionAudit.raw, PROTECTION_AUDIT_KEYS, blockers, 'protectionAuditReport');
  validateUnknownKeys(pullRequest.raw, PULL_REQUEST_KEYS, blockers, 'pullRequestSnapshot');
  validateUnknownKeys(checks.raw, CHECK_SNAPSHOT_KEYS, blockers, 'checkSnapshot');
  validateUnknownKeys(changedFiles.raw, CHANGED_FILES_KEYS, blockers, 'changedFilesSnapshot');

  requireFields(executionContext.raw, [
    'actorContext',
    'allowedBaseBranches',
    'currentBaseSha',
    'currentHeadSha',
    'now',
    'pullRequestNumber',
    'repository',
    'runStartedAt'
  ], blockers, 'executionContext');
  requireFields(autoMergePlan.outputs, [
    'base_sha',
    'eligible',
    'head_sha',
    'pull_request_number',
    'repository',
    'should_enable_auto_merge',
    'should_merge'
  ], blockers, 'autoMergePlan.outputs');
  requireFields(reviewEvidence.raw, [
    'apiReadOk',
    'approved',
    'baseSha',
    'blockers',
    'changesRequested',
    'checkedAt',
    'currentRunEvidence',
    'evidenceType',
    'headSha',
    'paginationComplete',
    'pullRequestNumber',
    'repository',
    'reportVersion',
    'requestedReviewers',
    'requestedTeams',
    'reviewedAt',
    'unresolvedReviewThreads'
  ], blockers, 'reviewEvidenceReport');
  requireFields(consumerAudit.raw, [
    'apiReadOk',
    'auditedCommitSha',
    'blockers',
    'checkedAt',
    'defaultBranch',
    'manualReviewRequired',
    'paginationComplete',
    'ready',
    'repository',
    'reportVersion'
  ], blockers, 'consumerAuditReport');
  requireFields(protectionAudit.raw, [
    'apiReadOk',
    'auditedSha',
    'blockers',
    'checkedAt',
    'defaultBranch',
    'manualReviewRequired',
    'paginationComplete',
    'ready',
    'repository',
    'reportVersion'
  ], blockers, 'protectionAuditReport');
  requireFields(pullRequest.raw, [
    'baseBranch',
    'baseSha',
    'draft',
    'headSha',
    'isFork',
    'isSameRepository',
    'mergeable',
    'mergeStateStatus',
    'pullRequestNumber',
    'repository',
    'requestedReviewers',
    'requestedTeams',
    'state'
  ], blockers, 'pullRequestSnapshot');
  requireFields(checks.raw, [
    'apiReadOk',
    'ciSuccessful',
    'duplicateChecks',
    'headSha',
    'paginationComplete',
    'requiredChecks',
    'requiredChecksSuccessful',
    'reviewEvidenceGateSuccessful'
  ], blockers, 'checkSnapshot');
  requireFields(changedFiles.raw, [
    'apiReadOk',
    'dangerousChange',
    'files',
    'headSha',
    'pullRequestTarget',
    'secretLikeChange',
    'workflowPermissionIncrease'
  ], blockers, 'changedFilesSnapshot');

  validateBooleanFields(reviewEvidence.raw, [
    'apiReadOk',
    'approved',
    'changesRequested',
    'currentRunEvidence',
    'paginationComplete'
  ], blockers, 'reviewEvidenceReport');
  validateBooleanFields(consumerAudit.raw, [
    'apiReadOk',
    'manualReviewRequired',
    'paginationComplete',
    'ready'
  ], blockers, 'consumerAuditReport');
  validateBooleanFields(protectionAudit.raw, [
    'apiReadOk',
    'manualReviewRequired',
    'paginationComplete',
    'ready'
  ], blockers, 'protectionAuditReport');
  validateBooleanFields(pullRequest.raw, [
    'draft',
    'isFork',
    'isSameRepository',
    'mergeable'
  ], blockers, 'pullRequestSnapshot');
  validateBooleanFields(checks.raw, [
    'apiReadOk',
    'ciSuccessful',
    'duplicateChecks',
    'paginationComplete',
    'requiredChecksSuccessful',
    'reviewEvidenceGateSuccessful'
  ], blockers, 'checkSnapshot');
  validateBooleanFields(changedFiles.raw, [
    'apiReadOk',
    'dangerousChange',
    'pullRequestTarget',
    'secretLikeChange',
    'workflowPermissionIncrease'
  ], blockers, 'changedFilesSnapshot');

  validateArrayFields(executionContext.raw, ['allowedBaseBranches'], blockers, 'executionContext');
  validateArrayFields(reviewEvidence.raw, ['blockers'], blockers, 'reviewEvidenceReport');
  validateArrayFields(consumerAudit.raw, ['blockers'], blockers, 'consumerAuditReport');
  validateArrayFields(protectionAudit.raw, ['blockers'], blockers, 'protectionAuditReport');
  validateArrayFields(checks.raw, ['requiredChecks'], blockers, 'checkSnapshot');
  validateArrayFields(changedFiles.raw, ['files'], blockers, 'changedFilesSnapshot');

  validatePositiveIntegerFields(executionContext.raw, ['pullRequestNumber'], blockers, 'executionContext');
  validatePositiveIntegerFields(reviewEvidence.raw, ['pullRequestNumber'], blockers, 'reviewEvidenceReport');
  validatePositiveIntegerFields(pullRequest.raw, ['pullRequestNumber'], blockers, 'pullRequestSnapshot');
  validateNonNegativeIntegerFields(reviewEvidence.raw, [
    'requestedReviewers',
    'requestedTeams',
    'unresolvedReviewThreads'
  ], blockers, 'reviewEvidenceReport');
  validateNonNegativeIntegerFields(pullRequest.raw, [
    'requestedReviewers',
    'requestedTeams'
  ], blockers, 'pullRequestSnapshot');

  validateTimestampFields(executionContext.raw, ['now', 'runStartedAt'], blockers, 'executionContext');
  validateTimestampFields(reviewEvidence.raw, ['checkedAt', 'reviewedAt'], blockers, 'reviewEvidenceReport');
  validateTimestampFields(consumerAudit.raw, ['checkedAt'], blockers, 'consumerAuditReport');
  validateTimestampFields(protectionAudit.raw, ['checkedAt'], blockers, 'protectionAuditReport');

  validateShaFields(executionContext.raw, ['currentBaseSha', 'currentHeadSha'], blockers, 'executionContext');
  validateShaFields(reviewEvidence.raw, ['baseSha', 'headSha'], blockers, 'reviewEvidenceReport');
  validateShaFields(consumerAudit.raw, ['auditedCommitSha'], blockers, 'consumerAuditReport');
  validateShaFields(protectionAudit.raw, ['auditedSha'], blockers, 'protectionAuditReport');
  validateShaFields(pullRequest.raw, ['baseSha', 'headSha'], blockers, 'pullRequestSnapshot');
  validateShaFields(checks.raw, ['headSha'], blockers, 'checkSnapshot');
  validateShaFields(changedFiles.raw, ['headSha'], blockers, 'changedFilesSnapshot');

  validateRepositoryField(executionContext.raw, blockers, 'executionContext');
  validateRepositoryField(reviewEvidence.raw, blockers, 'reviewEvidenceReport');
  validateRepositoryField(consumerAudit.raw, blockers, 'consumerAuditReport');
  validateRepositoryField(protectionAudit.raw, blockers, 'protectionAuditReport');
  validateRepositoryField(pullRequest.raw, blockers, 'pullRequestSnapshot');

  validateIssueArray(reviewEvidence.raw.blockers, blockers, 'reviewEvidenceReport.blockers');
  validateIssueArray(consumerAudit.raw.blockers, blockers, 'consumerAuditReport.blockers');
  validateIssueArray(protectionAudit.raw.blockers, blockers, 'protectionAuditReport.blockers');
  validateRequiredChecks(checks.raw.requiredChecks, blockers);

  if (reviewEvidence.raw?.reportVersion !== REVIEW_EVIDENCE_REPORT_VERSION) {
    addBlocker(blockers, 'report_schema_invalid', 'Review evidence report version is unsupported.', 'reviewEvidenceReport.reportVersion');
  }
  if (consumerAudit.raw?.reportVersion !== 'live-consumer-audit.v1') {
    addBlocker(blockers, 'report_schema_invalid', 'Consumer audit report version is unsupported.', 'consumerAuditReport.reportVersion');
  }
  if (protectionAudit.raw?.reportVersion !== 1) {
    addBlocker(blockers, 'report_schema_invalid', 'Protection audit report version is unsupported.', 'protectionAuditReport.reportVersion');
  }
  if (!isValidTimestamp(executionContext.now)) {
    addBlocker(blockers, 'report_schema_invalid', 'Execution context now timestamp is invalid.', 'executionContext.now');
  }
  if (executionContext.runStartedAt && !isValidTimestamp(executionContext.runStartedAt)) {
    addBlocker(blockers, 'report_schema_invalid', 'Execution context runStartedAt timestamp is invalid.', 'executionContext.runStartedAt');
  }
}

function resolveCurrentContext({ autoMergePlan, executionContext, pullRequest }) {
  return {
    baseBranch: pullRequest.baseBranch,
    currentBaseSha: executionContext.currentBaseSha || pullRequest.baseSha || autoMergePlan.baseSha,
    currentHeadSha: executionContext.currentHeadSha || pullRequest.headSha || autoMergePlan.headSha,
    now: executionContext.now,
    pullRequestNumber: executionContext.pullRequestNumber || pullRequest.pullRequestNumber || autoMergePlan.pullRequestNumber,
    reportMaxAgeMs: executionContext.reportMaxAgeMs,
    repository: executionContext.repository || pullRequest.repository || autoMergePlan.repository,
    runStartedAt: executionContext.runStartedAt || executionContext.now
  };
}

function validateCurrentContext(current, blockers) {
  if (!REPOSITORY_PATTERN.test(current.repository)) {
    addBlocker(blockers, 'report_schema_invalid', 'Repository must use owner/name format.', 'executionContext.repository');
  }
  if (!Number.isInteger(current.pullRequestNumber) || current.pullRequestNumber <= 0) {
    addBlocker(blockers, 'report_schema_invalid', 'Pull request number must be positive.', 'executionContext.pullRequestNumber');
  }
  if (!isValidSha(current.currentHeadSha)) {
    addBlocker(blockers, 'report_schema_invalid', 'Current head SHA must be a 40-character SHA.', 'executionContext.currentHeadSha');
  }
  if (!isValidSha(current.currentBaseSha)) {
    addBlocker(blockers, 'report_schema_invalid', 'Current base SHA must be a 40-character SHA.', 'executionContext.currentBaseSha');
  }
}

function validateReportFreshness({ blockers, current, report, reportName }) {
  const timestamp = report.checkedAt;
  if (!timestamp) {
    addBlocker(blockers, 'report_schema_invalid', 'Report timestamp is required.', `${reportName}.checkedAt`);
    return;
  }
  if (!isValidTimestamp(timestamp)) {
    addBlocker(blockers, 'report_schema_invalid', 'Report timestamp is invalid.', `${reportName}.checkedAt`);
    return;
  }

  const maxAgeMs = Number.isInteger(current.reportMaxAgeMs) && current.reportMaxAgeMs >= 0
    ? current.reportMaxAgeMs
    : DEFAULT_REPORT_MAX_AGE_MS;
  const nowMs = Date.parse(current.now);
  const timestampMs = Date.parse(timestamp);
  if (Number.isFinite(nowMs) && nowMs - timestampMs > maxAgeMs) {
    addBlocker(blockers, 'report_expired', 'Report is older than the allowed dry-run window.', reportName);
  }
}

function validateReportIdentity({ blockers, current, report, reportName, staleReview = false }) {
  if (report.repository && report.repository !== current.repository) {
    addBlocker(blockers, 'report_repository_mismatch', 'Report repository does not match current PR.', `${reportName}.repository`);
  }
  if (report.pullRequestNumber && report.pullRequestNumber !== current.pullRequestNumber) {
    addBlocker(blockers, 'report_pull_request_mismatch', 'Report pull request number does not match current PR.', `${reportName}.pullRequestNumber`);
  }

  const reportHeadSha = report.evidenceHeadSha || report.headSha;
  if (reportHeadSha && reportHeadSha !== current.currentHeadSha) {
    addBlocker(
      blockers,
      staleReview ? 'stale_review_head' : 'report_head_sha_mismatch',
      'Report head SHA does not match current PR head.',
      `${reportName}.headSha`
    );
  }

  if (report.baseSha && report.baseSha !== current.currentBaseSha) {
    addBlocker(blockers, 'report_base_sha_mismatch', 'Report base SHA does not match current PR base.', `${reportName}.baseSha`);
  }
}

function validateDefaultBranchAuditIdentity({ auditedSha, blockers, current, defaultBranch, report, reportName, shaPath }) {
  if (report.repository && report.repository !== current.repository) {
    addBlocker(blockers, 'report_repository_mismatch', 'Audit report repository does not match current PR.', `${reportName}.repository`);
  }
  if (defaultBranch && defaultBranch !== current.baseBranch) {
    addBlocker(blockers, 'report_base_sha_mismatch', 'Audit report default branch does not match PR base branch.', `${reportName}.defaultBranch`);
  }
  if (auditedSha && auditedSha !== current.currentBaseSha) {
    addBlocker(blockers, 'report_base_sha_mismatch', 'Audit report default branch SHA does not match current PR base.', `${reportName}.${shaPath}`);
  }
}

function validatePullRequestSnapshot({ blockers, current, executionContext, pullRequest }) {
  if (pullRequest.repository && pullRequest.repository !== current.repository) {
    addBlocker(blockers, 'report_repository_mismatch', 'Pull request snapshot repository does not match execution context.', 'pullRequestSnapshot.repository');
  }
  if (pullRequest.pullRequestNumber && pullRequest.pullRequestNumber !== current.pullRequestNumber) {
    addBlocker(blockers, 'report_pull_request_mismatch', 'Pull request snapshot number does not match execution context.', 'pullRequestSnapshot.pullRequestNumber');
  }
  if (pullRequest.headSha !== current.currentHeadSha) {
    addBlocker(blockers, 'report_head_sha_mismatch', 'Pull request snapshot head does not match current head.', 'pullRequestSnapshot.headSha');
  }
  if (pullRequest.baseSha !== current.currentBaseSha) {
    addBlocker(blockers, 'report_base_sha_mismatch', 'Pull request snapshot base does not match current base.', 'pullRequestSnapshot.baseSha');
  }
  if (executionContext.headShaAtStart && executionContext.headShaAtEnd && executionContext.headShaAtStart !== executionContext.headShaAtEnd) {
    addBlocker(blockers, 'report_head_sha_mismatch', 'PR head changed during dry-run decision.', 'executionContext.headShaAtEnd');
  }
  if (pullRequest.state !== 'open') {
    addBlocker(blockers, 'unknown_state', 'Pull request is not open.', 'pullRequestSnapshot.state');
  }
  if (pullRequest.draft === true) {
    addBlocker(blockers, 'unknown_state', 'Draft pull request cannot be auto-merged.', 'pullRequestSnapshot.draft');
  }
  if (pullRequest.isSameRepository !== true) {
    addBlocker(blockers, 'unknown_state', 'Pull request is not from the same repository.', 'pullRequestSnapshot.isSameRepository');
  }
  if (pullRequest.isFork === true) {
    addBlocker(blockers, 'unknown_state', 'Fork pull request cannot be auto-merged.', 'pullRequestSnapshot.isFork');
  }
  if (!allowedBaseBranches(executionContext).includes(pullRequest.baseBranch)) {
    addBlocker(blockers, 'unknown_state', 'Base branch is not allowed for auto-merge.', 'pullRequestSnapshot.baseBranch');
  }
  if (pullRequest.mergeable !== true) {
    addBlocker(blockers, 'unknown_state', 'Pull request mergeability is not safely true.', 'pullRequestSnapshot.mergeable');
  }
  if (!SAFE_MERGE_STATES.has(pullRequest.mergeStateStatus)) {
    addBlocker(blockers, 'unknown_state', 'Pull request merge state is not safely mergeable.', 'pullRequestSnapshot.mergeStateStatus');
  }
}

function validateReviewEvidence({ blockers, current, reviewEvidence }) {
  if (reviewEvidence.apiReadOk !== true || reviewEvidence.paginationComplete !== true) {
    addBlocker(blockers, 'review_evidence_missing', 'Review evidence could not be completely read.', 'reviewEvidenceReport');
  }
  if (reviewEvidence.blockers.length > 0) {
    addBlocker(blockers, 'review_evidence_missing', 'Review evidence report contains blockers.', 'reviewEvidenceReport.blockers');
  }
  if (reviewEvidence.changesRequested === true) {
    addBlocker(blockers, 'changes_requested', 'Review evidence contains unresolved changes requested.', 'reviewEvidenceReport.changesRequested');
  }
  if (reviewEvidence.approved !== true) {
    addBlocker(blockers, 'review_evidence_missing', 'Current-head review evidence is missing.', 'reviewEvidenceReport.approved');
  }
  if (reviewEvidence.unresolvedReviewThreads > 0) {
    addBlocker(blockers, 'unresolved_review_thread', 'Unresolved review thread remains.', 'reviewEvidenceReport.unresolvedReviewThreads');
  }
  if (reviewEvidence.requestedReviewers > 0 || reviewEvidence.requestedTeams > 0) {
    addBlocker(blockers, 'requested_reviewer_remaining', 'Requested reviewers or teams remain.', 'reviewEvidenceReport.requestedReviewers');
  }
  const reviewedAt = reviewEvidence.reviewedAt || reviewEvidence.checkedAt || '';
  if (reviewEvidence.currentRunEvidence === true || (reviewedAt && isValidTimestamp(reviewedAt) && Date.parse(reviewedAt) >= Date.parse(current.runStartedAt))) {
    addBlocker(blockers, 'review_evidence_from_current_run', 'Review evidence was created during the same dry-run.', 'reviewEvidenceReport.reviewedAt');
  }
}

function validateChecks({ blockers, checks, current, executionContext }) {
  if (checks.headSha && checks.headSha !== current.currentHeadSha) {
    addBlocker(blockers, 'report_head_sha_mismatch', 'Check snapshot head does not match current head.', 'checkSnapshot.headSha');
  }
  if (checks.apiReadOk !== true || checks.paginationComplete !== true) {
    addBlocker(blockers, 'ci_not_successful', 'CI/check API read did not complete.', 'checkSnapshot');
  }
  if (checks.ciSuccessful !== true || checks.requiredChecksSuccessful !== true) {
    addBlocker(blockers, 'ci_not_successful', 'CI or required checks are not successful.', 'checkSnapshot');
  }
  if (checks.duplicateChecks === true) {
    addBlocker(blockers, 'required_check_missing', 'Required check names are duplicated or ambiguous.', 'checkSnapshot.duplicateChecks');
  }

  const requiredNames = requiredCheckNames(executionContext);
  const checksByName = new Map();
  for (const check of checks.requiredChecks) {
    if (checksByName.has(check.name)) {
      addBlocker(blockers, 'required_check_missing', 'Required check name is duplicated.', `checkSnapshot.requiredChecks.${check.name}`);
    }
    checksByName.set(check.name, check);
  }

  for (const name of requiredNames) {
    const check = checksByName.get(name);
    if (!check) {
      addBlocker(blockers, 'required_check_missing', `Required check is missing: ${name}.`, `checkSnapshot.requiredChecks.${name}`);
      continue;
    }
    if (check.headSha && check.headSha !== current.currentHeadSha) {
      addBlocker(blockers, 'report_head_sha_mismatch', 'Required check is not for the current head.', `checkSnapshot.requiredChecks.${name}.headSha`);
    }
    if (check.status !== 'completed' || check.conclusion !== 'success') {
      addBlocker(blockers, name.toLowerCase() === 'ci' ? 'ci_not_successful' : 'required_check_missing', `Required check is not successful: ${name}.`, `checkSnapshot.requiredChecks.${name}`);
    }
  }

  if (checks.reviewEvidenceGateSuccessful !== true) {
    addBlocker(blockers, 'required_check_missing', 'Review evidence gate is not successful.', 'checkSnapshot.reviewEvidenceGateSuccessful');
  }
}

function validateChangedFiles({ blockers, changedFiles, current }) {
  if (changedFiles.headSha !== current.currentHeadSha) {
    addBlocker(blockers, 'report_head_sha_mismatch', 'Changed files snapshot head does not match current head.', 'changedFilesSnapshot.headSha');
  }
  if (changedFiles.apiReadOk !== true) {
    addBlocker(blockers, 'unknown_state', 'Changed files could not be read completely.', 'changedFilesSnapshot');
  }
  if (changedFiles.dangerousChange || changedFiles.workflowPermissionIncrease || changedFiles.pullRequestTarget) {
    addBlocker(blockers, 'dangerous_change_detected', 'Dangerous changed file or workflow permission change was detected.', 'changedFilesSnapshot');
  }
  if (changedFiles.secretLikeChange) {
    addBlocker(blockers, 'secret_like_change_detected', 'Secret-like added line was detected.', 'changedFilesSnapshot.secretLikeChange');
  }
}

function validateAudits({ blockers, consumerAudit, protectionAudit }) {
  if (consumerAudit.apiReadOk !== true || consumerAudit.paginationComplete !== true || consumerAudit.ready !== true || consumerAudit.manualReviewRequired !== false || consumerAudit.blockers.length > 0) {
    addBlocker(blockers, 'consumer_audit_not_ready', 'Live consumer audit is not ready.', 'consumerAuditReport');
  }
  if (protectionAudit.apiReadOk !== true || protectionAudit.paginationComplete !== true || protectionAudit.ready !== true || protectionAudit.manualReviewRequired !== false || protectionAudit.blockers.length > 0) {
    addBlocker(blockers, 'protection_audit_not_ready', 'Repository protection audit is not ready.', 'protectionAuditReport');
  }
}

function validateIdempotencyAndCooldown({ autoMergePlan, blockers, current, executionContext }) {
  if (!hasTrustedActorContext(executionContext.actorContext)) {
    addBlocker(blockers, 'unknown_state', 'Trusted actor context is missing or unsafe.', 'executionContext.actorContext');
  }

  const operation = inferOperationFromPlan(autoMergePlan.outputs);
  const idempotencyKey = operation
    ? `write-v1:${operation}:${current.repository}#${current.pullRequestNumber}:${current.currentHeadSha}:${current.currentBaseSha}`
    : '';
  if (idempotencyKey && executionContext.existingIdempotencyKeys.includes(idempotencyKey)) {
    addBlocker(blockers, 'duplicate_operation', 'A matching write command idempotency key already exists.', 'executionContext.existingIdempotencyKeys');
  }
  if (Number.isInteger(executionContext.maxAttempts) && executionContext.attemptCount >= executionContext.maxAttempts) {
    addBlocker(blockers, 'attempt_limit_exceeded', 'Auto-merge dry-run attempt limit is exceeded.', 'executionContext.attemptCount');
  }
  if (executionContext.cooldownSeconds > 0 && executionContext.lastAttemptedAt && isValidTimestamp(executionContext.lastAttemptedAt)) {
    const nowMs = Date.parse(executionContext.now);
    const lastMs = Date.parse(executionContext.lastAttemptedAt);
    if (Number.isFinite(nowMs) && Number.isFinite(lastMs) && nowMs - lastMs < executionContext.cooldownSeconds * 1000) {
      addBlocker(blockers, 'cooldown_active', 'Auto-merge dry-run cooldown is active.', 'executionContext.lastAttemptedAt');
    }
  }
}

function normalizeExecutionContext(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    raw,
    actorContext: isPlainObject(raw.actorContext) ? {
      actor: cleanString(raw.actorContext.actor),
      isFork: raw.actorContext.isFork === true,
      isTrusted: raw.actorContext.isTrusted === true,
      source: cleanString(raw.actorContext.source)
    } : undefined,
    allowedBaseBranches: normalizeStringArray(raw.allowedBaseBranches),
    attemptCount: Number.isInteger(raw.attemptCount) ? raw.attemptCount : 0,
    cooldownSeconds: Number.isInteger(raw.cooldownSeconds) ? raw.cooldownSeconds : 0,
    currentBaseSha: cleanSha(raw.currentBaseSha),
    currentHeadSha: cleanSha(raw.currentHeadSha),
    existingIdempotencyKeys: normalizeStringArray(raw.existingIdempotencyKeys),
    headShaAtEnd: cleanSha(raw.headShaAtEnd),
    headShaAtStart: cleanSha(raw.headShaAtStart),
    lastAttemptedAt: cleanString(raw.lastAttemptedAt),
    maxAttempts: Number.isInteger(raw.maxAttempts) ? raw.maxAttempts : 3,
    now: cleanString(raw.now),
    pullRequestNumber: normalizePullRequestNumber(raw.pullRequestNumber),
    reportMaxAgeMs: Number.isInteger(raw.reportMaxAgeMs) ? raw.reportMaxAgeMs : DEFAULT_REPORT_MAX_AGE_MS,
    repository: cleanRepository(raw.repository),
    requestedAt: cleanString(raw.requestedAt),
    requiredChecks: normalizeStringArray(raw.requiredChecks),
    runStartedAt: cleanString(raw.runStartedAt)
  };
}

function normalizeAutoMergePlan(value) {
  const raw = isPlainObject(value) ? value : {};
  const outputs = isPlainObject(raw.outputs) ? raw.outputs : raw;
  const normalized = {
    raw,
    outputs,
    baseSha: cleanSha(outputs.base_sha),
    headSha: cleanSha(outputs.head_sha),
    pullRequestNumber: normalizePullRequestNumber(outputs.pull_request_number),
    repository: cleanRepository(outputs.repository)
  };
  return normalized;
}

function normalizeReviewEvidenceReport(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    raw,
    apiReadOk: raw.apiReadOk === true,
    approved: raw.approved === true,
    baseSha: cleanSha(raw.baseSha),
    blockers: normalizeIssues(raw.blockers),
    changesRequested: raw.changesRequested === true,
    checkedAt: cleanString(raw.checkedAt || raw.createdAt),
    createdAt: cleanString(raw.createdAt),
    currentRunEvidence: raw.currentRunEvidence === true,
    evidenceHeadSha: cleanSha(raw.evidenceHeadSha),
    evidenceType: cleanString(raw.evidenceType),
    headSha: cleanSha(raw.headSha),
    paginationComplete: raw.paginationComplete === true,
    pullRequestNumber: normalizePullRequestNumber(raw.pullRequestNumber),
    reasonCodes: normalizeStringArray(raw.reasonCodes),
    repository: cleanRepository(raw.repository),
    requestedReviewers: normalizeCount(raw.requestedReviewers),
    requestedTeams: normalizeCount(raw.requestedTeams),
    reviewedAt: cleanString(raw.reviewedAt),
    runStartedAt: cleanString(raw.runStartedAt),
    unresolvedReviewThreads: normalizeCount(raw.unresolvedReviewThreads),
    warnings: normalizeIssues(raw.warnings)
  };
}

function normalizeConsumerAuditReport(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    raw,
    apiReadOk: raw.apiReadOk === true,
    auditedCommitSha: cleanSha(raw.auditedCommitSha),
    blockers: normalizeIssues(raw.blockers),
    checkedAt: cleanString(raw.checkedAt),
    defaultBranch: cleanString(raw.defaultBranch),
    manualReviewRequired: raw.manualReviewRequired === true,
    paginationComplete: raw.paginationComplete === true,
    ready: raw.ready === true,
    repository: cleanRepository(raw.repository),
    warnings: normalizeIssues(raw.warnings)
  };
}

function normalizeProtectionAuditReport(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    raw,
    apiReadOk: raw.apiReadOk === true,
    auditedSha: cleanSha(raw.auditedSha),
    baseSha: cleanSha(raw.baseSha),
    blockers: normalizeIssues(raw.blockers),
    checkedAt: cleanString(raw.checkedAt),
    defaultBranch: cleanString(raw.defaultBranch),
    manualReviewRequired: raw.manualReviewRequired === true,
    paginationComplete: raw.paginationComplete === true,
    ready: raw.ready === true,
    repository: cleanRepository(raw.repository),
    warnings: normalizeIssues(raw.warnings)
  };
}

function normalizePullRequestSnapshot(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    raw,
    baseBranch: cleanString(raw.baseBranch),
    baseSha: cleanSha(raw.baseSha),
    draft: raw.draft === true,
    headSha: cleanSha(raw.headSha),
    isFork: raw.isFork === true,
    isSameRepository: raw.isSameRepository === true,
    mergeable: raw.mergeable === true,
    mergeStateStatus: cleanString(raw.mergeStateStatus).toLowerCase(),
    pullRequestNumber: normalizePullRequestNumber(raw.pullRequestNumber),
    repository: cleanRepository(raw.repository),
    requestedReviewers: normalizeCount(raw.requestedReviewers),
    requestedTeams: normalizeCount(raw.requestedTeams),
    state: cleanString(raw.state)
  };
}

function normalizeCheckSnapshot(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    raw,
    apiReadOk: raw.apiReadOk === true,
    ciSuccessful: raw.ciSuccessful === true,
    duplicateChecks: raw.duplicateChecks === true,
    headSha: cleanSha(raw.headSha),
    paginationComplete: raw.paginationComplete === true,
    requiredChecks: Array.isArray(raw.requiredChecks) ? raw.requiredChecks.map(normalizeRequiredCheck).filter((check) => check.name) : [],
    requiredChecksSuccessful: raw.requiredChecksSuccessful === true,
    reviewEvidenceGateSuccessful: raw.reviewEvidenceGateSuccessful === true
  };
}

function normalizeChangedFilesSnapshot(value) {
  const raw = isPlainObject(value) ? value : {};
  const files = Array.isArray(raw.files) ? raw.files : [];
  return {
    raw,
    apiReadOk: raw.apiReadOk === true,
    dangerousChange: raw.dangerousChange === true || files.some((file) => file?.dangerous === true),
    headSha: cleanSha(raw.headSha),
    pullRequestTarget: raw.pullRequestTarget === true || files.some((file) => file?.pullRequestTarget === true),
    secretLikeChange: raw.secretLikeChange === true || files.some((file) => file?.secretLike === true),
    workflowPermissionIncrease: raw.workflowPermissionIncrease === true || files.some((file) => file?.workflowPermissionIncrease === true)
  };
}

function finalizeDecision({
  adapterResult = null,
  blockers,
  command = null,
  commandValidation = null,
  current = {},
  warnings
}) {
  const commandCreated = command !== null;
  const commandValid = commandCreated && commandValidation?.ok === true;
  const eligible = blockers.length === 0 && commandValid;
  const adapterReasonCode = adapterResult?.reasonCode || '';
  const reasonCodes = stableArray([
    ...blockers.map((entry) => entry.reasonCode),
    ...warnings.map((entry) => entry.reasonCode),
    adapterReasonCode
  ].filter(Boolean));

  return stableObject({
    adapterAccepted: adapterResult?.accepted === true,
    auditRecord: createDryRunAuditRecord({
      adapterResult,
      blockers,
      command,
      current,
      eligible,
      reasonCodes
    }),
    blockers,
    command: sanitizeCommand(command),
    commandCreated,
    commandValid,
    currentBaseSha: current.currentBaseSha || '',
    currentHeadSha: current.currentHeadSha || '',
    dryRun: true,
    eligible,
    evidenceHeadSha: '',
    executed: adapterResult?.executed === true,
    ok: blockers.length === 0,
    pullRequestNumber: current.pullRequestNumber || 0,
    reasonCodes,
    reportVersion: AUTO_MERGE_DRY_RUN_EXECUTOR_REPORT_VERSION,
    repository: current.repository || '',
    shouldCreateWriteCommand: blockers.length === 0,
    warnings
  });
}

function createDryRunAuditRecord({ adapterResult, blockers, command, current, eligible, reasonCodes }) {
  return stableObject({
    accepted: adapterResult?.accepted === true,
    blockerReasonCodes: stableArray(blockers.map((entry) => entry.reasonCode)),
    commandOperation: cleanString(command?.operation),
    dryRun: true,
    executed: adapterResult?.executed === true,
    expectedBaseSha: cleanSha(command?.expectedBaseSha) || current.currentBaseSha || '',
    expectedHeadSha: cleanSha(command?.expectedHeadSha) || current.currentHeadSha || '',
    pullRequestNumber: current.pullRequestNumber || 0,
    reasonCodes,
    reportVersion: AUTO_MERGE_DRY_RUN_EXECUTOR_REPORT_VERSION,
    repository: current.repository || '',
    result: eligible ? 'eligible_write_disabled' : 'blocked'
  });
}

function sanitizeCommand(command) {
  if (!command) {
    return null;
  }
  return stableObject({
    dryRun: command.dryRun === true,
    expectedBaseSha: cleanSha(command.expectedBaseSha),
    expectedHeadSha: cleanSha(command.expectedHeadSha),
    idempotencyKey: cleanString(command.idempotencyKey),
    operation: cleanString(command.operation),
    operationId: cleanString(command.operationId),
    pullRequestNumber: normalizePullRequestNumber(command.pullRequestNumber),
    reasonCode: cleanString(command.reasonCode),
    repository: cleanRepository(command.repository)
  });
}

function validateUnknownKeys(value, allowedKeys, blockers, path) {
  if (!isPlainObject(value)) {
    addBlocker(blockers, 'report_schema_invalid', 'Expected an object.', path);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addBlocker(blockers, 'report_schema_invalid', 'Report contains an unknown key.', `${path}.${key}`);
    }
  }
}

function requireFields(value, fields, blockers, path) {
  if (!isPlainObject(value)) {
    return;
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field) || value[field] === undefined || value[field] === null || value[field] === '') {
      addBlocker(blockers, 'report_schema_invalid', 'Report is missing a required field.', `${path}.${field}`);
    }
  }
}

function validateBooleanFields(value, fields, blockers, path) {
  validateFieldTypes(value, fields, blockers, path, (entry) => typeof entry === 'boolean', 'boolean');
}

function validateArrayFields(value, fields, blockers, path) {
  validateFieldTypes(value, fields, blockers, path, Array.isArray, 'array');
}

function validatePositiveIntegerFields(value, fields, blockers, path) {
  validateFieldTypes(value, fields, blockers, path, (entry) => Number.isInteger(entry) && entry > 0, 'positive integer');
}

function validateNonNegativeIntegerFields(value, fields, blockers, path) {
  validateFieldTypes(value, fields, blockers, path, (entry) => Number.isInteger(entry) && entry >= 0, 'non-negative integer');
}

function validateTimestampFields(value, fields, blockers, path) {
  validateFieldTypes(value, fields, blockers, path, (entry) => typeof entry === 'string' && isValidTimestamp(entry), 'valid timestamp');
}

function validateShaFields(value, fields, blockers, path) {
  validateFieldTypes(value, fields, blockers, path, (entry) => typeof entry === 'string' && SHA_PATTERN.test(entry), '40-character SHA');
}

function validateFieldTypes(value, fields, blockers, path, predicate, expectedType) {
  if (!isPlainObject(value)) {
    return;
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field) || value[field] === undefined || value[field] === null || value[field] === '') {
      continue;
    }
    if (!predicate(value[field])) {
      addBlocker(blockers, 'report_schema_invalid', `Report field must be a ${expectedType}.`, `${path}.${field}`);
    }
  }
}

function validateRepositoryField(value, blockers, path) {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'repository')) {
    return;
  }
  if (typeof value.repository !== 'string' || !REPOSITORY_PATTERN.test(value.repository)) {
    addBlocker(blockers, 'report_schema_invalid', 'Report repository must use owner/name format.', `${path}.repository`);
  }
}

function validateIssueArray(value, blockers, path) {
  if (!Array.isArray(value)) {
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isPlainObject(entry) || !cleanString(entry.reasonCode ?? entry.code)) {
      addBlocker(blockers, 'report_schema_invalid', 'Report blocker must contain a reason code.', `${path}.${index}`);
    }
  }
}

function validateRequiredChecks(value, blockers) {
  if (!Array.isArray(value)) {
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const check = value[index];
    const path = `checkSnapshot.requiredChecks.${index}`;
    if (!isPlainObject(check)) {
      addBlocker(blockers, 'report_schema_invalid', 'Required check must be an object.', path);
      continue;
    }
    requireFields(check, ['conclusion', 'headSha', 'name', 'status'], blockers, path);
    validateShaFields(check, ['headSha'], blockers, path);
  }
}

function addBlocker(blockers, reasonCode, message, path = '') {
  blockers.push(stableObject({
    message,
    path,
    reasonCode
  }));
}

function normalizeRequiredCheck(value) {
  return {
    appId: value?.appId === undefined || value?.appId === null ? null : String(value.appId),
    conclusion: cleanString(value?.conclusion).toLowerCase(),
    headSha: cleanSha(value?.headSha),
    name: cleanString(value?.name),
    status: cleanString(value?.status).toLowerCase() || 'completed'
  };
}

function normalizeIssues(value) {
  return Array.isArray(value) ? value.map((entry) => ({
    reasonCode: cleanString(entry?.reasonCode ?? entry?.code),
    message: cleanString(entry?.message)
  })).filter((entry) => entry.reasonCode) : [];
}

function allowedBaseBranches(executionContext) {
  return executionContext.allowedBaseBranches.length > 0 ? executionContext.allowedBaseBranches : [];
}

function requiredCheckNames(executionContext) {
  return executionContext.requiredChecks.length > 0 ? executionContext.requiredChecks : [...DEFAULT_REQUIRED_CHECKS];
}

function inferOperationFromPlan(outputs = {}) {
  if (outputs.should_merge === 'true') {
    return 'merge-pull-request';
  }
  if (outputs.should_enable_auto_merge === 'true') {
    return 'enable-auto-merge';
  }
  return '';
}

function hasTrustedActorContext(value) {
  return Boolean(
    value
    && value.actor
    && value.source
    && value.isTrusted === true
    && value.isFork === false
  );
}

function isValidSha(value) {
  return SHA_PATTERN.test(value);
}

function isValidTimestamp(value) {
  const time = Date.parse(cleanString(value));
  return Number.isFinite(time);
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => cleanString(entry)).filter(Boolean).sort() : [];
}

function stableArray(values) {
  return [...new Set(values.map(String).filter(Boolean))].sort();
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = stableObject(value[key]);
  }
  return result;
}

function normalizePullRequestNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function cleanRepository(value) {
  const repository = cleanString(value);
  return REPOSITORY_PATTERN.test(repository) ? repository : repository;
}

function cleanSha(value) {
  const sha = cleanString(value).toLowerCase();
  return SHA_PATTERN.test(sha) ? sha : '';
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
