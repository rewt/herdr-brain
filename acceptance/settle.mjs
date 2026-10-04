#!/usr/bin/env node
// Offline candidate harness: product modules are real; Herdr/model transport is
// scripted. This case does not claim live PTY or default supervisor discovery.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from '../settle/test/fixture.mjs';
import { loadAwareCommand } from './commands.mjs';
import { waitUntil } from './load.mjs';
import { scratchFixtureCommand } from './environment.mjs';

export async function settleCase(candidate, { load, execute = spawnSync,
  until = (fn, label, ms) => waitUntil(fn, label, ms, { load }) } = {}) {
  const cleanup = [], receipts = [];
  try {
    const f = fixture({ after: (fn) => cleanup.push(fn) }, { source: candidate,
      actor: 'settle-acceptance-worker', execute: scratchFixtureCommand(loadAwareCommand(execute, load)) });
    const run = f.start(); f.commit('wrong\n'); f.report(run);
    const first = f.settle(run); assert.equal(first.status, 0, first.stderr);
    const fix = JSON.parse(first.stdout); receipts.push(fix);
    assert.equal(fix.result, 'fix_round');
    assert.notEqual(fix.fix.run, run); assert.equal(f.show(fix.fix.run).item, f.show(run).item);
    assert.equal(f.show(fix.fix.run).workspace, f.workspace);
    await until(() => f.calls().some((a) => a[3]?.includes(`[org-report] run=${fix.fix.run} `)),
      'watch delivered the fix report', 8000);
    const final = f.settle(fix.fix.run); assert.equal(final.status, 0, final.stderr);
    const settled = JSON.parse(final.stdout); receipts.push(settled);
    assert.equal(settled.result, 'promotable'); assert.equal(settled.validation.executed, false);
    assert.ok(!fs.existsSync(path.join(f.repo, '.lane.json')));
    assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
    const artifacts = Object.fromEntries(fs.readdirSync(path.join(f.org, 'settle'))
      .filter((name) => fs.statSync(path.join(f.org, 'settle', name)).isFile())
      .map((name) => [name, fs.readFileSync(path.join(f.org, 'settle', name), 'utf8')]));
    return { receipts, calls: f.calls(), artifacts, detail: `${run} -> ${fix.fix.run}: actual record/review/dispatch/watch, suite deferred to promotion, no project config, scripted transport and claim check, no model` };
  } finally { for (const fn of cleanup) await fn(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const candidate = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
  try { process.stdout.write(`${JSON.stringify(await settleCase(candidate), null, 2)}\n`); }
  catch (e) { process.stderr.write(`${e.stack}\n`); process.exitCode = 1; }
}
