// Real Git, record, lane review/check, dispatch and detached watch. Only Herdr's
// transport/model execution is scripted. No routes or validation config exists.
import fs from 'node:fs';
import { repositorySeed } from '../../test/helpers/git-seed.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { stopFixtureInbox, stopFixtureProcessTree } from '../../test/helpers/inbox.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { createProcessTracker } from '../../test/helpers/processes.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const rootTool = fileURLToPath(new URL('../../', import.meta.url));
let copyInitialRepository;
export function fixture(t, { source = rootTool, actor = 'settle-test-agent', execute = spawnSync } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-')));
  fixtureFleet(t, root);
  const repo = path.join(root, 'project'), workspace = path.join(root, 'lane'), bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SETTLE_TEST_ROOT: root,
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(ORG_|LANE_|HERDR_|MONITOR_)/.test(key) || (key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key))) delete env[key];
  // HOME only protects children. Imported product calls and nested entry/join
  // commands must share this fixture's fleet even outside the bounded runner.
  env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  // Reset project/session inputs without sending offline fixture gates to the
  // real host lock. Each fixture owns its temporary slot and nested commands.
  env.MONITOR_TEST_SLOT_PATH = path.join(root, 'test-slot.lock');
  env.MONITOR_TEST_SLOT_COMPAT_PATH = env.MONITOR_TEST_SLOT_PATH;
  delete env.BCH_CLOAK_TEST_SLOT_TOKEN;
  delete env.BCH_CLOAK_TEST_SLOT_WAIT_SECONDS;
  env.ORG_ACTOR = actor;
  env.SUPERVISOR_INPUT_CONFIRM_SECONDS = '0.02';
  env.SUPERVISOR_INPUT_POLL_SECONDS = '0.02';
  env.SUPERVISOR_INPUT_WAIT_SECONDS = '2';
  delete env.NODE_TEST_CONTEXT;
  fs.mkdirSync(env.HOME); fs.mkdirSync(env.XDG_CONFIG_HOME);
  const watchers = new Map(), queueWorkers = new Map(), observed = new Set(), pending = [], tracker = createProcessTracker();
  const rememberWatchers = () => {
    const directory = path.join(repo, '.org/dispatch');
    const hasDispatch = fs.existsSync(directory);
    if (!hasDispatch && !fs.existsSync(path.join(repo, '.git/promote/queue.json'))) return;
    const current = tracker.snapshot();
    if (!current.ok) throw Error('Cannot confirm fixture watcher ownership');
    const drain = [process.execPath, path.join(source, 'promote/promote.mjs'), '--drain', '--repo', repo].join(' ');
    for (const row of current.value.values()) if (row.command === drain && !/^Z/.test(row.state))
      queueWorkers.set(row.pid, { pid: row.pid, identity: row.identity, command: row.command });
    if (!hasDispatch) return;
    for (const file of fs.readdirSync(directory).filter(x => x.endsWith('.json') && !x.endsWith('.routes.json'))) {
      const job = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (!job.watcher?.pid || observed.has(file)) continue;
      observed.add(file);
      const row = current.value.get(job.watcher?.pid);
      if (!row || /^Z/.test(row.state)) continue;
      if (!row.command.includes(path.join(source, 'watch/watch.mjs')) || !row.command.includes(path.join(repo, '.org'))) {
        console.error(`Fixture watcher PID ${row.pid} already changed after acknowledgment; no signal sent`);
        continue;
      }
      watchers.set(file, { pid: row.pid, identity: row.identity, command: row.command, pgid: row.pgid, group: false });
    }
  };
  // Register ownership cleanup before any setup command can time out.
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    // Child hooks were registered later than this fixture hook. Await their
    // actual completion here before stopping watchers and deleting any files.
    // Failed/unconfirmed completion retains the directory for inspection.
    await Promise.all(pending);
    rememberWatchers();
    // The empty-queue handoff releases worker.lock before the finite process's
    // final retirement catch-up. Await its pinned identity before deleting the
    // fixture; lock disappearance alone does not establish process completion.
    while (queueWorkers.size) {
      const current = tracker.snapshot();
      if (!current.ok) throw Error('Cannot confirm fixture queue shutdown');
      for (const [pid, entry] of queueWorkers) {
        const row = current.value.get(pid);
        if (!row || /^Z/.test(row.state) || row.identity !== entry.identity || row.command !== entry.command) queueWorkers.delete(pid);
      }
      if (!queueWorkers.size) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const entry of watchers.values()) await stopFixtureProcessTree(entry, { tracker, ownerGroup: entry.pgid,
      description: `settle watcher ${entry.pid}` });
    while (watchers.size) {
      const current = tracker.snapshot();
      if (!current.ok) throw Error('Cannot confirm watcher shutdown');
      for (const [file, entry] of watchers) {
        const row = current.value.get(entry.pid);
        if (!row || /^Z/.test(row.state) || row.identity !== entry.identity || row.command !== entry.command) watchers.delete(file);
      }
      if (watchers.size) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(watchers.size, 0, 'fixture watchers did not shut down');
    await stopFixtureInbox(path.join(repo, '.org/supervisor/inbox.log'), {
      script: path.join(source, 'supervisor/prompt-supervisor.mjs'), tracker,
    });
    // A just-terminated watcher can still finish a scratch log write. Retry
    // transient removal races briefly; cleanup remains bounded and owned here.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    cleaned = true;
  };
  t.after(cleanup);
  const exec = (file, args, cwd = repo, extra = {}) => {
    try { return execute(file, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' }); }
    finally { rememberWatchers(); }
  };
  const checked = (file, args, cwd, extra) => { const r = exec(file, args, cwd, extra); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
  const git = (args, cwd = repo) => checked('git', args, cwd);
  const initializeRepository = seed => {
    const git = args => {
      const result = execute('git', ['-C', seed, ...args], { cwd: seed, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Settle tests']); git(['config', 'user.email', 'settle@example.invalid']);
    fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test.mjs' } }));
    fs.writeFileSync(path.join(seed, 'work.txt'), 'base\n');
    fs.writeFileSync(path.join(seed, 'test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('work is nonempty',()=>assert.ok(fs.readFileSync('work.txt','utf8').trim()));\n");
    git(['add', '.']); git(['commit', '-qm', 'Create unconfigured project']);
  };
  // A supplied command hook owns only this fixture's scratch tree. Do not send
  // it shared seed operations or change the setup-failure boundary it scripts.
  if (execute === spawnSync && process.env.HERDR_TEST_OFFLINE_ROOT) {
    copyInitialRepository ??= repositorySeed(process.env.HERDR_TEST_OFFLINE_ROOT, initializeRepository);
    copyInitialRepository(repo);
  } else {
    fs.mkdirSync(repo);
    initializeRepository(repo);
  }
  git(['worktree', 'add', '-q', '-b', 'lane/topic', workspace]);
  const org = path.join(repo, '.org');
  env.SETTLE_TEST_RECORD = path.join(source, 'bin/org.mjs');
  const record = (args) => checked(process.execPath, [path.join(source, 'bin/org.mjs'), ...args], repo, { ORG_DIR: org });
  record(['init']);
  const item = record(['add', 'Produce correct work', '--role', 'engineer', '--accept', 'work.txt contains correct']).split(' ')[0];
  const brief = path.join(root, 'ask with spaces.md'); fs.writeFileSync(brief, '# Produce correct work\n\nwork.txt must contain correct.\n');
  const start = ({ owned = true } = {}) => {
    const id = record(['start', item, '--workspace', workspace, '--report', path.join(org, `report-${Date.now()}.md`), '--meta', 'lane=topic', '--meta', 'route=engineer', '--meta', 'harness=codex', '--meta', 'agent=original']).match(/R-\d+/)[0];
    if (owned) record(['claim', id, '--controller', 'brain']);
    return id;
  };
  const show = (id) => JSON.parse(record(['show', id, '--json']));
  const report = (id, outcome = 'done', { artifacts = ['work.txt'], body = 'Claim: work.txt contains correct.' } = {}) => fs.writeFileSync(show(id).report_path, `---\nrun: ${id}\noutcome: ${outcome}\nsummary: The worker says the work is correct.\nheadline: The work is correct\nblockers: ${outcome === 'done' ? '[]' : '["A scope decision is needed"]'}\nproposals: []\nartifacts: ${artifacts.length ? `\n${artifacts.map(entry => `  - ${JSON.stringify(entry)}`).join('\n')}` : '[]'}\n---\n\n${body}\n`);
  const commit = (text) => { fs.writeFileSync(path.join(workspace, 'work.txt'), text); git(['add', 'work.txt'], workspace); git(['commit', '-qm', 'Implement work'], workspace); };
  fs.writeFileSync(path.join(bin, 'herdr'), fake, { mode: 0o755 });
  const settle = (id, args = []) => exec(process.execPath, [path.join(source, 'settle/settle.mjs'), id, '--brief', brief, ...args]);
  const retry = (id, args = []) => exec(process.execPath, [path.join(source, 'settle/settle.mjs'), id, '--retry', ...args]);
  // Recovery witnesses request their ONE formal fix explicitly after the
  // default cap1 review. They must not depend on an automatic review/fix chain.
  const requestCorrection = (id, args = []) => {
    const first = settle(id, args);
    if (first.status !== 0) return first;
    const saved = JSON.parse(first.stdout);
    if (saved.code !== 'REVIEW_CAP_REACHED') return first;
    assert.equal(saved.review_policy.cap, 1);
    assert.equal(saved.review_policy.round, 1);
    return retry(id, [...args, '--fix-findings']);
  };
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const concurrent = (id, executable = path.join(source, 'settle/settle.mjs'), args = ['--brief', brief], { scenario = false } = {}) => {
    const child = (scenario ? spawnScenarioChild : spawnChild)(t, process.execPath, [executable, id, ...args], { cwd: repo, env });
    const done = waitForExit(child).then(result => { rememberWatchers(); return result; });
    done.catch(() => {});
    pending.push(done);
    return { child, done };
  };
  return { root, repo, workspace, org, env, exec, record, start, show, report, commit, git, settle, retry, requestCorrection, calls, concurrent, source, cleanup };
}
// The fake and its foreground owner must use the same interpreter, even when
// PATH selects a different Node in the fixture's scratch directory.
const fake = `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const {lookupProcess}=await import(path.join(path.dirname(process.env.SETTLE_TEST_RECORD),'../lib/processes.mjs'));
const root=process.env.SETTLE_TEST_ROOT, repo=path.join(root,'project'), cwd=path.join(root,'lane'), args=process.argv.slice(2);
const file=path.join(root,'agents.json'); const agents=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
const save=()=>fs.writeFileSync(file,JSON.stringify(agents));
const paneFile=path.join(root,'panes.json'); const panes=fs.existsSync(paneFile)?JSON.parse(fs.readFileSync(paneFile)):{};
const out=(result)=>console.log(JSON.stringify({result}));
const clientOwner=(relative,operation='')=>{
 const program=path.join(path.dirname(process.env.SETTLE_TEST_RECORD),'..',relative);
 const prefix=process.execPath+' '+program+(operation?' '+operation:'')+' ';
 // Only this client's ancestors can own it; unrelated host processes are not
 // fixture inputs and must not make its ownership lookup fail.
 let pid=process.ppid;const seen=new Set();
 while(pid>1&&!seen.has(pid)){
  seen.add(pid);const result=lookupProcess(pid);
  if(!result.ok)throw Error('cannot confirm fixture client owner: '+result.error);
  const owner=result.value;if(!owner)break;
  if(owner.command.startsWith(prefix))return {pid:owner.pid,identity:owner.identity};
  pid=owner.ppid;
 }
 throw Error('fixture client has no foreground owner');
};
const liveAgents=()=>Object.values(agents).filter(agent=>{
 if(!agent.client_owner)return true;
 const owner=lookupProcess(agent.client_owner.pid,{identityOnly:true});
 return !owner.ok||!!(owner.value&&owner.value.identity===agent.client_owner.identity&&!/^Z/.test(owner.value.state));
});
fs.appendFileSync(path.join(root,'calls'),JSON.stringify(args)+'\\n');
const ws={workspace_id:'w-lane',label:'topic',worktree:{checkout_path:cwd,is_linked_worktree:true,repo_key:path.join(repo,'.git'),repo_root:repo}};
if(args[0]==='workspace'&&args[1]==='list') out({workspaces:[ws,{workspace_id:'w-parent',label:'project',worktree:{checkout_path:repo,is_linked_worktree:false,repo_key:path.join(repo,'.git'),repo_root:repo}}]});
else if(args[0]==='worktree'&&args[1]==='list') out({source:{repo_key:path.join(repo,'.git'),repo_root:repo,source_checkout_path:repo},worktrees:[{path:cwd,branch:'lane/topic',open_workspace_id:'w-lane'},{path:repo,branch:'main',open_workspace_id:'w-parent'}]});
else if(args[0]==='tab'&&args[1]==='create') {const n=Object.keys(agents).length+1,w=args.includes('--workspace')?args[args.indexOf('--workspace')+1]:'w-lane',p=w+':p'+n;panes[p]={cwd:args.includes('--cwd')?args[args.indexOf('--cwd')+1]:cwd,workspace_id:w};fs.writeFileSync(paneFile,JSON.stringify(panes));out({root_pane:{pane_id:p},tab:{tab_id:w+':t'+n}});}
// Scripted clients belong to their real foreground review/dispatch process.
// Keep their registrations through delivery verification, then report vacancy
// only after that process has exited or its kernel birth has changed.
else if(args[0]==='tab'&&args[1]==='list') out({tabs:process.env.SETTLE_TEST_REVIEW_IDENTITY?liveAgents().filter(a=>a.workspace_id===args.at(-1)).map(a=>({tab_id:a.pane_id.replace(':p',':t'),workspace_id:a.workspace_id})):[]});
else if(args[0]==='pane'&&args[1]==='list') out({panes:process.env.SETTLE_TEST_REVIEW_IDENTITY?liveAgents().filter(a=>a.workspace_id===args.at(-1)).map(a=>({pane_id:a.pane_id,tab_id:a.pane_id.replace(':p',':t'),workspace_id:a.workspace_id})):[]});
else if(args[0]==='pane'&&args[1]==='process-info') {
 const agent=liveAgents().find(a=>a.pane_id===args.at(-1)),owner=lookupProcess(agent?.client_owner?.pid,{identityOnly:true});
 if(!owner.ok||!owner.value)throw Error('fixture reviewer owner unavailable');
 out({process_info:{shell_pid:123456789,foreground_processes:[{pid:owner.value.pid,name:'native'}],process_tree_complete:true,
  process_tree:[{pid:123456789,identity:'fixture-shell',command:'[zsh]',state:'S'},owner.value]}});
}
else if(args[0]==='pane'&&args[1]==='get') {const pane=args.at(-1);out({pane:{pane_id:pane,foreground_cwd:panes[pane]?.cwd??cwd}});}
else if(args[0]==='pane'&&args[1]==='read') console.log(fs.existsSync(path.join(root,'supervisor-composer'))?fs.readFileSync(path.join(root,'supervisor-composer'),'utf8'):'────────────────────\\n❯ \\n────────────────────');
else if(args[0]==='agent'&&args[1]==='start') {const n=args[2],pane=args[args.indexOf('--pane')+1]; agents[n]={name:n,pane_id:pane,workspace_id:panes[pane]?.workspace_id??'w-lane',cwd:panes[pane]?.cwd??cwd,terminal_id:'t-'+n,agent_session:{value:'s-'+n},agent_status:'idle',...(process.env.SETTLE_TEST_REVIEW_IDENTITY?{client_owner:clientOwner('lanes/lane.mjs','review')}:{})};save();out({name:n,pane_id:pane});}
else if(args[0]==='agent'&&args[1]==='list') out({agents:liveAgents().map(a=>{
 if(!process.env.SETTLE_TEST_REVIEW_IDENTITY)return a;
 const {agent_session,...summary}=a;return summary;
})});
else if(args[0]==='agent'&&args[1]==='get') out({agent:agents[args[2]]??{name:args[2],agent:'claude',agent_status:'idle',cwd,pane_id:'original:p',workspace_id:'w-lane'}});
else if(args[0]==='agent'&&args[1]==='read') console.log('');
else if(args[0]==='agent'&&args[1]==='wait') {await new Promise(r=>setTimeout(r,100));out({});}
else if(args[0]==='agent'&&args[1]==='prompt') {
 const prompt=args[3];
 if(prompt.includes('Private record file: ')) {
  fs.writeFileSync(path.join(root,'review-prompt'),prompt);
  if(fs.existsSync(path.join(root,'review-fail'))) {console.error('injected uncertain review');process.exit(1);}
  const field=(label)=>prompt.split('\\n').find(x=>x.startsWith(label+': '))?.slice(label.length+2);
  const correct=execFileSync('git',['-C',repo,'show',field('Reviewed commit')+':work.txt'],{encoding:'utf8'}).trim()==='correct';
  const override=path.join(root,'review-result.json');
  const review=fs.existsSync(override)?JSON.parse(fs.readFileSync(override,'utf8')):{};
  const verdict=review.verdict??(correct?'PASS':'NEEDS-WORK');
  const findings=review.findings??(correct?'None':'- [Major] work.txt:1 - Report claims correct content but diff contains wrong; Fix: write correct');
  const budget=prompt.includes('## Review run budget')&&prompt.includes('Build, test, prepare, install and check commands: maximum count 0 for each command.');
  const inherited='- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.';
  const acknowledgment=fs.existsSync(path.join(root,'inherited-unverified'));
  const unverified=review.unverified??(!budget?'- No unambiguous Review run budget; default zero-command limit.':fs.existsSync(path.join(root,'unverified'))?(acknowledgment?inherited+'\\n':'')+'- The acceptance evidence remains unresolved.':acknowledgment?inherited:'None');
  const gateAcknowledgment=prompt.split('\\n').find(line=>line.startsWith('- The supplied gate is inherited evidence;'));
  const nonclaims=budget&&!acknowledgment?[gateAcknowledgment,inherited].filter(Boolean).join('\\n'):'None';
  const recordAction=path.join(root,'review-record-action.json');
  if(fs.existsSync(path.join(root,'review-stop'))) {fs.mkdirSync(path.join(repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(repo,'.lane/supervisor/STOP'),'Stop during review\\n');}
  if(fs.existsSync(recordAction)) execFileSync(process.execPath,[process.env.SETTLE_TEST_RECORD,...JSON.parse(fs.readFileSync(recordAction,'utf8'))],{cwd:repo,env:{...process.env,ORG_DIR:path.join(repo,'.org')}});
  const newcomer=path.join(root,'review-new-report.json');
  if(fs.existsSync(newcomer)) {
   const {item,outcome}=JSON.parse(fs.readFileSync(newcomer,'utf8'));
   const record=(argv)=>execFileSync(process.execPath,[process.env.SETTLE_TEST_RECORD,...argv],{cwd:repo,env:{...process.env,ORG_DIR:path.join(repo,'.org')},encoding:'utf8'});
   const run=record(['start',item,'--workspace',cwd]).match(/R-\\d+/)[0], report=JSON.parse(record(['show',run,'--json'])).report_path;
   fs.writeFileSync(report,'---\\nrun: '+run+'\\noutcome: '+outcome+'\\nsummary: Newer run needs supervisor judgment.\\nblockers: ["Scope decision"]\\nproposals: []\\n---\\n');
   record(['ingest',report]);fs.writeFileSync(path.join(root,'review-new-run'),run);
  }
  const reviewed=fs.existsSync(path.join(root,'wrong-head'))?'0'.repeat(40):field('Reviewed commit');
  const lines=['**'+verdict+'**','Schema: lane-review/v1','Reviewed commit: '+reviewed,'Topic: '+field('Topic'),'Round: '+field('Round'),'Review ID: '+field('Review ID'),'Base branch: '+field('Base branch'),'Base commit: '+field('Base commit'),'','## Findings',findings,'','## Re-executed','~~~json','[]','~~~','','## Non-claims',nonclaims,'','## Unverified',unverified,'','## Private identifiers','~~~json','[]','~~~','','## Analysis','Scripted independent claim check.','','<!-- lane-review-complete -->',''];
  const dest=field('Private record file');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,lines.join('\\n').replaceAll('~~~',String.fromCharCode(96).repeat(3)));
  agents[args[2]].client_owner=clientOwner('lanes/lane.mjs','review');save();
 } else if(prompt.startsWith('You are run ')) {
  const [,run,report]=prompt.match(/You are run (R-\\d+).*Write the report to ([^;]+);/);
  if(fs.existsSync(path.join(root,'prompt-fail'))) {console.error('injected uncertain delivery');process.exit(1);}
  agents[args[2]].agent_status='working';save();
  fs.writeFileSync(path.join(cwd,'work.txt'),'correct\\n');execFileSync('git',['-C',cwd,'add','work.txt']);execFileSync('git',['-C',cwd,'commit','--allow-empty','-qm','Correct the independent finding']);
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'---\\nrun: '+run+'\\noutcome: done\\nsummary: Corrected the independent finding.\\nheadline: The finding is fixed\\nblockers: []\\nproposals: []\\nartifacts: ["work.txt"]\\n---\\n\\nClaim: work.txt contains correct.\\n');
  agents[args[2]].agent_status='idle';agents[args[2]].client_owner=clientOwner('dispatch/dispatch.mjs');save();
 }
 out({});
} else out({});
`;
