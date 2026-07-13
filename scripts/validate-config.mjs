#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateAutomationConfig } from '../packages/chatgpt-automation-core/src/config/index.js';

const configPath = process.argv[2] ?? 'templates/chatgpt-automation.yml';
const source = await readFile(configPath, 'utf8');
const result = validateAutomationConfig(source);

if (!result.ok) {
  console.error(`Config validation failed for ${configPath}.`);
  for (const error of result.errors) {
    console.error(`- ${error.path}: ${error.code} ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Config validation passed for ${configPath}.`);
  if (result.warnings.length > 0) {
    console.log(`Warnings: ${result.warnings.length}`);
  }
}
