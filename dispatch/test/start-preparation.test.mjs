import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { transact } from '../../lib/store.mjs';
import { fixture, RECORD, promptCalls } from './dispatch-fixture.mjs';

const rows = f => fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const saved = f => JSON.parse(fs.readFileSync(f.jobs()[0]));

test('closeout publication moves outside start locks and its failure retains pending preparation', t => {
  const f = fixture(t), hook = path.join(f.root, 'publication.mjs');
  const common = f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  fs.mkdirSync(path.join(common, 'closeout/entries'), { recursive: true });
  const receipt = path.join(f.root, 'publication.json');
  fs.writeFileSync(hook, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]===${JSON.stringify(RECORD)}){
 const open=fs.openSync;
 fs.openSync=function(file,...rest){
  if(String(file)===${JSON.stringify(path.join(f.org, 'events.jsonl'))}&&new Error().stack.includes('at publishCloseoutEvents ')){
   fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({command:process.argv[2],
    retirement:fs.existsSync(${JSON.stringify(path.join(common, 'retirement/owner.lock'))}),
    admission:fs.existsSync(${JSON.stringify(path.join(common, 'dispatch-session-cap'))})}));
   throw Error('injected closeout publication failure');
  }
  return open.call(this,file,...rest);
 };
 syncBuiltinESMExports();
}`);
  const first = f.start([], { env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${hook}` } });
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /injected closeout publication failure/);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)), { command: 'brief', retirement: false, admission: false });
  const before = saved(f);
  assert.equal(before.stage, 'worker');
  assert.equal(before.startPreparation.status, 'pending');
  assert.equal(before.native_launch_attempted, false);
  const retry = f.dispatch(['--retry', before.run]);
  assert.equal(retry.status, 0, retry.stderr + retry.stdout);
  assert.equal(saved(f).startPreparation.status, 'complete');
  assert.equal(rows(f).filter(e => e.type === 'run.started').length, 1);
  assert.equal(promptCalls(f).length, 1);
});

test('deferred preparation failure keeps one committed run and resumes before a single launch', t => {
  const f = fixture(t), parent = path.join(f.root, 'report-parent');
  fs.writeFileSync(parent, 'not a directory');
  const first = f.start(['--report', path.join(parent, 'report.md')]);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /EEXIST|ENOTDIR/);
  const before = saved(f);
  assert.equal(before.stage, 'worker');
  assert.equal(before.startPreparation.status, 'pending');
  assert.equal(before.native_launch_attempted, false);
  assert.equal(rows(f).filter(e => e.type === 'run.started').length, 1);
  assert.equal(promptCalls(f).length, 0);
  fs.unlinkSync(parent);
  const retry = f.dispatch(['--retry', before.run]);
  assert.equal(retry.status, 0, retry.stderr + retry.stdout);
  assert.equal(saved(f).run, before.run);
  assert.equal(saved(f).startPreparation.status, 'complete');
  assert.equal(rows(f).filter(e => e.type === 'run.started').length, 1);
  assert.equal(rows(f).filter(e => e.type === 'run.claimed').length, 1);
  assert.equal(promptCalls(f).length, 1);
});

test('a deferred start killed immediately after durable append stays unknown and recovers only its original journal', t => {
  const f = fixture(t), hook = path.join(f.root, 'kill-after-commit.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]===${JSON.stringify(RECORD)}&&process.argv[2]==='start'){
 const write=fs.writeSync,sync=fs.fsyncSync;let committed=false;
 fs.writeSync=function(fd,bytes,...rest){const result=write.call(this,fd,bytes,...rest);
  if(String(bytes).includes('"preparation_deferred":true'))committed=true;return result;};
 fs.fsyncSync=function(...args){const result=sync.apply(this,args);if(committed)process.kill(process.pid,'SIGTERM');return result;};
 syncBuiltinESMExports();
}`);
  const first = f.start([], { env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${hook}` } });
  assert.equal(first.status, 1, first.stderr);
  const receipt = JSON.parse(first.stdout), before = saved(f);
  assert.equal(receipt.code, 'DISPATCH_OUTCOME_UNKNOWN');
  assert.equal(receipt.stage, 'starting');
  assert.equal(receipt.receipt.signal, 'SIGTERM');
  assert.equal(before.startPreparation.status, 'pending');
  assert.equal(before.startRefused, false);
  assert.equal(before.native_launch_attempted, false);
  assert.equal(rows(f).filter(e => e.type === 'run.started').length, 1);
  assert.equal(promptCalls(f).length, 0);
  const retry = f.dispatch(['--retry', f.jobs()[0]]);
  assert.equal(retry.status, 0, retry.stderr + retry.stdout);
  assert.equal(saved(f).run, 'R-1');
  assert.equal(saved(f).startPreparation.status, 'complete');
  assert.equal(rows(f).filter(e => e.type === 'run.started').length, 1);
  assert.equal(promptCalls(f).length, 1);
});

test('an installed consumer with BCH-sized retained history binds on its first dispatch', async t => {
  const project = configFixture(t);
  await project.adopt();
  const f = fixture(t, { project });
  const benchmark = f.rec(['add', 'Start timing control', '--role', 'engineer']).match(/ENG-\d+/)[0];
  // Representative closed run/note history, not just a large inert JSON field.
  // No live allocations, native bindings or copied consumer data are invented.
  const history = [];
  for (let n = 1; n <= 1000; n++) {
    const id = `OLD-${n}`, run = `R-${n}`;
    history.push({ type: 'item.added', id, title: `Retained historical work ${n}`, role: 'engineer' },
      { type: 'run.started', id: run, item: id, workspace: f.repo, meta: {} },
      { type: 'report.ingested', run, report: { outcome: 'done', summary: 'Historical completion', blockers: [], proposals: [] } },
      { type: 'item.closed', id, as: 'done' });
  }
  const initial = rows(f).length, count = 67800 - initial;
  const text = 'Historical retained evidence. '.repeat(34);
  while (history.length < count) history.push({ type: 'note.added', id: `OLD-${history.length % 1000 + 1}`, text });
  transact(f.org, () => ({ add: history }), { actor: 'B8 isolated history fixture' });
  history.length = 0;
  const log = path.join(f.org, 'events.jsonl'), bytes = fs.statSync(log).size;
  assert.ok(bytes >= 68.6 * 1024 ** 2, `large-record witness has ${bytes} bytes`);
  // An existing empty closeout queue exercises the publication path while
  // granting no cleanup effects. Default policy and guards remain active.
  fs.mkdirSync(path.join(f.repo, '.git/closeout/entries'), { recursive: true });
  const start = performance.now();
  const baseline = f.rec(['start', benchmark, '--workspace', f.repo]);
  const synchronousMs = performance.now() - start;
  const baselineRun = baseline.match(/^(R-\d+) started/m)[1];
  f.rec(['abandon', baselineRun]);
  const hook = path.join(f.root, 'start-timing.mjs'), timings = path.join(f.root, 'start-timing.json');
  const installedRecord = path.join(project.bundle, 'bin/org.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]===${JSON.stringify(installedRecord)}&&process.argv[2]==='start'){
 const began=performance.now(),write=fs.writeSync,sync=fs.fsyncSync;let appended=false,commitMs;
 fs.writeSync=function(fd,bytes,...rest){const result=write.call(this,fd,bytes,...rest);
  if(String(bytes).includes('"preparation_deferred":true'))appended=true;return result;};
 fs.fsyncSync=function(...args){const result=sync.apply(this,args);if(appended)commitMs=performance.now()-began;return result;};
 process.on('exit',()=>fs.writeFileSync(${JSON.stringify(timings)},JSON.stringify({commit_ms:commitMs,exit_ms:performance.now()-began,deferred:process.argv.includes('--defer-preparation')})));
 syncBuiltinESMExports();
}`);
  const launchStart = performance.now();
  const result = f.start([], { env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${hook}` } });
  const launchMs = performance.now() - launchStart;
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const job = saved(f), events = rows(f), startEvent = events.find(e => e.type === 'run.started' && e.id === job.run);
  const bound = events.find(e => e.type === 'run.session_bound' && e.run === job.run);
  assert.ok(bound, 'first attempt records a native session binding');
  assert.equal(job.stage, 'complete');
  assert.equal(job.startPreparation.status, 'complete');
  assert.equal(job.release.root, project.bundle);
  assert.equal(startEvent.preparation_deferred, true);
  assert.equal(events.filter(e => e.type === 'run.started' && e.item === f.item).length, 1);
  assert.equal(events.filter(e => e.type === 'dispatch.completed' && e.journal === f.jobs()[0]).length, 1);
  assert.equal(promptCalls(f).length, 1);
  const brief = fs.readFileSync(f.show(job.run).brief_path, 'utf8');
  assert.match(brief, /## Durable locations/);
  assert.match(brief, /## When you stop: write one report/);
  const timing = JSON.parse(fs.readFileSync(timings));
  assert.equal(timing.deferred, true);
  assert.ok(Number.isFinite(timing.commit_ms));
  const evidence = { fixture_only: true, native: 'scripted transport; real installed dispatch, record and claim guards',
    event_count_before: 67800, bytes_before: bytes, synchronous_start_ms: synchronousMs,
    deferred_start: timing, dispatch_ms: launchMs, start_to_session_bound_ms: Date.parse(bound.at) - Date.parse(startEvent.at),
    first_attempt_successes: 1, attempts: 1, run: job.run, original_start_count: 1, recovery_calls: 0,
    candidate: process.env.B8_CANDIDATE ?? null };
  if (process.env.B8_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.B8_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.B8_EVIDENCE_DIR, 'installed-large-record.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  }
  t.diagnostic(JSON.stringify(evidence));
});
