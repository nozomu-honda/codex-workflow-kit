#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createReplaySnapshot,
  replayScenarios
} from '../packages/chatgpt-automation-core/src/auto-merge-regressions/index.js';
import { buildAutoMergeRegressionScenarios } from '../fixtures/auto-merge-regressions/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '../fixtures/auto-merge-regressions/snapshots/auto-merge-regressions.snapshot.json');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const replay = replayScenarios(buildAutoMergeRegressionScenarios(), {
    category: args.category,
    id: args.id
  });
  const snapshot = createReplaySnapshot(replay);
  const expectedSnapshot = filterSnapshot(readSnapshot(), args);
  const snapshotMatches = stableJson(snapshot) === stableJson(expectedSnapshot);
  const output = {
    ok: replay.ok && snapshotMatches,
    snapshotMatches,
    ...snapshot
  };

  if (args['update-snapshots']) {
    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    output.snapshotMatches = true;
    output.ok = replay.ok;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(formatText(output));
  }

  if (!output.ok) {
    process.exitCode = 1;
  }
}

function readSnapshot() {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function filterSnapshot(snapshot, args) {
  if (!snapshot.scenarioResults || (!args.id && !args.category)) {
    return snapshot;
  }

  const scenarioResults = snapshot.scenarioResults
    .filter((entry) => !args.id || entry.id === args.id)
    .filter((entry) => !args.category || entry.category === args.category);

  return {
    scenarioResults,
    summary: {
      failed: scenarioResults.filter((entry) => entry.result?.eligible === false && false).length,
      passed: scenarioResults.length,
      total: scenarioResults.length
    }
  };
}

function formatText(output) {
  const lines = [];
  lines.push(`Auto-merge regression replay: ${output.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`total: ${output.summary.total}`);
  lines.push(`passed: ${output.summary.passed}`);
  lines.push(`failed: ${output.summary.failed}`);
  lines.push(`snapshotMatches: ${output.snapshotMatches}`);
  for (const entry of output.scenarioResults) {
    const result = entry.result;
    lines.push(`- ${entry.id}: ${entry.ok === false ? 'FAIL' : 'PASS'} eligible=${result.eligible} commandCreated=${result.commandCreated} adapterCalled=${result.adapterCalled} executed=${result.executed} dryRun=${result.dryRun} reasons=${result.reasonCodes.join(',') || '(none)'}`);
    for (const error of entry.errors ?? []) {
      lines.push(`  error: ${error.code}${error.path ? ` (${error.path})` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])])
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
