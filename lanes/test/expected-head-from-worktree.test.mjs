import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initOrg, transact, loadEvents } from '../../lib/store.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { acquireLock } from '../promotion-lock.mjs';
import { makeFixture, openLane, commitFile, git, lane, laneProcess, writeConfig, waitForFile } from './lane-fixture.mjs';

const flag = '--expected-head-from-worktree';
const storeURL = new URL('../../lib/store.mjs', import.meta.url).href;

function fixture(t, { waived = false } = {}) {
  const f = makeFixture({ main: 'main', validate: 'true' });
  t.after(() => f.cleanup());
  fixtureFleet(t, f.root);
  f.env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  fs.writeFileSync(path.join(f.root, '.identity-root'), 'fixture\n');
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.org/\n.lane/\n');
  const topic = 'owned-head', workspace = openLane(f, topic), org = path.join(f.repo, '.org');
  commitFile(workspace, 'owned.txt', 'owned\n', 'Owned candidate');
  initOrg(org);
  const identity = fs.realpathSync(path.join(f.repo, '.git'));
  const native = { name: 'own-worker', pane_id: 'own-pane', workspace_id: 'own-workspace',
    terminal_id: 'own-terminal', cwd: workspace, agent_session: { value: 'own-session' } };
  const owner = { controller: 'brain', legacy: false,
    release: { id: 'source', commit: null, root: f.repo, identity } };
  const add = rows => transact(org, () => ({ add: rows }), { actor: 'fixture' });
  add([{ type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'Owned source' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace, meta: { lane: topic,
      agent: native.name, pane: native.pane_id, worker_workspace: native.workspace_id,
      terminal_id: native.terminal_id, agent_session_id: native.agent_session.value } },
    { type: 'run.claimed', run: 'R-1', project: identity, record: org, owner }]);
  const nativeFile = path.join(f.root, 'native.json'), calls = path.join(f.root, 'native-calls');
  const saveNative = () => fs.writeFileSync(nativeFile, JSON.stringify(native));
  saveNative();
  fs.writeFileSync(path.join(f.bin, 'herdr'), `#!${process.execPath}
const fs=require('fs');
if(process.argv.slice(2).join(' ')!=='agent get own-pane')process.exit(1);
fs.appendFileSync(${JSON.stringify(calls)},'read\\n');
console.log(JSON.stringify({result:{agent:JSON.parse(fs.readFileSync(${JSON.stringify(nativeFile)}))}}));
`, { mode: 0o755 });
  Object.assign(f.env, { ORG_DIR: org, HERDR_ENV: '1', HERDR_PANE_ID: native.pane_id,
    HERDR_WORKSPACE_ID: native.workspace_id, CODEX_THREAD_ID: native.agent_session.value });
  const base = git(f.repo, ['rev-parse', 'HEAD']), head = git(workspace, ['rev-parse', 'HEAD']);
  const config = { main: 'main', validate: 'true', ...(waived ? { validation: {
    landing_waiver: 'operator-20261025-until-stable-release', promotion: 'false' } } : {}) };
  writeConfig(f, config);
  const gate = code => {
    const file = path.join(f.root, 'gate.mjs');
    fs.writeFileSync(file, `import fs from 'node:fs';import cp from 'node:child_process';
import {transact} from ${JSON.stringify(storeURL)};
const git=(cwd,args)=>cp.execFileSync('git',['-C',cwd,...args],{stdio:'pipe'});
fs.writeFileSync(${JSON.stringify(path.join(f.root, 'gate-ran'))},'yes');
${code}\n`);
    writeConfig(f, { ...config, validate: `${process.execPath} ${file}` });
  };
  const promote = (args = [flag], options = {}) => lane(f, ['promote', topic, ...args], options);
  const unchanged = () => assert.equal(git(f.repo, ['rev-parse', 'main']), base);
  return { ...f, topic, workspace, org, identity, native, owner, add, nativeFile, calls,
    saveNative, base, head, gate, promote, unchanged };
}

test('worktree expected head captures the topic from an unrelated cwd and emits one immutable waived landing', t => {
  const f = fixture(t, { waived: true });
  // The command cwd has a different HEAD; native authority still owns the topic.
  const other = path.join(f.root, 'unrelated');
  git(f.repo, ['worktree', 'add', '-b', 'unrelated', other]);
  commitFile(other, 'other.txt', 'other', 'Unrelated head');
  const result = f.promote([flag], { cwd: other });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.match(/^captured expected head: /gm)?.length, 1);
  assert.ok(result.stdout.includes(`captured expected head: ${f.head}\n`));
  assert.doesNotMatch(result.stdout, /rebased /);
  assert.doesNotMatch(result.stderr, /post-FF landing receipt held/);
  const receipt = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('landing receipt: ')).slice('landing receipt: '.length));
  assert.equal(receipt.recorded, true);
  assert.equal(receipt.expected_head_source, 'worktree');
  assert.equal(receipt.expected_head, f.head);
  assert.equal(receipt.base, f.base);
  assert.equal(receipt.head, f.head);
  assert.equal(receipt.changes.length, 1);
  const landed = loadEvents(f.org).events.filter(event => event.type === 'change.landed');
  assert.equal(landed.length, 1);
  assert.equal(landed[0].base, f.base);
  assert.equal(landed[0].head, f.head);
  assert.equal(landed[0].run, 'R-1');
  assert.equal(landed[0].producer.agent, f.native.name);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.head);
  assert.equal(git(other, ['rev-parse', 'HEAD']), git(f.repo, ['rev-parse', 'unrelated']));
  assert.equal(fs.existsSync(path.join(f.root, 'gate-ran')), false);
});

for (const kind of ['no-native', 'native-name', 'native-session', 'native-workspace', 'native-cwd', 'run-worker', 'unclaimed', 'foreign-claim', 'HOLD'])
test(`worktree expected head refuses ${kind} before capture`, t => {
  const f = fixture(t);
  if (kind === 'no-native') delete f.env.HERDR_ENV;
  if (kind === 'native-name') f.native.name = 'another-worker';
  if (kind === 'native-session') f.native.agent_session.value = 'another-session';
  if (kind === 'native-workspace') f.native.workspace_id = 'another-workspace';
  if (kind === 'native-cwd') f.native.cwd = f.repo;
  if (kind === 'run-worker') f.add([{ type: 'run.updated', id: 'R-1', meta: { agent: 'another-worker' } }]);
  if (kind === 'unclaimed') f.add([{ type: 'run.claimed', run: 'R-1', project: f.identity, record: f.org, owner: null }]);
  if (kind === 'foreign-claim') f.add([{ type: 'run.claimed', run: 'R-1', project: f.identity, record: f.org, owner: { ...f.owner, controller: 'foreign' } }]);
  if (kind === 'HOLD') f.add([{ type: 'item.updated', id: 'ENG-1', fields: { meta: { hold: true } } }]);
  f.saveNative();
  const result = f.promote();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /native|owning|UNCLAIMED|OWNED_ELSEWHERE|HOLD/);
  assert.doesNotMatch(result.stdout, /captured expected head:/);
  f.unchanged();
});

test('worktree expected head refuses behind main without recapture or rebase', t => {
  const f = fixture(t);
  commitFile(f.repo, 'main.txt', 'new main', 'Main advanced');
  const before = git(f.repo, ['rev-parse', 'HEAD']);
  const result = f.promote();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected head requires a rebase/);
  assert.equal(result.stdout.match(/captured expected head:/g)?.length, 1);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), f.head);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), before);
  assert.equal(fs.existsSync(path.join(f.root, 'gate-ran')), false);
});

for (const kind of ['dirty-lane', 'dirty-main', 'STOP']) test(`worktree expected head retains initial ${kind} refusal`, t => {
  const f = fixture(t);
  if (kind === 'dirty-lane') fs.writeFileSync(path.join(f.workspace, 'dirty'), 'dirty');
  if (kind === 'dirty-main') fs.writeFileSync(path.join(f.repo, 'dirty'), 'dirty');
  if (kind === 'STOP') {
    fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true });
    fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'stop');
  }
  const result = f.promote();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not clean|supervisor STOP/);
  f.unchanged();
});

for (const kind of ['tip', 'branch', 'main', 'dirty-lane', 'dirty-main', 'STOP', 'HOLD', 'native', 'claim-generation'])
test(`worktree expected head refuses late ${kind} at the fast-forward boundary`, t => {
  const f = fixture(t);
  const update = rows => `transact(${JSON.stringify(f.org)},()=>({add:${JSON.stringify(rows)}}));`;
  const changes = {
    tip: `git(${JSON.stringify(f.workspace)},['commit','--allow-empty','-m','Moved tip']);`,
    branch: `git(${JSON.stringify(f.workspace)},['checkout','-b','other-branch']);`,
    main: `git(${JSON.stringify(f.repo)},['commit','--allow-empty','-m','Moved main']);`,
    'dirty-lane': `fs.writeFileSync(${JSON.stringify(path.join(f.workspace, 'late-dirty'))},'dirty');`,
    'dirty-main': `fs.writeFileSync(${JSON.stringify(path.join(f.repo, 'late-dirty'))},'dirty');`,
    STOP: `fs.mkdirSync(${JSON.stringify(path.join(f.repo, '.lane/supervisor'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(f.repo, '.lane/supervisor/STOP'))},'stop');`,
    HOLD: update([{ type: 'item.updated', id: 'ENG-1', fields: { meta: { hold: true } } }]),
    native: `fs.writeFileSync(${JSON.stringify(f.nativeFile)},${JSON.stringify(JSON.stringify({ ...f.native, terminal_id: 'replaced-terminal' }))});`,
    'claim-generation': update([{ type: 'run.claimed', run: 'R-1', project: f.identity, record: f.org, owner: f.owner }]),
  };
  f.gate(changes[kind]);
  const result = f.promote();
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /changed|differs from expected head|not clean|STOP|HOLD|OWNED_ELSEWHERE/);
  assert.equal(result.stdout.match(/captured expected head:/g)?.length, 1);
  assert.equal(loadEvents(f.org).events.some(event => event.type === 'change.landed'), false);
  assert.equal(fs.existsSync(path.join(f.org, 'lock')), false, 'refusal releases the record lock');
  if (kind === 'main') assert.notEqual(git(f.repo, ['rev-parse', 'HEAD']), f.head);
  else f.unchanged();
});

test('worktree expected head captures only after acquiring the shared promotion lock', async t => {
  const f = fixture(t, { waived: true }), lock = path.join(f.identity, 'lane-promote.lock');
  const release = acquireLock(lock), waiting = path.join(f.root, 'waiting');
  const loader = path.join(f.root, 'observe-lock.mjs');
  fs.writeFileSync(loader, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.mkdirSync;fs.mkdirSync=function(file,...args){try{return original.call(this,file,...args);}catch(error){if(file===${JSON.stringify(lock)}&&error.code==='EEXIST')fs.writeFileSync(${JSON.stringify(waiting)},'waiting');throw error;}};syncBuiltinESMExports();`);
  const pending = laneProcess(f, ['promote', f.topic, flag], { env: { ...f.env, NODE_OPTIONS: `--import=${loader}` } });
  try {
    await waitForFile(waiting);
    assert.equal(fs.existsSync(f.calls), false, 'native authority and capture wait for the promotion lock');
    assert.doesNotMatch(pending.stdout(), /captured expected head:/);
    commitFile(f.workspace, 'while-waiting', 'new tip', 'Tip before capture');
    const captured = git(f.workspace, ['rev-parse', 'HEAD']);
    release();
    const result = await pending.completed;
    assert.equal(result.code, 0, pending.stderr() || pending.stdout());
    assert.ok(pending.stdout().includes(`captured expected head: ${captured}\n`));
    assert.equal(git(f.repo, ['rev-parse', 'HEAD']), captured);
  } finally { release(); }
});

test('literal expected head still enforces its supplied CAS tuple', t => {
  const f = fixture(t);
  const refused = f.promote(['--expected-head', f.base]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /lane tip differs from expected head/);
  f.unchanged();
  const accepted = f.promote(['--expected-head', f.head]);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.head);
  assert.doesNotMatch(accepted.stdout, /captured expected head:/);
});

for (const args of [[flag, flag], [flag, '--expected-head', 'a'.repeat(40)],
  ['--expected-head', 'a'.repeat(40), flag], [flag, '--if-current-run', 'R-1', '--org', '/unused'], [flag, 'true']])
test(`worktree expected head rejects ambiguous arguments ${args.join(' ')}`, t => {
  const f = fixture(t), result = f.promote(args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: lane promote/);
  assert.equal(fs.existsSync(f.calls), false);
  f.unchanged();
});
