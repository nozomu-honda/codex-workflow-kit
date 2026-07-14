import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPullRequestDetailWithMergeabilityRetry,
  getNextPath,
  hydratePullRequests,
  listPaginated,
  readGithubMainFollowUpContext,
  resolveTargetBaseShaForScan
} from './plan-main-follow-up.mjs';
import { createMainFollowUpPlan } from '../packages/chatgpt-automation-core/src/main-follow-up/index.js';
import {
  FIXTURE_FORK_REPOSITORY,
  FIXTURE_REPOSITORY,
  FIXTURE_SHAS,
  behindPr,
  mergedPr,
  pushDefaultBranch
} from '../fixtures/github-events/index.js';

const API = 'https://api.github.example';
const TOKEN = 'fixture-token';
const TARGET_BASE_SHA = FIXTURE_SHAS.after;

test('PR一覧レスポンスにmergeabilityがなくても個別PR詳細のmergeable trueを採用する', async () => {
  const { fetchImpl, calls } = mockFetch(routesForPullRequest({
    detail: prDetail({ mergeable: true, mergeable_state: 'clean' })
  }));
  const hydrated = await hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [prDetail({ mergeable: undefined, mergeable_state: undefined })],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  });
  const plan = createMainFollowUpPlan(baseInput({
    openPullRequests: hydrated,
    targetBaseSha: TARGET_BASE_SHA
  }));
  const entry = parsePlans(plan)[0];

  assert.equal(hydrated[0].mergeable, true);
  assert.equal(entry.action, 'behind-update-candidate');
  assert.equal(calls.some((path) => path === `/repos/${FIXTURE_REPOSITORY.fullName}/pulls/42`), true);
});

test('PR一覧レスポンスと個別詳細が不一致の場合は個別詳細を正本にする', async () => {
  const listShape = prDetail({
    baseSha: FIXTURE_SHAS.base,
    headSha: FIXTURE_SHAS.merge,
    mergeable: null,
    mergeable_state: 'unknown'
  });
  const detail = prDetail({
    headSha: FIXTURE_SHAS.head,
    mergeable: true,
    mergeable_state: 'clean'
  });
  const { fetchImpl } = mockFetch(routesForPullRequest({ detail }));
  const hydrated = await hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [listShape],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  });

  assert.equal(hydrated[0].head.sha, FIXTURE_SHAS.head);
  assert.equal(hydrated[0].base.sha, TARGET_BASE_SHA);
  assert.equal(hydrated[0].mergeable, true);
});

test('初回mergeable nullで2回目trueなら正常に分類する', async () => {
  const { fetchImpl } = mockFetch(routesForPullRequest({
    details: [
      prDetail({ mergeable: null, mergeable_state: 'unknown' }),
      prDetail({ mergeable: true, mergeable_state: 'clean' }),
      prDetail({ mergeable: true, mergeable_state: 'clean' })
    ]
  }));
  const hydrated = await hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [prDetail()],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  });
  const plan = createMainFollowUpPlan(baseInput({
    openPullRequests: hydrated,
    targetBaseSha: TARGET_BASE_SHA
  }));

  assert.equal(parsePlans(plan)[0].action, 'behind-update-candidate');
});

test('最大retry後もmergeable nullならmanual reviewになる', async () => {
  const detail = await fetchPullRequestDetailWithMergeabilityRetry({
    fetchImpl: mockFetch({
      [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/42`]: [
        response(prDetail({ mergeable: null, mergeable_state: 'unknown' })),
        response(prDetail({ mergeable: null, mergeable_state: 'unknown' })),
        response(prDetail({ mergeable: null, mergeable_state: 'unknown' }))
      ]
    }).fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    maxRetries: 2,
    number: 42,
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop
  });
  const plan = createMainFollowUpPlan(baseInput({
    openPullRequests: [{
      ...detail,
      changedFiles: [changedFile()],
      compare: comparison(),
      headBranchExists: true
    }],
    targetBaseSha: TARGET_BASE_SHA
  }));
  const entry = parsePlans(plan)[0];

  assert.equal(entry.action, 'manual-review-required');
  assert.equal(entry.skip_reason, 'mergeable_unknown');
});

test('個別PR詳細API失敗はfail closedのapi read errorへ渡せる', async () => {
  const { fetchImpl } = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/git/ref/heads/main`]: [
      response(gitRef(TARGET_BASE_SHA)),
      response(gitRef(TARGET_BASE_SHA))
    ],
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/42`]: response({ message: 'boom' }, { status: 500 })
  });

  await assert.rejects(() => readGithubMainFollowUpContext({
    baseBranch: 'main',
    defaultBranch: 'main',
    eventPayload: pushDefaultBranch({ after: TARGET_BASE_SHA }),
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    normalizedEvent: normalizedEvent(),
    openPullRequests: [prDetail()],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop
  }), /github_api_500/);

  assert.match(createMainFollowUpPlan(baseInput({
    apiReadError: 'github_api_500',
    openPullRequests: [],
    targetBaseSha: TARGET_BASE_SHA
  })).outputs.skip_reason, /github_api_read_failed:github_api_500/);
});

test('個別詳細取得後にhead/base/repository情報を正規化しfork判定も詳細レスポンス基準にする', async () => {
  const { fetchImpl } = mockFetch(routesForPullRequest({
    detail: prDetail({
      fork: true,
      headRepository: FIXTURE_FORK_REPOSITORY.fullName
    })
  }));
  const hydrated = await hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [prDetail({ fork: false })],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  });
  const entry = parsePlans(createMainFollowUpPlan(baseInput({
    openPullRequests: hydrated,
    targetBaseSha: TARGET_BASE_SHA
  })))[0];

  assert.equal(hydrated[0].head.repo.full_name, FIXTURE_FORK_REPOSITORY.fullName);
  assert.match(entry.skip_reason, /not_same_repository|fork_not_allowed/);
});

test('closedまたはmergedへ変化したPRは対象外にする', async () => {
  const { fetchImpl } = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/42`]: response(prDetail({
      merged: true,
      state: 'closed'
    }))
  });
  const hydrated = await hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [prDetail()],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  });

  assert.deepEqual(hydrated, []);
});

test('push eventのafterとnormalized head SHAが不一致ならfail closed', () => {
  assert.throws(() => resolveTargetBaseShaForScan({
    currentDefaultBranchSha: TARGET_BASE_SHA,
    eventPayload: pushDefaultBranch({ after: TARGET_BASE_SHA }),
    normalizedEvent: normalizedEvent({ head_sha: FIXTURE_SHAS.base })
  }), /base_sha_mismatch/);
});

test('compare URLはbranch名ではなく固定base SHAを使う', async () => {
  const { fetchImpl, calls } = mockFetch(routesForPullRequest({
    detail: prDetail()
  }));

  await hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [prDetail()],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  });

  assert.equal(calls.includes(`/repos/${FIXTURE_REPOSITORY.fullName}/compare/${TARGET_BASE_SHA}...${FIXTURE_SHAS.head}`), true);
  assert.equal(calls.some((path) => path.includes('/compare/main...')), false);
});

test('plan、global output、dedupe keyは同じtarget base SHAを使う', () => {
  const plan = createMainFollowUpPlan(baseInput({
    openPullRequests: [prDetail({ baseSha: TARGET_BASE_SHA })],
    targetBaseSha: TARGET_BASE_SHA
  }));
  const entry = parsePlans(plan)[0];

  assert.equal(plan.outputs.base_sha, TARGET_BASE_SHA);
  assert.equal(entry.base_sha, TARGET_BASE_SHA);
  assert.equal(entry.dedupe_key.includes(`:${TARGET_BASE_SHA}:main-follow-up`), true);
});

test('scan開始後にdefault branch SHAが変化したらfail closed', async () => {
  const { fetchImpl } = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/git/ref/heads/main`]: [
      response(gitRef(TARGET_BASE_SHA)),
      response(gitRef(FIXTURE_SHAS.base))
    ],
    ...routesForPullRequest({ detail: prDetail() })
  });

  await assert.rejects(() => readGithubMainFollowUpContext({
    baseBranch: 'main',
    defaultBranch: 'main',
    eventPayload: pushDefaultBranch({ after: TARGET_BASE_SHA }),
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    normalizedEvent: normalizedEvent(),
    openPullRequests: [prDetail()],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop
  }), /base_sha_changed_during_scan/);
});

test('PR詳細取得中にhead SHAが変化したらfail closed', async () => {
  await assert.rejects(() => fetchPullRequestDetailWithMergeabilityRetry({
    fetchImpl: mockFetch({
      [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/42`]: [
        response(prDetail({ mergeable: null })),
        response(prDetail({ headSha: FIXTURE_SHAS.merge, mergeable: true }))
      ]
    }).fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    number: 42,
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop
  }), /pull_request_head_changed_during_scan/);
});

test('PR詳細取得中にbase branchまたはbase repositoryが変化したらfail closed', async () => {
  const { fetchImpl } = mockFetch(routesForPullRequest({
    details: [
      prDetail({ mergeable: true }),
      prDetail({ baseRef: 'develop', mergeable: true })
    ]
  }));

  await assert.rejects(() => hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [prDetail()],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  }), /pull_request_base_changed_during_scan/);
});

test('workflow_dispatchではdefault branch SHAをAPI取得してtarget baseにする', async () => {
  const { fetchImpl } = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/git/ref/heads/main`]: [
      response(gitRef(TARGET_BASE_SHA)),
      response(gitRef(TARGET_BASE_SHA))
    ],
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?state=open&base=main&sort=created&direction=asc&per_page=100`]: response([])
  });
  const context = await readGithubMainFollowUpContext({
    baseBranch: 'main',
    defaultBranch: 'main',
    eventPayload: { inputs: { base_branch: 'main' } },
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    normalizedEvent: normalizedEvent({ event_name: 'workflow_dispatch', head_sha: '' }),
    openPullRequests: [],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop
  });

  assert.equal(context.targetBaseSha, TARGET_BASE_SHA);
});

test('merged PR triggerではmerge_commit_shaがcurrent default branchと一致する場合だけ使う', () => {
  assert.equal(resolveTargetBaseShaForScan({
    currentDefaultBranchSha: FIXTURE_SHAS.merge,
    eventPayload: mergedPr({ mergeSha: FIXTURE_SHAS.merge }),
    normalizedEvent: normalizedEvent({ event_name: 'pull_request', head_sha: FIXTURE_SHAS.merge })
  }), FIXTURE_SHAS.merge);

  assert.throws(() => resolveTargetBaseShaForScan({
    currentDefaultBranchSha: TARGET_BASE_SHA,
    eventPayload: mergedPr({ mergeSha: FIXTURE_SHAS.merge }),
    normalizedEvent: normalizedEvent({ event_name: 'pull_request', head_sha: FIXTURE_SHAS.merge })
  }), /base_sha_changed_during_scan/);
});

test('複数PRすべてが同じtarget base SHAで比較される', async () => {
  const { fetchImpl, calls } = mockFetch({
    ...routesForPullRequest({ detail: prDetail({ pullRequestNumber: 42 }) }),
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/43`]: [
      response(prDetail({ pullRequestNumber: 43 })),
      response(prDetail({ pullRequestNumber: 43 }))
    ],
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/43/files?per_page=100`]: response([changedFile()]),
    [`/repos/${FIXTURE_REPOSITORY.fullName}/compare/${TARGET_BASE_SHA}...${FIXTURE_SHAS.head}`]: [
      response(comparison()),
      response(comparison())
    ],
    [`/repos/${FIXTURE_REPOSITORY.fullName}/git/ref/heads/feature/example-change`]: [
      response(gitRef(FIXTURE_SHAS.head)),
      response(gitRef(FIXTURE_SHAS.head))
    ]
  });

  await hydratePullRequests({
    baseBranch: 'main',
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    pullRequests: [prDetail({ pullRequestNumber: 42 }), prDetail({ pullRequestNumber: 43 })],
    repository: FIXTURE_REPOSITORY.fullName,
    sleep: noop,
    targetBaseSha: TARGET_BASE_SHA
  });

  assert.equal(calls.filter((path) => path.startsWith(`/repos/${FIXTURE_REPOSITORY.fullName}/compare/${TARGET_BASE_SHA}...`)).length, 2);
});

test('paginationは正常な2ページ取得とrel nextなし終了を扱う', async () => {
  const twoPages = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`]: response([{ number: 1 }], {
      link: `<${API}/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1&page=2>; rel="next"`
    }),
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1&page=2`]: response([{ number: 2 }])
  });

  assert.deepEqual(await listPaginated({
    fetchImpl: twoPages.fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    path: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`
  }), [{ number: 1 }, { number: 2 }]);

  const onePage = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`]: response([{ number: 1 }])
  });
  assert.deepEqual(await listPaginated({
    fetchImpl: onePage.fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    path: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`
  }), [{ number: 1 }]);
});

test('paginationは同一next URLとA-B-A循環をrejectする', async () => {
  const sameUrl = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`]: response([], {
      link: `<${API}/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1>; rel="next"`
    })
  });
  await assert.rejects(() => listPaginated({
    fetchImpl: sameUrl.fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    path: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`
  }), /github_api_pagination_cycle/);

  const cycle = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`]: response([], {
      link: `<${API}/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1&page=2>; rel="next"`
    }),
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1&page=2`]: response([], {
      link: `<${API}/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1>; rel="next"`
    })
  });
  await assert.rejects(() => listPaginated({
    fetchImpl: cycle.fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    path: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`
  }), /github_api_pagination_cycle/);
});

test('paginationは最大ページ数超過をrejectする', async () => {
  const { fetchImpl } = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`]: response([], {
      link: `<${API}/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1&page=2>; rel="next"`
    })
  });

  await assert.rejects(() => listPaginated({
    fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    maxPages: 1,
    path: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`
  }), /github_api_pagination_page_limit_exceeded/);
});

test('paginationは外部host、不正URL、rel next解析不能、非配列responseをrejectする', async () => {
  assert.throws(() => getNextPath(`<https://evil.example/repos/${FIXTURE_REPOSITORY.fullName}/pulls?page=2>; rel="next"`, {
    expectedPathname: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls`,
    githubApiUrl: API
  }), /github_api_pagination_external_host/);
  assert.throws(() => getNextPath('<::::>; rel="next"', {
    expectedPathname: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls`,
    githubApiUrl: API
  }), /github_api_pagination_invalid_next_url/);
  assert.throws(() => getNextPath('rel="next"', {
    expectedPathname: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls`,
    githubApiUrl: API
  }), /github_api_invalid_link_header/);

  const nonArray = mockFetch({
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`]: response({ number: 1 })
  });
  await assert.rejects(() => listPaginated({
    fetchImpl: nonArray.fetchImpl,
    githubApiUrl: API,
    githubToken: TOKEN,
    path: `/repos/${FIXTURE_REPOSITORY.fullName}/pulls?per_page=1`
  }), /github_api_unexpected_list_response/);

  assert.match(createMainFollowUpPlan(baseInput({
    apiReadError: 'github_api_pagination_cycle',
    openPullRequests: [],
    targetBaseSha: TARGET_BASE_SHA
  })).outputs.skip_reason, /github_api_read_failed:github_api_pagination_cycle/);
});

function routesForPullRequest({ detail, details, pullRequestNumber = 42 }) {
  const pullRequest = detail ?? prDetail({ pullRequestNumber });
  const detailResponses = details
    ? details.map((entry) => response(entry))
    : [response(pullRequest), response(pullRequest)];

  return {
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/${pullRequestNumber}`]: detailResponses,
    [`/repos/${FIXTURE_REPOSITORY.fullName}/pulls/${pullRequestNumber}/files?per_page=100`]: response([changedFile()]),
    [`/repos/${FIXTURE_REPOSITORY.fullName}/compare/${TARGET_BASE_SHA}...${pullRequest.head.sha}`]: response(comparison()),
    [`/repos/${FIXTURE_REPOSITORY.fullName}/git/ref/heads/${pullRequest.head.ref}`]: response(gitRef(pullRequest.head.sha))
  };
}

function prDetail(options = {}) {
  const fork = options.fork === true;
  const pullRequest = behindPr({
    baseRef: options.baseRef ?? 'main',
    baseSha: options.baseSha ?? TARGET_BASE_SHA,
    fork,
    headSha: options.headSha ?? FIXTURE_SHAS.head,
    labels: options.labels ?? ['auto-merge-after-ci'],
    mergeable: Object.hasOwn(options, 'mergeable') ? options.mergeable : true,
    mergeStateStatus: options.merge_state ?? options.mergeStateStatus ?? 'clean',
    pullRequestNumber: options.pullRequestNumber ?? 42
  });

  return {
    ...pullRequest,
    base: {
      ...pullRequest.base,
      repo: {
        ...pullRequest.base.repo,
        full_name: options.baseRepository ?? FIXTURE_REPOSITORY.fullName
      },
      ref: options.baseRef ?? pullRequest.base.ref,
      sha: options.baseSha ?? pullRequest.base.sha
    },
    head: {
      ...pullRequest.head,
      repo: {
        ...pullRequest.head.repo,
        fork,
        full_name: options.headRepository ?? pullRequest.head.repo.full_name
      },
      sha: options.headSha ?? pullRequest.head.sha
    },
    mergeable_state: options.mergeable_state ?? options.mergeStateStatus ?? 'clean',
    merged: options.merged ?? false,
    state: options.state ?? 'open'
  };
}

function comparison(overrides = {}) {
  return {
    ahead_by: overrides.ahead_by ?? 1,
    base_commit: { sha: overrides.baseSha ?? TARGET_BASE_SHA },
    behind_by: overrides.behind_by ?? 1,
    merge_base_commit: { sha: overrides.mergeBaseSha ?? TARGET_BASE_SHA },
    status: overrides.status ?? 'behind'
  };
}

function changedFile(overrides = {}) {
  return {
    additions: overrides.additions ?? 1,
    changes: overrides.changes ?? 1,
    deletions: overrides.deletions ?? 0,
    filename: overrides.filename ?? 'docs/change.md',
    patch: overrides.patch ?? '+ok'
  };
}

function gitRef(sha) {
  return {
    object: { sha }
  };
}

function response(body, options = {}) {
  return {
    body,
    headers: options.link ? { link: options.link } : {},
    status: options.status ?? 200
  };
}

function mockFetch(routes) {
  const calls = [];
  const routeMap = new Map(Object.entries(routes).map(([path, value]) => [
    path,
    Array.isArray(value) ? [...value] : [value]
  ]));

  return {
    calls,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const path = `${parsed.pathname}${parsed.search}`;
      calls.push(path);
      const queue = routeMap.get(path);
      assert.ok(queue && queue.length > 0, `unexpected request: ${path}`);
      const item = queue.shift();

      return new Response(JSON.stringify(item.body), {
        headers: item.headers,
        status: item.status
      });
    }
  };
}

function baseInput(overrides = {}) {
  return {
    config: automationConfig(),
    eventPayload: pushDefaultBranch({ after: TARGET_BASE_SHA }),
    existingDedupeKeys: [],
    normalizedEvent: normalizedEvent(),
    now: '2026-01-01T00:00:00.000Z',
    openPullRequests: [prDetail()],
    ...overrides
  };
}

function automationConfig() {
  return {
    version: 1,
    baseBranch: 'main',
    ciWorkflowName: 'CI',
    dryRunDefault: true,
    features: {
      autoRequest: false,
      routeReview: false,
      autoMerge: false,
      mainFollowup: true,
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
    mainFollowUp: {
      enabled: true,
      dryRun: true,
      allowedBaseBranches: ['main'],
      requiredLabels: ['auto-merge-after-ci'],
      blockedLabels: ['do-not-merge', 'needs-codex-fix', 'codex-fix-in-progress', 'do-not-auto-codex-main-followup', 'codex-main-followup-in-progress'],
      allowDraft: false,
      requireSameRepository: true,
      allowFork: false,
      maxAttempts: 2,
      cooldownSeconds: 0,
      maxOpenPullRequests: 100,
      maxChangedFiles: 100,
      maxAdditions: 2000,
      maxDeletions: 2000,
      sensitivePathPatterns: ['.github/**', 'scripts/**', 'actions/**'],
      protectedPathPatterns: ['.github/**', 'scripts/**', 'actions/**'],
      workflowPathPatterns: ['.github/workflows/**', '.github/actions/**'],
      dependencyPathPatterns: ['package.json', 'package-lock.json'],
      generatedPathPatterns: ['actions/**/dist/**', '**/dist/**'],
      duplicatePolicy: 'dedupe-key',
      codexFollowUpEnabled: true
    },
    review: {
      markers: {
        approved: '<!-- chatgpt-review: approved -->',
        changesRequested: '<!-- chatgpt-review: changes_requested -->',
        reviewRequest: '<!-- chatgpt-review-request -->',
        ignoreInFencedCodeBlocks: true,
        excludeReviewRequestComments: true
      }
    },
    protectedFiles: { hardBlockPatterns: [], warningOnlyPatterns: [] },
    secretLike: { hardBlockPatterns: ['secret', 'token', 'authorization'], warningOnlyPatterns: [] },
    queues: { reviewFix: { enabled: false }, mainFollowup: { enabled: false } },
    codex: { reviewFix: { enabled: false }, mainFollowup: { enabled: false } },
    schedules: { reviewRequest: { enabled: false }, autoMerge: { enabled: false }, mainFollowup: { enabled: false }, actionsApproval: { enabled: false } },
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
  };
}

function normalizedEvent(overrides = {}) {
  return {
    default_branch: 'main',
    eligible: 'true',
    event_action: '',
    event_name: 'push',
    head_sha: TARGET_BASE_SHA,
    repository: FIXTURE_REPOSITORY.fullName,
    ...overrides
  };
}

function parsePlans(plan) {
  return JSON.parse(plan.outputs.plans_json);
}

function noop() {
  return Promise.resolve();
}
