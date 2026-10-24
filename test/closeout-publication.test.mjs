import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture, isolatedEnv } from './helpers/retire-fixture.mjs';
import { loadEvents, transact } from '../lib/store.mjs';
import { bindCloseoutSources, publishCloseoutEvents, readCloseoutEntries, closeoutRevision } from '../lib/closeout.mjs';

function setup(t) {
  const f = fixture(t, { occupied: false });
  isolatedEnv(t, f);
  fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  fs.writeFileSync(f.eventFile, loadEvents(f.org).events.filter(e => !['report.ingested', 'item.closed'].includes(e.type))
    .map(e => JSON.stringify(e) + '\n').join(''));
  f.append = add => transact(f.org, events => bindCloseoutSources({ cwd: f.repo, org: f.org, env: f.env, events,
    mutation: { add } }), { actor: 'closeout publication fixture' }).added;
  f.publish = (added, start = false) => publishCloseoutEvents({ cwd: f.repo, org: f.org, env: f.env, added, start });
  return f;
}

test('notes and dispatch metadata do not inspect native state or touch an empty or pending closeout queue', t => {
  const f = setup(t), directory = path.join(f.common, 'closeout');
  for (const pending of [false, true]) {
    if (pending) {
      const source = f.append([{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: 'fixture' }]);
      assert.equal(f.publish(source).length, 1, 'the source creates a real pending request');
    }
    const before = readCloseoutEntries(f.common);
    const added = f.append([{ type: 'note.added', id: 'R-1', text: 'Dispatch: watcher ready; prompt not sent' },
      { type: 'run.updated', id: 'R-1', meta: { watcher_pid: 123, dispatch_waits: '[]' } }]);
    const probe = t.mock.method(childProcess, 'execFileSync', () => { throw Error('routine publication reached native discovery'); });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(f.publish(added, true), []);
      assert.equal(probe.mock.callCount(), 0);
    } finally { probe.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(readCloseoutEntries(f.common), before);
    if (!pending) assert.equal(fs.existsSync(directory), false, 'routine writes do not create an idle queue or lock');
  }
});

test('a revision without a pending request does not create an idle queue', t => {
  const f = setup(t);
  const added = f.append([{ type: 'run.abandoned', id: 'R-1', note: 'Superseded before closeout was requested' }]);
  assert.deepEqual(f.publish(added, true), []);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout')), false);
});

test('an existing empty queue still checks policy before processing a revision', t => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.common, 'closeout/entries'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":"invalid"}}');
  const added = f.append([{ type: 'run.abandoned', id: 'R-1', note: 'Superseded' }]);
  assert.throws(() => f.publish(added, true), /closeout policy invalid or unavailable/);
});

test('a related release still wakes a deferred request while routine metadata leaves it asleep', t => {
  const f = setup(t), starts = [];
  const source = f.append([{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: 'fixture' }]);
  assert.equal(f.publish(source).length, 1);
  const [entry] = readCloseoutEntries(f.common);
  f.append([{ type: 'closeout.evaluated', identity: f.common, key: entry.key, run: entry.run, item: entry.item,
    source: entry.source, completed: false, revision: entry.source.seq, reason: 'waiting for a related release' }]);
  const spawn = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    starts.push({ command, args, options });
    return { pid: 123, on() { return this; }, unref() {} };
  });
  syncBuiltinESMExports();
  try {
    const routine = f.append([{ type: 'run.updated', id: 'R-1', meta: { dispatch_waits: '[]' } }]);
    f.publish(routine, true);
    assert.equal(starts.length, 0);
    const release = f.append([{ type: 'retirement.release', run: 'R-1', item: 'ENG-1', confirmed: true }]);
    assert.equal(closeoutRevision(entry, loadEvents(f.org).events), release[0].seq);
    f.publish(release, true);
    assert.equal(starts.length, 1, 'the committed related revision starts the existing consumer path');
    assert.equal(starts[0].command, process.execPath);
    assert.deepEqual(starts[0].args.slice(1), ['drain', '--repo', f.repo, '--org', f.org]);
    assert.equal(starts[0].options.cwd, f.repo);
    assert.deepEqual(readCloseoutEntries(f.common), [entry]);
  } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
});
