#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_AUDIT_CONFIG_FILE,
  DEFAULT_AUDIT_WORKFLOW_FILE,
  auditConsumerInstallation,
  formatAuditResult
} from '../packages/chatgpt-automation-core/src/installation-audit/index.js';

const USAGE = `Usage:
  node scripts/audit-consumer-installation.mjs --root <consumer-repo> [options]

Options:
  --root <path>          Consumer repository root. Defaults to current directory.
  --config <path>        Config path relative to root. Defaults to ${DEFAULT_AUDIT_CONFIG_FILE}.
  --workflow <path>      Caller workflow path relative to root. Defaults to ${DEFAULT_AUDIT_WORKFLOW_FILE}.
  --expected-ref <sha>   Require the reusable workflow ref to match this 40-character commit SHA.
  --strict              Treat warnings as audit failures.
  --json                Print stable JSON result.
  --help, -h            Show this help.

The audit is read-only and does not call GitHub APIs, write files, run workflows, deploy, or merge.
`;

export async function runAuditConsumerInstallationCli(argv = process.argv.slice(2), io = defaultIo()) {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    io.stderr(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }

  try {
    const result = await auditConsumerInstallation({
      rootDir: parsed.root,
      configPath: parsed.config,
      workflowPath: parsed.workflow,
      expectedRef: parsed.expectedRef,
      strict: parsed.strict
    });

    if (parsed.json) {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout(formatAuditResult(result));
    }

    return result.ok ? 0 : 1;
  } catch {
    io.stderr('Installation audit failed unexpectedly without exposing stack trace.\n');
    return 1;
  }
}

export function parseArgs(argv) {
  const options = {
    ok: true,
    root: process.cwd(),
    config: DEFAULT_AUDIT_CONFIG_FILE,
    workflow: DEFAULT_AUDIT_WORKFLOW_FILE,
    expectedRef: undefined,
    strict: false,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--strict') {
      options.strict = true;
      continue;
    }

    if (arg === '--root' || arg === '--config' || arg === '--workflow' || arg === '--expected-ref') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return {
          ok: false,
          message: `${arg} requires a value.`
        };
      }
      index += 1;

      if (arg === '--root') {
        options.root = value;
      } else if (arg === '--config') {
        options.config = value;
      } else if (arg === '--workflow') {
        options.workflow = value;
      } else {
        options.expectedRef = value;
      }
      continue;
    }

    return {
      ok: false,
      message: `Unknown option: ${arg}`
    };
  }

  return options;
}

function defaultIo() {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAuditConsumerInstallationCli();
}
