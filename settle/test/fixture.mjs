// Real Git, record, lane review/check, dispatch and detached watch. Only Herdr's
// transport/model execution is scripted. No routes or validation config exists.
import fs from 'node:fs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { stopFixtureInbox } from '../../test/helpers/inbox.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { createProcessTracker, killProcess } from '../../test/helpers/processes.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const rootTool = fileURLToPath(new URL('../../', import.meta.url));
export function fixture(t, { source = rootTool, actor = 'settle-test-agent', execute = spawnSync } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-')));
  const repo = path.join(root, 'project'), workspace = path.join(root, 'lane'), bin = path.join(root, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SETTLE_TEST_ROOT: root,
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(ORG_|LANE_|HERDR_|MONITOR_)/.test(key) || (key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key))) delete env[key];
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
  const watchers = new Map(), observed = new Set(), pending = [], tracker = createProcessTracker();
  const rememberWatchers = () => {
    const directory = path.join(repo, '.org/dispatch');
    if (!fs.existsSync(directory)) return;
    const current = tracker.snapshot();
    if (!current.ok) throw Error('Cannot confirm fixture watcher ownership');
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
      watchers.set(file, { pid: row.pid, identity: row.identity, command: row.command, group: false });
    }
  };
  // Register ownership cleanup before any setup command can time out.
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    // Child hooks were registered later than this fixture hook. Await their
    // bounded completion here before stopping watchers and deleting any files.
    // Failed/unconfirmed completion retains the directory for inspection.
    await Promise.all(pending);
    for (const entry of watchers.values()) killProcess(entry, 'SIGTERM');
    const deadline = Date.now() + loadTimeout(2000);
    while (watchers.size && Date.now() < deadline) {
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
    try { return execute(file, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15_000 }); }
    finally { rememberWatchers(); }
  };
  const checked = (file, args, cwd, extra) => { const r = exec(file, args, cwd, extra); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
  const git = (args, cwd = repo) => checked('git', args, cwd);
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Settle tests']); git(['config', 'user.email', 'settle@example.invalid']);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test.mjs' } }));
  fs.writeFileSync(path.join(repo, 'work.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('work is nonempty',()=>assert.ok(fs.readFileSync('work.txt','utf8').trim()));\n");
  git(['add', '.']); git(['commit', '-qm', 'Create unconfigured project']);
  git(['worktree', 'add', '-q', '-b', 'lane/topic', workspace]);
  const org = path.join(repo, '.org');
  env.SETTLE_TEST_RECORD = path.join(source, 'bin/org.mjs');
  const record = (args) => checked(process.execPath, [path.join(source, 'bin/org.mjs'), ...args], repo, { ORG_DIR: org });
  record(['init']);
  const item = record(['add', 'Produce correct work', '--role', 'engineer', '--accept', 'work.txt contains correct']).split(' ')[0];
  const brief = path.join(root, 'ask with spaces.md'); fs.writeFileSync(brief, '# Produce correct work\n\nwork.txt must contain correct.\n');
  const start = () => record(['start', item, '--workspace', workspace, '--report', path.join(org, `report-${Date.now()}.md`), '--meta', 'lane=topic', '--meta', 'route=engineer', '--meta', 'harness=codex', '--meta', 'agent=original']).match(/R-\d+/)[0];
  const show = (id) => JSON.parse(record(['show', id, '--json']));
  const report = (id, outcome = 'done') => fs.writeFileSync(show(id).report_path, `---\nrun: ${id}\noutcome: ${outcome}\nsummary: The worker says the work is correct.\nheadline: The work is correct\nblockers: ${outcome === 'done' ? '[]' : '["A scope decision is needed"]'}\nproposals: []\nartifacts: ["work.txt"]\n---\n\nClaim: work.txt contains correct.\n`);
  const commit = (text) => { fs.writeFileSync(path.join(workspace, 'work.txt'), text); git(['add', 'work.txt'], workspace); git(['commit', '-qm', 'Implement work'], workspace); };
  fs.writeFileSync(path.join(bin, 'herdr'), fake, { mode: 0o755 });
  const settle = (id, args = []) => exec(process.execPath, [path.join(source, 'settle/settle.mjs'), id, '--brief', brief, ...args]);
  const retry = (id, args = []) => exec(process.execPath, [path.join(source, 'settle/settle.mjs'), id, '--retry', ...args]);
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const concurrent = (id, executable = path.join(source, 'settle/settle.mjs'), args = ['--brief', brief]) => {
    const child = spawnChild(t, process.execPath, [executable, id, ...args], { cwd: repo, env });
    const done = waitForExit(child).then(result => { rememberWatchers(); return result; });
    done.catch(() => {});
    pending.push(done);
    return { child, done };
  };
  return { root, repo, workspace, org, env, exec, record, start, show, report, commit, git, settle, retry, calls, concurrent, source, cleanup };
}
const fake = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const root=process.env.SETTLE_TEST_ROOT, repo=path.join(root,'project'), cwd=path.join(root,'lane'), args=process.argv.slice(2);
const file=path.join(root,'agents.json'); const agents=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
const save=()=>fs.writeFileSync(file,JSON.stringify(agents));
const out=(result)=>console.log(JSON.stringify({result}));
fs.appendFileSync(path.join(root,'calls'),JSON.stringify(args)+'\\n');
const ws={workspace_id:'w-lane',label:'topic',worktree:{checkout_path:cwd,is_linked_worktree:true,repo_key:path.join(repo,'.git'),repo_root:repo}};
if(args[0]==='workspace'&&args[1]==='list') out({workspaces:[ws,{workspace_id:'w-parent',label:'project',worktree:{checkout_path:repo,repo_key:path.join(repo,'.git'),repo_root:repo}}]});
else if(args[0]==='worktree'&&args[1]==='list') out({source:{repo_key:path.join(repo,'.git'),repo_root:repo,source_checkout_path:repo},worktrees:[{path:cwd,branch:'lane/topic',open_workspace_id:'w-lane'},{path:repo,branch:'main',open_workspace_id:'w-parent'}]});
else if(args[0]==='tab'&&args[1]==='create') {const n=Object.keys(agents).length+1;out({root_pane:{pane_id:'w-lane:p'+n},tab:{tab_id:'w-lane:t'+n}});}
else if(args[0]==='pane'&&args[1]==='get') out({pane:{pane_id:args[2],foreground_cwd:cwd}});
else if(args[0]==='pane'&&args[1]==='read') console.log(fs.existsSync(path.join(root,'supervisor-composer'))?fs.readFileSync(path.join(root,'supervisor-composer'),'utf8'):'────────────────────\\n❯ \\n────────────────────');
else if(args[0]==='agent'&&args[1]==='start') {const n=args[2],pane=args[args.indexOf('--pane')+1]; agents[n]={name:n,pane_id:pane,workspace_id:'w-lane',cwd,terminal_id:'t-'+n,agent_session:{value:'s-'+n},agent_status:'idle'};save();out({name:n,pane_id:pane});}
else if(args[0]==='agent'&&args[1]==='list') out({agents:Object.values(agents)});
else if(args[0]==='agent'&&args[1]==='get') out({agent:agents[args[2]]??{name:args[2],agent:'claude',agent_status:'idle',cwd,pane_id:'original:p',workspace_id:'w-lane'}});
else if(args[0]==='agent'&&args[1]==='read') console.log('');
else if(args[0]==='agent'&&args[1]==='wait') {await new Promise(r=>setTimeout(r,100));out({});}
else if(args[0]==='agent'&&args[1]==='prompt') {
 const prompt=args[3];
 if(prompt.includes('Private record file: ')) {
  fs.writeFileSync(path.join(root,'review-prompt'),prompt);
  if(fs.existsSync(path.join(root,'review-fail'))) {console.error('injected uncertain review');process.exit(1);}
  const field=(label)=>prompt.split('\\n').find(x=>x.startsWith(label+': '))?.slice(label.length+2);
  const correct=fs.readFileSync(path.join(cwd,'work.txt'),'utf8').trim()==='correct';
  const override=path.join(root,'review-result.json');
  const review=fs.existsSync(override)?JSON.parse(fs.readFileSync(override,'utf8')):{};
  const verdict=review.verdict??(correct?'PASS':'NEEDS-WORK');
  const findings=review.findings??(correct?'None':'- [Major] work.txt:1 - Report claims correct content but diff contains wrong; Fix: write correct');
  const budget=prompt.includes('## Review run budget')&&prompt.includes('Build, test, prepare, install and check commands: maximum count 0 for each command.');
  const inherited='- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.';
  const acknowledgment=fs.existsSync(path.join(root,'inherited-unverified'));
  const unverified=!budget?'- No unambiguous Review run budget; default zero-command limit.':fs.existsSync(path.join(root,'unverified'))?(acknowledgment?inherited+'\\n':'')+'- The acceptance evidence remains unresolved.':acknowledgment?inherited:'None';
  const nonclaims=budget&&!acknowledgment?inherited:'None';
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
 } else if(prompt.startsWith('You are run ')) {
  const [,run,report]=prompt.match(/You are run (R-\\d+).*Write the report to ([^;]+);/);
  if(fs.existsSync(path.join(root,'prompt-fail'))) {console.error('injected uncertain delivery');process.exit(1);}
  agents[args[2]].agent_status='working';save();
  fs.writeFileSync(path.join(cwd,'work.txt'),'correct\\n');execFileSync('git',['-C',cwd,'add','work.txt']);execFileSync('git',['-C',cwd,'commit','--allow-empty','-qm','Correct the independent finding']);
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'---\\nrun: '+run+'\\noutcome: done\\nsummary: Corrected the independent finding.\\nheadline: The finding is fixed\\nblockers: []\\nproposals: []\\nartifacts: ["work.txt"]\\n---\\n\\nClaim: work.txt contains correct.\\n');
  agents[args[2]].agent_status='idle';save();
 }
 out({});
} else out({});
`;
