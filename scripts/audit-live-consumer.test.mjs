import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubApiError,
  collectLiveConsumerSnapshot,
  createGitHubApiClient,
  getNextPath,
  githubRequestWithPagination,
  parseArgs,
  runAuditLiveConsumerCli
} from './audit-live-consumer.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKEN = 'dummy-token-for-test';
const CONFIG_SOURCE = await readFile(new URL('../templates/chatgpt-automation.yml', import.meta.url), 'utf8');
const WORKFLOW_SOURCE = (await readFile(new URL('../templates/workflows/validate-config.yml', import.meta.url), 'utf8'))
  .replaceAll('REPLACE_WITH_40_CHAR_COMMIT_SHA', SHA);

test('CLI help, default dry-run, --dry-run, --no-dry-run, and invalid option are stable', async () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--expected-kit-sha', SHA]).dryRun, true);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--expected-kit-sha', SHA, '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--repository', 'owner/example-repo', '--expected-kit-sha', SHA, '--no-dry-run']).ok, false);
  assert.deepEqual(parseArgs(['--repository', 'owner/example-repo', '--expected-kit-sha', SHA, '--allow-token-host', 'github.example.com']).allowedTokenHosts, ['github.example.com']);
  assert.equal(parseArgs(['--bad']).ok, false);

  const help = await runCli(['--help']);
  const bad = await runCli(['--repository', 'owner/example-repo', '--expected-kit-sha', SHA, '--no-dry-run']);

  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /audit-live-consumer/);
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /--no-dry-run/);
});

test('live audit CLI emits deterministic sanitized JSON and uses GET only', async () => {
  await withInventory(async (inventoryPath) => {
    const requests = [];
    const run = await runCli(['--inventory', inventoryPath, '--repository', 'owner/example-repo', '--json'], {
      fetchImpl: fakeGitHubFetch({ requests }),
      now: '2026-01-01T00:00:00.000Z',
      token: TOKEN
    });
    const report = JSON.parse(run.stdout);

    assert.equal(run.exitCode, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(report.ok, true);
    assert.equal(report.apiReadOk, true);
    assert.equal(report.paginationComplete, true);
    assert.equal(report.checkedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.detectedKitRefs, [SHA]);
    assert.equal(report.repository, 'owner/example-repo');
    assert.equal(requests.every((entry) => entry.method === 'GET'), true);
    assert.equal(requests.every((entry) => entry.redirect === 'error'), true);
    assert.equal(requests.some((entry) => entry.authorization === `Bearer ${TOKEN}`), true);
    assertNoUnsafeOutput(`${run.stdout}\n${run.stderr}`);
  });
});

test('collectLiveConsumerSnapshot fails closed on API read failure without throwing response bodies', async () => {
  const snapshot = await collectLiveConsumerSnapshot({
    apiUrl: 'https://api.github.com',
    consumer: consumer(),
    token: TOKEN,
    fetchImpl: async () => jsonResponse({ message: 'private details should not be logged' }, { status: 403 })
  });

  assert.equal(snapshot.apiErrors.length, 1);
  assert.equal(snapshot.apiErrors[0].code, 'api_permission_denied');
  assert.equal(JSON.stringify(snapshot).includes('private details'), false);
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
});

test('pagination reads page 2 and rejects cycles, external host, malformed next, and non-array payload', async () => {
  const pages = new Map([
    ['/repos/owner/example-repo/actions/workflows?per_page=100', {
      body: { workflows: [{ path: 'one.yml' }] },
      link: '<https://api.github.com/repos/owner/example-repo/actions/workflows?per_page=100&page=2>; rel="next"'
    }],
    ['/repos/owner/example-repo/actions/workflows?per_page=100&page=2', {
      body: { workflows: [{ path: 'two.yml' }] }
    }]
  ]);
  const ok = await githubRequestWithPagination({
    apiUrl: 'https://api.github.com',
    path: '/repos/owner/example-repo/actions/workflows?per_page=100',
    fetchImpl: paginatedFetch(pages),
    token: ''
  });
  assert.deepEqual(ok.map((entry) => entry.path), ['one.yml', 'two.yml']);
  assert.equal(getNextPath('<https://api.github.com/repos/owner/example-repo/actions/workflows?page=2>; rel="next"'), '/repos/owner/example-repo/actions/workflows?page=2');

  await assert.rejects(
    githubRequestWithPagination({
      apiUrl: 'https://api.github.com',
      path: '/repos/owner/example-repo/actions/workflows?per_page=100',
      fetchImpl: paginatedFetch(new Map([
        ['/repos/owner/example-repo/actions/workflows?per_page=100', {
          body: [],
          link: '<https://api.github.com/repos/owner/example-repo/actions/workflows?per_page=100>; rel="next"'
        }]
      ])),
      token: ''
    }),
    (error) => error instanceof GitHubApiError && error.code === 'pagination_cycle'
  );
  assert.throws(() => getNextPath('<https://evil.example/repos/owner/example-repo/actions/workflows?page=2>; rel="next"'), /host/);
  assert.throws(() => getNextPath('not-a-url; rel="next"'), /invalid/);
  await assert.rejects(
    githubRequestWithPagination({
      apiUrl: 'https://api.github.com',
      path: '/repos/owner/example-repo/actions/workflows?per_page=100',
      fetchImpl: paginatedFetch(new Map([
        ['/repos/owner/example-repo/actions/workflows?per_page=100', { body: { notWorkflows: true } }]
      ])),
      token: ''
    }),
    (error) => error instanceof GitHubApiError && error.code === 'pagination_invalid_response'
  );
});

test('GitHub API URL validation preserves GHES base path and rejects unsafe base URLs', async () => {
  for (const apiUrl of [
    'http://api.github.com',
    'https://user@api.github.com',
    'https://user:pass@api.github.com',
    'https://api.github.com?token=dummy',
    'https://api.github.com#fragment',
    'file:///tmp/github'
  ]) {
    assert.throws(() => createGitHubApiClient({
      apiUrl,
      fetchImpl: async () => jsonResponse({})
    }), (error) => error instanceof GitHubApiError && error.code === 'api_url_invalid');
  }

  const requests = [];
  const client = createGitHubApiClient({
    apiUrl: 'https://github.example.com/api/v3',
    fetchImpl: async (url, init) => {
      requests.push({
        path: `${url.pathname}${url.search}`,
        authorization: init.headers.authorization
      });
      return jsonResponse({ ok: true });
    },
    token: TOKEN
  });

  await client.get('/repos/owner/example-repo');
  assert.equal(requests[0].path, '/api/v3/repos/owner/example-repo');
  assert.equal(requests[0].authorization, undefined);
});

test('token forwarding is limited to GitHub.com or explicitly allowed GHES hosts', async () => {
  const githubRequests = [];
  await createGitHubApiClient({
    apiUrl: 'https://api.github.com/',
    fetchImpl: async (url, init) => {
      githubRequests.push(init.headers.authorization);
      return jsonResponse({ ok: true });
    },
    token: TOKEN
  }).get('/repos/owner/example-repo');
  assert.equal(githubRequests[0], `Bearer ${TOKEN}`);

  const ghesDenied = [];
  await createGitHubApiClient({
    apiUrl: 'https://github.example.com/api/v3/',
    fetchImpl: async (url, init) => {
      ghesDenied.push(init.headers.authorization);
      return jsonResponse({ ok: true });
    },
    token: TOKEN
  }).get('/repos/owner/example-repo');
  assert.equal(ghesDenied[0], undefined);

  const ghesAllowed = [];
  await createGitHubApiClient({
    apiUrl: 'https://github.example.com/api/v3/',
    allowedTokenHosts: ['github.example.com'],
    fetchImpl: async (url, init) => {
      ghesAllowed.push(init.headers.authorization);
      return jsonResponse({ ok: true });
    },
    token: TOKEN
  }).get('/repos/owner/example-repo');
  assert.equal(ghesAllowed[0], `Bearer ${TOKEN}`);
});

test('GHES pagination preserves base path and rejects base path escape', async () => {
  const ok = getNextPath(
    '<https://github.example.com/api/v3/repos/owner/example-repo/actions/workflows?page=2>; rel="next"',
    'https://github.example.com/api/v3'
  );
  assert.equal(ok, '/repos/owner/example-repo/actions/workflows?page=2');

  await assert.rejects(
    githubRequestWithPagination({
      apiUrl: 'https://github.example.com/api/v3',
      path: '/repos/owner/example-repo/actions/workflows?per_page=100',
      fetchImpl: paginatedFetch(new Map([
        ['/api/v3/repos/owner/example-repo/actions/workflows?per_page=100', {
          body: [],
          link: '<https://github.example.com/repos/owner/example-repo/actions/workflows?page=2>; rel="next"'
        }]
      ])),
      token: ''
    }),
    (error) => error instanceof GitHubApiError && error.code === 'pagination_base_path_escape'
  );
});

async function withInventory(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'live-consumer-audit-'));
  try {
    const inventoryPath = join(dir, 'inventory.yml');
    await mkdir(dirname(inventoryPath), { recursive: true });
    await writeFile(inventoryPath, `schemaVersion: 1
consumers:
  - repository: owner/example-repo
    defaultBranch: main
    configPath: .github/chatgpt-automation.yml
    callerWorkflowPaths:
      - .github/workflows/validate-config.yml
    expectedKitRef: "${SHA}"
    desiredCapabilitySet:
      - config-validation
    manualReviewRequired: false
`, 'utf8');
    await callback(inventoryPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args, dependencies = {}) {
  const output = { stdout: '', stderr: '' };
  const exitCode = await runAuditLiveConsumerCli(args, {
    stdout: (message) => { output.stdout += message; },
    stderr: (message) => { output.stderr += message; }
  }, dependencies);
  return { exitCode, ...output };
}

function fakeGitHubFetch(options = {}) {
  return async (url, init) => {
    const path = `${url.pathname}${url.search}`;
    options.requests?.push({
      path,
      method: init.method,
      redirect: init.redirect,
      authorization: init.headers.authorization
    });
    if (path === '/repos/owner/example-repo') {
      return jsonResponse({ full_name: 'owner/example-repo', default_branch: 'main' });
    }
    if (path === '/repos/owner/example-repo/git/ref/heads/main') {
      return jsonResponse({ object: { sha: SHA } });
    }
    if (path === `/repos/owner/example-repo/git/trees/${SHA}?recursive=1`) {
      return jsonResponse({
        truncated: false,
        tree: [
          { path: '.github/chatgpt-automation.yml', type: 'blob', sha: 'configsha', size: CONFIG_SOURCE.length },
          { path: '.github/workflows/validate-config.yml', type: 'blob', sha: 'workflowsha', size: WORKFLOW_SOURCE.length }
        ]
      });
    }
    if (path === `/repos/owner/example-repo/contents/.github/chatgpt-automation.yml?ref=${SHA}`) {
      return contentResponse(CONFIG_SOURCE, 'configsha');
    }
    if (path === `/repos/owner/example-repo/contents/.github/workflows/validate-config.yml?ref=${SHA}`) {
      return contentResponse(WORKFLOW_SOURCE, 'workflowsha');
    }
    if (path === '/repos/owner/example-repo/actions/workflows?per_page=100') {
      return jsonResponse({ workflows: [{ id: 1, name: 'Validate ChatGPT automation config', path: '.github/workflows/validate-config.yml', state: 'active' }] });
    }
    return jsonResponse({ message: 'not found' }, { status: 404 });
  };
}

function paginatedFetch(pages) {
  return async (url) => {
    const path = `${url.pathname}${url.search}`;
    const entry = pages.get(path);
    if (!entry) {
      return jsonResponse({ message: 'missing' }, { status: 404 });
    }
    return jsonResponse(entry.body, {
      headers: entry.link ? { link: entry.link } : undefined
    });
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

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {})
    }
  });
}

function consumer() {
  return {
    repository: 'owner/example-repo',
    defaultBranch: 'main',
    configPath: '.github/chatgpt-automation.yml',
    callerWorkflowPaths: ['.github/workflows/validate-config.yml'],
    expectedKitRef: SHA,
    desiredCapabilitySet: ['config-validation'],
    manualReviewRequired: false
  };
}

function assertNoUnsafeOutput(output) {
  assert.equal(output.includes(TOKEN), false);
  assert.equal(output.includes('authorization'), false);
  assert.equal(output.includes('PRIVATE_TOKEN'), false);
  assert.equal(output.includes('Bearer'), false);
  assert.equal(output.includes('C:\\'), false);
  assert.equal(/\n\s+at\s+/.test(output), false);
}
