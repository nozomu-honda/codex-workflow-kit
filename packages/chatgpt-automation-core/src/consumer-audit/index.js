import YAML from 'yaml';
import { validateAutomationConfig } from '../config/index.js';
import { classifyRef, RELEASE_CAPABILITIES } from '../release-readiness/index.js';

export const LIVE_CONSUMER_AUDIT_REPORT_VERSION = 'live-consumer-audit.v1';
export const DEFAULT_LIVE_CONSUMER_CONFIG_PATH = '.github/chatgpt-automation.yml';
export const DEFAULT_KIT_REPOSITORY = 'nozomu-honda/codex-workflow-kit';
export const LIVE_CONSUMER_INVENTORY_SCHEMA_VERSION = 1;

const SHA40_LOWER_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLACEHOLDER_REF = 'REPLACE_WITH_40_CHAR_COMMIT_SHA';
const DISALLOWED_WRITE_PERMISSIONS = new Set([
  'contents',
  'pull-requests',
  'issues',
  'checks',
  'actions',
  'statuses',
  'deployments',
  'id-token',
  'packages',
  'security-events'
]);
const INVENTORY_ALLOWED_KEYS = Object.freeze([
  'id',
  'repository',
  'defaultBranch',
  'configPath',
  'callerWorkflowPaths',
  'expectedKitRef',
  'desiredCapabilitySet',
  'expectedWorkflowNames',
  'allowedTriggers',
  'allowedPermissions',
  'manualReviewRequired'
]);

export const LIVE_CONSUMER_WORKFLOW_SPECS = Object.freeze({
  'config-validation': Object.freeze({
    capability: 'config-validation',
    path: '.github/workflows/validate-config.yml',
    expectedJob: 'validate-config',
    expectedReusableWorkflow: '.github/workflows/validate-config.yml',
    allowedTriggers: ['workflow_dispatch'],
    allowedPermissions: { contents: 'read' }
  }),
  'event-normalization': Object.freeze({
    capability: 'event-normalization',
    path: '.github/workflows/chatgpt-automation-events.yml',
    expectedJob: 'normalize-event',
    expectedReusableWorkflow: '.github/workflows/normalize-event.yml',
    allowedTriggers: [
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'workflow_run',
      'pull_request',
      'push'
    ],
    allowedPermissions: { contents: 'read' }
  }),
  'review-routing-plan': Object.freeze({
    capability: 'review-routing-plan',
    path: '.github/workflows/chatgpt-review-routing-events.yml',
    expectedJob: 'review-routing',
    expectedReusableWorkflow: '.github/workflows/review-routing.yml',
    allowedTriggers: [
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'workflow_run',
      'pull_request',
      'push',
      'workflow_dispatch'
    ],
    allowedPermissions: readPlannerPermissions()
  }),
  'auto-merge-plan': Object.freeze({
    capability: 'auto-merge-plan',
    path: '.github/workflows/reviewed-pr-auto-merge-events.yml',
    expectedJob: 'auto-merge-plan',
    expectedReusableWorkflow: '.github/workflows/auto-merge-plan.yml',
    allowedTriggers: [
      'workflow_run',
      'check_suite',
      'check_run',
      'pull_request_review',
      'pull_request_review_comment',
      'pull_request',
      'workflow_dispatch'
    ],
    allowedPermissions: readPlannerPermissions()
  }),
  'main-follow-up-plan': Object.freeze({
    capability: 'main-follow-up-plan',
    path: '.github/workflows/main-follow-up-events.yml',
    expectedJob: 'main-follow-up-plan',
    expectedReusableWorkflow: '.github/workflows/main-follow-up-plan.yml',
    allowedTriggers: ['push', 'pull_request', 'workflow_dispatch'],
    allowedPermissions: readPlannerPermissions()
  })
});

export function auditLiveConsumerInstallation(options = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const kitRepository = normalizeRepositoryName(options.kitRepository ?? DEFAULT_KIT_REPOSITORY);
  const inventory = normalizeConsumerInventoryItem(options.consumer ?? {});
  const snapshot = normalizeSnapshot(options.snapshot ?? {});
  const detectedKitRefs = new Set();
  const workflowsAudited = [];
  const triggerSummary = {};
  const permissionSummary = {
    workflowsWithWrite: 0,
    workflowsWithMissingPermissions: 0,
    workflowsAudited: 0
  };
  let configStatus = 'not_checked';
  let configCapabilities = falseCapabilities();

  validateInventory(inventory, errors, warnings, checks);
  validateSnapshot(snapshot, inventory, errors, warnings, checks);

  const configFile = snapshot.files[inventory.configPath];
  if (!configFile || configFile.status === 'missing') {
    addError(errors, checks, 'config_missing', 'Consumer config file is missing.', {
      file: inventory.configPath
    });
    configStatus = 'missing';
  } else if (configFile.status !== 'ok') {
    addError(errors, checks, fileStatusCode(configFile.status), 'Consumer config file could not be safely audited.', {
      file: inventory.configPath
    });
    configStatus = 'unreadable';
  } else {
    const configAudit = auditConfigFile(configFile.content, inventory.configPath);
    configStatus = configAudit.status;
    configCapabilities = configAudit.capabilities;
    errors.push(...configAudit.errors);
    warnings.push(...configAudit.warnings);
    checks.push(...configAudit.checks);
  }

  const workflowPaths = new Set(inventory.callerWorkflowPaths);
  const workflowMetadataByPath = new Map(snapshot.workflowMetadata.map((entry) => [entry.path, entry]));

  for (const path of [...workflowPaths].sort()) {
    const file = snapshot.files[path];
    const spec = workflowContractForPath(path, inventory);
    const metadata = workflowMetadataByPath.get(path);
    const workflowSummary = {
      path,
      capability: spec?.capability ?? 'unknown',
      status: 'not_found',
      kitRefs: [],
      triggers: [],
      permissions: {},
      workflowName: metadata?.name ?? null,
      workflowState: metadata?.state ?? null
    };

    if (!file || file.status === 'missing') {
      if (inventory.callerWorkflowPaths.includes(path)) {
        addError(errors, checks, 'workflow_missing', 'Expected caller workflow is missing.', { file: path });
      }
      workflowsAudited.push(stableObject(workflowSummary));
      continue;
    }

    if (file.status !== 'ok') {
      addError(errors, checks, fileStatusCode(file.status), 'Workflow file could not be safely audited.', { file: path });
      workflowsAudited.push(stableObject({ ...workflowSummary, status: file.status }));
      continue;
    }

    const workflowAudit = auditWorkflowFile({
      path,
      source: file.content,
      spec,
      expectedKitRef: inventory.expectedKitRef,
      kitRepository
    });
    const metadataAudit = auditWorkflowMetadata({
      path,
      metadata,
      metadataProvided: snapshot.workflowMetadataProvided,
      expectedWorkflowNames: inventory.expectedWorkflowNames
    });
    errors.push(...workflowAudit.errors);
    errors.push(...metadataAudit.errors);
    warnings.push(...workflowAudit.warnings);
    checks.push(...workflowAudit.checks);
    checks.push(...metadataAudit.checks);
    for (const ref of workflowAudit.kitRefs) {
      detectedKitRefs.add(ref);
    }
    for (const trigger of workflowAudit.triggers) {
      triggerSummary[trigger] = (triggerSummary[trigger] ?? 0) + 1;
    }
    if (workflowAudit.hasWritePermission) {
      permissionSummary.workflowsWithWrite += 1;
    }
    if (workflowAudit.missingPermissions) {
      permissionSummary.workflowsWithMissingPermissions += 1;
    }
    permissionSummary.workflowsAudited += 1;
    workflowsAudited.push(stableObject({
      ...workflowSummary,
      status: workflowAudit.status,
      kitRefs: stableArray(workflowAudit.kitRefs),
      triggers: stableArray(workflowAudit.triggers),
      permissions: workflowAudit.permissions
    }));
  }

  validateCapabilityWorkflowAlignment({
    inventory,
    configCapabilities,
    workflowPaths,
    errors,
    checks
  });
  validateKitRefs({
    detectedKitRefs: [...detectedKitRefs],
    expectedKitRef: inventory.expectedKitRef,
    errors,
    checks
  });

  let blockers = [...errors].sort(compareIssues);
  if (inventory.manualReviewRequired === true) {
    const manualReviewBlockers = [];
    addError(manualReviewBlockers, checks, 'manual_review_required', 'Consumer inventory requires manual review.');
    blockers = [...blockers, ...manualReviewBlockers].sort(compareIssues);
  }
  const manualReviewRequired = inventory.manualReviewRequired === true || blockers.length > 0;
  const ready = blockers.length === 0;

  return stableObject({
    ok: ready,
    ready,
    dryRun: true,
    reportVersion: LIVE_CONSUMER_AUDIT_REPORT_VERSION,
    repository: inventory.repository,
    defaultBranch: inventory.defaultBranch,
    auditedCommitSha: snapshot.defaultBranchStartSha,
    expectedKitRef: inventory.expectedKitRef,
    detectedKitRefs: stableArray([...detectedKitRefs]),
    capabilities: {
      config: configCapabilities,
      desired: stableArray(inventory.desiredCapabilitySet),
      workflows: stableArray(workflowsAudited.map((entry) => entry.capability).filter((value) => value !== 'unknown'))
    },
    workflowsAudited,
    configStatus,
    permissionSummary,
    triggerSummary: stableObject(triggerSummary),
    blockers,
    warnings: [...warnings].sort(compareIssues),
    manualReviewRequired,
    checks: [...checks].sort(compareIssues),
    checkedAt: options.checkedAt ?? null
  });
}

export function validateLiveConsumerInventoryObject(value) {
  const errors = [];
  const warnings = [];
  const checks = [];

  if (!isPlainObject(value)) {
    addError(errors, checks, 'inventory_object_required', 'Consumer audit inventory must be an object.');
    return { ok: false, errors, warnings, checks, consumers: [] };
  }

  const allowedRootKeys = new Set(['schemaVersion', 'consumers']);
  for (const key of Object.keys(value)) {
    if (!allowedRootKeys.has(key)) {
      addError(errors, checks, 'inventory_unknown_key', 'Consumer audit inventory contains an unknown root key.', {
        path: key
      });
    }
  }

  if (value.schemaVersion !== LIVE_CONSUMER_INVENTORY_SCHEMA_VERSION) {
    addError(errors, checks, 'inventory_schema_version_invalid', 'Consumer audit inventory schemaVersion is unsupported.', {
      path: 'schemaVersion'
    });
  }

  if (!Array.isArray(value.consumers)) {
    addError(errors, checks, 'inventory_consumers_required', 'Consumer audit inventory must contain consumers array.', {
      path: 'consumers'
    });
    return { ok: false, errors, warnings, checks, consumers: [] };
  }

  const repositories = new Set();
  const consumers = [];
  for (const [index, entry] of value.consumers.entries()) {
    const consumer = normalizeConsumerInventoryItem(entry);
    consumers.push(consumer);
    const before = errors.length;
    validateInventory(consumer, errors, warnings, checks, `consumers.${index}`);
    if (consumer.repository && repositories.has(consumer.repository)) {
      addError(errors, checks, 'inventory_repository_duplicate', 'Consumer audit inventory contains duplicate repository.', {
        path: `consumers.${index}.repository`
      });
    }
    if (consumer.repository) {
      repositories.add(consumer.repository);
    }
    if (before === errors.length) {
      addCheck(checks, 'inventory_consumer_valid', 'Consumer audit inventory item is structurally valid.', 'pass', {
        path: `consumers.${index}`
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
    consumers
  };
}

export function formatLiveConsumerAuditReport(report) {
  const lines = [];
  lines.push(`Live consumer audit: ${report.ready ? 'READY' : 'BLOCKED'}`);
  lines.push(`repository: ${report.repository}`);
  lines.push(`defaultBranch: ${report.defaultBranch}`);
  lines.push(`auditedCommitSha: ${report.auditedCommitSha}`);
  lines.push(`expectedKitRef: ${report.expectedKitRef}`);
  lines.push(`detectedKitRefs: ${report.detectedKitRefs.length > 0 ? report.detectedKitRefs.join(', ') : '(none)'}`);
  lines.push(`workflowsAudited: ${report.workflowsAudited.length}`);
  lines.push(`blockers: ${report.blockers.length}`);
  for (const blocker of report.blockers) {
    lines.push(`- ${blocker.code}: ${blocker.message}${formatLocation(blocker)}`);
  }
  lines.push(`warnings: ${report.warnings.length}`);
  for (const warning of report.warnings) {
    lines.push(`- ${warning.code}: ${warning.message}${formatLocation(warning)}`);
  }
  return `${lines.join('\n')}\n`;
}

function auditConfigFile(source, file) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const validation = validateAutomationConfig(source);

  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      addError(errors, checks, 'config_schema_invalid', 'Consumer config contains a schema warning and must be reviewed.', {
        file,
        path: warning.path
      });
    }
  }

  if (!validation.ok) {
    for (const error of validation.errors) {
      addError(errors, checks, 'config_schema_invalid', 'Consumer config schema validation failed.', {
        file,
        path: error.path
      });
    }
    return {
      status: 'invalid',
      capabilities: falseCapabilities(),
      errors,
      warnings,
      checks
    };
  }

  const config = validation.config;
  const writeLikePaths = [
    'features.actionsApproval',
    'queues.reviewFix.enabled',
    'queues.mainFollowup.enabled',
    'codex.reviewFix.enabled',
    'codex.mainFollowup.enabled',
    'schedules.actionsApproval.enabled'
  ];
  for (const path of writeLikePaths) {
    if (readDottedPath(config, path) === true) {
      addError(errors, checks, 'write_capability_enabled', 'Write-capable automation remains out of scope for live consumer audit.', {
        file,
        path
      });
    }
  }

  addCheck(checks, 'config_valid', 'Consumer config passed schema validation.', 'pass', { file });
  return {
    status: errors.length === 0 ? 'valid' : 'invalid',
    capabilities: validation.capabilities,
    errors,
    warnings,
    checks
  };
}

function auditWorkflowFile(options) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const kitRefs = [];
  const triggers = [];
  const permissions = {};
  const { path, source, spec, expectedKitRef, kitRepository } = options;
  const parsed = parseYaml(source);

  if (!parsed.ok) {
    addError(errors, checks, 'workflow_yaml_invalid', 'Workflow YAML could not be parsed.', { file: path });
    return {
      status: 'invalid',
      errors,
      warnings,
      checks,
      kitRefs,
      triggers,
      permissions,
      hasWritePermission: false,
      missingPermissions: false
    };
  }

  const workflow = parsed.value;
  if (!isPlainObject(workflow)) {
    addError(errors, checks, 'workflow_object_required', 'Workflow root must be an object.', { file: path });
    return {
      status: 'invalid',
      errors,
      warnings,
      checks,
      kitRefs,
      triggers,
      permissions,
      hasWritePermission: false,
      missingPermissions: true
    };
  }

  if (!spec) {
    addError(errors, checks, 'unknown_workflow', 'Workflow path is not a known ChatGPT automation caller.', { file: path });
  }

  const triggerAudit = auditTriggers(workflow.on, spec, path);
  errors.push(...triggerAudit.errors);
  checks.push(...triggerAudit.checks);
  triggers.push(...triggerAudit.triggers);

  const rootPermissionAudit = auditPermissions(workflow.permissions, spec?.allowedPermissions, path, 'permissions');
  errors.push(...rootPermissionAudit.errors);
  checks.push(...rootPermissionAudit.checks);
  permissions.workflow = rootPermissionAudit.summary;

  const jobAudit = auditJobs(workflow.jobs, {
    path,
    spec,
    expectedKitRef,
    kitRepository
  });
  errors.push(...jobAudit.errors);
  warnings.push(...jobAudit.warnings);
  checks.push(...jobAudit.checks);
  kitRefs.push(...jobAudit.kitRefs);
  permissions.jobs = jobAudit.permissionSummaries;

  const structuralAudit = auditDangerousWorkflowStructure(workflow, path);
  errors.push(...structuralAudit.errors);
  warnings.push(...structuralAudit.warnings);
  checks.push(...structuralAudit.checks);

  if (errors.length === 0) {
    addCheck(checks, 'workflow_audit_ok', 'Workflow passed live consumer audit checks.', 'pass', { file: path });
  }

  return {
    status: errors.length === 0 ? 'valid' : 'invalid',
    errors,
    warnings,
    checks,
    kitRefs,
    triggers,
    permissions,
    hasWritePermission: rootPermissionAudit.hasWritePermission || jobAudit.hasWritePermission,
    missingPermissions: rootPermissionAudit.missingPermissions || jobAudit.missingPermissions
  };
}

function auditWorkflowMetadata(options) {
  const errors = [];
  const checks = [];

  if (!options.metadataProvided) {
    return { errors, checks };
  }

  if (!options.metadata) {
    addError(errors, checks, 'workflow_metadata_missing', 'Actions workflow metadata is missing for caller workflow.', {
      file: options.path
    });
    return { errors, checks };
  }

  if (options.metadata.state && options.metadata.state !== 'active') {
    addError(errors, checks, 'workflow_metadata_inactive', 'Actions workflow metadata is not active.', {
      file: options.path,
      value: options.metadata.state
    });
  }

  if (
    options.expectedWorkflowNames.length > 0
    && !options.expectedWorkflowNames.includes(options.metadata.name)
  ) {
    addError(errors, checks, 'workflow_name_mismatch', 'Actions workflow name does not match inventory contract.', {
      file: options.path
    });
  }

  if (errors.length === 0) {
    addCheck(checks, 'workflow_metadata_ok', 'Actions workflow metadata matches inventory contract.', 'pass', {
      file: options.path
    });
  }

  return { errors, checks };
}

function auditTriggers(onValue, spec, file) {
  const errors = [];
  const checks = [];
  const triggers = isPlainObject(onValue) ? Object.keys(onValue).sort() : [];

  if (!isPlainObject(onValue)) {
    addError(errors, checks, 'workflow_trigger_invalid', 'Workflow must define triggers as an object.', {
      file,
      path: 'on'
    });
    return { errors, checks, triggers };
  }

  for (const trigger of triggers) {
    if (trigger === 'pull_request_target') {
      addError(errors, checks, 'pull_request_target_present', 'pull_request_target is forbidden.', {
        file,
        path: 'on.pull_request_target'
      });
      continue;
    }
    if (trigger === 'schedule') {
      addError(errors, checks, 'unexpected_trigger', 'schedule is not allowed in live consumer caller workflows.', {
        file,
        path: 'on.schedule'
      });
      continue;
    }
    if (!spec?.allowedTriggers.includes(trigger)) {
      addError(errors, checks, 'unexpected_trigger', 'Workflow contains a trigger outside the capability contract.', {
        file,
        path: `on.${trigger}`
      });
    }
  }

  if (triggers.length === 0) {
    addError(errors, checks, 'workflow_trigger_invalid', 'Workflow must define at least one trigger.', {
      file,
      path: 'on'
    });
  }

  if (errors.length === 0) {
    addCheck(checks, 'workflow_triggers_ok', 'Workflow triggers match the capability contract.', 'pass', { file });
  }

  return { errors, checks, triggers };
}

function auditJobs(jobs, context) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const kitRefs = [];
  const permissionSummaries = {};
  let hasWritePermission = false;
  let missingPermissions = false;

  if (!isPlainObject(jobs)) {
    addError(errors, checks, 'jobs_object_required', 'Workflow jobs must be an object.', {
      file: context.path,
      path: 'jobs'
    });
    return { errors, warnings, checks, kitRefs, permissionSummaries, hasWritePermission, missingPermissions: true };
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    const jobPath = `jobs.${jobName}`;
    if (!isPlainObject(job)) {
      addError(errors, checks, 'job_object_required', 'Workflow job must be an object.', {
        file: context.path,
        path: jobPath
      });
      continue;
    }

    const permissionAudit = auditPermissions(job.permissions, context.spec?.allowedPermissions, context.path, `${jobPath}.permissions`);
    errors.push(...permissionAudit.errors);
    checks.push(...permissionAudit.checks);
    permissionSummaries[jobName] = permissionAudit.summary;
    hasWritePermission = hasWritePermission || permissionAudit.hasWritePermission;
    missingPermissions = missingPermissions || permissionAudit.missingPermissions;

    if (Object.hasOwn(job, 'secrets')) {
      const code = job.secrets === 'inherit' ? 'secrets_inherit_present' : 'secret_usage_present';
      addError(errors, checks, code, 'Caller workflow must not pass secrets.', {
        file: context.path,
        path: `${jobPath}.secrets`
      });
    }

    for (const forbidden of ['runs-on', 'steps', 'run', 'shell']) {
      if (Object.hasOwn(job, forbidden)) {
        addError(errors, checks, forbiddenJobCode(forbidden), 'Caller workflow must remain a thin job-level reusable workflow call.', {
          file: context.path,
          path: `${jobPath}.${forbidden}`
        });
      }
    }

    if (typeof job.uses !== 'string') {
      addError(errors, checks, 'workflow_uses_missing', 'Caller job must use a reusable workflow with job-level uses.', {
        file: context.path,
        path: `${jobPath}.uses`
      });
    } else {
      const usesAudit = auditUsesValue(job.uses, {
        file: context.path,
        path: `${jobPath}.uses`,
        expectedKitRef: context.expectedKitRef,
        expectedReusableWorkflow: context.spec?.expectedReusableWorkflow,
        kitRepository: context.kitRepository
      });
      errors.push(...usesAudit.errors);
      checks.push(...usesAudit.checks);
      kitRefs.push(...usesAudit.kitRefs);
    }

    const inputAudit = auditWorkflowInputs(job.with, {
      file: context.path,
      path: `${jobPath}.with`,
      expectedKitRef: context.expectedKitRef
    });
    errors.push(...inputAudit.errors);
    checks.push(...inputAudit.checks);
    kitRefs.push(...inputAudit.kitRefs);
  }

  return {
    errors,
    warnings,
    checks,
    kitRefs,
    permissionSummaries,
    hasWritePermission,
    missingPermissions
  };
}

function auditPermissions(permissions, allowedPermissions, file, path) {
  const errors = [];
  const checks = [];
  const summary = {};
  let hasWritePermission = false;
  let missingPermissions = false;

  if (permissions === 'write-all') {
    addError(errors, checks, 'unexpected_write_permission', 'write-all is forbidden for live consumer audit.', {
      file,
      path
    });
    return { errors, checks, summary: { '*': 'write-all' }, hasWritePermission: true, missingPermissions };
  }

  if (!isPlainObject(permissions)) {
    addError(errors, checks, 'workflow_permission_missing', 'Workflow and job permissions must be explicit.', {
      file,
      path
    });
    return { errors, checks, summary, hasWritePermission, missingPermissions: true };
  }

  for (const [name, value] of Object.entries(permissions)) {
    summary[name] = value;
    if (value === 'write' || value === 'write-all' || (DISALLOWED_WRITE_PERMISSIONS.has(name) && value === 'write')) {
      addError(errors, checks, 'unexpected_write_permission', 'Write permissions are forbidden for live consumer audit.', {
        file,
        path: `${path}.${name}`
      });
      hasWritePermission = true;
    }
  }

  if (permissions === 'write-all') {
    addError(errors, checks, 'unexpected_write_permission', 'write-all is forbidden for live consumer audit.', {
      file,
      path
    });
    hasWritePermission = true;
  }

  const expected = allowedPermissions ?? {};
  for (const [name, value] of Object.entries(expected)) {
    if (permissions[name] !== value) {
      addError(errors, checks, 'workflow_permission_missing', 'Required read-only permission is missing or different.', {
        file,
        path: `${path}.${name}`
      });
      missingPermissions = true;
    }
  }

  for (const name of Object.keys(permissions)) {
    if (!Object.hasOwn(expected, name)) {
      addError(errors, checks, permissions[name] === 'write' ? 'unexpected_write_permission' : 'unexpected_permission', 'Workflow permission is outside the capability contract.', {
        file,
        path: `${path}.${name}`
      });
      if (permissions[name] === 'write') {
        hasWritePermission = true;
      }
    }
  }

  if (errors.length === 0) {
    addCheck(checks, 'workflow_permissions_ok', 'Permissions are explicit and read-only.', 'pass', { file, path });
  }

  return { errors, checks, summary, hasWritePermission, missingPermissions };
}

function auditUsesValue(value, context) {
  const errors = [];
  const checks = [];
  const kitRefs = [];

  if (value.startsWith('./')) {
    addCheck(checks, 'local_uses_allowed', 'Local reusable workflow reference is allowed.', 'pass', {
      file: context.file,
      path: context.path
    });
    return { errors, checks, kitRefs };
  }

  const parsed = parseUses(value);
  if (!parsed.ok) {
    addError(errors, checks, 'unknown_ref', 'uses value must include an explicit @ref.', {
      file: context.file,
      path: context.path
    });
    return { errors, checks, kitRefs };
  }

  const refAudit = auditRef(parsed.ref, parsed.target.startsWith(`${context.kitRepository}/`) ? 'kit' : 'external', context);
  errors.push(...refAudit.errors);
  checks.push(...refAudit.checks);
  if (parsed.target.startsWith(`${context.kitRepository}/`)) {
    kitRefs.push(parsed.ref);
    if (context.expectedReusableWorkflow && parsed.target !== `${context.kitRepository}/${context.expectedReusableWorkflow}`) {
      addError(errors, checks, 'capability_caller_mismatch', 'Caller workflow uses an unexpected reusable workflow path.', {
        file: context.file,
        path: context.path
      });
    }
  }

  return { errors, checks, kitRefs };
}

function auditWorkflowInputs(withValue, context) {
  const errors = [];
  const checks = [];
  const kitRefs = [];

  if (!isPlainObject(withValue)) {
    addError(errors, checks, 'workflow_inputs_missing', 'Caller workflow must pass expected read-only inputs.', {
      file: context.file,
      path: context.path
    });
    return { errors, checks, kitRefs };
  }

  if (withValue['dry-run'] !== true) {
    addError(errors, checks, 'dry_run_not_true', 'Caller workflow dry-run input must be true.', {
      file: context.file,
      path: `${context.path}.dry-run`
    });
  }

  if (typeof withValue['kit-ref'] === 'string') {
    const ref = withValue['kit-ref'];
    kitRefs.push(ref);
    const refAudit = auditRef(ref, 'kit', {
      file: context.file,
      path: `${context.path}.kit-ref`,
      expectedKitRef: context.expectedKitRef
    });
    errors.push(...refAudit.errors);
    checks.push(...refAudit.checks);
  }

  return { errors, checks, kitRefs };
}

function auditRef(ref, kind, context) {
  const errors = [];
  const checks = [];
  const refType = classifyRef(ref);

  if (refType === 'sha40') {
    if (kind === 'kit' && context.expectedKitRef && ref !== context.expectedKitRef) {
      addError(errors, checks, 'kit_ref_mismatch', 'Kit ref does not match expected reviewed commit SHA.', {
        file: context.file,
        path: context.path
      });
    } else {
      addCheck(checks, kind === 'kit' ? 'kit_ref_pinned' : 'external_ref_pinned', 'Reference is pinned to a 40-character commit SHA.', 'pass', {
        file: context.file,
        path: context.path
      });
    }
    return { errors, checks };
  }

  const code = refCode(refType, kind, ref);
  addError(errors, checks, code, `${kind === 'kit' ? 'Kit' : 'External Action'} ref must be a 40-character lowercase commit SHA.`, {
    file: context.file,
    path: context.path
  });
  return { errors, checks };
}

function auditDangerousWorkflowStructure(workflow, file) {
  const errors = [];
  const warnings = [];
  const checks = [];

  walk(workflow, (value, path) => {
    const key = path[path.length - 1] ?? '';
    const dotted = path.join('.');

    if (key === 'secrets') {
      const code = value === 'inherit' ? 'secrets_inherit_present' : 'secret_usage_present';
      addError(errors, checks, code, 'Workflow must not pass secrets.', { file, path: dotted });
    }

    if (typeof value === 'string') {
      if (value.includes('${{ secrets.')) {
        addError(errors, checks, 'secret_reference_present', 'Workflow references secrets; secret names are intentionally not reported.', {
          file,
          path: dotted
        });
      }
      if (/Authorization|Bearer|Cookie|token|secret/i.test(value) && /\$\{\{\s*secrets\./.test(value)) {
        addError(errors, checks, 'secret_like_env_present', 'Workflow expands secret-like data into runtime configuration.', {
          file,
          path: dotted
        });
      }
      if (containsConcreteSecretLikeValue(value)) {
        addError(errors, checks, 'secret_like_env_present', 'Workflow contains concrete credential-like data.', {
          file,
          path: dotted
        });
      }
      if (key === 'run' && /github\.event|toJson\(github\.event\)/.test(value)) {
        addError(errors, checks, 'untrusted_payload_in_shell', 'Workflow must not expand untrusted event payload directly in shell.', {
          file,
          path: dotted
        });
      }
      if (key === 'run' && /\beval\b/.test(value)) {
        addError(errors, checks, 'unsafe_command_construction', 'Workflow must not use eval.', {
          file,
          path: dotted
        });
      }
    }

    if (key === 'persist-credentials' && value === true) {
      addError(errors, checks, 'checkout_persist_credentials_true', 'checkout persist-credentials must not be true in consumer callers.', {
        file,
        path: dotted
      });
    }
  });

  return { errors, warnings, checks };
}

function containsConcreteSecretLikeValue(value) {
  if (/script\.google\.com\/macros\/s\/[^/\s]+\/exec/i.test(value)) {
    return true;
  }

  const bearer = value.match(/\bAuthorization\s*:\s*Bearer\s+([^\s'"]+)/i)
    ?? value.match(/\bBearer\s+([A-Za-z0-9._-]{8,})\b/i);
  if (bearer && !isDummySecretValue(bearer[1])) {
    return true;
  }

  const cookie = value.match(/\bCookie\s*:\s*[^=\s;]+=([^\s;]+)/i);
  if (cookie && !isDummySecretValue(cookie[1])) {
    return true;
  }

  const assignment = value.match(/\b(?:TOKEN|SECRET|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN)\s*=\s*([^\s'"]+)/);
  return Boolean(assignment && !isDummySecretValue(assignment[1]));
}

function isDummySecretValue(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  return new Set([
    'dummy',
    'dummy-token',
    'example',
    'example-token',
    'sample',
    'sample-token',
    'placeholder',
    'redacted',
    'xxx',
    'xxxx',
    '<token>',
    '<secret>',
    'your_token',
    'replace_me'
  ]).has(normalized);
}

function validateCapabilityWorkflowAlignment(context) {
  const desired = new Set(context.inventory.desiredCapabilitySet);
  const present = new Set();

  for (const path of context.workflowPaths) {
    const spec = workflowSpecForPath(path);
    if (spec) {
      present.add(spec.capability);
    }
  }

  for (const capability of desired) {
    if (!present.has(capability)) {
      addError(context.errors, context.checks, 'capability_caller_mismatch', 'Desired capability has no matching caller workflow.', {
        path: capability
      });
    }
  }

  for (const capability of present) {
    if (!desired.has(capability)) {
      addError(context.errors, context.checks, 'capability_caller_mismatch', 'Caller workflow exists but capability is not desired by inventory.', {
        path: capability
      });
    }
  }

  for (const [name, enabled] of Object.entries(context.configCapabilities)) {
    if (enabled && !configCapabilityAllowed(name, desired)) {
      addError(context.errors, context.checks, 'capability_caller_mismatch', 'Config enables a capability that is not represented by desired callers.', {
        path: name
      });
    }
  }
}

function validateKitRefs(context) {
  const refs = stableArray(context.detectedKitRefs.filter(Boolean));
  const validRefs = refs.filter((ref) => SHA40_LOWER_PATTERN.test(ref));
  const uniqueValidRefs = [...new Set(validRefs)];

  if (uniqueValidRefs.length > 1) {
    addError(context.errors, context.checks, 'mixed_kit_refs', 'Consumer caller workflows must not mix kit refs.');
  }

  if (context.expectedKitRef && uniqueValidRefs.some((ref) => ref !== context.expectedKitRef)) {
    addError(context.errors, context.checks, 'kit_ref_mismatch', 'Detected kit refs must match expectedKitRef.');
  }
}

function validateInventory(inventory, errors, warnings, checks, prefix = '') {
  for (const key of Object.keys(inventory.raw ?? {})) {
    if (!INVENTORY_ALLOWED_KEYS.includes(key)) {
      addError(errors, checks, 'inventory_unknown_key', 'Consumer inventory item contains an unknown key.', {
        path: joinPath(prefix, key)
      });
    }
  }

  if (!REPOSITORY_PATTERN.test(inventory.repository)) {
    addError(errors, checks, 'repository_invalid', 'Repository must use owner/name format.', {
      path: joinPath(prefix, 'repository')
    });
  }

  if (inventory.repository.includes('://')) {
    addError(errors, checks, 'repository_invalid', 'Repository must not be a URL.', {
      path: joinPath(prefix, 'repository')
    });
  }

  if (!isSafeRepositoryPath(inventory.configPath)) {
    addError(errors, checks, 'path_invalid', 'Config path must stay inside the repository.', {
      path: joinPath(prefix, 'configPath')
    });
  }

  for (const [index, path] of inventory.callerWorkflowPaths.entries()) {
    if (!isSafeRepositoryPath(path)) {
      addError(errors, checks, 'path_invalid', 'Caller workflow path must stay inside the repository.', {
        path: joinPath(prefix, `callerWorkflowPaths.${index}`)
      });
    }
  }

  for (const duplicate of findDuplicates(inventory.callerWorkflowPaths)) {
    addError(errors, checks, 'workflow_path_duplicate', 'Caller workflow path is duplicated.', {
      path: joinPath(prefix, 'callerWorkflowPaths'),
      value: duplicate
    });
  }

  if (!SHA40_LOWER_PATTERN.test(inventory.expectedKitRef)) {
    addError(errors, checks, 'expected_kit_ref_invalid', 'expectedKitRef must be a 40-character lowercase commit SHA.', {
      path: joinPath(prefix, 'expectedKitRef')
    });
  }

  for (const capability of inventory.desiredCapabilitySet) {
    if (!RELEASE_CAPABILITIES.includes(capability)) {
      addError(errors, checks, 'capability_unknown', 'desiredCapabilitySet contains an unknown capability.', {
        path: joinPath(prefix, 'desiredCapabilitySet'),
        value: capability
      });
    }
  }

  for (const duplicate of findDuplicates(inventory.desiredCapabilitySet)) {
    addError(errors, checks, 'capability_duplicate', 'desiredCapabilitySet contains duplicate capability.', {
      path: joinPath(prefix, 'desiredCapabilitySet'),
      value: duplicate
    });
  }

  for (const duplicate of findDuplicates(inventory.expectedWorkflowNames)) {
    addError(errors, checks, 'workflow_name_duplicate', 'expectedWorkflowNames contains duplicate workflow name.', {
      path: joinPath(prefix, 'expectedWorkflowNames'),
      value: duplicate
    });
  }

  for (const [capability, triggers] of Object.entries(inventory.allowedTriggers)) {
    if (!RELEASE_CAPABILITIES.includes(capability)) {
      addError(errors, checks, 'capability_unknown', 'allowedTriggers contains an unknown capability.', {
        path: joinPath(prefix, `allowedTriggers.${capability}`)
      });
      continue;
    }
    if (!Array.isArray(triggers) || triggers.length === 0 || triggers.some((trigger) => typeof trigger !== 'string' || trigger.trim() === '')) {
      addError(errors, checks, 'allowed_triggers_invalid', 'allowedTriggers entries must be non-empty string arrays.', {
        path: joinPath(prefix, `allowedTriggers.${capability}`)
      });
      continue;
    }
    for (const duplicate of findDuplicates(triggers.map(String))) {
      addError(errors, checks, 'allowed_triggers_duplicate', 'allowedTriggers contains duplicate trigger.', {
        path: joinPath(prefix, `allowedTriggers.${capability}`),
        value: duplicate
      });
    }
  }

  for (const [capability, permissions] of Object.entries(inventory.allowedPermissions)) {
    if (!RELEASE_CAPABILITIES.includes(capability)) {
      addError(errors, checks, 'capability_unknown', 'allowedPermissions contains an unknown capability.', {
        path: joinPath(prefix, `allowedPermissions.${capability}`)
      });
      continue;
    }
    if (!isPlainObject(permissions) || Object.keys(permissions).length === 0) {
      addError(errors, checks, 'allowed_permissions_invalid', 'allowedPermissions entries must be non-empty permission objects.', {
        path: joinPath(prefix, `allowedPermissions.${capability}`)
      });
      continue;
    }
    for (const [name, value] of Object.entries(permissions)) {
      if (value !== 'read') {
        addError(errors, checks, 'allowed_permissions_invalid', 'allowedPermissions only permits read values.', {
          path: joinPath(prefix, `allowedPermissions.${capability}.${name}`)
        });
      }
    }
  }
}

function validateSnapshot(snapshot, inventory, errors, warnings, checks) {
  if (snapshot.apiErrors.length > 0) {
    for (const error of snapshot.apiErrors) {
      addError(errors, checks, error.code ?? 'api_read_failed', 'GitHub API read failed.', {
        path: error.path
      });
    }
  }

  if (snapshot.paginationIncomplete) {
    addError(errors, checks, 'pagination_incomplete', 'GitHub API pagination did not complete safely.');
  }

  if (snapshot.repository !== '' && snapshot.repository !== inventory.repository) {
    addError(errors, checks, 'repository_mismatch', 'Repository metadata does not match inventory repository.');
  }

  if (snapshot.defaultBranch !== '' && inventory.defaultBranch !== '' && snapshot.defaultBranch !== inventory.defaultBranch) {
    addError(errors, checks, 'default_branch_mismatch', 'Repository default branch does not match inventory.');
  }

  if (!SHA40_LOWER_PATTERN.test(snapshot.defaultBranchStartSha)) {
    addError(errors, checks, 'audited_sha_missing', 'Default branch start SHA could not be verified.');
  }

  if (!SHA40_LOWER_PATTERN.test(snapshot.defaultBranchEndSha)) {
    addError(errors, checks, 'audited_sha_missing', 'Default branch end SHA could not be verified.');
  }

  if (
    SHA40_LOWER_PATTERN.test(snapshot.defaultBranchStartSha)
    && SHA40_LOWER_PATTERN.test(snapshot.defaultBranchEndSha)
    && snapshot.defaultBranchStartSha !== snapshot.defaultBranchEndSha
  ) {
    addError(errors, checks, 'default_branch_changed_during_audit', 'Default branch changed during audit.');
  }

  if (errors.length === 0 || !errors.some((error) => ['default_branch_changed_during_audit', 'audited_sha_missing'].includes(error.code))) {
    addCheck(checks, 'audit_snapshot_stable', 'Repository snapshot remained stable during audit.', 'pass');
  }
}

function normalizeConsumerInventoryItem(value = {}) {
  const raw = isPlainObject(value?.raw) ? value.raw : isPlainObject(value) ? value : {};
  const workflowPaths = Array.isArray(raw.callerWorkflowPaths)
    ? raw.callerWorkflowPaths.map(normalizeRepositoryPath).filter(Boolean)
    : [];
  const desiredCapabilitySet = Array.isArray(raw.desiredCapabilitySet)
    ? raw.desiredCapabilitySet.map(String)
    : [];

  return {
    raw,
    id: typeof raw.id === 'string' ? raw.id.trim() : '',
    repository: normalizeRepositoryName(raw.repository),
    defaultBranch: typeof raw.defaultBranch === 'string' ? raw.defaultBranch.trim() : '',
    configPath: normalizeRepositoryPath(raw.configPath ?? DEFAULT_LIVE_CONSUMER_CONFIG_PATH),
    callerWorkflowPaths: workflowPaths,
    expectedKitRef: typeof raw.expectedKitRef === 'string'
      ? raw.expectedKitRef.trim()
      : typeof raw.currentKitRef === 'string'
        ? raw.currentKitRef.trim()
        : '',
    desiredCapabilitySet,
    expectedWorkflowNames: Array.isArray(raw.expectedWorkflowNames)
      ? raw.expectedWorkflowNames.map((value) => String(value).trim()).filter(Boolean)
      : [],
    allowedTriggers: normalizeAllowedTriggers(raw.allowedTriggers),
    allowedPermissions: normalizeAllowedPermissions(raw.allowedPermissions),
    manualReviewRequired: raw.manualReviewRequired === true
  };
}

function normalizeAllowedTriggers(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const result = {};
  for (const [capability, triggers] of Object.entries(value)) {
    result[capability] = Array.isArray(triggers)
      ? triggers.map((trigger) => String(trigger).trim()).filter(Boolean)
      : triggers;
  }
  return result;
}

function normalizeAllowedPermissions(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const result = {};
  for (const [capability, permissions] of Object.entries(value)) {
    result[capability] = isPlainObject(permissions) ? stableObject(permissions) : permissions;
  }
  return result;
}

function normalizeSnapshot(value = {}) {
  const files = {};
  const rawFiles = isPlainObject(value.files) ? value.files : {};
  for (const [path, file] of Object.entries(rawFiles)) {
    files[normalizeRepositoryPath(path)] = normalizeFile(file);
  }
  const workflowMetadataProvided = Array.isArray(value.workflowMetadata);
  return {
    repository: normalizeRepositoryName(value.repository),
    defaultBranch: typeof value.defaultBranch === 'string' ? value.defaultBranch.trim() : '',
    defaultBranchStartSha: typeof value.defaultBranchStartSha === 'string' ? value.defaultBranchStartSha.trim() : '',
    defaultBranchEndSha: typeof value.defaultBranchEndSha === 'string' ? value.defaultBranchEndSha.trim() : '',
    files,
    workflowMetadata: workflowMetadataProvided
      ? value.workflowMetadata.map(normalizeWorkflowMetadata).filter((entry) => entry.path)
      : [],
    workflowMetadataProvided,
    apiErrors: Array.isArray(value.apiErrors) ? value.apiErrors : [],
    paginationIncomplete: value.paginationIncomplete === true
  };
}

function normalizeWorkflowMetadata(value) {
  if (!isPlainObject(value)) {
    return { path: '', name: '', state: '' };
  }
  return {
    path: normalizeRepositoryPath(value.path),
    name: typeof value.name === 'string' ? value.name.trim() : '',
    state: typeof value.state === 'string' ? value.state.trim() : ''
  };
}

function normalizeFile(file) {
  if (!isPlainObject(file)) {
    return { status: 'missing', content: '' };
  }
  return {
    status: typeof file.status === 'string' ? file.status : 'ok',
    content: typeof file.content === 'string' ? file.content : '',
    sha: typeof file.sha === 'string' ? file.sha : '',
    size: Number.isFinite(file.size) ? file.size : 0
  };
}

function workflowSpecForPath(path) {
  return Object.values(LIVE_CONSUMER_WORKFLOW_SPECS).find((spec) => spec.path === path);
}

function workflowContractForPath(path, inventory) {
  const spec = workflowSpecForPath(path);
  if (!spec) {
    return null;
  }
  return {
    ...spec,
    allowedTriggers: inventoryTriggerContract(inventory, spec),
    allowedPermissions: inventoryPermissionContract(inventory, spec)
  };
}

function inventoryTriggerContract(inventory, spec) {
  const value = inventory.allowedTriggers[spec.capability];
  return Array.isArray(value) ? stableArray(value) : spec.allowedTriggers;
}

function inventoryPermissionContract(inventory, spec) {
  const value = inventory.allowedPermissions[spec.capability];
  return isPlainObject(value) ? stableObject(value) : spec.allowedPermissions;
}

function configCapabilityAllowed(name, desired) {
  const map = {
    routeReview: 'review-routing-plan',
    autoMerge: 'auto-merge-plan',
    mainFollowup: 'main-follow-up-plan'
  };
  return map[name] ? desired.has(map[name]) : false;
}

function fileStatusCode(status) {
  switch (status) {
    case 'binary':
      return 'binary_or_submodule_manual_review';
    case 'submodule':
      return 'binary_or_submodule_manual_review';
    case 'symlink':
      return 'binary_or_submodule_manual_review';
    case 'too_large':
      return 'response_size_limit_exceeded';
    default:
      return 'api_read_failed';
  }
}

function forbiddenJobCode(key) {
  switch (key) {
    case 'run':
      return 'inline_run_present';
    case 'steps':
      return 'workflow_steps_present';
    case 'runs-on':
      return 'runs_on_present';
    default:
      return 'unsafe_command_construction';
  }
}

function refCode(refType, kind, ref) {
  const prefix = kind === 'kit' ? 'kit' : 'external';
  if (ref === PLACEHOLDER_REF || refType === 'placeholder') {
    return 'unresolved_placeholder';
  }
  if (refType === 'short-sha') {
    return `${prefix}_short_ref`;
  }
  if (refType === 'version-tag' || refType === 'partial-version-tag') {
    return `${prefix}_version_tag`;
  }
  if (refType === 'mutable') {
    return kind === 'kit' ? 'mutable_kit_ref' : 'mutable_external_ref';
  }
  return `${prefix}_ref_invalid`;
}

function readPlannerPermissions() {
  return {
    contents: 'read',
    'pull-requests': 'read',
    issues: 'read',
    actions: 'read',
    checks: 'read',
    statuses: 'read'
  };
}

function parseYaml(source) {
  const document = YAML.parseDocument(source, { prettyErrors: false });
  if (document.errors.length > 0) {
    return { ok: false, value: null };
  }
  return { ok: true, value: document.toJS() };
}

function parseUses(value) {
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) {
    return { ok: false };
  }
  return {
    ok: true,
    target: value.slice(0, atIndex),
    ref: value.slice(atIndex + 1)
  };
}

function walk(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      walk(entry, visitor, [...path, String(index)]);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      walk(entry, visitor, [...path, key]);
    }
  }
}

function readDottedPath(value, path) {
  return path.split('.').reduce((current, key) => isPlainObject(current) ? current[key] : undefined, value);
}

function falseCapabilities() {
  return {
    autoRequest: false,
    routeReview: false,
    autoMerge: false,
    mainFollowup: false,
    actionsApproval: false
  };
}

function normalizeRepositoryName(value) {
  const repository = typeof value === 'string' ? value.trim() : '';
  return REPOSITORY_PATTERN.test(repository) ? repository : repository;
}

function isWorkflowPath(path) {
  return path.startsWith('.github/workflows/') && (path.endsWith('.yml') || path.endsWith('.yaml'));
}

function isSafeRepositoryPath(value) {
  const path = normalizeRepositoryPath(value);
  return path !== ''
    && path !== '.'
    && path !== '..'
    && !path.startsWith('../')
    && !path.includes('/../')
    && !/^[A-Za-z]:\//.test(path)
    && !path.includes('\0');
}

function normalizeRepositoryPath(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    const key = String(value).toLowerCase();
    if (seen.has(key)) {
      duplicates.add(String(value));
    }
    seen.add(key);
  }
  return [...duplicates].sort();
}

function stableArray(values) {
  return [...values].map(String).sort();
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

function compareIssues(left, right) {
  return `${left.code}:${left.file ?? ''}:${left.path ?? ''}`.localeCompare(`${right.code}:${right.file ?? ''}:${right.path ?? ''}`);
}

function addError(errors, checks, code, message, details = {}) {
  const entry = issue(code, message, details);
  errors.push(entry);
  addCheck(checks, code, message, 'fail', details);
}

function addCheck(checks, code, message, status, details = {}) {
  checks.push(issue(code, message, { ...details, status }));
}

function issue(code, message, details = {}) {
  return stableObject({
    code,
    message,
    ...(details.status ? { status: details.status } : {}),
    ...(details.file ? { file: details.file } : {}),
    ...(details.path ? { path: details.path } : {}),
    ...(details.value ? { value: details.value } : {})
  });
}

function formatLocation(entry) {
  const parts = [];
  if (entry.file) {
    parts.push(entry.file);
  }
  if (entry.path) {
    parts.push(entry.path);
  }
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

function joinPath(prefix, path) {
  return prefix ? `${prefix}.${path}` : path;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
