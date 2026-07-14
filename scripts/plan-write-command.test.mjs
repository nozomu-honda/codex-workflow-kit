import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_REPOSITORY, FIXTURE_SHAS } from '../fixtures/github-events/index.js';

test('plan-write-command CLIはauto-merge planからdisabled write command resultを出力する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'write-command-'));
  try {
    const planPath = join(dir, 'auto-merge-plan.json');
    writeFileSync(planPath, JSON.stringify(autoMergePlan()), 'utf8');

    const result = spawnSync(process.execPath, [
      'scripts/plan-write-command.mjs',
      '--plan',
      planPath,
      '--plan-type',
      'auto-merge',
      '--operation',
      'enable-auto-merge',
      '--requested-at',
      '2026-01-01T00:00:00.000Z'
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.command_count, 1);
    assert.equal(output.commands[0].operation, 'enable-auto-merge');
    assert.equal(output.results[0].execution.reasonCode, 'write_disabled');
    assert.equal(JSON.stringify(output).includes('Authorization'), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('plan-write-command CLIはmanual review planではcommandを生成しない', () => {
  const result = spawnSync(process.execPath, [
    'scripts/plan-write-command.mjs',
    '--plan-json',
    JSON.stringify({
      outputs: {
        eligible: 'false',
        should_enable_auto_merge: 'false',
        should_merge: 'false',
        skip_reason: 'manual_review_required'
      }
    }),
    '--plan-type',
    'auto-merge'
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.command_count, 0);
  assert.equal(output.reason_code, 'manual_review_required');
});

function autoMergePlan() {
  return {
    outputs: {
      base_sha: FIXTURE_SHAS.base,
      dedupe_key: `${FIXTURE_REPOSITORY.fullName}#42:${FIXTURE_SHAS.head}:enable-auto-merge:v1`,
      eligible: 'true',
      head_sha: FIXTURE_SHAS.head,
      merge_reason: 'eligible_enable_auto_merge',
      pull_request_number: '42',
      repository: FIXTURE_REPOSITORY.fullName,
      should_enable_auto_merge: 'true',
      should_merge: 'false'
    }
  };
}
