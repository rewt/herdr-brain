// Offline native transport for installed-cycle.mjs. No socket or model calls.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.realpathSync(process.env.INSTALLED_CYCLE_ROOT);
const file = path.join(root, 'native.json'), args = process.argv.slice(2), [group, verb, positional] = args;
const state = JSON.parse(fs.readFileSync(file)), option = key => args[args.indexOf(key) + 1];
const target = positional === '--pane' ? option('--pane') : positional;
const inside = value => typeof value === 'string' && value.startsWith(root + path.sep) &&
  fs.realpathSync(value).startsWith(root + path.sep);
const all = Object.values(state.workspaces);
const workspace = all.find(w => w.workspace_id === target || w.pane.pane_id === target || w.agent?.name === target);
const agent = workspace?.agent;
// Disjoint from real macOS PIDs. Births belong to this private native world;
// the observation seam resolves only these rows and leaves real children real.
const birth = (command, ppid = 0) => {
  const pid = state.nextProcess = (state.nextProcess ?? 1_000_000_000) + 1;
  return { pid, ppid, pgid: pid, identity: `0:${pid}`, command, state: 'S' };
};
// Native tab and pane lists honor --workspace; concurrent lanes must not leak.
const scoped = () => args.includes('--workspace') ? all.filter(w => w.workspace_id === option('--workspace')) : all;
fs.appendFileSync(path.join(root, 'native-calls.jsonl'), JSON.stringify(args) + '\n');
let result = {}, changed = false;
const missing = () => { console.error(JSON.stringify({ error: { code: 'agent_not_found' } })); process.exit(1); };
if (group === 'workspace' && verb === 'list') result = { workspaces: all };
else if (group === 'worktree' && verb === 'list') result = { source: { repo_key: state.repo + '/.git', repo_root: state.repo, source_checkout_path: state.repo },
  worktrees: all.map(w => ({ path: w.cwd, branch: w.branch, repo_root: state.repo, open_workspace_id: w.workspace_id })) };
else if (group === 'worktree' && verb === 'open') {
  const cwd = option('--path');
  if (!inside(cwd) || option('--cwd') !== state.repo || !args.includes('--no-focus')) throw Error('foreign native creation');
  const id = 'scratch' + ++state.next;
  const w = { workspace_id: id, cwd, label: option('--label'), branch: 'lane/' + path.basename(cwd).replace(/^lane-/, ''),
    worktree: { checkout_path: cwd, repo_root: state.repo, repo_key: state.repo + '/.git', is_linked_worktree: true },
    tab: { tab_id: id + ':t1', workspace_id: id },
    pane: { pane_id: id + ':p1', tab_id: id + ':t1', workspace_id: id, terminal_id: id + '-terminal', foreground_cwd: cwd },
    shellProcess: birth('[sh]') };
  state.workspaces[id] = w; changed = true;
  result = { already_open: false, workspace: w, tab: w.tab, root_pane: w.pane };
} else if (group === 'tab' && verb === 'list') result = { tabs: scoped().flatMap(w => w.tab ? [w.tab] : []) };
else if (group === 'pane' && verb === 'list') result = { panes: scoped().flatMap(w => w.tab ? [w.pane] : []) };
else if (group === 'pane' && verb === 'get') { if (!workspace) missing(); result = { pane: workspace.pane }; }
else if (group === 'pane' && verb === 'process-info') {
  if (!workspace) missing();
  result = { process_info: { shell_pid: workspace.shellProcess.pid,
    foreground_processes: [{ pid: agent ? workspace.agentProcess.pid : workspace.shellProcess.pid, name: agent ? agent.agent : 'sh' }],
    process_tree_complete: true, process_tree: [workspace.shellProcess, ...(agent ? [workspace.agentProcess] : [])] } };
} else if (group === 'pane' && verb === 'run') {
  if (!workspace || !args[3].startsWith(" . '")) throw Error('only private environment preparation is executable');
  const prepared = spawnSync('/bin/sh', ['-c', args[3]], { cwd: workspace.cwd, encoding: 'utf8' });
  if (prepared.status !== 0) throw Error(prepared.stderr);
  workspace.output = prepared.stdout; changed = true;
} else if (group === 'pane' && verb === 'read') { process.stdout.write(workspace?.output ?? 'Ready for a task'); process.exit(0); }
else if (group === 'agent' && verb === 'start') {
  const w = all.find(w => w.pane.pane_id === option('--pane'));
  if (!w || !inside(w.cwd)) throw Error('foreign native start');
  w.agent = { name: target, agent: option('--kind'), pane_id: w.pane.pane_id, tab_id: w.tab.tab_id,
    workspace_id: w.workspace_id, cwd: w.cwd, terminal_id: w.pane.terminal_id,
    agent_session: { value: w.workspace_id + '-session' }, agent_status: 'idle' };
  w.agentProcess = birth(`[${w.agent.agent}]`, w.shellProcess.pid);
  changed = true; result = { name: target, pane_id: w.pane.pane_id };
} else if (group === 'agent' && verb === 'get') { if (!agent) missing(); result = { agent }; }
else if (group === 'agent' && verb === 'list') result = { agents: all.flatMap(w => w.agent ? [w.agent] : []) };
else if (group === 'agent' && verb === 'prompt') {
  if (!agent) missing();
  if (args[3] !== '/exit') {
    const events = fs.readFileSync(path.join(state.repo, '.org/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const binding = events.find(e => e.type === 'run.session_bound' && e.session === agent.agent_session.value);
    fs.appendFileSync(path.join(root, 'evidence/native-input.jsonl'), JSON.stringify({ agent: agent.name,
      process: workspace.agentProcess, session: agent.agent_session.value,
      binding: binding ? { seq: binding.seq, run: binding.run, process: binding.process, session: binding.session } : null }) + '\n');
  }
  if(args[3]!=='/exit'&&fs.existsSync(path.join(root,'refuse-prompt'))) {
    console.error(JSON.stringify({error:{code:'NATIVE_REFUSAL',message:'scripted explicit input refusal'}}));process.exit(1);
  }
  if (args[3] === '/exit') { delete workspace.agent; delete workspace.agentProcess; }
  else agent.agent_status = 'working';
  changed = true;
  if (fs.existsSync(path.join(root, 'lose-prompt-reply'))) {
    fs.writeFileSync(file, JSON.stringify(state));
    console.error('scripted lost native prompt reply'); process.exit(1);
  }
} else if (group === 'agent' && verb === 'wait') await new Promise(resolve => setTimeout(resolve, 25));
else if (group === 'agent' && verb === 'read') process.stdout.write('Ready for a task');
else if (group === 'agent' && verb === 'send-keys') { if (!agent) missing(); }
else if (group === 'tab' && verb === 'close') {
  const w = all.find(w => w.tab?.tab_id === target); if (!w) throw Error('foreign tab close');
  delete w.tab; delete w.agent; delete w.agentProcess; changed = true;
} else if (group === 'workspace' && verb === 'close') {
  if (!workspace || workspace.cwd === state.repo || workspace.tab) throw Error('foreign or occupied workspace close');
  delete state.workspaces[target]; changed = true;
} else if (!(group === 'tab' && verb === 'rename')) throw Error(`unexpected scripted native call: ${args.join(' ')}`);
if (changed) { const pending = file + '.' + process.pid; fs.writeFileSync(pending, JSON.stringify(state)); fs.renameSync(pending, file); }
console.log(JSON.stringify({ result }));
