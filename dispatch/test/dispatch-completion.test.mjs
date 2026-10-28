import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, promptCalls, DISPATCH, RECORD } from './dispatch-fixture.mjs';

function completionFixture(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'race.cjs');
  fs.writeFileSync(preload, `if(process.argv[1]===${JSON.stringify(DISPATCH)}) {
    const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
    const mkdir=fs.mkdirSync,mode=${JSON.stringify(mode)};let hits=0;
    fs.mkdirSync=function(dir,...args) {
      const org=process.env.ORG_DIR;
      if(String(dir)===path.join(org,'lock')) {
        const stack=new Error().stack,publication=stack.includes('plannedAppend');
        const file=fs.readdirSync(path.join(org,'dispatch')).find(f=>f.endsWith('.json')&&!f.endsWith('.routes.json'));
        const job=file&&JSON.parse(fs.readFileSync(path.join(org,'dispatch',file)));
        if(job?.stage==='complete' && !fs.existsSync(path.join(process.env.FAKE_ROOT,'disable-completion-race')) && (mode.startsWith('publish')?publication:stack.includes('fenceOwner')) && (!hits||mode.endsWith('exhausted'))) {
          hits++;fs.writeFileSync(path.join(process.env.FAKE_ROOT,'completion-hits'),String(hits));
          if(mode.endsWith('exhausted')) throw Object.assign(Error('record guard conflict: source changed; no guarded effect was run'),{code:publication?'RECORD_PLANNING_CONFLICT':'RECORD_GUARD_CONFLICT'});
          if(mode.endsWith('refused')) throw Object.assign(Error('RUN_OWNED_ELSEWHERE: changed claim'),{code:'RUN_OWNED_ELSEWHERE'});
          const result=mode.endsWith('main')
            ?cp.spawnSync('git',['-C',job.repo,'commit','--allow-empty','-m','main moved during dispatch completion'],{encoding:'utf8'})
            :cp.spawnSync(process.execPath,[${JSON.stringify(RECORD)},'note',job.run,'Concurrent completion record writer'],{encoding:'utf8'});
          if(result.status!==0)throw Error(result.stderr);
        }
      }
      return mkdir.call(this,dir,...args);
    };
  }`);
  return fixture(t, { preload });
}

function assertSingleLaunch(f, result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout), job = JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(promptCalls(f).length, 1);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1);
  assert.equal(f.jobs().length, 1);
  assert.equal(job.stage, 'complete');
  assert.deepEqual(receipt.watcher, job.watcher);
  assert.equal(receipt.agent, job.worker.agentName);
  assert.doesNotMatch(result.stdout, /DISPATCH_FAILED/);
  return { receipt, job };
}

function completions(f) {
  return fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.type === 'dispatch.completed');
}

for (const mode of ['save-main', 'save-record', 'publish-main']) {
  test(`${mode} change during completion re-prepares without replaying the launch`, t => {
    const f = completionFixture(t, mode), base = f.git(['rev-parse', 'main']);
    const { receipt, job } = assertSingleLaunch(f, f.start());
    assert.equal(fs.readFileSync(path.join(f.root, 'completion-hits'), 'utf8'), '1');
    if (mode.endsWith('main')) assert.notEqual(f.git(['rev-parse', 'main']), base);
    assert.equal(receipt.completion, undefined);
    const [event] = completions(f);
    assert.equal(completions(f).length, 1);
    assert.equal(event.stage, 'complete'); assert.equal(event.exit_code, 0);
    assert.equal(event.request_sha256, createHash('sha256').update(fs.readFileSync(receipt.journal)).digest('hex'));
    const retried = assertSingleLaunch(f, f.dispatch(['--retry', receipt.run]));
    assert.deepEqual(retried.job.worker, job.worker); assert.deepEqual(retried.job.watcher, job.watcher);
    assert.equal(completions(f).length, 1, 'exact completion retry is idempotent');
  });
}

for (const mode of ['save-exhausted', 'publish-exhausted']) {
  test(`${mode} returns launched with pending completion and recovers the same request`, t => {
    const f = completionFixture(t, mode), first = f.start();
    const { receipt, job } = assertSingleLaunch(f, first);
    assert.equal(receipt.result, 'launched'); assert.equal(receipt.completion.status, 'pending');
    assert.match(receipt.completion.retry, new RegExp(`--retry ${receipt.run}$`));
    const hits = Number(fs.readFileSync(path.join(f.root, 'completion-hits'), 'utf8'));
    assert.ok(hits >= 32 && hits <= 64, `bounded retries: ${hits}`);
    // Disable only this fixture's injected race, then use the supported retry.
    fs.writeFileSync(path.join(f.root, 'disable-completion-race'), 'disabled');
    const retried = assertSingleLaunch(f, f.dispatch(['--retry', receipt.run]));
    assert.equal(retried.receipt.completion, undefined);
    assert.deepEqual(retried.job.worker, job.worker); assert.deepEqual(retried.job.watcher, job.watcher);
    assert.equal(completions(f).at(-1).exit_code, 0);
  });
}

test('an ownership refusal is never re-prepared or converted into launched success', t => {
  const f = completionFixture(t, 'save-refused'), result = f.start();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).result, 'failed');
  assert.match(result.stderr, /RUN_OWNED_ELSEWHERE/);
  assert.equal(fs.readFileSync(path.join(f.root, 'completion-hits'), 'utf8'), '1');
  assert.equal(promptCalls(f).length, 1);
  assert.equal(completions(f).at(-1).exit_code, 1);
});
