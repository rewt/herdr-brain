import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, DISPATCH, RECORD, promptCalls } from './dispatch-fixture.mjs';

// These controls stop at the fake lane's refused launch. They never observe a
// host process, launch a worker, arm a watcher or send a prompt.
function hook(f, body) {
  const file = path.join(f.root, 'record-race.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
const lock=${JSON.stringify(path.join(f.org, 'lock'))},log=${JSON.stringify(path.join(f.org, 'events.jsonl'))};
const mkdir=fs.mkdirSync;let attempts=0;
const dispatch=process.argv[1]===${JSON.stringify(DISPATCH)},record=process.argv[1]===${JSON.stringify(RECORD)};
fs.mkdirSync=function(file,...args){${body}};
`);
  return { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${file}` };
}
function interrupted(t) {
  const f = fixture(t); f.fail('dispatch');
  const env = hook(f, `if(file===lock&&dispatch&&new Error().stack.includes('at claimRun ')&&attempts++===0)
    throw Error('injected interruption before initial claim');
    return mkdir.call(this,file,...args);`);
  const result = f.start([], { env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /injected interruption before initial claim/);
  const journal = f.jobs()[0], saved = JSON.parse(fs.readFileSync(journal));
  assert.equal(saved.stage, 'starting'); assert.equal(saved.run, 'R-1');
  assert.equal(saved.ownership, undefined); assert.equal(f.show(saved.run).owner, undefined);
  return { f, journal, saved, result };
}
const events = f => fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const launches = f => f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch');
function noDelivery(f) {
  assert.equal(promptCalls(f).length, 0);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 0);
}

test('dispatch replans concurrent record starts and claims before one launch attempt', t => {
  const f = fixture(t); f.fail('dispatch');
  const env = hook(f, `const raced=file===lock&&((record&&process.argv[2]==='start')||
    (dispatch&&new Error().stack.includes('at claimRun ')));
    const result=mkdir.call(this,file,...args);
    if(raced&&attempts++<3){const rows=fs.readFileSync(log,'utf8').trim().split('\\n');
      fs.appendFileSync(log,JSON.stringify({seq:JSON.parse(rows.at(-1)).seq+1,type:'future.concurrent'})+'\\n');}
    return result;`);
  const result = f.start([], { env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /injected dispatch/);
  const rows = events(f);
  assert.equal(rows.filter(e => e.type === 'future.concurrent').length, 6);
  assert.equal(rows.filter(e => e.type === 'run.started').length, 1);
  assert.equal(rows.filter(e => e.type === 'run.claimed').length, 1);
  const conflicts = fs.readFileSync(path.join(f.org, 'record-conflicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(conflicts.filter(e => e.code === 'RECORD_PLANNING_CONFLICT' && e.retry).length, 6);
  assert.equal(launches(f).length, 1); noDelivery(f);
  const retry = f.dispatch(['--retry', 'R-1']);
  assert.match(retry.stderr, /worker launch outcome is unknown/);
  assert.equal(launches(f).length, 1, 'an uncertain native attempt is never replayed');
});

test('worker receipt preparation retries concurrent appends without duplicating identity', t => {
  const f = fixture(t); f.fail('dispatch'); assert.equal(f.start().status, 1);
  const saved = JSON.parse(fs.readFileSync(f.jobs()[0]));
  const env = hook(f, `const result=mkdir.call(this,file,...args);
    if(file===lock&&record&&process.argv[2]==='worker'&&attempts++<3){
      const rows=fs.readFileSync(log,'utf8').trim().split('\\n');
      fs.appendFileSync(log,JSON.stringify({seq:JSON.parse(rows.at(-1)).seq+1,type:'future.concurrent'})+'\\n');}
    return result;`);
  const args = ['worker', saved.run, '--agent', 'fixture-worker', '--pane', 'fixture:p1',
    '--worker-workspace', 'fixture', '--terminal-id', 'fixture-terminal', '--cwd', saved.workspace];
  f.rec(args, { NODE_OPTIONS: env.NODE_OPTIONS });
  assert.equal(events(f).filter(e => e.type === 'future.concurrent').length, 3);
  assert.equal(events(f).filter(e => e.type === 'run.updated' && e.meta?.agent === 'fixture-worker').length, 1);
  assert.equal(f.show(saved.run).meta.terminal_id, 'fixture-terminal'); noDelivery(f);
});

for (const selector of ['run', 'journal']) test(`retry by ${selector} finishes an interrupted initial claim on the original run`, t => {
  const { f, journal, saved, result } = interrupted(t);
  const advice = JSON.parse(result.stdout).retry;
  assert.ok(advice.includes(DISPATCH) && advice.includes(f.repo) && advice.includes(f.org) && advice.includes(saved.run));
  assert.ok(result.stderr.includes(`retry: ${advice}`));
  const retry = f.dispatch(['--retry', selector === 'run' ? saved.run : journal]);
  assert.equal(retry.status, 1, retry.stdout + retry.stderr);
  assert.match(retry.stderr, /injected dispatch/);
  assert.doesNotMatch(retry.stderr, /RUN_OWNER_UNCLAIMED/);
  assert.deepEqual(f.show(f.item).runs, [saved.run]);
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, 1);
  assert.equal(f.show(saved.run).owner.controller, 'brain');
  assert.equal(launches(f).length, 1); noDelivery(f);
});

test('pre-run failure prints a journal retry and resumes the saved request', t => {
  const f = fixture(t); f.fail('prepare');
  const result = f.start(), journal = f.jobs()[0], advice = JSON.parse(result.stdout).retry;
  assert.equal(result.status, 1); assert.ok(advice.includes(journal));
  assert.ok(advice.includes(f.org) && advice.includes(f.repo));
  assert.deepEqual(f.show(f.item).runs, []);
  f.fail('dispatch'); const retry = f.dispatch(['--retry', journal]);
  assert.match(retry.stderr, /injected dispatch/);
  assert.equal(f.show(f.item).runs.length, 1); assert.equal(launches(f).length, 1); noDelivery(f);
});

for (const control of ['STOP', 'HOLD']) test(`pre-claim retry retains the ${control} launch guard`, t => {
  const { f, saved } = interrupted(t);
  if (control === 'STOP') {
    const directory = path.join(f.repo, '.lane/supervisor'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'STOP'), 'fixture stop');
  } else f.rec(['set', f.item, 'meta.hold=true']);
  const retry = f.dispatch(['--retry', saved.run]);
  assert.match(retry.stderr, control === 'STOP' ? /Supervisor STOP/ : /dispatch launch input changed/);
  assert.deepEqual(f.show(f.item).runs, [saved.run]); assert.equal(launches(f).length, 0); noDelivery(f);
});

for (const changed of ['request', 'native', 'abandoned', 'owner', 'ambiguous']) test(`pre-claim recovery refuses changed ${changed} evidence without another effect`, t => {
  const { f, journal, saved } = interrupted(t);
  if (changed === 'request') saved.token = 'foreign-request';
  if (changed === 'native') saved.native_launch_attempted = true;
  if (changed === 'abandoned') f.rec(['abandon', saved.run, '--note', 'fixture abandoned']);
  if (changed === 'owner') f.rec(['claim', saved.run, '--controller', 'foreign-controller', '--legacy']);
  if (changed === 'ambiguous') {
    f.rec(['start', f.item, '--route', saved.route, '--route-config', saved.routeConfig, '--workspace', saved.workspace,
      ...Object.entries({ lane: saved.lane, dispatch_journal: journal, dispatch_project: saved.common,
        dispatch_record: saved.org, dispatch_attempt: saved.token,
        dispatch_unlanded_admitted: saved.unlandedCap.admission.admitted }).flatMap(([key, value]) => ['--meta', `${key}=${value}`])]);
  }
  fs.writeFileSync(journal, JSON.stringify(saved));
  const before = fs.readFileSync(journal, 'utf8'), claims = events(f).filter(e => e.type === 'run.claimed').length;
  const retry = f.dispatch(['--retry', saved.run]);
  assert.equal(retry.status, 1, retry.stdout + retry.stderr);
  assert.match(retry.stderr, changed === 'owner' ? /RUN_OWNED_ELSEWHERE/ : /RUN_OWNER_UNCLAIMED/);
  assert.equal(fs.readFileSync(journal, 'utf8'), before);
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, claims);
  assert.equal(launches(f).length, 0); noDelivery(f);
});
