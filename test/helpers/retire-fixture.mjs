// Shared offline topology for retirement and the composed activation seam.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRetirement } from '../../supervisor/retire.mjs';
import { queueFor } from '../../promote/promote.mjs';
import { loadEvents } from '../../lib/store.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const laneCLI = path.join(root, 'lanes/lane.mjs');
export const heldReason = 'retirement held: .lane/supervisor/HOLD-WORKER-TAB-CLOSE';
export function hold(f, kind = 'file', cwd = f.repo) {
  f.traceGit();
  const file = path.join(cwd, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (kind === 'directory') fs.mkdirSync(file);
  else if (kind === 'symlink') fs.symlinkSync('missing-target', file);
  else fs.writeFileSync(file, 'contents must never be read');
  return () => fs.rmSync(file, { recursive: true, force: true });
}
export function isolatedEnv(t, f) {
  const old = {};
  for (const key of ['ORG_DIR', 'HERDR_MONITOR_FLEET', 'HERDR_RETIRE_HERDR', 'MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'XDG_STATE_HOME']) {
    old[key] = process.env[key]; process.env[key] = f.env[key];
  }
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
export function assertNoRemoval(f) {
  assert.deepEqual(f.read().actions.filter(a => ['close', 'remove'].includes(a[1])), []);
  assert.deepEqual(f.gitCalls().filter(a => a.includes('worktree') && a.includes('remove')), []);
}
export function fixture(t, { merged = true, occupied = true } = {}) {
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
  const file = path.join(scratch, 'state.json'), herdr = path.join(scratch, 'herdr'), herdrLog = path.join(scratch, 'herdr-calls.jsonl');
  const save = () => fs.writeFileSync(file, JSON.stringify(state)); save();
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs = require('node:fs'), file = ${JSON.stringify(file)}, s = JSON.parse(fs.readFileSync(file)), a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(herdrLog)}, JSON.stringify(a) + '\\n');
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
else if (s.exitMode && a[0] === 'pane' && a[1] === 'read') { process.stdout.write(s.screen); }
else if (s.exitMode && a[0] === 'agent' && a[1] === 'prompt') {
  s.actions.push(a);
  if(s.exitMode==='exit') s.info={shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}],process_tree_complete:true,process_tree:[s.info.process_tree[0]]};
  fs.writeFileSync(file,JSON.stringify(s));out({});
}
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
  const retirement = (options = {}) => createRetirement({ cwd: repo, org, herdr, env, ...options });
  const close = (gitOnly = true) => spawnSync(process.execPath, [laneCLI, 'close', 'topic', ...(gitOnly ? ['--git-only'] : []), ...(merged ? ['--expected-tip',head] : [])], { cwd: repo, env, encoding: 'utf8' });
  const job = { id: 'job', topic: 'topic', org, run: 'R-1', herdr, laneCLI };
  return { scratch, repo, lane, org, env, git, head, common, state, save, file, retirement, close, job,
    eventFile, eventBytes, read: () => JSON.parse(fs.readFileSync(file)), queue: () => queueFor(repo),
    herdrCalls: () => fs.existsSync(herdrLog) ? fs.readFileSync(herdrLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    traceGit, gitCalls: () => fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

// An open reported chain, ignored evidence and a reconcile manifest for a real fast-forward.
export function completionFixture(t) {
  const f = fixture(t, { merged: false }); isolatedEnv(t, f);
  // Native completion discovers this disposable project's record itself.
  fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.org\n.lane/\n');
  const events = loadEvents(f.org).events.filter(e => e.type !== 'item.closed');
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  fs.mkdirSync(path.join(f.lane, '.lane')); const scratchFile = path.join(f.lane, '.lane/review-and-scratch');
  const bytes = Buffer.from('unique review, report and scratch evidence\n'); fs.writeFileSync(scratchFile, bytes);
  const manifest = path.join(f.scratch, 'manifest.json'), prepared = path.join(f.scratch, 'prepared.json'), gate = path.join(f.scratch, 'gate.log');
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'composed', candidate: f.head,
    items: [{ item: 'ENG-1', run: 'R-1', head: f.head, superseded: [], why: 'Disposable fixture independent acceptance' }], excluded: [] }));
  const config = path.join(f.scratch, 'lane.json'); fs.writeFileSync(config, JSON.stringify({ main: 'main', validate: 'true' }));
  f.env.LANE_CONFIG = config;
  const run = args => {
    const r = spawnSync(process.execPath, args, { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr); return r;
  };
  return { ...f, scratchFile, bytes, manifest, prepared, gate, config, run };
}

export function traceLane(f) {
  const calls = path.join(f.scratch, 'lane-calls.jsonl'), wrapped = path.join(f.scratch, 'lane-wrapper.mjs');
  fs.writeFileSync(wrapped, `import fs from 'node:fs';import {spawnSync} from 'node:child_process';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');const r=spawnSync(process.execPath,[${JSON.stringify(laneCLI)},...a],{stdio:'inherit'});process.exit(r.status??1);`);
  return { calls, job: { ...f.job, laneCLI: wrapped } };
}
