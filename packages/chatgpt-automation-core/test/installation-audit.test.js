import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  DEFAULT_AUDIT_CONFIG_FILE,
  DEFAULT_AUDIT_WORKFLOW_FILE,
  auditConsumerInstallation,
  formatAuditResult
} from '../src/installation-audit/index.js';
import { runAuditConsumerInstallationCli } from '../../../scripts/audit-consumer-installation.mjs';
import { runTemplateAudit } from '../../../scripts/audit-template.mjs';

const PINNED_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const SAMPLE_CONFIG = new URL('../../../templates/chatgpt-automation.yml', import.meta.url);
const CLI_SCRIPT = fileURLToPath(new URL('../../../scripts/audit-consumer-installation.mjs', import.meta.url));

async function withConsumerRepo(callback, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'consumer-installation-audit-'));
  try {
    if (options.config !== false) {
      await writeRepoFile(dir, options.configPath ?? DEFAULT_AUDIT_CONFIG_FILE, options.config ?? await readSampleConfig());
    }

    if (options.workflow !== false) {
      await writeRepoFile(dir, options.workflowPath ?? DEFAULT_AUDIT_WORKFLOW_FILE, options.workflow ?? workflowSource({
        configPath: options.configPath ?? DEFAULT_AUDIT_CONFIG_FILE
      }));
    }

    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeRepoFile(root, relativePath, content) {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function readSampleConfig() {
  return readFile(SAMPLE_CONFIG, 'utf8');
}

function mutateConfig(mutator) {
  return async () => {
    const config = YAML.parse(await readSampleConfig());
    mutator(config);
    return YAML.stringify(config);
  };
}

function workflowSource(options = {}) {
  const configPath = options.configPath ?? DEFAULT_AUDIT_CONFIG_FILE;
  const repository = options.repository ?? 'nozomu-honda/codex-workflow-kit';
  const workflowPath = options.reusableWorkflowPath ?? '.github/workflows/validate-config.yml';
  const ref = options.ref ?? PINNED_SHA;
  const hasOn = Object.hasOwn(options, 'on');
  const trigger = hasOn ? options.on : { workflow_dispatch: null };
  const rootPermissions = options.permissions ?? { contents: 'read' };
  const jobPermissions = options.jobPermissions ?? { contents: 'read' };
  const withInputs = options.with ?? {
    'config-file': configPath,
    'dry-run': true
  };
  const job = {
    name: 'Validate config',
    permissions: jobPermissions,
    uses: `${repository}/${workflowPath}@${ref}`,
    with: withInputs,
    ...options.job
  };
  const jobs = options.jobs ?? {
    'validate-config': job
  };
  const workflow = {
    name: 'Validate ChatGPT automation config',
    ...(hasOn && trigger === undefined ? {} : { on: trigger }),
    permissions: rootPermissions,
    jobs,
    ...options.root
  };

  return YAML.stringify(workflow);
}

function findCode(result, code) {
  return [...result.errors, ...result.warnings, ...result.checks].some((entry) => entry.code === code);
}

async function expectAuditCode(options, code) {
  await withConsumerRepo(async (dir) => {
    const result = await auditConsumerInstallation({
      rootDir: dir,
      expectedRef: options.expectedRef,
      configPath: options.configPath,
      workflowPath: options.workflowPath,
      readFile: options.readFile
    });

    assert.equal(result.ok, false, JSON.stringify(result, null, 2));
    assert.equal(findCode(result, code), true, `expected ${code}`);
  }, options);
}

test('valid minimal installation passes with stable result schema', async () => {
  await withConsumerRepo(async (dir) => {
    const result = await auditConsumerInstallation({ rootDir: dir });

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result).sort(), ['capabilities', 'checks', 'errors', 'files', 'ok', 'warnings']);
    assert.deepEqual(result.files, {
      config: DEFAULT_AUDIT_CONFIG_FILE,
      workflow: DEFAULT_AUDIT_WORKFLOW_FILE
    });
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.capabilities, falseCapabilities());
    assert.equal(findCode(result, 'CONFIG_VALID'), true);
    assert.equal(findCode(result, 'REUSABLE_WORKFLOW_REF_PINNED'), true);
  });
});

test('expected ref option requires the exact pinned SHA', async () => {
  await withConsumerRepo(async (dir) => {
    const ok = await auditConsumerInstallation({
      rootDir: dir,
      expectedRef: PINNED_SHA
    });
    const mismatch = await auditConsumerInstallation({
      rootDir: dir,
      expectedRef: OTHER_SHA
    });

    assert.equal(ok.ok, true);
    assert.equal(mismatch.ok, false);
    assert.equal(findCode(mismatch, 'REUSABLE_WORKFLOW_REF_MISMATCH'), true);
  });
});

test('custom config and workflow paths can be audited', async () => {
  const configPath = 'config/chatgpt-automation.yml';
  const workflowPath = '.github/workflows/validate-chatgpt-automation-config.yml';

  await withConsumerRepo(async (dir) => {
    const result = await auditConsumerInstallation({
      rootDir: dir,
      configPath,
      workflowPath
    });

    assert.equal(result.ok, true);
    assert.equal(result.files.config, configPath);
    assert.equal(result.files.workflow, workflowPath);
  }, {
    configPath,
    workflowPath,
    workflow: workflowSource({ configPath })
  });
});

test('human-readable and JSON CLI output are stable and parseable', async () => {
  await withConsumerRepo(async (dir) => {
    const human = { stdout: '', stderr: '' };
    const json = { stdout: '', stderr: '' };

    const humanExit = await runAuditConsumerInstallationCli(['--root', dir], {
      stdout: (message) => { human.stdout += message; },
      stderr: (message) => { human.stderr += message; }
    });
    const jsonExit = await runAuditConsumerInstallationCli(['--root', dir, '--json'], {
      stdout: (message) => { json.stdout += message; },
      stderr: (message) => { json.stderr += message; }
    });
    const parsed = JSON.parse(json.stdout);

    assert.equal(humanExit, 0);
    assert.equal(jsonExit, 0);
    assert.match(human.stdout, /installation audit: OK/);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.files.config, DEFAULT_AUDIT_CONFIG_FILE);
  });
});

test('CLI help and usage errors return expected exit codes', async () => {
  const help = { stdout: '', stderr: '' };
  const usage = { stdout: '', stderr: '' };

  assert.equal(await runAuditConsumerInstallationCli(['--help'], {
    stdout: (message) => { help.stdout += message; },
    stderr: (message) => { help.stderr += message; }
  }), 0);
  assert.equal(await runAuditConsumerInstallationCli(['--unknown'], {
    stdout: (message) => { usage.stdout += message; },
    stderr: (message) => { usage.stderr += message; }
  }), 2);
  assert.match(help.stdout, /--root/);
  assert.match(usage.stderr, /Unknown option/);
});

test('missing and unreadable config fail closed with all capabilities false', async () => {
  await expectAuditCode({ config: false }, 'CONFIG_MISSING');

  await withConsumerRepo(async (dir) => {
    const result = await auditConsumerInstallation({
      rootDir: dir,
      readFile: async (file, encoding) => {
        if (String(file).endsWith(DEFAULT_AUDIT_CONFIG_FILE.replaceAll('/', '\\')) || String(file).endsWith(DEFAULT_AUDIT_CONFIG_FILE)) {
          const error = new Error('not allowed');
          error.code = 'EACCES';
          throw error;
        }
        return readFile(file, encoding);
      }
    });

    assert.equal(result.ok, false);
    assert.equal(findCode(result, 'CONFIG_READ_FAILED'), true);
    assert.deepEqual(result.capabilities, falseCapabilities());
  });
});

test('invalid config cases are detected without weakening the shared validator', async () => {
  await expectAuditCode({ config: 'version: 1\nbaseBranch: [' }, 'YAML_PARSE_ERROR');
  await expectAuditCode({ config: await mutateConfig((config) => { config.features.autoMerge = 'true'; })() }, 'BOOLEAN_REQUIRED');
  await expectAuditCode({ config: await mutateConfig((config) => { config.dryRunDefault = false; })() }, 'CONFIG_DRY_RUN_DEFAULT_FALSE');
});

test('enabled capabilities fail closed during initial installation audit', async () => {
  for (const capability of Object.keys(falseCapabilities())) {
    await withConsumerRepo(async (dir) => {
      const result = await auditConsumerInstallation({ rootDir: dir });

      assert.equal(result.ok, false, capability);
      assert.equal(findCode(result, 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN'), true);
      assert.deepEqual(result.capabilities, falseCapabilities());
      assert.equal(result.errors.some((error) => error.path === `features.${capability}`), true);
    }, {
      config: await mutateConfig((config) => { config.features[capability] = true; })()
    });
  }
});

test('config errors keep capabilities fail closed even when enabled features are present', async () => {
  await withConsumerRepo(async (dir) => {
    const result = await auditConsumerInstallation({ rootDir: dir });

    assert.equal(result.ok, false);
    assert.equal(findCode(result, 'INVALID_MERGE_METHOD'), true);
    assert.deepEqual(result.capabilities, falseCapabilities());
  }, {
    config: await mutateConfig((config) => {
      config.features.autoMerge = true;
      config.mergeMethod = 'unsafe';
    })()
  });
});

test('unknown config keys fail closed by default at root and nested paths', async () => {
  const fixtures = [
    {
      path: 'root.unknownRootForAuditTest',
      config: `${await readSampleConfig()}\nunknownRootForAuditTest: true\n`
    },
    {
      path: 'review.unknownNestedForAuditTest',
      config: await mutateConfig((config) => {
        config.review.unknownNestedForAuditTest = true;
      })()
    }
  ];

  for (const fixture of fixtures) {
    await withConsumerRepo(async (dir) => {
      const normal = await auditConsumerInstallation({ rootDir: dir });
      const strict = await auditConsumerInstallation({ rootDir: dir, strict: true });

      assert.equal(normal.ok, false, fixture.path);
      assert.equal(strict.ok, false, fixture.path);
      assert.equal(findCode(normal, 'UNKNOWN_KEY'), true);
      assert.equal(normal.errors.some((error) => error.code === 'UNKNOWN_KEY' && error.path === fixture.path), true);
      assert.deepEqual(normal.capabilities, falseCapabilities());
    }, {
      config: fixture.config
    });
  }
});

test('CLI human and JSON output keep stable error codes for default fail-closed cases', async () => {
  const cases = [
    {
      code: 'UNKNOWN_KEY',
      config: `${await readSampleConfig()}\nunknownRootForAuditTest: true\n`
    },
    {
      code: 'CONFIG_CAPABILITY_ENABLED_FORBIDDEN',
      config: await mutateConfig((config) => {
        config.features.autoMerge = true;
      })()
    }
  ];

  for (const entry of cases) {
    await withConsumerRepo(async (dir) => {
      const human = { stdout: '', stderr: '' };
      const json = { stdout: '', stderr: '' };

      const humanExit = await runAuditConsumerInstallationCli(['--root', dir], {
        stdout: (message) => { human.stdout += message; },
        stderr: (message) => { human.stderr += message; }
      });
      const jsonExit = await runAuditConsumerInstallationCli(['--root', dir, '--json'], {
        stdout: (message) => { json.stdout += message; },
        stderr: (message) => { json.stderr += message; }
      });
      const parsed = JSON.parse(json.stdout);

      assert.equal(humanExit, 1);
      assert.equal(jsonExit, 1);
      assert.match(human.stdout, new RegExp(entry.code));
      assert.equal(parsed.ok, false);
      assert.equal(parsed.errors.some((error) => error.code === entry.code), true);
      assert.deepEqual(parsed.capabilities, falseCapabilities());
    }, {
      config: entry.config
    });
  }
});

test('strict mode remains compatible when the default audit has no warnings', async () => {
  await withConsumerRepo(async (dir) => {
    const normal = await auditConsumerInstallation({ rootDir: dir });
    const strict = await auditConsumerInstallation({ rootDir: dir, strict: true });

    assert.equal(normal.ok, true);
    assert.equal(strict.ok, true);
    assert.equal(normal.warnings.length, 0);
  }, {
    config: await readSampleConfig()
  });
});

test('workflow missing and YAML parse failures are detected', async () => {
  await expectAuditCode({ workflow: false }, 'WORKFLOW_MISSING');
  await expectAuditCode({ workflow: 'name: [\n' }, 'WORKFLOW_YAML_PARSE_ERROR');
});

test('workflow ref validation rejects branch, tag, short SHA, and placeholder', async () => {
  await expectAuditCode({ workflow: workflowSource({ ref: 'master' }) }, 'REUSABLE_WORKFLOW_REF_MUTABLE');
  await expectAuditCode({ workflow: workflowSource({ ref: 'v1.2.3' }) }, 'REUSABLE_WORKFLOW_REF_TAG');
  await expectAuditCode({ workflow: workflowSource({ ref: '0123456' }) }, 'REUSABLE_WORKFLOW_REF_SHORT_SHA');
  await expectAuditCode({ workflow: workflowSource({ ref: 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA' }) }, 'REUSABLE_WORKFLOW_REF_PLACEHOLDER');
});

test('workflow repository and path must match the shared reusable workflow', async () => {
  await expectAuditCode({ workflow: workflowSource({ repository: 'someone/else' }) }, 'REUSABLE_WORKFLOW_REPOSITORY_MISMATCH');
  await expectAuditCode({ workflow: workflowSource({ reusableWorkflowPath: '.github/workflows/other.yml' }) }, 'REUSABLE_WORKFLOW_PATH_MISMATCH');
});

test('workflow triggers are limited to workflow_dispatch only', async () => {
  await withConsumerRepo(async (dir) => {
    const result = await auditConsumerInstallation({ rootDir: dir });

    assert.equal(result.ok, true);
    assert.equal(findCode(result, 'WORKFLOW_DISPATCH_ONLY'), true);
  }, {
    workflow: workflowSource({ on: { workflow_dispatch: {} } })
  });
  await expectAuditCode({ workflow: workflowSource({ on: undefined }) }, 'WORKFLOW_TRIGGER_INVALID');
  await expectAuditCode({ workflow: workflowSource({ on: null }) }, 'WORKFLOW_TRIGGER_INVALID');
  await expectAuditCode({ workflow: workflowSource({ on: {} }) }, 'WORKFLOW_TRIGGER_INVALID');
  await expectAuditCode({ workflow: workflowSource({ on: [] }) }, 'WORKFLOW_TRIGGER_INVALID');
  await expectAuditCode({ workflow: workflowSource({ on: 'push' }) }, 'WORKFLOW_TRIGGER_INVALID');
  await expectAuditCode({ workflow: workflowSource({ on: { workflow_dispatch: null, push: { branches: ['master'] } } }) }, 'WORKFLOW_TRIGGER_UNEXPECTED');
  await expectAuditCode({ workflow: workflowSource({ on: { pull_request_target: null } }) }, 'PULL_REQUEST_TARGET_FORBIDDEN');
  await expectAuditCode({ workflow: workflowSource({ on: { workflow_dispatch: { inputs: { unsafe: { type: 'string' } } } } }) }, 'WORKFLOW_DISPATCH_INPUTS_UNEXPECTED');
});

test('CLI output keeps stable error codes for invalid workflow triggers', async () => {
  const cases = [
    {
      code: 'WORKFLOW_TRIGGER_INVALID',
      workflow: workflowSource({ on: {} })
    },
    {
      code: 'WORKFLOW_TRIGGER_UNEXPECTED',
      workflow: workflowSource({ on: { workflow_dispatch: null, push: { branches: ['master'] } } })
    },
    {
      code: 'PULL_REQUEST_TARGET_FORBIDDEN',
      workflow: workflowSource({ on: { pull_request_target: null } })
    },
    {
      code: 'WORKFLOW_DISPATCH_INPUTS_UNEXPECTED',
      workflow: workflowSource({ on: { workflow_dispatch: { inputs: { unsafe: { type: 'string' } } } } })
    }
  ];

  for (const entry of cases) {
    await withConsumerRepo(async (dir) => {
      const human = { stdout: '', stderr: '' };
      const json = { stdout: '', stderr: '' };

      const humanExit = await runAuditConsumerInstallationCli(['--root', dir], {
        stdout: (message) => { human.stdout += message; },
        stderr: (message) => { human.stderr += message; }
      });
      const jsonExit = await runAuditConsumerInstallationCli(['--root', dir, '--json'], {
        stdout: (message) => { json.stdout += message; },
        stderr: (message) => { json.stderr += message; }
      });
      const parsed = JSON.parse(json.stdout);

      assert.equal(humanExit, 1);
      assert.equal(jsonExit, 1);
      assert.match(human.stdout, new RegExp(entry.code));
      assert.equal(parsed.ok, false);
      assert.equal(parsed.errors.some((error) => error.code === entry.code), true);
      assert.deepEqual(parsed.capabilities, falseCapabilities());
    }, {
      workflow: entry.workflow
    });
  }
});

test('workflow permissions must be contents read only', async () => {
  await expectAuditCode({ workflow: workflowSource({ permissions: { contents: 'write' } }) }, 'WORKFLOW_PERMISSIONS_INVALID');
  await expectAuditCode({ workflow: workflowSource({ jobPermissions: { contents: 'read', actions: 'read' } }) }, 'JOB_PERMISSIONS_INVALID');
});

test('workflow forbids secrets, secrets inherit, runs-on, steps, run, shell, extra jobs, and outputs', async () => {
  await expectAuditCode({ workflow: workflowSource({ job: { secrets: { TOKEN: '${{ secrets.TOKEN }}' } } }) }, 'WORKFLOW_SECRETS_FORBIDDEN');
  await expectAuditCode({ workflow: workflowSource({ job: { secrets: 'inherit' } }) }, 'WORKFLOW_SECRETS_INHERIT_FORBIDDEN');
  await expectAuditCode({ workflow: workflowSource({ job: { 'runs-on': 'ubuntu-latest' } }) }, 'WORKFLOW_RUNS_ON_FORBIDDEN');
  await expectAuditCode({ workflow: workflowSource({ job: { steps: [{ run: 'echo unsafe' }] } }) }, 'WORKFLOW_STEPS_FORBIDDEN');
  await expectAuditCode({ workflow: workflowSource({ job: { run: 'echo unsafe' } }) }, 'WORKFLOW_INLINE_RUN_FORBIDDEN');
  await expectAuditCode({ workflow: workflowSource({ job: { shell: 'bash' } }) }, 'WORKFLOW_SHELL_FORBIDDEN');
  await expectAuditCode({ workflow: workflowSource({ jobs: { 'validate-config': { permissions: { contents: 'read' }, uses: `nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@${PINNED_SHA}`, with: { 'config-file': DEFAULT_AUDIT_CONFIG_FILE, 'dry-run': true } }, extra: {} } }) }, 'UNEXPECTED_JOB');
  await expectAuditCode({ workflow: workflowSource({ root: { outputs: {} } }) }, 'WORKFLOW_OUTPUT_UNEXPECTED');
});

test('workflow inputs must be expected config-file and dry-run true only', async () => {
  await expectAuditCode({ workflow: workflowSource({ with: { 'config-file': 'wrong.yml', 'dry-run': true } }) }, 'WORKFLOW_CONFIG_FILE_MISMATCH');
  await expectAuditCode({ workflow: workflowSource({ with: { 'config-file': DEFAULT_AUDIT_CONFIG_FILE, 'dry-run': false } }) }, 'WORKFLOW_DRY_RUN_NOT_TRUE');
  await expectAuditCode({ workflow: workflowSource({ with: { 'config-file': DEFAULT_AUDIT_CONFIG_FILE, 'dry-run': true, extra: true } }) }, 'WORKFLOW_INPUT_UNEXPECTED');
});

test('result and CLI output do not expose secret-like fixture values, absolute paths, or stack traces', async () => {
  const secretValue = 'Authorization: Bearer abc.def.ghi';
  const config = await mutateConfig((entry) => {
    entry.secrets.autoMergeToken = secretValue;
  })();

  await withConsumerRepo(async (dir) => {
    const result = await auditConsumerInstallation({ rootDir: dir });
    const json = JSON.stringify(result);
    const human = formatAuditResult(result);
    const child = spawnSync(process.execPath, [CLI_SCRIPT, '--root', dir, '--json'], {
      encoding: 'utf8'
    });

    assert.notEqual(child.status, 0);
    assert.doesNotThrow(() => JSON.parse(child.stdout));
    assert.equal(json.includes(secretValue), false);
    assert.equal(human.includes(secretValue), false);
    assert.equal(child.stdout.includes(secretValue), false);
    assert.equal(child.stderr.includes(secretValue), false);
    assert.equal(json.includes(resolve(dir)), false);
    assert.equal(child.stdout.includes(resolve(dir)), false);
    assert.equal(`${child.stdout}\n${child.stderr}`.includes('Error:'), false);
    assert.equal(`${child.stdout}\n${child.stderr}`.includes('at '), false);
  }, { config });
});

test('paths outside the repository root fail without echoing absolute paths', async () => {
  await withConsumerRepo(async (dir) => {
    const outsidePath = resolve(dir, '..', 'outside-config.yml');
    const result = await auditConsumerInstallation({
      rootDir: dir,
      configPath: outsidePath
    });
    const json = JSON.stringify(result);

    assert.equal(result.ok, false);
    assert.equal(findCode(result, 'CONFIG_PATH_INVALID'), true);
    assert.equal(result.files.config, '[outside-repository]');
    assert.equal(json.includes(outsidePath), false);
    assert.equal(json.includes(resolve(dir)), false);
  });
});

test('template dogfood audit patches placeholder in a temp fixture without allowing placeholders in production audit', async () => {
  const dogfood = await runTemplateAudit();

  assert.equal(dogfood.ok, true);

  await expectAuditCode({
    configPath: 'templates/chatgpt-automation.yml',
    workflowPath: 'templates/workflows/validate-config.yml',
    config: false,
    workflow: false
  }, 'CONFIG_MISSING');

  const templateWorkflow = await readFile(new URL('../../../templates/workflows/validate-config.yml', import.meta.url), 'utf8');
  await expectAuditCode({
    workflow: templateWorkflow
  }, 'REUSABLE_WORKFLOW_REF_PLACEHOLDER');
});

function falseCapabilities() {
  return {
    autoRequest: false,
    routeReview: false,
    autoMerge: false,
    mainFollowup: false,
    actionsApproval: false
  };
}
