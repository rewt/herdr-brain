import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupOrg } from './helpers.mjs';
import { retirementLock } from '../lib/retire-lock.mjs';

test('deferred start returns its committed run without post-commit reads or preparation; brief prepares the original facts', t => {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '-qb', 'main', f.root], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  fs.writeFileSync(path.join(f.root, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  fs.mkdirSync(path.join(f.root, '.git/closeout/entries'), { recursive: true });
  const id = f.ok(['add', 'Deferred work']).trim();
  f.ok(['close', id, '--dropped']);
  const hook = path.join(f.root, 'observe.mjs'), calls = path.join(f.root, 'calls');
  fs.writeFileSync(hook, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const log=${JSON.stringify(path.join(f.dir, 'events.jsonl'))},calls=${JSON.stringify(calls)};
const open=fs.openSync,write=fs.writeSync;let committed=false;
fs.writeSync=function(fd,bytes,...rest){const result=write.call(this,fd,bytes,...rest);
 if(String(bytes).includes('"preparation_deferred":true'))committed=true;return result;};
fs.openSync=function(file,...rest){
 const stack=new Error().stack;
 if(String(file)===log&&stack.includes('at publishCloseoutEvents '))fs.appendFileSync(calls,'publication\\n');
 if(process.argv[2]==='start'&&committed&&String(file)===log)throw Error('post-commit record read');
 return open.call(this,file,...rest);};
fs.mkdirSync=new Proxy(fs.mkdirSync,{apply(fn,self,args){
 if(process.argv[2]==='start'&&String(args[0]).includes('/runs/'))throw Error('start prepared a directory');
 return Reflect.apply(fn,self,args);}});
syncBuiltinESMExports();`);
  const env = { HERDR_MONITOR_FLEET: path.join(f.root, 'fleet'), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}` };
  const report = path.join(f.root, 'reports/result.md');
  const started = f.ok(['start', id, '--defer-preparation', '--report', report], { env });
  assert.match(started, /^R-1 started/);
  assert.equal(fs.existsSync(path.join(f.dir, 'runs/R-1')), false);
  assert.equal(fs.existsSync(path.dirname(report)), false);
  assert.equal(fs.existsSync(calls), false);
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  const rows = f.events();
  assert.equal(rows.filter(e => e.type === 'run.started').length, 1);
  assert.equal(rows.at(-1).preparation_deferred, true);
  assert.equal(rows.at(-2).type, 'item.reopened');
  const brief = f.ok(['brief', 'R-1', '--prepare-start'], { env });
  assert.match(brief, /# Brief: run R-1/);
  assert.match(brief, /Deferred work/);
  assert.match(brief, /## When you stop: write one report/);
  assert.ok(fs.existsSync(path.dirname(report)));
  assert.match(fs.readFileSync(calls, 'utf8'), /publication/);
  // The empty queue has no target; publishing original revisions adds no
  // invented facts. A repeated preparation preserves saved brief bytes.
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
  assert.equal(f.ok(['brief', 'R-1', '--prepare-start'], { env }), brief);
  assert.equal(f.events().filter(e => e.type === 'run.started').length, 1);
});

for (const fault of ['busy', 'malformed']) test(`reopened deferred start prepares despite a ${fault} retirement hint`, t => {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const id = f.ok(['add', 'Reopened work']).trim();
  f.ok(['close', id, '--dropped']);
  const report = path.join(f.root, 'reports/result.md');
  f.ok(['start', id, '--defer-preparation', '--report', report]);
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  const lock = path.join(f.dir, 'retirement/request.lock');
  let owner;
  if (fault === 'busy') {
    const release = retirementLock(lock);
    t.after(release);
    owner = fs.readFileSync(path.join(lock, 'owner.json'));
  } else {
    fs.writeFileSync(path.join(f.dir, 'retirement/request.json'), 'malformed hint');
  }
  const result = f.org(['brief', 'R-1', '--prepare-start']);
  assert.equal(result.code, 0, result.err + result.out);
  assert.match(result.err, /record: retirement request deferred:/);
  if (fault === 'busy') {
    assert.match(result.err, /request\.lock; owner is live or unknown/);
    assert.deepEqual(fs.readFileSync(path.join(lock, 'owner.json')), owner, 'live hint lock is retained');
  } else {
    assert.equal(fs.readFileSync(path.join(f.dir, 'retirement/request.json'), 'utf8'), 'malformed hint');
    assert.equal(fs.existsSync(lock), false, 'hint writer releases its own lock after an error');
  }
  assert.match(result.out, /# Brief: run R-1/);
  assert.match(result.out, /Reopened work/);
  assert.ok(fs.existsSync(path.dirname(report)));
  assert.equal(fs.readFileSync(path.join(f.dir, 'runs/R-1/brief.md'), 'utf8'), result.out);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before, 'original start and reopen remain intact');
  assert.equal(f.events().filter(e => e.type === 'run.started').length, 1);
  assert.equal(f.events().filter(e => e.type === 'item.reopened').length, 1);
});

test('deferred start retains real pre-commit refusal and cannot prepare an unrelated legacy start', t => {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.match(f.fail(['start', 'ENG-999', '--defer-preparation']), /unknown item/);
  assert.equal(f.events().some(e => e.type === 'run.started'), false);
  const id = f.ok(['add', 'Legacy work']).trim();
  f.ok(['start', id]);
  assert.match(f.fail(['brief', 'R-1', '--prepare-start']), /no deferred start preparation/);
});
