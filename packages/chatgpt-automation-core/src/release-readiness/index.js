export const RELEASE_PLAN_VERSION = 'release-readiness.v1';
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_REF_PLACEHOLDER = 'REPLACE_WITH_40_CHAR_COMMIT_SHA';
export const LEGACY_RELEASE_REF_PLACEHOLDER = 'REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA';

export const RELEASE_CAPABILITIES = Object.freeze([
  'config-validation',
  'event-normalization',
  'review-routing-plan',
  'auto-merge-plan',
  'main-follow-up-plan'
]);

export const UNIMPLEMENTED_WRITE_CAPABILITIES = Object.freeze([
  'auto-merge-write',
  'branch-update-write',
  'codex-launch',
  'queue-issue-update'
]);

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA40_LOWER_PATTERN = /^[a-f0-9]{40}$/;
const SHA40_ANY_CASE_PATTERN = /^[a-fA-F0-9]{40}$/;
const SHORT_SHA_PATTERN = /^[a-fA-F0-9]{7,39}$/;
const MUTABLE_REFS = new Set(['main', 'master', 'develop', 'latest', 'head']);
const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'schemaVersion',
  'releaseVersion',
  'releaseCommitSha',
  'previousReleaseCommitSha',
  'releaseDate',
  'capabilities',
  'changedCapabilities',
  'breakingChanges',
  'migrationRequired',
  'actionArtifacts',
  'reusableWorkflows',
  'callerTemplates',
  'schemas',
  'rollbackCommitSha',
  'validationCommands'
]);
const OPTIONAL_MANIFEST_FIELDS = Object.freeze([
  'unimplementedWriteCapabilities'
]);

export function isValidSemVer(value) {
  return typeof value === 'string' && SEMVER_PATTERN.test(value);
}

export function isValidVersionTag(value) {
  return typeof value === 'string' && VERSION_TAG_PATTERN.test(value);
}

export function isValidReleaseSha(value) {
  return typeof value === 'string' && SHA40_LOWER_PATTERN.test(value);
}

export function classifyRef(value) {
  const ref = typeof value === 'string' ? value.trim() : '';

  if (isValidReleaseSha(ref)) {
    return 'sha40';
  }

  if (SHA40_ANY_CASE_PATTERN.test(ref)) {
    return 'uppercase-sha';
  }

  if (SHORT_SHA_PATTERN.test(ref)) {
    return 'short-sha';
  }

  if (isValidVersionTag(ref)) {
    return 'version-tag';
  }

  if (/^v\d+(\.\d+)?$/.test(ref)) {
    return 'partial-version-tag';
  }

  if (MUTABLE_REFS.has(ref.toLowerCase())) {
    return 'mutable';
  }

  if (ref === RELEASE_REF_PLACEHOLDER || ref === LEGACY_RELEASE_REF_PLACEHOLDER) {
    return 'placeholder';
  }

  return 'invalid';
}

export function compareSemVer(left, right) {
  if (!isValidSemVer(left) || !isValidSemVer(right)) {
    return null;
  }

  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }
    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return 0;
}

export function classifyVersionChange(previousVersion, releaseVersion) {
  if (!isValidSemVer(previousVersion) || !isValidSemVer(releaseVersion)) {
    return 'unknown';
  }

  const previous = previousVersion.split('.').map(Number);
  const release = releaseVersion.split('.').map(Number);

  if (release[0] > previous[0]) {
    return 'major';
  }
  if (release[1] > previous[1]) {
    return 'minor';
  }
  if (release[2] > previous[2]) {
    return 'patch';
  }
  if (release.every((part, index) => part === previous[index])) {
    return 'same';
  }
  return 'downgrade';
}

export function validateReleaseManifestObject(manifest) {
  const errors = [];
  const warnings = [];
  const checks = [];

  if (!isPlainObject(manifest)) {
    addError(errors, checks, 'RELEASE_MANIFEST_OBJECT_REQUIRED', 'Release manifest root must be an object.');
    return { ok: false, errors, warnings, checks };
  }

  const allowedFields = new Set([...REQUIRED_MANIFEST_FIELDS, ...OPTIONAL_MANIFEST_FIELDS]);
  for (const key of Object.keys(manifest)) {
    if (!allowedFields.has(key)) {
      addError(errors, checks, 'RELEASE_MANIFEST_UNKNOWN_KEY', 'Release manifest contains an unknown key.', { path: key });
    }
  }

  for (const key of REQUIRED_MANIFEST_FIELDS) {
    if (!Object.hasOwn(manifest, key)) {
      addError(errors, checks, 'RELEASE_MANIFEST_REQUIRED_FIELD_MISSING', 'Release manifest is missing a required field.', { path: key });
    }
  }

  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    addError(errors, checks, 'RELEASE_MANIFEST_SCHEMA_VERSION_UNSUPPORTED', 'Release manifest schemaVersion is unsupported.', { path: 'schemaVersion' });
  }

  if (!isValidSemVer(manifest.releaseVersion)) {
    addError(errors, checks, 'RELEASE_VERSION_INVALID', 'releaseVersion must be SemVer x.y.z.', { path: 'releaseVersion' });
  }

  validateShaField(manifest.releaseCommitSha, 'releaseCommitSha', errors, checks);
  validateShaField(manifest.previousReleaseCommitSha, 'previousReleaseCommitSha', errors, checks);
  validateShaField(manifest.rollbackCommitSha, 'rollbackCommitSha', errors, checks);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(manifest.releaseDate ?? ''))) {
    addError(errors, checks, 'RELEASE_DATE_INVALID', 'releaseDate must be YYYY-MM-DD.', { path: 'releaseDate' });
  }

  validateStringArray(manifest.capabilities, 'capabilities', errors, checks);
  validateStringArray(manifest.changedCapabilities, 'changedCapabilities', errors, checks);
  validateStringArray(manifest.validationCommands, 'validationCommands', errors, checks);
  validateManifestFileList(manifest.actionArtifacts, 'actionArtifacts', errors, checks);
  validateManifestFileList(manifest.reusableWorkflows, 'reusableWorkflows', errors, checks);
  validateManifestFileList(manifest.callerTemplates, 'callerTemplates', errors, checks);
  validateManifestFileList(manifest.schemas, 'schemas', errors, checks);

  for (const capability of manifest.capabilities ?? []) {
    if (UNIMPLEMENTED_WRITE_CAPABILITIES.includes(capability)) {
      addError(errors, checks, 'RELEASE_MANIFEST_UNIMPLEMENTED_WRITE_CAPABILITY', 'Release manifest must not list unimplemented write capability as released.', {
        path: 'capabilities'
      });
    }
  }

  const duplicates = findDuplicates(manifest.capabilities ?? []);
  for (const duplicate of duplicates) {
    addError(errors, checks, 'RELEASE_MANIFEST_DUPLICATE_CAPABILITY', 'Release manifest capability list contains duplicates.', {
      path: 'capabilities',
      value: duplicate
    });
  }

  if (manifest.migrationRequired === true && !hasMigrationEntry(manifest.breakingChanges)) {
    addError(errors, checks, 'RELEASE_MIGRATION_DETAILS_REQUIRED', 'migrationRequired=true requires a breakingChanges entry with migration notes.', {
      path: 'breakingChanges'
    });
  }

  if (Array.isArray(manifest.unimplementedWriteCapabilities)) {
    for (const capability of manifest.unimplementedWriteCapabilities) {
      if (!UNIMPLEMENTED_WRITE_CAPABILITIES.includes(capability)) {
        addWarning(warnings, checks, 'RELEASE_MANIFEST_UNKNOWN_UNIMPLEMENTED_CAPABILITY', 'unimplementedWriteCapabilities contains an unknown capability name.', {
          path: 'unimplementedWriteCapabilities'
        });
      }
    }
  }

  if (errors.length === 0) {
    addCheck(checks, 'RELEASE_MANIFEST_VALID', 'Release manifest is structurally valid.', 'pass');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks
  };
}

export function auditFixedRefs(options = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const files = Array.isArray(options.files) ? options.files : [];

  for (const file of files) {
    const path = normalizeRepositoryPath(file?.path);
    const source = typeof file?.content === 'string' ? file.content : '';
    const allowTemplatePlaceholder = path.startsWith('templates/workflows/');
    const entries = collectUsesEntries(source, path);

    for (const entry of entries) {
      if (entry.value.startsWith('./')) {
        addCheck(checks, 'FIXED_REF_LOCAL_USES_ALLOWED', 'Local reusable workflow reference is allowed.', 'pass', {
          file: path,
          path: `line:${entry.line}`
        });
        continue;
      }

      const parsed = parseUsesRef(entry.value);
      if (!parsed.ok) {
        addError(errors, checks, 'FIXED_REF_USES_MALFORMED', 'uses value must include an @ref unless it is a local ./ reference.', {
          file: path,
          path: `line:${entry.line}`
        });
        continue;
      }

      if (parsed.ref === RELEASE_REF_PLACEHOLDER && allowTemplatePlaceholder) {
        addCheck(checks, 'FIXED_REF_TEMPLATE_PLACEHOLDER_ALLOWED', 'Template placeholder is allowed only in caller templates.', 'pass', {
          file: path,
          path: `line:${entry.line}`
        });
        continue;
      }

      if (parsed.ref === RELEASE_REF_PLACEHOLDER || parsed.ref === LEGACY_RELEASE_REF_PLACEHOLDER) {
        addError(errors, checks, 'FIXED_REF_PLACEHOLDER_FORBIDDEN', 'Placeholder ref is forbidden outside approved templates.', {
          file: path,
          path: `line:${entry.line}`
        });
        continue;
      }

      const refType = classifyRef(parsed.ref);
      if (refType !== 'sha40') {
        addError(errors, checks, fixedRefCode(refType), 'External uses ref must be a reviewed 40-character lowercase commit SHA.', {
          file: path,
          path: `line:${entry.line}`
        });
        continue;
      }

      addCheck(checks, 'FIXED_REF_PINNED_SHA', 'External uses ref is pinned to a 40-character commit SHA.', 'pass', {
        file: path,
        path: `line:${entry.line}`
      });
    }
  }

  if (errors.length === 0) {
    addCheck(checks, 'FIXED_REF_AUDIT_OK', 'Fixed ref audit passed.', 'pass');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks
  };
}

export function checkChangelog(options = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const source = typeof options.source === 'string' ? options.source : '';
  const manifest = options.manifest;
  const packageVersion = options.packageVersion;

  if (!source.includes('## Unreleased')) {
    addError(errors, checks, 'CHANGELOG_UNRELEASED_MISSING', 'CHANGELOG.md must contain an Unreleased section.');
  } else {
    addCheck(checks, 'CHANGELOG_UNRELEASED_PRESENT', 'CHANGELOG.md contains an Unreleased section.', 'pass');
  }

  const versionHeadings = [...source.matchAll(/^## \[(\d+\.\d+\.\d+)] - ([^\n]+)$/gm)];
  const versions = versionHeadings.map((match) => match[1]);
  for (const duplicate of findDuplicates(versions)) {
    addError(errors, checks, 'CHANGELOG_VERSION_DUPLICATE', 'CHANGELOG.md contains a duplicate version heading.', {
      value: duplicate
    });
  }

  const invalidDates = [...source.matchAll(/^## \[\d+\.\d+\.\d+] - ([^\n]+)$/gm)]
    .filter((match) => !/^\d{4}-\d{2}-\d{2}$/.test(match[1]));
  for (const invalid of invalidDates) {
    addError(errors, checks, 'CHANGELOG_DATE_INVALID', 'CHANGELOG version dates must be YYYY-MM-DD.', {
      value: invalid[1]
    });
  }

  if (isPlainObject(manifest)) {
    for (const capability of manifest.changedCapabilities ?? []) {
      if (!source.includes(capability)) {
        addError(errors, checks, 'CHANGELOG_MANIFEST_CAPABILITY_MISSING', 'CHANGELOG.md must mention every changed capability from the release manifest.', {
          value: capability
        });
      }
    }

    if (manifest.migrationRequired === true && !/^### Migration$/m.test(source)) {
      addError(errors, checks, 'CHANGELOG_MIGRATION_SECTION_MISSING', 'CHANGELOG.md needs a Migration section when migrationRequired is true.');
    }
  }

  if (packageVersion !== undefined && !isValidSemVer(String(packageVersion))) {
    addError(errors, checks, 'PACKAGE_VERSION_INVALID', 'package.json version must be SemVer x.y.z.');
  }

  if (errors.length === 0) {
    addCheck(checks, 'CHANGELOG_VALID', 'CHANGELOG.md release policy checks passed.', 'pass');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks
  };
}

export function createConsumerUpdatePlan(options = {}) {
  const manifest = options.manifest;
  const inventory = options.inventory;
  const errors = [];
  const warnings = [];
  const checks = [];
  const updates = [];

  if (!isPlainObject(manifest) || !isValidReleaseSha(manifest.releaseCommitSha)) {
    addError(errors, checks, 'CONSUMER_TARGET_REF_INVALID', 'Consumer update planning requires a manifest releaseCommitSha.');
    return { ok: false, errors, warnings, checks, updates };
  }

  if (!isPlainObject(inventory)) {
    addError(errors, checks, 'CONSUMER_INVENTORY_OBJECT_REQUIRED', 'Consumer inventory root must be an object.');
    return { ok: false, errors, warnings, checks, updates };
  }

  const consumers = Array.isArray(inventory.consumers) ? inventory.consumers : [];
  if (!Array.isArray(inventory.consumers)) {
    addError(errors, checks, 'CONSUMER_INVENTORY_CONSUMERS_REQUIRED', 'Consumer inventory must contain a consumers array.');
  }

  const repositoryNames = new Set();
  for (const consumer of consumers) {
    const plan = planConsumerUpdate(consumer, manifest);
    updates.push(plan);

    if (!plan.repository) {
      addError(errors, checks, 'CONSUMER_REPOSITORY_INVALID', 'Consumer repository must be owner/name.', {
        path: 'consumers.repository'
      });
    } else if (repositoryNames.has(plan.repository)) {
      addError(errors, checks, 'CONSUMER_REPOSITORY_DUPLICATE', 'Consumer inventory contains duplicate repository entries.', {
        value: plan.repository
      });
    } else {
      repositoryNames.add(plan.repository);
    }

    for (const blocker of plan.blockers) {
      addError(errors, checks, blocker.code, blocker.message, {
        value: plan.repository
      });
    }
  }

  if (errors.length === 0) {
    addCheck(checks, 'CONSUMER_UPDATE_PLAN_OK', 'Consumer update plan was generated without blockers.', 'pass');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
    updates
  };
}

export function createReleaseReadinessPlan(options = {}) {
  const manifest = options.manifest ?? {};
  const manifestAudit = validateReleaseManifestObject(manifest);
  const fixedRefAudit = auditFixedRefs({ files: options.refAuditFiles ?? [] });
  const changelogAudit = checkChangelog({
    source: options.changelogSource ?? '',
    manifest,
    packageVersion: options.packageVersion
  });
  const consumerPlan = createConsumerUpdatePlan({
    manifest,
    inventory: options.consumerInventory ?? { consumers: [] }
  });
  const sourceDist = normalizeSourceDistStatus(options.sourceDistStatus);
  const blockers = [
    ...manifestAudit.errors,
    ...fixedRefAudit.errors,
    ...changelogAudit.errors,
    ...consumerPlan.errors,
    ...sourceDist.blockers
  ];
  const warnings = [
    ...manifestAudit.warnings,
    ...fixedRefAudit.warnings,
    ...changelogAudit.warnings,
    ...consumerPlan.warnings,
    ...sourceDist.warnings
  ];
  const checks = [
    ...manifestAudit.checks,
    ...fixedRefAudit.checks,
    ...changelogAudit.checks,
    ...consumerPlan.checks,
    ...sourceDist.checks
  ];
  const ready = blockers.length === 0;

  return stableObject({
    ok: ready,
    ready,
    dryRun: options.dryRun !== false,
    planVersion: RELEASE_PLAN_VERSION,
    releaseVersion: String(manifest.releaseVersion ?? ''),
    releaseTag: isValidSemVer(manifest.releaseVersion) ? `v${manifest.releaseVersion}` : '',
    releaseCommitSha: String(manifest.releaseCommitSha ?? ''),
    previousReleaseCommitSha: String(manifest.previousReleaseCommitSha ?? ''),
    rollbackCommitSha: String(manifest.rollbackCommitSha ?? ''),
    capabilities: stableArray(manifest.capabilities ?? []),
    changedCapabilities: stableArray(manifest.changedCapabilities ?? []),
    breakingChanges: normalizeBreakingChanges(manifest.breakingChanges),
    migrationRequired: manifest.migrationRequired === true,
    blockers,
    warnings,
    checks,
    consumerUpdates: consumerPlan.updates,
    validationCommands: stableArray(manifest.validationCommands ?? [])
  });
}

export function formatReleasePlan(result) {
  const lines = [];
  lines.push(`Release readiness: ${result.ready ? 'READY' : 'BLOCKED'}`);
  lines.push(`releaseVersion: ${result.releaseVersion}`);
  lines.push(`releaseCommitSha: ${result.releaseCommitSha}`);
  lines.push(`previousReleaseCommitSha: ${result.previousReleaseCommitSha}`);
  lines.push(`rollbackCommitSha: ${result.rollbackCommitSha}`);
  lines.push(`blockers: ${result.blockers.length}`);
  for (const blocker of result.blockers) {
    lines.push(`- ${blocker.code}: ${blocker.message}${formatIssueLocation(blocker)}`);
  }
  lines.push(`warnings: ${result.warnings.length}`);
  for (const warning of result.warnings) {
    lines.push(`- ${warning.code}: ${warning.message}${formatIssueLocation(warning)}`);
  }
  lines.push(`consumerUpdates: ${result.consumerUpdates.length}`);
  for (const update of result.consumerUpdates) {
    lines.push(`- ${update.repository}: ${update.needsUpdate ? `${update.currentRef} -> ${update.targetRef}` : 'no update'}${update.manualReviewRequired ? ' (manual review)' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function validateShaField(value, path, errors, checks) {
  if (!isValidReleaseSha(value)) {
    const code = SHA40_ANY_CASE_PATTERN.test(String(value ?? ''))
      ? 'RELEASE_SHA_UPPERCASE'
      : SHORT_SHA_PATTERN.test(String(value ?? ''))
        ? 'RELEASE_SHA_SHORT'
        : 'RELEASE_SHA_INVALID';
    addError(errors, checks, code, `${path} must be a 40-character lowercase commit SHA.`, { path });
  }
}

function validateStringArray(value, path, errors, checks) {
  if (!Array.isArray(value)) {
    addError(errors, checks, 'RELEASE_MANIFEST_ARRAY_REQUIRED', `${path} must be an array.`, { path });
    return;
  }

  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      addError(errors, checks, 'RELEASE_MANIFEST_STRING_REQUIRED', `${path} entries must be non-empty strings.`, {
        path: `${path}.${index}`
      });
    }
  }
}

function validateManifestFileList(value, path, errors, checks) {
  validateStringArray(value, path, errors, checks);
  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, entry] of value.entries()) {
    if (typeof entry === 'string' && !isSafeRepositoryPath(entry)) {
      addError(errors, checks, 'RELEASE_MANIFEST_PATH_INVALID', `${path} entries must stay inside the repository.`, {
        path: `${path}.${index}`
      });
    }
  }
}

function collectUsesEntries(source, filePath) {
  const entries = [];
  const lines = source.split(/\r?\n/);
  let inFence = false;
  let fencedLanguage = '';
  const isMarkdown = filePath.endsWith('.md');

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const fence = trimmed.match(/^```([A-Za-z0-9_-]*)/);
    if (isMarkdown && fence) {
      inFence = !inFence;
      fencedLanguage = inFence ? fence[1].toLowerCase() : '';
      continue;
    }

    if (isMarkdown && !inFence) {
      continue;
    }

    if (isMarkdown && inFence && fencedLanguage !== '' && !['yaml', 'yml'].includes(fencedLanguage)) {
      continue;
    }

    if (trimmed.startsWith('#')) {
      continue;
    }

    const match = line.match(/^\s*(?:-\s*)?uses\s*:\s*['"]?([^'"\s#]+)['"]?/);
    if (match) {
      entries.push({
        value: match[1],
        line: index + 1
      });
    }
  }

  return entries;
}

function parseUsesRef(value) {
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

function fixedRefCode(refType) {
  switch (refType) {
    case 'uppercase-sha':
      return 'FIXED_REF_UPPERCASE_SHA';
    case 'short-sha':
      return 'FIXED_REF_SHORT_SHA';
    case 'version-tag':
    case 'partial-version-tag':
      return 'FIXED_REF_VERSION_TAG_FORBIDDEN';
    case 'mutable':
      return 'FIXED_REF_MUTABLE_FORBIDDEN';
    default:
      return 'FIXED_REF_INVALID';
  }
}

function planConsumerUpdate(consumer, manifest) {
  const repository = normalizeRepositoryName(consumer?.repository);
  const currentRefs = collectConsumerRefs(consumer);
  const uniqueRefs = [...new Set(currentRefs)];
  const currentRef = typeof consumer?.currentKitRef === 'string' ? consumer.currentKitRef.trim() : uniqueRefs[0] ?? '';
  const targetRef = manifest.releaseCommitSha;
  const blockers = [];
  const filesToUpdate = collectConsumerFiles(consumer);
  const manualReviewRequired = Boolean(consumer?.manualReviewRequired) || manifest.migrationRequired === true;

  if (repository === '') {
    blockers.push(issue('CONSUMER_REPOSITORY_INVALID', 'Consumer repository must be owner/name.'));
  }

  if (!isValidReleaseSha(currentRef)) {
    blockers.push(issue('CONSUMER_CURRENT_REF_INVALID', 'Consumer currentKitRef must be a 40-character lowercase commit SHA.'));
  }

  if (uniqueRefs.length > 1) {
    blockers.push(issue('CONSUMER_MIXED_REFS', 'Consumer caller workflows must not mix kit refs.'));
  }

  if (filesToUpdate.some((path) => !isSafeRepositoryPath(path))) {
    blockers.push(issue('CONSUMER_PATH_TRAVERSAL', 'Consumer file paths must stay inside the repository.'));
  }

  if (consumer?.updatePolicy?.allowDowngrade !== true && consumer?.updatePolicy?.direction === 'downgrade') {
    blockers.push(issue('CONSUMER_DOWNGRADE_BLOCKED', 'Consumer downgrade requires explicit manual approval outside the plan.'));
  }

  const needsUpdate = currentRef !== targetRef;

  return stableObject({
    repository,
    currentRef,
    targetRef,
    needsUpdate,
    changedCapabilities: stableArray(manifest.changedCapabilities ?? []),
    migrationRequired: manifest.migrationRequired === true,
    filesToUpdate,
    validationCommands: stableArray(manifest.validationCommands ?? []),
    manualReviewRequired,
    blockers,
    rollbackRef: manifest.rollbackCommitSha
  });
}

function collectConsumerRefs(consumer) {
  if (Array.isArray(consumer?.callerWorkflows)) {
    return consumer.callerWorkflows
      .map((entry) => typeof entry?.currentKitRef === 'string' ? entry.currentKitRef.trim() : '')
      .filter(Boolean);
  }
  return typeof consumer?.currentKitRef === 'string' ? [consumer.currentKitRef.trim()] : [];
}

function collectConsumerFiles(consumer) {
  const paths = new Set();
  if (typeof consumer?.configPath === 'string') {
    paths.add(normalizeRepositoryPath(consumer.configPath));
  }
  for (const path of consumer?.callerWorkflowPaths ?? []) {
    if (typeof path === 'string') {
      paths.add(normalizeRepositoryPath(path));
    }
  }
  for (const workflow of consumer?.callerWorkflows ?? []) {
    if (typeof workflow?.path === 'string') {
      paths.add(normalizeRepositoryPath(workflow.path));
    }
  }
  return [...paths].sort();
}

function normalizeSourceDistStatus(status) {
  const checks = [];
  const blockers = [];
  const warnings = [];

  if (!isPlainObject(status)) {
    addError(blockers, checks, 'SOURCE_DIST_STATUS_MISSING', 'Source/dist status was not provided.');
    return { blockers, warnings, checks };
  }

  if (status.ok === true) {
    addCheck(checks, 'SOURCE_DIST_MATCH', 'Action source and dist are consistent.', 'pass');
    return { blockers, warnings, checks };
  }

  addError(blockers, checks, 'SOURCE_DIST_MISMATCH', 'Action source and dist must match before release.');
  return { blockers, warnings, checks };
}

function normalizeBreakingChanges(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (typeof entry === 'string') {
      return { description: entry };
    }
    if (isPlainObject(entry)) {
      return stableObject({
        description: String(entry.description ?? ''),
        migration: String(entry.migration ?? '')
      });
    }
    return { description: '' };
  });
}

function hasMigrationEntry(value) {
  return Array.isArray(value)
    && value.some((entry) => isPlainObject(entry) && typeof entry.migration === 'string' && entry.migration.trim() !== '');
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

function normalizeRepositoryName(value) {
  const repository = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : '';
}

function isSafeRepositoryPath(value) {
  const path = normalizeRepositoryPath(value);
  return path !== ''
    && path !== '.'
    && !path.startsWith('../')
    && path !== '..'
    && !path.includes('/../')
    && !/^[A-Za-z]:\//.test(path);
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

function stableArray(value) {
  return Array.isArray(value) ? [...value].map((entry) => String(entry)).sort() : [];
}

function stableObject(value) {
  if (!isPlainObject(value)) {
    return value;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (Array.isArray(entry)) {
      result[key] = entry.map((item) => stableObject(item));
    } else if (isPlainObject(entry)) {
      result[key] = stableObject(entry);
    } else {
      result[key] = entry;
    }
  }
  return result;
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

function formatIssueLocation(entry) {
  const parts = [];
  if (entry.file) {
    parts.push(entry.file);
  }
  if (entry.path) {
    parts.push(entry.path);
  }
  if (entry.value) {
    parts.push(entry.value);
  }
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
