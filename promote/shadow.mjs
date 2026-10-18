#!/usr/bin/env node
// Summarize saved selector observations; no execution, record writes or rescans.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from '../lib/cli-help.mjs';

export function collectShadow({ project = process.cwd() } = {}) {
  const git = spawnSync('git', ['-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (git.error || git.status !== 0) throw Error('cannot resolve shadow batch directory');
  const identity = fs.realpathSync(git.stdout.trim()), directory = path.join(identity, 'promote/batches');
  const rows = [], warnings = [];
  for (const batch of fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []) {
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(directory, batch, 'train.json'), 'utf8'));
      if (plan.schema !== 'promotion-train/v1' || plan.identity !== identity) throw Error('invalid batch identity/schema');
      for (const [attempt, value] of (plan.attempts ?? []).entries()) {
        const observations = [...(value.selector_shadow_history ?? []), ...(value.selector_shadow ? [value.selector_shadow] : [])];
        for (const [observation, shadow] of observations.entries()) {
          if (shadow.schema !== 'promotion-selector-shadow/v1' ||
              !(shadow.pick === 'full' || Array.isArray(shadow.pick)) || ![null, true, false].includes(shadow.miss)) throw Error('invalid shadow observation');
          rows.push({ batch, attempt, observation, ...shadow });
        }
      }
    } catch (error) { warnings.push(`${batch}: ${error.message}`); }
  }
  return { schema: 'promotion-selector-summary/v1', project, rows, warnings,
    summary: { observations: rows.length, completed: rows.filter(r => r.miss !== null).length,
      misses: rows.filter(r => r.miss === true).length, pending: rows.filter(r => r.miss === null).length,
      full: rows.filter(r => r.pick === 'full').length, subsets: rows.filter(r => Array.isArray(r.pick)).length,
      errors: rows.filter(r => r.error || r.comparison_error).length } };
}
export function renderShadow(result) {
  const s = result.summary;
  return [`Selector shadow: ${s.completed}/${s.observations} completed; ${s.misses} misses; ${s.pending} pending`,
    `Picks: ${s.full} full; ${s.subsets} subsets; ${s.errors} errors`,
    ...result.rows.map(row => `${row.batch} attempt ${row.attempt} observation ${row.observation}: ${row.pick === 'full' ? 'full' : row.pick.length + ' files'}; miss=${row.miss ?? 'pending'}; ${row.reason}`),
    ...result.warnings.map(warning => `Warning: ${warning}`)].join('\n') + '\n';
}
export function main(argv = process.argv.slice(2)) {
  let project, json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) project = path.resolve(argv[++i]);
    else if (argv[i] === '--json') json = true;
    else throw Error('usage: node promote/shadow.mjs [--project PATH] [--json]');
  }
  const result = collectShadow({ project });
  process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : renderShadow(result));
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`shadow: ${error.message}\n`); process.exitCode = 1; }
}
