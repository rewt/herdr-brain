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
    // Record preparation adds frames between mkdir and fenceOwner. Keep the
    // boundary selector visible instead of relying on V8's default ten frames.
    Error.stackTraceLimit=64;
    const mkdir=fs.mkdirSync,mode=${JSON.stringify(mode)};let hits=0;
    fs.mkdirSync=function(dir,...args) {
      const org=process.env.ORG_DIR;
      if(String(dir)===path.join(org,'lock')) {
        const stack=new Error().stack,publication=stack.includes('plannedAppend');
        const file=fs.readdirSync(path.join(org,'dispatch')).find(f=>f.endsWith('.json')&&!f.endsWith('.routes.json'));
        const job=file&&JSON.parse(fs.readFileSync(path.join(org,'dispatch',file)));
        if(job?.stage==='complete' && !fs.existsSync(path.join(process.env.FAKE_ROOT,'disable-completion-race')) && (mode.startsWith('publish')?publication:stack.includes('fenceOwner')) && (!hits||mode.endsWith('exhausted'))) {
          hits++;fs.writeFileSync(path.join(process.env.FAKE_ROOT,'completion-hits'),String(hits));
          if(mode.endsWith('exhausted')) {
            // Change the prepared source before lock acquisition. The store
            // must create its own provenance-bearing conflict; a lookalike
            // error code deliberately has no permission to replay preparation.
            const log=path.join(org,'events.jsonl');
            const events=fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse);
            fs.appendFileSync(log,JSON.stringify({seq:events.at(-1).seq+1,at:new Date().toISOString(),by:'completion-fixture',type:'fixture.concurrent-completion-write'})+'\\n');
          } else {
            if(mode.endsWith('refused')) throw Object.assign(Error('RUN_OWNED_ELSEWHERE: changed claim'),{code:'RUN_OWNED_ELSEWHERE'});
            const result=mode.endsWith('main')
              ?cp.spawnSync('git',['-C',job.repo,'commit','--allow-empty','-m','main moved during dispatch completion'],{encoding:'utf8'})
              :cp.spawnSync(process.execPath,[${JSON.stringify(RECORD)},'note',job.run,'Concurrent completion record writer'],{encoding:'utf8'});
            if(result.status!==0)throw Error(result.stderr);
          }
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
    t.diagnostic(`${mode}: injected once; one worker, prompt, watcher and completion retained`);
  });
}

for (const mode of ['save-exhausted', 'publish-exhausted']) {
  test(`${mode} returns launched with pending completion and recovers the same request`, t => {
    const f = completionFixture(t, mode), first = f.start();
    const { receipt, job } = assertSingleLaunch(f, first);
    assert.equal(receipt.result, 'launched'); assert.equal(receipt.completion.status, 'pending');
    assert.match(receipt.completion.retry, new RegExp(`--retry ${receipt.run}$`));
    const hits = Number(fs.readFileSync(path.join(f.root, 'completion-hits'), 'utf8'));
    // Save has both the dispatch's 32-attempt budget and the store guard's
    // 32-attempt budget; publication has only the store's budget.
    assert.equal(hits, mode.startsWith('save') ? 32 * 32 : 32, `bounded retries: ${hits}`);
    const conflicts = fs.readFileSync(path.join(f.org, 'record-conflicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(conflicts.length, hits, 'every injected source change reached the store fence');
    for (const conflict of conflicts) {
      assert.equal(conflict.code, mode.startsWith('save') ? 'RECORD_GUARD_CONFLICT' : 'RECORD_PLANNING_CONFLICT');
      assert.equal(conflict.effects_started, false);
      assert.equal(conflict.record_effects, false);
    }
    t.diagnostic(`${mode}: ${hits} genuine pre-effect conflicts exhausted; recovering the original request`);
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
  t.diagnostic('ownership refusal: injected once and retained as failure');
  assert.equal(promptCalls(f).length, 1);
  assert.equal(completions(f).at(-1).exit_code, 1);
});

test('original unprompted failure stays nonfinal until its producer commits explicit authorized abandonment',t=>{
  const f=fixture(t);f.fail('watch');
  const failed=f.start();assert.equal(failed.status,1,failed.stderr);
  const journal=f.jobs()[0],job=JSON.parse(fs.readFileSync(journal));
  const original=completions(f).at(-1);assert.equal(original.stage,'watch');
  assert.equal(original.closeout_binding_errors[0].code,'DISPATCH_NOT_FINAL');
  assert.equal(f.show(job.run).abandoned,null,'prompt not sent is not finality');
  f.fail('');
  const abandoned=f.dispatch(['--retry',job.run,'--abandon','--abandon-reason','Explicitly end the original unprompted allocation']);
  assert.equal(abandoned.status,0,abandoned.stderr+abandoned.stdout);
  assert.equal(JSON.parse(abandoned.stdout).result,'abandoned');assert.equal(promptCalls(f).length,0);
  assert.ok(f.show(job.run).abandoned);
  const rows=fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse),ending=rows.find(e=>e.type==='run.abandoned');
  assert.equal(ending.producer.journal,journal);assert.equal(ending.producer.attempt,job.token);
  assert.equal(ending.authorization.proof.kind,'original-unprompted-terminal');
  assert.ok(ending.closeout_targets?.length||ending.closeout_binding_errors?.length);
  assert.deepEqual(rows.find(e=>e.seq===original.seq),original);
  const repeated=f.dispatch(['--retry',job.run,'--abandon','--abandon-reason','Same authorized original']);
  assert.equal(repeated.status,0,repeated.stderr);assert.equal(promptCalls(f).length,0);
});

test('unknown prompt delivery cannot be relabeled as terminal abandonment',t=>{
  const f=fixture(t);f.fail('prompt-lost-reply');const failed=f.start();assert.equal(failed.status,1);
  const journal=f.jobs()[0],job=JSON.parse(fs.readFileSync(journal));
  assert.equal(job.stage,'prompting');
  const result=f.dispatch(['--retry',job.run,'--abandon','--abandon-reason','Cannot prove this']);
  assert.equal(result.status,1);assert.match(result.stderr,/UNKNOWN is retained/);
  assert.equal(f.show(job.run).abandoned,null);assert.equal(promptCalls(f).length,1);
});

for (const scenario of [
  { stage: 'open', allocated: false },
  { stage: 'open', allocated: true },
  { stage: 'start', allocated: true },
  { stage: 'starting', allocated: true },
  { stage: 'starting', allocated: true, started: true },
]) test(`abandonment refuses saved ${scenario.stage} with ${scenario.started ? 'a committed start' : scenario.allocated ? 'a retained lane' : 'no lane'} before allocation effects`, t => {
  const f = fixture(t);
  f.fail('open');
  const first = f.start(); assert.equal(first.status, 1, first.stderr);
  const journal = f.jobs()[0], job = JSON.parse(fs.readFileSync(journal));
  assert.equal(job.stage, 'open'); assert.equal(job.run, null);
  f.fail('');
  if (scenario.allocated) {
    const lane = path.join(f.root, 'lane');
    f.git(['worktree', 'add', '-b', 'lane/topic', lane, 'HEAD']);
    job.workspace = fs.realpathSync(lane);
    if (scenario.stage === 'open') {
      f.git(['commit', '--allow-empty', '-m', 'requested base advances']);
      job.base = f.git(['rev-parse', 'HEAD']);
      assert.notEqual(f.git(['rev-parse', 'HEAD'], lane), job.base);
    }
  }
  job.stage = scenario.stage;
  if (scenario.stage === 'starting') {
    job.startRefused = !scenario.started;
    if (scenario.started) f.rec(['start', f.item, '--route', job.route, '--route-config', job.routeConfig,
      '--workspace', job.workspace, '--meta', `lane=${job.lane}`, '--meta', `dispatch_journal=${journal}`,
      '--meta', `dispatch_attempt=${job.token}`, '--meta', `dispatch_project=${job.common}`, '--meta', `dispatch_record=${job.org}`]);
  }
  fs.writeFileSync(journal, JSON.stringify(job));
  const original = fs.readFileSync(journal), eventFile = path.join(f.org, 'events.jsonl'), events = fs.readFileSync(eventFile);
  const calls = f.calls(), worktrees = f.git(['worktree', 'list', '--porcelain']), main = f.git(['rev-parse', 'main']);
  const laneHead = job.workspace && f.git(['rev-parse', 'HEAD'], job.workspace);
  const result = f.dispatch(['--retry', journal, '--abandon', '--abandon-reason', 'End only the original allocation']);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, new RegExp(`terminal abandonment refuses saved ${scenario.stage} request`));
  assert.deepEqual(fs.readFileSync(journal), original, 'retain original pending/start proof unchanged');
  assert.deepEqual(fs.readFileSync(eventFile), events, 'no new run, claim, note, completion or abandonment');
  assert.deepEqual(f.calls(), calls, 'no admission native queries, lane preparation, worker, watcher or prompt');
  assert.equal(f.git(['worktree', 'list', '--porcelain']), worktrees, 'no lane allocation');
  assert.equal(f.git(['rev-parse', 'main']), main);
  if (job.workspace) assert.equal(f.git(['rev-parse', 'HEAD'], job.workspace), laneHead, 'no base fast-forward');
  assert.equal(fs.existsSync(journal + '.lock'), false, 'release original request lock');
});
