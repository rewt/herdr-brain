import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retirementLock } from '../lib/retire-lock.mjs';
import { requestRetirement, consumeRetirement } from '../lib/retire-trigger.mjs';
import { ownerIdentity } from '../lib/process-owner.mjs';

const deadPid = 2147483647;
function fixture(t) {
  const org = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-lock-'));
  t.after(() => fs.rmSync(org, { recursive: true, force: true }));
  const lock = name => path.join(org, 'retirement', name);
  const seed = (file, receipt) => { fs.mkdirSync(file, { recursive: true }); fs.writeFileSync(path.join(file, 'owner.json'), JSON.stringify(receipt)); };
  return { org, lock, seed };
}

test('consume reclaims a proven dead owner and its dead recovery guard', t => {
  const f = fixture(t);
  requestRetirement({ org: f.org, eventSeq: 1, source: 'completion' });
  for (const name of ['consume.lock', 'consume.lock.recovery']) f.seed(f.lock(name), { pid: deadPid, identity: 'old-birth' });
  let planned = 0;
  const result = consumeRetirement({ org: f.org, retirement: () => ({
    plan: () => { planned++; const owner = JSON.parse(fs.readFileSync(path.join(f.lock('consume.lock'), 'owner.json')));
      assert.equal(owner.pid, process.pid); assert.equal(owner.identity, ownerIdentity(process.pid));
      return { close: [], keep: [], diagnostics: [] }; }, apply: () => [],
  }) });
  assert.equal(result.handled, true); assert.equal(planned, 1);
  assert.equal(fs.existsSync(f.lock('consume.lock')), false); assert.equal(fs.existsSync(f.lock('consume.lock.recovery')), false);
});

test('consume respects a live owner without observing or changing its receipt', t => {
  const f = fixture(t);
  requestRetirement({ org: f.org, eventSeq: 1, source: 'completion' });
  const owner = { pid: process.pid, identity: ownerIdentity(process.pid), token: 'live-owner' };
  f.seed(f.lock('consume.lock'), owner);
  assert.throws(() => consumeRetirement({ org: f.org, retirement: () => assert.fail('live consumer was replaced') }), /owner is live or unknown/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.lock('consume.lock'), 'owner.json'))), owner);
});

test('request recovers its dead owner without rereading the event log', t => {
  const f = fixture(t); f.seed(f.lock('request.lock'), { pid: deadPid, identity: 'old-birth' });
  requestRetirement({ org: f.org, eventSeq: 7, source: 'known event' });
  assert.equal(JSON.parse(fs.readFileSync(f.lock('request.json'))).event_seq, 7);
  assert.equal(fs.existsSync(f.lock('request.lock')), false);
});

test('unknown owners are retained, while PID reuse proves the recorded owner gone', t => {
  const f = fixture(t), file = f.lock('consume.lock');
  const owner = { pid: deadPid, identity: 'old-birth', token: 'old-token' }; f.seed(file, owner);
  const readProcess = pid => ({ ok: true, value: { pid, identity: 'new-birth', state: 'S' } });
  assert.throws(() => retirementLock(file, { readProcess: pid => pid === deadPid ? { ok: false, error: 'unreadable' } : readProcess(pid) }), /owner is live or unknown/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(file, 'owner.json'))), owner);
  const release = retirementLock(file, { readProcess });
  const current = JSON.parse(fs.readFileSync(path.join(file, 'owner.json')));
  assert.equal(current.identity, 'new-birth');
  // Releasing an older acquisition cannot remove a newer owner's directory.
  f.seed(file, { ...current, token: 'replacement-token' }); release();
  assert.equal(fs.existsSync(file), true);
});

test('an expired consumer deadline returns pending and leaves no lock or handled revision', t => {
  const f = fixture(t); requestRetirement({ org: f.org, eventSeq: 1, source: 'completion' });
  const result = consumeRetirement({ org: f.org, deadline: Date.now() - 1, retirement: () => assert.fail('deadline was ignored') });
  assert.equal(result.pending, true); assert.equal(result.handled, false);
  assert.equal(fs.existsSync(f.lock('consume.lock')), false); assert.equal(fs.existsSync(f.lock('handled.json')), false);
});

test('a partially applied deadline leaves its hint resumable and releases the consumer lock', t => {
  const f = fixture(t); requestRetirement({ org: f.org, eventSeq: 1, source: 'completion' });
  const result = consumeRetirement({ org: f.org, retirement: () => ({
    plan: () => ({ close: [{ tab_id: 'first' }, { tab_id: 'later' }], keep: [], diagnostics: [] }),
    apply: () => [{ tab_id: 'first', action: 'closed' }, { tab_id: 'later', action: 'deferred' }],
  }) });
  assert.equal(result.pending, true); assert.equal(fs.existsSync(f.lock('handled.json')), false); assert.equal(fs.existsSync(f.lock('consume.lock')), false);
  const resumed = consumeRetirement({ org: f.org, retirement: () => ({ plan: () => ({ close: [], keep: [], diagnostics: [] }), apply: () => [] }) });
  assert.equal(resumed.handled, true); assert.equal(resumed.revision, 1);
});

test('a returned skip-close at or past the deadline never acknowledges the hint', t => {
  const f = fixture(t); requestRetirement({ org: f.org, eventSeq: 1, source: 'completion' });
  const now = Date.now, deadline = now() + 60000;
  try {
    const result = consumeRetirement({ org: f.org, deadline, retirement: () => ({
      plan: () => ({ close: [{ tab_id: 'last' }], keep: [], diagnostics: [] }),
      apply: () => { Date.now = () => deadline; return [{ tab_id: 'last', action: 'skip-close' }]; },
    }) });
    assert.equal(result.pending, true); assert.equal(fs.existsSync(f.lock('handled.json')), false);
  } finally { Date.now = now; }
});

test('deadline diagnostics after an otherwise successful apply keep its hint pending', t => {
  const f = fixture(t); requestRetirement({ org: f.org, eventSeq: 1, source: 'completion' });
  const result = consumeRetirement({ org: f.org, retirement: () => ({
    diagnostics: [{ code: 'RETIREMENT_DEADLINE', reason: 'late pruning diagnostic' }],
    plan: () => ({ close: [], keep: [], diagnostics: [] }), apply: () => [{ action: 'closed' }],
  }) });
  assert.equal(result.pending, true); assert.equal(result.results[0].action, 'closed');
  assert.equal(fs.existsSync(f.lock('handled.json')), false); assert.equal(fs.existsSync(f.lock('consume.lock')), false);
});
