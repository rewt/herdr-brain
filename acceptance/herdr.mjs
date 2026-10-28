#!/usr/bin/env node
// Capability boundary for acceptance. Never forwards a target not returned by
// creation or a verified late-pane receipt in this run. Native model sessions
// launch only through this run's confined live worker.
import { loadTimeout } from './deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { saveCreation, creationTargets, saveCreationIntent, recoverCreations } from './receipts.mjs';
import { registerProducer, assertProducing } from './producers.mjs';
import { isLaneEnvironmentCommand } from './environment.mjs';
import { pollNative } from './poll.mjs';

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
class FocusRefusal extends CapabilityRefusal {}
const option = (key) => argv[argv.indexOf(key) + 1];
const requireOption = (key) => { if (!argv.includes(key)) throw new CapabilityRefusal(`explicit ${key} required`); return option(key); };
const owned = (id, collection) => { if (!state[collection].includes(id)) throw new CapabilityRefusal(`unowned ${collection}: ${id}`); };
class ReceiptLimit extends Error {}
async function updateOwnership(change) {
  const lock = path.join(root, 'ownership.lock');
  const deadline = Date.now() + loadTimeout(10_000);
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new ReceiptLimit('ownership lock timed out; creation receipts retained');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
let child, producer, interrupted = false;
const agentPanes = new Map();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  interrupted = true;
  // Let the close handler persist any creation reply already in the pipe.
  child?.kill(signal);
});
async function real(args) {
  assertProducing(root);
  if (interrupted) throw new ReceiptLimit('adapter interrupted; no further native commands allowed');
  const mutating = !['list', 'get', 'read', 'wait', 'process-info'].includes(args[1]);
  const id = `${process.pid}:${Date.now()}:${Math.random()}`;
  const focusCalls = path.join(root, 'evidence', 'focus-calls.jsonl');
  const agentPane = args[0] === 'agent' ? agentPanes.get(args[2]) : undefined;
  const targets = agentPane ? { panes: [agentPane], workspaces: [] } : undefined;
  const traceCall = (type, extra = {}) => {
    if (mutating && fs.existsSync(path.dirname(focusCalls))) fs.appendFileSync(focusCalls,
      JSON.stringify({ type, id, at: Date.now(), args, requested: argv, origin: process.env.ACCEPTANCE_CALLER ?? 'product', actor: process.env.ORG_ACTOR, ...(targets ? { targets } : {}), ...extra }) + '\n');
  };
  traceCall('start');
  return await new Promise((resolve, reject) => {
    child = spawn(state.binary, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(state.socketPath ? { HERDR_SOCKET_PATH: state.socketPath } : {}) } });
    producer.child(child.pid);
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => { stdout += v; });
    child.stderr.on('data', (v) => { stderr += v; });
    const active = child;
    child.on('error', error => { reject(error); });
    child.on('close', (code) => {
      producer.child(active.pid, false);
      let created;
      if (['workspace', 'worktree', 'tab'].includes(args[0]) && ['create', 'open'].includes(args[1])) {
        let result;
        try { result = JSON.parse(stdout).result; } catch { /* caller reports malformed reply */ }
        if (result) {
          try {
            const targets = saveCreation(root, args, result);
            created = { panes: targets.panes, workspaces: targets.workspaces };
          } catch (error) { reject(new ReceiptLimit(`creation receipt persistence failed: ${error.message}`)); return; }
        }
      }
      traceCall('end', created ? { created } : {});
      fs.appendFileSync(path.join(root, 'herdr.jsonl'), JSON.stringify({ args, code, stdout, stderr }) + '\n');
      resolve({ code, stdout, stderr });
    });
  });
}
const body = (r) => {
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  const result = r.stdout.trim() ? JSON.parse(r.stdout).result : {};
  if (result.agent?.name && result.agent?.pane_id) agentPanes.set(result.agent.name, result.agent.pane_id);
  return result;
};
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
  producer = registerProducer(root, 'adapter');
  const [group, verb, target] = argv;
  if (['focus', 'attach', 'zoom'].includes(verb)) throw new FocusRefusal(`focus changes forbidden: ${group} ${verb}`);
  if (group === 'worktree' && verb === 'remove') throw new FocusRefusal('Herdr worktree remove changes focus; remove the checkout through Git before closing the owned workspace');
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
  } else if (group === 'tab' && ['list', 'create'].includes(verb)) {
    owned(requireOption('--workspace'), 'workspaces');
    if (argv.includes('--cwd')) safePath(option('--cwd'));
  } else if (group === 'tab' && ['get', 'close', 'rename'].includes(verb)) owned(target, 'tabs');
  else if (group === 'pane' && verb === 'list') owned(requireOption('--workspace'), 'workspaces');
  else if (group === 'pane' && verb === 'process-info') await ownedPane(requireOption('--pane'));
  else if (group === 'pane' && ['get', 'read', 'run', 'report-agent', 'release-agent'].includes(verb)) {
    await ownedPane(target);
    if (verb === 'run' && !isLaneEnvironmentCommand(argv[3], root) &&
        !['worker.mjs', 'live-worker.mjs', 'entry-session.mjs'].some((f) => argv[3].startsWith(`${quote(process.execPath)} ${quote(path.join(root, f))} `))) {
      throw new CapabilityRefusal('pane run permits only the scripted stand-in or private lane environment handoff');
    }
  } else if (group === 'agent' && verb === 'list') { /* filtered below */ }
  else if (group === 'agent' && ['get', 'read', 'wait', 'prompt', 'send-keys', 'rename', 'start'].includes(verb)) {
    if (verb === 'start') await ownedPane(requireOption('--pane'));
    else if (state.panes.includes(target)) { /* owned pane */ }
    else {
      const agent = body(await real(['agent', 'get', target])).agent;
      agentPanes.set(target, agent.pane_id);
      await ownedPane(agent.pane_id);
    }
  } else throw new CapabilityRefusal(`unsupported Herdr operation: ${group} ${verb}`);

  // Check the live cwd too: stale names and moved panes cannot escape the grant.
  if ((group === 'pane' && ['run', 'report-agent', 'release-agent'].includes(verb)) || (group === 'agent' && ['start', 'send-keys'].includes(verb))) {
    const id = group === 'pane' ? target : verb === 'start' ? option('--pane') : state.panes.includes(target) ? target : body(await real(['agent', 'get', target])).agent.pane_id;
    let pane;
    try {
      await pollNative(async deadline => {
        pane = body(await real(['pane', 'get', id], { deadline })).pane;
        if (pane?.foreground_cwd && !inside(pane.foreground_cwd)) throw new CapabilityRefusal('pane cwd left scratch');
        return pane.foreground_cwd && inside(pane.foreground_cwd);
      }, 'pane cwd did not become ready', 5000);
    } catch (error) {
      if (pane?.foreground_cwd && !inside(pane.foreground_cwd)) throw new CapabilityRefusal('pane cwd left scratch');
      throw new ReceiptLimit(error.message);
    }
    if (!pane.foreground_cwd) throw new ReceiptLimit('pane cwd receipt unavailable');
    if (!inside(pane.foreground_cwd)) throw new CapabilityRefusal('pane cwd left scratch');
  }
  if (group === 'agent' && verb === 'start') {
    const pane = option('--pane');
    // report-agent registers the script as Codex. Give its real executable the
    // same name so retirement sees an honest kernel/foreground match. Keep the
    // forbidden model executables in bin/ untouched; this is only a Node copy.
    const executable = path.join(root, 'script-runtime', 'codex');
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(executable)) {
      const temporary = `${executable}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, fs.readFileSync(process.execPath), { mode: 0o700, flag: 'wx' });
        fs.renameSync(temporary, executable);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    const command = [executable, path.join(root, 'worker.mjs'), root, 'worker', target].map(quote).join(' ');
    body(await real(['pane', 'run', pane, command]));
    try {
      // pane.run acknowledges PTY input before the script can report its
      // lifecycle. An empty successful inventory is startup evidence, whereas
      // agent.get on that same not-yet-registered pane is a native refusal.
      // Wait for registration without issuing or retrying that refusal.
      await pollNative(async deadline => {
        const agents = body(await real(['agent', 'list'], { deadline })).agents;
        if (!Array.isArray(agents)) throw new Error('native agent inventory unavailable');
        const observed = agents.find(agent => agent.pane_id === pane);
        return observed?.agent_status === 'idle';
      }, 'stand-in did not register', 6000);
      const observed = body(await real(['agent', 'get', pane])).agent;
      if (observed?.pane_id !== pane || observed.agent_status !== 'idle') throw new Error('registered stand-in identity/readiness changed');
    } catch (error) { throw new ReceiptLimit(`stand-in did not register: ${error.message}`); }
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
      // Scripted readline needs a byte delimiter. Native Enter can use the
      // pane's keyboard encoding; it is not necessarily a newline on stdin.
      const text = argv[3].endsWith('\n') ? argv[3] : argv[3] + '\n';
      body(await real(['pane', 'send-text', agent.pane_id, text]));
      body(await real(['pane', 'send-keys', agent.pane_id, 'Enter']));
      const deadline = Date.now() + loadTimeout(10_000);
      while (Date.now() < deadline) {
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
    if (args.includes('--focus')) throw new FocusRefusal('focus changes forbidden');
    if (!args.includes('--no-focus')) args.push('--no-focus');
    if (['workspace', 'tab'].includes(group)) {
      const shell = path.join(root, 'shell');
      fs.mkdirSync(shell, { recursive: true });
      fs.writeFileSync(path.join(shell, '.zshrc'), `PROMPT='acceptance%# '\nprintf '\\033]7;file://localhost%s\\007' "$PWD"\nprintf '\\033]2;acceptance:%s\\007' "$PWD"\n: > ${quote(path.join(shell, 'ready-'))}$HERDR_PANE_ID\n`);
      args.push('--env', `ZDOTDIR=${shell}`, '--env', `HISTFILE=${path.join(shell, 'history')}`);
    }
  }
  let intent;
  if ((group === 'workspace' && verb === 'create') || (group === 'worktree' && ['create', 'open'].includes(verb))) {
    const recoveryLabel = !args.includes('--label');
    if (recoveryLabel) args.push('--label', `acceptance-recovery-${randomUUID()}`);
    const before = body(await real(['workspace', 'list'])).workspaces;
    if (!Array.isArray(before)) throw new ReceiptLimit('pre-creation workspace inventory unavailable');
    intent = saveCreationIntent(root, args, before, argv.includes('--cwd') ? fs.realpathSync(option('--cwd')) : undefined, recoveryLabel);
  }
  const result = await real(args);
  if (intent && !interrupted) {
    const after = body(await real(['workspace', 'list'])).workspaces;
    if (!Array.isArray(after)) throw new ReceiptLimit('post-creation workspace inventory unavailable');
    for (const workspace of await recoverCreations(intent, after, async args => body(await real(args)))) {
      saveCreation(root, args, { workspace });
      await updateOwnership(latest => { latest.workspaces = [...new Set([...latest.workspaces, workspace.workspace_id])]; });
    }
  }
  if (interrupted) throw new ReceiptLimit('adapter interrupted; creation receipts retained for cleanup');
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
      // Grant root receipts before optional topology/startup probes can fail.
      await updateOwnership((latest) => {
        const targets = creationTargets(r);
        for (const collection of ['workspaces', 'panes', 'tabs']) {
          latest[collection] = [...new Set([...latest[collection], ...targets[collection]])];
        }
      });
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
        for (const collection of ['panes', 'tabs']) latest[collection] = [...new Set([...latest[collection], ...children[collection]])];
      });
      if (pane?.pane_id && ['workspace', 'tab'].includes(group)) {
        let ready = false;
        const deadline = Date.now() + loadTimeout(10_000);
        while (Date.now() < deadline) {
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
  if (error instanceof FocusRefusal) {
    // A caller may suppress the non-zero reply and succeed via a fallback.
    // Keep an independent typed receipt for the final full-run focus verdict.
    const evidence = path.join(root, 'evidence');
    fs.mkdirSync(evidence, { recursive: true });
    fs.appendFileSync(path.join(evidence, 'focus-calls.jsonl'), JSON.stringify({
      type: 'forbidden-focus', id: `${process.pid}:${Date.now()}`, at: Date.now(),
      args: argv, requested: argv, error: error.message,
    }) + '\n');
  }
  fs.appendFileSync(path.join(root, 'denied.jsonl'), JSON.stringify({ argv, error: error.message }) + '\n');
  process.stderr.write(JSON.stringify({ error: { code: error instanceof CapabilityRefusal ? 'acceptance_product_boundary' : 'acceptance_harness_limit', message: error.message } }) + '\n');
  process.exitCode = 1;
} finally { producer?.release(); }
