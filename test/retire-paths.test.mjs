import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRetirement } from '../supervisor/retire.mjs';
import { queueFor, finishCleanup, retryCleanup } from '../promote/promote.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { copyProduct } from '../lib/product-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const laneCLI = path.join(root, 'lanes/lane.mjs'), recordCLI = path.join(root, 'bin/org.mjs');
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
    tabs: occupied ? [{ tab_id: 'w:t' }] : [], panes: occupied ? [{ pane_id: 'w:p', tab_id: 'w:t' }] : [],
    agents: occupied ? [{ name: 'worker', agent: 'native', agent_status: 'done', pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w',
      cwd: lane, terminal_id: 'term', agent_session: { value: 'session' }, state_change_seq: 5 }] : [], actions: [] };
  const file = path.join(scratch, 'state.json'), herdr = path.join(scratch, 'herdr');
  const save = () => fs.writeFileSync(file, JSON.stringify(state)); save();
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs = require('node:fs'), file = ${JSON.stringify(file)}, s = JSON.parse(fs.readFileSync(file)), a = process.argv.slice(2);
const out = result => console.log(JSON.stringify({ result }));
if (a[0] === 'workspace' && a[1] === 'list') out({workspaces:s.workspaces});
else if (a[0] === 'worktree' && a[1] === 'list') out({source:{repo_key:${JSON.stringify(common)},repo_root:${JSON.stringify(repo)},source_checkout_path:${JSON.stringify(repo)}},worktrees:[{path:${JSON.stringify(lane)},open_workspace_id:'w'}]});
else if (a[0] === 'tab' && a[1] === 'list') out({tabs:s.tabs});
else if (a[0] === 'pane' && a[1] === 'list') out({panes:s.panes});
else if (a[0] === 'pane' && a[1] === 'process-info') out({process_info:{shell_pid:1,foreground_processes:[{name:'native',pid:2}],process_tree_complete:true,process_tree:[{pid:1,identity:'shell',state:'S',command:'[zsh]'},{pid:2,identity:'native',state:'S',command:'[native]'}]}});
else if (a[0] === 'agent' && a[1] === 'list') out({agents:s.agents});
else if (a[0] === 'tab' && a[1] === 'close') {
  if(s.failClose) { console.error('injected tab failure'); process.exit(1); }
  s.actions.push(a); s.tabs=[]; s.panes=[]; s.agents=[]; fs.writeFileSync(file,JSON.stringify(s)); out({});
} else if(a[0] === 'workspace' && a[1] === 'close') {s.actions.push(a);s.workspaces=[];fs.writeFileSync(file,JSON.stringify(s));out({});}
else {console.error('unexpected fixture command '+a.join(' '));process.exit(1);}
`, { mode: 0o755 });
  env.HERDR_RETIRE_HERDR = herdr;
  env.PATH = `${scratch}:${process.env.PATH}`;
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
    eventFile, eventBytes, read: () => JSON.parse(fs.readFileSync(file)), queue: () => queueFor(repo) };
}

test('CLI dry plan reads the fold and shared executor refuses a concurrent native-session replacement', t => {
  const f = fixture(t), retirement = f.retirement(), plan = retirement.plan(); assert.equal(plan.close.length,1);
  f.state.agents[0].agent_session.value = 'replacement'; f.save();
  const result = retirement.apply(plan); assert.equal(result[0].action,'skip-close'); assert.match(result[0].why,/identity/);
  assert.deepEqual(f.read().actions,[]); assert.equal(fs.readFileSync(f.eventFile,'utf8'),f.eventBytes);
  const cli = spawnSync(process.execPath,[path.join(root,'supervisor/retire.mjs'),'plan','--repo',f.repo,'--org',f.org,'--herdr',f.job.herdr],{env:f.env,encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).keep.length,1);
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
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/chain is still open/);assert.deepEqual(f.read().actions,[]);
});
