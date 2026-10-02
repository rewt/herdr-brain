#!/usr/bin/env node
// Capability boundary for acceptance. Never forwards a target not returned by
// creation in this run, and never launches a model executable.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = fs.realpathSync(process.env.ACCEPTANCE_ROOT);
const ledger = path.join(root, 'ownership.json');
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(ledger, 'utf8'));
const inside = (p) => {
  const r = path.relative(root, fs.realpathSync(p));
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
};
const option = (key) => argv[argv.indexOf(key) + 1];
const requireOption = (key) => { if (!argv.includes(key)) throw new Error(`explicit ${key} required`); return option(key); };
const owned = (id, collection) => { if (!state[collection].includes(id)) throw new Error(`unowned ${collection}: ${id}`); };
function safePath(p) {
  let ancestor = path.resolve(p);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!inside(ancestor)) throw new Error(`path outside scratch: ${p}`);
}
let child;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child?.kill(signal); process.exit(1); });
async function real(args) {
  return await new Promise((resolve, reject) => {
    child = spawn(state.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => { stdout += v; });
    child.stderr.on('data', (v) => { stderr += v; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 35_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.appendFileSync(path.join(root, 'herdr.jsonl'), JSON.stringify({ args, code, stdout, stderr }) + '\n');
      resolve({ code, stdout, stderr });
    });
  });
}
const body = (r) => { if (r.code !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim() ? JSON.parse(r.stdout).result : {}; };
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
try {
  const [group, verb, target] = argv;
  if (group === 'workspace' && verb === 'create') safePath(requireOption('--cwd'));
  else if (group === 'workspace' && verb === 'list') { /* filtered below */ }
  else if (group === 'workspace' && ['get', 'close'].includes(verb)) owned(target, 'workspaces');
  else if (group === 'worktree' && ['create', 'open', 'list', 'remove'].includes(verb)) {
    if (argv.includes('--workspace')) owned(option('--workspace'), 'workspaces');
    else safePath(requireOption('--cwd'));
    if (['create', 'open'].includes(verb)) safePath(requireOption('--path'));
    if (verb === 'remove' && argv.includes('--force')) throw new Error('forced worktree removal forbidden');
  } else if (group === 'tab' && ['list', 'create'].includes(verb)) {
    owned(requireOption('--workspace'), 'workspaces');
    if (argv.includes('--cwd')) safePath(option('--cwd'));
  } else if (group === 'tab' && ['get', 'close'].includes(verb)) owned(target, 'tabs');
  else if (group === 'pane' && verb === 'list') owned(requireOption('--workspace'), 'workspaces');
  else if (group === 'pane' && ['get', 'read', 'run', 'report-agent', 'release-agent'].includes(verb)) {
    owned(target, 'panes');
    if (verb === 'run' && !['worker.mjs', 'live-worker.mjs'].some((f) => argv[3].startsWith(`${quote(process.execPath)} ${quote(path.join(root, f))} `))) {
      throw new Error('pane run permits only the scripted stand-in');
    }
  } else if (group === 'agent' && verb === 'list') { /* filtered below */ }
  else if (group === 'agent' && ['get', 'read', 'wait', 'prompt', 'rename', 'start'].includes(verb)) {
    if (verb === 'start') owned(requireOption('--pane'), 'panes');
    else if (state.panes.includes(target)) { /* owned pane */ }
    else {
      const agent = body(await real(['agent', 'get', target])).agent;
      owned(agent.pane_id, 'panes');
    }
  } else throw new Error(`unsupported Herdr operation: ${group} ${verb}`);

  // Check the live cwd too: stale names and moved panes cannot escape the grant.
  if ((group === 'pane' && ['run', 'report-agent', 'release-agent'].includes(verb)) || (group === 'agent' && verb === 'start')) {
    const id = group === 'pane' ? target : option('--pane');
    let pane;
    for (let attempt = 0; attempt < 50; attempt++) {
      pane = body(await real(['pane', 'get', id])).pane;
      if (pane.foreground_cwd && inside(pane.foreground_cwd)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!pane.foreground_cwd || !inside(pane.foreground_cwd)) throw new Error('pane cwd left scratch');
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
    if (args.includes('--focus')) throw new Error('focus changes forbidden');
    if (!args.includes('--no-focus')) args.push('--no-focus');
  }
  const result = await real(args);
  if (result.code === 0) {
    const value = result.stdout.trim() ? JSON.parse(result.stdout) : { result: {} };
    const r = value.result;
    if (['create', 'open'].includes(verb)) {
      const workspace = r.workspace ?? r.open_result?.workspace;
      const pane = r.root_pane ?? r.open_result?.root_pane;
      const tab = r.tab ?? r.open_result?.tab;
      const lock = path.join(root, 'ownership.lock');
      for (;;) {
        try { fs.mkdirSync(lock); break; }
        catch (e) { if (e.code !== 'EEXIST') throw e; await new Promise((r) => setTimeout(r, 25)); }
      }
      try {
        const latest = JSON.parse(fs.readFileSync(ledger, 'utf8'));
        if (workspace?.workspace_id) latest.workspaces.push(workspace.workspace_id);
        if (pane?.pane_id) latest.panes.push(pane.pane_id);
        if (tab?.tab_id) latest.tabs.push(tab.tab_id);
        const temp = `${ledger}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(latest)); fs.renameSync(temp, ledger);
      } finally { fs.rmdirSync(lock); }
    }
    if (group === 'workspace' && verb === 'list') r.workspaces = r.workspaces.filter((w) => state.workspaces.includes(w.workspace_id));
    if (group === 'agent' && verb === 'list') r.agents = r.agents.filter((a) => state.panes.includes(a.pane_id));
    process.stdout.write(JSON.stringify(value) + '\n');
  } else { process.stderr.write(result.stderr || result.stdout); process.exitCode = result.code ?? 1; }
} catch (error) {
  fs.appendFileSync(path.join(root, 'denied.jsonl'), JSON.stringify({ argv, error: error.message }) + '\n');
  process.stderr.write(JSON.stringify({ error: { code: 'acceptance_boundary', message: error.message } }) + '\n');
  process.exitCode = 1;
}
