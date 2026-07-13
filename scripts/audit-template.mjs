#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_AUDIT_CONFIG_FILE,
  DEFAULT_AUDIT_WORKFLOW_FILE,
  auditConsumerInstallation,
  formatAuditResult
} from '../packages/chatgpt-automation-core/src/installation-audit/index.js';

const TEMPLATE_CONFIG = 'templates/chatgpt-automation.yml';
const TEMPLATE_WORKFLOW = 'templates/workflows/validate-config.yml';
const DOGFOOD_REF = '0123456789abcdef0123456789abcdef01234567';

export async function runTemplateAudit(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const templateConfig = await readFile(join(cwd, TEMPLATE_CONFIG), 'utf8');
  const templateWorkflow = (await readFile(join(cwd, TEMPLATE_WORKFLOW), 'utf8'))
    .replaceAll('REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA', DOGFOOD_REF);
  const tempRoot = await mkdtemp(join(tmpdir(), 'chatgpt-automation-template-audit-'));

  try {
    await writeTempFile(tempRoot, DEFAULT_AUDIT_CONFIG_FILE, templateConfig);
    await writeTempFile(tempRoot, DEFAULT_AUDIT_WORKFLOW_FILE, templateWorkflow);

    return auditConsumerInstallation({
      rootDir: tempRoot,
      expectedRef: DOGFOOD_REF
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeTempFile(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runTemplateAudit();
    process.stdout.write(formatAuditResult(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    process.stderr.write('Template audit failed unexpectedly without exposing stack trace.\n');
    process.exitCode = 1;
  }
}
