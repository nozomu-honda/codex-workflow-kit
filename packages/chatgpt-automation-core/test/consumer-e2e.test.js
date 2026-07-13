import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  DEFAULT_AUDIT_CONFIG_FILE,
  DEFAULT_AUDIT_WORKFLOW_FILE,
  auditConsumerInstallation,
  formatAuditResult
} from '../src/installation-audit/index.js';
import { runAuditConsumerInstallationCli } from '../../../scripts/audit-consumer-installation.mjs';
import {
  falseCapabilities,
  readSampleConfig,
  runAction,
  runBundledAction
} from '../../../actions/validate-config/test/helpers.js';

const PINNED_SHA = '0123456789abcdef0123456789abcdef01234567';
const PLACEHOLDER_REF = 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA';
const SENSITIVE_FIXTURE = 'DUMMY_SENSITIVE_MARKER_FOR_OUTPUT_REDACTION';
const TEMPLATE_WORKFLOW = new URL('../../../templates/workflows/validate-config.yml', import.meta.url);

test('templateから作ったoffline consumer fixtureはread-only監査を通過する', async () => {
  await withConsumerFromTemplates(async (dir) => {
    const result = await auditConsumerInstallation({
      rootDir: dir,
      expectedRef: PINNED_SHA
    });
    const human = await runAuditCli(dir);
    const json = await runAuditCli(dir, ['--json']);
    const parsed = JSON.parse(json.stdout);
    const config = YAML.parse(await readFile(join(dir, DEFAULT_AUDIT_CONFIG_FILE), 'utf8'));
    const workflow = YAML.parse(await readFile(join(dir, DEFAULT_AUDIT_WORKFLOW_FILE), 'utf8'));

    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.deepEqual(result.capabilities, falseCapabilities());
    assert.equal(config.dryRunDefault, true);
    assertAllCapabilitiesDisabled(config);

    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(workflow.jobs['validate-config'].permissions, { contents: 'read' });
    assert.match(workflow.jobs['validate-config'].uses, new RegExp(`@${PINNED_SHA}$`));
    assert.equal(workflow.jobs['validate-config'].with['config-file'], DEFAULT_AUDIT_CONFIG_FILE);
    assert.equal(workflow.jobs['validate-config'].with['dry-run'], true);
    assertNoForbiddenWorkflowKeys(workflow);

    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /installation audit: OK/);
    assertNoUnsafeOutput(`${human.stdout}\n${human.stderr}`, dir);
    assert.equal(json.exitCode, 0);
    assert.deepEqual(Object.keys(parsed).sort(), ['capabilities', 'checks', 'errors', 'files', 'ok', 'warnings']);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.capabilities, falseCapabilities());
    assertNoUnsafeOutput(`${json.stdout}\n${json.stderr}`, dir);
    assert.match(formatAuditResult(result), /checks: /);
  });
});

test('offline consumer invalid matrixはnon-zeroとstable error codeでfail closedになる', async () => {
  const cases = await invalidConsumerCases();

  for (const entry of cases) {
    await withConsumerFromTemplates(async (dir) => {
      const run = await runAuditCli(dir, ['--json'], entry.auditArgs);
      const parsed = JSON.parse(run.stdout);
      const matchingError = parsed.errors.find((error) => {
        if (error.code !== entry.code) {
          return false;
        }
        if (entry.path !== undefined && error.path !== entry.path) {
          return false;
        }
        if (entry.file !== undefined && error.file !== entry.file) {
          return false;
        }
        return true;
      });

      assert.equal(run.exitCode, 1, entry.name);
      assert.equal(parsed.ok, false, entry.name);
      assert.ok(matchingError, `${entry.name} should include ${entry.code}`);
      assert.deepEqual(parsed.capabilities, falseCapabilities(), entry.name);
      assertNoUnsafeOutput(`${run.stdout}\n${run.stderr}`, dir);
    }, entry.fixture);
  }
});

test('consumer fixtureのconfigはAction sourceとdistで同じ結果になる', async () => {
  await withConsumerFromTemplates(async (dir) => {
    const configSource = await readFile(join(dir, DEFAULT_AUDIT_CONFIG_FILE), 'utf8');
    const sourceRun = await runAction(dir);
    const distRun = await runBundledAction(join(dir, 'dist-run'), configSource);

    assert.equal(sourceRun.exitCode, 0);
    assert.equal(distRun.status, 0);
    assert.equal(sourceRun.outputs.ok, 'true');
    assert.equal(distRun.outputs.ok, 'true');
    assert.equal(sourceRun.outputs['error-count'], '0');
    assert.equal(distRun.outputs['error-count'], '0');
    assert.equal(sourceRun.outputs['dry-run'], 'true');
    assert.equal(distRun.outputs['dry-run'], 'true');
    assert.deepEqual(JSON.parse(sourceRun.outputs['capabilities-json']), falseCapabilities());
    assert.deepEqual(JSON.parse(distRun.outputs['capabilities-json']), falseCapabilities());
    assert.deepEqual(distRun.outputs, {
      ok: sourceRun.outputs.ok,
      'error-count': sourceRun.outputs['error-count'],
      'warning-count': sourceRun.outputs['warning-count'],
      'capabilities-json': sourceRun.outputs['capabilities-json'],
      'dry-run': sourceRun.outputs['dry-run']
    });
    await assert.rejects(readFile(join(distRun.actionRoot, 'node_modules/yaml/package.json'), 'utf8'));
  });
});

test('Action sourceとdistはinvalid configでfail closedになりconfig本文を出さない', async () => {
  await withConsumerFromTemplates(async (dir) => {
    const source = 'version: 999\n';
    await writeRepoFile(dir, DEFAULT_AUDIT_CONFIG_FILE, source);

    const sourceRun = await runAction(dir);
    const distRun = await runBundledAction(join(dir, 'dist-invalid-run'), source);
    const logs = `${sourceRun.logText}\n${distRun.stdout}\n${distRun.stderr}`;

    assert.equal(sourceRun.exitCode, 1);
    assert.notEqual(distRun.status, 0);
    assert.equal(sourceRun.outputs.ok, 'false');
    assert.equal(distRun.outputs.ok, 'false');
    assert.deepEqual(JSON.parse(sourceRun.outputs['capabilities-json']), falseCapabilities());
    assert.deepEqual(JSON.parse(distRun.outputs['capabilities-json']), falseCapabilities());
    assert.equal(logs.includes(source.trim()), false);
    assertNoUnsafeOutput(logs, dir);
  });
});

test('Action sourceとdistはcommand injection風のconfig値をログへ出さない', async () => {
  await withConsumerFromTemplates(async (dir) => {
    const injected = '::error::consumer-e2e-injected-command';
    const config = YAML.parse(await readSampleConfig());
    config.review.markers.ignoreInFencedCodeBlocks = false;
    config.consumerE2eSensitiveValue = SENSITIVE_FIXTURE;
    config.consumerE2eInjectedValue = injected;
    const source = YAML.stringify(config);
    await writeRepoFile(dir, DEFAULT_AUDIT_CONFIG_FILE, source);

    const sourceRun = await runAction(dir);
    const distRun = await runBundledAction(join(dir, 'dist-injection-run'), source);
    const logs = `${sourceRun.logText}\n${distRun.stdout}\n${distRun.stderr}`;

    assert.equal(sourceRun.exitCode, 1);
    assert.notEqual(distRun.status, 0);
    assert.equal(logs.includes(SENSITIVE_FIXTURE), false);
    assert.equal(logs.includes(injected), false);
    assert.equal(logs.includes(source.trim()), false);
    assertNoUnsafeOutput(logs, dir);
  });
});

async function invalidConsumerCases() {
  return [
    {
      name: 'placeholder ref',
      code: 'REUSABLE_WORKFLOW_REF_PLACEHOLDER',
      path: 'jobs.validate-config.uses',
      fixture: { workflow: await workflowFromTemplate({ replacePlaceholder: false }) }
    },
    {
      name: 'mutable branch ref',
      code: 'REUSABLE_WORKFLOW_REF_MUTABLE',
      path: 'jobs.validate-config.uses',
      fixture: { workflow: await workflowFromTemplate({ ref: 'master' }) }
    },
    {
      name: 'tag ref',
      code: 'REUSABLE_WORKFLOW_REF_TAG',
      path: 'jobs.validate-config.uses',
      fixture: { workflow: await workflowFromTemplate({ ref: 'v1.2.3' }) }
    },
    {
      name: 'short SHA',
      code: 'REUSABLE_WORKFLOW_REF_SHORT_SHA',
      path: 'jobs.validate-config.uses',
      fixture: { workflow: await workflowFromTemplate({ ref: '0123456' }) }
    },
    {
      name: 'unknown config key',
      code: 'UNKNOWN_KEY',
      path: 'root.consumerE2eUnknownKey',
      fixture: { config: await configWith((config) => { config.consumerE2eUnknownKey = SENSITIVE_FIXTURE; }) }
    },
    {
      name: 'features enabled',
      code: 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN',
      path: 'features.autoRequest',
      fixture: { config: await configWith((config) => { config.features.autoRequest = true; }) }
    },
    {
      name: 'queues enabled',
      code: 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN',
      path: 'queues.reviewFix.enabled',
      fixture: { config: await configWith((config) => { config.queues.reviewFix.enabled = true; }) }
    },
    {
      name: 'codex enabled',
      code: 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN',
      path: 'codex.reviewFix.enabled',
      fixture: { config: await configWith((config) => { config.codex.reviewFix.enabled = true; }) }
    },
    {
      name: 'schedules enabled',
      code: 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN',
      path: 'schedules.autoMerge.enabled',
      fixture: {
        config: await configWith((config) => {
          config.schedules.autoMerge.enabled = true;
          config.schedules.autoMerge.cron = '20/15 * * * *';
        })
      }
    },
    {
      name: 'dryRunDefault false',
      code: 'CONFIG_DRY_RUN_DEFAULT_FALSE',
      path: 'dryRunDefault',
      fixture: { config: await configWith((config) => { config.dryRunDefault = false; }) }
    },
    {
      name: 'write permission',
      code: 'WORKFLOW_PERMISSIONS_INVALID',
      path: 'permissions',
      fixture: { workflow: await workflowWith((workflow) => { workflow.permissions.contents = 'write'; }) }
    },
    {
      name: 'multiple permission',
      code: 'JOB_PERMISSIONS_INVALID',
      path: 'jobs.validate-config.permissions',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs['validate-config'].permissions.actions = 'read';
        })
      }
    },
    {
      name: 'secrets inherit',
      code: 'WORKFLOW_SECRETS_INHERIT_FORBIDDEN',
      path: 'jobs.validate-config.secrets',
      fixture: { workflow: await workflowWith((workflow) => { workflow.jobs['validate-config'].secrets = 'inherit'; }) }
    },
    {
      name: 'secret mapping',
      code: 'WORKFLOW_SECRETS_FORBIDDEN',
      path: 'jobs.validate-config.secrets',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs['validate-config'].secrets = { TOKEN: '${{ secrets.TOKEN }}' };
        })
      }
    },
    {
      name: 'dry-run false',
      code: 'WORKFLOW_DRY_RUN_NOT_TRUE',
      path: 'jobs.validate-config.with.dry-run',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs['validate-config'].with['dry-run'] = false;
        })
      }
    },
    {
      name: 'config-file mismatch',
      code: 'WORKFLOW_CONFIG_FILE_MISMATCH',
      path: 'jobs.validate-config.with.config-file',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs['validate-config'].with['config-file'] = 'wrong.yml';
        })
      }
    },
    {
      name: 'workflow path escape',
      code: 'WORKFLOW_PATH_INVALID',
      file: '[outside-repository]',
      auditArgs: { workflowPath: '../outside.yml' }
    },
    {
      name: 'config path escape',
      code: 'CONFIG_PATH_INVALID',
      file: '[outside-repository]',
      auditArgs: { configPath: '../outside.yml' }
    },
    {
      name: 'config missing',
      code: 'CONFIG_MISSING',
      file: DEFAULT_AUDIT_CONFIG_FILE,
      fixture: { config: false }
    },
    {
      name: 'workflow missing',
      code: 'WORKFLOW_MISSING',
      file: DEFAULT_AUDIT_WORKFLOW_FILE,
      fixture: { workflow: false }
    },
    {
      name: 'config YAML syntax error',
      code: 'YAML_PARSE_ERROR',
      fixture: { config: 'version: 1\nbaseBranch: [' }
    },
    {
      name: 'workflow YAML syntax error',
      code: 'WORKFLOW_YAML_PARSE_ERROR',
      file: DEFAULT_AUDIT_WORKFLOW_FILE,
      fixture: { workflow: 'name: [' }
    },
    {
      name: 'unexpected job',
      code: 'UNEXPECTED_JOB',
      path: 'jobs',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs.extra = { permissions: { contents: 'read' }, uses: './other.yml' };
        })
      }
    },
    {
      name: 'inline run',
      code: 'WORKFLOW_INLINE_RUN_FORBIDDEN',
      path: 'jobs.validate-config.run',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs['validate-config'].run = 'echo unsafe';
        })
      }
    },
    {
      name: 'steps',
      code: 'WORKFLOW_STEPS_FORBIDDEN',
      path: 'jobs.validate-config.steps',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs['validate-config'].steps = [{ run: 'echo unsafe' }];
        })
      }
    },
    {
      name: 'runs-on',
      code: 'WORKFLOW_RUNS_ON_FORBIDDEN',
      path: 'jobs.validate-config.runs-on',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.jobs['validate-config']['runs-on'] = 'ubuntu-latest';
        })
      }
    },
    {
      name: 'pull_request_target',
      code: 'PULL_REQUEST_TARGET_FORBIDDEN',
      path: 'on.pull_request_target',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.on = { pull_request_target: null };
        })
      }
    },
    {
      name: 'workflow_dispatch以外のtrigger',
      code: 'WORKFLOW_TRIGGER_UNEXPECTED',
      path: 'on.push',
      fixture: {
        workflow: await workflowWith((workflow) => {
          workflow.on.push = { branches: ['master'] };
        })
      }
    }
  ];
}

async function withConsumerFromTemplates(callback, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'consumer-e2e-'));
  try {
    await writeRepoFile(dir, 'fixtures/sensitive-marker.txt', SENSITIVE_FIXTURE);

    if (options.config !== false) {
      await writeRepoFile(dir, DEFAULT_AUDIT_CONFIG_FILE, options.config ?? await readSampleConfig());
    }

    if (options.workflow !== false) {
      await writeRepoFile(dir, DEFAULT_AUDIT_WORKFLOW_FILE, options.workflow ?? await workflowFromTemplate());
    }

    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeRepoFile(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function workflowFromTemplate(options = {}) {
  const source = await readFile(TEMPLATE_WORKFLOW, 'utf8');

  if (options.replacePlaceholder === false) {
    return source;
  }

  return source.replaceAll(PLACEHOLDER_REF, options.ref ?? PINNED_SHA);
}

async function workflowWith(mutator) {
  const workflow = YAML.parse(await workflowFromTemplate());
  mutator(workflow);
  return YAML.stringify(workflow);
}

async function configWith(mutator) {
  const config = YAML.parse(await readSampleConfig());
  mutator(config);
  return YAML.stringify(config);
}

async function runAuditCli(dir, args = [], auditArgs = {}) {
  const output = { stdout: '', stderr: '' };
  const argv = [
    '--root',
    dir,
    '--expected-ref',
    PINNED_SHA,
    ...pathArgs(auditArgs),
    ...args
  ];
  const exitCode = await runAuditConsumerInstallationCli(argv, {
    stdout: (message) => { output.stdout += message; },
    stderr: (message) => { output.stderr += message; }
  });

  return { exitCode, ...output };
}

function pathArgs(auditArgs = {}) {
  const args = [];
  if (auditArgs.configPath !== undefined) {
    args.push('--config', auditArgs.configPath);
  }
  if (auditArgs.workflowPath !== undefined) {
    args.push('--workflow', auditArgs.workflowPath);
  }
  return args;
}

function assertAllCapabilitiesDisabled(config) {
  const paths = [
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
  ];

  for (const path of paths) {
    assert.equal(readDottedPath(config, path), false, `${path} must be disabled`);
  }
}

function readDottedPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function assertNoForbiddenWorkflowKeys(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoForbiddenWorkflowKeys(entry);
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    assert.notEqual(key, 'pull_request_target');
    assert.notEqual(key, 'secrets');
    assert.notEqual(key, 'runs-on');
    assert.notEqual(key, 'steps');
    assert.notEqual(key, 'run');
    assert.notEqual(key, 'shell');
    assert.notEqual(entry, 'inherit');
    assertNoForbiddenWorkflowKeys(entry);
  }
}

function assertNoUnsafeOutput(output, dir) {
  assert.equal(output.includes(SENSITIVE_FIXTURE), false);
  assert.equal(output.includes(resolve(dir)), false);
  assert.equal(output.includes('Error:'), false);
  assert.equal(/\n\s+at\s+/.test(output), false);
}
