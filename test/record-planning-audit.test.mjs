import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import observed, { recordSourceConflict } from '../lib/record-observation.mjs';
import { auditPolicyRead } from '../lib/config-audit.mjs';
import { contentDigest } from '../lib/config-home.mjs';
import { initOrg, loadEvents, planTransaction, transact } from '../lib/store.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-audit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, 'owner'), cwd = path.join(owner, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(owner, '.identity-root'), 'fixture\n');
  execFileSync('git', ['init', '-qb', 'main', cwd]);
  const env = { ...process.env, HOME: root, ORG_ACTOR: 'audit-fixture', HERDR_MONITOR_FLEET: path.join(root, 'fleet') };
  const priorFleet = process.env.HERDR_MONITOR_FLEET;
  process.env.HERDR_MONITOR_FLEET = env.HERDR_MONITOR_FLEET;
  t.after(() => {
    if (priorFleet === undefined) delete process.env.HERDR_MONITOR_FLEET;
    else process.env.HERDR_MONITOR_FLEET = priorFleet;
  });
  const dir = path.join(cwd, '.org'), home = path.join(root, '.herdr-monitor/owner');
  const folder = path.join(home, 'project'), file = path.join(folder, 'lane.json');
  fs.mkdirSync(folder, { recursive: true }); initOrg(dir);
  fs.writeFileSync(path.join(home, 'identity.json'), JSON.stringify({ identity_root: owner }));
  fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify({ identity: 'owner', common: path.join(cwd, '.git'), record: dir }));
  const write = n => fs.writeFileSync(file, JSON.stringify({ dispatch: { max_sessions: n } }));
  const audit = () => {
    const bytes = observed.readFileSync(file);
    return auditPolicyRead(file, JSON.parse(bytes), bytes, undefined, { cwd, env });
  };
  write(1); audit(); write(2);
  return { dir, file, write, audit, events: () => loadEvents(dir).events };
}

test('planning audits refresh a hand-edited policy once and commit with fresh events', t => {
  const f = fixture(t); let plans = 0, commits = 0;
  const result = planTransaction(f.dir, events => {
    plans++; f.audit();
    return { add: [{ type: 'future.planned', seen: events.length }], commit: () => { commits++; } };
  }, { replaySafe: true });
  assert.equal(plans, 2); assert.equal(commits, 1);
  assert.equal(result.added[0].seen, 2); assert.equal(result.added[0].seq, 3);
  assert.equal(f.events().filter(e => e.type === 'config.changed').length, 2);
  f.audit(); assert.equal(f.events().length, 3, 'the real digest dedupe appends nothing');
});

test('planning audits preserve replay opt-out and allow a fresh caller to recover', t => {
  const f = fixture(t); let plans = 0;
  const plan = () => { plans++; f.audit(); return { add: [{ type: 'future.planned' }] }; };
  assert.throws(() => planTransaction(f.dir, plan), /record planning conflict/);
  assert.equal(plans, 1); assert.equal(f.events().length, 2);
  assert.equal(planTransaction(f.dir, plan).added[0].seq, 3);
  assert.equal(plans, 2); assert.equal(f.events().length, 3);
});

for (const order of ['before', 'after']) test(`planning audits never excuse a generic nested write ${order} the audit`, t => {
  const f = fixture(t); let plans = 0, commits = 0;
  const effect = () => transact(f.dir, () => ({ add: [{ type: 'future.nested' }] }));
  assert.throws(() => planTransaction(f.dir, () => {
    plans++; if (order === 'before') effect(); f.audit(); if (order === 'after') effect();
    return { add: [{ type: 'future.forbidden' }], commit: () => { commits++; } };
  }, { replaySafe: true }), /record planning conflict/);
  assert.equal(plans, 1); assert.equal(commits, 0);
  assert.equal(f.events().filter(e => e.type === 'config.changed').length, 2);
  assert.equal(f.events().filter(e => e.type === 'future.nested').length, 1);
  assert.equal(f.events().length, 3);
});

test('planning audits stop after one audit refresh when policy keeps changing', t => {
  const f = fixture(t); let plans = 0, commits = 0;
  assert.throws(() => planTransaction(f.dir, () => {
    f.write(++plans + 2); f.audit();
    return { add: [{ type: 'future.forbidden' }], commit: () => { commits++; } };
  }, { replaySafe: true }), /record planning conflict/);
  assert.equal(plans, 2); assert.equal(commits, 0);
  assert.deepEqual(f.events().map(e => e.new_value.dispatch.max_sessions), [1, 3, 4]);
});

test('planning audits retain their refresh limit across read-set validation failures', t => {
  const f = fixture(t); let plans = 0;
  assert.throws(() => planTransaction(f.dir, () => {
    plans++; f.audit(); f.write(plans + 2);
    return { add: [{ type: 'future.forbidden' }] };
  }, { replaySafe: true }), /record observation conflict/);
  assert.equal(plans, 2); assert.equal(f.events().length, 3);
  assert.deepEqual(f.events().map(e => e.new_value.dispatch.max_sessions), [1, 2, 3]);
});

test('planning audits do not replay a refused native hook after refreshing', t => {
  const f = fixture(t); let plans = 0, native = 0;
  assert.throws(() => planTransaction(f.dir, () => {
    plans++; f.audit();
    return { add: [{ type: 'future.forbidden' }], commit: () => {
      native++; throw recordSourceConflict('native refused', 'RECORD_PLANNING_CONFLICT');
    } };
  }, { replaySafe: true }), /native refused/);
  assert.equal(plans, 2); assert.equal(native, 1); assert.equal(f.events().length, 2);
});

test('planning audits never refresh an audit transaction that failed after append', t => {
  const f = fixture(t), fsync = fs.fsyncSync; let plans = 0, flushes = 0;
  fs.fsyncSync = function(fd) {
    fsync.call(this, fd); flushes++;
    throw recordSourceConflict('audit flush receipt failed', 'RECORD_PLANNING_CONFLICT');
  };
  try {
    assert.throws(() => planTransaction(f.dir, () => {
      plans++; f.audit(); return { add: [{ type: 'future.forbidden' }] };
    }, { replaySafe: true }), /audit flush receipt failed/);
  } finally { fs.fsyncSync = fsync; }
  assert.equal(plans, 1); assert.equal(flushes, 1); assert.equal(f.events().length, 2);
});

test('planning audits recover a committed write intent without duplicating its completion', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file), operation = 'saved-intent';
  transact(f.dir, () => ({ add: [{ type: 'config.change-intent', file: f.file, operation, new_digest: contentDigest(bytes),
    new_value: JSON.parse(bytes), old_value: { dispatch: { max_sessions: 1 } }, old_digest: 'old', origin: 'command' }] }));
  let plans = 0;
  const result = planTransaction(f.dir, () => { plans++; f.audit(); return { add: [{ type: 'future.planned' }] }; }, { replaySafe: true });
  assert.equal(plans, 2); assert.equal(result.added[0].seq, 4);
  assert.equal(f.events().filter(e => e.type === 'config.changed' && e.operation === operation).length, 1);
});
