import { readFile as defaultReadFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { validateAutomationConfig } from '../config/index.js';

export const DEFAULT_AUDIT_CONFIG_FILE = '.github/chatgpt-automation.yml';
export const DEFAULT_AUDIT_WORKFLOW_FILE = '.github/workflows/validate-config.yml';
export const EXPECTED_REUSABLE_WORKFLOW = Object.freeze({
  owner: 'nozomu-honda',
  repository: 'codex-workflow-kit',
  path: '.github/workflows/validate-config.yml'
});

const FALSE_CAPABILITIES = Object.freeze({
  autoRequest: false,
  routeReview: false,
  autoMerge: false,
  mainFollowup: false,
  actionsApproval: false
});

const ALLOWED_ROOT_KEYS = ['name', 'on', 'permissions', 'jobs'];
const ALLOWED_JOB_KEYS = ['name', 'permissions', 'uses', 'with'];
const ALLOWED_WITH_KEYS = ['config-file', 'dry-run'];
const REQUIRED_JOB_NAME = 'validate-config';
const SHA40_PATTERN = /^[a-f0-9]{40}$/i;
const SHORT_SHA_PATTERN = /^[a-f0-9]{7,39}$/i;
const PLACEHOLDER_REF = 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA';

export async function auditConsumerInstallation(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const readFile = options.readFile ?? defaultReadFile;
  const strict = options.strict === true;
  const errors = [];
  const warnings = [];
  const checks = [];
  const configPath = resolveRepositoryPath(rootDir, options.configPath ?? DEFAULT_AUDIT_CONFIG_FILE);
  const workflowPath = resolveRepositoryPath(rootDir, options.workflowPath ?? DEFAULT_AUDIT_WORKFLOW_FILE);
  const files = {
    config: configPath.relativePath,
    workflow: workflowPath.relativePath
  };
  let capabilities = { ...FALSE_CAPABILITIES };

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

  for (const [name, enabled] of Object.entries(validation.capabilities)) {
    if (enabled) {
      addError(errors, checks, 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN', 'Initial consumer installation audit requires every capability to stay disabled.', {
        file: configPath.relativePath,
        path: `features.${name}`
      });
    } else {
      addCheck(checks, `CAPABILITY_${name}`, `Capability ${name} is disabled.`, 'pass', {
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

async function auditWorkflow({ readFile, workflowPath, expectedConfigPath, expectedRef, checks }) {
  const errors = [];
  const warnings = [];

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
    if (!ALLOWED_ROOT_KEYS.includes(key)) {
      addError(errors, checks, rootKeyCode(key), 'Workflow contains an unexpected top-level key.', {
        file: workflowPath.relativePath,
        path: key
      });
    }
  }

  validateWorkflowTriggers(workflow.on, errors, checks, workflowPath.relativePath);
  validateExactReadPermissions(workflow.permissions, 'WORKFLOW_PERMISSIONS_INVALID', 'Workflow permissions must be exactly contents: read.', errors, checks, workflowPath.relativePath, 'permissions');
  validateJobs(workflow.jobs, {
    errors,
    checks,
    workflowFile: workflowPath.relativePath,
    expectedConfigPath,
    expectedRef
  });

  return { errors, warnings };
}

function validateWorkflowTriggers(onValue, errors, checks, workflowFile) {
  if (!isPlainObject(onValue)) {
    addError(errors, checks, 'WORKFLOW_TRIGGER_INVALID', 'Workflow must define only workflow_dispatch as an object trigger.', {
      file: workflowFile,
      path: 'on'
    });
    return;
  }

  const triggers = Object.keys(onValue);

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

function validateJobs(jobs, context) {
  const { errors, checks, workflowFile, expectedConfigPath, expectedRef } = context;

  if (!isPlainObject(jobs)) {
    addError(errors, checks, 'JOBS_OBJECT_REQUIRED', 'Workflow jobs must be an object.', {
      file: workflowFile,
      path: 'jobs'
    });
    return;
  }

  const jobKeys = Object.keys(jobs);
  if (jobKeys.length !== 1 || jobKeys[0] !== REQUIRED_JOB_NAME) {
    addError(errors, checks, 'UNEXPECTED_JOB', 'Workflow must define exactly one validate-config job.', {
      file: workflowFile,
      path: 'jobs'
    });
    return;
  }

  const job = jobs[REQUIRED_JOB_NAME];
  if (!isPlainObject(job)) {
    addError(errors, checks, 'JOB_OBJECT_REQUIRED', 'validate-config job must be an object.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}`
    });
    return;
  }

  for (const key of Object.keys(job)) {
    if (!ALLOWED_JOB_KEYS.includes(key)) {
      addError(errors, checks, jobKeyCode(key, job[key]), 'validate-config job contains an unexpected key.', {
        file: workflowFile,
        path: `jobs.${REQUIRED_JOB_NAME}.${key}`
      });
    }
  }

  validateExactReadPermissions(job.permissions, 'JOB_PERMISSIONS_INVALID', 'Job permissions must be exactly contents: read.', errors, checks, workflowFile, `jobs.${REQUIRED_JOB_NAME}.permissions`);
  validateReusableWorkflowUses(job.uses, expectedRef, errors, checks, workflowFile);
  validateWorkflowInputs(job.with, expectedConfigPath, errors, checks, workflowFile);
}

function validateReusableWorkflowUses(value, expectedRef, errors, checks, workflowFile) {
  if (typeof value !== 'string') {
    addError(errors, checks, 'REUSABLE_WORKFLOW_USES_REQUIRED', 'validate-config job must call the reusable workflow with job-level uses.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.uses`
    });
    return;
  }

  const parsed = parseUses(value);
  if (!parsed.ok) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_USES_INVALID', 'Reusable workflow uses value must include owner, repository, path, and ref.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.uses`
    });
    return;
  }

  if (parsed.owner !== EXPECTED_REUSABLE_WORKFLOW.owner || parsed.repository !== EXPECTED_REUSABLE_WORKFLOW.repository) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REPOSITORY_MISMATCH', 'Reusable workflow repository must match the expected shared repository.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.uses`
    });
  } else {
    addCheck(checks, 'REUSABLE_WORKFLOW_REPOSITORY_OK', 'Reusable workflow repository matches.', 'pass', {
      file: workflowFile
    });
  }

  if (parsed.workflowPath !== EXPECTED_REUSABLE_WORKFLOW.path) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_PATH_MISMATCH', 'Reusable workflow path must match the validate-config reusable workflow.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.uses`
    });
  } else {
    addCheck(checks, 'REUSABLE_WORKFLOW_PATH_OK', 'Reusable workflow path matches.', 'pass', {
      file: workflowFile
    });
  }

  validateReusableWorkflowRef(parsed.ref, expectedRef, errors, checks, workflowFile);
}

function validateReusableWorkflowRef(ref, expectedRef, errors, checks, workflowFile) {
  if (ref === PLACEHOLDER_REF) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REF_PLACEHOLDER', 'Reusable workflow ref placeholder must be replaced before production use.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.uses`
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
      path: `jobs.${REQUIRED_JOB_NAME}.uses`
    });
    return;
  }

  if (expectedRef !== undefined && ref.toLowerCase() !== String(expectedRef).toLowerCase()) {
    addError(errors, checks, 'REUSABLE_WORKFLOW_REF_MISMATCH', 'Reusable workflow ref does not match the expected commit SHA.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.uses`
    });
    return;
  }

  addCheck(checks, 'REUSABLE_WORKFLOW_REF_PINNED', 'Reusable workflow ref is pinned to a 40-character commit SHA.', 'pass', {
    file: workflowFile
  });
}

function validateWorkflowInputs(withValue, expectedConfigPath, errors, checks, workflowFile) {
  if (!isPlainObject(withValue)) {
    addError(errors, checks, 'WORKFLOW_WITH_REQUIRED', 'validate-config job must pass config-file and dry-run inputs.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.with`
    });
    return;
  }

  for (const key of Object.keys(withValue)) {
    if (!ALLOWED_WITH_KEYS.includes(key)) {
      addError(errors, checks, 'WORKFLOW_INPUT_UNEXPECTED', 'validate-config job contains an unexpected input.', {
        file: workflowFile,
        path: `jobs.${REQUIRED_JOB_NAME}.with.${key}`
      });
    }
  }

  if (normalizeRepositoryPath(withValue['config-file']) !== expectedConfigPath) {
    addError(errors, checks, 'WORKFLOW_CONFIG_FILE_MISMATCH', 'Workflow config-file input must match the audited config path.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.with.config-file`
    });
  } else {
    addCheck(checks, 'WORKFLOW_CONFIG_FILE_OK', 'Workflow config-file input matches the audited config path.', 'pass', {
      file: workflowFile
    });
  }

  if (withValue['dry-run'] !== true) {
    addError(errors, checks, 'WORKFLOW_DRY_RUN_NOT_TRUE', 'Workflow dry-run input must be boolean true.', {
      file: workflowFile,
      path: `jobs.${REQUIRED_JOB_NAME}.with.dry-run`
    });
  } else {
    addCheck(checks, 'WORKFLOW_DRY_RUN_TRUE', 'Workflow dry-run input is true.', 'pass', {
      file: workflowFile
    });
  }
}

function validateExactReadPermissions(permissions, code, message, errors, checks, workflowFile, path) {
  if (isPlainObject(permissions) && Object.keys(permissions).length === 1 && permissions.contents === 'read') {
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
