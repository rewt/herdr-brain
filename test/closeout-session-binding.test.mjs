import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { currentCloseoutEntries, bindCloseoutSources } from '../lib/closeout.mjs';
import { refreshCloseouts } from '../lib/closeout-consumer.mjs';
import { events, setup, effects, selectCurrentCleanup } from './helpers/closeout-fixture.mjs';

test('pending report and abandonment keep a valid delivery-time session binding for every outcome', t => {
  for (const outcome of ['done', 'blocked', 'needs_human', 'failed', 'abandoned']) {
    const f = setup(t, { direct: true, bound: true });
    const before = events(f), state = fold(before);
    assert.equal(effectiveWorkerIdentity(state.runs.get('R-1'), state).agent_session_id, 'session');
    const ending = outcome === 'abandoned' ? { type: 'run.abandoned', id: 'R-1' }
      : { type: 'report.ingested', run: 'R-1', report: { outcome }, sha256: 'fixture' };
    const mutation = bindCloseoutSources({ cwd: f.repo, org: f.org, events: before,
      mutation: { add: [{ type: 'note.added', id: 'R-1', text: 'before completion' }, ending] } });
    assert.equal(mutation.add[1].seq, undefined, 'the store still owns actual append stamping');
    assert.equal(mutation.add[1].closeout_targets[0].panes[0].session, 'session');
    const rows = f.append([{ type: 'note.added', id: 'R-1', text: 'before completion' }, ending]);
    const target = rows[1].closeout_targets[0];
    assert.equal(target.panes[0].session, 'session');
    assert.equal(target.panes[0].pane, 'w:p');
    const result = f.drain({ keys: [target.key] });
    if (outcome !== 'abandoned') {
      assert.equal(result.evaluated[0].completed, true, JSON.stringify(result));
      assert.equal(fs.existsSync(f.lane), false);
      assert.equal(f.read().tabs.length, 0);
      assert.equal(effects(f).filter(e => e.action === 'closed' && e.tab_id).length, 1);
      assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head, 'unlanded source remains recoverable');
    } else assert.equal(result.evaluated[0].sessions_retired, true, JSON.stringify(result));
  }
});

function emptyReport(t) {
  const f = setup(t, { direct: true, bound: true, merged: true });
  f.report();
  // Model immutable output of the old writer, not a new metadata/session bind.
  const legacy = events(f);
  legacy.find(e => e.type === 'report.ingested').closeout_targets[0].panes = [];
  fs.writeFileSync(f.eventFile, legacy.map(e => JSON.stringify(e) + '\n').join(''));
  selectCurrentCleanup(f);
  return f;
}

test('current line recovers empty unattempted report targets from original session evidence once and closes normally', t => {
  const f = emptyReport(t), before = fs.readFileSync(f.eventFile);
  const refresh = () => refreshCloseouts({ cwd: f.repo, org: f.org, env: f.env, retirementOptions: f.options });
  const result = refresh();
  assert.equal(result.created.length, 1, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0, before.length), before);
  const [entry] = currentCloseoutEntries(f.common, f.org, events(f));
  assert.equal(entry.source.type, 'cleanup.bound');
  assert.equal(entry.panes[0].session, 'session');
  assert.equal(entry.cleanup.empty_report_sources[0].type, 'report.ingested');
  assert.deepEqual(refresh().created, []);
  const closed = f.drain({ keys: [entry.key] });
  assert.equal(closed.evaluated[0].completed, true, JSON.stringify(closed));
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.read().tabs.length, 0);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
});

test('empty report recovery retains original native attempts, refusals and changed source identities', t => {
  for (const kind of ['unknown', 'failed', 'refused', 'head', 'working', 'session', 'HOLD']) {
    const f = emptyReport(t), [entry] = currentCloseoutEntries(f.common, f.org, events(f));
    if (kind === 'unknown' || kind === 'failed') transact(f.org, () => ({ add: [{
      type: kind === 'unknown' ? 'closeout.effect' : 'closeout.command-failed',
      key: entry.key, identity: f.common, run: entry.run, source: entry.source,
      effect: 'original-unknown', outcome: { action: 'agent-exit-requested', pane: 'w:p' },
    }] }));
    if (kind === 'refused') transact(f.org, () => ({ add: [{ type: 'closeout.evaluated',
      key: entry.key, identity: f.common, run: entry.run, source: entry.source, reason: 'EPERM native refusal' }] }));
    if (kind === 'head') f.git(['commit', '--allow-empty', '-m', 'changed source'], f.lane);
    if (kind === 'working') { f.state.agents[0].agent_status = 'working'; f.save(); }
    if (kind === 'session') { f.state.agents[0].agent_session.value = 'replacement'; f.save(); }
    if (kind === 'HOLD') fs.mkdirSync(path.join(f.repo, '.lane/supervisor/HOLD'), { recursive: true });
    const before = fs.readFileSync(f.eventFile);
    const refresh = () => refreshCloseouts({ cwd: f.repo, org: f.org, env: f.env, retirementOptions: f.options });
    if (kind === 'HOLD') assert.throws(refresh, /STOP\/HOLD/);
    else assert.deepEqual(refresh().created, [], kind);
    assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0, before.length), before);
    assert.deepEqual(f.read().actions, [], kind);
    assert.ok(fs.existsSync(f.lane), kind);
    assert.equal(events(f).some(e => e.type === 'cleanup.bound'), false, kind);
  }
});
