#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  executeAutoMergeDryRun,
  formatAutoMergeDryRunDecision
} from '../packages/chatgpt-automation-core/src/auto-merge-executor/index.js';

async function main() {
  const exitCode = await runExecuteAutoMergeDryRunCli(process.argv.slice(2), {
    stderr: (message) => process.stderr.write(message),
    stdout: (message) => process.stdout.write(message)
  });
  process.exitCode = exitCode;
}

export async function runExecuteAutoMergeDryRunCli(argv = [], io = {}) {
  const stdout = io.stdout ?? (() => {});
  const stderr = io.stderr ?? (() => {});
  const args = parseArgs(argv);

  if (args.help) {
    stdout(usage());
    return 0;
  }

  if (!args.ok) {
    stderr(`${args.error}\n\n${usage()}`);
    return 2;
  }

  try {
    const decision = executeAutoMergeDryRun({
      autoMergePlan: readJsonArgument(args, 'auto-merge-plan'),
      changedFilesSnapshot: readJsonArgument(args, 'changed-files'),
      checkSnapshot: readJsonArgument(args, 'checks'),
      consumerAuditReport: readJsonArgument(args, 'consumer-audit'),
      executionContext: readJsonArgument(args, 'execution-context'),
      protectionAuditReport: readJsonArgument(args, 'protection-audit'),
      pullRequestSnapshot: readJsonArgument(args, 'pull-request'),
      reviewEvidenceReport: readJsonArgument(args, 'review-evidence')
    });

    stdout(args.json ? `${JSON.stringify(decision, null, 2)}\n` : formatAutoMergeDryRunDecision(decision));
    return 0;
  } catch {
    stderr('Auto-merge dry-run executor failed without exposing stack trace.\n');
    return 1;
  }
}

function readJsonArgument(args, name) {
  const inline = args[`${name}-json`];
  if (inline) {
    return JSON.parse(inline);
  }
  const path = args[name];
  if (path) {
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  return {};
}

function parseArgs(argv) {
  const result = {
    json: false,
    ok: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      return result;
    }
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (arg === '--no-dry-run') {
      return { ok: false, error: '--no-dry-run is not supported; executor is dry-run only.' };
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        return { ok: false, error: `${arg} requires a value.` };
      }
      result[key] = next;
      index += 1;
      continue;
    }
    return { ok: false, error: `Unexpected argument: ${arg}` };
  }

  return result;
}

function usage() {
  return `Usage: node scripts/execute-auto-merge-dry-run.mjs [options]

Required JSON inputs can be passed as --name <file> or --name-json <json>.

Inputs:
  --auto-merge-plan <file>
  --review-evidence <file>
  --consumer-audit <file>
  --protection-audit <file>
  --pull-request <file>
  --checks <file>
  --changed-files <file>
  --execution-context <file>

Options:
  --json       Emit deterministic JSON.
  --help       Show this help.

The executor is offline and dry-run only. It does not accept tokens, call GitHub
write APIs, merge PRs, enable auto-merge, comment, label, deploy, release, or tag.
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
