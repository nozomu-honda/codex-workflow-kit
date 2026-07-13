import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import {
  DEFAULT_HARD_BLOCK_FILE_PATTERNS,
  DEFAULT_SECRET_LIKE_PATTERNS,
  validateAutomationConfig
} from '../src/config/index.js';

let schemaValidator;

async function getSchemaValidator() {
  if (schemaValidator) {
    return schemaValidator;
  }

  const schemaSource = await readFile(new URL('../../../schemas/chatgpt-automation.schema.json', import.meta.url), 'utf8');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  schemaValidator = ajv.compile(JSON.parse(schemaSource));
  return schemaValidator;
}

async function expectSchemaAndValidator(config, expected) {
  const validateSchema = await getSchemaValidator();
  const schemaOk = validateSchema(config);
  const validatorResult = validateAutomationConfig(config);

  assert.equal(Boolean(schemaOk), expected, JSON.stringify(validateSchema.errors ?? []));
  assert.equal(validatorResult.ok, expected, JSON.stringify(validatorResult.errors));
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    baseBranch: 'master',
    ciWorkflowName: 'CI',
    mergeMethod: 'squash',
    dryRunDefault: true,
    features: {
      autoRequest: true,
      routeReview: true,
      autoMerge: false,
      mainFollowup: false,
      actionsApproval: false
    },
    labels: {
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
    },
    review: {
      decisionMode: 'marker-only',
      trustedActors: [],
      markers: {
        approved: '<!-- chatgpt-review: approved -->',
        changesRequested: '<!-- chatgpt-review: changes_requested -->',
        reviewRequest: '<!-- chatgpt-review-request -->',
        ignoreInFencedCodeBlocks: true,
        excludeReviewRequestComments: true
      },
      decisions: {
        stopOnLatestChangesRequested: true
      }
    },
    protectedFiles: {
      hardBlockPatterns: ['docs/private/**'],
      warningOnlyPatterns: ['docs/drafts/**']
    },
    secretLike: {
      hardBlockPatterns: ['PRIVATE_DEPLOYMENT_URL'],
      warningOnlyPatterns: ['generated-placeholder']
    },
    queues: {
      reviewFix: {
        enabled: false
      },
      mainFollowup: {
        enabled: false
      }
    },
    codex: {
      reviewFix: {
        enabled: false,
        maxAttempts: 2,
        sameRepoOnly: true,
        allowDraft: false,
        blockedLabel: 'do-not-auto-codex-fix',
        inProgressLabel: 'codex-fix-in-progress',
        triggerVariableName: 'CODEX_TRIGGER_COMMENT'
      },
      mainFollowup: {
        enabled: false,
        maxAttempts: 2,
        sameRepoOnly: true,
        allowDraft: false,
        blockedLabel: 'do-not-auto-codex-main-followup',
        inProgressLabel: 'codex-main-followup-in-progress',
        triggerVariableName: 'CODEX_TRIGGER_COMMENT'
      }
    },
    schedules: {
      reviewRequest: { enabled: false },
      autoMerge: { enabled: false },
      mainFollowup: { enabled: false },
      actionsApproval: { enabled: false }
    },
    secrets: {
      reviewRequestCommentToken: 'REVIEW_REQUEST_COMMENT_TOKEN',
      prBranchUpdateToken: 'PR_BRANCH_UPDATE_TOKEN',
      autoMergeToken: 'AUTO_MERGE_TOKEN',
      actionsApproverToken: 'ACTIONS_APPROVER_TOKEN'
    },
    variables: {
      codexTrigger: 'CODEX_TRIGGER_COMMENT',
      mainFollowupEnabled: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX',
      reviewFixMaxAttempts: 'CODEX_AUTO_FIX_MAX_ATTEMPTS',
      mainFollowupMaxAttempts: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX_MAX_ATTEMPTS'
    },
    ...overrides
  };
}

function expectError(config, code) {
  const result = validateAutomationConfig(config);
  assert.equal(result.ok, false);
  assert.equal(result.config, null);
  assert.equal(result.capabilities.autoMerge, false);
  assert.ok(result.errors.some((error) => error.code === code), `expected ${code}, got ${result.errors.map((error) => error.code).join(', ')}`);
  return result;
}

test('loads the sample config and normalizes safe defaults', async () => {
  const source = await readFile(new URL('../../../templates/chatgpt-automation.yml', import.meta.url), 'utf8');
  const result = validateAutomationConfig(source);

  assert.equal(result.ok, true);
  assert.equal(result.config.version, 1);
  assert.equal(result.config.baseBranch, 'master');
  assert.equal(result.capabilities.autoRequest, true);
  assert.equal(result.capabilities.routeReview, true);
  assert.equal(result.capabilities.autoMerge, false);
  assert.ok(result.config.protectedFiles.hardBlockPatterns.includes('.github/**'));
  assert.ok(result.config.protectedFiles.hardBlockPatterns.includes('docs/private/**'));
  assert.ok(result.config.secretLike.hardBlockPatterns.includes('token'));
  assert.ok(result.config.secretLike.hardBlockPatterns.includes('PRIVATE_DEPLOYMENT_URL'));
});

test('sample config is valid for both JSON Schema and validator', async () => {
  const source = await readFile(new URL('../../../templates/chatgpt-automation.yml', import.meta.url), 'utf8');
  const parsed = YAML.parse(source);

  await expectSchemaAndValidator(parsed, true);
});

test('hard-block defaults include migrated and shared foundation critical areas', () => {
  const expectedPatterns = [
    '.github/**',
    'scripts/**',
    '.chatgpt-review.json',
    'actions/**',
    'reusable-workflows/**',
    'packages/**',
    'schemas/**',
    'templates/**'
  ];

  for (const pattern of expectedPatterns) {
    assert.ok(DEFAULT_HARD_BLOCK_FILE_PATTERNS.includes(pattern), `${pattern} should be hard-blocked by default`);
  }
});

test('keeps hard-block defaults even when incoming arrays are empty', () => {
  const result = validateAutomationConfig(validConfig({
    protectedFiles: {
      hardBlockPatterns: [],
      warningOnlyPatterns: []
    },
    secretLike: {
      hardBlockPatterns: [],
      warningOnlyPatterns: []
    }
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.config.protectedFiles.hardBlockDefaults, [...DEFAULT_HARD_BLOCK_FILE_PATTERNS]);
  assert.deepEqual(result.config.secretLike.hardBlockDefaults, [...DEFAULT_SECRET_LIKE_PATTERNS]);
  assert.ok(result.config.protectedFiles.hardBlockPatterns.includes('.env*'));
  assert.ok(result.config.secretLike.hardBlockPatterns.includes('authorization'));
});

test('allows warning-only additions without weakening hard blocks', () => {
  const result = validateAutomationConfig(validConfig({
    protectedFiles: {
      hardBlockPatterns: ['docs/restricted/**'],
      warningOnlyPatterns: ['docs/notes/**']
    },
    secretLike: {
      hardBlockPatterns: ['INTERNAL_PLACEHOLDER'],
      warningOnlyPatterns: ['generated-placeholder']
    }
  }));

  assert.equal(result.ok, true);
  assert.ok(result.config.protectedFiles.hardBlockPatterns.includes('.github/**'));
  assert.ok(result.config.protectedFiles.warningOnlyPatterns.includes('docs/notes/**'));
  assert.ok(result.config.secretLike.hardBlockPatterns.includes('secret'));
  assert.ok(result.config.secretLike.warningOnlyPatterns.includes('generated-placeholder'));
});

test('does not require queue target or cron when disabled', () => {
  const result = validateAutomationConfig(validConfig({
    queues: {
      reviewFix: { enabled: false },
      mainFollowup: { enabled: false }
    },
    schedules: {
      reviewRequest: { enabled: false },
      autoMerge: { enabled: false },
      mainFollowup: { enabled: false },
      actionsApproval: { enabled: false }
    }
  }));

  assert.equal(result.ok, true);
});

test('keeps token and variable names as names only', () => {
  const result = validateAutomationConfig(validConfig({
    secrets: {
      reviewRequestCommentToken: 'REVIEW_REQUEST_COMMENT_TOKEN',
      prBranchUpdateToken: 'PR_BRANCH_UPDATE_TOKEN',
      autoMergeToken: 'AUTO_MERGE_TOKEN',
      actionsApproverToken: 'ACTIONS_APPROVER_TOKEN'
    },
    variables: {
      codexTrigger: 'CODEX_TRIGGER_COMMENT',
      mainFollowupEnabled: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX',
      reviewFixMaxAttempts: 'CODEX_AUTO_FIX_MAX_ATTEMPTS',
      mainFollowupMaxAttempts: 'MAIN_FOLLOWUP_CODEX_AUTO_FIX_MAX_ATTEMPTS'
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.config.secrets.autoMergeToken, 'AUTO_MERGE_TOKEN');
  assert.equal(result.config.variables.codexTrigger, 'CODEX_TRIGGER_COMMENT');
  assert.equal(result.config.variables.reviewFixMaxAttempts, 'CODEX_AUTO_FIX_MAX_ATTEMPTS');
  assert.equal(result.config.variables.mainFollowupMaxAttempts, 'MAIN_FOLLOWUP_CODEX_AUTO_FIX_MAX_ATTEMPTS');
});

test('rejects unsupported version', () => {
  expectError(validConfig({ version: 999 }), 'UNSUPPORTED_VERSION');
});

test('rejects YAML syntax errors', () => {
  expectError('version: 1\nbaseBranch: [', 'YAML_PARSE_ERROR');
});

test('rejects non-object roots', () => {
  expectError([], 'ROOT_OBJECT_REQUIRED');
  expectError(null, 'ROOT_OBJECT_REQUIRED');
  expectError('not-object', 'ROOT_OBJECT_REQUIRED');
});

test('rejects invalid base branch and CI workflow names', () => {
  expectError(validConfig({ baseBranch: '' }), 'INVALID_BASE_BRANCH');
  expectError(validConfig({ baseBranch: 'bad branch' }), 'INVALID_BASE_BRANCH');
  expectError(validConfig({ ciWorkflowName: '' }), 'INVALID_CI_WORKFLOW_NAME');
});

test('rejects invalid merge method and critical boolean type mismatch', () => {
  expectError(validConfig({ mergeMethod: 'fast-forward' }), 'INVALID_MERGE_METHOD');
  expectError(validConfig({ dryRunDefault: 'false' }), 'BOOLEAN_REQUIRED');
  expectError(validConfig({ features: { autoMerge: 'true' } }), 'BOOLEAN_REQUIRED');
});

test('rejects empty label names', () => {
  expectError(validConfig({ labels: { doNotMerge: '' } }), 'LABEL_REQUIRED');
});

test('rejects duplicated decision markers', () => {
  expectError(validConfig({
    review: {
      markers: {
        approved: '<!-- same -->',
        changesRequested: '<!-- same -->'
      }
    }
  }), 'DUPLICATE_REVIEW_MARKERS');
});

test('rejects weakening review marker safety settings', () => {
  expectError(validConfig({
    review: {
      markers: {
        ignoreInFencedCodeBlocks: false
      }
    }
  }), 'FENCED_MARKER_IGNORE_REQUIRED');

  expectError(validConfig({
    review: {
      markers: {
        excludeReviewRequestComments: false
      }
    }
  }), 'REVIEW_REQUEST_EXCLUSION_REQUIRED');

  expectError(validConfig({
    review: {
      decisions: {
        stopOnLatestChangesRequested: false
      }
    }
  }), 'LATEST_CHANGES_REQUESTED_REQUIRED');
});

test('rejects attempts to disable or edit hard-block defaults', () => {
  expectError(validConfig({
    protectedFiles: {
      disableDefaults: true
    }
  }), 'HARD_BLOCK_DEFAULTS_REQUIRED');

  expectError(validConfig({
    protectedFiles: {
      defaultHardBlockPatterns: []
    }
  }), 'READONLY_HARD_BLOCK_DEFAULTS');
});

test('rejects attempts to downgrade secret-like hard blocks', () => {
  expectError(validConfig({
    secretLike: {
      disableDefaults: true
    }
  }), 'SECRET_HARD_BLOCK_REQUIRED');

  expectError(validConfig({
    secretLike: {
      warningOnlyPatterns: ['token']
    }
  }), 'SECRET_HARD_BLOCK_DOWNGRADE_FORBIDDEN');

  expectError(validConfig({
    protectedFiles: {
      warningOnlyPatterns: ['**/*token*']
    }
  }), 'HARD_BLOCK_DOWNGRADE_FORBIDDEN');
});

test('rejects invalid secret and variable names', () => {
  expectError(validConfig({
    secrets: {
      autoMergeToken: 'not valid'
    }
  }), 'INVALID_SECRET_NAME');

  expectError(validConfig({
    variables: {
      codexTrigger: 'not-valid'
    }
  }), 'INVALID_VARIABLE_NAME');
});

test('rejects enabled queues without issue target', () => {
  expectError(validConfig({
    queues: {
      reviewFix: {
        enabled: true
      }
    }
  }), 'QUEUE_TARGET_REQUIRED');
});

test('rejects enabled schedules without safe cron', () => {
  expectError(validConfig({
    schedules: {
      autoMerge: {
        enabled: true
      }
    }
  }), 'CRON_REQUIRED');

  expectError(validConfig({
    schedules: {
      autoMerge: {
        enabled: true,
        cron: 'not enough fields'
      }
    }
  }), 'INVALID_CRON');
});

test('accepts safe GitHub Actions cron values', () => {
  const result = validateAutomationConfig(validConfig({
    schedules: {
      autoMerge: {
        enabled: true,
        cron: '*/15 1-5 * * 1-5'
      }
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.config.schedules.autoMerge.cron, '*/15 1-5 * * 1-5');
});

test('rejects out-of-range cron values and step zero', async () => {
  await expectSchemaAndValidator(validConfig({
    schedules: {
      autoMerge: {
        enabled: true,
        cron: '99 99 99 99 99'
      }
    }
  }), false);

  await expectSchemaAndValidator(validConfig({
    schedules: {
      autoMerge: {
        enabled: true,
        cron: '*/0 * * * *'
      }
    }
  }), false);

  expectError(validConfig({
    schedules: {
      autoMerge: {
        enabled: true,
        cron: '10-5 * * * *'
      }
    }
  }), 'INVALID_CRON');
});

test('rejects cross-repository Codex auto-fix', () => {
  expectError(validConfig({
    codex: {
      reviewFix: {
        enabled: true,
        sameRepoOnly: false
      }
    }
  }), 'SAME_REPO_ONLY_REQUIRED');
});

test('reports unknown keys as warnings', () => {
  const result = validateAutomationConfig(validConfig({
    unknownTopLevel: true
  }));

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.code === 'UNKNOWN_KEY' && warning.path === 'root.unknownTopLevel'));
});

test('keeps capabilities false when config is invalid', () => {
  const result = expectError(validConfig({
    features: {
      autoMerge: true
    },
    mergeMethod: 'unsafe'
  }), 'INVALID_MERGE_METHOD');

  assert.deepEqual(result.capabilities, {
    autoRequest: false,
    routeReview: false,
    autoMerge: false,
    mainFollowup: false,
    actionsApproval: false
  });
});

test('JSON Schema and validator both reject representative invalid configs', async () => {
  await expectSchemaAndValidator(validConfig({
    labels: {
      doNotMerge: ''
    }
  }), false);

  await expectSchemaAndValidator(validConfig({
    secrets: {
      autoMergeToken: 'not valid'
    }
  }), false);

  await expectSchemaAndValidator(validConfig({
    variables: {
      codexTrigger: 'not-valid'
    }
  }), false);

  await expectSchemaAndValidator(validConfig({
    queues: {
      reviewFix: {
        enabled: true
      }
    }
  }), false);

  await expectSchemaAndValidator(validConfig({
    schedules: {
      autoMerge: {
        enabled: true
      }
    }
  }), false);

  await expectSchemaAndValidator(validConfig({
    review: {
      markers: {
        ignoreInFencedCodeBlocks: false
      }
    }
  }), false);

  await expectSchemaAndValidator(validConfig({
    features: {
      autoMerge: 'true'
    }
  }), false);
});

test('validation errors do not echo input values or full config', () => {
  const markerText = 'placeholder-sensitive-value';
  const result = validateAutomationConfig(validConfig({
    secrets: {
      autoMergeToken: markerText
    }
  }));
  const serialized = JSON.stringify(result.errors);

  assert.equal(result.ok, false);
  assert.equal(serialized.includes(markerText), false);
  assert.equal(serialized.includes('baseBranch'), false);
});

test('validator does not log config input', () => {
  const calls = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => calls.push(args);
  console.error = (...args) => calls.push(args);

  try {
    validateAutomationConfig(validConfig());
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(calls, []);
});
