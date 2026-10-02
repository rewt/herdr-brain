#!/usr/bin/env node
// Capability boundary for acceptance. Never forwards a target not returned by
// creation or a verified late-pane receipt in this run. Native model sessions
// launch only through this run's confined live worker.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = fs.realpathSync(process.env.ACCEPTANCE_ROOT);
const ledger = path.join(root, 'ownership.json');
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(ledger, 'utf8'));
const inside = (p) => {
  return [root, ...(state.creationRoots ?? [])].some((base) => {
    const r = path.relative(base, fs.realpathSync(p));
    return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
  });
};
// Only explicit capability checks identify candidate safety violations. Native
// failures, malformed receipts, script timeouts and adapter I/O are harness errors.
class CapabilityRefusal extends Error {}
const option = (key) => argv[argv.indexOf(key) + 1];
const requireOption = (key) => { if (!argv.includes(key)) throw new CapabilityRefusal(`explicit ${key} required`); return option(key); };
const owned = (id, collection) => { if (!state[collection].includes(id)) throw new CapabilityRefusal(`unowned ${collection}: ${id}`); };
class ReceiptLimit extends Error {}
async function updateOwnership(change) {
  const lock = path.join(root, 'ownership.lock');
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  try {
    const latest = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    change(latest);
    const temporary = `${ledger}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(latest)); fs.renameSync(temporary, ledger);
    Object.assign(state, latest);
  } finally { fs.rmdirSync(lock); }
}
function safePath(p) {
  let ancestor = path.resolve(p);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!inside(ancestor)) throw new CapabilityRefusal(`path outside scratch: ${p}`);
}
let child;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child?.kill(signal); process.exit(1); });
async function real(args) {
  const mutating = !['list', 'get', 'read', 'wait', 'process-info'].includes(args[1]);
  const id = `${process.pid}:${Date.now()}:${Math.random()}`;
  const focusCalls = path.join(root, 'evidence', 'focus-calls.jsonl');
  const traceCall = (type) => {
    if (mutating && fs.existsSync(path.dirname(focusCalls))) fs.appendFileSync(focusCalls,
      JSON.stringify({ type, id, at: Date.now(), args, requested: argv }) + '\n');
  };
  traceCall('start');
  return await new Promise((resolve, reject) => {
    child = spawn(state.binary, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(state.socketPath ? { HERDR_SOCKET_PATH: state.socketPath } : {}) } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => { stdout += v; });
    child.stderr.on('data', (v) => { stderr += v; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 35_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      traceCall('end');
      fs.appendFileSync(path.join(root, 'herdr.jsonl'), JSON.stringify({ args, code, stdout, stderr }) + '\n');
      resolve({ code, stdout, stderr });
    });
  });
}
const body = (r) => { if (r.code !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim() ? JSON.parse(r.stdout).result : {}; };
async function ownedPane(id) {
  if (state.panes.includes(id)) return;
  // Late default-layout children must have a live identity and scratch cwd;
  // a list row or a workspace-shaped ID never grants a capability.
  const pane = body(await real(['pane', 'get', id])).pane;
  if (!pane || pane.pane_id !== id || !pane.workspace_id || !pane.foreground_cwd) {
    throw new ReceiptLimit(`live pane identity/cwd receipt unavailable: ${id}`);
  }
  if (!state.workspaces.includes(pane.workspace_id) || !inside(pane.foreground_cwd)) {
    throw new CapabilityRefusal(`unowned panes: ${id}; live workspace/cwd proof failed`);
  }
  await updateOwnership((latest) => {
    if (!latest.workspaces.includes(pane.workspace_id)) throw new CapabilityRefusal('late pane workspace has no creation receipt');
    latest.panes = [...new Set([...latest.panes, id])];
    latest.latePanes = [...(latest.latePanes ?? []), { pane_id: id, workspace_id: pane.workspace_id, cwd: pane.foreground_cwd }];
  });
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
try {
  const [group, verb, target] = argv;
  if (group === 'notification' && verb === 'show') {
    // Notification UI is excluded; retain the candidate's attempt in scratch.
    fs.appendFileSync(path.join(root, 'notifications.jsonl'), JSON.stringify(argv) + '\n');
    process.stdout.write('{"result":{}}\n'); process.exit(0);
  }
  if (group === 'workspace' && verb === 'create') safePath(requireOption('--cwd'));
  else if (group === 'workspace' && verb === 'list') { /* filtered below */ }
  else if (group === 'workspace' && ['get', 'close'].includes(verb)) owned(target, 'workspaces');
  else if (group === 'worktree' && ['create', 'open', 'list', 'remove'].includes(verb)) {
    if (argv.includes('--workspace')) owned(option('--workspace'), 'workspaces');
    else safePath(requireOption('--cwd'));
    if (['create', 'open'].includes(verb)) safePath(requireOption('--path'));
    if (verb === 'remove') throw new CapabilityRefusal('Herdr worktree remove changes focus; close the owned workspace and remove the checkout through Git');
  } else if (group === 'tab' && ['list', 'create'].includes(verb)) {
    owned(requireOption('--workspace'), 'workspaces');
    if (argv.includes('--cwd')) safePath(option('--cwd'));
  } else if (group === 'tab' && ['get', 'close'].includes(verb)) owned(target, 'tabs');
  else if (group === 'pane' && verb === 'list') owned(requireOption('--workspace'), 'workspaces');
  else if (group === 'pane' && verb === 'process-info') await ownedPane(requireOption('--pane'));
  else if (group === 'pane' && ['get', 'read', 'run', 'report-agent', 'release-agent'].includes(verb)) {
    await ownedPane(target);
    if (verb === 'run' && !['worker.mjs', 'live-worker.mjs'].some((f) => argv[3].startsWith(`${quote(process.execPath)} ${quote(path.join(root, f))} `))) {
      throw new CapabilityRefusal('pane run permits only the scripted stand-in');
    }
  } else if (group === 'agent' && verb === 'list') { /* filtered below */ }
  else if (group === 'agent' && ['get', 'read', 'wait', 'prompt', 'send-keys', 'rename', 'start'].includes(verb)) {
    if (verb === 'start') await ownedPane(requireOption('--pane'));
    else if (state.panes.includes(target)) { /* owned pane */ }
    else {
      const agent = body(await real(['agent', 'get', target])).agent;
      await ownedPane(agent.pane_id);
    }
  } else throw new CapabilityRefusal(`unsupported Herdr operation: ${group} ${verb}`);

  // Check the live cwd too: stale names and moved panes cannot escape the grant.
  if ((group === 'pane' && ['run', 'report-agent', 'release-agent'].includes(verb)) || (group === 'agent' && ['start', 'send-keys'].includes(verb))) {
    const id = group === 'pane' ? target : verb === 'start' ? option('--pane') : state.panes.includes(target) ? target : body(await real(['agent', 'get', target])).agent.pane_id;
    let pane;
    for (let attempt = 0; attempt < 50; attempt++) {
      pane = body(await real(['pane', 'get', id])).pane;
      if (pane.foreground_cwd && inside(pane.foreground_cwd)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!pane.foreground_cwd) throw new ReceiptLimit('pane cwd receipt unavailable');
    if (!inside(pane.foreground_cwd)) throw new CapabilityRefusal('pane cwd left scratch');
  }
  if (group === 'agent' && verb === 'start') {
    const pane = option('--pane');
    const command = [process.execPath, path.join(root, 'worker.mjs'), root, 'worker', target].map(quote).join(' ');
    body(await real(['pane', 'run', pane, command]));
    for (let attempt = 0; attempt < 60; attempt++) {
      const r = await real(['agent', 'get', pane]);
      if (r.code === 0 && body(r).agent?.agent_status === 'idle') break;
      if (attempt === 59) throw new Error('stand-in did not register');
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = await real(['agent', 'rename', pane, target]);
    body(r); process.stdout.write(r.stdout); process.exit(0);
  }
  // report-agent describes a script's lifecycle, but Herdr intentionally refuses
  // agent prompt when its foreground executable is not a harness. For stand-ins
  // only, transport through the raw owned PTY and wait for a script receipt.
  if (group === 'agent' && verb === 'prompt') {
    const agent = body(await real(['agent', 'get', target])).agent;
    const ready = path.join(root, 'script-panes', agent.pane_id);
    if (fs.existsSync(ready)) {
      const role = fs.readFileSync(ready, 'utf8');
      const receipt = path.join(root, `${role}-input.jsonl`);
      const before = fs.existsSync(receipt) ? fs.statSync(receipt).size : 0;
      body(await real(['pane', 'send-text', agent.pane_id, argv[3]]));
      body(await real(['pane', 'send-keys', agent.pane_id, 'Enter']));
      for (let attempt = 0; attempt < 100; attempt++) {
        if (fs.existsSync(receipt) && fs.statSync(receipt).size > before) {
          process.stdout.write('{"result":{}}\n'); process.exit(0);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('script did not acknowledge PTY prompt');
    }
  }
  const args = [...argv];
  if (['workspace', 'worktree', 'tab'].includes(group) && ['create', 'open'].includes(verb)) {
    if (args.includes('--focus')) throw new CapabilityRefusal('focus changes forbidden');
    if (!args.includes('--no-focus')) args.push('--no-focus');
    if (['workspace', 'tab'].includes(group)) {
      const shell = path.join(root, 'shell');
      fs.mkdirSync(shell, { recursive: true });
      fs.writeFileSync(path.join(shell, '.zshrc'), `PROMPT='acceptance%# '\nprintf '\\033]7;file://localhost%s\\007' "$PWD"\nprintf '\\033]2;acceptance:%s\\007' "$PWD"\n: > ${quote(path.join(shell, 'ready-'))}$HERDR_PANE_ID\n`);
      args.push('--env', `ZDOTDIR=${shell}`, '--env', `HISTFILE=${path.join(shell, 'history')}`);
    }
  }
  const result = await real(args);
  if (result.code === 0) {
    if (verb === 'read' && !result.stdout.trim().startsWith('{')) {
      process.stdout.write(result.stdout); process.exit(0);
    }
    const value = result.stdout.trim() ? JSON.parse(result.stdout) : { result: {} };
    const r = value.result;
    if (['create', 'open'].includes(verb)) {
      const workspace = r.workspace ?? r.open_result?.workspace;
      const pane = r.root_pane ?? r.open_result?.root_pane;
      const tab = r.tab ?? r.open_result?.tab;
      // A new workspace can contain an extra initial shell tab not named in
      // worktree.create's root receipt. Its topology belongs to this scratch
      // workspace too; collect opaque child receipts, never infer their IDs.
      const children = { panes: [], tabs: [] };
      if (workspace?.workspace_id) {
        for (const [kind, collection] of [['pane', 'panes'], ['tab', 'tabs']]) {
          let topology;
          try { topology = body(await real([kind, 'list', '--workspace', workspace.workspace_id])); }
          catch (error) { throw new ReceiptLimit(`pane-layout receipt unavailable: ${error.message}`); }
          for (const item of topology[collection] ?? []) {
            if (item.workspace_id && item.workspace_id !== workspace.workspace_id) throw new ReceiptLimit('creation topology escaped its workspace');
            children[collection].push(item[`${kind}_id`]);
          }
        }
      }
      await updateOwnership((latest) => {
        if (workspace?.workspace_id) latest.workspaces.push(workspace.workspace_id);
        if (pane?.pane_id) latest.panes.push(pane.pane_id);
        if (tab?.tab_id) latest.tabs.push(tab.tab_id);
        for (const collection of ['panes', 'tabs']) latest[collection] = [...new Set([...latest[collection], ...children[collection]])];
      });
      if (pane?.pane_id && ['workspace', 'tab'].includes(group)) {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          if (fs.existsSync(path.join(root, 'shell', `ready-${pane.pane_id}`))) { ready = true; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!ready) throw new ReceiptLimit('created shell never reached its scratch startup receipt');
      }
    }
    if (group === 'workspace' && verb === 'list') r.workspaces = r.workspaces.filter((w) => state.workspaces.includes(w.workspace_id));
    if (group === 'agent' && verb === 'list') r.agents = r.agents.filter((a) => state.panes.includes(a.pane_id));
    process.stdout.write(JSON.stringify(value) + '\n');
  } else body(result);
} catch (error) {
  fs.appendFileSync(path.join(root, 'denied.jsonl'), JSON.stringify({ argv, error: error.message }) + '\n');
  process.stderr.write(JSON.stringify({ error: { code: error instanceof CapabilityRefusal ? 'acceptance_product_boundary' : 'acceptance_harness_limit', message: error.message } }) + '\n');
  process.exitCode = 1;
}
