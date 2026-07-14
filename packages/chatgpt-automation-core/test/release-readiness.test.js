import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  LEGACY_RELEASE_REF_PLACEHOLDER,
  RELEASE_REF_PLACEHOLDER,
  RELEASE_CAPABILITIES,
  auditReleaseGitState,
  auditReleaseManifestInventory,
  auditFixedRefs,
  checkChangelog,
  classifyRef,
  classifyVersionChange,
  compareSemVer,
  createConsumerUpdatePlan,
  createReleaseReadinessPlan,
  isValidReleaseSha,
  isValidSemVer,
  isValidVersionTag,
  validateReleaseManifestObject
} from '../src/release-readiness/index.js';
import releaseManifestSchema from '../../../schemas/release-manifest.schema.json' with { type: 'json' };

const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PREVIOUS_SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const FUTURE_SHA = '3333333333333333333333333333333333333333';

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    releaseVersion: '0.1.0',
    releaseCommitSha: RELEASE_SHA,
    previousReleaseCommitSha: PREVIOUS_SHA,
    releaseDate: '2026-07-14',
    capabilities: [
      'config-validation',
      'event-normalization',
      'review-routing-plan',
      'auto-merge-plan',
      'main-follow-up-plan'
    ],
    changedCapabilities: [
      'auto-merge-plan',
      'main-follow-up-plan'
    ],
    breakingChanges: [],
    migrationRequired: false,
    actionArtifacts: [
      'actions/validate-config/action.yml',
      'actions/validate-config/dist/index.js'
    ],
    reusableWorkflows: [
      '.github/workflows/validate-config.yml',
      '.github/workflows/normalize-event.yml'
    ],
    callerTemplates: [
      'templates/workflows/validate-config.yml'
    ],
    schemas: [
      'schemas/chatgpt-automation.schema.json',
      'schemas/release-manifest.schema.json'
    ],
    rollbackCommitSha: PREVIOUS_SHA,
    validationCommands: [
      'npm ci',
      'npm run ci'
    ],
    unimplementedWriteCapabilities: [
      'auto-merge-write',
      'branch-update-write',
      'codex-launch',
      'queue-issue-update'
    ],
    ...overrides
  };
}

function changelog(extra = '') {
  return `# Changelog

## Unreleased

### Added

- Added release readiness planning for auto-merge-plan and main-follow-up-plan.

### Changed

- Documented fixed SHA consumer update policy.

### Migration

- No migration is required for this release.
${extra}`;
}

function inventory(overrides = {}) {
  return {
    schemaVersion: 1,
    consumers: [
      {
        repository: 'owner/example-repo',
        defaultBranch: 'main',
        configPath: '.github/chatgpt-automation.yml',
        callerWorkflowPaths: [
          '.github/workflows/validate-config.yml',
          '.github/workflows/main-follow-up-events.yml'
        ],
        currentKitRef: PREVIOUS_SHA,
        desiredCapabilitySet: [
          'config-validation',
          'main-follow-up-plan'
        ],
        updatePolicy: {
          allowDowngrade: false,
          direction: 'forward'
        },
        manualReviewRequired: false,
        ...overrides.consumer
      }
    ],
    ...overrides.root
  };
}

function refAuditFiles(source) {
  return [
    {
      path: '.github/workflows/ci.yml',
      content: source
    }
  ];
}

function gitState(overrides = {}) {
  return {
    ok: true,
    headSha: RELEASE_SHA,
    commits: {
      [RELEASE_SHA]: { exists: true, type: 'commit' },
      [PREVIOUS_SHA]: { exists: true, type: 'commit' },
      [OTHER_SHA]: { exists: true, type: 'commit' },
      [FUTURE_SHA]: { exists: true, type: 'commit' },
      ...overrides.commits
    },
    ancestors: {
      [`${PREVIOUS_SHA}..${RELEASE_SHA}`]: { ok: true, isAncestor: true },
      [`${OTHER_SHA}..${RELEASE_SHA}`]: { ok: true, isAncestor: false },
      [`${FUTURE_SHA}..${RELEASE_SHA}`]: { ok: true, isAncestor: false },
      ...overrides.ancestors
    },
    ...overrides.root
  };
}

function repositoryInventory(overrides = {}) {
  const base = manifest();
  const inventory = {
    actionArtifacts: base.actionArtifacts,
    reusableWorkflows: base.reusableWorkflows,
    callerTemplates: base.callerTemplates,
    schemas: base.schemas,
    capabilities: RELEASE_CAPABILITIES,
    existingFiles: [
      ...base.actionArtifacts,
      ...base.reusableWorkflows,
      ...base.callerTemplates,
      ...base.schemas
    ],
    ...overrides
  };
  return inventory;
}

function findCode(result, code) {
  return [...(result.errors ?? []), ...(result.warnings ?? []), ...(result.blockers ?? []), ...(result.checks ?? [])]
    .some((entry) => entry.code === code);
}

test('SemVer、version tag、40桁SHAのpolicyを判定する', () => {
  assert.equal(isValidSemVer('1.2.3'), true);
  assert.equal(isValidSemVer('1.2'), false);
  assert.equal(isValidVersionTag('v1.2.3'), true);
  assert.equal(isValidVersionTag('v1.2'), false);
  assert.equal(isValidReleaseSha(RELEASE_SHA), true);
  assert.equal(isValidReleaseSha(RELEASE_SHA.toUpperCase()), false);
  assert.equal(classifyRef('main'), 'mutable');
  assert.equal(classifyRef('master'), 'mutable');
  assert.equal(classifyRef('latest'), 'mutable');
  assert.equal(classifyRef('0123456'), 'short-sha');
  assert.equal(classifyRef('v1.2.3'), 'version-tag');
  assert.equal(classifyRef(RELEASE_SHA), 'sha40');
});

test('version change分類はpatch / minor / major / downgradeを返す', () => {
  assert.equal(classifyVersionChange('1.2.3', '1.2.4'), 'patch');
  assert.equal(classifyVersionChange('1.2.3', '1.3.0'), 'minor');
  assert.equal(classifyVersionChange('1.2.3', '2.0.0'), 'major');
  assert.equal(classifyVersionChange('1.2.3', '1.2.2'), 'downgrade');
  assert.equal(compareSemVer('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemVer('1.2.4', '1.2.3'), 1);
  assert.equal(compareSemVer('1.2.2', '1.2.3'), -1);
});

test('release manifest schemaとcore validatorはvalid manifestを通す', () => {
  const ajv = new Ajv2020({ allErrors: true });
  assert.equal(ajv.validate(releaseManifestSchema, manifest()), true, JSON.stringify(ajv.errors, null, 2));

  const result = validateReleaseManifestObject(manifest());
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(findCode(result, 'RELEASE_MANIFEST_VALID'), true);
});

test('release manifestは未知key、重複capability、invalid rollback SHA、未実装write capabilityをfail closedにする', () => {
  const invalid = validateReleaseManifestObject(manifest({
    unknown: true,
    capabilities: ['config-validation', 'config-validation', 'auto-merge-write'],
    rollbackCommitSha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'
  }));

  assert.equal(invalid.ok, false);
  assert.equal(findCode(invalid, 'RELEASE_MANIFEST_UNKNOWN_KEY'), true);
  assert.equal(findCode(invalid, 'RELEASE_MANIFEST_DUPLICATE_CAPABILITY'), true);
  assert.equal(findCode(invalid, 'RELEASE_SHA_UPPERCASE'), true);
  assert.equal(findCode(invalid, 'RELEASE_MANIFEST_UNIMPLEMENTED_WRITE_CAPABILITY'), true);
});

test('migrationRequired=true は migration notes を要求する', () => {
  const invalid = validateReleaseManifestObject(manifest({
    migrationRequired: true,
    breakingChanges: [{ description: 'Required input changed.' }]
  }));
  const valid = validateReleaseManifestObject(manifest({
    migrationRequired: true,
    breakingChanges: [{ description: 'Required input changed.', migration: 'Update caller workflow inputs manually.' }]
  }));

  assert.equal(findCode(invalid, 'RELEASE_MIGRATION_DETAILS_REQUIRED'), true);
  assert.equal(valid.ok, true);
});

test('release git stateはcommit存在、HEAD一致、ancestorを検証する', () => {
  const valid = auditReleaseGitState({
    manifest: manifest(),
    gitState: gitState()
  });
  const releaseMissing = auditReleaseGitState({
    manifest: manifest(),
    gitState: gitState({ commits: { [RELEASE_SHA]: { exists: false, type: '' } } })
  });
  const headMismatch = auditReleaseGitState({
    manifest: manifest(),
    gitState: gitState({ root: { headSha: OTHER_SHA } })
  });
  const previousMissing = auditReleaseGitState({
    manifest: manifest(),
    gitState: gitState({ commits: { [PREVIOUS_SHA]: { exists: false, type: '' } } })
  });
  const rollbackMissing = auditReleaseGitState({
    manifest: manifest(),
    gitState: gitState({ commits: { [PREVIOUS_SHA]: { exists: false, type: '' } } })
  });

  assert.equal(valid.ok, true, JSON.stringify(valid, null, 2));
  assert.equal(findCode(releaseMissing, 'RELEASE_COMMIT_NOT_FOUND'), true);
  assert.equal(findCode(headMismatch, 'RELEASE_COMMIT_HEAD_MISMATCH'), true);
  assert.equal(findCode(previousMissing, 'RELEASE_PREVIOUS_COMMIT_NOT_FOUND'), true);
  assert.equal(findCode(rollbackMissing, 'RELEASE_ROLLBACK_COMMIT_NOT_FOUND'), true);
});

test('release git stateはprevious / rollback ancestorとgit失敗をfail closedにする', () => {
  const previousNotAncestor = auditReleaseGitState({
    manifest: manifest({ previousReleaseCommitSha: OTHER_SHA }),
    gitState: gitState()
  });
  const rollbackValid = auditReleaseGitState({
    manifest: manifest({ rollbackCommitSha: PREVIOUS_SHA }),
    gitState: gitState()
  });
  const rollbackNotAncestor = auditReleaseGitState({
    manifest: manifest({ rollbackCommitSha: FUTURE_SHA }),
    gitState: gitState()
  });
  const mergeBaseFailed = auditReleaseGitState({
    manifest: manifest(),
    gitState: gitState({
      ancestors: {
        [`${PREVIOUS_SHA}..${RELEASE_SHA}`]: { ok: false, isAncestor: false }
      }
    })
  });
  const gitFailed = auditReleaseGitState({
    manifest: manifest(),
    gitState: { ok: false, reason: 'git_command_failed' }
  });

  assert.equal(findCode(previousNotAncestor, 'RELEASE_PREVIOUS_NOT_ANCESTOR'), true);
  assert.equal(rollbackValid.ok, true);
  assert.equal(findCode(rollbackNotAncestor, 'RELEASE_ROLLBACK_NOT_ANCESTOR'), true);
  assert.equal(findCode(mergeBaseFailed, 'RELEASE_PREVIOUS_ANCESTOR_CHECK_FAILED'), true);
  assert.equal(findCode(gitFailed, 'RELEASE_GIT_STATE_UNAVAILABLE'), true);
});

test('manifest inventoryはfile存在、重複、漏れ、余分を検出する', () => {
  const valid = auditReleaseManifestInventory({
    manifest: manifest(),
    repositoryInventory: repositoryInventory()
  });
  const missingWorkflow = auditReleaseManifestInventory({
    manifest: manifest({ reusableWorkflows: ['.github/workflows/missing.yml'] }),
    repositoryInventory: repositoryInventory()
  });
  const missingSchema = auditReleaseManifestInventory({
    manifest: manifest({ schemas: ['schemas/missing.schema.json'] }),
    repositoryInventory: repositoryInventory()
  });
  const missingTemplate = auditReleaseManifestInventory({
    manifest: manifest({ callerTemplates: ['templates/workflows/missing.yml'] }),
    repositoryInventory: repositoryInventory()
  });
  const missingArtifact = auditReleaseManifestInventory({
    manifest: manifest({ actionArtifacts: ['actions/validate-config/dist/missing.js'] }),
    repositoryInventory: repositoryInventory()
  });
  const duplicate = auditReleaseManifestInventory({
    manifest: manifest({ schemas: ['schemas/release-manifest.schema.json', 'schemas/release-manifest.schema.json'] }),
    repositoryInventory: repositoryInventory()
  });
  const omitted = auditReleaseManifestInventory({
    manifest: manifest({ schemas: ['schemas/release-manifest.schema.json'] }),
    repositoryInventory: repositoryInventory()
  });
  const extra = auditReleaseManifestInventory({
    manifest: manifest({ schemas: [...manifest().schemas, 'schemas/extra.schema.json'] }),
    repositoryInventory: repositoryInventory({ existingFiles: [...repositoryInventory().existingFiles, 'schemas/extra.schema.json'] })
  });

  assert.equal(valid.ok, true, JSON.stringify(valid, null, 2));
  assert.equal(findCode(missingWorkflow, 'RELEASE_MANIFEST_FILE_MISSING'), true);
  assert.equal(findCode(missingSchema, 'RELEASE_MANIFEST_FILE_MISSING'), true);
  assert.equal(findCode(missingTemplate, 'RELEASE_MANIFEST_FILE_MISSING'), true);
  assert.equal(findCode(missingArtifact, 'RELEASE_MANIFEST_FILE_MISSING'), true);
  assert.equal(findCode(duplicate, 'RELEASE_MANIFEST_FILE_DUPLICATE'), true);
  assert.equal(findCode(omitted, 'RELEASE_MANIFEST_INVENTORY_MISSING'), true);
  assert.equal(findCode(extra, 'RELEASE_MANIFEST_INVENTORY_EXTRA'), true);
});

test('manifest inventoryはcapability漏れと余分を検出する', () => {
  const missing = auditReleaseManifestInventory({
    manifest: manifest({ capabilities: RELEASE_CAPABILITIES.filter((capability) => capability !== 'main-follow-up-plan') }),
    repositoryInventory: repositoryInventory()
  });
  const extra = auditReleaseManifestInventory({
    manifest: manifest({ capabilities: [...RELEASE_CAPABILITIES, 'unknown-read-only-plan'] }),
    repositoryInventory: repositoryInventory()
  });
  const changedUnknown = auditReleaseManifestInventory({
    manifest: manifest({ changedCapabilities: ['unknown-read-only-plan'] }),
    repositoryInventory: repositoryInventory()
  });

  assert.equal(findCode(missing, 'RELEASE_MANIFEST_CAPABILITY_MISSING'), true);
  assert.equal(findCode(extra, 'RELEASE_MANIFEST_CAPABILITY_EXTRA'), true);
  assert.equal(findCode(changedUnknown, 'RELEASE_MANIFEST_CHANGED_CAPABILITY_UNKNOWN'), true);
});

test('fixed ref auditは40桁SHAとlocal actionを許可し、mutable/tag/short SHA/malformed usesを拒否する', () => {
  const result = auditFixedRefs({
    files: refAuditFiles(`jobs:
  ok:
    steps:
      - uses: actions/checkout@${RELEASE_SHA}
      - uses: ./.github/workflows/validate-config.yml
      - uses: actions/setup-node@main
      - uses: actions/cache@v1.2.3
      - uses: actions/upload-artifact@0123456
      - uses: owner/repo/action
`)
  });

  assert.equal(result.ok, false);
  assert.equal(findCode(result, 'FIXED_REF_PINNED_SHA'), true);
  assert.equal(findCode(result, 'FIXED_REF_LOCAL_USES_ALLOWED'), true);
  assert.equal(findCode(result, 'FIXED_REF_MUTABLE_FORBIDDEN'), true);
  assert.equal(findCode(result, 'FIXED_REF_VERSION_TAG_FORBIDDEN'), true);
  assert.equal(findCode(result, 'FIXED_REF_SHORT_SHA'), true);
  assert.equal(findCode(result, 'FIXED_REF_USES_MALFORMED'), true);
});

test('fixed ref auditはtemplate placeholderだけを明示許可し、本番workflowやlegacy placeholderを拒否する', () => {
  const template = auditFixedRefs({
    files: [
      {
        path: 'templates/workflows/validate-config.yml',
        content: `jobs:\n  ok:\n    uses: nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@${RELEASE_REF_PLACEHOLDER}\n`
      }
    ]
  });
  const production = auditFixedRefs({
    files: [
      {
        path: '.github/workflows/validate-config.yml',
        content: `jobs:\n  ok:\n    uses: nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@${RELEASE_REF_PLACEHOLDER}\n`
      },
      {
        path: 'templates/workflows/legacy.yml',
        content: `jobs:\n  ok:\n    uses: nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@${LEGACY_RELEASE_REF_PLACEHOLDER}\n`
      }
    ]
  });

  assert.equal(template.ok, true);
  assert.equal(findCode(template, 'FIXED_REF_TEMPLATE_PLACEHOLDER_ALLOWED'), true);
  assert.equal(production.ok, false);
  assert.equal(findCode(production, 'FIXED_REF_PLACEHOLDER_FORBIDDEN'), true);
});

test('fixed ref auditはMarkdown本文とYAMLコメントを実参照として誤検知しない', () => {
  const result = auditFixedRefs({
    files: [
      {
        path: 'docs/example.md',
        content: `This mentions uses: actions/checkout@main in prose.

\`\`\`text
uses: actions/checkout@main
\`\`\`

\`\`\`yaml
# uses: actions/checkout@main
jobs:
  ok:
    steps:
      - uses: actions/checkout@${RELEASE_SHA}
\`\`\`
`
      }
    ]
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(findCode(result, 'FIXED_REF_PINNED_SHA'), true);
});

test('CHANGELOGはUnreleased、重複version、日付、manifest capability、Migrationを検証する', () => {
  const valid = checkChangelog({
    source: changelog(),
    manifest: manifest(),
    packageVersion: '0.1.0'
  });
  const invalid = checkChangelog({
    source: `# Changelog

## [0.1.0] - 2026/07/14
## [0.1.0] - 2026/07/15
`,
    manifest: manifest({ migrationRequired: true }),
    packageVersion: 'bad'
  });

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
  assert.equal(findCode(invalid, 'CHANGELOG_UNRELEASED_MISSING'), true);
  assert.equal(findCode(invalid, 'CHANGELOG_VERSION_DUPLICATE'), true);
  assert.equal(findCode(invalid, 'CHANGELOG_DATE_INVALID'), true);
  assert.equal(findCode(invalid, 'CHANGELOG_MIGRATION_SECTION_MISSING'), true);
  assert.equal(findCode(invalid, 'PACKAGE_VERSION_INVALID'), true);
});

test('consumer update planは同一SHAをskipし、安全な更新計画を生成する', () => {
  const same = createConsumerUpdatePlan({
    manifest: manifest(),
    inventory: inventory({ consumer: { currentKitRef: RELEASE_SHA } })
  });
  const update = createConsumerUpdatePlan({
    manifest: manifest(),
    inventory: inventory()
  });

  assert.equal(same.ok, true);
  assert.equal(same.updates[0].needsUpdate, false);
  assert.equal(update.ok, true);
  assert.equal(update.updates[0].needsUpdate, true);
  assert.equal(update.updates[0].targetRef, RELEASE_SHA);
  assert.deepEqual(update.updates[0].filesToUpdate, [
    '.github/chatgpt-automation.yml',
    '.github/workflows/main-follow-up-events.yml',
    '.github/workflows/validate-config.yml'
  ]);
});

test('consumer update planはbreaking change、downgrade、mixed refs、重複repo、path traversal、mutable refをblockする', () => {
  const result = createConsumerUpdatePlan({
    manifest: manifest({ migrationRequired: true }),
    inventory: {
      schemaVersion: 1,
      consumers: [
        {
          repository: 'owner/example-repo',
          currentKitRef: 'main',
          configPath: '../escape.yml',
          callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
          callerWorkflows: [
            { path: '.github/workflows/validate-config.yml', currentKitRef: PREVIOUS_SHA },
            { path: '.github/workflows/main-follow-up-events.yml', currentKitRef: OTHER_SHA }
          ],
          updatePolicy: {
            direction: 'downgrade'
          }
        },
        {
          repository: 'owner/example-repo',
          currentKitRef: PREVIOUS_SHA
        }
      ]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(findCode(result, 'CONSUMER_CURRENT_REF_INVALID'), true);
  assert.equal(findCode(result, 'CONSUMER_PATH_TRAVERSAL'), true);
  assert.equal(findCode(result, 'CONSUMER_MIXED_REFS'), true);
  assert.equal(findCode(result, 'CONSUMER_DOWNGRADE_BLOCKED'), true);
  assert.equal(findCode(result, 'CONSUMER_REPOSITORY_DUPLICATE'), true);
  assert.equal(result.updates[0].manualReviewRequired, true);
});

test('release readiness planはmanifest、refs、changelog、source/dist、consumer計画をdeterministic JSONにまとめる', () => {
  const result = createReleaseReadinessPlan({
    manifest: manifest(),
    packageVersion: '0.1.0',
    changelogSource: changelog(),
    refAuditFiles: refAuditFiles(`jobs:\n  ok:\n    steps:\n      - uses: actions/checkout@${RELEASE_SHA}\n`),
    consumerInventory: inventory(),
    gitState: gitState(),
    repositoryInventory: repositoryInventory(),
    sourceDistStatus: { ok: true },
    dryRun: true
  });
  const text = JSON.stringify(result, null, 2);

  assert.equal(result.ready, true, text);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.releaseCommitSha, RELEASE_SHA);
  assert.equal(result.releaseTag, 'v0.1.0');
  assert.equal(result.consumerUpdates[0].targetRef, RELEASE_SHA);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.equal(text.includes('secret'), false);
});

test('release readiness planはsource/dist不一致や固定ref違反でblockする', () => {
  const result = createReleaseReadinessPlan({
    manifest: manifest(),
    packageVersion: '0.1.0',
    changelogSource: changelog(),
    refAuditFiles: refAuditFiles('jobs:\n  bad:\n    steps:\n      - uses: actions/checkout@main\n'),
    consumerInventory: inventory(),
    gitState: gitState(),
    repositoryInventory: repositoryInventory(),
    sourceDistStatus: { ok: false },
    dryRun: true
  });

  assert.equal(result.ready, false);
  assert.equal(findCode(result, 'FIXED_REF_MUTABLE_FORBIDDEN'), true);
  assert.equal(findCode(result, 'SOURCE_DIST_MISMATCH'), true);
});
