import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLineService, sourceRoot, reviewAttempt } from '../line-service.mjs';
import { launchPlist } from '../launchd.mjs';
import { noticeLock } from '../../supervisor/notice-lock.mjs';
import { gitProject } from '../../lib/project.mjs';
import { loadEvents } from '../../lib/store.mjs';
import { fold } from '../../lib/state.mjs';
import { captureProductCheckout } from '../../lib/product-files.mjs';

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-service-'))), org = path.join(repo, '.org');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const env = { ...process.env, ORG_DIR: org, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.LANE_CONFIG;
  const exec = (exe, args) => {
    const r = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();
  };
  const git = args => exec('git', args), record = args => exec(process.execPath, [path.join(sourceRoot, 'bin/org.mjs'), ...args]);
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Line fixture']); git(['config', 'user.email', 'line@example.invalid']);
  fs.writeFileSync(path.join(repo, 'source'), 'initial'); git(['add', '.']); git(['commit', '-qm', 'Initial']); record(['init']);
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ routes: { engineer: { kind: 'codex', model: 'fixture', effort: 'high' } }, dispatch: { max_sessions: 2 } }));
  const add = (title, priority = 1, extra = []) => record(['add', title, '--role', 'engineer', '--priority', String(priority), ...extra]).split(' ')[0];
  const show = id => JSON.parse(record(['show', id, '--json']));
  const calls = [], notes = [];
  let fail;
  const command = (exe, args, options) => {
    calls.push({ exe, args, options });
    if (fail) return { status: 1, stdout: '', stderr: fail };
    return { status: 0, stdout: JSON.stringify({ result: args[1] === 'handle' ? 'review_pending' : 'dispatched' }), stderr: '' };
  };
  const service = (overrides = {}) => createLineService({ repo, org, to: 'supervisor-test', env, command,
    capacity: () => ({ count: 0, cap: 2 }), notify: (to, text, options) => { notes.push({ to, text, options }); return { id: options.id, inbox: 'fixture' }; }, resume: () => {}, ...overrides });
  return { repo, org, env, record, git, add, show, calls, notes, service, setFailure: value => { fail = value; } };
}

test('priority READY dispatch uses existing admission and retains its one effect across restart', t => {
  const f = fixture(t); const high = f.add('High', 7);
  f.service().pass(); f.service().pass();
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]; assert.equal(call.args[0], path.join(sourceRoot, 'dispatch/dispatch.mjs')); assert.equal(call.args[1], high);
  assert.ok(!call.args.includes('--to')); assert.ok(!call.args.includes('--reuse'));
  assert.equal(call.options.env.HERDR_PANE_ID, undefined); assert.equal(call.options.env.HERDR_ENV, undefined);
});
test('blocked and reserved work stays held while another READY item dispatches', t => {
  const f = fixture(t), blocker = f.add('Blocker'); const blocked = f.add('Blocked', 20);
  f.record(['block', blocked, '--by', blocker]); const reserved = f.add('Reserved', 30); f.record(['set', reserved, 'meta.operator_reserved=true']);
  const ready = f.add('Ready', 10); f.service().pass(); f.service().pass();
  assert.equal(f.calls[0].args[1], ready); assert.equal(f.notes.length, 1); assert.match(f.notes[0].text, /reserved/);
});
test('STOP, HOLD and an incomplete tail prevent all effects', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service();
  fs.writeFileSync(path.join(s.directory, 'STOP'), 'stop'); assert.match(s.pass().held, /STOP/); fs.unlinkSync(path.join(s.directory, 'STOP'));
  fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/HOLD'), 'hold'); assert.match(s.pass().held, /HOLD/);
  fs.unlinkSync(path.join(f.repo, '.lane/supervisor/HOLD')); fs.appendFileSync(path.join(f.org, 'events.jsonl'), '{'); assert.match(s.pass().held, /tail/);
  assert.equal(f.calls.length, 0);
});
test('a real command refusal is recorded once and never re-executed on restart', t => {
  const f = fixture(t); f.add('Ready'); f.setFailure('native permission refused'); const s = f.service(); s.pass(); f.service().pass(); f.service().pass();
  assert.equal(f.calls.length, 1);
  const evidence = JSON.parse(fs.readFileSync(path.join(s.directory, 'effects.json'))); const action = Object.values(evidence.actions)[0];
  assert.equal(action.state, 'held'); assert.equal(action.receipt.status, 1); assert.match(action.error, /native permission/);
  assert.ok(f.notes.length <= 2);
});
test('unknown native capacity holds dispatch without spending an effect', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service({ capacity: () => { throw Object.assign(Error('actual cap reached'), { code: 'DISPATCH_SESSION_CAP' }); } });
  s.pass(); assert.equal(f.calls.length, 0);
  f.service().pass(); assert.equal(f.calls.length, 1);
});
test('singleton rejects a concurrent pass without stealing its owner', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service(), release = noticeLock(path.join(s.directory, 'pass.lock'));
  try { assert.throws(() => s.pass(), /locked/); assert.equal(f.calls.length, 0); } finally { release(); }
  s.pass(); assert.equal(f.calls.length, 1);
});
test('existing uncertain native review on any item run holds a second review', t => {
  const f = fixture(t), item = f.add('Code');
  const run = f.record(['start', item, '--workspace', f.repo]).match(/R-\d+/)[0];
  const events = loadEvents(f.org).events, identity = gitProject(f.repo).identity, current = fold(events).items.get(item);
  const directory = path.join(f.org, 'retirement/occupants'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'native.json'), JSON.stringify({ kind: 'settle', common: identity, run }));
  assert.equal(reviewAttempt(current, { org: f.org, identity, events }), 'existing native reviewer');
});
test('launchd uses only actual transport paths, an explicit project and no caller identity', () => {
  const plist = launchPlist({ label: 'fixture', repo: '/project', org: '/record', to: 'supervisor-test', herdr: '/bin/herdr', socket: '/actual/socket', directory: '/record/service', node: '/node20', searchPath: '/bin', interval: 30 });
  assert.match(plist, /--once/); assert.match(plist, /StartInterval.*30/); assert.match(plist, /HERDR_SOCKET_PATH/);
  assert.doesNotMatch(plist, /HERDR_ENV|PANE_ID|SESSION_ID|THREAD_ID/);
  assert.ok(!plist.includes('KeepAlive')); assert.match(plist, /<string>\/project<\/string>/);
});

test('historical closed, retired and unclaimed reports do not recreate review debt or disturb a held review', t => {
  const f = fixture(t);
  const reported = (title, workspace, owned = false) => {
    const item = f.add(title), run = f.record(['start', item, '--workspace', workspace]).match(/R-\d+/)[0];
    if (owned) f.record(['claim', run, '--controller', 'brain']);
    const file = f.show(run).report_path;
    fs.writeFileSync(file, `---\nrun: ${run}\noutcome: done\nsummary: Historical completed work.\nheadline: Historical work finished\nblockers: []\nproposals: []\nartifacts: []\n---\n`);
    f.record(['ingest', file]); return { item, run };
  };
  const old = reported('Old closed work', f.repo); f.record(['close', old.item]);
  const retired = path.join(f.repo, 'retired'); fs.mkdirSync(retired);
  const missing = reported('Retired work', retired, true); fs.rmSync(retired, { recursive: true });
  reported('Old unclaimed work', f.repo);
  const held = reported('Recent held async review', f.repo, true), saved = path.join(f.org, 'settle', `${held.run}.json`);
  fs.mkdirSync(path.dirname(saved), { recursive: true }); const receipt = '{"stage":"reviewing","reason":"native refusal; preserve original attempt"}\n'; fs.writeFileSync(saved, receipt);
  const ready = f.add('Independent ready work', 9);
  f.service().pass(); f.service().pass();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args[1], ready);
  assert.equal(f.notes.length, 0); assert.equal(fs.readFileSync(saved, 'utf8'), receipt);
  assert.equal(f.show(missing.run).abandoned, null); assert.equal(f.show(held.item).closed, null);
});

test('source inventory includes line-service, omits only Finder metadata and retains runtime parity guard', t => {
  const f = fixture(t);
  for (const name of ['line-service', 'lib']) fs.mkdirSync(path.join(f.repo, name));
  fs.writeFileSync(path.join(f.repo, 'line-service/line-service.mjs'), 'export const service = true;\n');
  fs.writeFileSync(path.join(f.repo, 'lib/module.mjs'), 'export const guard = true;\n');
  f.git(['add', 'line-service', 'lib']); f.git(['commit', '-qm', 'Runtime fixture']);
  fs.writeFileSync(path.join(f.repo, 'lib/.DS_Store'), 'Finder metadata');
  const captured = captureProductCheckout(f.repo);
  assert.ok(captured.runtime.includes('line-service/line-service.mjs'));
  assert.ok(!captured.runtime.some(file => file.endsWith('.DS_Store')));
  fs.writeFileSync(path.join(f.repo, 'lib/untracked-runtime.mjs'), 'export const extra = true;\n');
  assert.throws(() => captureProductCheckout(f.repo), /source runtime inventory mismatch/);
});
