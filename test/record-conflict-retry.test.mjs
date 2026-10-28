import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import observed from '../lib/record-observation.mjs';
import {initOrg, loadEvents, transact, planTransaction, withRecordGuard} from '../lib/store.mjs';
import {linkedCloseoutStatuses} from '../lib/closeout-status.mjs';
import {setupOrg, BIN, report} from './helpers.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-retry-'))), org = path.join(root, '.org');
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  initOrg(org);
  return {root, org, file:path.join(org, 'events.jsonl'), lock:path.join(org, 'lock')};
}
function race(t, f, action) {
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = function(file, ...args) {
    const result = mkdir.call(this, file, ...args);
    if (file === f.lock) action();
    return result;
  };
  t.after(() => { fs.mkdirSync = mkdir; });
}
const append = (f, type = 'future.unknown') => fs.appendFileSync(f.file, JSON.stringify({seq:loadEvents(f.org).events.length + 1, type}) + '\n');

test('guard retries unrelated source changes with fresh snapshots and executes only once', t => {
  const f = fixture(t); let checks = 0, effects = 0, races = 0;
  race(t, f, () => { if (races++ < 3) append(f); });
  const value = withRecordGuard(f.org, events => {
    checks++; assert.equal(fs.existsSync(f.lock), false); return events.length;
  }, count => { effects++; assert.equal(fs.existsSync(f.lock), true); return count; });
  assert.equal(value, 3); assert.equal(checks, 4); assert.equal(effects, 1);
  const rows = fs.readFileSync(path.join(f.org, 'record-conflicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => [r.attempt,r.retry]), [[1,true],[2,true],[3,true]]);
});

for (const kind of ['HOLD', 'STOP']) test(`guard retry revalidates fresh ${kind} and preserves its refusal`, t => {
  const f = fixture(t), stop = path.join(f.root, 'STOP'); let checks = 0, raced = false;
  race(t, f, () => {
    if (raced) return; raced = true;
    if (kind === 'HOLD') append(f, 'future.hold'); else fs.writeFileSync(stop, 'stop');
  });
  assert.throws(() => withRecordGuard(f.org, events => {
    checks++;
    if (events.some(e => e.type === 'future.hold') || observed.existsSync(stop)) throw Error(`${kind} still refuses`);
  }, () => assert.fail('stale authority')), new RegExp(`${kind} still refuses`));
  assert.equal(checks, 2);
});

test('guard retries are bounded and never run the effect on exhaustion', t => {
  const f = fixture(t); let checks = 0;
  race(t, f, () => append(f));
  assert.throws(() => withRecordGuard(f.org, () => { checks++; }, () => assert.fail('exhausted')), /guard conflict/);
  assert.equal(checks, 32); assert.equal(fs.existsSync(f.lock), false);
  const rows = fs.readFileSync(path.join(f.org, 'record-conflicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 32); assert.equal(rows.at(-1).retry, false);
});

test('guard refuses nested record effects and never replays an operation conflict', t => {
  const f = fixture(t); let checks = 0, effects = 0;
  assert.throws(() => withRecordGuard(f.org, () => {
    checks++; transact(f.org, () => ({add:[{type:'future.audit'}]}));
  }, () => assert.fail('nested effect')), /guard conflict/);
  assert.equal(checks, 1);
  const input = path.join(f.root, 'input'); fs.writeFileSync(input, 'old');
  assert.throws(() => withRecordGuard(f.org, () => { checks++; }, () => {
    effects++;
    return planTransaction(f.org, () => {
      observed.readFileSync(input); fs.writeFileSync(input, 'new'); return {};
    });
  }), /observation conflict/);
  assert.equal(checks, 2); assert.equal(effects, 1);
});

test('native refusal codes cannot impersonate a pre-effect source conflict', t => {
  const f = fixture(t); let guards = 0, plans = 0;
  const refusal = () => Object.assign(Error('native refused'), {code:'RECORD_OBSERVATION_CONFLICT'});
  assert.throws(() => withRecordGuard(f.org, () => { guards++; throw refusal(); }, () => assert.fail('refused')), /native refused/);
  assert.throws(() => planTransaction(f.org, () => { plans++; throw refusal(); }, {replaySafe:true}), /native refused/);
  assert.equal(guards, 1); assert.equal(plans, 1);
});

test('report intake retries a concurrent append and publishes one immutable report', t => {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, {recursive:true,force:true}));
  const item = f.ok(['add','Report owner']).trim(), run = f.ok(['start',item]).match(/^R-\d+/)[0];
  const file = path.join(f.root,'report.md'), preload = path.join(f.root,'race.mjs');
  fs.writeFileSync(file, report(`run: ${run}\noutcome: done\nsummary: Immutable retry`));
  fs.writeFileSync(preload, `import fs from 'node:fs'; const mkdir=fs.mkdirSync; let raced=false;
    fs.mkdirSync=function(file,...args){const result=mkdir.call(this,file,...args);if(file===${JSON.stringify(path.join(f.dir,'lock'))}&&!raced){raced=true;
      const log=${JSON.stringify(path.join(f.dir,'events.jsonl'))},lines=fs.readFileSync(log,'utf8').trim().split('\\n');
      fs.appendFileSync(log,JSON.stringify({seq:JSON.parse(lines.at(-1)).seq+1,type:'future.concurrent'})+'\\n');}return result;};`);
  const result = spawnSync(process.execPath, ['--import',preload,BIN,'ingest',file], {cwd:f.root,env:{...process.env,ORG_DIR:f.dir,ORG_ACTOR:'fixture'},encoding:'utf8'});
  assert.equal(result.status, 0, result.stdout+result.stderr);
  assert.equal(loadEvents(f.dir).events.filter(e => e.type === 'report.ingested').length, 1);
  assert.equal(fs.readFileSync(path.join(f.dir,'reports',run+'.md'),'utf8'), fs.readFileSync(file,'utf8'));
  assert.ok(fs.readFileSync(path.join(f.dir,'record-conflicts.jsonl'),'utf8').includes('"retry":true'));
});

test('unmatched closeout completions avoid rescanning full history for prior statuses', () => {
  let scans = 0;
  const wait = {type:'closeout.waiting',identity:'project',key:'key',source:{seq:1,type:'source'},wait_id:'wait',waiting:{producers:[{kind:'worker-report',run:'R-1',claim:1}]}};
  const events = [wait, ...Array.from({length:500}, (_,i) => ({seq:i+2,type:'future.unrelated'}))];
  events[Symbol.iterator] = function* () { scans++; yield* Array.prototype.values.call(this); };
  assert.deepEqual(linkedCloseoutStatuses(events,events.slice(1)), []);
  assert.equal(scans, 1, 'only the initial wait collection traverses history');
});
