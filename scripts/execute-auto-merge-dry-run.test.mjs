import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS
} from '../fixtures/github-events/index.js';
import { REVIEW_EVIDENCE_REPORT_VERSION } from '../packages/chatgpt-automation-core/src/auto-merge-executor/index.js';
import { runAuditLiveConsumerCli } from './audit-live-consumer.mjs';
import { runAuditRepositoryProtectionCli } from './audit-repository-protection.mjs';

const SCRIPT = 'scripts/execute-auto-merge-dry-run.mjs';
const NOW = '2026-01-01T00:10:00.000Z';
const CHECKED_AT = '2026-01-01T00:08:30.000Z';
const KIT_REF = FIXTURE_SHAS.base;
const CONFIG_SOURCE = readFileSync(new URL('../templates/chatgpt-automation.yml', import.meta.url), 'utf8');
const VALIDATE_CONFIG_WORKFLOW_SOURCE = readFileSync(new URL('../templates/workflows/validate-config.yml', import.meta.url), 'utf8')
  .replaceAll('REPLACE_WITH_40_CHAR_COMMIT_SHA', KIT_REF);
const POLICY_YAML = `defaultBranch: ${FIXTURE_REPOSITORY.defaultBranch}
requiredStatusChecks:
  - CI
  - Review evidence gate
requirePullRequest: true
minimumApprovals: 1
dismissStaleApprovals: true
requireCodeOwnerReview: false
requireLastPushApproval: true
requireConversationResolution: true
requireLinearHistory: false
requireSignedCommits: false
blockForcePush: true
blockDeletion: true
enforceAdmins: true
allowedMergeMethods:
  - squash
allowedBypassActors: []
requireReviewEvidenceGate: true
requireRuleset: false
`;

test('execute-auto-merge-dry-run CLIはfile入力からdeterministic JSONを返す', () => {
  const temp = writeInputs(baseInput());
  try {
    const result = runCli([
      ...fileArgs(temp.files),
      '--json'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.eligible, true);
    assert.equal(parsed.commandCreated, true);
    assert.equal(parsed.executed, false);
    assert.equal(parsed.reasonCodes.includes('write_disabled'), true);
  } finally {
    temp.cleanup();
  }
});

test('execute-auto-merge-dry-run CLIはvalidなblock decisionをexit 0でsanitized JSONとして返す', () => {
  const temp = writeInputs(baseInput({
    reviewEvidenceReport: {
      approved: false
    }
  }));
  try {
    const result = runCli([
      ...fileArgs(temp.files),
      '--json'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.eligible, false);
    assert.equal(parsed.reasonCodes.includes('review_evidence_missing'), true);
    assert.equal(parsed.commandCreated, false);
    assert.equal(parsed.adapterAccepted, false);
    assert.equal(parsed.executed, false);
  } finally {
    temp.cleanup();
  }
});

test('execute-auto-merge-dry-run CLIはJSON parse failureをsystem errorとしてnon-zeroにする', () => {
  const temp = writeInputs(baseInput());
  try {
    writeFileSync(temp.files['review-evidence'], '{invalid-json');
    const result = runCli([
      ...fileArgs(temp.files),
      '--json'
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /failed without exposing stack trace/);
  } finally {
    temp.cleanup();
  }
});

test('audit producer CLI JSON output can be parsed and passed to executor CLI', async () => {
  const consumerAuditReport = await runLiveConsumerAuditJson();
  const protectionAuditReport = await runProtectionAuditJson();
  const temp = writeInputs(baseInput({
    consumerAuditReport,
    protectionAuditReport
  }));
  try {
    const result = runCli([
      ...fileArgs(temp.files),
      '--json'
    ]);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(consumerAuditReport.apiReadOk, true);
    assert.equal(consumerAuditReport.paginationComplete, true);
    assert.equal(consumerAuditReport.auditedCommitSha, FIXTURE_SHAS.base);
    assert.equal(protectionAuditReport.apiReadOk, true);
    assert.equal(protectionAuditReport.paginationComplete, true);
    assert.equal(protectionAuditReport.auditedSha, FIXTURE_SHAS.base);
    assert.equal(parsed.eligible, true, JSON.stringify(parsed, null, 2));
    assert.equal(parsed.reasonCodes.includes('write_disabled'), true);
  } finally {
    temp.cleanup();
  }
});

test('execute-auto-merge-dry-run CLIは--no-dry-runを拒否する', () => {
  const result = runCli(['--no-dry-run']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--no-dry-run is not supported/);
});

function writeInputs(input) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-merge-dry-run-'));
  const files = {
    'auto-merge-plan': writeJson(dir, 'auto-merge-plan.json', input.autoMergePlan),
    'changed-files': writeJson(dir, 'changed-files.json', input.changedFilesSnapshot),
    checks: writeJson(dir, 'checks.json', input.checkSnapshot),
    'consumer-audit': writeJson(dir, 'consumer-audit.json', input.consumerAuditReport),
    'execution-context': writeJson(dir, 'execution-context.json', input.executionContext),
    'protection-audit': writeJson(dir, 'protection-audit.json', input.protectionAuditReport),
    'pull-request': writeJson(dir, 'pull-request.json', input.pullRequestSnapshot),
    'review-evidence': writeJson(dir, 'review-evidence.json', input.reviewEvidenceReport)
  };
  return {
    files,
    cleanup: () => rmSync(dir, { force: true, recursive: true })
  };
}

function writeJson(dir, name, value) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function fileArgs(files) {
  return Object.entries(files).flatMap(([name, file]) => [`--${name}`, file]);
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
}

function baseInput(overrides = {}) {
  return {
    autoMergePlan: {
      outputs: {
        base_sha: FIXTURE_SHAS.base,
        dedupe_key: `${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:enable-auto-merge:v1`,
        dry_run: 'true',
        eligible: 'true',
        head_sha: FIXTURE_SHAS.head,
        merge_reason: 'eligible_enable_auto_merge',
        pull_request_number: '42',
        repository: FIXTURE_REPOSITORY.fullName,
        should_enable_auto_merge: 'true',
        should_merge: 'false'
      }
    },
    changedFilesSnapshot: {
      apiReadOk: true,
      dangerousChange: false,
      files: [],
      headSha: FIXTURE_SHAS.head,
      pullRequestTarget: false,
      secretLikeChange: false,
      workflowPermissionIncrease: false
    },
    checkSnapshot: {
      apiReadOk: true,
      ciSuccessful: true,
      duplicateChecks: false,
      headSha: FIXTURE_SHAS.head,
      paginationComplete: true,
      requiredChecks: [
        {
          conclusion: 'success',
          headSha: FIXTURE_SHAS.head,
          name: 'CI',
          status: 'completed'
        },
        {
          conclusion: 'success',
          headSha: FIXTURE_SHAS.head,
          name: 'Review evidence gate',
          status: 'completed'
        }
      ],
      requiredChecksSuccessful: true,
      reviewEvidenceGateSuccessful: true
    },
    consumerAuditReport: {
      apiReadOk: true,
      auditedCommitSha: FIXTURE_SHAS.base,
      blockers: [],
      checkedAt: '2026-01-01T00:08:30.000Z',
      defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
      manualReviewRequired: false,
      paginationComplete: true,
      ready: true,
      repository: FIXTURE_REPOSITORY.fullName,
      reportVersion: 'live-consumer-audit.v1',
      warnings: []
    },
    executionContext: {
      actorContext: {
        actor: 'github-actions[bot]',
        isFork: false,
        isTrusted: true,
        source: 'auto-merge-dry-run'
      },
      allowedBaseBranches: [FIXTURE_REPOSITORY.defaultBranch],
      attemptCount: 0,
      cooldownSeconds: 0,
      currentBaseSha: FIXTURE_SHAS.base,
      currentHeadSha: FIXTURE_SHAS.head,
      existingIdempotencyKeys: [],
      maxAttempts: 3,
      now: NOW,
      pullRequestNumber: 42,
      repository: FIXTURE_REPOSITORY.fullName,
      requestedAt: NOW,
      requiredChecks: ['CI', 'Review evidence gate'],
      runStartedAt: '2026-01-01T00:09:00.000Z'
    },
    protectionAuditReport: {
      apiReadOk: true,
      auditedSha: FIXTURE_SHAS.base,
      blockers: [],
      checkedAt: '2026-01-01T00:08:30.000Z',
      defaultBranch: FIXTURE_REPOSITORY.defaultBranch,
      manualReviewRequired: false,
      paginationComplete: true,
      ready: true,
      repository: FIXTURE_REPOSITORY.fullName,
      reportVersion: 1,
      warnings: []
    },
    pullRequestSnapshot: {
      baseBranch: FIXTURE_REPOSITORY.defaultBranch,
      baseSha: FIXTURE_SHAS.base,
      draft: false,
      headSha: FIXTURE_SHAS.head,
      isFork: false,
      isSameRepository: true,
      mergeStateStatus: 'clean',
      mergeable: true,
      pullRequestNumber: 42,
      repository: FIXTURE_REPOSITORY.fullName,
      requestedReviewers: 0,
      requestedTeams: 0,
      state: 'open'
    },
    reviewEvidenceReport: {
      apiReadOk: true,
      approved: true,
      baseSha: FIXTURE_SHAS.base,
      blockers: [],
      changesRequested: false,
      checkedAt: '2026-01-01T00:08:30.000Z',
      currentRunEvidence: false,
      evidenceType: 'chatgpt-marker',
      headSha: FIXTURE_SHAS.head,
      paginationComplete: true,
      pullRequestNumber: 42,
      reportVersion: REVIEW_EVIDENCE_REPORT_VERSION,
      repository: FIXTURE_REPOSITORY.fullName,
      requestedReviewers: 0,
      requestedTeams: 0,
      reviewedAt: '2026-01-01T00:08:00.000Z',
      unresolvedReviewThreads: 0,
      warnings: [],
      ...(overrides.reviewEvidenceReport ?? {})
    }
  };
}

async function runLiveConsumerAuditJson() {
  const dir = mkdtempSync(join(tmpdir(), 'executor-live-audit-'));
  try {
    const inventoryPath = join(dir, 'inventory.yml');
    writeFileSync(inventoryPath, `schemaVersion: 1
consumers:
  - repository: ${FIXTURE_REPOSITORY.fullName}
    defaultBranch: ${FIXTURE_REPOSITORY.defaultBranch}
    configPath: .github/chatgpt-automation.yml
    callerWorkflowPaths:
      - .github/workflows/validate-config.yml
    expectedKitRef: "${KIT_REF}"
    desiredCapabilitySet:
      - config-validation
    expectedWorkflowNames:
      - Validate ChatGPT automation config
    manualReviewRequired: false
`, 'utf8');
    const output = { stdout: '', stderr: '' };
    const exitCode = await runAuditLiveConsumerCli([
      '--inventory',
      inventoryPath,
      '--repository',
      FIXTURE_REPOSITORY.fullName,
      '--json'
    ], {
      stdout: (message) => { output.stdout += message; },
      stderr: (message) => { output.stderr += message; }
    }, {
      fetchImpl: fakeLiveConsumerFetch(),
      now: CHECKED_AT,
      token: 'dummy-token'
    });
    assert.equal(exitCode, 0, `${output.stdout}\n${output.stderr}`);
    return JSON.parse(output.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runProtectionAuditJson() {
  const output = { stdout: '', stderr: '' };
  const exitCode = await runAuditRepositoryProtectionCli([
    '--repository',
    FIXTURE_REPOSITORY.fullName,
    '--json'
  ], {
    stdout: (message) => { output.stdout += message; },
    stderr: (message) => { output.stderr += message; }
  }, {
    fetchImpl: fakeProtectionFetch(),
    githubToken: 'dummy-token',
    now: CHECKED_AT,
    readFile: async () => POLICY_YAML
  });
  assert.equal(exitCode, 0, `${output.stdout}\n${output.stderr}`);
  return JSON.parse(output.stdout);
}

function fakeLiveConsumerFetch() {
  return async (url, init = {}) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    const path = `${url.pathname}${url.search}`;
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}`) {
      return jsonResponse({ full_name: FIXTURE_REPOSITORY.fullName, default_branch: FIXTURE_REPOSITORY.defaultBranch });
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/git/ref/heads/${FIXTURE_REPOSITORY.defaultBranch}`) {
      return jsonResponse({ object: { sha: FIXTURE_SHAS.base } });
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/git/trees/${FIXTURE_SHAS.base}?recursive=1`) {
      return jsonResponse({
        truncated: false,
        tree: [
          { path: '.github/chatgpt-automation.yml', type: 'blob', sha: 'configsha', size: CONFIG_SOURCE.length },
          { path: '.github/workflows/validate-config.yml', type: 'blob', sha: 'workflowsha', size: VALIDATE_CONFIG_WORKFLOW_SOURCE.length }
        ]
      });
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/contents/.github/chatgpt-automation.yml?ref=${FIXTURE_SHAS.base}`) {
      return contentResponse(CONFIG_SOURCE, 'configsha');
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/contents/.github/workflows/validate-config.yml?ref=${FIXTURE_SHAS.base}`) {
      return contentResponse(VALIDATE_CONFIG_WORKFLOW_SOURCE, 'workflowsha');
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/actions/workflows?per_page=100`) {
      return jsonResponse({
        workflows: [
          {
            id: 1,
            name: 'Validate ChatGPT automation config',
            path: '.github/workflows/validate-config.yml',
            state: 'active'
          }
        ]
      });
    }
    return jsonResponse({ message: 'not found' }, { status: 404 });
  };
}

function fakeProtectionFetch() {
  let branchProtectionReads = 0;
  return async (url, init = {}) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}`) {
      return jsonResponse({
        allow_auto_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        allow_squash_merge: true,
        default_branch: FIXTURE_REPOSITORY.defaultBranch,
        delete_branch_on_merge: true,
        full_name: FIXTURE_REPOSITORY.fullName,
        merge_queue_enabled: false
      });
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/branches/${FIXTURE_REPOSITORY.defaultBranch}`) {
      return jsonResponse({ commit: { sha: FIXTURE_SHAS.base } });
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/branches/${FIXTURE_REPOSITORY.defaultBranch}/protection`) {
      branchProtectionReads += 1;
      assert.equal(branchProtectionReads <= 2, true);
      return jsonResponse(branchProtection());
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/rulesets?targets=branch&per_page=100`) {
      return jsonResponse([rulesetSummary()]);
    }
    if (path === `/repos/${FIXTURE_REPOSITORY.fullName}/rulesets/101`) {
      return jsonResponse(rulesetDetail());
    }
    return jsonResponse({ message: 'not found' }, { status: 404 });
  };
}

function contentResponse(source, sha) {
  return jsonResponse({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(source, 'utf8').toString('base64'),
    sha,
    size: source.length
  });
}

function branchProtection() {
  return {
    allow_deletions: { enabled: false },
    allow_force_pushes: { enabled: false },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_last_push_approval: true,
      required_approving_review_count: 1
    },
    required_status_checks: {
      contexts: ['CI', 'Review evidence gate'],
      strict: true
    }
  };
}

function rulesetSummary() {
  return {
    enforcement: 'active',
    id: 101,
    name: 'protect-default-branch',
    target: 'branch',
    updated_at: '2026-01-01T00:00:00Z'
  };
}

function rulesetDetail() {
  return {
    ...rulesetSummary(),
    bypass_actors: [],
    conditions: {
      ref_name: {
        exclude: [],
        include: ['~DEFAULT_BRANCH']
      }
    },
    rules: [
      {
        parameters: {
          required_status_checks: [
            { context: 'CI', integration_id: 1 },
            { context: 'Review evidence gate', integration_id: 1 }
          ],
          strict_required_status_checks_policy: true
        },
        type: 'required_status_checks'
      },
      {
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: true
        },
        type: 'pull_request'
      },
      { type: 'deletion' },
      { type: 'non_fast_forward' }
    ]
  };
}

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {})
    }
  });
}
