import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from '../runtime.mjs';
import { fleetPath } from '../../lib/fleet.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { copyProduct } from '../../lib/product-files.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { FAST_VALIDATION_TIMEOUT, PROMOTION_VALIDATION_TIMEOUT, VALIDATION_WRAPPER_GRACE,
  ENTRY_COMMAND_GRACE, MAX_ENTRY_TIMEOUT, entryValidationTimeout, requestTimeout, validationTimeout, validationStepTimeout } from '../deadlines.mjs';

const product = new URL('../../', import.meta.url).pathname;
test('entry reserves bounded owner, wrapper, preparation and reply time for promotion', () => {
  process.env.ORG_ACTOR = 'entry-deadline-policy-test';
  assert.equal(validationTimeout('fast'), 120_000);
  assert.equal(validationTimeout('promotion'), 1_800_000);
  assert.throws(() => validationTimeout('release'), /fast or promotion/);
  assert.equal(entryValidationTimeout('promotion', 2), PROMOTION_VALIDATION_TIMEOUT + VALIDATION_WRAPPER_GRACE +
    ENTRY_COMMAND_GRACE + 2 * (FAST_VALIDATION_TIMEOUT + VALIDATION_WRAPPER_GRACE));
  assert.equal(entryValidationTimeout('promotion', 100), MAX_ENTRY_TIMEOUT);
  for (const op of ['check', 'promote', 'finish']) assert.ok(requestTimeout(op) > MAX_ENTRY_TIMEOUT);
  assert.equal(requestTimeout('commit'), 180_000);
  for (const count of [-1, Infinity, 0.5]) assert.throws(() => entryValidationTimeout('fast', count));
  assert.equal(validationStepTimeout('promotion', 100_000, 70_000), 5_000);
  assert.equal(validationStepTimeout('fast', 1_000_000, 70_000), FAST_VALIDATION_TIMEOUT);
  assert.throws(() => validationStepTimeout('promotion', 100_000, 75_000), /exhausted/);
  assert.throws(() => validationStepTimeout('promotion', 'invalid'), /invalid/);
});

test('declared promotion outlives fast owner, wrapper and client bounds with real descendant cleanup', { timeout: 30000 }, async t => {
  process.env.ORG_ACTOR = 'entry-long-promotion-test';
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'entry-promotion-deadline-'));
  fixtureFleet(t, scratch);
  let entry;
  t.after(() => { entry?.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
  assert.equal(fleetPath(), path.join(scratch, 'fleet/fleet.json'), 'entry must only join this fixture fleet');
  const source = path.join(scratch, 'product'); fs.mkdirSync(source);
  // Execute the same production stack at short wall-clock bounds. Only these
  // numeric policy constants change; sandbox construction and the native owner
  // (including lifetime markers and descendant sweeps) remain real.
  copyProduct(product, source);
  const policy = path.join(source, 'discovery/deadlines.mjs');
  const scaled = { FAST_VALIDATION_TIMEOUT: 1_000, PROMOTION_VALIDATION_TIMEOUT: 10_000,
    VALIDATION_WRAPPER_GRACE: 2_000, ENTRY_COMMAND_GRACE: 1_000, MAX_ENTRY_TIMEOUT: 20_000,
    DEFAULT_REQUEST_TIMEOUT: 3_000, REQUEST_REPLY_GRACE: 500 };
  let text = fs.readFileSync(policy, 'utf8');
  for (const [name, value] of Object.entries(scaled)) text = text.replace(new RegExp(`(${name} = )[\\d_]+;`), `$1${value};`);
  fs.writeFileSync(policy, text);
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  command('git', ['init', '-qb', 'main'], repo);
  command('git', ['config', 'user.name', 'Promotion deadline test'], repo);
  command('git', ['config', 'user.email', 'test@example.invalid'], repo);
  const late = path.join(scratch, 'late-write'), complete = path.join(scratch, 'complete');
  fs.writeFileSync(path.join(repo, 'slow.cjs'), `const cp=require('child_process');
require('assert').equal(process.env.MONITOR_VALIDATION_TIER,undefined);
require('assert').equal(process.env.MONITOR_VALIDATION_DEADLINE,undefined);
cp.spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'leaked'),7000);`)}],{stdio:'ignore'}).unref();
setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(complete)},'complete'),4400);\n`);
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ main: 'main' }));
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ fast: `${process.execPath} slow.cjs`, promotion: `${process.execPath} slow.cjs`, release: 'must-never-run' }));
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Declare long promotion check'], repo);
  const sandbox = path.join(scratch, 'sandbox'), profiles = path.join(scratch, 'profiles.jsonl');
  fs.writeFileSync(sandbox, `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(profiles)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(require(${JSON.stringify(path.join(product, 'discovery/test/helpers/lifetime.cjs'))})(process.argv.slice(2)));`, { mode: 0o755 });
  const { createEntry } = await import(pathToFileURL(path.join(source, 'discovery/runtime.mjs')));
  entry = createEntry({ cwd: repo, sandboxBinary: sandbox, runtimeDir: path.join(scratch, 'runtime'), worktreeRoot: path.join(scratch, 'lanes') });
  const fleet = JSON.parse(fs.readFileSync(fleetPath(), 'utf8'));
  assert.deepEqual(Object.keys(fleet.projects), ['repo']);
  assert.equal(fleet.projects.repo.checkout, repo);
  assert.equal(fleet.projects.repo.record, path.join(repo, '.org'));
  const current = entry.dispatch({ op: 'start', text: 'Complete a longer declared promotion' });
  fs.mkdirSync(path.dirname(current.report), { recursive: true });
  fs.writeFileSync(current.report, `---\nrun: ${current.run}\noutcome: done\nsummary: Long promotion check completed.\nblockers: []\nproposals: []\nartifacts: []\n---\n`);
  entry.dispatch({ op: 'commit', text: 'Complete promotion fixture' });
  assert.throws(() => entry.dispatch({ op: 'check' }), /sandboxed validation exited 124/, 'fast owner must still enforce its shorter bound');
  assert.equal(fs.existsSync(complete), false);
  assert.throws(() => command(process.execPath, [path.join(source, 'discovery/validate.mjs'), sandbox,
    current.workspace, JSON.stringify([current.org]), `${process.execPath} slow.cjs`], current.workspace,
    { MONITOR_PROJECT_CONFIG: path.join(repo, '.lane.json'), MONITOR_VALIDATION_TIER: 'promotion',
      MONITOR_VALIDATION_DEADLINE: String(Date.now() + scaled.VALIDATION_WRAPPER_GRACE + 1000) }),
  /sandboxed validation exited 124/, 'remaining aggregate time must shorten the native owner before the broker expires');
  assert.equal(fs.existsSync(complete), false);
  const client = spawnChild(t, process.execPath, [path.join(source, 'discovery/client.mjs'), 'promote'], {
    cwd: current.workspace, env: { ...process.env, ORG_ACTOR: 'entry-long-promotion-client', MONITOR_REQUEST_DIR: current.requests },
  });
  const done = waitForExit(client);
  const polling = setInterval(() => entry.poll(), 20);
  let promoted;
  try { promoted = await done; } finally { clearInterval(polling); }
  assert.equal(promoted.code, 0, promoted.stderr);
  assert.match(promoted.stdout, /fast-forward/);
  assert.equal(fs.readFileSync(complete, 'utf8'), 'complete');
  assert.equal(command('git', ['rev-parse', 'main'], repo), command('git', ['rev-parse', 'HEAD'], current.workspace));
  const args = fs.readFileSync(profiles, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(args.length, 3, 'red fast and aggregate-bound checks, then one green promotion');
  for (const profile of args) {
    const filesystem = profile.find(arg => arg.startsWith('permissions.monitor-validation.filesystem='));
    assert.ok(filesystem.includes(`${JSON.stringify(path.join(repo, '.org'))}="read"`));
    assert.ok(filesystem.includes('validation-tmp'));
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(fs.existsSync(late), false, 'neither timed-out nor successful validation may leave a descendant');
});
