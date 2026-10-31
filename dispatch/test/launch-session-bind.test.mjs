import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, promptCalls } from './dispatch-fixture.mjs';
import { workerSessionState } from '../worker-session.mjs';

const bindCalls = f => f.calls().filter(c => c.type === 'org' && c.a[0] === 'session-bind');
function editCommand(f, name, before, after) {
  const file = path.join(f.root, 'bin', name), source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(before));
  fs.writeFileSync(file, source.replace(before, after));
}

test('launch-time session commits before prompt even when task work hides the native foreground', t => {
  const f = fixture(t, { timingRecord: true });
  editCommand(f, 'herdr', "if(a[0]==='pane' && a[1]==='process-info') {", `if(a[0]==='pane' && a[1]==='process-info') {
    if(Object.values(workers).some(w=>w.agent_status==='working')) { console.error('native foreground unavailable during task'); process.exit(1); }`);
  editCommand(f, 'herdr', "workers[a[2]].agent_status='working';save();", `
    const events=fs.readFileSync(path.join(process.env.ORG_DIR,'events.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
    if(!events.some(e=>e.type==='run.session_bound')) { console.error('task started without binding'); process.exit(1); }
    workers[a[2]].agent_status='working';save();`);
  const result = f.start(); assert.equal(result.status, 0, result.stderr);
  const file = f.jobs()[0], job = JSON.parse(fs.readFileSync(file)), state = f.state();
  assert.equal(job.launchSessionBindProtocol, 1); assert.equal(job.sessionBinding.status, 'bound');
  assert.equal(state.sessionBindings.get(job.run).length, 1);
  const calls = f.calls(), bind = calls.findIndex(c => c.type === 'org' && c.a[0] === 'session-bind');
  const prompt = calls.findIndex(c => c.type === 'herdr' && c.a[1] === 'prompt');
  assert.ok(bind >= 0 && bind < prompt); assert.equal(bindCalls(f).length, 1); assert.equal(promptCalls(f).length, 1);
  assert.equal(calls.slice(prompt + 1).some(c => c.a[1] === 'process-info'), false);
  const native = JSON.parse(fs.readFileSync(path.join(f.root, 'workers')))[job.worker.agentName];
  const ready = workerSessionState({ id: job.run, journal: file, org: f.org, job, state,
    events: fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
    binding: { org: f.org, project: { identity: job.common, canonical: f.repo, checkout: job.workspace }, native } });
  assert.equal(ready.status, 'ready'); assert.equal(ready.event_seq, state.sessionBindings.get(job.run)[0].seq);
});

test('unknown pre-prompt writer reply keeps task unsent and recovers only the original proposal', t => {
  const f = fixture(t, { timingRecord: true }); f.fail('bind-lost-reply');
  const first = f.start(); assert.equal(first.status, 1); assert.match(first.stderr, /prompt not sent/);
  const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
  assert.equal(before.stage, 'prompt'); assert.equal(before.sessionBinding.commit_attempts[0].outcome, 'unknown');
  assert.equal(promptCalls(f).length, 0); assert.equal(f.state().sessionBindings.get(before.run).length, 1);
  f.fail(''); const retry = f.dispatch(['--retry', before.run]); assert.equal(retry.status, 0, retry.stderr);
  const after = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(after.sessionBinding.proposed, before.sessionBinding.proposed);
  assert.deepEqual(after.sessionBinding.commit_attempts[0], before.sessionBinding.commit_attempts[0]);
  assert.equal(after.sessionBinding.commit_attempts[1].receipt.recorded, false);
  assert.deepEqual(after.watcher, before.watcher); assert.deepEqual(after.worker, before.worker);
  assert.equal(f.state().sessionBindings.get(before.run).length, 1); assert.equal(promptCalls(f).length, 1);
});

test('pre-prompt binding refusal stays final without task delivery or another bind attempt', t => {
  const f = fixture(t, { timingRecord: true });
  editCommand(f, 'org', "if(type==='org') {", `if(type==='org') {
    if(a[0]==='session-bind') { console.error('record: injected original binding refusal'); process.exit(1); }`);
  const first = f.start(); assert.equal(first.status, 1); assert.match(first.stderr, /prompt not sent/);
  const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
  assert.equal(before.stage, 'prompt'); assert.equal(before.sessionBinding.record_refusal, true);
  assert.equal(before.sessionBinding.commit_attempts[0].outcome, 'refused');
  const retry = f.dispatch(['--retry', before.run]); assert.equal(retry.status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).sessionBinding, before.sessionBinding);
  assert.equal(bindCalls(f).length, 1); assert.equal(promptCalls(f).length, 0);
  assert.equal(f.state().sessionBindings.get(before.run), undefined);
});

test('saved requests without the launch binding protocol retain their post-delivery path', t => {
  const f = fixture(t, { timingRecord: true }); f.fail('prepare'); assert.equal(f.start().status, 1);
  const file = f.jobs()[0], saved = JSON.parse(fs.readFileSync(file)); delete saved.launchSessionBindProtocol;
  fs.writeFileSync(file, JSON.stringify(saved)); f.fail('');
  const result = f.dispatch(['--retry', file]); assert.equal(result.status, 0, result.stderr);
  const calls = f.calls(), bind = calls.findIndex(c => c.type === 'org' && c.a[0] === 'session-bind');
  const prompt = calls.findIndex(c => c.type === 'herdr' && c.a[1] === 'prompt');
  assert.ok(bind > prompt && prompt >= 0); assert.equal(bindCalls(f).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).launchSessionBindProtocol, undefined);
});
