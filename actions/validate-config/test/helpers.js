import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import {
  DEFAULT_CONFIG_FILE,
  runValidateConfigAction
} from '../src/index.js';

const SAMPLE_CONFIG = new URL('../../../templates/chatgpt-automation.yml', import.meta.url);
const ACTION_METADATA = new URL('../action.yml', import.meta.url);

export async function withTempRepo(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'validate-config-action-'));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeConfig(dir, source) {
  const path = join(dir, DEFAULT_CONFIG_FILE);
  await mkdir(join(dir, '.github'), { recursive: true });
  await writeFile(path, source, 'utf8');
}

export async function readSampleConfig() {
  return readFile(SAMPLE_CONFIG, 'utf8');
}

export async function readActionMetadata() {
  return YAML.parse(await readFile(ACTION_METADATA, 'utf8'));
}

export function collectLogger() {
  const messages = [];
  const push = (level) => (message) => messages.push({ level, message: String(message) });
  return {
    logger: {
      info: push('info'),
      warn: push('warn'),
      error: push('error')
    },
    text() {
      return messages.map((entry) => entry.message).join('\n');
    }
  };
}

export async function runAction(dir, env = {}) {
  const logs = collectLogger();
  const outputFile = join(dir, 'github-output.txt');
  const run = await runValidateConfigAction({
    cwd: dir,
    env,
    logger: logs.logger,
    outputFile
  });
  const outputText = await readFile(outputFile, 'utf8').catch(() => '');

  return { ...run, logText: logs.text(), outputText };
}

export async function runBundledAction(dir, configSource, env = {}) {
  const metadata = await readActionMetadata();
  const actionRoot = join(dir, 'copied-action');
  const repoRoot = join(dir, 'repo');
  const outputFile = join(dir, 'github-output.txt');
  const mainFile = join(actionRoot, metadata.runs.main);
  const distPackageFile = join(actionRoot, 'dist/package.json');

  await mkdir(dirname(mainFile), { recursive: true });
  await writeFile(mainFile, await readFile(new URL(`../${metadata.runs.main}`, import.meta.url)), 'utf8');
  await writeFile(distPackageFile, await readFile(new URL('../dist/package.json', import.meta.url)), 'utf8');
  await mkdir(join(repoRoot, '.github'), { recursive: true });
  await writeFile(join(repoRoot, DEFAULT_CONFIG_FILE), configSource, 'utf8');

  const child = spawnSync(process.execPath, [mainFile], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      GITHUB_OUTPUT: outputFile,
      ...env
    },
    encoding: 'utf8'
  });
  const outputText = await readFile(outputFile, 'utf8').catch(() => '');

  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    outputText,
    outputs: parseGithubOutput(outputText),
    actionRoot
  };
}

export function parseGithubOutput(outputText) {
  const outputs = {};
  const pattern = /^([^<\r\n]+)<<__chatgpt_automation_output__\r?\n([\s\S]*?)\r?\n__chatgpt_automation_output__$/gm;
  let match;

  while ((match = pattern.exec(outputText)) !== null) {
    outputs[match[1]] = match[2];
  }

  return outputs;
}

export function falseCapabilities() {
  return {
    autoRequest: false,
    routeReview: false,
    autoMerge: false,
    mainFollowup: false,
    actionsApproval: false
  };
}
