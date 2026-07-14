#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createWriteCommandCandidateFromAutoMergePlan,
  createWriteCommandCandidatesFromMainFollowUpPlan,
  DisabledGitHubWriteAdapter,
  validateWriteCommand
} from '../packages/chatgpt-automation-core/src/github-write/index.js';

const DEFAULT_REQUESTED_AT = '1970-01-01T00:00:00.000Z';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = readPlan(args);
  const planType = args['plan-type'] || inferPlanType(plan);
  const operation = args.operation || '';
  const requestedAt = args['requested-at'] || DEFAULT_REQUESTED_AT;
  const actorContext = args['allow-fixture-trust'] === 'true' ? {
    actor: args.actor || 'local-plan',
    isFork: false,
    isTrusted: true,
    source: 'plan'
  } : undefined;
  const now = args.now || '';
  const adapter = new DisabledGitHubWriteAdapter();
  const candidates = createCandidates({ actorContext, now, operation, plan, planType, requestedAt });
  const commands = candidates.map((candidate) => candidate.command).filter(Boolean);
  const results = candidates
    .filter((candidate) => candidate.command)
    .map((candidate) => ({
      command: candidate.command,
      execution: adapter.execute(candidate.command, candidate.validationContext),
      validation: validateWriteCommand(candidate.command, candidate.validationContext)
    }));

  const output = {
    command_count: commands.length,
    commands,
    ok: commands.length > 0 && results.every((entry) => entry.validation.ok),
    plan_type: planType,
    reason_code: commands.length > 0 ? '' : firstReason(candidates) || 'no_write_command_candidate',
    results
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export function createCandidates({ actorContext, now, operation, plan, planType, requestedAt }) {
  if (planType === 'auto-merge') {
    return [
      createWriteCommandCandidateFromAutoMergePlan(plan, {
        actorContext,
        now,
        operation,
        requestedAt
      })
    ];
  }

  if (planType === 'main-follow-up') {
    return createWriteCommandCandidatesFromMainFollowUpPlan(plan, {
      actorContext,
      now,
      operation,
      requestedAt
    });
  }

  return [{ command: null, reasonCode: 'unsupported_plan_type' }];
}

function readPlan(args) {
  if (args.plan) {
    return JSON.parse(readFileSync(args.plan, 'utf8'));
  }
  if (args['plan-json']) {
    return JSON.parse(args['plan-json']);
  }
  throw new Error('plan input is required');
}

function inferPlanType(plan) {
  const outputs = plan?.outputs ?? plan ?? {};
  if ('should_merge' in outputs || 'should_enable_auto_merge' in outputs) {
    return 'auto-merge';
  }
  if ('plans_json' in outputs || 'update_candidate_count' in outputs) {
    return 'main-follow-up';
  }
  return 'unknown';
}

function firstReason(candidates) {
  return candidates.find((candidate) => candidate.reasonCode)?.reasonCode || '';
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
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
