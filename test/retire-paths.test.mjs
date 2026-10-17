import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRetirement } from '../supervisor/retire.mjs';
import { queueFor, finishCleanup, retryCleanup, drain } from '../promote/promote.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { copyProduct } from '../lib/product-files.mjs';
import { requestRetirement, consumeRetirement } from '../lib/retire-trigger.mjs';
import { retirementDeadline } from '../lib/retire-lock.mjs';
import { stopFixtureInbox } from './helpers/inbox.mjs';
import { createHousekeeping, tidyFinishedTabs } from '../housekeeping/housekeeping.mjs';
import { recordStandardSlot, slotReceiptFile } from '../sessions/receipts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const laneCLI = path.join(root, 'lanes/lane.mjs'), recordCLI = path.join(root, 'bin/org.mjs');
const heldReason = 'retirement held: .lane/supervisor/HOLD-WORKER-TAB-CLOSE';
function hold(f, kind = 'file') {
  f.traceGit();
  const file = path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (kind === 'directory') fs.mkdirSync(file);
  else if (kind === 'symlink') fs.symlinkSync('missing-target', file);
  else fs.writeFileSync(file, 'contents must never be read');
  return () => fs.rmSync(file, { recursive: true, force: true });
}
function isolatedEnv(t, f) {
  const old = {};
  for (const key of ['ORG_DIR', 'HERDR_MONITOR_FLEET', 'HERDR_RETIRE_HERDR', 'MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'XDG_STATE_HOME']) {
    old[key] = process.env[key]; process.env[key] = f.env[key];
  }
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function assertNoRemoval(f) {
  assert.deepEqual(f.read().actions.filter(a => ['close', 'remove'].includes(a[1])), []);
  assert.deepEqual(f.gitCalls().filter(a => a.includes('worktree') && a.includes('remove')), []);
}
function fixture(t, { merged = true, occupied = true } = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retire-path-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'repo'), lane = path.join(scratch, 'lane'), org = path.join(scratch, 'record');
  fs.mkdirSync(repo); fs.mkdirSync(org); fs.mkdirSync(path.join(org, 'references'));
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'retire-fixture', HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'),
    MONITOR_TEST_SLOT_PATH: path.join(scratch, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(scratch, 'slot'),
    XDG_STATE_HOME: path.join(scratch, 'trusted'), HERDR_TAB_ID: '', HERDR_PANE_ID: '' };
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'seed'), 'base'); git(['add', '.']); git(['commit', '-qm', 'base']);
  git(['worktree', 'add', '-b', 'lane/topic', lane]); fs.writeFileSync(path.join(lane, 'seed'), 'changed'); git(['commit', '-am', 'work'], lane);
  const head = git(['rev-parse', 'HEAD'], lane); if (merged) git(['merge', '--ff-only', head]);
  const common = fs.realpathSync(path.join(repo, '.git'));
  const state = { workspaces: [{ workspace_id: 'w', worktree: { checkout_path: lane, repo_key: common, repo_root: repo, is_linked_worktree: true } }],
    tabs: occupied ? [{ tab_id: 'w:t', workspace_id: 'w' }] : [], panes: occupied ? [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w' }] : [],
    agents: occupied ? [{ name: 'worker', agent: 'native', agent_status: 'done', pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w',
      cwd: lane, terminal_id: 'term', agent_session: { value: 'session' }, state_change_seq: 5 }] : [], actions: [] };
  const file = path.join(scratch, 'state.json'), herdr = path.join(scratch, 'herdr');
  const save = () => fs.writeFileSync(file, JSON.stringify(state)); save();
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs = require('node:fs'), file = ${JSON.stringify(file)}, s = JSON.parse(fs.readFileSync(file)), a = process.argv.slice(2);
const out = result => console.log(JSON.stringify({ result }));
if(a[0]==='workspace'&&a[1]==='list'&&s.readyMarker&&!fs.existsSync(s.readyMarker)){s.preReadyObservation=true;fs.writeFileSync(file,JSON.stringify(s));console.error('retirement observed before acknowledgment');process.exit(1);}
if(a[0]==='workspace'&&a[1]==='list'&&s.currentQueue){const q=JSON.parse(fs.readFileSync(s.currentQueue));s.catchupCurrent=q.current?.id??null;s.catchupPersisted=q.results.length;fs.writeFileSync(file,JSON.stringify(s));if(q.current){s.observedCurrent=true;fs.writeFileSync(file,JSON.stringify(s));console.error('retirement catch-up left a dequeued job current');process.exit(1);}}
if(a[0]==='workspace'&&a[1]==='list'&&s.delayWorkspace)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,s.delayWorkspace);
if (a[0] === 'workspace' && a[1] === 'list') out({workspaces:s.workspaces});
else if (a[0] === 'worktree' && a[1] === 'list') out({source:{repo_key:${JSON.stringify(common)},repo_root:${JSON.stringify(repo)},source_checkout_path:${JSON.stringify(repo)}},worktrees:[{path:${JSON.stringify(lane)},open_workspace_id:'w'}]});
else if (a[0] === 'tab' && a[1] === 'list') out({tabs:s.tabs.filter(t=>t.workspace_id===a.at(-1))});
else if (a[0] === 'pane' && a[1] === 'list') out({panes:s.panes.filter(p=>p.workspace_id===a.at(-1))});
else if (a[0] === 'pane' && a[1] === 'process-info') out({process_info:s.watcherMode&&a.at(-1)==='main:watch:p'?{shell_pid:1,foreground_processes:[{name:'node',pid:process.ppid}],process_tree_complete:true,process_tree:[{pid:1,identity:'shell',state:'S',command:'[zsh]'},{pid:process.ppid,identity:'watcher',state:'S',command:'[node]'}]}:s.info??{shell_pid:1,foreground_processes:[{name:'native',pid:2}],process_tree_complete:true,process_tree:[{pid:1,identity:'shell',state:'S',command:'[zsh]'},{pid:2,identity:'native',state:'S',command:'[native]'}]}});
else if (a[0] === 'agent' && a[1] === 'list') out({agents:s.agents});
else if (a[0] === 'tab' && a[1] === 'close') {
  if(s.failClose) { console.error('injected tab failure'); process.exit(1); }
  s.actions.push(a); s.tabs=s.tabs.filter(t=>t.tab_id!==a[2]); s.panes=s.panes.filter(p=>p.tab_id!==a[2]); s.agents=s.agents.filter(g=>g.tab_id!==a[2]); fs.writeFileSync(file,JSON.stringify(s)); out({});
  if(s.triggerOnClose){const hint=${JSON.stringify(path.join(org,'retirement/request.json'))};const r=JSON.parse(fs.readFileSync(hint));fs.writeFileSync(hint,JSON.stringify({...r,revision:r.revision+1,source:'completion during apply'}));}
} else if(a[0] === 'workspace' && a[1] === 'close') {if(s.failWorkspace){console.error('injected workspace failure');process.exit(1);}s.actions.push(a);s.workspaces=[];fs.writeFileSync(file,JSON.stringify(s));out({});}
else if(a[0]==='tab'&&a[1]==='create') {s.actions.push(a);s.tabs.push({tab_id:'main:watch',workspace_id:'main'});s.panes.push({pane_id:'main:watch:p',tab_id:'main:watch',workspace_id:'main'});fs.writeFileSync(file,JSON.stringify(s));out({root_pane:{pane_id:'main:watch:p'}});}
else if(a[0]==='pane'&&a[1]==='run') {const r=require('node:child_process').spawnSync(a[3],{shell:true,encoding:'utf8',env:{...process.env,HERDR_TAB_ID:'main:watch',HERDR_PANE_ID:'main:watch:p'}});if(r.status!==0){console.error(r.stdout+r.stderr);process.exit(1);}console.error(r.stdout);out({child:r.stdout});}
else if(a[0]==='agent'&&a[1]==='get') out({agent:s.sessionMode?{agent_status:'done'}:s.agents.find(g=>g.name===a[2])??{agent_status:'done'}});
else if(s.sessionMode && a[0]==='agent'&&a[1]==='start') {s.agents.forEach(g=>g.agent_status='done');fs.writeFileSync(file,JSON.stringify(s));out({});}
else if(s.sessionMode && a[0]==='agent'&&['prompt','wait'].includes(a[1])) out({});
else if(s.sessionMode && a[0]==='pane'&&a[1]==='read') {console.log('fixture session complete');}
else if(s.sessionMode && a[0]==='notification') out({});
else {console.error('unexpected fixture command '+a.join(' '));process.exit(1);}
`, { mode: 0o755 });
  env.HERDR_RETIRE_HERDR = herdr;
  env.PATH = `${scratch}:${process.env.PATH}`;
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(), gitLog = path.join(scratch, 'git-calls.jsonl');
  const traceGit = () => fs.writeFileSync(path.join(scratch, 'git'), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify(args)+'\\n');const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  const events = [
    { type: 'item.added', id: 'ENG-1', role: 'engineer', kind: 'work' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: lane, meta: { agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'term', agent_session_id: 'session', lane: 'topic' } },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Immutable' }, sha256: 'report-hash' },
    { type: 'item.closed', id: 'ENG-1', as: 'done' },
  ].map((e,i) => ({...e,seq:i+1,at:'2026-01-01T00:00:00Z',by:'test'}));
  const eventFile = path.join(org, 'events.jsonl'); const eventBytes = events.map(e => JSON.stringify(e)+'\n').join(''); fs.writeFileSync(eventFile,eventBytes);
  const retirement = () => createRetirement({ cwd: repo, org, herdr, env });
  const close = (gitOnly = true) => spawnSync(process.execPath, [laneCLI, 'close', 'topic', ...(gitOnly ? ['--git-only'] : []), ...(merged ? ['--expected-tip',head] : [])], { cwd: repo, env, encoding: 'utf8' });
  const job = { id: 'job', topic: 'topic', org, run: 'R-1', herdr, laneCLI };
  return { scratch, repo, lane, org, env, git, head, common, state, save, file, retirement, close, job,
    eventFile, eventBytes, read: () => JSON.parse(fs.readFileSync(file)), queue: () => queueFor(repo),
    traceGit, gitCalls: () => fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

function adoptStandard(f) {
  return recordStandardSlot({ cwd: f.lane, action: 'adopt', uid: 'fixture-chat', actor: 'fixture', why: 'offline proven binding',
    slot: { server: 'default', workspace: 'w', checkout: f.lane, tab: 'w:t', standardSlot: 'chat', panes: [{ pane: 'w:p', paneSlot: 'primary' }] } });
}
test('standard-slot runtime rechecks canonical lane receipts before tab, workspace and guarded lane removal', t => {
  const f = fixture(t), retirement = f.retirement(), plan = retirement.plan(); assert.equal(plan.close.length, 1);
  adoptStandard(f);
  const blocked = retirement.apply(plan); assert.equal(blocked[0].action, 'skip-close'); assert.match(blocked[0].why, /adopted standard slot/);
  assert.match(createRetirement({ cwd: f.lane, org: f.org, herdr: f.job.herdr, env: f.env }).plan(f.lane).keep[0].why, /adopted/);
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head }), /adopted/);
  assertNoRemoval(f);
  recordStandardSlot({ cwd: f.repo, action: 'withdraw', uid: 'fixture-chat', actor: 'fixture', why: 'explicit offline disposition' });
  assert.equal(retirement.apply(retirement.plan())[0].action, 'closed');
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});
test('standard-slot runtime preserves an enclosing workspace after tabs disappear and keeps unreadable evidence', t => {
  const f = fixture(t, { occupied: false }), retirement = f.retirement(); adoptStandard(f);
  assert.throws(() => retirement.assertVacant(f.lane), /adopted/);
  for (const bytes of ['{', JSON.stringify({ schema: 'standard-slot-history/v1', common: '/foreign/.git', operations: [] })]) {
    fs.writeFileSync(slotReceiptFile(f.common), bytes);
    assert.throws(() => retirement.assertVacant(f.lane), /protection evidence unreadable/);
  }
  assertNoRemoval(f);
});
test('STOP during an unreviewed or needs-human chain retains the warm worker without launching anything', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'stop dispatch');
  const events = loadEvents(f.org).events.filter(e => e.type !== 'item.closed');
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  assert.match(f.retirement().plan().keep[0].why, /chain is still open/);
  events.find(e => e.type === 'report.ingested').report.outcome = 'needs_human';
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  assert.match(f.retirement().plan().keep[0].why, /disposition/); assertNoRemoval(f);
});

test('CLI dry plan reads the fold and shared executor refuses a concurrent native-session replacement', t => {
  const f = fixture(t), retirement = f.retirement(), plan = retirement.plan(); assert.equal(plan.close.length,1);
  f.state.agents[0].agent_session.value = 'replacement'; f.save();
  const result = retirement.apply(plan); assert.equal(result[0].action,'skip-close'); assert.match(result[0].why,/identity/);
  assert.deepEqual(f.read().actions,[]); assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
  const cli = spawnSync(process.execPath,[path.join(root,'supervisor/retire.mjs'),'plan','--repo',f.repo,'--org',f.org,'--herdr',f.job.herdr],{env:f.env,encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).keep.length,1);
});

for (const kind of ['file', 'directory', 'symlink']) test(`retirement hold: ${kind} in the canonical checkout keeps every tab and receipt`, t => {
  const f = fixture(t), logs = [];
  const retirement = createRetirement({ cwd: f.lane, org: f.org, herdr: f.job.herdr, env: f.env, log: row => logs.push(row) });
  retirement.recordCallback({ kind: 'executive', pane: 'w:p', pid: 2, agent: 'worker' });
  const directory = path.join(f.org, 'retirement/occupants'), original = fs.readdirSync(directory)[0];
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, original)));
  fs.writeFileSync(path.join(directory, original), JSON.stringify({ ...receipt, tab: 'another-gone' }));
  fs.writeFileSync(path.join(directory, 'absent.json'), JSON.stringify({ ...receipt, tab: 'gone' }));
  const release = hold(f, kind), plan = retirement.plan();
  const results = retirement.apply(plan);
  assertNoRemoval(f); assert.equal(plan.close.length, 0); assert.equal(plan.keep[0].why, heldReason);
  assert.equal(results[0].action, 'held'); assert.ok(logs.some(r => r.action === 'held' && r.tab_id === 'w:t'));
  assert.equal(fs.readdirSync(directory).length, 2);
  release(); retirement.apply(retirement.plan());
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]); assert.deepEqual(fs.readdirSync(directory), []);
});

test('retirement hold: appearing between plan and apply stops the stale close', t => {
  const f = fixture(t), retirement = f.retirement(), plan = retirement.plan(); assert.equal(plan.close.length, 1);
  const release = hold(f), result = retirement.apply(plan);
  assertNoRemoval(f); assert.equal(result[0].action, 'held'); assert.equal(result[0].why, heldReason);
  release(); retirement.apply(plan); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

for (const code of ['EACCES', 'ENOTDIR', 'EIO']) test(`retirement hold: indeterminate lstat ${code} fails closed without reading contents`, t => {
  const f = fixture(t), retirement = f.retirement(), original = fs.lstatSync, read = fs.readFileSync;
  const file = path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE');
  fs.lstatSync = function(target, ...args) { if (target === file) throw Object.assign(Error('injected hold lookup failure'), { code }); return original(target, ...args); };
  fs.readFileSync = function(target, ...args) { assert.notEqual(target, file, 'hold contents must not be read'); return read(target, ...args); };
  try { const plan = retirement.plan(), result = retirement.apply(plan); assertNoRemoval(f); assert.equal(plan.keep[0].why, heldReason); assert.equal(result[0].action, 'held'); }
  finally { fs.lstatSync = original; fs.readFileSync = read; }
  retirement.apply(retirement.plan()); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: rechecked after the final observation immediately before a close', t => {
  const f = fixture(t), plan = f.retirement().plan(); let release;
  const command = (exe, args, options) => {
    const result = spawnSync(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'list') release ??= hold(f);
    return result;
  };
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, command });
  const result = retirement.apply(plan); assertNoRemoval(f); assert.equal(result[0].action, 'held');
  release(); f.retirement().apply(plan); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: an empty workspace stays open and logs held before any close', t => {
  const f = fixture(t, { occupied: false }), logs = [];
  f.git(['worktree', 'remove', f.lane]);
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, log: row => logs.push(row) });
  const release = hold(f); assert.throws(() => retirement.closeEmptyWorkspace('w', f.lane), /retirement held/);
  assertNoRemoval(f); assert.equal(logs[0].action, 'held');
  release(); retirement.closeEmptyWorkspace('w', f.lane); assert.deepEqual(f.read().actions, [['workspace', 'close', 'w']]);
});

test('only a canonical hold can brake retirement; a lane-local lookalike has no authority', t => {
  const f = fixture(t), file = path.join(f.lane, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE');
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.lane/\n'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'lane-local');
  f.retirement().apply(f.retirement().plan()); assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

for (const mode of ['tidy', 'housekeeping-fast', 'housekeeping-strict', 'plan', 'apply', 'consume']) test(`retirement hold: ${mode} keeps tabs and logs the hold, then resumes`, t => {
  const f = fixture(t); isolatedEnv(t, f); const logs = [], release = hold(f);
  if (mode === 'consume') requestRetirement({ org: f.org, eventSeq: 4, source: 'held test' });
  const run = () => {
    if (mode === 'housekeeping-fast') {
      assert.equal(tidyFinishedTabs({ cwd: f.lane, org: f.org, herdr: f.job.herdr, record: [process.execPath, recordCLI], log: r => logs.push(r) }), true);
      return JSON.stringify(logs);
    }
    if (mode === 'housekeeping-strict') {
      createHousekeeping({ cwd: f.lane, org: f.org, herdr: f.job.herdr, log: r => logs.push(r) }).tick({ resume: false });
      return JSON.stringify(logs);
    }
    const args = mode === 'tidy' ? [path.join(root, 'supervisor/tidy-tabs.mjs'), '--cwd', f.lane, '--org', f.org, '--herdr', f.job.herdr]
      : [path.join(root, 'supervisor/retire.mjs'), mode, '--repo', f.lane, '--org', f.org, '--herdr', f.job.herdr];
    const r = spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout + r.stderr;
  };
  const held = run(); assertNoRemoval(f); assert.ok(held.includes(heldReason), held);
  if (mode !== 'plan') assert.match(held, /held/);
  if (mode === 'consume') assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  release(); const resumed = run();
  if (mode === 'plan') { assert.equal(JSON.parse(resumed).close.length, 1); assertNoRemoval(f); }
  else assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: drain catch-up acknowledges ready first and leaves the hint pending at both boundaries', async t => {
  const f = fixture(t); isolatedEnv(t, f); const queue = f.queue(), release = hold(f), outputs = [], messages = [];
  const send = process.send, write = process.stderr.write;
  process.send = m => { messages.push(m); return true; };
  process.stderr.write = function(chunk, ...args) { outputs.push({ text: String(chunk), ready: messages.some(m => m.ready) }); return write.call(this, chunk, ...args); };
  t.after(() => { process.send = send; process.stderr.write = write; });
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' }); await drain(queue);
  assertNoRemoval(f); assert.deepEqual(messages, [{ ready: true }]);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  const held = outputs.filter(row => row.text.includes('"action":"held"')); assert.ok(held.length >= 2, JSON.stringify(outputs));
  assert.ok(held.every(row => row.ready));
  release(); await drain(queue); assert.equal(JSON.parse(fs.readFileSync(path.join(f.org, 'retirement/handled.json'))).revision, 4);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('retirement hold: promotion cleanup never invokes git-only close and stays promoted until bounded retry', t => {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f); const queue = f.queue(), release = hold(f);
  const calls = path.join(f.scratch, 'lane-calls.jsonl'), wrapped = path.join(f.scratch, 'lane-wrapper.mjs');
  fs.writeFileSync(wrapped, `import fs from 'node:fs';import {spawnSync} from 'node:child_process';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');const r=spawnSync(process.execPath,[${JSON.stringify(laneCLI)},...a],{stdio:'inherit'});process.exit(r.status??1);`);
  const job = { ...f.job, laneCLI: wrapped };
  const result = finishCleanup(job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue, { now: 1000 });
  assertNoRemoval(f); assert.equal(fs.existsSync(calls), false); assert.equal(result.outcome, 'promoted');
  assert.equal(result.cleanup.state, 'pending'); assert.equal(result.cleanup.outcome, 'held'); assert.match(result.reason, /retirement held/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(queue.directory, 'job-cleanup.jsonl'), 'utf8').trim()).action, 'held');
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  queue.transaction(data => data.results.push({ ...job, ...result }));
  retryCleanup(queue, { now: result.cleanup.next_attempt_at }); assertNoRemoval(f); assert.equal(fs.existsSync(calls), false);
  release(); retryCleanup(queue, { now: queue.load().results[0].cleanup.next_attempt_at });
  assert.equal(queue.load().results[0].outcome, 'promoted'); assert.equal(queue.load().results[0].cleanup.state, 'complete');
  assert.equal(fs.existsSync(f.lane), false); assert.match(fs.readFileSync(calls, 'utf8'), /--git-only/);
});

for (const gitOnly of [false, true]) test(`retirement hold: lane close ${gitOnly ? 'git-only' : 'normal'} retains worktree and branch before lifecycle mutations`, t => {
  const f = fixture(t, { occupied: !gitOnly }), release = hold(f);
  const r = f.close(gitOnly); assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /retirement held/);
  assertNoRemoval(f); assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  release(); const resumed = f.close(gitOnly); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(fs.existsSync(f.lane), false); assert.ok(f.gitCalls().some(a => a.includes('worktree') && a.includes('remove')));
});

test('retirement hold: standalone settle-watch self-retirement preserves its tab and receipt', t => {
  const f = fixture(t), installed = path.join(f.scratch, 'standalone'); copyProduct(root, installed); fs.rmSync(path.join(installed, 'supervisor'), { recursive: true });
  f.state.watcherMode = true; f.state.workspaces.push({ workspace_id: 'main', worktree: { checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  f.state.tabs.push({ tab_id: 'main:watch', workspace_id: 'main' }); f.state.panes.push({ pane_id: 'main:watch:p', tab_id: 'main:watch', workspace_id: 'main' }); f.save();
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`, { mode: 0o755 });
  const config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'checklist'); fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const run = () => spawnSync(process.execPath, [path.join(installed, 'contrib/settle-watch.mjs'), 'R-1', '--close-tab-on-exit', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: { ...f.env, HERDR_TAB_ID: 'main:watch', HERDR_PANE_ID: 'main:watch:p' }, encoding: 'utf8' });
  const release = hold(f), r = run(); assert.equal(r.status, 0, r.stdout + r.stderr); assertNoRemoval(f); assert.match(r.stdout, /held/);
  assert.equal(fs.readdirSync(path.join(f.org, 'retirement/occupants')).length, 1);
  release(); const resumed = run(); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'main:watch']]);
});

test('retirement hold: settle-watch worker pruning keeps eligible workers then closes after release', t => {
  const f = fixture(t), config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'checklist'), count = path.join(f.scratch, 'org-count');
  fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const run = fold(loadEvents(f.org).events).runs.get('R-1');
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!${process.execPath}\nconst fs=require('node:fs'),file=${JSON.stringify(count)},n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(n+1));console.log(JSON.stringify(n?${JSON.stringify(run)}:${JSON.stringify({ ...run, report: null })}));\n`, { mode: 0o755 });
  const watch = () => spawnSync(process.execPath, [path.join(root, 'contrib/settle-watch.mjs'), 'R-1', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: f.env, encoding: 'utf8' });
  const release = hold(f), r = watch(); assert.equal(r.status, 0, r.stdout + r.stderr); assertNoRemoval(f); assert.match(r.stdout, /held/);
  release(); fs.unlinkSync(count); const resumed = watch(); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

for (const stage of ['pruneSessionTabs', 'closeWorkerTab']) test(`retirement hold: settle-watch ${stage} honors the brake during a real CLI handoff`, t => {
  const f = fixture(t), config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'checklist');
  fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const reported = fold(loadEvents(f.org).events).runs.get('R-1'), report = path.join(f.scratch, 'report.md'); fs.writeFileSync(report, 'legacy report');
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!${process.execPath}\nconst a=process.argv.slice(2);console.log(JSON.stringify(a[0]==='show'?${JSON.stringify({ ...reported, report: null, report_path: report })}:{}));\n`, { mode: 0o755 });
  const launcher = path.join(f.scratch, 'launcher'), memory = path.join(f.scratch, 'memory'), clock = path.join(f.scratch, 'no-delays.mjs');
  fs.writeFileSync(launcher, `#!/bin/sh\necho CLAUDE_CONFIG_DIR=${f.scratch}/fake-account\n`, { mode: 0o755 }); fs.writeFileSync(memory, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // Omit fixed UI launch sleeps in this fake-only CLI fixture.
  fs.writeFileSync(clock, 'Atomics.wait = () => "timed-out";\n');
  const reset = () => {
    f.state.sessionMode = true; f.state.tabs = [{ tab_id: 'w:t', workspace_id: 'w' }]; f.state.panes = [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w' }];
    f.state.agents[0].agent_status = stage === 'closeWorkerTab' ? 'working' : 'done'; f.save();
  };
  f.state.workspaces.push({ workspace_id: 'main', worktree: { checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  const watch = () => spawnSync(process.execPath, ['--import', clock, path.join(root, 'contrib/settle-watch.mjs'), 'R-1', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--launcher', launcher, '--cmem-domain', memory, '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: f.env, encoding: 'utf8' });
  reset(); const release = hold(f), held = watch(); assert.equal(held.status, 0, held.stdout + held.stderr); assertNoRemoval(f); assert.match(held.stdout, /"action":"held"/);
  release(); reset(); const resumed = watch(); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(f.read().actions.filter(a => a[1] === 'close'), [['tab', 'close', 'w:t']]);
});

test('lane close --git-only keeps the worktree beneath even an eligible pane', t => {
  const f = fixture(t); assert.equal(f.retirement().plan().close.length,1);
  const r = f.close(); assert.notEqual(r.status,0); assert.match(r.stderr,/occupied lane/);
  assert.equal(fs.existsSync(f.lane),true); assert.equal(f.git(['rev-parse','lane/topic']),f.head); assert.deepEqual(f.read().actions,[]);
});

test('lane close uses the executor then proves vacancy before Git and empty workspace close', t => {
  const f = fixture(t); const r = f.close(false); assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(fs.existsSync(f.lane),false); assert.deepEqual(f.read().actions,[['tab','close','w:t'],['workspace','close','w']]);
  assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('an empty unmerged lane retains its recoverable archive and immutable record', t => {
  const f = fixture(t,{merged:false,occupied:false}); const r = f.close(); assert.equal(r.status,0,r.stderr);
  assert.equal(f.git(['rev-parse','archive/lane/topic']),f.head); assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('promotion keeps integrated success on a live reference and retries cleanup only after it disappears', t => {
  const f = fixture(t), queue = f.queue(), ref = path.join(f.org,'references/host.json');
  fs.writeFileSync(ref,JSON.stringify({schema:'herdr-reference/v1',owner:'tool',kind:'host-job',job:'pending',state:'pending',item:'ENG-1',created_at:'2026-01-01T00:00:00Z',expires_at:'2999-01-01T00:00:00Z'}));
  const result = finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},queue);
  assert.equal(result.outcome,'promoted'); assert.equal(result.cleanup.state,'pending'); assert.match(result.reason,/integrated-but-cleanup-pending.*host-job/);
  assert.equal(fs.existsSync(f.lane),true); assert.deepEqual(f.read().actions,[]);
  queue.transaction(data => data.results.push({...f.job,...result})); fs.unlinkSync(ref);
  requestRetirement({ org:f.org, key:'host completed', source:'host completion' });
  // Product helpers inherit the fixture's source declarations, never the live host slot.
  const old = {};
  for(const key of ['MONITOR_TEST_SLOT_PATH','MONITOR_TEST_SLOT_COMPAT_PATH','XDG_STATE_HOME']) {old[key]=process.env[key];process.env[key]=f.env[key];}
  t.after(()=>{for(const [key,value] of Object.entries(old)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state,'complete'); assert.equal(fs.existsSync(f.lane),false);
  const actions = f.read().actions; retryCleanup(queue); assert.deepEqual(f.read().actions,actions);
  assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('a tab-close failure stays cleanup-pending and never turns promotion into a gate failure', t => {
  const f = fixture(t); f.state.failClose=true;f.save();
  const result=finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},f.queue());
  assert.equal(result.outcome,'promoted');assert.equal(result.cleanup.state,'pending');assert.match(result.reason,/injected tab failure/);assert.equal(fs.existsSync(f.lane),true);
});

test('record handoff is confirmed, idempotent, ignored by older fold, and never rewrites reports', t => {
  const f=fixture(t), events=loadEvents(f.org).events;
  events.push({type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane,seq:5,at:'2026-01-01T01:00:00Z',meta:{...events[1].meta,agent:'successor',pane:'w:q',terminal_id:'new-terminal',agent_session_id:'new-session'}});
  fs.writeFileSync(f.eventFile,events.map(e=>JSON.stringify(e)+'\n').join(''));
  const run=args=>spawnSync(process.execPath,[recordCLI,'handoff','R-1','--to','R-2','--why','retained successor',...args],{cwd:f.repo,env:f.env,encoding:'utf8'});
  assert.notEqual(run([]).status,0); const accepted=run(['--confirm']);assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).recorded,true);assert.equal(JSON.parse(run(['--confirm']).stdout).recorded,false);
  const loaded=loadEvents(f.org).events;assert.equal(loaded.filter(e=>e.type==='retirement.handoff').length,1);
  assert.deepEqual(fold(loaded).runs.get('R-1').report,fold(events).runs.get('R-1').report);
  assert.deepEqual(Object.keys(fold(loaded)),Object.keys(fold(events)));
  const request=JSON.parse(fs.readFileSync(path.join(f.org,'retirement/request.json')));assert.equal(request.source,'record handoff');
});

const releaseArgs = f => ['release', 'R-1', '--session', 'session', '--terminal', 'term', '--pane', 'w:p', '--head', f.head,
  '--authority', 'owner ruling', '--next', 'reviewer after correction', '--unresolved', 'review and integration',
  '--evidence', '/evidence/report.md', '--evidence', '/evidence/review.md', '--confirm', '--why', 'idle context recorded'];
const recordRelease = (f, args = releaseArgs(f)) => spawnSync(process.execPath, [recordCLI, ...args], { cwd: f.repo, env: f.env, encoding: 'utf8' });
const writeEvents = (f, events) => fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));

test('record release atomically records continuation, is idempotent, refuses conflicts and never rewrites reports', t => {
  const f = fixture(t), before = fs.readFileSync(f.eventFile, 'utf8'), oldReport = fold(loadEvents(f.org).events).runs.get('R-1').report;
  const reportFile = path.join(f.org, 'reports/R-1.md'); fs.mkdirSync(path.dirname(reportFile)); fs.writeFileSync(reportFile, 'immutable report bytes');
  const accepted = recordRelease(f); assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { run: 'R-1', recorded: true });
  const loaded = loadEvents(f.org).events, [note, release] = loaded.slice(-2);
  assert.equal(note.type, 'note.added'); assert.equal(note.id, 'ENG-1'); assert.equal(note.kind, 'release'); assert.equal(note.decision, true);
  for (const value of ['R-1', 'session', 'term', 'w:p', f.head, '/evidence/report.md', '/evidence/review.md', 'reviewer after correction',
    'review and integration', 'owner ruling', 'idle context recorded']) assert.ok(note.text.includes(value), value);
  assert.deepEqual(Object.fromEntries(Object.keys(release).filter(key => !['seq', 'at', 'by', 'unattributed'].includes(key)).map(key => [key, release[key]])),
    { type: 'retirement.release', run: 'R-1', item: 'ENG-1', pane: 'w:p', terminal: 'term', session: 'session', workspace: 'w',
      cwd: f.lane, head: f.head, authority: 'owner ruling', confirmed: true, why: 'idle context recorded' });
  const bytes = fs.readFileSync(f.eventFile, 'utf8'); assert.ok(bytes.startsWith(before));
  const requestFile = path.join(f.org, 'retirement/request.json'), requestBytes = fs.readFileSync(requestFile, 'utf8');
  assert.equal(JSON.parse(requestBytes).source, 'record release'); assert.equal(JSON.parse(requestBytes).event_seq, release.seq);
  assert.deepEqual(JSON.parse(recordRelease(f).stdout), { run: 'R-1', recorded: false });
  for (const flag of ['--head', '--authority', '--why', '--next', '--unresolved', '--evidence']) {
    const args = releaseArgs(f); args[args.indexOf(flag) + 1] = flag === '--head' ? 'b'.repeat(40) : 'different';
    const result = recordRelease(f, args); assert.equal(result.status, 1); assert.match(result.stderr, /different release/);
  }
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes); assert.equal(fs.readFileSync(requestFile, 'utf8'), requestBytes);
  assert.deepEqual(fold(loadEvents(f.org).events).runs.get('R-1').report, oldReport);
  assert.equal(fs.readFileSync(reportFile, 'utf8'), 'immutable report bytes'); assert.deepEqual(f.read().actions, []);
});

test('record release refuses incomplete or mismatched confirmation without appending either event', t => {
  const f = fixture(t), before = fs.readFileSync(f.eventFile, 'utf8');
  for (const flag of ['--session', '--terminal', '--pane', '--head', '--authority', '--next', '--unresolved', '--evidence', '--why', '--confirm']) {
    const args = releaseArgs(f), at = args.indexOf(flag);
    if (flag === '--confirm') args.splice(at, 1);
    else args[at + 1] = ['--session', '--terminal', '--pane'].includes(flag) ? 'wrong' : '   ';
    const result = recordRelease(f, args); assert.equal(result.status, 1, flag + result.stderr);
    assert.equal(fs.readFileSync(f.eventFile, 'utf8'), before);
  }
  const args = releaseArgs(f).filter((value, i, all) => value !== '--evidence' && all[i - 1] !== '--evidence');
  assert.equal(recordRelease(f, args).status, 1);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/request.json')), false);
});

test('record release requires an existing non-abandoned ingested run and complete launch receipt', t => {
  const f = fixture(t), original = loadEvents(f.org).events;
  for (const variant of ['unknown', 'abandoned', 'report-file-only', 'session', 'terminal', 'pane', 'workspace', 'worker_workspace']) {
    const events = structuredClone(original), args = releaseArgs(f);
    if (variant === 'unknown') args[1] = 'R-99';
    if (variant === 'abandoned') events.push({ type: 'run.abandoned', id: 'R-1', seq: 5 });
    if (variant === 'report-file-only') { events.splice(2, 1); events[1].report_path = '/exists/report.md'; }
    if (variant === 'workspace') delete events[1].workspace;
    if (['session', 'terminal', 'pane', 'worker_workspace'].includes(variant)) delete events[1].meta[{ session: 'agent_session_id', terminal: 'terminal_id' }[variant] ?? variant];
    writeEvents(f, events); const bytes = fs.readFileSync(f.eventFile, 'utf8');
    const result = recordRelease(f, args); assert.equal(result.status, 1, variant + result.stderr);
    assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes);
  }
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/request.json')), false);
});

for (const binding of ['pane', 'agent_session_id']) test(`record release refuses newer ${binding} continuation before and after recording`, t => {
  const f = fixture(t), events = loadEvents(f.org).events;
  const newer = { type: 'run.started', id: 'R-2256', item: 'ENG-1', workspace: f.lane, seq: 5,
    meta: { ...events[1].meta, agent: 'continuation', pane: 'w:q', agent_session_id: 'new-session', [binding]: events[1].meta[binding] } };
  writeEvents(f, [...events, newer]); const bytes = fs.readFileSync(f.eventFile, 'utf8');
  const refused = recordRelease(f); assert.equal(refused.status, 1); assert.match(refused.stderr, /newer run uses the same pane or native session/);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes);
  writeEvents(f, events); const accepted = recordRelease(f); assert.equal(accepted.status, 0, accepted.stderr);
  fs.appendFileSync(f.eventFile, JSON.stringify({ ...newer, seq: 7 }) + '\n');
  assert.equal(recordRelease(f).status, 1);
  assert.equal(f.retirement().plan().close.length, 0);
});

test('record release closes only the fixture tab and preserves the open lane, worktree, branch, workspace and files', t => {
  const f = fixture(t, { merged: false }); writeEvents(f, loadEvents(f.org).events.filter(e => e.type !== 'item.closed'));
  fs.writeFileSync(path.join(f.lane, 'uncommitted'), 'keep these bytes'); f.traceGit();
  const retirement = f.retirement(); assert.match(retirement.plan().keep[0].why, /chain is still open/);
  const accepted = recordRelease(f); assert.equal(accepted.status, 0, accepted.stderr);
  const plan = retirement.plan(); assert.equal(plan.close.length, 1); assert.match(plan.close[0].why, /record release for R-1/);
  const unhold = hold(f); assert.equal(retirement.apply(plan)[0].action, 'held'); assertNoRemoval(f); unhold();
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]); assert.equal(f.read().workspaces.length, 1);
  assert.equal(fs.readFileSync(path.join(f.lane, 'uncommitted'), 'utf8'), 'keep these bytes');
  assert.equal(f.git(['rev-parse', 'HEAD'], f.lane), f.head); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(f.git(['worktree', 'list', '--porcelain']).includes(f.lane));
  assert.throws(() => retirement.closeEmptyWorkspace('w', f.lane), /worktree removal is not confirmed/);
  assert.throws(() => retirement.assertVacant(f.lane), /chain is still open/);
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head }), /lane worktree is not clean/);
  assert.deepEqual(f.gitCalls().filter(args => args.includes('worktree') && args.includes('remove')), []);
});

test('Git-only lane without a workspace still keeps queued lane and run references', t => {
  const f=fixture(t,{occupied:false});f.state.workspaces=[];f.save();
  const queue=f.queue();queue.transaction(data=>data.pending.push({...f.job}));
  const r=f.close();assert.notEqual(r.status,0);assert.match(r.stderr,/promote reference/);assert.equal(fs.existsSync(f.lane),true);
});
test('installed distribution ships the adoption CLI and compatibility surfaces with no dependencies', t => {
  const f=fixture(t),installed=path.join(f.scratch,'installed');copyProduct(root,installed);
  for(const file of ['supervisor/retire.mjs','contrib/settle-watch.mjs','lib/cli-help.mjs','lib/state.mjs']) assert.ok(fs.existsSync(path.join(installed,file)));
  const r=spawnSync(process.execPath,[path.join(installed,'supervisor/retire.mjs'),'plan','--repo',f.repo,'--org',f.org,'--herdr',f.job.herdr],{env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).close.length,1);assert.deepEqual(f.read().actions,[]);
});

test('installed settle-watch flags keep an ingested worker while its chain is open', t => {
  const f=fixture(t);const events=loadEvents(f.org).events.filter(e=>e.type!=='item.closed');
  fs.writeFileSync(f.eventFile,events.map(e=>JSON.stringify(e)+'\n').join(''));
  fs.writeFileSync(path.join(f.scratch,'org'),`#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`,{mode:0o755});
  const config=path.join(f.scratch,'lane.json'),checklist=path.join(f.scratch,'CHECKLIST.md');fs.writeFileSync(config,'{}');fs.writeFileSync(checklist,'fixture');
  const r=spawnSync(process.execPath,[path.join(root,'contrib/settle-watch.mjs'),'R-1','--org',f.org,'--cwd',f.repo,
    '--lane-config',config,'--checklist',checklist,'--model','opaque-model','--effort','opaque-effort','--close-tab-on-exit'],{env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(f.retirement().plan().keep[0].why,/chain is still open/);assert.deepEqual(f.read().actions,[]);
});

test('a disposition trigger gets a fresh foreground plan once, and the repeated hint is a no-op', t => {
  const f=fixture(t), events=loadEvents(f.org).events.filter(e=>e.type!=='item.closed');
  fs.writeFileSync(f.eventFile,events.map(e=>JSON.stringify(e)+'\n').join(''));
  assert.equal(f.retirement().plan().close.length,0);
  const r=spawnSync(process.execPath,[recordCLI,'close','ENG-1'],{cwd:f.repo,env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const hint=JSON.parse(fs.readFileSync(path.join(f.org,'retirement/request.json')));
  assert.equal(hint.event_seq,loadEvents(f.org).events.at(-1).seq);
  let observations=0;
  const consume=()=>consumeRetirement({org:f.org,retirement:()=>{observations++;return f.retirement();}});
  assert.equal(consume().handled,true);assert.deepEqual(f.read().actions,[['tab','close','w:t']]);
  requestRetirement({org:f.org,eventSeq:hint.event_seq,source:'repeated disposition'});
  assert.equal(consume().handled,false);assert.equal(observations,1);
  // Hint writing needs no log read; the event owner supplied the sequence.
  fs.writeFileSync(f.eventFile,'invalid event log');
  requestRetirement({org:f.org,eventSeq:hint.event_seq+1,source:'known appended sequence'});
});

test('the consume CLI reaches its own deadline cleanly, retaining the hint and releasing its lock', t => {
  const f = fixture(t); f.state.delayWorkspace = 1000; f.save();
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' });
  const r = spawnSync(process.execPath, [path.join(root, 'supervisor/retire.mjs'), 'consume', '--repo', f.repo, '--org', f.org,
    '--herdr', f.job.herdr, '--budget-ms', '100'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout);
  assert.equal(result.pending, true); assert.equal(result.handled, false);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/consume.lock')), false);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
  assert.deepEqual(f.read().actions, []);
});

test('promote drain consumes requests at both foreground boundaries without running a gate', async t => {
  const f=fixture(t);f.state.triggerOnClose=true;f.save();const queue=f.queue();
  const old={};for(const key of ['ORG_DIR','HERDR_MONITOR_FLEET','HERDR_RETIRE_HERDR','MONITOR_TEST_SLOT_PATH','MONITOR_TEST_SLOT_COMPAT_PATH','XDG_STATE_HOME']){old[key]=process.env[key];process.env[key]=f.env[key];}
  t.after(()=>{for(const[key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  requestRetirement({org:f.org,eventSeq:4,source:'disposition'});await drain(queue);
  const handled=JSON.parse(fs.readFileSync(path.join(f.org,'retirement/handled.json')));
  assert.equal(handled.revision,5);assert.deepEqual(f.read().actions,[['tab','close','w:t']]);assert.deepEqual(queue.load().results,[]);
});

test('promote sends its ready acknowledgment before observing a pending retirement hint', async t => {
  const f = fixture(t), queue = f.queue(), marker = path.join(f.scratch, 'ready');
  f.state.readyMarker = marker; f.save();
  const old = {};
  for (const key of ['ORG_DIR', 'HERDR_MONITOR_FLEET', 'HERDR_RETIRE_HERDR', 'MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'XDG_STATE_HOME']) { old[key] = process.env[key]; process.env[key] = f.env[key]; }
  const send = process.send, write = process.stderr.write, messages = [], earlyErrors = [];
  let ready = false;
  process.send = message => { messages.push(message); if (message.ready) { ready = true; fs.writeFileSync(marker, 'acknowledged'); } return true; };
  process.stderr.write = function(chunk, ...args) { if (!ready && String(chunk).includes('retirement catch-up')) earlyErrors.push(String(chunk)); return write.call(this, chunk, ...args); };
  t.after(() => { process.send = send; process.stderr.write = write; for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' });
  await drain(queue);
  assert.equal(f.read().preReadyObservation ?? false, false, 'retirement observed before ready');
  assert.deepEqual(earlyErrors, [], 'retirement catch-up error preceded ready');
  assert.deepEqual(messages, [{ ready: true }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.org, 'retirement/handled.json'))).revision, 4);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
});

test('a dequeued job is persisted before retirement catch-up and is never left current during it', async t => {
  let inbox;
  t.after(async () => { if (inbox) await stopFixtureInbox(inbox, { script: path.join(root, 'supervisor/prompt-supervisor.mjs') }); });
  const f = fixture(t), queue = f.queue(), fakeLane = path.join(f.scratch, 'refused-lane.mjs');
  inbox = path.join(f.org, 'supervisor/inbox.log');
  fs.writeFileSync(fakeLane, "console.error('lane: fixture refusal');process.exit(1);\n");
  // A refused legacy job avoids per-job cleanup, so workspace reads identify
  // foreground catch-up rather than an integration or its scoped cleanup.
  queue.transaction(data => data.pending.push({ ...f.job, laneCLI: fakeLane, to: 'fixture', attempts: 1, retry: 0 }));
  f.state.currentQueue = queue.file; f.save();
  const old = {};
  for (const key of ['ORG_DIR', 'HERDR_MONITOR_FLEET', 'HERDR_RETIRE_HERDR', 'MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'XDG_STATE_HOME']) { old[key] = process.env[key]; process.env[key] = f.env[key]; }
  const send = process.send, messages = [];
  process.send = message => { messages.push(message); return true; };
  t.after(() => { process.send = send; for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' }); await drain(queue);
  assert.deepEqual(messages, [{ ready: true }]);
  assert.equal(f.read().observedCurrent ?? false, false, 'catch-up observed the dequeued job as current');
  assert.equal(f.read().catchupCurrent, null); assert.equal(f.read().catchupPersisted, 1);
  assert.equal(queue.load().results[0].outcome, 'refused');
});

test('the final re-observation crossing a deadline inside a callback owner lookup leaves its hint pending', t => {
  const f = fixture(t); f.retirement().recordCallback({ kind: 'executive', pane: 'w:p', pid: 2, agent: 'worker' });
  f.state.agents = []; f.state.info = { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true,
    process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' }] }; f.save();
  requestRetirement({ org: f.org, eventSeq: 4, source: 'completion' });
  const now = Date.now, deadline = now() + 60000; let reads = 0;
  try {
    const result = consumeRetirement({ org: f.org, deadline, retirement: () => createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, deadline,
      readOwner: () => { if (++reads === 3) { Date.now = () => deadline; throw retirementDeadline(); } return false; } }) });
    assert.equal(reads, 3); assert.equal(result.pending, true); assert.equal(result.handled, false);
    assert.equal(result.results.at(-1).action, 'deferred');
    assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
    assert.equal(fs.existsSync(path.join(f.org, 'retirement/consume.lock')), false); assert.deepEqual(f.read().actions, []);
  } finally { Date.now = now; }
});

test('cleanup retries are capped with backoff, record the refusal, and reset on a new request', t => {
  const f=fixture(t), queue=f.queue(); f.state.failClose=true;f.save();
  const old={};for(const key of ['MONITOR_TEST_SLOT_PATH','MONITOR_TEST_SLOT_COMPAT_PATH','XDG_STATE_HOME']){old[key]=process.env[key];process.env[key]=f.env[key];}
  t.after(()=>{for(const[key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const result=finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},queue,{now:1000});
  assert.match(result.cleanup.last_refusal,/injected tab failure/);queue.transaction(data=>data.results.push({...f.job,...result}));
  retryCleanup(queue,{now:1001});assert.equal(queue.load().results[0].cleanup.attempts,1);
  for(let attempt=2;attempt<=5;attempt++) {retryCleanup(queue,{now:queue.load().results[0].cleanup.next_attempt_at});assert.equal(queue.load().results[0].cleanup.attempts,attempt);}
  const capped=queue.load().results[0];retryCleanup(queue,{now:1e12});assert.deepEqual(queue.load().results[0],capped);
  requestRetirement({org:f.org,key:'new completion',source:'completion'});retryCleanup(queue,{now:1e12});
  assert.equal(queue.load().results[0].cleanup.attempts,1);assert.equal(queue.load().results[0].outcome,'promoted');
});

test('lane close permits an absent Herdr executable and refuses an unreadable installed server', t => {
  const f=fixture(t,{occupied:false});
  fs.writeFileSync(f.job.herdr,'#!/bin/sh\necho unreadable-server >&2\nexit 1\n',{mode:0o755});
  const unavailable=f.close();assert.notEqual(unavailable.status,0);assert.match(unavailable.stderr,/unreadable-server/);
  assert.equal(fs.existsSync(f.lane),true);
  fs.unlinkSync(f.job.herdr); const absent=f.close();assert.equal(absent.status,0,absent.stderr);assert.equal(fs.existsSync(f.lane),false);
});

for(const kind of ['watcher','settle','executive','plan']) test(`tidy-tabs prunes an exited recorded ${kind} callback through the shared guard`,t=>{
  const f=fixture(t), retirement=f.retirement();
  retirement.recordCallback({kind,pane:'w:p',pid:2,...(['watcher','settle'].includes(kind)?{run:'R-1'}:{}),agent:'worker'});
  f.state.agents=[];f.state.info={shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}],process_tree_complete:true,process_tree:[{pid:1,identity:'shell',state:'S',command:'[zsh]'}]};f.save();
  const cli=()=>spawnSync(process.execPath,[path.join(root,'supervisor/tidy-tabs.mjs'),'--cwd',f.repo,'--org',f.org,'--herdr',f.job.herdr,'--org-cli',process.execPath,'--org-cli-arg',recordCLI],{env:f.env,encoding:'utf8'});
  // A replacement shell never inherits the departed callback's authority.
  f.state.info.process_tree[0].identity='replacement';f.save();const kept=cli();assert.equal(kept.status,0,kept.stderr);assert.deepEqual(f.read().actions,[]);
  f.state.info.process_tree[0].identity='shell';f.save();const released=cli();assert.equal(released.status,0,released.stderr);
  assert.deepEqual(f.read().actions,[['tab','close','w:t']]);
  assert.deepEqual(fs.readdirSync(path.join(f.org, 'retirement/occupants')), []);
});

test('apply prunes an absent callback receipt without reading its owner; scoped reads retain other workspaces', t => {
  const f = fixture(t);
  f.retirement().recordCallback({ kind: 'watcher', pane: 'w:p', pid: 2, run: 'R-1' });
  const directory = path.join(f.org, 'retirement/occupants');
  f.state.tabs = []; f.state.panes = []; f.state.agents = []; f.save();
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, readOwner: () => assert.fail('absent receipt owner was inspected') });
  const scoped = retirement.plan(f.repo); retirement.apply(scoped, f.repo);
  assert.equal(fs.readdirSync(directory).length, 1, 'a scoped observation cannot prune another workspace');
  const preview = retirement.plan(); assert.equal(fs.readdirSync(directory).length, 1, 'preview remains read-only');
  retirement.apply(preview); assert.deepEqual(fs.readdirSync(directory), []);
});

test('a concurrently pruned absent receipt does not abort remaining tab closes', t => {
  const f = fixture(t); f.retirement().recordCallback({ kind: 'watcher', pane: 'w:p', pid: 2, run: 'R-1' });
  const directory = path.join(f.org, 'retirement/occupants'), file = path.join(directory, fs.readdirSync(directory)[0]);
  const receipt = JSON.parse(fs.readFileSync(file)); receipt.tab = 'already-gone'; fs.writeFileSync(file, JSON.stringify(receipt));
  const retirement = f.retirement(), plan = retirement.plan(), unlink = fs.unlinkSync;
  let raced = false;
  fs.unlinkSync = function(target) { if (target === file && !raced) { raced = true; unlink(target); return unlink(target); } return unlink(target); };
  try {
    const results = retirement.apply(plan); assert.equal(raced, true); assert.equal(results[0].action, 'closed');
    assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
  } finally { fs.unlinkSync = unlink; }
});

for (const code of ['ENOENT', 'EACCES']) test(`post-close receipt pruning ${code} preserves the successful close result`, t => {
  const f = fixture(t); f.retirement().recordCallback({ kind: 'executive', pane: 'w:p', pid: 2, agent: 'worker' });
  f.state.agents = []; f.state.info = { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true,
    process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' }] }; f.save();
  const directory = path.join(f.org, 'retirement/occupants'), file = path.join(directory, fs.readdirSync(directory)[0]), logs = [];
  const retirement = createRetirement({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, readOwner: () => false, log: row => logs.push(row) });
  const plan = retirement.plan(), unlink = fs.unlinkSync;
  fs.unlinkSync = function(target) { if (target === file) { if (code === 'ENOENT') { unlink(target); return unlink(target); } throw Object.assign(Error('injected receipt pruning error'), { code }); } return unlink(target); };
  try {
    const results = retirement.apply(plan); assert.equal(results[0].action, 'closed');
    assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
    assert.equal(logs.some(row => row.action === 'close-failed'), false);
    assert.equal(logs.some(row => row.action === 'receipt-pruning-diagnostic'), code === 'EACCES');
  } finally { fs.unlinkSync = unlink; }
});

test('settle-watch --spawn keeps its flags and narrowly retires its own tab after ingestion',t=>{
  const f=fixture(t);f.state.watcherMode=true;
  f.state.workspaces.push({workspace_id:'main',worktree:{checkout_path:f.repo,repo_key:f.common,repo_root:f.repo,is_linked_worktree:false}});f.save();
  fs.writeFileSync(path.join(f.scratch,'org'),`#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`,{mode:0o755});
  const config=path.join(f.scratch,'lane.json'),checklist=path.join(f.scratch,'CHECKLIST.md');fs.writeFileSync(config,'{}');fs.writeFileSync(checklist,'fixture');
  const r=spawnSync(process.execPath,[path.join(root,'contrib/settle-watch.mjs'),'R-1','--spawn','--org',f.org,'--cwd',f.repo,
    '--lane-config',config,'--checklist',checklist,'--model','opaque-model','--effort','opaque-effort'],{env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stdout+r.stderr);const state=f.read();assert.ok(state.actions.some(a=>a[0]==='tab'&&a[1]==='create'));
  assert.deepEqual(state.actions.filter(a=>a[1]==='close'),[['tab','close','main:watch']]);
  assert.ok(state.tabs.some(t=>t.tab_id==='w:t'));assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
});

test('a foreground watcher without close-tab-on-exit never adopts an ordinary operator tab', t => {
  const f = fixture(t); f.state.watcherMode = true;
  f.state.workspaces.push({ workspace_id: 'main', worktree: { checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  f.state.tabs.push({ tab_id: 'main:watch', workspace_id: 'main' });
  f.state.panes.push({ pane_id: 'main:watch:p', tab_id: 'main:watch', workspace_id: 'main' }); f.save();
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${recordCLI}' "$@"\n`, { mode: 0o755 });
  const config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'CHECKLIST.md'); fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const r = spawnSync(process.execPath, [path.join(root, 'contrib/settle-watch.mjs'), 'R-1', '--org', f.org, '--cwd', f.repo,
    '--lane-config', config, '--checklist', checklist, '--model', 'opaque-model', '--effort', 'opaque-effort'], {
    env: { ...f.env, HERDR_TAB_ID: 'main:watch', HERDR_PANE_ID: 'main:watch:p' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/occupants')), false);
  const plan = f.retirement().plan(); assert.ok(plan.keep.some(tab => tab.tab_id === 'main:watch'));
  f.retirement().apply({ ...plan, close: [] }); assert.ok(f.read().tabs.some(tab => tab.tab_id === 'main:watch')); assert.deepEqual(f.read().actions, []);
});

test('standalone contrib retires only its owned watcher with no supervisor directory', t => {
  const f = fixture(t), installed = path.join(f.scratch, 'standalone');
  copyProduct(root, installed);
  fs.rmSync(path.join(installed, 'supervisor'), { recursive: true });
  f.state.watcherMode = true;
  f.state.workspaces.push({ workspace_id: 'main', worktree: {
    checkout_path: f.repo, repo_key: f.common, repo_root: f.repo, is_linked_worktree: false } });
  f.save();
  fs.writeFileSync(path.join(f.scratch, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(installed, 'bin/org.mjs')}' "$@"\n`, { mode: 0o755 });
  const config = path.join(f.scratch, 'lane.json'), checklist = path.join(f.scratch, 'CHECKLIST.md');
  fs.writeFileSync(config, '{}'); fs.writeFileSync(checklist, 'fixture');
  const result = spawnSync(process.execPath, [path.join(installed, 'contrib/settle-watch.mjs'), 'R-1', '--spawn',
    '--org', f.org, '--cwd', f.repo, '--lane-config', config, '--checklist', checklist,
    '--model', 'opaque-model', '--effort', 'opaque-effort'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = f.read();
  assert.ok(state.actions.some(action => action[0] === 'tab' && action[1] === 'create'));
  assert.deepEqual(state.actions.filter(action => action[1] === 'close'), [['tab', 'close', 'main:watch']]);
  assert.ok(state.tabs.some(tab => tab.tab_id === 'w:t'));
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});

for (const keep of [true, false]) test(`composed promotion then native completion reconcile then cleanup: ${keep ? 'KEEP protects lane and evidence' : 'release closes workspace after verified preservation'}`, t => {
  const f = fixture(t, { merged: false }); isolatedEnv(t, f);
  // Native completion discovers this disposable project's record itself.
  fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.org\n.lane/\n');
  const events = loadEvents(f.org).events.filter(e => e.type !== 'item.closed');
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  fs.mkdirSync(path.join(f.lane, '.lane')); const scratch = path.join(f.lane, '.lane/review-and-scratch');
  const bytes = Buffer.from('unique review, report and scratch evidence\n'); fs.writeFileSync(scratch, bytes);
  const manifest = path.join(f.scratch, 'manifest.json'), prepared = path.join(f.scratch, 'prepared.json'), gate = path.join(f.scratch, 'gate.log');
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'composed', candidate: f.head,
    items: [{ item: 'ENG-1', run: 'R-1', head: f.head, superseded: [], why: 'Disposable fixture independent acceptance' }], excluded: [] }));
  const config = path.join(f.scratch, 'lane.json'); fs.writeFileSync(config, JSON.stringify({ main: 'main', validate: 'true' }));
  f.env.LANE_CONFIG = config;
  const run = args => {
    const r = spawnSync(process.execPath, args, { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr); return r;
  };
  const completion = [path.join(root, 'supervisor/reconcile.mjs')];
  const options = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
  run([...completion, 'prepare', ...options, '--manifest', manifest, '--gate-log', gate]);
  const promoted = run([laneCLI, 'promote', 'topic']); fs.writeFileSync(gate, promoted.stdout + promoted.stderr);
  assert.equal(f.git(['rev-parse', 'main']), f.head);
  assert.equal(Boolean(fold(loadEvents(f.org).events).items.get('ENG-1').closed), false);
  const reconciled = run([...completion, 'finish', ...options, '--gate-exit', '0', '--tip', f.head]);
  assert.equal(JSON.parse(reconciled.stdout).result, 'reconciled');
  assert.ok(fold(loadEvents(f.org).events).items.get('ENG-1').closed);
  if (keep) {
    // The default shell pane is an occupant even after the native worker's
    // report and chain become terminal. No callback receipt releases it.
    f.state.tabs.push({ tab_id: 'w:shell', workspace_id: 'w' });
    f.state.panes.push({ pane_id: 'w:shell:p', tab_id: 'w:shell', workspace_id: 'w' }); f.save();
  }
  const queue = f.queue(), job = { ...f.job, laneConfig: config };
  const result = finishCleanup(job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue);
  assert.equal(result.outcome, 'promoted');
  const receipt = fs.readFileSync(path.join(queue.directory, 'job-cleanup.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (keep) {
    assert.equal(result.cleanup.state, 'pending'); assert.match(result.reason, /unknown occupant|shell/);
    assert.deepEqual(fs.readFileSync(scratch), bytes); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.ok(f.read().workspaces.some(w => w.workspace_id === 'w'));
    assert.ok(receipt.some(r => r.action === 'keep' && r.tab_id === 'w:shell'));
    assert.equal(receipt.some(r => r.action === 'lane-removed'), false);
  } else {
    assert.equal(result.cleanup.state, 'complete', result.reason); assert.equal(fs.existsSync(f.lane), false);
    assert.equal(f.git(['branch', '--list', 'lane/topic']), ''); assert.equal(f.read().workspaces.length, 0);
    const proof = receipt.find(r => r.action === 'lane-preflight'); assert.ok(proof?.evidence?.sha256);
    assert.deepEqual(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/review-and-scratch')), bytes);
    const manifestBytes = fs.readFileSync(proof.evidence.manifest);
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), proof.evidence.sha256);
    assert.ok(receipt.findIndex(r => r.action === 'lane-preflight') < receipt.findIndex(r => r.action === 'lane-removed'));
    assert.ok(f.read().actions.some(a => a[0] === 'workspace' && a[1] === 'close'));
  }
});


test('workspace close failure retries only the empty workspace after Git removal', t => {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f);
  f.state.failWorkspace = true; f.save();
  const queue = f.queue(), result = finishCleanup(f.job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue);
  assert.equal(result.outcome, 'promoted'); assert.equal(result.cleanup.state, 'pending');
  assert.match(result.reason, /workspace.*failure/); assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), ''); assert.equal(f.read().workspaces.length, 1);
  const state = f.read(); state.failWorkspace = false; fs.writeFileSync(f.file, JSON.stringify(state));
  const retried = finishCleanup(f.job, result, queue);
  assert.equal(retried.cleanup.state, 'complete', retried.reason); assert.equal(f.read().workspaces.length, 0);
  assert.equal(retried.reason, 'green fast-forward; cleanup complete'); assert.deepEqual(retried.warnings, []);
});


test('an occupied workspace retry retains its reason in the cleanup receipt after the lane is gone', t => {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f);
  const queue = f.queue(), result = finishCleanup(f.job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue);
  assert.equal(result.cleanup.state, 'complete', result.reason);
  f.state.tabs = [{ tab_id: 'w:shell', workspace_id: 'w' }];
  f.state.panes = [{ pane_id: 'w:shell:p', tab_id: 'w:shell', workspace_id: 'w' }]; f.save();
  const retried = finishCleanup(f.job, { ...result, cleanup: { state: 'pending' } }, queue);
  assert.equal(retried.outcome, 'promoted'); assert.equal(retried.cleanup.state, 'pending');
  assert.match(retried.reason, /occupied lane/); assert.equal(f.read().workspaces.length, 1);
  const receipt = fs.readFileSync(path.join(queue.directory, 'job-cleanup.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(receipt.some(r => r.action === 'keep' && r.workspace_id === 'w' && /occupied lane/.test(r.why)));
});

for (const gitOnly of [true, false]) test(`a planner KEEP refuses ${gitOnly ? 'git-only' : 'normal'} unmerged close before any evidence copy or tag`, t => {
  const f = fixture(t, { merged: false });
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane')); fs.writeFileSync(path.join(f.lane, '.lane/scratch'), 'unique scratch');
  f.state.agents[0].agent_status = 'working'; f.save();
  const refs = f.git(['for-each-ref', '--format=%(refname) %(objectname)']);
  const result = f.close(gitOnly); assert.notEqual(result.status, 0); assert.match(result.stderr, /occupant worker is working/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  assert.equal(f.git(['for-each-ref', '--format=%(refname) %(objectname)']), refs);
  assert.equal(fs.readFileSync(path.join(f.lane, '.lane/scratch'), 'utf8'), 'unique scratch'); assertNoRemoval(f);
});
