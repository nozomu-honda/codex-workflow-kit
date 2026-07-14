import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  LIVE_CONSUMER_WORKFLOW_SPECS,
  auditLiveConsumerInstallation,
  formatLiveConsumerAuditReport,
  validateLiveConsumerInventoryObject
} from '../src/consumer-audit/index.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const SECRET_FIXTURE = 'Authorization: Bearer abc.def.ghi';
const CONFIG_FILE = new URL('../../../templates/chatgpt-automation.yml', import.meta.url);
const TEMPLATE_FILES = {
  'config-validation': new URL('../../../templates/workflows/validate-config.yml', import.meta.url),
  'event-normalization': new URL('../../../templates/workflows/chatgpt-automation-events.yml', import.meta.url),
  'review-routing-plan': new URL('../../../templates/workflows/chatgpt-review-routing-events.yml', import.meta.url),
  'auto-merge-plan': new URL('../../../templates/workflows/reviewed-pr-auto-merge-events.yml', import.meta.url),
  'main-follow-up-plan': new URL('../../../templates/workflows/main-follow-up-events.yml', import.meta.url)
};

test('valid live consumer snapshot produces sanitized deterministic report', async () => {
  const consumer = validConsumer();
  const snapshot = await validSnapshot();
  const first = auditLiveConsumerInstallation({ consumer, snapshot });
  const second = auditLiveConsumerInstallation({ consumer, snapshot });
  const human = formatLiveConsumerAuditReport(first);

  assert.equal(first.ok, true, JSON.stringify(first, null, 2));
  assert.equal(first.ready, true);
  assert.equal(first.reportVersion, 'live-consumer-audit.v1');
  assert.deepEqual(first.detectedKitRefs, [SHA]);
  assert.equal(first.workflowsAudited.length, 5);
  assert.deepEqual(first.blockers, []);
  assert.deepEqual(first, second);
  assert.match(human, /Live consumer audit: READY/);
  assertNoUnsafeOutput(`${JSON.stringify(first)}\n${human}`);
});

test('non-caller workflows are ignored and only inventory callers are audited', async () => {
  const snapshot = await validSnapshot({
    extraFiles: {
      '.github/workflows/ci.yml': {
        status: 'ok',
        content: [
          'name: CI',
          'on:',
          '  pull_request:',
          'permissions:',
          '  contents: read',
          'jobs:',
          '  test:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: npm test'
        ].join('\n'),
        sha: 'cisha',
        size: 120
      }
    }
  });
  const result = auditLiveConsumerInstallation({ consumer: validConsumer(), snapshot });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.ready, true);
  assert.equal(hasCode(result, 'unknown_workflow'), false);
  assert.equal(result.workflowsAudited.some((entry) => entry.path === '.github/workflows/ci.yml'), false);
});

test('caller workflow paths from inventory define the audited workflow set', async () => {
  const result = auditLiveConsumerInstallation({
    consumer: validConsumer({
      callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
      desiredCapabilitySet: ['config-validation'],
      expectedWorkflowNames: ['Validate ChatGPT automation config']
    }),
    snapshot: await validSnapshot({
      extraFiles: {
        '.github/workflows/dependabot.yml': {
          status: 'ok',
          content: 'name: Dependabot\non:\n  workflow_dispatch:\n',
          sha: 'dependabotsha',
          size: 40
        }
      }
    })
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.workflowsAudited.length, 1);
  assert.equal(result.workflowsAudited[0].path, '.github/workflows/validate-config.yml');
  assert.equal(hasCode(result, 'unknown_workflow'), false);
});

test('inventory validation rejects unknown keys, URLs, unsafe paths, duplicate paths, bad refs, and unknown capabilities', () => {
  const inventory = {
    schemaVersion: 1,
    consumers: [
      {
        ...validConsumer(),
        repository: 'https://example.invalid/owner/repo',
        configPath: '../config.yml',
        callerWorkflowPaths: ['.github/workflows/validate-config.yml', '.github/workflows/validate-config.yml'],
        expectedKitRef: 'main',
        desiredCapabilitySet: ['config-validation', 'unknown-capability'],
        unexpected: true
      }
    ]
  };
  const result = validateLiveConsumerInventoryObject(inventory);

  assert.equal(result.ok, false);
  for (const code of [
    'inventory_unknown_key',
    'repository_invalid',
    'path_invalid',
    'workflow_path_duplicate',
    'expected_kit_ref_invalid',
    'capability_unknown'
  ]) {
    assert.equal(hasCode(result, code), true, code);
  }
});

test('fixed SHA audit rejects mutable, short, version tag, placeholder, mixed, and mismatched kit refs', async () => {
  const cases = [
    { ref: 'main', code: 'mutable_kit_ref' },
    { ref: '0123456', code: 'kit_short_ref' },
    { ref: 'v1.2.3', code: 'kit_version_tag' },
    { ref: 'REPLACE_WITH_40_CHAR_COMMIT_SHA', code: 'unresolved_placeholder' },
    { ref: OTHER_SHA, code: 'kit_ref_mismatch' }
  ];

  for (const entry of cases) {
    const result = auditLiveConsumerInstallation({
      consumer: validConsumer(),
      snapshot: await validSnapshot({
        mutateWorkflow: {
          capability: 'review-routing-plan',
          mutate: (workflow) => {
            workflow.jobs['review-routing'].uses = workflow.jobs['review-routing'].uses.replace(SHA, entry.ref);
            workflow.jobs['review-routing'].with['kit-ref'] = entry.ref;
          }
        }
      })
    });
    assert.equal(result.ok, false, entry.ref);
    assert.equal(hasCode(result, entry.code), true, entry.code);
  }

  const mixed = auditLiveConsumerInstallation({
    consumer: validConsumer({ expectedKitRef: undefined }),
    snapshot: await validSnapshot({
      mutateWorkflow: {
        capability: 'main-follow-up-plan',
        mutate: (workflow) => {
          workflow.jobs['main-follow-up-plan'].uses = workflow.jobs['main-follow-up-plan'].uses.replace(SHA, OTHER_SHA);
          workflow.jobs['main-follow-up-plan'].with['kit-ref'] = OTHER_SHA;
        }
      }
    })
  });
  assert.equal(mixed.ok, false);
  assert.equal(hasCode(mixed, 'mixed_kit_refs'), true);
});

test('trigger, permission, and secret-like dangerous workflow patterns fail closed', async () => {
  const cases = [
    {
      code: 'pull_request_target_present',
      mutate: (workflow) => {
        workflow.on.pull_request_target = {};
      }
    },
    {
      code: 'unexpected_write_permission',
      mutate: (workflow) => {
        workflow.permissions.contents = 'write';
      }
    },
    {
      code: 'unexpected_write_permission',
      mutate: (workflow) => {
        workflow.permissions = 'write-all';
      }
    },
    {
      code: 'workflow_permission_missing',
      mutate: (workflow) => {
        delete workflow.jobs['review-routing'].permissions;
      }
    },
    {
      code: 'secrets_inherit_present',
      mutate: (workflow) => {
        workflow.jobs['review-routing'].secrets = 'inherit';
      }
    },
    {
      code: 'secret_reference_present',
      mutate: (workflow) => {
        workflow.jobs['review-routing'].with.secretish = '${{ secrets.PRIVATE_TOKEN }}';
      }
    },
    {
      code: 'secret_like_env_present',
      mutate: (workflow) => {
        workflow.jobs['review-routing'].with.secretish = SECRET_FIXTURE;
      }
    },
    {
      code: 'workflow_steps_present',
      mutate: (workflow) => {
        workflow.jobs['review-routing'].steps = [{ run: 'echo unsafe' }];
      }
    },
    {
      code: 'untrusted_payload_in_shell',
      mutate: (workflow) => {
        workflow.jobs['review-routing'].run = 'echo ${{ toJson(github.event) }}';
      }
    },
    {
      code: 'checkout_persist_credentials_true',
      mutate: (workflow) => {
        workflow.jobs['review-routing'].extra = {
          with: {
            'persist-credentials': true
          }
        };
      }
    }
  ];

  for (const entry of cases) {
    const result = auditLiveConsumerInstallation({
      consumer: validConsumer(),
      snapshot: await validSnapshot({
        mutateWorkflow: {
          capability: 'review-routing-plan',
          mutate: entry.mutate
        }
      })
    });
    assert.equal(result.ok, false, entry.code);
    assert.equal(hasCode(result, entry.code), true, entry.code);
    assertNoUnsafeOutput(JSON.stringify(result));
  }
});

test('inventory trigger and permission contracts override default workflow specs', async () => {
  const allowedTrigger = auditLiveConsumerInstallation({
    consumer: validConsumer({
      callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
      desiredCapabilitySet: ['config-validation'],
      expectedWorkflowNames: ['Validate ChatGPT automation config'],
      allowedTriggers: {
        'config-validation': ['workflow_dispatch', 'workflow_run']
      }
    }),
    snapshot: await validSnapshot({
      mutateWorkflow: {
        capability: 'config-validation',
        mutate: (workflow) => {
          workflow.on.workflow_run = {};
        }
      }
    })
  });
  assert.equal(allowedTrigger.ok, true, JSON.stringify(allowedTrigger, null, 2));

  const disallowedTrigger = auditLiveConsumerInstallation({
    consumer: validConsumer({
      callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
      desiredCapabilitySet: ['config-validation'],
      expectedWorkflowNames: ['Validate ChatGPT automation config']
    }),
    snapshot: await validSnapshot({
      mutateWorkflow: {
        capability: 'config-validation',
        mutate: (workflow) => {
          workflow.on.workflow_run = {};
        }
      }
    })
  });
  assert.equal(disallowedTrigger.ok, false);
  assert.equal(hasCode(disallowedTrigger, 'unexpected_trigger'), true);

  const allowedPermission = auditLiveConsumerInstallation({
    consumer: validConsumer({
      callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
      desiredCapabilitySet: ['config-validation'],
      expectedWorkflowNames: ['Validate ChatGPT automation config'],
      allowedPermissions: {
        'config-validation': {
          contents: 'read',
          actions: 'read'
        }
      }
    }),
    snapshot: await validSnapshot({
      mutateWorkflow: {
        capability: 'config-validation',
        mutate: (workflow) => {
          workflow.permissions.actions = 'read';
          workflow.jobs['validate-config'].permissions.actions = 'read';
        }
      }
    })
  });
  assert.equal(allowedPermission.ok, true, JSON.stringify(allowedPermission, null, 2));
});

test('workflow metadata name is checked against inventory expectedWorkflowNames', async () => {
  const match = auditLiveConsumerInstallation({
    consumer: validConsumer({
      callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
      desiredCapabilitySet: ['config-validation'],
      expectedWorkflowNames: ['Validate ChatGPT automation config']
    }),
    snapshot: await validSnapshot()
  });
  assert.equal(match.ok, true, JSON.stringify(match, null, 2));
  assert.equal(hasCode(match, 'workflow_metadata_ok'), true);

  const mismatchSnapshot = await validSnapshot();
  mismatchSnapshot.workflowMetadata = mismatchSnapshot.workflowMetadata.map((entry) => entry.path === '.github/workflows/validate-config.yml'
    ? { ...entry, name: 'Unexpected workflow name' }
    : entry);
  const mismatch = auditLiveConsumerInstallation({
    consumer: validConsumer({
      callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
      desiredCapabilitySet: ['config-validation'],
      expectedWorkflowNames: ['Validate ChatGPT automation config']
    }),
    snapshot: mismatchSnapshot
  });
  assert.equal(mismatch.ok, false);
  assert.equal(hasCode(mismatch, 'workflow_name_mismatch'), true);
});

test('manualReviewRequired controls ready state consistently', async () => {
  const manual = auditLiveConsumerInstallation({
    consumer: validConsumer({ manualReviewRequired: true }),
    snapshot: await validSnapshot()
  });
  assert.equal(manual.ok, false);
  assert.equal(manual.ready, false);
  assert.equal(manual.manualReviewRequired, true);
  assert.equal(hasCode(manual, 'manual_review_required'), true);

  const automatic = auditLiveConsumerInstallation({
    consumer: validConsumer({ manualReviewRequired: false }),
    snapshot: await validSnapshot()
  });
  assert.equal(automatic.ok, true);
  assert.equal(automatic.ready, true);
  assert.equal(automatic.manualReviewRequired, false);
});

test('config and capability mismatches fail closed', async () => {
  const missingConfig = auditLiveConsumerInstallation({
    consumer: validConsumer(),
    snapshot: await validSnapshot({ missing: ['.github/chatgpt-automation.yml'] })
  });
  assert.equal(missingConfig.ok, false);
  assert.equal(hasCode(missingConfig, 'config_missing'), true);

  const invalidConfig = auditLiveConsumerInstallation({
    consumer: validConsumer(),
    snapshot: await validSnapshot({ config: 'version: 1\nbaseBranch: [' })
  });
  assert.equal(invalidConfig.ok, false);
  assert.equal(hasCode(invalidConfig, 'config_schema_invalid'), true);

  const mismatch = auditLiveConsumerInstallation({
    consumer: validConsumer({
      desiredCapabilitySet: ['config-validation'],
      callerWorkflowPaths: Object.values(LIVE_CONSUMER_WORKFLOW_SPECS).map((spec) => spec.path)
    }),
    snapshot: await validSnapshot()
  });
  assert.equal(mismatch.ok, false);
  assert.equal(hasCode(mismatch, 'capability_caller_mismatch'), true);
});

test('API errors, branch race, binary, submodule, and oversized files fail closed', async () => {
  const apiFailure = auditLiveConsumerInstallation({
    consumer: validConsumer(),
    snapshot: {
      ...await validSnapshot(),
      apiErrors: [{ code: 'api_permission_denied', path: '/actions/workflows' }]
    }
  });
  assert.equal(apiFailure.ok, false);
  assert.equal(hasCode(apiFailure, 'api_permission_denied'), true);

  const branchRace = auditLiveConsumerInstallation({
    consumer: validConsumer(),
    snapshot: {
      ...await validSnapshot(),
      defaultBranchEndSha: OTHER_SHA
    }
  });
  assert.equal(branchRace.ok, false);
  assert.equal(hasCode(branchRace, 'default_branch_changed_during_audit'), true);

  for (const [status, code] of [
    ['binary', 'binary_or_submodule_manual_review'],
    ['submodule', 'binary_or_submodule_manual_review'],
    ['too_large', 'response_size_limit_exceeded']
  ]) {
    const snapshot = await validSnapshot();
    snapshot.files['.github/workflows/validate-config.yml'] = { status, content: '', sha: '', size: 1 };
    const result = auditLiveConsumerInstallation({ consumer: validConsumer(), snapshot });
    assert.equal(result.ok, false, status);
    assert.equal(hasCode(result, code), true);
  }
});

test('report does not expose secret-like values', async () => {
  const result = auditLiveConsumerInstallation({
    consumer: validConsumer(),
    snapshot: await validSnapshot({
      mutateWorkflow: {
        capability: 'review-routing-plan',
        mutate: (workflow) => {
          workflow.jobs['review-routing'].with.secretish = SECRET_FIXTURE;
        }
      }
    })
  });

  assert.equal(JSON.stringify(result).includes(SECRET_FIXTURE), false);
  assert.equal(formatLiveConsumerAuditReport(result).includes(SECRET_FIXTURE), false);
});

function validConsumer(overrides = {}) {
  return {
    repository: 'owner/example-repo',
    defaultBranch: 'main',
    configPath: '.github/chatgpt-automation.yml',
    callerWorkflowPaths: Object.values(LIVE_CONSUMER_WORKFLOW_SPECS).map((spec) => spec.path),
    expectedKitRef: SHA,
    desiredCapabilitySet: Object.keys(LIVE_CONSUMER_WORKFLOW_SPECS),
    manualReviewRequired: false,
    ...overrides
  };
}

async function validSnapshot(options = {}) {
  const files = {};
  const workflowMetadata = [];
  const config = options.config ?? await readFile(CONFIG_FILE, 'utf8');
  files['.github/chatgpt-automation.yml'] = { status: 'ok', content: config, sha: 'configsha', size: config.length };

  for (const [capability, file] of Object.entries(TEMPLATE_FILES)) {
    const spec = LIVE_CONSUMER_WORKFLOW_SPECS[capability];
    let source = (await readFile(file, 'utf8')).replaceAll('REPLACE_WITH_40_CHAR_COMMIT_SHA', SHA);
    if (options.mutateWorkflow?.capability === capability) {
      const workflow = YAML.parse(source);
      options.mutateWorkflow.mutate(workflow);
      source = YAML.stringify(workflow);
    }
    const workflow = YAML.parse(source);
    files[spec.path] = { status: 'ok', content: source, sha: `${capability}sha`, size: source.length };
    workflowMetadata.push({
      id: workflowMetadata.length + 1,
      name: workflow.name,
      path: spec.path,
      state: 'active'
    });
  }

  for (const [path, file] of Object.entries(options.extraFiles ?? {})) {
    files[path] = file;
  }

  for (const path of options.missing ?? []) {
    files[path] = { status: 'missing', content: '', sha: '', size: 0 };
  }

  return {
    repository: 'owner/example-repo',
    defaultBranch: 'main',
    defaultBranchStartSha: SHA,
    defaultBranchEndSha: SHA,
    files,
    workflowMetadata,
    apiErrors: []
  };
}

function hasCode(result, code) {
  return [...(result.errors ?? []), ...(result.blockers ?? []), ...(result.warnings ?? []), ...(result.checks ?? [])]
    .some((entry) => entry.code === code);
}

function assertNoUnsafeOutput(output) {
  assert.equal(output.includes(SECRET_FIXTURE), false);
  assert.equal(output.includes('PRIVATE_TOKEN'), false);
  assert.equal(output.includes('Authorization: Bearer'), false);
  assert.equal(output.includes('C:\\'), false);
  assert.equal(output.includes('/tmp/'), false);
}
