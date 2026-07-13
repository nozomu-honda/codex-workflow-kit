#!/usr/bin/env node
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAutomationConfig } from '../../../packages/chatgpt-automation-core/src/config/index.js';

export const DEFAULT_CONFIG_FILE = '.github/chatgpt-automation.yml';

export const ACTION_INPUTS = Object.freeze({
  configFile: 'config-file',
  dryRun: 'dry-run'
});

export const ACTION_OUTPUTS = Object.freeze([
  'ok',
  'error-count',
  'warning-count',
  'capabilities-json',
  'dry-run'
]);

const FALSE_CAPABILITIES = Object.freeze({
  autoRequest: false,
  routeReview: false,
  autoMerge: false,
  mainFollowup: false,
  actionsApproval: false
});

export async function runValidateConfigAction(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? defaultLogger();
  const configFile = getInput(env, ACTION_INPUTS.configFile, DEFAULT_CONFIG_FILE);
  const dryRun = parseDryRun(getInput(env, ACTION_INPUTS.dryRun, 'true'));
  const outputFile = options.outputFile ?? env.GITHUB_OUTPUT;

  logger.info(`validate-config: dry-run=${dryRun}; write operations are disabled.`);
  if (!dryRun) {
    logger.info('validate-config: dry-run=false was requested, but this action has no write capability.');
  }

  let result;

  try {
    const source = await readFile(resolve(cwd, configFile), 'utf8');
    result = validateAutomationConfig(source);
  } catch {
    result = failClosed([
      issue('configFile', 'CONFIG_READ_FAILED', 'Config file could not be read.')
    ]);
  }

  const outputs = toActionOutputs(result, dryRun);
  logIssues(logger, result);
  logResultSummary(logger, result);
  await writeActionOutputs(outputFile, outputs);

  return {
    exitCode: result.ok ? 0 : 1,
    outputs,
    result,
    dryRun,
    sideEffects: []
  };
}

export async function main() {
  const run = await runValidateConfigAction();
  if (run.exitCode !== 0) {
    process.exitCode = run.exitCode;
  }
}

function getInput(env, name, defaultValue) {
  const rawName = `INPUT_${name.toUpperCase()}`;
  const normalizedName = `INPUT_${name.replaceAll('-', '_').toUpperCase()}`;
  const value = env[rawName] ?? env[normalizedName];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}

function parseDryRun(value) {
  return String(value).trim().toLowerCase() !== 'false';
}

function toActionOutputs(result, dryRun) {
  return {
    ok: String(result.ok),
    'error-count': String(result.errors.length),
    'warning-count': String(result.warnings.length),
    'capabilities-json': JSON.stringify(safeCapabilities(result.capabilities)),
    'dry-run': String(dryRun)
  };
}

function safeCapabilities(capabilities) {
  return Object.fromEntries(
    Object.keys(FALSE_CAPABILITIES).map((key) => [key, capabilities?.[key] === true])
  );
}

function logIssues(logger, result) {
  for (const warning of result.warnings) {
    logger.warn(formatIssue('warning', warning));
  }

  for (const error of result.errors) {
    logger.error(formatIssue('error', error));
  }
}

function logResultSummary(logger, result) {
  if (result.ok) {
    logger.info(`validate-config: ok=true errors=${result.errors.length} warnings=${result.warnings.length}`);
  } else {
    logger.error(`validate-config: ok=false errors=${result.errors.length} warnings=${result.warnings.length}`);
  }
}

function formatIssue(level, entry) {
  return `validate-config: ${level} path=${safeToken(entry.path)} code=${safeToken(entry.code)} message=${safeMessage(entry.message)}`;
}

function safeToken(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '?');
}

function safeMessage(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ');
}

async function writeActionOutputs(outputFile, outputs) {
  if (!outputFile) {
    return;
  }

  await mkdir(dirname(outputFile), { recursive: true });
  const content = Object.entries(outputs)
    .map(([key, value]) => `${key}<<__chatgpt_automation_output__\n${value}\n__chatgpt_automation_output__`)
    .join('\n');
  await appendFile(outputFile, `${content}\n`, 'utf8');
}

function issue(path, code, message) {
  return { path, code, message };
}

function failClosed(errors, warnings = []) {
  return {
    ok: false,
    config: null,
    errors,
    warnings,
    capabilities: { ...FALSE_CAPABILITIES }
  };
}

function defaultLogger() {
  return {
    info: console.log,
    warn: console.warn,
    error: console.error
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
