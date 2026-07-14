import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewRoutingPlan, REVIEW_ROUTING_OUTPUT_NAMES, classifyActorTrust, createDedupeKey, detectReviewDecision, getLatestReviewDecision } from '../src/review-routing/index.js';

const REPOSITORY = 'owner/repo';
const OWNER = 'owner';
const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';

test('same-repo open PR、trusted actor、CI successならdry-run routing対象になる', () => {
  const plan = createReviewRoutingPlan(baseInput());

  assertRoute(plan, 'ci_success');
  assert.equal(plan.outputs.trigger_type, 'ci-success');
  assert.equal(plan.outputs.actor_trust, 'repository-owner');
  assert.equal(plan.outputs.ci_required, 'true');
  assert.equal(plan.outputs.ci_satisfied, 'true');
  assert.equal(plan.outputs.dry_run, 'true');
  assert.equal(plan.outputs.dedupe_key, `${REPOSITORY}#42:${HEAD_SHA}:ci-success:v1`);
});

test('review decision markerはfenced code blockとreview request commentを除外する', () => {
  const reviewConfig = automationConfig().review;

  assert.equal(detectReviewDecision({
    actor: 'reviewer',
    body: [
      '```md',
      '<!-- chatgpt-review: approved -->',
      '```'
    ].join('\n'),
    createdAt: '2026-01-01T00:00:00.000Z'
  }, reviewConfig), null);

  assert.equal(detectReviewDecision({
    actor: 'reviewer',
    body: [
      '<!-- chatgpt-review-request -->',
      '<!-- chatgpt-review: changes_requested -->'
    ].join('\n'),
    createdAt: '2026-01-01T00:00:00.000Z'
  }, reviewConfig), null);

  assert.deepEqual(detectReviewDecision({
    actor: 'reviewer',
    body: '<!-- chatgpt-review: approved -->',
    createdAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.invalid/review'
  }, reviewConfig), {
    decision: 'approved',
    reason: 'marker',
    actor: 'reviewer',
    url: 'https://example.invalid/review',
    timestamp: '2026-01-01T00:00:00.000Z'
  });
});

test('trusted-actors modeだけGitHub review stateとstatus headingを判定対象にする', () => {
  const markerOnly = automationConfig().review;
  const trusted = {
    ...markerOnly,
    decisionMode: 'trusted-actors',
    trustedActors: ['trusted-reviewer']
  };

  assert.equal(detectReviewDecision({
    actor: 'trusted-reviewer',
    reviewState: 'APPROVED',
    body: '',
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, markerOnly), null);
  assert.equal(detectReviewDecision({
    actor: 'external',
    reviewState: 'CHANGES_REQUESTED',
    body: '',
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, trusted), null);
  assert.equal(detectReviewDecision({
    actor: 'trusted-reviewer',
    reviewState: 'CHANGES_REQUESTED',
    body: '',
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, trusted)?.decision, 'changes_requested');
  assert.equal(detectReviewDecision({
    actor: 'trusted-reviewer',
    body: '## ChatGPT Review\n\nstatus: approved',
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, trusted)?.decision, 'approved');
});

test('latest changes_requestedがapprovedより新しければ最新判定として返す', () => {
  const latest = getLatestReviewDecision([
    {
      actor: 'reviewer',
      body: '<!-- chatgpt-review: approved -->',
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    {
      actor: 'reviewer',
      body: '<!-- chatgpt-review: changes_requested -->',
      createdAt: '2026-01-01T01:00:00.000Z'
    }
  ], automationConfig().review);

  assert.equal(latest.decision, 'changes_requested');
});

test('同一source内の競合review decisionはchanges_requestedとしてfail closedする', () => {
  const reviewConfig = automationConfig().review;
  const trustedConfig = {
    ...reviewConfig,
    decisionMode: 'trusted-actors',
    trustedActors: ['trusted-reviewer']
  };

  for (const body of [
    [
      '<!-- chatgpt-review: approved -->',
      '<!-- chatgpt-review: changes_requested -->'
    ].join('\n'),
    [
      '<!-- chatgpt-review: changes_requested -->',
      '<!-- chatgpt-review: approved -->'
    ].join('\n'),
    [
      '<!-- chatgpt-review: approved -->',
      '',
      '通常文を挟む',
      '',
      '<!-- chatgpt-review: changes_requested -->'
    ].join('\n')
  ]) {
    const decision = detectReviewDecision({
      actor: 'reviewer',
      body,
      createdAt: '2026-01-01T00:00:00.000Z'
    }, reviewConfig);
    assert.equal(decision.decision, 'changes_requested');
    assert.equal(decision.reason, 'ambiguous_review_decision');
  }

  assert.equal(detectReviewDecision({
    actor: 'reviewer',
    body: [
      '```md',
      '<!-- chatgpt-review: approved -->',
      '<!-- chatgpt-review: changes_requested -->',
      '```'
    ].join('\n'),
    createdAt: '2026-01-01T00:00:00.000Z'
  }, reviewConfig), null);

  assert.equal(detectReviewDecision({
    actor: 'reviewer',
    body: [
      '```md',
      '<!-- chatgpt-review: approved -->',
      '```',
      '<!-- chatgpt-review: approved -->',
      '<!-- chatgpt-review: changes_requested -->'
    ].join('\n'),
    createdAt: '2026-01-01T00:00:00.000Z'
  }, reviewConfig)?.decision, 'changes_requested');

  assert.equal(detectReviewDecision({
    actor: 'trusted-reviewer',
    body: '<!-- chatgpt-review: changes_requested -->',
    reviewState: 'APPROVED',
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, trustedConfig)?.decision, 'changes_requested');

  assert.equal(detectReviewDecision({
    actor: 'trusted-reviewer',
    body: '<!-- chatgpt-review: approved -->',
    reviewState: 'CHANGES_REQUESTED',
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, trustedConfig)?.decision, 'changes_requested');

  assert.equal(detectReviewDecision({
    actor: 'trusted-reviewer',
    body: [
      '<!-- chatgpt-review: approved -->',
      '## ChatGPT Review',
      'status: changes_requested'
    ].join('\n'),
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, trustedConfig)?.decision, 'changes_requested');

  assert.equal(detectReviewDecision({
    actor: 'trusted-reviewer',
    body: [
      '<!-- chatgpt-review: changes_requested -->',
      '## ChatGPT Review',
      'status: approved'
    ].join('\n'),
    submittedAt: '2026-01-01T00:00:00.000Z'
  }, trustedConfig)?.decision, 'changes_requested');

  assert.equal(detectReviewDecision({
    actor: 'reviewer',
    body: '<!-- chatgpt-review: approved -->',
    createdAt: '2026-01-01T00:00:00.000Z'
  }, reviewConfig)?.decision, 'approved');

  assert.equal(detectReviewDecision({
    actor: 'reviewer',
    body: '<!-- chatgpt-review: changes_requested -->',
    createdAt: '2026-01-01T00:00:00.000Z'
  }, reviewConfig)?.decision, 'changes_requested');
});

test('trusted review commandはrouting対象になる', () => {
  const plan = createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({
      event_name: 'pull_request_review_comment',
      event_action: 'created',
      workflow_name: '',
      workflow_conclusion: ''
    }),
    eventPayload: {
      comment: { body: '/chatgpt-review 再レビューしてください' }
    }
  }));

  assertRoute(plan, 'trusted_review_command');
  assert.equal(plan.outputs.trigger_type, 'trusted-review-command');
  assert.equal(plan.outputs.requested_command, '/chatgpt-review');
});

test('manual dispatch相当の明示requestをrouting対象にできる', () => {
  const plan = createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({
      event_name: 'workflow_dispatch',
      event_action: '',
      workflow_name: '',
      workflow_conclusion: ''
    })
  }));

  assertRoute(plan, 'manual_review_request');
  assert.equal(plan.outputs.trigger_type, 'manual-review-request');
});

test('fork PRはfail closedでroutingしない', () => {
  const plan = createReviewRoutingPlan(baseInput({
    pullRequest: pullRequest({ headRepository: 'fork/repo', fork: true }),
    normalizedEvent: normalizedEvent({ head_repository: 'fork/repo', is_same_repository: 'false', is_fork: 'true' })
  }));

  assertSkip(plan, /not_same_repository|fork_not_allowed/);
  assert.equal(plan.outputs.is_fork, 'true');
});

test('unknown actorやGitHub Actions botはroutingしない', () => {
  const external = createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({ actor: 'external-user' })
  }));
  const bot = createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({ actor: 'github-actions[bot]' })
  }));

  assertSkip(external, /actor_not_trusted/);
  assert.equal(external.outputs.actor_trust, 'external-actor');
  assertSkip(bot, /actor_not_trusted:github-actions-bot|bot_loop_actor/);
});

test('Draft禁止、base不一致、head SHA不一致、closed PRはroutingしない', () => {
  assertSkip(createReviewRoutingPlan(baseInput({ pullRequest: pullRequest({ draft: true }) })), /draft_not_allowed/);
  assertSkip(createReviewRoutingPlan(baseInput({ pullRequest: pullRequest({ baseRef: 'develop' }) })), /base_branch_not_allowed/);
  assertSkip(createReviewRoutingPlan(baseInput({ pullRequest: pullRequest({ headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) })), /head_sha_mismatch/);
  assertSkip(createReviewRoutingPlan(baseInput({ pullRequest: pullRequest({ state: 'closed' }) })), /pull_request_not_open/);
});

test('unsupported event/action、normalizer不適格、config不正、API read失敗はroutingしない', () => {
  assertSkip(createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({ event_name: 'push', workflow_name: '', workflow_conclusion: '' })
  })), /unsupported_trigger/);
  assertSkip(createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({ eligible: 'false', ineligible_reason: 'pull request issue_comment provenance is not verified' })
  })), /normalized_event_ineligible/);
  assertSkip(createReviewRoutingPlan(baseInput({ config: { reviewRouting: { enabled: true } } })), /config_invalid/);
  assertSkip(createReviewRoutingPlan(baseInput({ apiReadError: 'github_api_403' })), /github_api_read_failed/);
});

test('CI失敗、pending、required workflow不一致はroutingしない', () => {
  assertSkip(createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({ workflow_conclusion: 'failure' })
  })), /required_ci_not_satisfied/);
  assertSkip(createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({ workflow_conclusion: '' })
  })), /required_ci_not_satisfied/);
  assertSkip(createReviewRoutingPlan(baseInput({
    normalizedEvent: normalizedEvent({ workflow_name: 'Other' })
  })), /required_ci_not_satisfied/);
});

test('dangerous file、secret-like追加行、diff上限超過はroutingしない', () => {
  assertSkip(createReviewRoutingPlan(baseInput({
    changedFiles: [{ filename: '.github/workflows/ci.yml', additions: 1, deletions: 0, patch: '+name: CI' }]
  })), /sensitive_changed_file/);
  assertSkip(createReviewRoutingPlan(baseInput({
    changedFiles: [{ filename: 'docs/test.md', additions: 1, deletions: 0, patch: '+const token = "dummy";' }]
  })), /secret_like_added_line/);
  assertSkip(createReviewRoutingPlan(baseInput({
    changedFiles: Array.from({ length: 101 }, (_, index) => ({ filename: `docs/${index}.md`, additions: 1, deletions: 0, patch: '+ok' }))
  })), /changed_files_limit_exceeded/);
  assertSkip(createReviewRoutingPlan(baseInput({
    changedFiles: [{ filename: 'docs/large.md', additions: 2001, deletions: 0, patch: '+ok' }]
  })), /diff_additions_limit_exceeded/);
});

test('duplicate keyとcooldown中はroutingしない', () => {
  const dedupeKey = createDedupeKey({
    repository: REPOSITORY,
    pullRequestNumber: '42',
    headSha: HEAD_SHA,
    triggerType: 'ci-success',
    configVersion: 1
  });
  const duplicate = createReviewRoutingPlan(baseInput({
    existingDedupeKeys: [dedupeKey]
  }));
  const cooldown = createReviewRoutingPlan(baseInput({
    lastRoutedAt: '2026-01-01T00:00:00.000Z',
    now: '2026-01-01T00:05:00.000Z',
    config: automationConfig({ reviewRouting: { cooldownSeconds: 600 } })
  }));

  assertSkip(duplicate, /duplicate_suppressed/);
  assert.equal(duplicate.outputs.duplicate_suppressed, 'true');
  assertSkip(cooldown, /cooldown_active/);
  assert.equal(cooldown.outputs.cooldown_active, 'true');
});

test('actor trust分類はowner、collaborator、member、allowlist、fork author、externalを区別する', () => {
  assert.equal(classifyActorTrust({ actor: OWNER, repositoryOwner: OWNER }), 'repository-owner');
  assert.equal(classifyActorTrust({ actor: 'dev', repositoryOwner: OWNER, actorInfo: { permission: 'write' } }), 'collaborator');
  assert.equal(classifyActorTrust({ actor: 'member', repositoryOwner: OWNER, actorInfo: { isOrganizationMember: true } }), 'organization-member');
  assert.equal(classifyActorTrust({ actor: 'trusted', repositoryOwner: OWNER, config: { trustedHumanActors: ['trusted'], trustedBotActors: [] } }), 'allowlisted-human');
  assert.equal(classifyActorTrust({ actor: 'bot[bot]', repositoryOwner: OWNER, config: { trustedHumanActors: [], trustedBotActors: ['bot[bot]'] } }), 'allowlisted-bot');
  assert.equal(classifyActorTrust({ actor: 'author', repositoryOwner: OWNER, pullRequest: { isFork: true, author: 'author' } }), 'fork-author');
  assert.equal(classifyActorTrust({ actor: 'someone', repositoryOwner: OWNER }), 'external-actor');
});

function assertRoute(plan, reason) {
  assert.equal(plan.ok, true);
  assert.equal(plan.outputs.should_route, 'true');
  assert.equal(plan.outputs.eligible, 'true');
  assert.equal(plan.outputs.route_reason, reason);
  assert.deepEqual(Object.keys(plan.outputs).sort(), REVIEW_ROUTING_OUTPUT_NAMES.toSorted());
}

function assertSkip(plan, reasonPattern) {
  assert.equal(plan.ok, false);
  assert.equal(plan.outputs.should_route, 'false');
  assert.match(plan.outputs.skip_reason, reasonPattern);
  assert.deepEqual(Object.keys(plan.outputs).sort(), REVIEW_ROUTING_OUTPUT_NAMES.toSorted());
}

function baseInput(overrides = {}) {
  return {
    normalizedEvent: normalizedEvent(),
    eventPayload: {},
    config: automationConfig(),
    pullRequest: pullRequest(),
    changedFiles: [{ filename: 'docs/change.md', additions: 1, deletions: 0, patch: '+ok' }],
    actorInfo: {},
    ...overrides
  };
}

function automationConfig(overrides = {}) {
  return {
    ...overrides,
    version: 1,
    baseBranch: 'master',
    ciWorkflowName: 'CI',
    dryRunDefault: true,
    features: {
      routeReview: true
    },
    reviewRouting: {
      enabled: true,
      dryRun: true,
      allowedBaseBranches: ['master'],
      acceptedTriggerTypes: ['ci-success', 'trusted-review-command', 'manual-review-request'],
      commands: ['/chatgpt-review'],
      requestLabels: ['needs-chatgpt-review'],
      trustedHumanActors: [],
      trustedBotActors: [],
      allowDraft: false,
      allowFork: false,
      requireSameRepository: true,
      requiredWorkflows: ['CI'],
      ignoredPathPatterns: [],
      sensitivePathPatterns: ['.github/**', 'scripts/**', 'packages/**', 'schemas/**', 'templates/**'],
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      cooldownSeconds: 0,
      duplicatePolicy: 'dedupe-key',
      ...overrides.reviewRouting
    }
  };
}

function normalizedEvent(overrides = {}) {
  return {
    event_name: 'workflow_run',
    event_action: 'completed',
    repository: REPOSITORY,
    repository_owner: OWNER,
    default_branch: 'master',
    actor: OWNER,
    issue_number: '',
    pull_request_number: '42',
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
    head_repository: REPOSITORY,
    is_same_repository: 'true',
    is_fork: 'false',
    workflow_name: 'CI',
    workflow_conclusion: 'success',
    dry_run: 'true',
    eligible: 'true',
    ineligible_reason: '',
    ...overrides
  };
}

function pullRequest(overrides = {}) {
  const headRepository = overrides.headRepository ?? REPOSITORY;
  const headSha = overrides.headSha ?? HEAD_SHA;

  return {
    number: 42,
    state: overrides.state ?? 'open',
    draft: overrides.draft ?? false,
    user: { login: overrides.author ?? OWNER },
    head: {
      sha: headSha,
      ref: 'feature/test',
      repo: {
        full_name: headRepository,
        fork: overrides.fork ?? false
      }
    },
    base: {
      ref: overrides.baseRef ?? 'master',
      sha: BASE_SHA,
      repo: {
        full_name: REPOSITORY
      }
    }
  };
}
