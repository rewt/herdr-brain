import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, DISPATCH, RECORD, promptCalls } from './dispatch-fixture.mjs';

const events = f => fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function interruptedCommand(t, mode, action = 'start') {
  const f = fixture(t), wrapper = path.join(f.root, 'slow-command.mjs'), preload = path.join(f.root, 'command-receipt.mjs');
  const original = action === 'dispatch' ? path.join(f.root, 'bin/lane') : RECORD;
  fs.writeFileSync(wrapper, `#!${process.execPath}
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),selected=args[0]===${JSON.stringify(action)},mode=${JSON.stringify(mode)};
if(selected&&mode==='refused'){console.error('record: injected definite refusal');process.exit(1);}
if(selected&&mode==='readback-unavailable'){
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'readback-unavailable'))},'failed');
  console.error('record: injected definite refusal');process.exit(1);
}
if(selected&&mode==='uncommitted-signal')process.kill(process.pid,'SIGTERM');
const r=spawnSync(process.execPath,[${JSON.stringify(original)},...args],{stdio:'inherit'});
if(r.status!==0)process.exit(r.status??1);
if(selected){
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'committed'))},'committed');
  if(mode==='signal')process.kill(process.pid,'SIGTERM');
  // The fixture alone imposes a timeout, after invoking the real record start.
  // Its marker and run.started event prove that the slow command committed.
  if(mode==='timeout')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,8000);
  if(mode==='uncapped')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
}
`, { mode: 0o755 });
  fs.writeFileSync(preload, `import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]===${JSON.stringify(RECORD)}&&process.argv[2]==='start'&&${JSON.stringify(mode)}==='brief-error'){
  const {UserError}=await import(${JSON.stringify(new URL('../../lib/store.mjs', import.meta.url).href)});
  const rename=fs.renameSync;
  fs.renameSync=function(from,to,...args){
    if(String(to).endsWith('/runs/R-1/brief.md'))throw new UserError('injected brief failure after committed start');
    return rename.call(this,from,to,...args);
  };
}
if(process.argv[1]===${JSON.stringify(DISPATCH)}){
  const open=fs.openSync;
  fs.openSync=function(file,...args){
    if(${JSON.stringify(mode)}==='readback-unavailable'&&String(file)===${JSON.stringify(path.join(f.org, 'events.jsonl'))}&&
       fs.existsSync(${JSON.stringify(path.join(f.root, 'readback-unavailable'))})&&new Error().stack.includes('at requestStarts '))
      throw Error('injected unavailable start readback');
    return open.call(this,file,...args);
  };
  const original=cp.spawnSync;
  cp.spawnSync=function(exe,args,options){
    const owned=args.includes('--owned-command');
    const request=owned?JSON.parse(options.input):{exe,args};
    if(request.exe===${JSON.stringify(wrapper)}&&request.args[0]===${JSON.stringify(action)}){
      fs.writeFileSync(${JSON.stringify(path.join(f.root, 'command-options'))},JSON.stringify({owned,timeout:options.timeout}));
      if(${JSON.stringify(mode)}==='timeout'){
        // Exercise an actual spawnSync ETIMEDOUT, independent of production's
        // removed cap. Never shorten the real record writer's lock allowance.
        const r=original(request.exe,request.args,{...options,input:undefined,timeout:5000,killSignal:'SIGTERM'});
        const receipt={status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,
          ...(r.error?{error:{code:r.error.code,message:r.error.message}}:{})};
        fs.writeFileSync(${JSON.stringify(path.join(f.root, 'native-receipt'))},JSON.stringify(receipt));
        return owned?{status:0,signal:null,stdout:JSON.stringify(receipt),stderr:''}:r;
      }
    }
    return original(exe,args,options);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${preload}` };
  const start = (extra = []) => f.start([action === 'dispatch' ? '--lane-cli' : '--org-cli', wrapper, ...extra], { env });
  return { f, start };
}

function assertUnknown(f, result, stage, committed) {
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout), journal = f.jobs()[0], saved = JSON.parse(fs.readFileSync(journal));
  assert.equal(receipt.result, 'unknown'); assert.equal(receipt.code, 'DISPATCH_OUTCOME_UNKNOWN');
  assert.equal(receipt.stage, stage); assert.equal(receipt.journal, journal);
  assert.equal(Object.hasOwn(receipt, 'retry'), false); assert.doesNotMatch(result.stderr, /^retry:/m);
  assert.match(receipt.readback.journal, /--status/); assert.match(receipt.readback.record, /show/);
  assert.ok(receipt.readback.record.includes(`ORG_DIR='${f.org}'`));
  assert.equal(receipt.readback.org, f.org);
  assert.equal(receipt.native_launch_attempted, stage === 'launching');
  if (stage === 'starting') {
    assert.match(receipt.readback.start_recovery.condition, /exactly one current matching committed start with no native launch/);
    assert.match(receipt.readback.start_recovery.action, /Resume only this original journal/);
    assert.ok(receipt.readback.start_recovery.command.endsWith(`--retry' '${journal}'`));
  } else assert.equal(receipt.readback.start_recovery, undefined);
  assert.match(receipt.readback.hint, /never redispatch, replay or replace/);
  assert.equal(saved.failure.kind, 'unknown'); assert.equal(saved.failure.code, receipt.code);
  assert.deepEqual(saved.failure.receipt, receipt.receipt);
  assert.deepEqual(saved.failure.readback, receipt.readback);
  assert.equal(saved.startRefused ?? false, false);
  assert.equal(events(f).filter(e => e.type === 'run.started').length, committed ? 1 : 0);
  assert.equal(f.show(f.item).runs.length, committed ? 1 : 0);
  const completed = events(f).filter(e => e.type === 'dispatch.completed');
  assert.equal(completed.length, 1); assert.equal(completed[0].failure.code, receipt.code);
  assert.deepEqual(completed[0].failure.receipt, receipt.receipt);
  assert.equal(promptCalls(f).length, 0);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 0);
  const before = fs.readFileSync(journal);
  const status = f.dispatch(['--status', journal]); assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), saved); assert.deepEqual(fs.readFileSync(journal), before);
  assert.doesNotMatch(result.stdout, /DISPATCH_FAILED/);
  return { receipt, saved };
}

function recoverOriginal(f, receipt, controller = 'brain') {
  // Execute exactly the quoted command offered to the caller, without the
  // fixture's common CLI flags masking omissions in that command.
  const recovered = spawnSync('/bin/sh', ['-c', receipt.readback.start_recovery.command], {
    cwd: f.repo, env: f.env, encoding: 'utf8',
  });
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).run, 'R-1');
  assert.deepEqual(f.show(f.item).runs, ['R-1']);
  assert.equal(f.show('R-1').owner.controller, controller);
  assert.equal(events(f).filter(e => e.type === 'run.started').length, 1);
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1);
  assert.equal(promptCalls(f).length, 1);
  const completions = events(f).filter(e => e.type === 'dispatch.completed');
  assert.equal(completions.length, 2);
  assert.equal(completions[0].failure.code, 'DISPATCH_OUTCOME_UNKNOWN');
  assert.deepEqual(completions[0].failure.receipt, receipt.receipt);
  assert.equal(completions[1].stage, 'complete');
  assert.equal(completions[1].exit_code, 0);
  assert.equal(completions[1].failure, null);
  assert.equal(completions[1].journal, completions[0].journal);
  assert.equal(completions[1].attempt, completions[0].attempt);
  assert.equal(completions[1].run, 'R-1');
}

test('a nonzero record start after committed brief failure is unknown and its exact command recovers the original run', t => {
  const { f, start } = interruptedCommand(t, 'brief-error');
  const { receipt } = assertUnknown(f, start(['--controller', 'custom-controller']), 'starting', true);
  assert.equal(receipt.receipt.status, 1); assert.equal(receipt.receipt.signal, null);
  assert.equal(receipt.receipt.stdout, '');
  assert.match(receipt.receipt.stderr, /^record: injected brief failure after committed start/m);
  const saved = JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(saved.invocation.controller, 'custom-controller');
  for (const key of ['controller', 'org-cli', 'lane-cli', 'watch-cli']) {
    assert.ok(receipt.readback.start_recovery.command.includes(`'--${key}' '${saved.invocation[key]}'`));
  }
  // The injected render failure happened before a brief existed; restore that
  // read-only artifact through its real supported command before continuation.
  f.rec(['brief', 'R-1']);
  recoverOriginal(f, receipt, 'custom-controller');
});

test('a nonzero record start after report directory failure is unknown without a record refusal prefix', t => {
  const f = fixture(t), parent = path.join(f.root, 'report-parent');
  fs.writeFileSync(parent, 'not a directory');
  const { receipt } = assertUnknown(f, f.start(['--report', path.join(parent, 'report.md')]), 'starting', true);
  assert.equal(receipt.receipt.status, 1); assert.equal(receipt.receipt.signal, null);
  assert.equal(receipt.receipt.stdout, ''); assert.match(receipt.receipt.stderr, /EEXIST|ENOTDIR/);
});

test('saved command selection resumes a typed unknown by journal without repeated CLI flags', t => {
  const { f, start } = interruptedCommand(t, 'signal');
  const { receipt } = assertUnknown(f, start(['--controller', 'custom-controller']), 'starting', true);
  const command = [process.execPath, DISPATCH, '--repo', f.repo, '--org', f.org, '--retry', receipt.journal];
  const recovered = spawnSync(command[0], command.slice(1), { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  assert.equal(f.show('R-1').owner.controller, 'custom-controller');
  assert.equal(promptCalls(f).length, 1);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1);
  assert.deepEqual(f.show(f.item).runs, ['R-1']);
});

test('an older journal without saved command selection retains explicit flag recovery', t => {
  const { f, start } = interruptedCommand(t, 'signal');
  const { receipt, saved } = assertUnknown(f, start(), 'starting', true);
  delete saved.invocation;
  fs.writeFileSync(receipt.journal, JSON.stringify(saved));
  const recovered = f.dispatch(['--retry', receipt.journal]);
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  assert.equal(promptCalls(f).length, 1);
  assert.deepEqual(f.show(f.item).runs, ['R-1']);
  assert.equal(JSON.parse(fs.readFileSync(receipt.journal)).invocation, undefined);
});

test('a failed start readback cannot turn a nonzero record exit into a definite refusal', t => {
  const { f, start } = interruptedCommand(t, 'readback-unavailable');
  const { receipt } = assertUnknown(f, start(), 'starting', false);
  assert.match(receipt.reason, /start readback unavailable: injected unavailable start readback/);
  assert.equal(receipt.receipt.status, 1);
  assert.match(receipt.receipt.stderr, /record: injected definite refusal/);
});

test('retry cannot replace saved command selection or mutate the retained unknown attempt', t => {
  const { f, start } = interruptedCommand(t, 'signal');
  const { receipt } = assertUnknown(f, start(), 'starting', true);
  const before = fs.readFileSync(receipt.journal);
  for (const key of ['controller', 'org-cli', 'lane-cli', 'watch-cli']) {
    const refused = f.dispatch(['--retry', receipt.journal, `--${key}`, 'replacement']);
    assert.equal(refused.status, 1, refused.stderr + refused.stdout);
    assert.match(refused.stderr, new RegExp(`cannot replace saved --${key}`));
    assert.deepEqual(fs.readFileSync(receipt.journal), before);
  }
  assert.equal(events(f).filter(e => e.type === 'dispatch.completed').length, 1);
  assert.equal(promptCalls(f).length, 0);
});

test('a slow real record start commits before spawnSync ETIMEDOUT and returns typed unknown without replay', t => {
  const { f, start } = interruptedCommand(t, 'timeout');
  const { receipt, saved } = assertUnknown(f, start(), 'starting', true);
  assert.equal(fs.readFileSync(path.join(f.root, 'committed'), 'utf8'), 'committed');
  assert.equal(receipt.receipt.error, 'ETIMEDOUT'); assert.equal(receipt.receipt.signal, 'SIGTERM');
  const native = JSON.parse(fs.readFileSync(path.join(f.root, 'native-receipt')));
  assert.deepEqual(receipt.receipt, { ...native, error: native.error.code });
  assert.equal(saved.run, null); assert.equal(saved.native_launch_attempted, false);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 0);
  recoverOriginal(f, receipt);
  t.diagnostic('Initial unknown retains ETIMEDOUT/SIGTERM with zero launches; exact recovery claims the same run, launches once and adds one successful completion.');
});

for (const mode of ['signal', 'uncommitted-signal']) test(`${mode} record start is unknown whether or not it committed`, t => {
  const { f, start } = interruptedCommand(t, mode);
  const { receipt } = assertUnknown(f, start(), 'starting', mode === 'signal');
  assert.equal(receipt.receipt.signal, 'SIGTERM');
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 0);
});

test('a signalled lane dispatch retains its original allocation as unknown without a second attempt', t => {
  const { f, start } = interruptedCommand(t, 'signal', 'dispatch');
  const { receipt, saved } = assertUnknown(f, start(), 'launching', true);
  assert.equal(receipt.receipt.signal, 'SIGTERM'); assert.equal(saved.native_launch_attempted, true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.root, 'workers')))).length, 1);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(saved.worker, undefined);
});

test('ordinary record start has no wall-clock cap and keeps its committed run when the later fake launch refuses', t => {
  const { f, start } = interruptedCommand(t, 'uncapped'); f.fail('dispatch');
  const result = start(), saved = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(result.status, 1, result.stderr + result.stdout); assert.match(result.stderr, /injected dispatch/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'command-options'))), { owned: true, timeout: 0 });
  assert.equal(saved.stage, 'launching'); assert.equal(saved.run, 'R-1');
  assert.equal(events(f).filter(e => e.type === 'run.started').length, 1);
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(promptCalls(f).length, 0);
});

test('a definite record refusal stays failed with no committed start or native effect', t => {
  const { f, start } = interruptedCommand(t, 'refused'), result = start();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout), saved = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(receipt.result, 'failed'); assert.equal(receipt.code, 'DISPATCH_FAILED');
  assert.match(receipt.retry, /--retry/); assert.equal(saved.startRefused, true);
  assert.equal(events(f).filter(e => e.type === 'run.started').length, 0);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 0);
});

for (const stage of ['starting', 'launching']) test(`a second same-item lane dispatch surfaces the original open ${stage} run without superseding it`, t => {
  const { f, start } = interruptedCommand(t, stage === 'starting' ? 'signal' : 'uncapped');
  f.fail('dispatch'); const first = start(); assert.equal(first.status, 1, first.stderr);
  const original = f.jobs()[0], bytes = fs.readFileSync(original), saved = JSON.parse(bytes);
  assert.equal(saved.stage, stage); assert.equal(f.show(f.item).runs.length, 1);
  const second = f.start(), blocked = JSON.parse(second.stdout);
  assert.equal(second.status, 1, second.stderr + second.stdout);
  assert.equal(blocked.result, 'blocked'); assert.equal(blocked.code, 'DISPATCH_LANE_OCCUPIED');
  assert.equal(blocked.occupied.run, 'R-1'); assert.equal(blocked.occupied.journal, original);
  assert.equal(Object.hasOwn(blocked, 'retry'), false);
  assert.deepEqual(fs.readFileSync(original), bytes);
  assert.deepEqual(f.show(f.item).runs, ['R-1']);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, stage === 'launching' ? 1 : 0);
  assert.equal(promptCalls(f).length, 0);
});
