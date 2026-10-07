#!/usr/bin/env node
// A repeated build with the same lockfile leaves installed dependencies alone.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliHelp } from '../lib/cli-help.mjs';
cliHelp(import.meta.url, "Usage: node herdr/dependencies.mjs\nInstall console and MCP dependencies when their lockfiles change.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const module of ['console', 'mcp']) {
    const directory = path.join(root, module), lock = path.join(directory, 'package-lock.json');
    if (!fs.existsSync(path.join(directory, 'package.json'))) continue;
    const fingerprint = createHash('sha256').update(fs.readFileSync(lock)).update(process.versions.modules).update(process.platform).update(process.arch).digest('hex');
    const receipt = path.join(directory, 'node_modules/.monitor-dependencies');
    if (fs.existsSync(receipt) && fs.readFileSync(receipt, 'utf8') === fingerprint) { console.log(`install: ${module} dependencies already installed`); continue; }
    const result = spawnSync('npm', ['--prefix', directory, 'ci', '--no-audit', '--no-fund', '--prefer-offline'], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (result.error || result.status !== 0) throw new Error(`${module} dependency installation failed: ${result.error?.message ?? `npm exit ${result.status}`}`);
    fs.writeFileSync(receipt, fingerprint, { mode: 0o600 });
    console.log(`install: ${module} dependencies installed in ${directory}`);
  }
} catch (error) { console.error(`install: ${error.message}`); process.exitCode = 1; }
