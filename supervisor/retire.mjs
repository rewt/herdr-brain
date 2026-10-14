#!/usr/bin/env node
// Read-only observation and the shared guarded retirement adapter. No schedule.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { loadTimeout } from '../lib/deadline.mjs';
import { findOrgDir, loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { consumeRetirement } from '../lib/retire-trigger.mjs';
import { ownerAlive } from '../lib/process-owner.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { planRetirement, executeRetirement, laneRemovalReason } from '../lib/retire.mjs';
import { holderState, slotPathOf, TEST_SLOT_PATH, COMPAT_PATH_ENV } from '../test-slot/test-slot.mjs';
import { readTestSlotQueue } from '../test-slot/ticket-queue.mjs';

const canonical = file => {
  if (!file) return file;
  let parent = path.resolve(file), suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(parent), ...suffix); }
    catch (e) { if (e.code !== 'ENOENT') throw e; const next = path.dirname(parent); if (next === parent) throw e;
      suffix.unshift(path.basename(parent)); parent = next; }
  }
};
const array = (data, name) => { if (!Array.isArray(data)) throw Error(`incomplete ${name}`); return data; };
const optional = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const shells = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish']);
export function isShellOnly(info) {
  const fg = info?.foreground_processes ?? [];
  return fg.length > 0 && fg.every(p => shells.has(p.name) || shells.has(p.argv0) || p.pid === info.shell_pid);
}

// The supervisor-owned contract has keep-only authority. Expiry is mandatory;
// unreadable/unknown files hold the project, even when apparently expired.
export function readDeclaredReferences(org, now = Date.now()) {
  const directory = path.join(org, 'references'), references = [], diagnostics = [], errors = [];
  let files;
  try { files = fs.readdirSync(directory).sort(); }
  catch (e) { if (e.code === 'ENOENT') return { references, diagnostics, errors }; return { references, diagnostics, errors: [`reference directory unreadable: ${e.message}`] }; }
  for (const name of files) {
    const file = path.join(directory, name);
    try {
      if (!fs.lstatSync(file).isFile()) throw Error('reference is not a regular JSON file');
      const ref = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (ref.schema !== 'herdr-reference/v1' || !['pending', 'running'].includes(ref.state) ||
          ['owner', 'kind', 'job', 'item', 'created_at', 'expires_at'].some(k => typeof ref[k] !== 'string' || !ref[k].trim()) ||
          ['run', 'lane', 'cwd', 'pane'].some(k => ref[k] !== undefined && (typeof ref[k] !== 'string' || !ref[k].trim())) ||
          !Number.isFinite(Date.parse(ref.created_at)) || !Number.isFinite(Date.parse(ref.expires_at)) ||
          (ref.cwd !== undefined && !path.isAbsolute(ref.cwd))) throw Error('invalid herdr-reference/v1');
      if (Date.parse(ref.expires_at) <= now) { diagnostics.push({ file, reason: 'expired reference ignored', job: ref.job }); continue; }
      references.push({ ...ref, ...(ref.cwd ? { cwd: canonical(ref.cwd) } : {}), source: file });
    } catch (e) { errors.push(`reference ${file}: ${e.message}; project kept`); }
  }
  return { references, diagnostics, errors };
}

export function readLiveReferences({ common, org, env = process.env, verifyStateDir, now = Date.now(), readOwner = ownerAlive } = {}) {
  const declared = org ? readDeclaredReferences(org, now) : { references: [], diagnostics: [], errors: [] };
  const { references, diagnostics, errors } = declared;
  const attempt = (name, fn) => { try { fn(); } catch (e) { errors.push(`${name} unreadable: ${e.message}; project kept`); } };
  const add = (kind, job) => references.push({ kind, job: job.id ?? job.job ?? job.label, item: job.item,
    run: job.run, lane: job.topic ?? job.lane, cwd: job.cwd ? canonical(job.cwd) : undefined,
    pane: job.pane, head: job.sha, label: job.label });
  attempt('promotion queue', () => {
    const queue = optional(path.join(common, 'promote/queue.json'));
    if (!queue) return;
    if (canonical(queue.identity) !== common || !Array.isArray(queue.pending) || !Array.isArray(queue.results)) throw Error('invalid identity or contents');
    const members = batch => batch?.jobs ?? (batch ? [batch] : []);
    for (const job of queue.pending) add('pending promote', job);
    for (const batch of queue.interrupted ?? []) for (const job of members(batch)) add('interrupted promote', job);
    for (const job of members(queue.current)) {
      const result = queue.current?.results?.find(m => m.job.id === job.id)?.result ?? queue.current?.result;
      // Once integration and reconciliation are durably complete, this is a
      // cleanup/delivery checkpoint, not another resource user or callback.
      if (result?.outcome === 'promoted' && result.reconciliation?.state !== 'pending' && !result.replacement_pending) continue;
      if (queue.current?.phase === 'promoted' && queue.current.tip) continue;
      add('current promote', job);
    }
    for (const job of queue.results) if (job.reconciliation?.state === 'pending') add('reconcile pending', job);
  });
  attempt('trusted verify queue', () => {
    const directory = verifyStateDir ?? env.HERDR_RETIRE_VERIFY_STATE_DIR ?? path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'herdr-monitor/verify', createHash('sha256').update(common).digest('hex'));
    const queue = optional(path.join(directory, 'queue.json'));
    if (!queue) return;
    if (queue.schema !== 'verify-queue/v1' || canonical(queue.identity) !== common || !Array.isArray(queue.jobs)) throw Error('invalid verify identity or contents');
    for (const job of queue.jobs) if (!job.completed_at && (job.admission || job.started_at)) add('verify admitted or running', job);
  });
  if (org) attempt('settle callbacks', () => {
    const directory = path.join(org, 'settle');
    let files;
    try { files = fs.readdirSync(directory).filter(name => /^R-\d+\.json$/.test(name)); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const name of files) {
      const saved = optional(path.join(directory, name));
      if (!saved || !saved.common || !saved.run || !saved.stage) throw Error(`invalid settle callback ${name}`);
      if (canonical(saved.common) !== common || saved.stage === 'complete') continue;
      add('settle callback', { ...saved, id: saved.run, cwd: saved.workspace });
    }
  });
  for (const lock of new Set([slotPathOf(env), env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH])) attempt('host test slot', () => {
    const holder = optional(lock);
    if (holder && holderState(holder).state !== 'gone') {
      if (!holder.cwd && !holder.label) throw Error('unknown holder target');
      add('test-slot holder', holder);
    }
    for (const row of readTestSlotQueue(lock).tickets) if (!['gone', 'expired'].includes(row.state)) {
      if (!row.ticket?.cwd && !row.ticket?.label) throw Error('unknown waiter target');
      add('test-slot waiter', row.ticket);
    }
  });
  return { references, diagnostics, errors, readOwner };
}

export function createRetirement({ cwd = process.cwd(), org, herdr = process.env.HERDR_RETIRE_HERDR ?? 'herdr', record,
  command = spawnSync, selfTab = process.env.HERDR_TAB_ID ?? null, main,
  env = process.env, log = () => {}, verifyStateDir, readOwner = ownerAlive, allowAbsentHerdr = false, selfRetirement } = {}) {
  if (selfRetirement && (selfRetirement.pid !== process.pid || selfRetirement.tab !== env.HERDR_TAB_ID || selfRetirement.pane !== env.HERDR_PANE_ID)) throw Error('self-retirement must name this process and its own Herdr tab and pane');
  const invoke = (exe, args) => {
    const r = command(exe, args, { cwd, encoding: 'utf8', timeout: loadTimeout(10000), maxBuffer: 64 * 1024 * 1024,
      env: { ...env, ORG_DIR: org } });
    if (r.error || r.status !== 0) throw Object.assign(Error(`${exe} ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.error?.message || r.stdout || `exit ${r.status}`).trim()}`), { code: r.error?.code });
    return r.stdout.trim();
  };
  const json = text => { const d = JSON.parse(text); if (d.error) throw Error(JSON.stringify(d.error)); return d.result ?? d; };
  const h = args => json(invoke(herdr, args));
  const git = (root, args) => invoke('git', ['-C', root, ...args]);
  const commonAt = root => canonical(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const common = commonAt(cwd);
  const canonicalRoot = canonical(git(cwd, ['worktree', 'list', '--porcelain']).split('\n').find(line => line.startsWith('worktree '))?.slice(9));
  if (!canonicalRoot || commonAt(canonicalRoot) !== common) throw Error('canonical checkout identity is unavailable');
  main ??= git(canonicalRoot, ['symbolic-ref', '--short', 'HEAD']);
  org ??= findOrgDir({ cwd, env });
  function observe(workspacePath) {
    if (commonAt(cwd) !== common || commonAt(canonicalRoot) !== common) throw Error('canonical common directory changed');
    const readRecord = () => {
      const loaded = org ? loadEvents(org) : { events: [], tornTail: false };
      if (loaded.tornTail) throw Error('incomplete record tail');
      const events = loaded.events;
      const state = record ? json(invoke(record[0], [...record.slice(1), 'status', '--json'])) : fold(events);
      const runs = state.runs instanceof Map ? [...state.runs.values()] : array(state.runs, 'record runs');
      const items = state.items instanceof Map ? [...state.items.values()] : array(state.items, 'record items');
      return { state, events, runs, items };
    };
    let { state, events = [], runs = [], items = [] } = workspacePath ? readRecord() : {};
    const successorWorkspaces = new Set(events.filter(e => e.type === 'retirement.handoff' && runs.some(r => r.id === e.from && canonical(r.workspace) === canonical(workspacePath))).map(e => runs.find(r => r.id === e.to)?.meta?.worker_workspace));
    let all, absent = false;
    try { all = array(h(['workspace', 'list']).workspaces, 'workspaces'); }
    catch (e) {
      // Only an absent executable proves this host has no Herdr panes. A
      // present CLI with an unreadable server remains an observation failure.
      const installed = (herdr.includes(path.sep) ? [path.resolve(cwd, herdr)] : (env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, herdr))).some(file => fs.existsSync(file));
      if (!allowAbsentHerdr || e.code !== 'ENOENT' || installed) throw e;
      all = []; absent = true;
    }
    const workspaces = all.filter(w => {
      const wt = w.worktree;
      // Include mismatched metadata for this path/repository so it causes a
      // refusal; filtering it out would let Git-only removal lose an occupant.
      return wt && (canonical(wt.repo_key) === common || (workspacePath && canonical(wt.checkout_path) === canonical(workspacePath))) &&
        (!workspacePath || canonical(wt.checkout_path) === canonical(workspacePath) || successorWorkspaces.has(w.workspace_id));
    }).map(w => ({ ...w, worktree: { ...w.worktree, checkout_path: canonical(w.worktree.checkout_path), repo_key: canonical(w.worktree.repo_key) } }));
    const tabs = [], panes = [], gitState = [], errors = [];
    for (const ws of workspaces) {
      const wt = ws.worktree, root = wt.checkout_path;
      for (const tab of array(h(['tab', 'list', '--workspace', ws.workspace_id]).tabs, 'tabs')) tabs.push({ ...tab, workspace_id: ws.workspace_id });
      for (const pane of array(h(['pane', 'list', '--workspace', ws.workspace_id]).panes, 'panes')) {
        const info = h(['pane', 'process-info', '--pane', pane.pane_id]).process_info;
        if (!info || !Array.isArray(info.foreground_processes)) throw Error('incomplete process info');
        panes.push({ ...pane, workspace_id: ws.workspace_id, process_info: info, shellOnly: isShellOnly(info) });
      }
      try {
        const identity = commonAt(root);
        if (!wt.repo_root || commonAt(wt.repo_root) !== common || identity !== common || wt.repo_key !== common) throw Error('worktree metadata/common directory mismatch');
        const head = git(root, ['rev-parse', 'HEAD']);
        let branch = null; try { branch = git(root, ['symbolic-ref', '--short', 'HEAD']); } catch {}
        let integrated = false;
        try { git(root, ['merge-base', '--is-ancestor', head, main]); integrated = true; } catch {}
        gitState.push({ path: root, common: identity, head, branch, lane: branch?.startsWith('lane/') ? branch.slice(5) : null,
          clean: !git(root, ['status', '--porcelain']), integrated });
      } catch (e) { gitState.push({ path: root, common: wt.repo_key, error: `Git observation ${root}: ${e.message}` }); }
    }
    let processRows;
    for (const pane of panes) {
      const info = pane.process_info;
      // A complete tree from the configured Herdr reader is useful for offline
      // adapters. Current Herdr supplies foreground rows, so use the shared
      // native source to include background descendants and birth identities.
      if (info.process_tree_complete === true && Array.isArray(info.process_tree)) continue;
      processRows ??= lookupProcess(undefined, { identityOnly: true });
      if (!processRows.ok) { errors.push(processRows.error); continue; }
      const roots = new Set([info.shell_pid, ...info.foreground_processes.map(p => p.pid)]);
      const tree = [...processRows.value.values()].filter(row => {
        const seen = new Set();
        for (let pid = row.pid; !seen.has(pid); pid = processRows.value.get(pid)?.ppid) {
          if (roots.has(pid)) return true;
          if (!processRows.value.has(pid)) break;
          seen.add(pid);
        }
        return false;
      }).filter(row => !/^[ZX]/.test(row.state));
      pane.process_info = { ...info, process_tree_complete: true, process_tree: tree };
    }
    // A Git-only lane may have no Herdr workspace. Its path/head/common still
    // participate in the removal guard and in matching queued job references.
    if (workspacePath && !gitState.some(g => g.path === canonical(workspacePath))) {
      const root = canonical(workspacePath);
      try {
        const identity = commonAt(root), head = git(root, ['rev-parse', 'HEAD']);
        const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
        if (identity !== common) throw Error('lane common directory differs');
        gitState.push({ path: root, common: identity, head, branch,
          lane: branch.startsWith('lane/') ? branch.slice(5) : null, clean: !git(root, ['status', '--porcelain']) });
      } catch (e) { gitState.push({ path: root, error: `Git observation ${root}: ${e.message}` }); }
    }
    const agents = absent ? [] : array(h(['agent', 'list']).agents, 'agents').map(a => ({ ...a, cwd: canonical(a.cwd) }));
    ({ state, events, runs, items } = readRecord());
    const refs = readLiveReferences({ common, org, env, verifyStateDir });
    for (const run of runs) if (run.meta?.watcher_pid) {
      try { if (readOwner({ pid: Number(run.meta.watcher_pid), identity: run.meta.watcher_identity })) refs.references.push({ kind: 'watcher callback', job: run.id, run: run.id, cwd: canonical(run.workspace), pid: Number(run.meta.watcher_pid), identity: run.meta.watcher_identity }); }
      catch (e) { refs.references.push({ kind: 'unknown watcher callback', job: run.id, run: run.id, cwd: canonical(run.workspace) }); refs.diagnostics.push({ run: run.id, reason: e.message }); }
    }
    const callbacks = [];
    if (org) try {
      const directory = path.join(org, 'retirement/occupants');
      if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
        const receipt = optional(path.join(directory, name));
        if (receipt?.schema !== 'retirement-occupant/v1' || !['watcher', 'settle', 'executive', 'plan'].includes(receipt.kind) ||
            ['common', 'cwd', 'workspace', 'tab', 'pane'].some(k => typeof receipt[k] !== 'string' || !receipt[k]) ||
            [receipt.shell, receipt.process].some(p => !Number.isSafeInteger(p?.pid) || p.pid < 1 || typeof p.identity !== 'string' || !p.identity || !p.command)) throw Error(`invalid callback receipt ${name}`);
        if (canonical(receipt.common) !== common) continue;
        let process_gone = false;
        try { process_gone = !readOwner(receipt.process); } catch (e) { refs.diagnostics.push({ file: name, reason: e.message }); }
        callbacks.push({ ...receipt, cwd: canonical(receipt.cwd), common, process_gone });
      }
    } catch (e) { errors.push(`callback receipts unreadable: ${e.message}; project kept`); }
    // Our synchronous observation helpers have exited by now. For narrow
    // self-retirement, discard only descendants proved gone by birth identity;
    // a surviving child or an unreadable process source still keeps the tab.
    if (selfRetirement?.pid === process.pid) for (const p of panes.filter(p => p.pane_id === selfRetirement.pane)) {
      p.process_info.process_tree = p.process_info.process_tree?.filter(row => {
        if (row.pid === p.process_info.shell_pid || row.pid === process.pid) return true;
        try { return readOwner(row); } catch { return true; }
      });
    }
    return { common, workspaces, tabs, panes, agents, git: gitState,
      record: { runs: runs.map(r => ({ ...r, workspace: canonical(r.workspace) })), items, links: state.links ?? [], revision: state.eventCount },
      references: refs.references, errors: [...errors, ...refs.errors], diagnostics: refs.diagnostics, selfTab,
      handoffs: events.filter(e => e.type === 'retirement.handoff'),
      callbacks, selfRetirement,
    };
  }
  const plan = workspacePath => {
    const snapshot = observe(workspacePath), result = planRetirement(snapshot);
    if (!workspacePath) return result;
    const ids = new Set(snapshot.workspaces.filter(w => w.worktree.checkout_path === canonical(workspacePath)).map(w => w.workspace_id));
    return { ...result, close: result.close.filter(t => ids.has(t.workspace_id)), keep: result.keep.filter(t => ids.has(t.workspace_id)) };
  };
  const recordCallback = ({ kind, pane: paneId, pid, run, agent }) => {
    if (!org) throw Error('callback launch needs a record');
    const snapshot = observe(), p = snapshot.panes.find(p => p.pane_id === paneId);
    const ws = snapshot.workspaces.find(w => w.workspace_id === p?.workspace_id);
    const a = snapshot.agents.find(a => a.pane_id === paneId && a.name === agent);
    pid ??= p?.process_info.foreground_processes.filter(row => row.pid !== p.process_info.shell_pid).at(0)?.pid;
    const tree = p?.process_info.process_tree ?? [];
    const processRow = tree.find(row => row.pid === pid), shell = tree.find(row => row.pid === p?.process_info.shell_pid);
    if (!p || !ws || !processRow?.identity || !shell?.identity || (agent && !a) || !['watcher', 'settle', 'executive', 'plan'].includes(kind)) throw Error('callback launch identity is incomplete');
    const receipt = { schema: 'retirement-occupant/v1', kind, common, cwd: ws.worktree.checkout_path,
      workspace: ws.workspace_id, tab: p.tab_id, pane: paneId,
      shell: { pid: shell.pid, identity: shell.identity, command: shell.command }, process: { pid, identity: processRow.identity, command: processRow.command },
      ...(run ? { run } : {}), ...(a ? { agent: a.name, terminal_id: a.terminal_id, agent_session_id: a.agent_session?.value } : {}) };
    const file = path.join(org, 'retirement/occupants', createHash('sha256').update(p.tab_id).digest('hex') + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const previous = optional(file);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt) && readOwner(previous.process)) throw Error('callback launch receipt belongs to a live process');
    writeFileAtomic(file, JSON.stringify(receipt) + '\n');
    return receipt;
  };
  const apply = (planned = plan(), workspacePath) => executeRetirement(planned, { observe: () => observe(workspacePath), close: id => invoke(herdr, ['tab', 'close', id]), log });
  const assertVacant = lane => {
    const reason = laneRemovalReason(observe(lane), canonical(lane));
    if (reason) throw Error(reason);
  };
  const closeEmptyWorkspace = (id, lane) => {
    // Git has removed this path. Confirm that exact absence instead of treating
    // arbitrary Git errors as proof, then use the same guarded executor.
    const emptyObservation = () => {
      if (fs.existsSync(lane) || git(cwd, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${lane}`)) throw Error('worktree removal is not confirmed');
      const snapshot = observe(lane);
      const ws = snapshot.workspaces.find(w => w.workspace_id === id);
      if (!ws || ws.worktree.checkout_path !== canonical(lane) || ws.worktree.repo_key !== common || commonAt(ws.worktree.repo_root) !== common) throw Error('empty workspace identity changed');
      snapshot.git = snapshot.git.filter(g => g.path !== canonical(lane));
      return snapshot;
    };
    const snapshot = emptyObservation(), reason = laneRemovalReason(snapshot, canonical(lane));
    if (reason) throw Error(reason);
    const result = executeRetirement({ close: [], workspaceClose: [{ workspace_id: id, cwd: canonical(lane), token: planRetirement(snapshot).token }] }, {
      observe: emptyObservation, closeWorkspace: workspace => invoke(herdr, ['workspace', 'close', workspace]), log });
    if (result.some(r => r.action !== 'closed')) throw Error(result.map(r => r.why).join('; '));
  };
  return { common, observe, plan, apply, assertVacant, closeEmptyWorkspace, recordCallback };
}

function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, herdr: { type: 'string', default: 'herdr' },
    'verify-state-dir': { type: 'string' }, lane: { type: 'string' },
  }, usage: 'Usage: node supervisor/retire.mjs plan|apply|consume --repo CHECKOUT --org RECORD [--lane PATH] [--verify-state-dir DIR]' });
  if (positionals.length !== 1 || !['plan', 'apply', 'consume'].includes(positionals[0])) throw Error('expected plan, apply or consume');
  if (positionals[0] === 'consume') {
    const org = opt.org ?? findOrgDir({ cwd: opt.repo });
    const result = org ? consumeRetirement({ org, retirement: () => createRetirement({ cwd: canonical(opt.repo), org, herdr: opt.herdr }) }) : { handled: false };
    process.stdout.write(JSON.stringify(result) + '\n'); return;
  }
  const retirement = createRetirement({ cwd: canonical(opt.repo), org: opt.org, herdr: opt.herdr, verifyStateDir: opt['verify-state-dir'] });
  const plan = retirement.plan(opt.lane);
  process.stdout.write(JSON.stringify(positionals[0] === 'plan' ? plan : { plan, results: retirement.apply(plan, opt.lane) }) + '\n');
}
if (isMain(import.meta.url)) {
  try { main(); } catch (e) { process.stderr.write(`retire: ${e.message}\n`); process.exitCode = 1; }
}
