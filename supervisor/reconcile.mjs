#!/usr/bin/env node
// Shared completion adapter for manually stacked lanes and legacy promoters.
// Runs once at preparation/completion, never polls and never promotes or tests.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { completionFingerprint, completionEvents, stable } from '../lib/completion.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { isMain } from '../lib/cli-help.mjs';

const hash = v => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v ?? '');
function git(repo, args) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0 || r.error) throw Error(r.stderr || r.error?.message || `git ${args[0]} failed`);
  return r.stdout.trim();
}
const ancestor = (repo, head, tip) => git(repo, ['merge-base', '--is-ancestor', head, tip]);

export function reconcile(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    repo: { type: 'string' }, org: { type: 'string' }, role: { type: 'string' },
    manifest: { type: 'string' }, prepared: { type: 'string' },
    'gate-log': { type: 'string' }, 'gate-exit': { type: 'string' }, tip: { type: 'string' },
  } });
  const [action] = positionals;
  if (positionals.length !== 1 || !['prepare', 'finish'].includes(action) || !opt.repo || !opt.org || !opt.prepared || opt.role !== 'supervisor')
    throw Error('usage: reconcile.mjs prepare|finish --repo PATH --org PATH --role supervisor --prepared FILE [--manifest FILE --gate-log FILE | --gate-exit 0 --tip SHA]');
  const project = gitProject(opt.repo), org = fs.realpathSync(opt.org);
  if (project.checkout !== project.canonical) throw Error('completion requires the canonical checkout');
  const discovered = findOrgDir({ cwd: project.canonical, env: { ...process.env, ORG_DIR: '' } });
  if (!discovered || fs.realpathSync(discovered) !== org) throw Error('explicit record differs from canonical project record; inherited ORG_DIR is never used');
  if (fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) throw Error('supervisor STOP prevents completion');
  const file = path.resolve(opt.prepared), branch = git(project.canonical, ['symbolic-ref', '--short', 'HEAD']);
  const lock = acquireLock(path.join(project.identity, 'lane-promote.lock'));
  try {
    if (git(project.canonical, ['status', '--porcelain'])) throw Error('canonical checkout is dirty');
    if (action === 'prepare') {
      if (!opt.manifest || !opt['gate-log']) throw Error('prepare needs --manifest and --gate-log');
      if (fs.existsSync(file)) throw Error('prepared receipt already exists; inspect it instead of replacing approved evidence');
      const manifest = JSON.parse(fs.readFileSync(opt.manifest, 'utf8'));
      if (!hash(manifest.candidate) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(manifest.batch ?? '') || !Array.isArray(manifest.items) || !manifest.items.length || !Array.isArray(manifest.excluded ?? [])) throw Error('invalid batch manifest');
      const loaded = loadEvents(org);
      if (loaded.tornTail) throw Error('incomplete record tail');
      const state = fold(loaded.events), seen = new Set();
      const bind = (entry, included) => {
        const item = state.items.get(entry.item), run = state.runs.get(entry.run);
        if (!item || !run || run.item !== item.id || seen.has(item.id)) throw Error('manifest has stale, duplicate or mismatched item/run');
        seen.add(item.id);
        // Historical exclusions account for an earlier decision without
        // rebinding or changing newer excluded work, as in the native adapter.
        if (!included && entry.disposition === 'historical') return { ...entry };
        if (item.runs.at(-1) !== run.id || item.closed || run.abandoned) throw Error('manifest has stale, duplicate or mismatched item/run');
        if (included) {
          if (!run.workspace || git(run.workspace, ['status', '--porcelain']) || gitProject(run.workspace).identity !== project.identity || !hash(entry.head) ||
              git(run.workspace, ['rev-parse', 'HEAD']) !== entry.head) throw Error(`${entry.item} head/workspace differs from its manifest`);
          const branch = git(run.workspace, ['symbolic-ref', '--short', 'HEAD']);
          if (!/^lane\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(branch)) throw Error(`${entry.item} workspace is not a named lane`);
          entry = { ...entry, topic: branch.slice(5) };
          ancestor(project.canonical, entry.head, manifest.candidate);
          if (!entry.why?.trim() || !Array.isArray(entry.superseded)) throw Error(`${entry.item} needs authority/review reason and explicit superseded runs`);
        }
        return { ...entry, expected: completionFingerprint(state, item.id) };
      };
      const prepared = { version: 1, batch: manifest.batch, identity: project.identity, org,
        canonical: project.canonical, branch, base: git(project.canonical, ['rev-parse', 'HEAD']),
        candidate: manifest.candidate, gate_log: path.resolve(opt['gate-log']), items: manifest.items.map(e => bind(e, true)),
        excluded: (manifest.excluded ?? []).map(e => bind(e, false)) };
      ancestor(project.canonical, prepared.base, prepared.candidate);
      // Run every record guard before spending a gate; this only derives events.
      completionEvents(state, loaded.events, { ...prepared, tip: prepared.candidate,
        gate: { exit_code: 0, log: prepared.gate_log, sha256: '0'.repeat(64) } }, org);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(prepared, null, 2) + '\n');
      return { result: 'prepared', file, batch: prepared.batch, items: prepared.items.map(e => e.item) };
    }
    const prepared = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prepared.version !== 1 || prepared.identity !== project.identity || prepared.org !== org || prepared.canonical !== project.canonical || prepared.branch !== branch)
      throw Error('prepared project, record or integration branch differs');
    if (opt['gate-exit'] !== '0' || !hash(opt.tip)) throw Error('completion requires the promoter’s successful gate exit and exact integrated tip');
    if (opt.tip !== prepared.candidate) throw Error('integrated tip differs from the prepared candidate; rebase and review before preparation');
    ancestor(project.canonical, prepared.base, opt.tip);
    ancestor(project.canonical, opt.tip, 'HEAD');
    for (const item of prepared.items) ancestor(project.canonical, item.head, opt.tip);
    const bytes = fs.readFileSync(prepared.gate_log);
    if (!bytes.length) throw Error('gate log is empty');
    const payload = { version: 1, batch: prepared.batch, org, identity: project.identity,
      base: prepared.base, tip: opt.tip,
      gate: { exit_code: 0, log: prepared.gate_log, sha256: createHash('sha256').update(bytes).digest('hex') },
      items: prepared.items, excluded: prepared.excluded };
    const receipt = file + '.record.json';
    if (fs.existsSync(receipt) && stable(JSON.parse(fs.readFileSync(receipt, 'utf8'))) !== stable(payload))
      throw Error('completion evidence changed; preserve the original receipt and inspect');
    if (!fs.existsSync(receipt)) writeFileAtomic(receipt, JSON.stringify(payload, null, 2) + '\n');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/org.mjs', import.meta.url)), 'complete-batch', '--file', receipt],
      { cwd: project.canonical, env: { ...process.env, ORG_DIR: org, ORG_ACTOR: process.env.ORG_ACTOR || 'supervisor-completion' }, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0 || r.error) throw Error(`Git is integrated but record reconciliation is pending: ${r.stderr || r.error?.message || r.stdout}`);
    return { result: 'reconciled', ...JSON.parse(r.stdout), receipt };
  } finally { lock(); }
}

if (isMain(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(reconcile(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(`completion: ${error.message}\n`); process.exitCode = 1; }
}
