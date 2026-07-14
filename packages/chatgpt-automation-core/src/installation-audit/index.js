import { readFile as defaultReadFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { validateAutomationConfig } from '../config/index.js';

export const DEFAULT_AUDIT_CONFIG_FILE = '.github/chatgpt-automation.yml';
export const DEFAULT_AUDIT_WORKFLOW_FILE = '.github/workflows/validate-config.yml';
export const DEFAULT_MAIN_FOLLOW_UP_AUDIT_WORKFLOW_FILE = '.github/workflows/main-follow-up-events.yml';
export const AUDIT_WORKFLOW_KINDS = Object.freeze(['validate-config', 'main-follow-up']);

const REPOSITORY = Object.freeze({
  owner: 'nozomu-honda',
  repository: 'codex-workflow-kit'
});

const FALSE_CAPABILITIES = Object.freeze({
  autoRequest: false,
  routeReview: false,
  autoMerge: false,
  mainFollowup: false,
  actionsApproval: false
});

const WORKFLOW_SPECS = Object.freeze({
  'validate-config': Object.freeze({
    allowedJobKeys: ['name', 'permissions', 'uses', 'with'],
    allowedRootKeys: ['name', 'on', 'permissions', 'jobs'],
    allowedWithKeys: ['config-file', 'dry-run'],
    defaultWorkflowFile: DEFAULT_AUDIT_WORKFLOW_FILE,
    expectedPermissions: { contents: 'read' },
    expectedReusableWorkflow: {
      ...REPOSITORY,
      path: '.github/workflows/validate-config.yml'
    },
    jobName: 'validate-config',
    kind: 'validate-config'
  }),
  'main-follow-up': Object.freeze({
    allowedJobKeys: ['permissions', 'uses', 'with'],
    allowedRootKeys: ['name', 'on', 'permissions', 'jobs'],
    allowedWithKeys: [
      'actor',
      'attempt-counts-json',
      'default-branch',
      'dry-run',
      'event-action',
      'event-name',
      'event-payload-json',
      'existing-dedupe-keys',
      'kit-ref',
      'last-attempted-at-json',
      'ref-name',
      'repository',
      'repository-config-json',
      'repository-owner',
      'sha'
    ],
    defaultWorkflowFile: DEFAULT_MAIN_FOLLOW_UP_AUDIT_WORKFLOW_FILE,
    expectedPermissions: {
      contents: 'read',
      'pull-requests': 'read',
      issues: 'read',
      actions: 'read',
      checks: 'read',
      statuses: 'read'
    },
    expectedReusableWorkflow: {
      ...REPOSITORY,
      path: '.github/workflows/main-follow-up-plan.yml'
    },
    jobName: 'main-follow-up-plan',
    kind: 'main-follow-up'
  })
});
const SHA40_PATTERN = /^[a-f0-9]{40}$/i;
const SHORT_SHA_PATTERN = /^[a-f0-9]{7,39}$/i;
const PLACEHOLDER_REF = 'REPLACE_WITH_40_CHAR_COMMIT_SHA';
const INITIAL_DISABLED_CONFIG_PATHS = Object.freeze([
  'features.autoRequest',
  'features.routeReview',
  'features.autoMerge',
  'features.mainFollowup',
  'features.actionsApproval',
  'queues.reviewFix.enabled',
  'queues.mainFollowup.enabled',
  'codex.reviewFix.enabled',
  'codex.mainFollowup.enabled',
  'schedules.reviewRequest.enabled',
  'schedules.autoMerge.enabled',
  'schedules.mainFollowup.enabled',
  'schedules.actionsApproval.enabled'
]);

export async function auditConsumerInstallation(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const readFile = options.readFile ?? defaultReadFile;
  const strict = options.strict === true;
  const errors = [];
  const warnings = [];
  const checks = [];
  const workflowSpec = getWorkflowSpec(options.workflowKind);
  const configPath = resolveRepositoryPath(rootDir, options.configPath ?? DEFAULT_AUDIT_CONFIG_FILE);
  const workflowPath = resolveRepositoryPath(rootDir, options.workflowPath ?? workflowSpec.spec.defaultWorkflowFile);
  const files = {
    config: configPath.relativePath,
    workflow: workflowPath.relativePath
  };
  let capabilities = { ...FALSE_CAPABILITIES };

  if (!workflowSpec.ok) {
    addError(errors, checks, 'WORKFLOW_KIND_INVALID', 'Workflow kind must be validate-config or main-follow-up.', {
      path: 'workflowKind'
    });
  }

  if (!configPath.ok) {
    addError(errors, checks, 'CONFIG_PATH_INVALID', 'Config path must stay inside the repository root.', {
      file: files.config
    });
  } else {
    const configAudit = await auditConfig({
      readFile,
      configPath,
      checks
    });
    errors.push(...configAudit.errors);
    warnings.push(...configAudit.warnings);
    capabilities = configAudit.capabilities;
  }

  if (!workflowPath.ok) {
    addError(errors, checks, 'WORKFLOW_PATH_INVALID', 'Workflow path must stay inside the repository root.', {
      file: files.workflow
    });
  } else {
    const workflowAudit = await auditWorkflow({
      readFile,
      workflowPath,
      expectedConfigPath: configPath.relativePath,
      expectedRef: options.expectedRef,
      workflowSpec,
      checks
    });
    errors.push(...workflowAudit.errors);
    warnings.push(...workflowAudit.warnings);
  }

  if (options.expectedRef !== undefined && !SHA40_PATTERN.test(String(options.expectedRef))) {
    addError(errors, checks, 'EXPECTED_REF_INVALID', 'Expected ref must be a 40-character commit SHA.');
  }

  if (strict && warnings.length > 0) {
    addError(errors, checks, 'STRICT_WARNINGS_FOUND', 'Strict mode treats warnings as audit failures.');
  }

  const ok = errors.length === 0;

  return {
    ok,
    errors,
    warnings,
    checks,
    capabilities: ok ? capabilities : { ...FALSE_CAPABILITIES },
    files
  };
}

export function formatAuditResult(result) {
  const lines = [];

  lines.push(`ChatGPT automation installation audit: ${result.ok ? 'OK' : 'FAILED'}`);
  lines.push(`config: ${result.files.config}`);
  lines.push(`workflow: ${result.files.workflow}`);
  lines.push('capabilities:');

  for (const [name, enabled] of Object.entries(result.capabilities)) {
    lines.push(`- ${name}: ${enabled}`);
  }

  lines.push(`checks: ${result.checks.length}`);
  for (const check of result.checks) {
    lines.push(`- [${check.status}] ${check.code}: ${check.message}${check.file ? ` (${check.file})` : ''}`);
  }

  if (result.warnings.length > 0) {
    lines.push(`warnings: ${result.warnings.length}`);
    for (const warning of result.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}${formatIssueLocation(warning)}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push(`errors: ${result.errors.length}`);
    for (const error of result.errors) {
      lines.push(`- ${error.code}: ${error.message}${formatIssueLocation(error)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function auditConfig({ readFile, configPath, checks }) {
  const errors = [];
  const warnings = [];

  addCheck(checks, 'CONFIG_PATH_RESOLVED', 'Config path stays inside the repository root.', 'pass', {
    file: configPath.relativePath
  });

  let source;
  try {
    source = await readFile(configPath.absolutePath, 'utf8');
    addCheck(checks, 'CONFIG_READ', 'Config file was read.', 'pass', {
      file: configPath.relativePath
    });
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'CONFIG_MISSING' : 'CONFIG_READ_FAILED';
    const message = error?.code === 'ENOENT'
      ? 'Config file is missing.'
      : 'Config file could not be read.';
    addError(errors, checks, code, message, {
      file: configPath.relativePath
    });
    return {
      errors,
      warnings,
      capabilities: { ...FALSE_CAPABILITIES }
    };
  }

  const validation = validateAutomationConfig(source);

  for (const warning of validation.warnings) {
    addError(errors, checks, warning.code, warning.message, {
      file: configPath.relativePath,
      path: warning.path
    });
  }

  if (!validation.ok) {
    for (const error of validation.errors) {
      addError(errors, checks, error.code, error.message, {
        file: configPath.relativePath,
        path: error.path
      });
    }
    return {
      errors,
      warnings,
      capabilities: { ...FALSE_CAPABILITIES }
    };
  }

  addCheck(checks, 'CONFIG_VALID', 'Config passed the shared fail-closed validator.', 'pass', {
    file: configPath.relativePath
  });

  if (validation.config.dryRunDefault !== true) {
    addError(errors, checks, 'CONFIG_DRY_RUN_DEFAULT_FALSE', 'dryRunDefault must remain true for initial consumer installation.', {
      file: configPath.relativePath,
      path: 'dryRunDefault'
    });
  } else {
    addCheck(checks, 'CONFIG_DRY_RUN_DEFAULT_TRUE', 'dryRunDefault is true.', 'pass', {
      file: configPath.relativePath
    });
  }

  for (const pathName of INITIAL_DISABLED_CONFIG_PATHS) {
    const enabled = readDottedPath(validation.config, pathName);

    if (enabled) {
      addError(errors, checks, 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN', 'Initial consumer installation audit requires every automation capability to stay disabled.', {
        file: configPath.relativePath,
        path: pathName
      });
    } else {
      addCheck(checks, `CONFIG_${toCodeFragment(pathName)}_DISABLED`, `Config ${pathName} is disabled.`, 'pass', {
        file: configPath.relativePath
      });
    }
  }

  return {
    errors,
    warnings,
    capabilities: { ...validation.capabilities }
  };
}

async function auditWorkflow({ readFile, workflowPath, expectedConfigPath, expectedRef, workflowSpec, checks }) {
  const errors = [];
  const warnings = [];
  const spec = workflowSpec.spec;

  addCheck(checks, 'WORKFLOW_PATH_RESOLVED', 'Workflow path stays inside the repository root.', 'pass', {
    file: workflowPath.relativePath
  });

  let source;
  try {
    source = await readFile(workflowPath.absolutePath, 'utf8');
    addCheck(checks, 'WORKFLOW_READ', 'Workflow file was read.', 'pass', {
      file: workflowPath.relativePath
    });
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'WORKFLOW_MISSING' : 'WORKFLOW_READ_FAILED';
    const message = error?.code === 'ENOENT'
      ? 'Workflow file is missing.'
      : 'Workflow file could not be read.';
    addError(errors, checks, code, message, {
      file: workflowPath.relativePath
    });
    return { errors, warnings };
  }

  const parsed = parseWorkflowYaml(source);
  if (!parsed.ok) {
    addError(errors, checks, 'WORKFLOW_YAML_PARSE_ERROR', 'Workflow YAML could not be parsed.', {
      file: workflowPath.relativePath
    });
    return { errors, warnings };
  }

  addCheck(checks, 'WORKFLOW_YAML_VALID', 'Workflow YAML was parsed.', 'pass', {
    file: workflowPath.relativePath
  });

  const workflow = parsed.value;
  if (!isPlainObject(workflow)) {
    addError(errors, checks, 'WORKFLOW_ROOT_OBJECT_REQUIRED', 'Workflow root must be an object.', {
      file: workflowPath.relativePath
    });
    return { errors, warnings };
  }

  for (const key of Object.keys(workflow)) {
    if (!spec.allowedRootKeys.includes(key)) {
      addError(errors, checks, rootKeyCode(key), 'Workflow contains an unexpected top-level key.', {
        file: workflowPath.relativePath,
        path: key
      });
    }
  }

  validateWorkflowTriggers(workflow.on, spec, errors, checks, workflowPath.relativePath);
  validateExactReadPermissions(workflow.permissions, spec.expectedPermissions, 'WORKFLOW_PERMISSIONS_INVALID', 'Workflow permissions must match the expected read-only set.', errors, checks, workflowPath.relativePath, 'permissions');
  validateJobs(workflow.jobs, {
    errors,
    checks,
    workflowFile: workflowPath.relativePath,
    expectedConfigPath,
    expectedRef,
    spec
  });

  return { errors, warnings };
}

function validateWorkflowTriggers(onValue, spec, errors, checks, workflowFile) {
  if (!isPlainObject(onValue)) {
    addError(errors, checks, 'WORKFLOW_TRIGGER_INVALID', 'Workflow must define its expected triggers as an object.', {
      file: workflowFile,
      path: 'on'
    });
    return;
  }

  const triggers = Object.keys(onValue);

  if (triggers.length === 0) {
    addError(errors, checks, 'WORKFLOW_TRIGGER_INVALID', 'Workflow must define workflow_dispatch as its only trigger.', {
      file: workflowFile,
      path: 'on'
    });
    return;
  }

  if (spec.kind === 'main-follow-up') {
    validateMainFollowUpTriggers(onValue, errors, checks, workflowFile);
    return;
  }

  if (triggers.length === 1 && triggers[0] === 'workflow_dispatch') {
    const dispatch = onValue.workflow_dispatch;
    if (dispatch !== null && dispatch !== undefined && (!isPlainObject(dispatch) || Object.keys(dispatch).length > 0)) {
      addError(errors, checks, 'WORKFLOW_DISPATCH_INPUTS_UNEXPECTED', 'workflow_dispatch must not define inputs for this caller workflow.', {
        file: workflowFile,
        path: 'on.workflow_dispatch'
      });
    } else {
      addCheck(checks, 'WORKFLOW_DISPATCH_ONLY', 'Workflow trigger is workflow_dispatch only.', 'pass', {
        file: workflowFile
      });
    }
    return;
  }

  for (const trigger of triggers) {
    const code = trigger === 'pull_request_target'
      ? 'PULL_REQUEST_TARGET_FORBIDDEN'
      : 'WORKFLOW_TRIGGER_UNEXPECTED';
    addError(errors, checks, code, 'Workflow must not define PR, push, schedule, workflow_run, or other triggers.', {
      file: workflowFile,
      path: `on.${trigger}`
    });
  }
}

function validateMainFollowUpTriggers(onValue, errors, checks, workflowFile) {
  const triggers = Object.keys(onValue);
  const expected = ['pull_request', 'push', 'workflow_dispatch'];

  for (const trigger of triggers) {
    if (!expected.includes(trigger)) {
      const code = trigger === 'pull_request_target'
        ? 'PULL_REQUEST_TARGET_FORBIDDEN'
        : 'WORKFLOW_TRIGGER_UNEXPECTED';
      addError(errors, checks, code, 'Main follow-up caller must not define unexpected triggers.', {
        file: workflowFile,
        path: `on.${trigger}`
      });
    }
  }

  for (const trigger of expected) {
    if (!triggers.includes(trigger)) {
      addError(errors, checks, 'WORKFLOW_TRIGGER_INVALID', 'Main follow-up caller must define push, pull_request.closed, and workflow_dispatch triggers.', {
        file: workflowFile,
        path: `on.${trigger}`
      });
    }
  }

  const pullRequest = onValue.pull_request;
  if (!isPlainObject(pullRequest) || !Array.isArray(pullRequest.types) || pullRequest.types.length !== 1 || pullRequest.types[0] !== 'closed') {
    addError(errors, checks, 'WORKFLOW_TRIGGER_UNEXPECTED', 'Main follow-up caller must only use pull_request.closed.', {
      file: workflowFile,
      path: 'on.pull_request.types'
    });
  }

  if (onValue.push !== null && onValue.push !== undefined && (!isPlainObject(onValue.push) || Object.keys(onValue.push).length > 0)) {
    addError(errors, checks, 'WORKFLOW_TRIGGER_UNEXPECTED', 'Main follow-up push trigger must not hardcode branches; the planner filters the default branch.', {
      file: workflowFile,
      path: 'on.push'
    });
  }

  const dispatch = onValue.workflow_dispatch;
  const inputs = isPlainObject(dispatch) ? dispatch.inputs : undefined;
  if (dispatch !== null && dispatch !== undefined && !isPlainObject(dispatch)) {
    addError(errors, checks, 'WORKFLOW_TRIGGER_INVALID', 'workflow_dispatch must be an object or empty value.', {
      file: workflowFile,
      path: 'on.workflow_dispatch'
    });
  } else if (inputs !== undefined) {
    const inputKeys = isPlainObject(inputs) ? Object.keys(inputs) : [];
    const baseBranch = inputs?.base_branch;
    const validBaseBranch = isPlainObject(baseBranch)
      && baseBranch.type === 'string'
      && (baseBranch.required === false || baseBranch.required === undefined);

    if (inputKeys.length !== 1 || inputKeys[0] !== 'base_branch' || !validBaseBranch) {
      addError(errors, checks, 'WORKFLOW_DISPATCH_INPUTS_UNEXPECTED', 'workflow_dispatch may only define optional base_branch string input.', {
        file: workflowFile,
        path: 'on.workflow_dispatch.inputs'
      });
    }
  }

  if (errors.length === 0 || !errors.some((error) => error.file === workflowFile && String(error.path ?? '').startsWith('on'))) {
    addCheck(checks, 'MAIN_FOLLOW_UP_TRIGGERS_OK', 'Main follow-up caller triggers are limited to push, pull_request.closed, and workflow_dispatch.', 'pass', {
      file: workflowFile
    });
  }
}

function validateJobs(jobs, context) {
  const { errors, checks, workflowFile, expectedConfigPath, expectedRef, spec } = context;

  if (!isPlainObject(jobs)) {
    addError(errors, checks, 'JOBS_OBJECT_REQUIRED', 'Workflow jobs must be an object.', {
      file: workflowFile,
      path: 'jobs'
    });
    return;
  }

  const jobKeys = Object.keys(jobs);
  if (jobKeys.length !== 1 || jobKeys[0] !== spec.jobName) {
    addError(errors, checks, 'UNEXPECTED_JOB', `Workflow must define exactly one ${spec.jobName} job.`, {
      file: workflowFile,
      path: 'jobs'
    });
    return;
  }

  const job = jobs[spec.jobName];
  if (!isPlainObject(job)) {
    addError(errors, checks, 'JOB_OBJECT_REQUIRED', `${spec.jobName} job must be an object.`, {
      file: workflowFile,
      path: `jobs.${spec.jobName}`
    });
    return;
  }

  for (const key of Object.keys(job)) {
    if (!spec.allowedJobKeys.includes(key)) {
      addError(errors, checks, jobKeyCode(key, job[key]), `${spec.jobName} job contains an unexpected key.`, {
        file: workflowFile,
        path: `jobs.${spec.jobName}.${key}`
      });
    }
  }

  validateExactReadPermissions(job.permissions, spec.expectedPermissions, 'JOB_PERMISSIONS_INVALID', 'Job permissions must match the expected read-only set.', errors, checks, workflowFile, `jobs.${spec.jobName}.permissions`);
  validateReusableWorkflowUses(job.uses, expectedRef, errors, checks, workflowFile, spec);
  validateWorkflowInputs(job.with, expectedConfigPath, expectedRef, errors, checks, workflowFile, spec);
}

function validateReusableWorkflowUses(value, expectedRef, errors, checks, workflowFile, spec) {
  if (typeof value !== 'string') {
    addError(errors, checks, 'REUSABLE_WORKFLOW_USES_REQUIRED', `${spec.jobName} job must call the reusable workflow with job-level uses.`, {
      file: workflowFile,
      path: `jobs.${spec.jobName}.uses`
    });
    return;
  }

  const parsed = parseUses(value);
  if (!parsed.ok) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_USES_INVALID', 'Reusable workflow uses value must include owner, repository, path, and ref.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.uses`
    });
    return;
  }

  if (parsed.owner !== spec.expectedReusableWorkflow.owner || parsed.repository !== spec.expectedReusableWorkflow.repository) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REPOSITORY_MISMATCH', 'Reusable workflow repository must match the expected shared repository.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.uses`
    });
  } else {
    addCheck(checks, 'REUSABLE_WORKFLOW_REPOSITORY_OK', 'Reusable workflow repository matches.', 'pass', {
      file: workflowFile
    });
  }

  if (parsed.workflowPath !== spec.expectedReusableWorkflow.path) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_PATH_MISMATCH', 'Reusable workflow path must match the expected reusable workflow.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.uses`
    });
  } else {
    addCheck(checks, 'REUSABLE_WORKFLOW_PATH_OK', 'Reusable workflow path matches.', 'pass', {
      file: workflowFile
    });
  }

  validateReusableWorkflowRef(parsed.ref, expectedRef, errors, checks, workflowFile, spec);
}

function validateReusableWorkflowRef(ref, expectedRef, errors, checks, workflowFile, spec) {
  if (ref === PLACEHOLDER_REF) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REF_PLACEHOLDER', 'Reusable workflow ref placeholder must be replaced before production use.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.uses`
    });
    return;
  }

  if (!SHA40_PATTERN.test(ref)) {
    const code = SHORT_SHA_PATTERN.test(ref)
      ? 'REUSABLE_WORKFLOW_REF_SHORT_SHA'
      : /^v\d+(\.\d+){0,2}$/.test(ref)
        ? 'REUSABLE_WORKFLOW_REF_TAG'
        : 'REUSABLE_WORKFLOW_REF_MUTABLE';
    addError(errors, checks, code, 'Reusable workflow ref must be a 40-character commit SHA.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.uses`
    });
    return;
  }

  if (expectedRef !== undefined && ref.toLowerCase() !== String(expectedRef).toLowerCase()) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REF_MISMATCH', 'Reusable workflow ref does not match the expected commit SHA.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.uses`
    });
    return;
  }

  addCheck(checks, 'REUSABLE_WORKFLOW_REF_PINNED', 'Reusable workflow ref is pinned to a 40-character commit SHA.', 'pass', {
    file: workflowFile
  });
}

function validateWorkflowInputs(withValue, expectedConfigPath, expectedRef, errors, checks, workflowFile, spec) {
  if (!isPlainObject(withValue)) {
    addError(errors, checks, 'WORKFLOW_WITH_REQUIRED', `${spec.jobName} job must pass the expected dry-run inputs.`, {
      file: workflowFile,
      path: `jobs.${spec.jobName}.with`
    });
    return;
  }

  for (const key of Object.keys(withValue)) {
    if (!spec.allowedWithKeys.includes(key)) {
      addError(errors, checks, 'WORKFLOW_INPUT_UNEXPECTED', `${spec.jobName} job contains an unexpected input.`, {
        file: workflowFile,
        path: `jobs.${spec.jobName}.with.${key}`
      });
    }
  }

  if (spec.kind === 'main-follow-up') {
    validateMainFollowUpInputs(withValue, expectedRef, errors, checks, workflowFile, spec);
    return;
  }

  if (normalizeRepositoryPath(withValue['config-file']) !== expectedConfigPath) {
    addError(errors, checks, 'WORKFLOW_CONFIG_FILE_MISMATCH', 'Workflow config-file input must match the audited config path.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.with.config-file`
    });
  } else {
    addCheck(checks, 'WORKFLOW_CONFIG_FILE_OK', 'Workflow config-file input matches the audited config path.', 'pass', {
      file: workflowFile
    });
  }

  if (withValue['dry-run'] !== true) {
    addError(errors, checks, 'WORKFLOW_DRY_RUN_NOT_TRUE', 'Workflow dry-run input must be boolean true.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.with.dry-run`
    });
  } else {
    addCheck(checks, 'WORKFLOW_DRY_RUN_TRUE', 'Workflow dry-run input is true.', 'pass', {
      file: workflowFile
    });
  }
}

function validateMainFollowUpInputs(withValue, expectedRef, errors, checks, workflowFile, spec) {
  const expectedInputs = {
    'event-name': '${{ github.event_name }}',
    'event-action': "${{ github.event.action || '' }}",
    'event-payload-json': '${{ toJson(github.event) }}',
    repository: '${{ github.repository }}',
    'repository-owner': '${{ github.repository_owner }}',
    'default-branch': '${{ github.event.repository.default_branch }}',
    actor: '${{ github.actor }}',
    'ref-name': '${{ github.ref_name }}',
    sha: '${{ github.sha }}',
    'repository-config-json': "${{ vars.CHATGPT_AUTOMATION_MAIN_FOLLOW_UP_CONFIG_JSON || '{}' }}",
    'existing-dedupe-keys': "${{ vars.CHATGPT_AUTOMATION_MAIN_FOLLOW_UP_DEDUPE_KEYS || '' }}",
    'attempt-counts-json': "${{ vars.CHATGPT_AUTOMATION_MAIN_FOLLOW_UP_ATTEMPT_COUNTS_JSON || '{}' }}",
    'last-attempted-at-json': "${{ vars.CHATGPT_AUTOMATION_MAIN_FOLLOW_UP_LAST_ATTEMPTED_AT_JSON || '{}' }}"
  };

  for (const [name, expected] of Object.entries(expectedInputs)) {
    if (withValue[name] !== expected) {
      addError(errors, checks, 'WORKFLOW_INPUT_UNEXPECTED', 'Main follow-up caller input must match the read-only template contract.', {
        file: workflowFile,
        path: `jobs.${spec.jobName}.with.${name}`
      });
    }
  }

  if (withValue['dry-run'] !== true) {
    addError(errors, checks, 'WORKFLOW_DRY_RUN_NOT_TRUE', 'Workflow dry-run input must be boolean true.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.with.dry-run`
    });
  } else {
    addCheck(checks, 'WORKFLOW_DRY_RUN_TRUE', 'Workflow dry-run input is true.', 'pass', {
      file: workflowFile
    });
  }

  const kitRef = typeof withValue['kit-ref'] === 'string' ? withValue['kit-ref'] : '';
  if (kitRef === PLACEHOLDER_REF) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REF_PLACEHOLDER', 'kit-ref placeholder must be replaced before production use.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.with.kit-ref`
    });
  } else if (!SHA40_PATTERN.test(kitRef)) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REF_MUTABLE', 'kit-ref must be a 40-character commit SHA.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.with.kit-ref`
    });
  } else if (expectedRef !== undefined && kitRef.toLowerCase() !== String(expectedRef).toLowerCase()) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REF_MISMATCH', 'kit-ref does not match the expected commit SHA.', {
      file: workflowFile,
      path: `jobs.${spec.jobName}.with.kit-ref`
    });
  } else {
    addCheck(checks, 'WORKFLOW_KIT_REF_PINNED', 'kit-ref is pinned to a 40-character commit SHA.', 'pass', {
      file: workflowFile
    });
  }
}

function validateExactReadPermissions(permissions, expectedPermissions, code, message, errors, checks, workflowFile, path) {
  if (sameObject(permissions, expectedPermissions)) {
    addCheck(checks, code.replace('_INVALID', '_OK'), message.replace('must be exactly', 'are exactly'), 'pass', {
      file: workflowFile
    });
    return;
  }

  addError(errors, checks, code, message, {
    file: workflowFile,
    path
  });
}

function getWorkflowSpec(kind) {
  const normalized = typeof kind === 'string' && kind.trim() !== ''
    ? kind.trim()
    : 'validate-config';
  const spec = WORKFLOW_SPECS[normalized];

  if (!spec) {
    return {
      ok: false,
      spec: WORKFLOW_SPECS['validate-config']
    };
  }

  return {
    ok: true,
    spec
  };
}

function sameObject(actual, expected) {
  if (!isPlainObject(actual)) {
    return false;
  }

  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();

  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function parseWorkflowYaml(source) {
  const document = YAML.parseDocument(source, { prettyErrors: false });

  if (document.errors.length > 0) {
    return {
      ok: false,
      value: null
    };
  }

  return {
    ok: true,
    value: document.toJS()
  };
}

function parseUses(value) {
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) {
    return { ok: false };
  }

  const target = value.slice(0, atIndex);
  const ref = value.slice(atIndex + 1);
  const parts = target.split('/');

  if (parts.length < 3) {
    return { ok: false };
  }

  return {
    ok: true,
    owner: parts[0],
    repository: parts[1],
    workflowPath: parts.slice(2).join('/'),
    ref
  };
}

function resolveRepositoryPath(rootDir, value) {
  const rawPath = typeof value === 'string' && value.trim() !== '' ? value : '';
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootDir, rawPath);
  const relativePath = normalizeRepositoryPath(relative(rootDir, absolutePath));
  const ok = relativePath !== ''
    && relativePath !== '.'
    && !relativePath.startsWith('../')
    && relativePath !== '..';

  return {
    ok,
    absolutePath,
    relativePath: ok ? relativePath : '[outside-repository]'
  };
}

function normalizeRepositoryPath(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function readDottedPath(value, path) {
  return path
    .split('.')
    .reduce((current, key) => isPlainObject(current) ? current[key] : undefined, value);
}

function toCodeFragment(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
}

function rootKeyCode(key) {
  if (key === 'outputs') {
    return 'WORKFLOW_OUTPUT_UNEXPECTED';
  }
  return 'WORKFLOW_ROOT_KEY_UNEXPECTED';
}

function jobKeyCode(key, value) {
  if (key === 'secrets') {
    return value === 'inherit'
      ? 'WORKFLOW_SECRETS_INHERIT_FORBIDDEN'
      : 'WORKFLOW_SECRETS_FORBIDDEN';
  }
  if (key === 'runs-on') {
    return 'WORKFLOW_RUNS_ON_FORBIDDEN';
  }
  if (key === 'steps') {
    return 'WORKFLOW_STEPS_FORBIDDEN';
  }
  if (key === 'run') {
    return 'WORKFLOW_INLINE_RUN_FORBIDDEN';
  }
  if (key === 'shell') {
    return 'WORKFLOW_SHELL_FORBIDDEN';
  }
  if (key === 'outputs') {
    return 'WORKFLOW_OUTPUT_UNEXPECTED';
  }
  return 'WORKFLOW_JOB_KEY_UNEXPECTED';
}

function addError(errors, checks, code, message, details = {}) {
  const entry = issue(code, message, details);
  errors.push(entry);
  addCheck(checks, code, message, 'fail', details);
}

function addWarning(warnings, checks, code, message, details = {}) {
  const entry = issue(code, message, details);
  warnings.push(entry);
  addCheck(checks, code, message, 'warning', details);
}

function addCheck(checks, code, message, status, details = {}) {
  checks.push({
    code,
    message,
    status,
    ...(details.file ? { file: details.file } : {}),
    ...(details.path ? { path: details.path } : {})
  });
}

function issue(code, message, details = {}) {
  return {
    code,
    message,
    ...(details.file ? { file: details.file } : {}),
    ...(details.path ? { path: details.path } : {})
  };
}

function formatIssueLocation(issueEntry) {
  const parts = [];
  if (issueEntry.file) {
    parts.push(issueEntry.file);
  }
  if (issueEntry.path) {
    parts.push(issueEntry.path);
  }
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
