#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeAutomationEvent } from '../packages/chatgpt-automation-core/src/events/index.js';

export async function runNormalizeEventCli(env = process.env, io = console) {
  const result = normalizeAutomationEvent({
    eventName: env.EVENT_NAME,
    eventAction: env.EVENT_ACTION,
    payload: env.EVENT_PAYLOAD_JSON,
    repository: env.REPOSITORY,
    repositoryOwner: env.REPOSITORY_OWNER,
    defaultBranch: env.DEFAULT_BRANCH,
    actor: env.ACTOR,
    refName: env.REF_NAME,
    sha: env.SHA,
    dryRun: env.DRY_RUN,
    permissionMode: env.PERMISSION_MODE,
    requestedCapability: env.REQUESTED_CAPABILITY,
    repositoryConfigJson: env.REPOSITORY_CONFIG_JSON
  });

  await writeOutputs(env.GITHUB_OUTPUT, result.outputs);

  if (result.ok) {
    io.log('event normalization: eligible');
  } else {
    io.log(`event normalization: ineligible (${result.outputs.ineligible_reason || 'unknown'})`);
  }

  return 0;
}

async function writeOutputs(outputPath, outputs) {
  if (!outputPath) {
    return;
  }

  const lines = [];
  for (const [name, value] of Object.entries(outputs)) {
    lines.push(`${name}=${value}`);
  }

  await appendFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runNormalizeEventCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    console.error('event normalization: failed closed');
    process.exitCode = 1;
  });
}
