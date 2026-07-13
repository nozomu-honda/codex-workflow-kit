#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distFiles = Object.freeze(['index.js', 'package.json']);

export async function checkActionDist(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const nccCliPath = resolve(root, 'node_modules/@vercel/ncc/dist/ncc/cli.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'check-validate-config-dist-'));

  try {
    const build = spawnSync(process.execPath, [
      nccCliPath,
      'build',
      'actions/validate-config/src/index.js',
      '-o',
      tempDir,
      '--target',
      'es2022',
      '--minify',
      '--no-source-map-register',
      '--no-cache'
    ], {
      cwd: root,
      encoding: 'utf8'
    });

    if (build.status !== 0) {
      return {
        ok: false,
        reason: 'BUILD_FAILED',
        stdout: build.stdout,
        stderr: build.stderr,
        status: build.status ?? 1
      };
    }

    const committed = await readDistFiles(resolve(root, 'actions/validate-config/dist'));
    const rebuilt = await readDistFiles(tempDir);
    const comparison = compareActionDistFiles(committed, rebuilt);
    return {
      ok: comparison.ok,
      reason: comparison.ok ? 'OK' : 'DIST_OUT_OF_DATE',
      comparison
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function compareActionDistFiles(committed, rebuilt) {
  const changed = [];
  const missingCommitted = [];
  const missingRebuilt = [];

  for (const file of distFiles) {
    const committedContent = committed.get(file);
    const rebuiltContent = rebuilt.get(file);

    if (committedContent === undefined) {
      missingCommitted.push(file);
      continue;
    }

    if (rebuiltContent === undefined) {
      missingRebuilt.push(file);
      continue;
    }

    if (committedContent !== rebuiltContent) {
      changed.push(file);
    }
  }

  return {
    ok: changed.length === 0 && missingCommitted.length === 0 && missingRebuilt.length === 0,
    changed,
    missingCommitted,
    missingRebuilt
  };
}

async function readDistFiles(dir) {
  const entries = new Map();

  for (const file of distFiles) {
    try {
      entries.set(file, await readFile(resolve(dir, file), 'utf8'));
    } catch {
      entries.set(file, undefined);
    }
  }

  return entries;
}

async function main() {
  const result = await checkActionDist();

  if (result.reason === 'BUILD_FAILED') {
    process.stderr.write('Action dist check failed while rebuilding dist.\n');
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
    return;
  }

  if (!result.ok) {
    const details = result.comparison;
    process.stderr.write('actions/validate-config/dist is out of date. Run npm run build:action and commit the result.\n');
    process.stderr.write(`changed=${details.changed.join(',') || '-'} missingCommitted=${details.missingCommitted.join(',') || '-'} missingRebuilt=${details.missingRebuilt.join(',') || '-'}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('actions/validate-config/dist is up to date.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
