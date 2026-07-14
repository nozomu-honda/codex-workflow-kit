#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import {
  createReleaseReadinessPlan,
  formatReleasePlan
} from '../packages/chatgpt-automation-core/src/release-readiness/index.js';
import { checkActionDist } from './check-action-dist.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'release/release-manifest.example.yml';
const DEFAULT_CONSUMERS = 'release/consumers.example.yml';
const DEFAULT_CHANGELOG = 'CHANGELOG.md';
const REF_AUDIT_ROOTS = Object.freeze([
  '.github/workflows',
  'reusable-workflows',
  'templates/workflows',
  'docs',
  'fixtures'
]);
const REF_AUDIT_EXTENSIONS = new Set(['.yml', '.yaml', '.md']);

export async function runPlanReleaseCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((message) => process.stdout.write(message));
  const stderr = io.stderr ?? ((message) => process.stderr.write(message));
  const parsed = parseArgs(argv);

  if (parsed.help) {
    stdout(usage());
    return 0;
  }

  if (!parsed.ok) {
    stderr(`${parsed.error}\n\n${usage()}`);
    return 2;
  }

  try {
    const root = resolve(parsed.root ?? repoRoot);
    const manifestPath = resolveInside(root, parsed.manifest ?? DEFAULT_MANIFEST);
    const consumersPath = resolveInside(root, parsed.consumers ?? DEFAULT_CONSUMERS);
    const changelogPath = resolveInside(root, parsed.changelog ?? DEFAULT_CHANGELOG);
    const manifest = parseYamlObject(await readFile(manifestPath.absolutePath, 'utf8'), manifestPath.relativePath);
    const consumerInventory = parseYamlObject(await readFile(consumersPath.absolutePath, 'utf8'), consumersPath.relativePath);
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const changelogSource = await readFile(changelogPath.absolutePath, 'utf8');
    const refAuditFiles = await collectRefAuditFiles(root);
    const sourceDistStatus = await checkActionDist({ repoRoot: root });
    const plan = createReleaseReadinessPlan({
      manifest: {
        ...manifest,
        ...(parsed.version ? { releaseVersion: parsed.version } : {}),
        ...(parsed.releaseSha ? { releaseCommitSha: parsed.releaseSha } : {}),
        ...(parsed.previousReleaseSha ? { previousReleaseCommitSha: parsed.previousReleaseSha } : {})
      },
      packageVersion: packageJson.version,
      changelogSource,
      refAuditFiles,
      consumerInventory,
      sourceDistStatus,
      dryRun: parsed.dryRun
    });

    if (parsed.json) {
      stdout(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      stdout(formatReleasePlan(plan));
    }

    return plan.ready ? 0 : 1;
  } catch {
    stderr('Release plan failed without exposing stack trace.\n');
    return 1;
  }
}

function parseArgs(argv) {
  const result = {
    ok: true,
    dryRun: true,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      return result;
    }
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg === '--no-dry-run') {
      result.dryRun = false;
      continue;
    }
    if ([
      '--root',
      '--manifest',
      '--consumers',
      '--changelog',
      '--version',
      '--release-sha',
      '--previous-release-sha'
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, error: `${arg} requires a value.` };
      }
      const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      result[key] = value;
      index += 1;
      continue;
    }
    return { ok: false, error: `Unknown option: ${arg}` };
  }

  return result;
}

function usage() {
  return `Usage: node scripts/plan-release.mjs [options]

Options:
  --root <path>                  Repository root. Defaults to current package root.
  --manifest <path>              Release manifest path. Defaults to ${DEFAULT_MANIFEST}.
  --consumers <path>             Consumer inventory path. Defaults to ${DEFAULT_CONSUMERS}.
  --changelog <path>             Changelog path. Defaults to ${DEFAULT_CHANGELOG}.
  --version <semver>             Override releaseVersion for planning.
  --release-sha <sha>            Override releaseCommitSha for planning.
  --previous-release-sha <sha>   Override previousReleaseCommitSha for planning.
  --dry-run                      Plan only. Default.
  --no-dry-run                   Keep output explicit; this CLI still performs no writes.
  --json                         Emit deterministic JSON.
  --help                         Show this help.
`;
}

function parseYamlObject(source, file) {
  const document = YAML.parseDocument(source, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new Error(`YAML parse failed: ${file}`);
  }
  return document.toJS();
}

async function collectRefAuditFiles(root) {
  const files = [];
  for (const relativeRoot of REF_AUDIT_ROOTS) {
    const absoluteRoot = resolve(root, relativeRoot);
    files.push(...await collectFiles(root, absoluteRoot));
  }
  return files;
}

async function collectFiles(root, dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!REF_AUDIT_EXTENSIONS.has(extension(entry.name))) {
      continue;
    }
    files.push({
      path: normalizePath(relative(root, absolutePath)),
      content: await readFile(absolutePath, 'utf8')
    });
  }
  return files;
}

function resolveInside(root, value) {
  const absolutePath = resolve(root, value);
  const relativePath = normalizePath(relative(root, absolutePath));
  if (relativePath.startsWith('../') || relativePath === '..' || relativePath === '') {
    throw new Error('Path escapes repository root.');
  }
  return {
    absolutePath,
    relativePath
  };
}

function extension(file) {
  const index = file.lastIndexOf('.');
  return index === -1 ? '' : file.slice(index).toLowerCase();
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPlanReleaseCli();
}
