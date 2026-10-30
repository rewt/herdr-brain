import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTimeout } from '../../lib/deadline.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { runMetrics } from '../metrics.mjs';
import { readTiming, readAdmissionTiming } from '../../lib/run-timing.mjs';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { policyLocation } from '../../lib/config-home.mjs';
import { fixture, promptCalls, unlandedSetting, sessionCapSetting, provingWait, pendingItem, until, pauseHook, admissionHook, admissionAttempts } from './dispatch-fixture.mjs';

const DISPATCH = fileURLToPath(new URL('../dispatch.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const WATCH = fileURLToPath(new URL('../../watch/watch.mjs', import.meta.url));
test('awaited dispatch records the notification and plan step before launching and preserves retry flags', t => {
  const f = fixture(t); f.fail('dispatch');
  assert.equal(f.start(['--awaited', '--awaited-step', 'Cut RC-11']).status, 1);
  assert.equal(f.show(f.item).meta.notify, 'supervisor');
  assert.equal(f.show(f.item).meta.notify_step, 'Cut RC-11');
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(f.dispatch(['--retry', job.run, '--awaited']).status, 1);
  f.rec(['set', f.item, 'meta.notify=none']);
  f.fail(''); const retry = f.dispatch(['--retry', job.run, '--fresh']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(f.show(f.item).meta.notify, 'none', 'retry must not re-arm an operator-cleared notification');
});
// Current admission counts running native workers and uncertain starts, not
// landed histories. A surviving record start child holds the session slot.
for (const exceptional of [false, true]) for (const displayOnly of [false, true]) test(`a killed coordinator cannot release the last session slot while its ${exceptional ? 'unblocks follow-up' : 'item'} record start child survives${displayOnly ? ', even after retry with a display-only journal match' : ''}`, async t => {
  const f = fixture(t); sessionCapSetting(f, 1);
  const target = exceptional ? pendingItem(f).item : undefined;
  const other = f.rec(['add', 'Contending item', '--role', 'engineer']);
  const ready = path.join(f.root, 'writer-ready'), release = path.join(f.root, 'writer-release'), finished = path.join(f.root, 'writer-finished');
  const adapter = path.join(f.root, 'record-adapter');
  fs.writeFileSync(adapter, `#!/usr/bin/env node
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='start') {
 fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,parent:process.ppid}));
 const deadline=Date.now()+${loadTimeout(30000)};
 while(!fs.existsSync(${JSON.stringify(release)})) {
  if(Date.now()>deadline) throw Error('record writer barrier timed out');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
}
const result=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...args],{encoding:'utf8',env:process.env});
if(args[0]==='start') {fs.writeFileSync(${JSON.stringify(finished)},JSON.stringify({status:result.status,stderr:result.stderr}));}
else {process.stdout.write(result.stdout);process.stderr.write(result.stderr);}
process.exit(result.status??1);
`, { mode: 0o755 });
  const hook = admissionHook(f, `const rename=fs.renameSync;let once=true;fs.renameSync=function(from,to) {
 const result=rename.call(this,from,to);
 if(once && String(to).endsWith('/dispatch-session-cap')) {once=false;pause();}
 return result;
};`);
  const args = item => [item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief, ...(target ? ['--unblocks', target] : [])];
  const first = f.concurrent([...args(f.item), '--org-cli', adapter], hook);
  let second, journal, decoy;
  const held = stderr => {
    assert.match(stderr, /session cap 1 reached/);
    assert.ok(stderr.includes(`uncertain launch: pending start ${journal}`), stderr);
  };
  try {
    await until(() => fs.existsSync(hook.PAUSE_MARKER));
    second = f.concurrent(args(other), hook);
    await until(() => admissionAttempts(hook) === 2); // Both passed their early counts.
    fs.writeFileSync(hook.PAUSE_RELEASE, 'go');
    await until(() => fs.existsSync(ready));
    const writer = JSON.parse(fs.readFileSync(ready));
    // Mutation helpers now keep the record writer below a measured-activity
    // foreground owner. Killing its coordinator must still retain the child.
    const foreground=lookupProcess(writer.parent);
    assert.equal(foreground.ok,true,foreground.error);
    assert.equal(foreground.value?.ppid,first.child.pid);
    assert.match(foreground.value.command,/foreground-command\.mjs --owned-command/);
    journal = f.jobs().find(file => JSON.parse(fs.readFileSync(file)).item === f.item);
    const pending = JSON.parse(fs.readFileSync(journal));
    assert.equal(pending.stage, 'starting'); assert.equal(pending.run, null);
    assert.deepEqual([pending.unlandedCap.admission.kind, pending.unlandedCap.admission.admitted], ['regular', false],
      'landed-history accounting is diagnostic; running occupancy admits');
    assert.equal(pending.unblocks, target ?? null);
    if (exceptional) assert.ok(f.state().links.some(l => l.blocker === f.item && l.blocked === target), 'the follow-up relation stays validated and recorded');
    assert.equal(first.child.kill('SIGKILL'), true);
    assert.equal((await first.done).signal, 'SIGKILL');
    assert.equal(lookupProcess(writer.pid).value?.pid, writer.pid, 'the orphan writer must remain able to append');
    const refused = await second.done;
    assert.equal(refused.status, 1, refused.stderr);
    held(refused.stderr);
    assert.equal(JSON.parse(fs.readFileSync(JSON.parse(refused.stdout).journal)).stage, 'worker', 'refused before any native launch');
    assert.deepEqual(f.show(f.item).runs, []);
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
    assert.equal(promptCalls(f).length, 0);
    if (displayOnly) {
      // A reported ordinary run can acquire every matching display field later.
      decoy = pendingItem(f, { item: f.item, admitted: false }).run;
      const report = path.join(f.root, 'decoy-report.md');
      fs.writeFileSync(report, `---\nrun: ${decoy}\noutcome: done\nsummary: Ordinary run finished\n---\n`);
      f.rec(['ingest', report]);
      f.rec(['set', decoy, `dispatch_journal=${journal}`, `dispatch_attempt=${pending.token}`,
        `dispatch_unlanded_admitted=${pending.unlandedCap.admission.admitted}`]);
      const state = f.state();
      fs.appendFileSync(path.join(f.org, 'events.jsonl'), JSON.stringify({ type: 'promotion.reconciled', seq: state.eventCount + 1,
        at: new Date().toISOString(), by: 'dispatch-test-agent', identity: pending.common,
        items: [f.item], runs: [decoy], heads: [{ item: f.item, run: decoy, head: 'a'.repeat(40) }] }) + '\n');
      for (const recovery of [[], ['--recover-run', decoy]]) {
        const retry = f.dispatch(['--retry', journal, ...recovery]);
        assert.equal(retry.status, 1, retry.stderr);
        assert.match(retry.stderr, recovery.length ? /recovery run does not belong/ : /record start outcome is unknown/);
        const saved = JSON.parse(fs.readFileSync(journal));
        assert.equal(saved.stage, 'starting'); assert.equal(saved.run, null);
      }
      const contender = f.jobs().find(file => JSON.parse(fs.readFileSync(file)).item === other);
      const stillRefused = f.dispatch(['--retry', contender]);
      assert.equal(stillRefused.status, 1, stillRefused.stderr);
      held(stillRefused.stderr);
      assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false); assert.equal(promptCalls(f).length, 0);
      assert.equal(lookupProcess(writer.pid).value?.pid, writer.pid, 'retry cannot free capacity while the original writer can append');
    }
  } finally {
    fs.writeFileSync(hook.PAUSE_RELEASE, 'go'); fs.writeFileSync(release, 'go');
    await Promise.all([first.done, second?.done]);
    if (fs.existsSync(ready)) await until(() => fs.existsSync(finished));
  }
  const written = JSON.parse(fs.readFileSync(finished)); assert.equal(written.status, 0, written.stderr);
  assert.equal(f.show(f.item).runs.length, displayOnly ? 2 : 1, 'the surviving child commits after the contender is refused');
  const recovered = f.dispatch(['--retry', journal]); assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(f.show(f.item).runs.length, displayOnly ? 2 : 1, 'recovery adopts the matching original start without another run');
  const run = JSON.parse(recovered.stdout).run;
  assert.notEqual(run, decoy, 'the display-only match cannot replace the original dispatch start');
  assert.equal(f.show(run).meta.dispatch_unlanded_admitted, false);
  // The recovered worker now holds the only slot until its run finishes.
  const contender = f.jobs().find(file => JSON.parse(fs.readFileSync(file)).item === other);
  const full = f.dispatch(['--retry', contender]); assert.equal(full.status, 1, full.stderr);
  assert.match(full.stderr, new RegExp(`session cap 1 reached: ${run}`));
  f.rec(['abandon', run]);
  const admitted = f.dispatch(['--retry', contender]); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(f.show(other).runs.length, 1, 'the refused contender keeps its one started run and launches once');
  assert.equal(promptCalls(f).length, 2);
});
test('dispatch journals memory and final admission gates and mirrors allowlisted events into run metadata', t => {
  const f = fixture(t);
  const result = f.start(); assert.equal(result.status, 0, result.stderr);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  const events = fs.readFileSync(`${f.jobs()[0]}.events.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => [e.kind, e.outcome]), [
    ['memory_open', 'entry'], ['memory_open', 'granted'], ['memory_worker', 'entry'], ['memory_worker', 'granted'],
  ]);
  const admission = readAdmissionTiming(f.jobs()[0]);
  assert.deepEqual(admission.map(e => [e.kind, e.outcome]), [['admission_lock', 'entry'], ['admission_lock', 'granted']]);
  const metadata = JSON.parse(f.show(job.run).meta.dispatch_waits);
  assert.deepEqual(metadata, events.map(e => ({ ...e, run: job.run })));
  const extra = JSON.parse(f.show(job.run).meta.dispatch_admission_waits);
  assert.deepEqual(extra, admission.map(e => ({ ...e, run: job.run })));
  for (const e of [...metadata, ...extra]) {
    assert.deepEqual(Object.keys(e), ['at', 'run', 'item', 'lane', 'kind', 'outcome']);
    assert.equal(e.item, f.item); assert.equal(e.lane, `topic-${f.item.toLowerCase()}`);
  }
});

test('failed timing record sets leave lane open, launch and prompt delivery unchanged and clocks missing', t => {
  const normal = fixture(t), failed = fixture(t, { timingFailure: true });
  for (const f of [normal, failed]) {
    const result = f.start(); assert.equal(result.status, 0, result.stderr);
    assert.equal(promptCalls(f).length, 1);
  }
  const stages = f => f.calls().filter(c => c.type === 'lane').map(c => c.a[0]);
  assert.deepEqual(stages(failed), stages(normal));
  const job = JSON.parse(fs.readFileSync(failed.jobs()[0]));
  assert.equal(job.stage, 'complete'); assert.equal(job.timing_missing, 5);
  assert.equal(failed.show(job.run).meta.dispatch_waits, undefined);
  assert.equal(failed.show(job.run).meta.dispatch_admission_waits, undefined);
  const { summary } = runMetrics([failed.show(job.run)]);
  assert.equal(summary.dispatch_wait_s.missing, 1);
  assert.equal(summary.waits_s.memory_worker.missing, 1);
});

test('recovery skips timing record sets when metadata already equals the journal', t => {
  const f = fixture(t, { timingRecord: true }); f.fail('watch');
  assert.equal(f.start().status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  const sets = () => f.calls().filter(c => c.type === 'org' && c.a[0] === 'set' && /^(dispatch_waits|dispatch_admission_waits)=/.test(c.a[2])).length;
  const before = sets(); assert.equal(before, 5);
  f.fail(''); const result = f.dispatch(['--retry', job.run]);
  assert.equal(result.status, 0, result.stderr); assert.equal(sets(), before);
});

test('failed timing record sets preserve STOP during the worker proving wait and its stopped receipt', async t => {
  for (const timingFailure of [false, true]) {
    const f = fixture(t, { timingFailure }), { pending, held } = await provingWait(f, 'worker');
    let result;
    try {
      const stop = path.join(f.repo, '.lane/supervisor/STOP');
      fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'Operator stop');
      result = await pending.done;
    } finally {
      held.release();
      await pending.done;
    }
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.result, 'stopped'); assert.equal(receipt.stage, 'worker');
    assert.equal(receipt.reason, 'Supervisor STOP appeared before dispatch; no new worker launched');
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
    assert.equal(promptCalls(f).length, 0);
    if (timingFailure) assert.equal(JSON.parse(fs.readFileSync(receipt.journal)).timing_missing, 3);
  }
});

test('REV-63 stopped dispatch publishes completion',async t=>{
  const f=fixture(t),{pending,held}=await provingWait(f,'worker');
  const journal=f.jobs()[0],original=JSON.parse(fs.readFileSync(journal));
  assert.equal(original.completion_protocol,1);assert.equal(original.stage,'worker');
  assert.equal(fs.readFileSync(journal+'.lock','utf8'),String(pending.child.pid));
  const stop=path.join(f.repo,'.lane/supervisor/STOP');let result;
  try{
    fs.mkdirSync(path.dirname(stop),{recursive:true});fs.writeFileSync(stop,'Operator stop');
    result=await pending.done;
  }finally{held.release();await pending.done;}
  assert.equal(result.status,0,result.stderr);
  const response=JSON.parse(result.stdout),job=JSON.parse(fs.readFileSync(journal));
  assert.equal(response.result,'stopped');assert.equal(response.stage,'worker');assert.equal(response.journal,journal);
  const history=fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const rows=history.filter(e=>e.type==='dispatch.completed');assert.equal(rows.length,1,result.stderr);
  const status=rows[0],claim=history.findLast(e=>e.type==='run.claimed'&&e.run===job.run);
  assert.equal(status.journal,journal);assert.equal(status.attempt,original.token);assert.equal(status.item,f.item);
  assert.equal(status.project,job.common);assert.equal(status.run,original.run);assert.equal(status.run,claim.run);
  assert.equal(job.ownership.generation,claim.seq);assert.equal(status.exit_code,0);assert.equal(status.stage,'worker');
  assert.equal(status.failure.code,'DISPATCH_STOPPED');assert.equal(status.failure.kind,'fence');assert.equal(status.native_launch_attempted,false);
  assert.equal(f.calls().some(c=>c.type==='lane'&&c.a[0]==='dispatch'),false);assert.equal(promptCalls(f).length,0);
  assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='open').length,1);
  assert.equal(fs.readFileSync(stop,'utf8'),'Operator stop');assert.equal(fs.existsSync(journal+'.lock'),false);
});

test('dispatch defaults to its recorded worker while explicit and saved recipients win', t => {
  const f = fixture(t, {noticeRecipient: 'ops-project'}); f.fail('prepare');
  const first = f.start(); assert.equal(first.status, 1);
  const journal = f.jobs()[0];
  assert.equal(JSON.parse(fs.readFileSync(journal)).to, null, 'default waits for actual worker recording');
  assert.equal(f.calls().some(c => c.type === 'herdr' && c.a[2] === 'ops-project'), false);
  f.fail(''); const resumed = f.dispatch(['--retry', journal]); assert.equal(resumed.status, 0, resumed.stderr);
  const job = JSON.parse(fs.readFileSync(journal));
  assert.equal(job.to, job.worker.agentName);
  assert.equal(f.show(job.run).meta.agent, job.to, 'recipient is the recorded worker');
  const watchers = () => f.calls().filter(c => c.type === 'watch');
  assert.equal(watchers()[0].a[watchers()[0].a.indexOf('--to') + 1], job.to);
  const prompt = promptCalls(f)[0].a[3];
  assert.ok(prompt.includes(`--to ${job.to}`));
  assert.ok(prompt.includes('exceptions to your PROJECT SUPERVISOR at "ops-project"'), prompt);
  assert.match(prompt, /Self-land your own finished committed source/);
  assert.match(prompt, /single record queue-review path; the line service creates\/dispatches the one review item/);
  assert.match(prompt, /Never start a parallel settle\/lane review/);
  f.env.MONITOR_SUPERVISOR_AGENT = 'ops-explicit';
  const repeated = f.dispatch(['--retry', job.run]); assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(fs.readFileSync(journal)).to, job.to);
  assert.equal(watchers().length, 1); assert.equal(promptCalls(f).length, 1);
  const other = fixture(t, {noticeRecipient: 'ops-project'}); other.fail('prepare');
  assert.equal(other.start(['--to', 'ops-explicit']).status, 1);
  const explicitJournal = other.jobs()[0];
  assert.equal(JSON.parse(fs.readFileSync(explicitJournal)).to, 'ops-explicit');
  assert.deepEqual(other.calls().find(c => c.type === 'herdr' && c.a[1] === 'get').a, ['agent', 'get', 'ops-explicit']);
  other.fail(''); const explicit = other.dispatch(['--retry', explicitJournal]); assert.equal(explicit.status, 0, explicit.stderr);
  const explicitJob = JSON.parse(fs.readFileSync(explicitJournal));
  assert.equal(explicitJob.to, 'ops-explicit');
  const watch = other.calls().find(c => c.type === 'watch');
  assert.equal(watch.a[watch.a.indexOf('--to') + 1], 'ops-explicit');
  const savedWatcher = explicitJob.watcher;
  other.env.MONITOR_SUPERVISOR_AGENT = 'supervisor-herdr';
  const retained = other.dispatch(['--retry', explicitJob.run]); assert.equal(retained.status, 0, retained.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(explicitJournal)).watcher, savedWatcher);
  assert.equal(other.calls().filter(c => c.type === 'watch').length, 1);
  assert.equal(promptCalls(other).length, 1);
  assert.equal(f.calls().some(c => c.a.includes('chat-operator')), false);
});
test('dispatch owner delivery refuses a replaced occupant before watcher recovery', t => {
  const f = fixture(t); f.fail('watch');
  const first = f.start(); assert.equal(first.status, 1);
  const journal = f.jobs()[0], job = JSON.parse(fs.readFileSync(journal));
  assert.equal(job.to, job.worker.agentName);
  assert.equal(f.show(job.run).meta.agent, job.to);
  const workersFile = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(workersFile));
  workers[job.to].terminal_id = 'foreign-terminal';
  fs.writeFileSync(workersFile, JSON.stringify(workers)); f.fail('');
  const retry = f.dispatch(['--retry', job.run]);
  assert.equal(retry.status, 1); assert.match(retry.stderr, /worker occupant identity changed/);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1, 'no watcher is armed for a replacement');
  assert.equal(promptCalls(f).length, 0);
});
test('source-selected cold dispatch preserves home policy and saved-operation roots', async t => {
  const project = configFixture(t); await project.adopt();
  const f = fixture(t, { project, sourceEntry: true });
  const source = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const first = f.start(['--to', 'ops-project'], {entry: path.join(project.bundle, 'dispatch/dispatch.mjs')}); assert.equal(first.status, 0, first.stderr);
  const savedFile = f.jobs()[0], saved = JSON.parse(fs.readFileSync(savedFile));
  assert.equal(saved.release.root, project.bundle, 'the saved operation belongs to its original immutable bundle');
  f.env.HERDR_BRAIN_ROOT = source;
  const retry = f.dispatch(['--retry', saved.run]); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(fs.readFileSync(savedFile)).release.root, project.bundle);
  assert.equal(f.show(saved.run).owner.release.root, project.bundle);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1, 'saved retry retains its one watcher');
  const report = f.show(saved.run).report_path;
  fs.writeFileSync(report, `---\nrun: ${saved.run}\noutcome: done\nsummary: Fixture complete\n---\n`); f.rec(['ingest', report]);
  const pin = policyLocation(f.repo, 'pin', f.env).file, pinBytes = fs.readFileSync(pin);
  const item = f.rec(['add', 'Fresh source-selected work', '--role', 'engineer']);
  const fresh = f.dispatch([item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief]);
  assert.equal(fresh.status, 0, fresh.stderr);
  const job = f.jobs().map(file => JSON.parse(fs.readFileSync(file))).find(job => job.run !== saved.run);
  assert.equal(job.release.root, source);
  assert.equal(job.sourceSelection.root, source); assert.match(job.sourceSelection.head, /^[a-f0-9]{40}$/);
  assert.equal(f.show(job.run).owner.release.root, source, 'new claim binds the actual selected source');
  assert.equal(job.to, job.worker.agentName); assert.equal(f.show(job.run).meta.agent, job.to);
  const watchers = f.calls().filter(c => c.type === 'watch');
  assert.equal(watchers.length, 2, 'one watcher per distinct run');
  assert.equal(watchers[1].a[watchers[1].a.indexOf('--to') + 1], job.to);
  assert.deepEqual(fs.readFileSync(pin), pinBytes, 'source selection never edits the adopted project pin');
  f.env.HERDR_BRAIN_ROOT = f.repo;
  const invalidItem = f.rec(['add', 'Mismatched source must not dispatch', '--role', 'engineer']);
  const mismatch = f.dispatch([invalidItem, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief]);
  assert.equal(mismatch.status, 1); assert.match(mismatch.stderr, /must match the invoked development source root/);
  assert.equal(f.jobs().length, 2); assert.deepEqual(f.show(invalidItem).runs, []);
});
test('open/prepare failures keep a visible request, create no run, and retry cleanly',t=>{
  for(const stage of ['open','prepare']) {
    const f=fixture(t);f.fail(stage);let r=f.start();assert.equal(r.status,1);const journal=f.jobs()[0];
    const job=JSON.parse(fs.readFileSync(journal));assert.equal(job.run,null);assert.match(job.error,/injected/);
    f.fail('');r=f.dispatch(['--retry',journal]);assert.equal(r.status,0,r.stderr);assert.equal(promptCalls(f).length,1);
  }
});
test('watch failure records a worker but never sends work; retry reuses the same worker/run',t=>{
  const f=fixture(t);f.fail('watch');let r=f.start();assert.equal(r.status,1);
  const job=JSON.parse(fs.readFileSync(f.jobs()[0]));assert.equal(job.stage,'watch');assert.ok(f.show(job.run).meta.agent);
  assert.equal(promptCalls(f).length,0);assert.match(f.show(job.run).notes.at(-1).text,/incomplete/);
  f.fail('');r=f.dispatch(['--retry',job.run]);assert.equal(r.status,0,r.stderr);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='dispatch').length,1);
});
test('uncertain launch refuses automatic replay and requires explicit adoption',t=>{
  const f=fixture(t);f.fail('uncertain-launch');assert.equal(f.start().status,1);
  const job=JSON.parse(fs.readFileSync(f.jobs()[0]));f.fail('');let r=f.dispatch(['--retry',job.run]);assert.equal(r.status,1);assert.match(r.stderr,/--adopt/);
  r=f.dispatch(['--retry',job.run,'--adopt','worker-1']);assert.equal(r.status,0,r.stderr);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='dispatch').length,1);
});
test('uncertain prompt refuses automatic resend; caller can authorize it after inspection',t=>{
  const f=fixture(t);f.fail('prompt');assert.equal(f.start().status,1);const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  f.fail('');let r=f.dispatch(['--retry',job.run]);assert.equal(r.status,1);assert.match(r.stderr,/delivery outcome is unknown/);assert.equal(promptCalls(f).length,1);
  r=f.dispatch(['--retry',job.run,'--resend']);assert.equal(r.status,0,r.stderr);assert.equal(promptCalls(f).length,2);
});
test('retry pins routes across config edits and detects a replaced occupant',t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex',model:'changed',effort:'low'}}}));
  f.fail('');let r=f.dispatch(['--retry',job.run]);assert.equal(r.status,0,r.stderr);assert.equal(f.show(job.run).meta.model,'model-a');
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));workers[job.worker.agentName].terminal_id='replacement';fs.writeFileSync(file,JSON.stringify(workers));
  r=f.dispatch(['--retry',job.run]);assert.equal(r.status,1);assert.match(r.stderr,/occupant identity changed/);assert.equal(promptCalls(f).length,1);
});
test('base moves a clean reused lane only by fast-forward; dirty lane is preserved',t=>{
  const f=fixture(t),first=f.start();assert.equal(first.status,0,first.stderr);
  const finish=run=>{const report=path.join(f.root,'base-report.md');
    fs.writeFileSync(report,`---\nrun: ${run}\noutcome: done\nsummary: Base round complete\n---\n`);f.rec(['ingest',report]);};
  finish(JSON.parse(first.stdout).run);
  fs.writeFileSync(path.join(f.repo,'second'),'second');f.git(['add','second']);f.git(['commit','-m','base advance']);
  let r=f.start(['--base','main']);assert.equal(r.status,0,r.stderr);assert.equal(f.git(['rev-parse','HEAD'],path.join(f.root,'lane')),f.git(['rev-parse','main']));
  finish(JSON.parse(r.stdout).run);
  fs.writeFileSync(path.join(f.root,'lane','dirty'),'dirty');r=f.start(['--base','main']);assert.equal(r.status,1);assert.match(r.stderr,/clean lane/);
});
test('lost record start result is visible and recovered without starting a second run',t=>{
  const f=fixture(t),adapter=path.join(f.root,'record-adapter');
  unlandedSetting(f,1);
  fs.writeFileSync(adapter,`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2),r=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...a],{encoding:'utf8',env:process.env});
if(a[0]==='start') { console.error('lost start response');process.exit(1); }
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);
`,{mode:0o755});
  let r=f.start(['--org-cli',adapter]);assert.equal(r.status,1);const journal=f.jobs()[0],job=JSON.parse(fs.readFileSync(journal));assert.equal(job.stage,'starting');assert.equal(job.run,null);
  assert.equal(f.show('R-1').meta.dispatch_journal,journal);
  r=f.dispatch(['--retry',journal]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).run,'R-1');
  assert.equal(f.show(f.item).runs.length,1);
});
test('live request locks refuse retries without changing the journal',t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);const journal=f.jobs()[0],before=fs.readFileSync(journal,'utf8');
  fs.writeFileSync(journal+'.lock',String(process.pid));
  const r=f.dispatch(['--retry',journal]);assert.equal(r.status,1);assert.match(r.stderr,/already running/);assert.equal(fs.readFileSync(journal,'utf8'),before);
});
test('explicit fresh launch and accepted delivery recover uncertain attempts',t=>{
  const f=fixture(t);f.fail('dispatch');assert.equal(f.start().status,1);const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  f.fail('prompt');let r=f.dispatch(['--retry',job.run,'--fresh']);assert.equal(r.status,1);assert.match(r.stderr,/injected prompt/);
  f.fail('');r=f.dispatch(['--retry',job.run,'--accept-delivered']);assert.equal(r.status,0,r.stderr);assert.equal(promptCalls(f).length,1);
});
test('invalid route and empty brief mutate neither lane nor record',t=>{
  const f=fixture(t);let r=f.dispatch([f.item,'--lane','topic','--route','missing','--brief',f.brief]);assert.equal(r.status,1);assert.match(r.stderr,/unknown route/);
  fs.writeFileSync(f.brief,'');r=f.start();assert.equal(r.status,1);assert.match(r.stderr,/nonempty/);
  assert.equal(f.calls().filter(x=>x.type==='lane').length,0);assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
});

test('a refused record start with no matching run retries the saved request',t=>{
  const f=fixture(t),adapter=path.join(f.root,'record-adapter'),refuse=path.join(f.root,'refuse-start');
  fs.writeFileSync(refuse,'yes');
  fs.writeFileSync(adapter,`#!/usr/bin/env node
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2);
if(a[0]==='start' && fs.existsSync(${JSON.stringify(refuse)})) { console.error('record: injected record refusal');process.exit(1); }
const r=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...a],{encoding:'utf8',env:process.env});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);
`,{mode:0o755});
  let r=f.start(['--org-cli',adapter]);assert.equal(r.status,1);
  const journal=f.jobs()[0];assert.equal(JSON.parse(fs.readFileSync(journal)).stage,'starting');
  assert.deepEqual(f.show(f.item).runs,[]);
  fs.unlinkSync(refuse);r=f.dispatch(['--retry',journal,'--org-cli',adapter]);assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).run,'R-1');assert.equal(promptCalls(f).length,1);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='open').length,1);
});
test('retry locks before reading its journal so another retry cannot replay stale progress',async t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);
  const journal=f.jobs()[0];f.fail('');
  const hook=pauseHook(f,`let once=true;fs.readFileSync=function(file,...args) {
 const value=read.call(fs,file,...args);
 if(once && String(file)===${JSON.stringify(journal)}) {once=false;pause();}
 return value;
};`);
  const first=f.concurrent(['--retry',journal],hook);
  try {
    await until(()=>fs.existsSync(hook.PAUSE_MARKER));
    const second=f.dispatch(['--retry',journal]);
    assert.equal(second.status,1,second.stderr);assert.match(second.stderr,/already running/);
  } finally { fs.writeFileSync(hook.PAUSE_RELEASE,'go');await first.done; }
  assert.equal((await first.done).status,0);
  assert.equal(promptCalls(f).length,1);assert.equal(f.calls().filter(x=>x.type==='watch').length,2);
  assert.equal(f.dispatch(['--retry',journal]).status,0);assert.equal(promptCalls(f).length,1);
});
test('two retries cannot both take over a dead-owner lock',async t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);
  const journal=f.jobs()[0];f.fail('');
  const dead=spawnSync(process.execPath,['-e',''],{encoding:'utf8'}).pid;
  fs.writeFileSync(journal+'.lock',String(dead));
  fs.mkdirSync(journal+'.locks',{recursive:true});fs.writeFileSync(path.join(journal+'.locks',`${dead}-crashed`),'');
  const hook=pauseHook(f,`process.kill=function(pid,...args) {
 if(pid===${dead}) { try {return kill.call(process,pid,...args);} catch(error) {pause();throw error;} }
 return kill.call(process,pid,...args);
};`);
  const first=f.concurrent(['--retry',journal],hook);
  try {
    await until(()=>fs.existsSync(hook.PAUSE_MARKER));
    const second=f.dispatch(['--retry',journal]);
    assert.equal(second.status,1,second.stderr);assert.match(second.stderr,/already running/);
  } finally { fs.writeFileSync(hook.PAUSE_RELEASE,'go');await first.done; }
  assert.equal((await first.done).status,0);assert.equal(promptCalls(f).length,1);
  assert.equal(fs.existsSync(journal+'.lock'),false);
  assert.deepEqual(fs.readdirSync(journal+'.locks'),[]);
});

test('an unknown start outcome with no match stays conservative; multiple matches require explicit recovery',t=>{
  const f=fixture(t),adapter=path.join(f.root,'record-adapter');
  fs.writeFileSync(adapter,`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2);
if(a[0]==='start') {console.error('unknown transport failure');process.exit(1);}
const r=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...a],{encoding:'utf8',env:process.env});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);
`,{mode:0o755});
  assert.equal(f.start(['--org-cli',adapter]).status,1);
  const journal=f.jobs()[0],job=JSON.parse(fs.readFileSync(journal));
  let r=f.dispatch(['--retry',journal]);assert.equal(r.status,1);assert.match(r.stderr,/--recover-run/);
  assert.deepEqual(f.show(f.item).runs,[]);
  for(let i=0;i<2;i++)f.rec(['start',f.item,'--route',job.route,'--route-config',job.routeConfig,
    '--workspace',job.workspace,'--meta',`lane=${job.lane}`,'--meta',`dispatch_journal=${journal}`,
    '--meta',`dispatch_project=${job.common}`,'--meta',`dispatch_attempt=${job.token}`,
    '--meta',`dispatch_record=${job.org}`,
    '--meta',`dispatch_unlanded_admitted=${job.unlandedCap.admission.admitted}`]);
  r=f.dispatch(['--retry',journal]);assert.equal(r.status,1);assert.match(r.stderr,/multiple matches/);
  assert.equal(promptCalls(f).length,0);assert.equal(f.show(f.item).runs.length,2);
  // Recover the current match (an older one is superseded at launch); also
  // cover a committed run whose brief was never materialized.
  fs.unlinkSync(f.show('R-2').brief_path);
  r=f.dispatch(['--retry',journal,'--recover-run','R-2']);assert.equal(r.status,0,r.stderr);
  assert.ok(fs.readFileSync(f.show('R-2').brief_path,'utf8').includes('R-2'));
  assert.equal(JSON.parse(r.stdout).run,'R-2');assert.equal(f.show(f.item).runs.length,2);
});
