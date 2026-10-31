import test from '../../test/helpers/bounded-test.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerAlive } from '../../lib/process-owner.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { effectiveWorkerIdentity } from '../../lib/worker-identity.mjs';
import { fixture, promptCalls, until, pauseHook, savedReuse, hooksTableScreen, startupHookReviewScreen } from './dispatch-fixture.mjs';

const DISPATCH = fileURLToPath(new URL('../dispatch.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const WATCH = fileURLToPath(new URL('../../watch/watch.mjs', import.meta.url));
// A refused saved request appends only its own completion status.
function onlyCompletion(f, before, journal) {
  const after = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  assert.deepEqual(after.subarray(0, before.length), before);
  const added = after.subarray(before.length).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(added.map(e => [e.type, e.journal, e.stage, e.run, e.exit_code]), [['dispatch.completed', journal, 'open', null, 1]]);
}
for (const mode of ['legacy', 'history', 'lost-reply', 'refused']) test(mode === 'refused'
  ? 'explicit dispatch retry keeps a saved proposal record refusal final without native observation or prompt'
  : `timely saved unbound proposal retries through dispatch without a new native observation or prompt (${mode})`, t => {
  const refused = mode === 'refused';
  const f = fixture(t, { lateSession: 'delayed', timingRecord: mode === 'lost-reply' });
  const first = f.start(); assert.equal(first.status, 0, first.stderr);
  const file = f.jobs()[0], job = JSON.parse(fs.readFileSync(file)), b = job.sessionBinding;
  const eventFile = path.join(f.org, 'events.jsonl');
  const events = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type !== 'run.session_bound');
  fs.writeFileSync(eventFile, events.map((e, i) => JSON.stringify({ ...e, seq: i + 1 }) + '\n').join(''));
  b.status = 'unbound'; const at = Date.now() - 120000;
  b.prompted_at = b.proposed.prompted_at = new Date(at).toISOString();
  b.deadline = b.proposed.deadline = new Date(at + 60000).toISOString();
  b.proposed.observed_at = new Date(at + 30000).toISOString();
  b.reason = 'record: original legacy refusal';
  if (mode === 'legacy' || mode === 'lost-reply') delete b.commit_attempts;
  if (refused) b.record_refusal = true;
  fs.writeFileSync(file, JSON.stringify(job));
  const reads = () => fs.readFileSync(path.join(f.root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(c => c.a[0] === 'pane' && c.a[1] === 'process-info').length;
  if (mode === 'lost-reply') f.fail('bind-lost-reply');
  const before = reads(), retry = f.dispatch(['--retry', job.run]); assert.equal(retry.status, 0, retry.stderr);
  let after = JSON.parse(fs.readFileSync(file));
  const history = b.commit_attempts ?? [];
  if (mode === 'lost-reply') {
    assert.equal(after.sessionBinding.status, 'observing');
    assert.equal(after.sessionBinding.commit_attempts.at(-1).outcome, 'unknown');
    assert.deepEqual(after.sessionBinding.commit_attempts[0].reopened_from, { status: b.status, reason: b.reason });
    const attempts = after.sessionBinding.commit_attempts;
    f.fail('');
    const recovered = f.dispatch(['--retry', job.run]); assert.equal(recovered.status, 0, recovered.stderr);
    after = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(after.sessionBinding.commit_attempts.slice(0, -1), attempts);
  }
  assert.equal(after.sessionBinding.status, refused ? 'unbound' : 'bound');
  assert.equal(reads(), before); assert.equal(promptCalls(f).length, 1);
  assert.deepEqual(after.sessionBinding.proposed, b.proposed); assert.equal(after.sessionBinding.deadline, b.deadline);
  assert.deepEqual(after.watcher, job.watcher);
  if (refused) {
    assert.deepEqual(after.sessionBinding, b);
    assert.equal(f.state().sessionBindings.get(job.run), undefined);
  } else {
    const attempts = after.sessionBinding.commit_attempts, reopened = attempts[history.length];
    assert.deepEqual(attempts.slice(0, history.length), history);
    assert.equal(attempts.length, history.length + (mode === 'lost-reply' ? 3 : 2));
    assert.equal(reopened.outcome, 'reopened');
    assert.deepEqual(reopened.reopened_from, { status: b.status, reason: b.reason });
    assert.ok(Number.isFinite(Date.parse(reopened.started_at)));
    assert.equal(reopened.finished_at, reopened.started_at);
    assert.equal(attempts.at(-1).outcome, 'bound');
    assert.equal(after.sessionBinding.reason, undefined);
    const binds = f.state().sessionBindings.get(job.run);
    assert.equal(binds.length, 1);
    assert.equal(after.sessionBinding.commit_receipt.event_seq, binds[0].seq);
    assert.equal(after.sessionBinding.commit_receipt.recorded, true);
  }
  assert.equal(effectiveWorkerIdentity(f.state().runs.get(job.run), f.state()).identity_conflict, false);
});
test('fake Herdr readers see complete worker state while a concurrent writer is paused mid-write', async t => {
  const f = fixture(t), first = f.start(); assert.equal(first.status, 0, first.stderr);
  const agent = JSON.parse(first.stdout).agent, state = path.join(f.root, 'workers');
  const workers = JSON.parse(fs.readFileSync(state)); workers[agent].agent_status = 'idle';
  fs.writeFileSync(state, JSON.stringify(workers));
  const marker = path.join(f.root, 'publication-paused'), release = path.join(f.root, 'publication-release');
  const preload = path.join(f.root, 'publication.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const write=fs.writeFileSync;fs.writeFileSync=function(file,data,...args){
 if(String(file).startsWith(${JSON.stringify(state)})){
  write(file,String(data).slice(0,5),...args);write(${JSON.stringify(marker)},'paused');
  const end=Date.now()+${loadTimeout(10000)};
  while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('publication fixture timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 }return write.call(this,file,data,...args);
};syncBuiltinESMExports();`);
  const herdr = path.join(f.root, 'bin/herdr'), env = { ...process.env, FAKE_ROOT: f.root };
  const writer = spawnChild(t, process.execPath, [herdr, 'agent', 'prompt', agent], {
    cwd: f.repo, env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` },
  });
  const done = waitForExit(writer);
  try {
    await until(() => fs.existsSync(marker));
    const reader = spawnSync(process.execPath, [herdr, 'agent', 'get', agent], { env, encoding: 'utf8' });
    assert.equal(reader.status, 0, reader.stderr);
    assert.equal(JSON.parse(reader.stdout).result.agent.agent_status, 'idle');
    assert.equal(JSON.parse(fs.readFileSync(state))[agent].agent_status, 'idle');
  } finally { fs.writeFileSync(release, 'go'); await done; }
  const result = await done; assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(state))[agent].agent_status, 'working');
});
test('delayed native session binds separately before a saved same-session continuation reuses it', t => {
  const f = fixture(t, { lateSession: 'delayed', timingRecord: true });
  const first = f.start(); assert.equal(first.status, 0, first.stderr);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])), run = f.show(job.run);
  assert.equal(run.meta.agent_session_id, undefined, 'receipt remains terminal-only');
  assert.equal(f.state().sessionBindings.get(job.run).length, 1);
  assert.equal(effectiveWorkerIdentity(run, f.state()).agent_session_id, 's-worker-1');
  assert.equal(job.sessionBinding.status, 'bound');
  assert.equal(Date.parse(job.sessionBinding.deadline) - Date.parse(job.sessionBinding.prompted_at), 60000);
  const calls = f.calls(), receipt = calls.findIndex(c => c.type === 'org' && c.a[0] === 'worker');
  assert.ok(receipt < calls.findIndex(c => c.type === 'herdr' && c.a[1] === 'prompt'));
  f.rec(['abandon', job.run]);
  const file = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(file));
  workers['worker-1'].agent_status = 'idle'; fs.writeFileSync(file, JSON.stringify(workers));
  const next = f.dispatch(['--retry', savedReuse(f, job.run)]); assert.equal(next.status, 0, next.stderr);
  const nextRun = f.show(JSON.parse(next.stdout).run);
  assert.equal(nextRun.meta.agent_session_id, 's-worker-1');
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(promptCalls(f).length, 2);
});

test('ordinary retry after a blocked first delivery binds without another worker or watcher', t => {
  const f = fixture(t, { lateSession: 'delayed' }); f.fail('screen');
  assert.equal(f.start().status, 1);
  const before = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(before.stage, 'prompt'); assert.equal(before.sessionBinding, undefined);
  f.fail(''); const retry = f.dispatch(['--retry', before.run]); assert.equal(retry.status, 0, retry.stderr);
  const after = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(after.sessionBinding.status, 'bound'); assert.equal(promptCalls(f).length, 1);
  assert.equal(f.state().sessionBindings.get(before.run).length, 1);
  assert.deepEqual(after.launchProcess, before.launchProcess);
  assert.deepEqual(after.watcher, before.watcher);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
});

for (const recovery of ['resend', 'accept-delivered']) test(`${recovery} binds an expired uncertain delivery once using original launch evidence`, t => {
  const f = fixture(t, { lateSession: 'delayed' });
  f.fail(recovery === 'resend' ? 'prompt-blocked' : 'prompt-lost-reply');
  const first = f.start(); assert.equal(first.status, 1);
  assert.match(first.stderr, recovery === 'resend' ? /agent_blocked/ : /lost prompt reply/);
  const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file)); assert.equal(before.stage, 'prompting');
  // The trust prompt in the reported incident held delivery for three minutes.
  // Age the saved opportunity without sleeping or changing its identity anchors.
  const attempted = Date.now() - 180000;
  before.sessionBinding.prompted_at = new Date(attempted).toISOString();
  before.sessionBinding.deadline = new Date(attempted + 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify(before));
  f.fail('');
  const uncertain = f.dispatch(['--retry', before.run]);
  assert.equal(uncertain.status, 1); assert.match(uncertain.stderr, /prompt delivery outcome is unknown/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).sessionBinding, before.sessionBinding);
  assert.equal(f.state().sessionBindings.get(before.run), undefined); assert.equal(promptCalls(f).length, 1);
  const retry = f.dispatch(['--retry', before.run, `--${recovery}`]); assert.equal(retry.status, 0, retry.stderr);
  const after = JSON.parse(fs.readFileSync(file)), state = f.state(), run = f.show(before.run);
  assert.equal(JSON.parse(retry.stdout).binding.status, 'bound'); assert.equal(after.stage, 'complete');
  assert.equal(after.sessionBinding.status, 'bound');
  assert.ok(Date.parse(after.sessionBinding.prompted_at) > Date.parse(before.sessionBinding.deadline));
  assert.equal(Date.parse(after.sessionBinding.deadline) - Date.parse(after.sessionBinding.prompted_at), 60000);
  assert.deepEqual(after.sessionBinding.process, before.sessionBinding.process);
  assert.deepEqual(after.sessionBinding.receipt, before.sessionBinding.receipt);
  assert.deepEqual(after.launchProcess, before.launchProcess); assert.deepEqual(after.watcher, before.watcher);
  assert.equal(run.meta.agent_session_id, undefined, 'original receipt remains terminal-only');
  assert.equal(effectiveWorkerIdentity(run, state).agent_session_id, 's-worker-1');
  assert.equal(state.sessionBindings.get(before.run).length, 1);
  const prompts = recovery === 'resend' ? 2 : 1;
  assert.equal(promptCalls(f).length, prompts);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1);
  assert.equal(f.dispatch(['--retry', before.run, `--${recovery}`]).status, 0);
  assert.deepEqual(f.state().sessionBindings.get(before.run), state.sessionBindings.get(before.run));
  assert.equal(promptCalls(f).length, prompts);
});

for (const recovery of ['resend', 'accept-delivered']) {
  for (const field of ['name', 'terminal_id']) test(`${recovery} refuses a changed worker ${field} without binding or delivering`, t => {
    const f = fixture(t, { lateSession: 'delayed' }); f.fail('prompt-blocked'); assert.equal(f.start().status, 1);
    const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
    const workerFile = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(workerFile));
    workers[before.worker.agentName][field] = 'replacement'; fs.writeFileSync(workerFile, JSON.stringify(workers));
    f.fail(''); const retry = f.dispatch(['--retry', before.run, `--${recovery}`]);
    assert.equal(retry.status, 1); assert.match(retry.stderr, /worker occupant identity changed/);
    assert.equal(f.state().sessionBindings.get(before.run), undefined); assert.equal(promptCalls(f).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).sessionBinding, before.sessionBinding);
  });
  test(`${recovery} rejects a replacement native process in the original terminal`, t => {
    const f = fixture(t, { lateSession: 'replacement-before-prompt' }); f.fail('prompt-blocked'); assert.equal(f.start().status, 1);
    const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
    f.fail(''); const retry = f.dispatch(['--retry', before.run, `--${recovery}`]); assert.equal(retry.status, 0, retry.stderr);
    const after = JSON.parse(fs.readFileSync(file));
    assert.equal(after.sessionBinding.status, 'unbound'); assert.equal(after.sessionBinding.reason, 'native process changed');
    assert.deepEqual(after.sessionBinding.process, before.sessionBinding.process);
    assert.equal(f.state().sessionBindings.get(before.run), undefined);
  });
}

for (const mode of ['replacement', 'replacement-before-prompt']) test(`same-terminal ${mode} keeps the original launch unbound despite matching topology`, t => {
  const f = fixture(t, { lateSession: mode }), result = f.start();
  assert.equal(result.status, 0, result.stderr);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(job.sessionBinding.status, 'unbound'); assert.match(job.sessionBinding.reason, /process changed/);
  assert.equal(f.state().sessionBindings.get(job.run), undefined);
  assert.equal(promptCalls(f).length, 1);
});

for (const fault of ['after-prompt', 'bind-lost-reply']) test(`${fault} recovers within the saved opportunity without replaying delivery`, t => {
  const f = fixture(t, { lateSession: 'delayed', timingRecord: true }); f.fail(fault);
  const first = f.start(); assert.equal(first.status, fault === 'after-prompt' ? 1 : 0, first.stderr);
  const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
  assert.equal(before.stage, 'complete');
  if (fault === 'bind-lost-reply') {
    assert.ok(before.sessionBinding.proposed);
    assert.deepEqual(JSON.parse(first.stdout).binding, { status: 'unknown', retry: `node dispatch/dispatch.mjs --retry ${before.run}` });
    assert.match(first.stderr, /bind reply unknown; saved proposal awaits line replay/);
    assert.equal(f.show(before.run).notes.some(n => /bind reply unknown/.test(n.text)), false);
    f.rec(['abandon', before.run]); // Exact reply recovery also works after finishing.
  }
  f.fail('');
  const retry = f.dispatch(['--retry', before.run]); assert.equal(retry.status, 0, retry.stderr);
  const after = JSON.parse(fs.readFileSync(file));
  assert.equal(after.sessionBinding.deadline, before.sessionBinding.deadline);
  assert.equal(after.sessionBinding.status, 'bound');
  assert.equal(f.state().sessionBindings.get(before.run).length, 1);
  assert.equal(promptCalls(f).length, 1);
});

test('the saved bind writer finishes without the observation SIGKILL deadline', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-writer-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const preload = path.join(scratch, 'near-deadline.cjs');
  fs.writeFileSync(preload, `if(process.argv[1]===${JSON.stringify(DISPATCH)}) {
const fs=require('node:fs'), rename=fs.renameSync;
fs.renameSync=function(from,to) {
  const result=rename.call(this,from,to);
  if(String(to).endsWith('.json')) {
    const job=JSON.parse(fs.readFileSync(to,'utf8'));
    if(job.sessionBinding?.proposed) Date.now=()=>Date.parse(job.sessionBinding.deadline)-1;
  }
  return result;
};
}`);
  const f = fixture(t, { lateSession: 'delayed', preload });
  const result = f.start(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).binding.status, 'bound');
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(f.state().sessionBindings.get(job.run).length, 1);
  assert.equal(promptCalls(f).length, 1);
});
for (const [screenName, screen, count] of [
  ['startup dialog', startupHookReviewScreen, '1 hook is new or changed.'],
  ['captured hooks event table', hooksTableScreen, '1 hook needs review before it can run.'],
]) for (const profile of [undefined, 'claude-mem-bastian']) test(`Codex ${screenName} blocks the brief visibly in ${profile ?? 'the default profile'} and ordinary retry delivers once`, t => {
  const f = fixture(t);
  if (profile) fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({
    routes: { engineer: { kind: 'codex', model: 'model-a', effort: 'high', args: ['--profile', profile] } },
  }));
  fs.writeFileSync(path.join(f.root, 'screen'), screen);
  const first = f.start(); assert.equal(first.status, 1, first.stderr);
  const blocked = JSON.parse(first.stdout), job = JSON.parse(fs.readFileSync(blocked.journal));
  assert.equal(blocked.result, 'blocked'); assert.equal(blocked.code, 'DISPATCH_HOOK_REVIEW');
  assert.equal(blocked.run, job.run); assert.equal(blocked.pane, job.worker.pane);
  assert.ok(first.stderr.includes(count)); assert.match(first.stderr, /Open \/hooks/);
  assert.ok(first.stderr.includes(profile ?? 'configured default profile'));
  assert.equal(job.stage, 'prompt'); assert.equal(promptCalls(f).length, 0);
  assert.match(f.show(job.run).notes.at(-1).text, /hook-review dialog.*brief not sent/);
  const watcher = job.watcher;
  assert.equal(f.dispatch(['--retry', job.run]).status, 1); assert.equal(promptCalls(f).length, 0);
  // A changed live config must not misidentify the profile of the saved worker.
  if (profile) {
    fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({routes:{engineer:{kind:'codex',args:['-p','other']}}}));
    assert.ok(f.dispatch(['--retry', job.run]).stderr.includes(profile));
  }
  fs.writeFileSync(path.join(f.root, 'screen'), '› Ready for a task');
  const retry = f.dispatch(['--retry', job.run]); assert.equal(retry.status, 0, retry.stderr);
  const resumed = JSON.parse(retry.stdout); assert.equal(resumed.run, job.run); assert.equal(resumed.agent, job.worker.agentName);
  assert.deepEqual(resumed.watcher, watcher); assert.equal(promptCalls(f).length, 1);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1);
  assert.equal(f.calls().some(c => c.a.includes('send-keys')), false, 'dispatch never accepts hook trust');
  const reads = f.calls().filter(c => c.a[0] === 'pane' && c.a[1] === 'read');
  for (const read of reads) assert.deepEqual(read.a, ['pane','read',job.worker.pane,'--source','visible','--format','text']);
  assert.equal(f.dispatch(['--retry', job.run]).status, 0); assert.equal(promptCalls(f).length, 1);
});
test('screen read failure leaves delivery unsent and retryable', t => {
  const f = fixture(t); f.fail('screen'); const first = f.start();
  assert.equal(first.status, 1); assert.match(first.stderr, /screen read failure/);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])); assert.equal(job.stage, 'prompt'); assert.equal(promptCalls(f).length, 0);
  f.fail(''); const retry = f.dispatch(['--retry', job.run]); assert.equal(retry.status, 0, retry.stderr); assert.equal(promptCalls(f).length, 1);
});
test('an explicitly authorized resend also checks the hook dialog and preserves uncertain delivery', t => {
  const f = fixture(t); f.fail('prompt'); assert.equal(f.start().status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])); f.fail('');
  fs.writeFileSync(path.join(f.root, 'screen'), startupHookReviewScreen.replace('1 hook is', '2 hooks are'));
  const stopped = f.dispatch(['--retry', job.run, '--resend']); assert.equal(stopped.status, 1);
  assert.equal(JSON.parse(stopped.stdout).result, 'blocked'); assert.equal(promptCalls(f).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).stage, 'prompting');
  fs.writeFileSync(path.join(f.root, 'screen'), '› Ready');
  assert.equal(f.dispatch(['--retry', job.run]).status, 1, 'uncertain earlier delivery still needs explicit recovery');
  const retry = f.dispatch(['--retry', job.run, '--resend']); assert.equal(retry.status, 0, retry.stderr); assert.equal(promptCalls(f).length, 2);
});
test('Linux dispatch watcher receipt and journal round-trip as strings through record set', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-linux-identity-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const preload = path.join(scratch, 'linux.cjs'), boot = '12345678-1234-4234-8234-123456789abc';
  fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
if(process.argv[1]===${JSON.stringify(DISPATCH)}||path.basename(process.argv[1]||'')==='watch') {
Object.defineProperty(process,'platform',{value:'linux'});
const read=fs.readFileSync;
fs.readFileSync=function(file,...args){
if(file==='/proc/sys/kernel/random/boot_id') return ${JSON.stringify(boot + '\n')};
const match=String(file).match(/^\\/proc\\/(\\d+)\\/stat$/);
if(match){const pid=Number(match[1]);process.kill(pid,0);return pid+' (watcher) S '+[1,pid,...Array(16).fill(0),'12345'].join(' ')+'\\n';}
if(file==='/proc/meminfo') return 'MemTotal: 16777216 kB\\nMemAvailable: 8388608 kB\\nSwapTotal: 0 kB\\nSwapFree: 0 kB\\n';
return read.call(this,file,...args);};require('node:module').syncBuiltinESMExports();}
`);
  const f = fixture(t, { preload });
  const r = f.start(); assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(r.stdout), job = JSON.parse(fs.readFileSync(receipt.journal));
  const identity = f.show(receipt.run).meta.watcher_identity;
  assert.equal(typeof identity, 'string');
  assert.equal(identity, receipt.watcher.identity);
  assert.equal(identity, job.watcher.identity);
  const readProcess = birth => pid => lookupProcess(pid, { platform: 'linux', identityOnly: true, readFile: file =>
    file === '/proc/sys/kernel/random/boot_id' ? `${boot}\n` : `${pid} (watcher) S ${[1, pid, ...Array(16).fill(0), birth].join(' ')}\n` });
  assert.equal(ownerAlive({ pid: receipt.watcher.pid, identity }, readProcess('12345')), true);
  assert.equal(ownerAlive({ pid: receipt.watcher.pid, identity }, readProcess('12346')), false);
  const retry = f.dispatch(['--retry', receipt.journal]); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(f.show(receipt.run).meta.watcher_identity, identity);
  assert.equal(promptCalls(f).length, 1);
});
for (const configured of [false, true]) test(`worker prompt preserves the final test selection (declared fast tier ${configured})`,t=>{
  const f=fixture(t), before=fs.readFileSync(f.brief,'utf8');
  if (configured) fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ fast: 'npm run test:fast' }));
  const configFile = path.join(f.repo, '.lane.json'), config = JSON.parse(fs.readFileSync(configFile));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, archive: { dirs: ['docs/reports', '../evidence'] } }));
  const r=f.start(['--report','docs/reports/round.md','--extra','Fix round: inspect the review.']);assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout),run=f.show(result.run);
  assert.deepEqual([run.meta.route,run.meta.harness,run.meta.model,run.meta.effort,run.meta.lane],['engineer','codex','model-a','high',`topic-${f.item.toLowerCase()}`]);
  assert.equal(run.meta.agent,result.agent);assert.equal(run.meta.pane,result.pane);
  assert.equal(run.report_path,path.join(f.root,'lane','docs/reports/round.md'));
  assert.equal(run.meta.watcher_pid,result.watcher.pid);
  const context = fs.readFileSync(run.brief_path, 'utf8');
  assert.match(context, /## Durable locations/);
  assert.ok(context.includes(path.join(f.repo, 'docs/reports')));
  assert.ok(context.includes(path.join(f.root, 'evidence')));
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(job.routeConfig)), 'archive'), false, 'route snapshots stay routing-only');
  const calls=f.calls(),watch=calls.findIndex(x=>x.type==='watch'),prompt=calls.findIndex(x=>x.a[1]==='prompt');assert.ok(watch<prompt);
  assert.equal(job.base, f.git(['rev-parse','HEAD']), 'new requests freeze their resolved source base');
  assert.deepEqual(calls.find(x=>x.type==='lane'&&x.a[0]==='open').a, ['open',run.meta.lane,job.base,'--git-only']);
  assert.match(promptCalls(f)[0].a[3],new RegExp(result.run));assert.ok(promptCalls(f)[0].a[3].includes(run.brief_path));
  assert.ok(promptCalls(f)[0].a[3].includes(run.report_path));assert.match(promptCalls(f)[0].a[3],/Fix round/);
  assert.match(promptCalls(f)[0].a[3], /Run only the ask's or explicit --extra scope's focused check selection once through.*check --cmd 'COMMAND' on the clean committed candidate/);
  assert.match(promptCalls(f)[0].a[3], /If no check is selected or applicable, report the selection\/scope and unrun truth/);
  assert.doesNotMatch(promptCalls(f)[0].a[3], /use check without --cmd|default test command without configuration|npm run test:fast/);
  assert.match(promptCalls(f)[0].a[3], /Do not add a tier run or repeat tests/);
  assert.match(promptCalls(f)[0].a[3], /\.lane\/gate\.json.*TAP totals and Node version/);
  assert.equal(fs.readFileSync(f.brief,'utf8'),before);
  assert.equal(f.dispatch(['--retry',result.run]).status,0);assert.equal(promptCalls(f).length,1);
});
test('new reuse is refused; a saved fix round can reuse a stopped worker, fresh starts stay fresh and a changed route is refused',t=>{
  const f=fixture(t);let r=f.start();assert.equal(r.status,0,r.stderr);const first=JSON.parse(r.stdout);
  const report=path.join(f.root,'first-report.md');
  fs.writeFileSync(report,`---\nrun: ${first.run}\noutcome: done\nsummary: First round complete\n---\n`);f.rec(['ingest',report]);
  const workerFile=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(workerFile));workers[first.agent].agent_status='idle';fs.writeFileSync(workerFile,JSON.stringify(workers));
  const removedRuns=f.show(f.item).runs,removedCalls=f.calls().length,removedJobs=f.jobs().length,removedEvents=fs.readFileSync(path.join(f.org,'events.jsonl'));
  r=f.start(['--reuse',first.run]);assert.equal(r.status,1);assert.match(r.stderr,/new work starts fresh; use --resume-session UUID/);
  assert.equal(JSON.parse(r.stdout).result,'failed');assert.equal(JSON.parse(r.stdout).journal,undefined,'no request is saved');
  assert.deepEqual(f.show(f.item).runs,removedRuns);assert.equal(f.jobs().length,removedJobs);assert.equal(f.calls().length,removedCalls);
  assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),removedEvents);
  r=f.dispatch(['--retry',savedReuse(f,first.run)]);assert.equal(r.status,0,r.stderr);const second=JSON.parse(r.stdout);assert.notEqual(second.run,first.run);assert.equal(second.agent,first.agent);
  assert.equal(second.pane,first.pane);
  const continued=f.show(second.run),previous=f.show(first.run);
  assert.equal(continued.meta.continuation_of,first.run);assert.equal(continued.meta.same_session,true);
  assert.equal(continued.meta.agent_session_id,previous.meta.agent_session_id);
  r=f.start();assert.equal(r.status,1,r.stderr);assert.equal(JSON.parse(r.stdout).code,'DISPATCH_LANE_OCCUPIED');
  assert.deepEqual(f.show(f.item).runs,[first.run,second.run],'an open fix round still owns the lane');
  fs.writeFileSync(report,`---\nrun: ${second.run}\noutcome: done\nsummary: Fix round complete\n---\n`);f.rec(['ingest',report]);
  r=f.start();assert.equal(r.status,0,r.stderr);assert.notEqual(JSON.parse(r.stdout).agent,first.agent);
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex',model:'changed',effort:'high'}}}));
  const changed=savedReuse(f,first.run),runs=f.show(f.item).runs,calls=f.calls().length,jobs=f.jobs().length;
  r=f.dispatch(['--retry',changed]);assert.equal(r.status,1);assert.match(r.stderr,/declared harness/);
  assert.equal(JSON.parse(r.stdout).code,'REUSE_MISMATCH');assert.deepEqual(f.show(f.item).runs,runs);
  assert.equal(f.jobs().length,jobs);assert.equal(f.calls().slice(calls).filter(c=>c.type==='lane').length,0);
});
test('a real detached watcher acknowledges initialization and sheds supervisor pane identity',async t=>{
  // Omitted --to deliberately exercises the supported worker callback.
  // The loaded-start control below covers an explicit supervisor recipient.
  const f=fixture(t,{realWatch:true});const r=f.start();assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);
  assert.ok(result.watcher.pid);process.kill(result.watcher.pid,0);
  const job=JSON.parse(fs.readFileSync(result.journal));
  assert.equal(job.to,result.agent);
  const until=Date.now()+3000;
  while(!f.calls().some(x=>x.type==='herdr'&&x.a[2]===result.agent&&x.pane===null)&&Date.now()<until) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(f.calls().some(x=>x.type==='herdr'&&x.a[2]===result.agent&&x.pane===null));
  assert.ok(fs.readFileSync(result.watcher.log,'utf8').includes(`supervisor ${result.agent}`));
  const duplicate=spawnSync(process.execPath,[WATCH,result.run,'--org',f.org,'--detach','--log',path.join(f.root,'duplicate.log')],{cwd:f.repo,env:{...process.env,ORG_ACTOR:'dispatch-test-agent',PATH:`${path.join(f.root,'bin')}:${process.env.PATH}`,FAKE_ROOT:f.root},encoding:'utf8'});
  assert.equal(duplicate.status,1);assert.match(fs.readFileSync(path.join(f.root,'duplicate.log'),'utf8'),/another watcher/);
});
test('a run ID supplied as ITEM is refused before creating a lane or journal',t=>{
  const f=fixture(t),run=f.rec(['start',f.item]).match(/^(R-\d+) started/m)[1];
  const r=f.dispatch([run,'--lane','topic','--route','engineer','--brief',f.brief]);
  assert.equal(r.status,1);assert.match(r.stderr,/must be an item/);
  assert.equal(f.calls().filter(x=>x.type==='lane').length,0);
  assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
  assert.deepEqual(f.show(f.item).runs,[run]);
});
test('saved reuse refuses an idle worker whose previous run is still open',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='idle';fs.writeFileSync(file,JSON.stringify(workers));
  const r=f.dispatch(['--retry',savedReuse(f,first.run)]);assert.equal(r.status,1);assert.match(r.stderr,/reported or abandoned/);
  assert.equal(JSON.parse(r.stdout).code,'REUSE_RUN_OPEN');
  assert.equal(promptCalls(f).length,1);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='dispatch').length,1);
  assert.deepEqual(f.show(f.item).runs,[first.run]);
});
test('saved reuse accepts an abandoned run with the same stopped occupant',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
  const r=f.dispatch(['--retry',savedReuse(f,first.run)]);assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).agent,first.agent);
});

test('saved reuse lane, route and declared-field mismatches refuse before any lane or run side effect',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const config=JSON.parse(fs.readFileSync(path.join(f.repo,'.lane.json')));
  config.routes.other={...config.routes.engineer};
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify(config));
  for(const field of ['lane','route','harness','model','effort']) {
    const changed=structuredClone(config);
    if(field==='harness') changed.routes.engineer.kind='claude';
    if(['model','effort'].includes(field)) changed.routes.engineer[field]='changed';
    fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify(changed));
    const saved=savedReuse(f,first.run,[f.item,'--lane',field==='lane'?'other-lane':'topic','--route',field==='route'?'other':'engineer','--brief',f.brief]);
    const events=fs.readFileSync(path.join(f.org,'events.jsonl')),calls=f.calls().length,jobs=f.jobs().length;
    const r=f.dispatch(['--retry',saved]);
    assert.equal(r.status,1,field);assert.equal(JSON.parse(r.stdout).code,'REUSE_MISMATCH',r.stderr);
    onlyCompletion(f,events,saved);
    assert.equal(f.jobs().length,jobs);assert.equal(f.calls().slice(calls).filter(c=>c.type==='lane').length,0);
  }
});

test('from-run refuses another item and superseded origins before opening a lane or starting a run',t=>{
  const f=fixture(t),other=f.rec(['add','Other item','--role','engineer']).split(' ')[0];
  const first=f.rec(['start',f.item]).match(/R-\d+/)[0],later=f.rec(['start',f.item]).match(/R-\d+/)[0];
  const foreign=f.rec(['start',other]).match(/R-\d+/)[0];
  for(const run of [first,later,foreign]) f.rec(['claim',run,'--controller','brain']);
  for(const [origin,code] of [[foreign,'FROM_RUN_OTHER_ITEM'],[first,'FROM_RUN_SUPERSEDED']]) {
    const events=fs.readFileSync(path.join(f.org,'events.jsonl'));
    const r=f.start(['--from-run',origin,'--awaited']);
    assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).code,code);
    if(origin===first) assert.match(JSON.parse(r.stdout).reason,new RegExp(`${first} is superseded by ${later}`));
    assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),events);
    assert.equal(f.calls().filter(c=>c.type==='lane').length,0);
    assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
  }
});

test('saved cross-item reuse accepts the same lane and identity without adding an origin precondition',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
  const other=f.rec(['add','Sibling slice','--role','engineer']).split(' ')[0];
  const r=f.dispatch(['--retry',savedReuse(f,first.run,[other,'--lane','topic','--route','engineer','--brief',f.brief])]);
  assert.equal(r.status,0,r.stderr);const next=JSON.parse(r.stdout),run=f.show(next.run);
  assert.equal(next.agent,first.agent);assert.equal(next.pane,first.pane);
  assert.equal(run.meta.agent_session_id,f.show(first.run).meta.agent_session_id);
  assert.equal(run.meta.continuation_of,first.run);assert.equal(run.meta.same_session,true);
  assert.equal(JSON.parse(fs.readFileSync(next.journal)).fromRun,null);
  assert.deepEqual(f.show(f.item).runs,[first.run]);assert.deepEqual(f.show(other).runs,[next.run]);
  assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch').length,1);
});

test('an older reported run cannot lend a saved reuse worker held by a newer open correction, even when idle or done',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout),report=f.show(first.run).report_path;
  fs.writeFileSync(report,`---\nrun: ${first.run}\noutcome: done\nsummary: First run complete\n---\n`);f.rec(['ingest',report]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='idle';fs.writeFileSync(file,JSON.stringify(workers));
  const second=f.dispatch(['--retry',savedReuse(f,first.run)]);assert.equal(second.status,0,second.stderr);
  const correction=JSON.parse(second.stdout);
  const other=f.rec(['add','Sibling work','--role','engineer']).split(' ')[0];
  const saved=savedReuse(f,first.run,[other,'--lane','topic','--route','engineer','--brief',f.brief]),reuse=()=>f.dispatch(['--retry',saved]);
  for(const status of ['idle','done']) {
    workers[first.agent].agent_status=status;fs.writeFileSync(file,JSON.stringify(workers));
    const events=fs.readFileSync(path.join(f.org,'events.jsonl')),jobs=f.jobs().length,calls=f.calls().length;
    const r=reuse();assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).code,'REUSE_WORKER_BUSY');
    assert.ok(JSON.parse(r.stdout).reason.includes(correction.run));
    onlyCompletion(f,events,saved);
    assert.equal(f.jobs().length,jobs);assert.equal(f.calls().slice(calls).filter(c=>c.type==='lane').length,0);
    assert.equal(promptCalls(f).length,2);
  }
  f.rec(['abandon',correction.run]);
  const released=reuse();assert.equal(released.status,0,released.stderr);
  assert.equal(JSON.parse(released.stdout).agent,first.agent);
});

test('saved reuse rechecks newer open occupant holders immediately before prompting',async t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
  const hook=pauseHook(f,`const rename=fs.renameSync,remove=fs.rmSync;let once=true,promptSaved=false;fs.renameSync=function(from,to) {
 const result=rename.call(fs,from,to);
 if(once && String(to).endsWith('.json')) {
  const job=JSON.parse(read.call(fs,to,'utf8'));
  if(job.reuse && job.stage==='prompt') promptSaved=true;
 }
 return result;
};
// Ownership reserves the intent under the record lock. Pause after releasing
// that lock so this fixture can publish its competing occupant before prompt.
fs.rmSync=function(target,...args) {
 const result=remove.call(fs,target,...args);
 if(once && promptSaved && String(target)===${JSON.stringify(path.join(f.org,'lock'))}) {once=false;pause();}
 return result;
};`);
  const pending=f.concurrent(['--retry',savedReuse(f,first.run)],hook);
  let holder;
  try {
    // The saved retry replays start, worker and watch stages before its prompt.
    await until(()=>fs.existsSync(hook.PAUSE_MARKER),loadTimeout(30000));
    const other=f.rec(['add','Sibling work','--role','engineer']).split(' ')[0],prior=f.show(first.run);
    holder=f.rec(['start',other,'--workspace',prior.workspace]).match(/R-\d+/)[0];
    f.rec(['worker',holder,'--agent',prior.meta.agent,'--pane',prior.meta.pane,
      '--worker-workspace',prior.meta.worker_workspace,'--cwd',prior.workspace,
      '--terminal-id',prior.meta.terminal_id,'--agent-session-id',prior.meta.agent_session_id]);
  } finally {fs.writeFileSync(hook.PAUSE_RELEASE,'go');await pending.done;}
  const r=await pending.done;assert.equal(r.status,1,r.stderr);
  assert.equal(JSON.parse(r.stdout).code,'REUSE_WORKER_BUSY');assert.ok(JSON.parse(r.stdout).reason.includes(holder));
  assert.equal(promptCalls(f).length,1,'the new dispatch never prompts its worker');
});

test('terminal-only saved reuse refused before prompting retries with a fresh session binding window',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-reuse-window-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const preload=path.join(root,'clock.cjs');
  fs.writeFileSync(preload,`if([${JSON.stringify(DISPATCH)},${JSON.stringify(RECORD)}].includes(process.argv[1])) {
 const fs=require('node:fs'),path=require('node:path'),now=Date.now;
 const offset=path.join(process.env.FAKE_ROOT,'clock-offset');
 Date.now=()=>now()+(fs.existsSync(offset)?Number(fs.readFileSync(offset,'utf8')):0);
}`);
  const f=fixture(t,{lateSession:'delayed',preload});f.fail('watch');
  const initial=f.start();assert.equal(initial.status,1,initial.stderr);
  const prior=f.show(JSON.parse(fs.readFileSync(f.jobs()[0])).run);
  assert.ok(prior.meta.terminal_id);assert.equal(prior.meta.agent_session_id,undefined);
  assert.equal(f.state().sessionBindings.get(prior.id),undefined);
  f.fail('');f.rec(['abandon',prior.id]);
  // Start the holder first but publish its terminal claim only after preflight.
  // A newer worker receipt independently forbids late binding even if abandoned.
  const other=f.rec(['add','Temporary holder','--role','engineer']).split(' ')[0];
  const holder=f.rec(['start',other,'--workspace',prior.workspace]).match(/R-\d+/)[0];
  const hook=pauseHook(f,`const rename=fs.renameSync,remove=fs.rmSync;let once=true,promptSaved=false;fs.renameSync=function(from,to) {
 const result=rename.call(fs,from,to);
 if(once && String(to).endsWith('.json')) {
  const job=JSON.parse(read.call(fs,to,'utf8'));
  if(job.reuse && job.stage==='prompt') promptSaved=true;
 }
 return result;
};
// Ownership reserves the intent under the record lock. Pause after releasing
// that lock so this fixture can publish its competing occupant before prompt.
fs.rmSync=function(target,...args) {
 const result=remove.call(fs,target,...args);
 if(once && promptSaved && String(target)===${JSON.stringify(path.join(f.org,'lock'))}) {once=false;pause();}
 return result;
};`);
  hook.NODE_OPTIONS+=` --require=${preload}`;
  const pending=f.concurrent(['--retry',savedReuse(f,prior.id)],hook);
  try {
    await until(()=>fs.existsSync(hook.PAUSE_MARKER),loadTimeout(30000));
    f.rec(['worker',holder,'--agent','temporary-holder','--pane','holder:pane',
      '--worker-workspace',prior.meta.worker_workspace,'--cwd',prior.workspace,'--terminal-id',prior.meta.terminal_id]);
  } finally {fs.writeFileSync(hook.PAUSE_RELEASE,'go');await pending.done;}
  const refused=await pending.done;assert.equal(refused.status,1,refused.stderr);
  const receipt=JSON.parse(refused.stdout);assert.equal(receipt.code,'REUSE_WORKER_BUSY');
  const before=JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(before.stage,'prompt');assert.equal(before.worker.agentSessionId,undefined);
  assert.equal(before.sessionBinding,undefined,'a refused prompt does not start its observation window');
  assert.equal(promptCalls(f).length,0);
  const refusedAt=Date.now();
  fs.writeFileSync(path.join(f.root,'clock-offset'),'61000');
  f.rec(['abandon',holder]);
  const retry=f.dispatch(['--retry',before.run]);assert.equal(retry.status,0,retry.stderr);
  assert.equal(JSON.parse(retry.stdout).binding.status,'bound');
  const after=JSON.parse(fs.readFileSync(receipt.journal)),state=f.state(),run=f.show(before.run);
  assert.ok(Date.parse(after.sessionBinding.prompted_at)>=refusedAt+61000);
  assert.equal(Date.parse(after.sessionBinding.deadline)-Date.parse(after.sessionBinding.prompted_at),60000);
  assert.equal(state.sessionBindings.get(before.run).length,1);
  assert.equal(run.meta.agent_session_id,undefined,'the launch receipt stays terminal-only');
  assert.equal(effectiveWorkerIdentity(run,state).agent_session_id,'s-worker-1');
  assert.equal(promptCalls(f).length,1,'only the successful retry delivers work');
});

test('saved reuse identity classification is local to the worker stage and preserves existing codes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-reuse-codes-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const preload=path.join(root,'fault.cjs');
  fs.writeFileSync(preload,`if(process.argv[1]===${JSON.stringify(DISPATCH)}) {
 const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),spawn=cp.spawnSync;
 cp.spawnSync=function(command,args,options) {
  const root=process.env.FAKE_ROOT,fault=path.join(root,'reuse-fault.json');
  if(path.basename(command)==='lane' && args?.[0]==='verify-agent' && fs.existsSync(fault)) {
   const target=JSON.parse(fs.readFileSync(fault,'utf8')),directory=path.join(process.env.ORG_DIR,'dispatch');
   const matches=fs.readdirSync(directory).filter(file=>file.endsWith('.json')&&!file.endsWith('.routes.json'))
    .map(file=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8')))
    .some(job=>job.reuse && job.stage===target.stage);
   if(matches) throw Object.assign(new Error('injected reuse identity transport failure'),target.code?{code:target.code}:{});
  }
  return spawn.call(this,command,args,options);
 };require('node:module').syncBuiltinESMExports();
}`);
  for(const [stage,code,expected] of [
    ['worker',null,'REUSE_IDENTITY_UNKNOWN'],['worker','REUSE_WORKER_BUSY','REUSE_WORKER_BUSY'],
    ['worker','EAGAIN','DISPATCH_FAILED'],['record-worker',null,'DISPATCH_FAILED'],
    ['watch',null,'DISPATCH_FAILED'],['prompt',null,'DISPATCH_FAILED'],['watch','EMFILE','DISPATCH_FAILED'],
  ]) {
    const f=fixture(t,{preload}),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
    const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
    workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
    fs.writeFileSync(path.join(f.root,'reuse-fault.json'),JSON.stringify({stage,code}));
    const r=f.dispatch(['--retry',savedReuse(f,first.run)]);assert.equal(r.status,1,`${stage}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).code,expected,`${stage} ${code}: ${r.stderr}`);
    assert.match(JSON.parse(r.stdout).reason,/injected reuse identity transport failure/);
    const job=JSON.parse(fs.readFileSync(JSON.parse(r.stdout).journal));
    assert.equal(job.stage,stage);assert.equal(promptCalls(f).length,1);
  }
});

test('native filesystem error codes are normalized without changing failure reasons',t=>{
  const f=fixture(t),missing=path.join(f.root,'missing-brief.md');
  const r=f.dispatch([f.item,'--lane','topic','--route','engineer','--brief',missing]);
  assert.equal(r.status,1);const failed=JSON.parse(r.stdout);
  assert.equal(failed.result,'failed');assert.equal(failed.code,'DISPATCH_FAILED');
  assert.match(failed.reason,/ENOENT/);assert.ok(failed.reason.includes(missing));
  assert.ok(r.stderr.includes(failed.reason));assert.deepEqual(f.show(f.item).runs,[]);
  assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
});

test('late saved reuse identity and busy refusals retain their messages and supply stable codes',t=>{
  for(const kind of ['missing','replaced','busy']) {
    const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
    const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
    workers[first.agent].agent_status=kind==='busy'?'working':'done';
    if(kind==='missing') f.rec(['set',first.run,'terminal_id=','agent_session_id=']);
    if(kind==='replaced') workers[first.agent].terminal_id='replacement';
    fs.writeFileSync(file,JSON.stringify(workers));
    const r=f.dispatch(['--retry',savedReuse(f,first.run)]);assert.equal(r.status,1);
    assert.equal(JSON.parse(r.stdout).code,kind==='busy'?'REUSE_WORKER_BUSY':'REUSE_IDENTITY_UNKNOWN',r.stderr);
    assert.match(r.stderr,kind==='busy'?/idle or done/:kind==='missing'?/consistent recorded occupant/:/occupant identity changed/);
    assert.equal(promptCalls(f).length,1);
    assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch').length,1);
  }
});
test('dispatch waits for a real watcher whose configuration read exceeds the old startup deadline at load 24', { timeout: 60000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-loaded-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'load.cjs');
  fs.writeFileSync(preload, `const os=require('node:os');os.loadavg=()=>[24,24,24];os.availableParallelism=()=>4;
const cp=require('node:child_process'),original=cp.spawnSync;
cp.spawnSync=function(command,args,options){
if(process.argv[1]===${JSON.stringify(WATCH)}&&!process.argv.includes('--detach')&&args?.includes('show'))
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,11000);
return original.call(this,command,args,options);};require('node:module').syncBuiltinESMExports();`);
  const f = fixture(t, { realWatch: true, preload });
  // Only the child sees load 24. Reserve time for its delayed configuration
  // reads and dispatch overhead even on a quiet host, within the 60 s test.
  const result = f.start(['--to', 'supervisor-herdr'], { [commandAllowance]: loadTimeout(45_000) });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.ok(receipt.watcher.pid > 0);
  const job = JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(job.stage, 'complete');
  assert.equal(job.to, 'supervisor-herdr');
  assert.notEqual(job.to, receipt.agent);
  assert.equal(promptCalls(f).length, 1);
  const log = fs.readFileSync(receipt.watcher.log, 'utf8');
  assert.match(log, /watching R-1.*supervisor supervisor-herdr/);
});
