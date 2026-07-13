import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { compareActionDistFiles } from '../../../scripts/check-action-dist.mjs';
import {
  ACTION_INPUTS,
  ACTION_OUTPUTS,
  DEFAULT_CONFIG_FILE
} from '../src/index.js';
import {
  falseCapabilities,
  readActionMetadata,
  readSampleConfig,
  runAction,
  runBundledAction,
  withTempRepo,
  writeConfig
} from './helpers.js';

test('sample configで成功する', async () => {
  await withTempRepo(async (dir) => {
    await writeConfig(dir, await readSampleConfig());

    const run = await runAction(dir);

    assert.equal(run.exitCode, 0);
    assert.equal(run.outputs.ok, 'true');
    assert.equal(run.outputs['error-count'], '0');
    assert.equal(run.outputs['dry-run'], 'true');
    assert.deepEqual(JSON.parse(run.outputs['capabilities-json']), falseCapabilities());
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
  const metadata = await readActionMetadata();

  assert.deepEqual(Object.keys(metadata.inputs).sort(), Object.values(ACTION_INPUTS).sort());
  assert.deepEqual(Object.keys(metadata.outputs).sort(), [...ACTION_OUTPUTS].sort());
  assert.equal(metadata.inputs['config-file'].default, DEFAULT_CONFIG_FILE);
  assert.equal(metadata.inputs['dry-run'].default, 'true');
  assert.equal(metadata.runs.using, 'node24');
  assert.equal(metadata.runs.main, 'dist/index.js');
});

test('Action metadataはNode 24 runtimeを指定する', async () => {
  const metadata = await readActionMetadata();

  assert.equal(metadata.runs.using, 'node24');
});

test('outputsはGitHub Actions output fileへ書き込まれる', async () => {
  await withTempRepo(async (dir) => {
    await writeConfig(dir, await readSampleConfig());

    const run = await runAction(dir);

    assert.match(run.outputText, /ok<<__chatgpt_automation_output__/);
    assert.match(run.outputText, /capabilities-json<<__chatgpt_automation_output__/);
  });
});

test('dist配布物は外部node_modulesなしでvalid configを処理する', async () => {
  await withTempRepo(async (dir) => {
    const run = await runBundledAction(dir, await readSampleConfig());

    assert.equal(run.status, 0);
    assert.equal(run.outputs.ok, 'true');
    assert.equal(run.outputs['error-count'], '0');
    assert.equal(run.outputs['dry-run'], 'true');
    assert.deepEqual(JSON.parse(run.outputs['capabilities-json']), falseCapabilities());
    assert.match(run.outputText, /ok<<__chatgpt_automation_output__/);
    await assert.rejects(readFile(join(run.actionRoot, 'node_modules/yaml/package.json'), 'utf8'));
  });
});

test('dist配布物はinvalid configでfail closedになりcapabilityをすべてfalseにする', async () => {
  await withTempRepo(async (dir) => {
    const run = await runBundledAction(dir, 'version: 999\n');

    assert.notEqual(run.status, 0);
    assert.equal(run.outputs.ok, 'false');
    assert.deepEqual(JSON.parse(run.outputs['capabilities-json']), falseCapabilities());
    assert.match(`${run.stdout}\n${run.stderr}`, /UNSUPPORTED_VERSION/);
  });
});

test('dist配布物もSecret-like文字列やconfig全文をstdout/stderrへ出さない', async () => {
  await withTempRepo(async (dir) => {
    const marker = 'dummy-bundled-secret-like-token-value';
    const uniqueConfigText = 'unique-bundled-full-config-text';
    const config = YAML.parse(await readSampleConfig());
    config.secrets.autoMergeToken = marker;
    config.metadataForBundledTest = uniqueConfigText;
    const source = YAML.stringify(config);
    const run = await runBundledAction(dir, source);
    const logs = `${run.stdout}\n${run.stderr}`;

    assert.notEqual(run.status, 0);
    assert.equal(logs.includes(marker), false);
    assert.equal(logs.includes(uniqueConfigText), false);
    assert.equal(logs.includes(source.trim()), false);
  });
});

test('dist整合性比較は古い配布物を検出する', () => {
  const comparison = compareActionDistFiles(
    new Map([
      ['index.js', 'old'],
      ['package.json', '{"type":"module"}']
    ]),
    new Map([
      ['index.js', 'new'],
      ['package.json', '{"type":"module"}']
    ])
  );

  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.changed, ['index.js']);
});
