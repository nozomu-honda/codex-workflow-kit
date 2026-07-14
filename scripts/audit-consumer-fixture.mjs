#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import {
  LIVE_CONSUMER_WORKFLOW_SPECS,
  auditLiveConsumerInstallation,
  formatLiveConsumerAuditReport,
  validateLiveConsumerInventoryObject
} from '../packages/chatgpt-automation-core/src/consumer-audit/index.js';

const DEFAULT_INVENTORY = 'release/live-consumers.example.yml';
const CONFIG_TEMPLATE = 'templates/chatgpt-automation.yml';
const WORKFLOW_TEMPLATES = Object.freeze({
  'config-validation': 'templates/workflows/validate-config.yml',
  'event-normalization': 'templates/workflows/chatgpt-automation-events.yml',
  'review-routing-plan': 'templates/workflows/chatgpt-review-routing-events.yml',
  'auto-merge-plan': 'templates/workflows/reviewed-pr-auto-merge-events.yml',
  'main-follow-up-plan': 'templates/workflows/main-follow-up-events.yml'
});

export async function runAuditConsumerFixtureCli(argv = process.argv.slice(2), io = defaultIo()) {
  const json = argv.includes('--json');
  const help = argv.includes('--help') || argv.includes('-h');
  if (help) {
    io.stdout('Usage: node scripts/audit-consumer-fixture.mjs [--json]\n');
    return 0;
  }

  try {
    const inventorySource = await readFile(DEFAULT_INVENTORY, 'utf8');
    const document = YAML.parseDocument(inventorySource, { prettyErrors: false });
    if (document.errors.length > 0) {
      throw new Error('Invalid fixture inventory.');
    }
    const validation = validateLiveConsumerInventoryObject(document.toJS());
    if (!validation.ok) {
      throw new Error('Fixture inventory failed validation.');
    }
    const consumer = validation.consumers[0];
    const snapshot = await createFixtureSnapshot(consumer);
    const report = auditLiveConsumerInstallation({ consumer, snapshot });

    if (json) {
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stdout(formatLiveConsumerAuditReport(report));
    }
    return report.ok ? 0 : 1;
  } catch {
    io.stderr('Consumer fixture audit failed without exposing stack trace.\n');
    return 1;
  }
}

async function createFixtureSnapshot(consumer) {
  const files = {};
  const config = await readFile(CONFIG_TEMPLATE, 'utf8');
  files[consumer.configPath] = {
    status: 'ok',
    content: config,
    sha: 'fixture-config-sha',
    size: config.length
  };

  for (const capability of consumer.desiredCapabilitySet) {
    const spec = LIVE_CONSUMER_WORKFLOW_SPECS[capability];
    const templatePath = WORKFLOW_TEMPLATES[capability];
    if (!spec || !templatePath) {
      continue;
    }
    const source = (await readFile(templatePath, 'utf8'))
      .replaceAll('REPLACE_WITH_40_CHAR_COMMIT_SHA', consumer.expectedKitRef);
    files[spec.path] = {
      status: 'ok',
      content: source,
      sha: `${capability}-fixture-sha`,
      size: source.length
    };
  }

  return {
    repository: consumer.repository,
    defaultBranch: consumer.defaultBranch,
    defaultBranchStartSha: consumer.expectedKitRef,
    defaultBranchEndSha: consumer.expectedKitRef,
    files,
    apiErrors: []
  };
}

function defaultIo() {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAuditConsumerFixtureCli();
}
