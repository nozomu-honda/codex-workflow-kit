import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  ACTION_INPUTS,
  ACTION_OUTPUTS,
  DEFAULT_CONFIG_FILE,
  runValidateConfigAction
} from '../src/index.js';

const SAMPLE_CONFIG = new URL('../../../templates/chatgpt-automation.yml', import.meta.url);
const ACTION_METADATA = new URL('../action.yml', import.meta.url);

async function withTempRepo(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'validate-config-action-'));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(dir, source) {
  const path = join(dir, DEFAULT_CONFIG_FILE);
  await mkdir(join(dir, '.github'), { recursive: true });
  await writeFile(path, source, 'utf8');
}

async function readSampleConfig() {
  return readFile(SAMPLE_CONFIG, 'utf8');
}

function collectLogger() {
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

async function runAction(dir, env = {}) {
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

test('sample configで成功する', async () => {
  await withTempRepo(async (dir) => {
    await writeConfig(dir, await readSampleConfig());

    const run = await runAction(dir);

    assert.equal(run.exitCode, 0);
    assert.equal(run.outputs.ok, 'true');
    assert.equal(run.outputs['error-count'], '0');
    assert.equal(run.outputs['dry-run'], 'true');
    assert.equal(JSON.parse(run.outputs['capabilities-json']).autoRequest, true);
  });
});

test('config欠落でfail closedになる', async () => {
  await withTempRepo(async (dir) => {
    const run = await runAction(dir);

    assert.equal(run.exitCode, 1);
    assert.equal(run.outputs.ok, 'false');
    assert.equal(run.outputs['error-count'], '1');
    assert.deepEqual(JSON.parse(run.outputs['capabilities-json']), falseCapabilities());
    assert.match(run.logText, /CONFIG_READ_FAILED/);
  });
});

test('不正YAMLでfail closedになる', async () => {
  await withTempRepo(async (dir) => {
    await writeConfig(dir, 'version: 1\nbaseBranch: [');

    const run = await runAction(dir);

    assert.equal(run.exitCode, 1);
    assert.equal(run.outputs.ok, 'false');
    assert.deepEqual(JSON.parse(run.outputs['capabilities-json']), falseCapabilities());
    assert.match(run.logText, /YAML_PARSE_ERROR/);
  });
});

test('未対応versionでfail closedになる', async () => {
  await withTempRepo(async (dir) => {
    const source = (await readSampleConfig()).replace('version: 1', 'version: 999');
    await writeConfig(dir, source);

    const run = await runAction(dir);

    assert.equal(run.exitCode, 1);
    assert.equal(run.outputs.ok, 'false');
    assert.deepEqual(JSON.parse(run.outputs['capabilities-json']), falseCapabilities());
    assert.match(run.logText, /UNSUPPORTED_VERSION/);
  });
});

test('安全boolean弱体化でfail closedになる', async () => {
  await withTempRepo(async (dir) => {
    const config = YAML.parse(await readSampleConfig());
    config.review.markers.ignoreInFencedCodeBlocks = false;
    await writeConfig(dir, YAML.stringify(config));

    const run = await runAction(dir);

    assert.equal(run.exitCode, 1);
    assert.deepEqual(JSON.parse(run.outputs['capabilities-json']), falseCapabilities());
    assert.match(run.logText, /FENCED_MARKER_IGNORE_REQUIRED/);
  });
});

test('Secret-like文字列やconfig全文をログへ出さない', async () => {
  await withTempRepo(async (dir) => {
    const marker = 'dummy-secret-like-token-value';
    const uniqueConfigText = 'unique-full-config-text';
    const config = YAML.parse(await readSampleConfig());
    config.secrets.autoMergeToken = marker;
    config.metadataForTest = uniqueConfigText;
    const source = YAML.stringify(config);
    await writeConfig(dir, source);

    const run = await runAction(dir);

    assert.equal(run.exitCode, 1);
    assert.equal(run.logText.includes(marker), false);
    assert.equal(run.logText.includes(uniqueConfigText), false);
    assert.equal(run.logText.includes(source.trim()), false);
  });
});

test('unknown keyはwarningとして数えられる', async () => {
  await withTempRepo(async (dir) => {
    await writeConfig(dir, `${await readSampleConfig()}\nunknownRootForActionTest: true\n`);

    const run = await runAction(dir);

    assert.equal(run.exitCode, 0);
    assert.equal(run.outputs.ok, 'true');
    assert.equal(run.outputs['warning-count'], '1');
    assert.match(run.logText, /UNKNOWN_KEY/);
  });
});

test('dry-run defaultはtrueで、falseでも副作用処理を持たない', async () => {
  await withTempRepo(async (dir) => {
    await writeConfig(dir, await readSampleConfig());

    const defaultRun = await runAction(dir);
    assert.equal(defaultRun.outputs['dry-run'], 'true');
    assert.deepEqual(defaultRun.sideEffects, []);

    const falseRun = await runAction(dir, { INPUT_DRY_RUN: 'false' });
    assert.equal(falseRun.exitCode, 0);
    assert.equal(falseRun.outputs['dry-run'], 'false');
    assert.deepEqual(falseRun.sideEffects, []);
    assert.match(falseRun.logText, /no write capability/);
  });
});

test('config-file inputは指定パスを読む', async () => {
  await withTempRepo(async (dir) => {
    await writeFile(join(dir, 'custom-config.yml'), await readSampleConfig(), 'utf8');

    const run = await runAction(dir, { INPUT_CONFIG_FILE: 'custom-config.yml' });

    assert.equal(run.exitCode, 0);
    assert.equal(run.outputs.ok, 'true');
  });
});

test('Action metadataのinput/output名が実装と一致する', async () => {
  const metadata = YAML.parse(await readFile(ACTION_METADATA, 'utf8'));

  assert.deepEqual(Object.keys(metadata.inputs).sort(), Object.values(ACTION_INPUTS).sort());
  assert.deepEqual(Object.keys(metadata.outputs).sort(), [...ACTION_OUTPUTS].sort());
  assert.equal(metadata.inputs['config-file'].default, DEFAULT_CONFIG_FILE);
  assert.equal(metadata.inputs['dry-run'].default, 'true');
  assert.equal(metadata.runs.using, 'node20');
  assert.equal(metadata.runs.main, 'src/index.js');
});

test('outputsはGitHub Actions output fileへ書き込まれる', async () => {
  await withTempRepo(async (dir) => {
    await writeConfig(dir, await readSampleConfig());

    const run = await runAction(dir);

    assert.match(run.outputText, /ok<<__chatgpt_automation_output__/);
    assert.match(run.outputText, /capabilities-json<<__chatgpt_automation_output__/);
  });
});

function falseCapabilities() {
  return {
    autoRequest: false,
    routeReview: false,
    autoMerge: false,
    mainFollowup: false,
    actionsApproval: false
  };
}
