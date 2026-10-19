// Read-only observation and the shared guarded retirement adapter. No schedule.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from './cli-help.mjs';
import { loadTimeout } from './deadline.mjs';
import { findOrgDir, loadEvents, writeFileAtomic } from './store.mjs';
import { recordPaneRelease } from './retire-command.mjs';
import { SESSION_RELEASE_POLICY } from './session-release.mjs';
import { readConfig as readHousekeepingConfig } from '../housekeeping/config.mjs';
import { readReviewVerdicts, reviewVerdictId } from './review-verdict.mjs';
import { projectFleet } from './fleet.mjs';
import { fold } from './state.mjs';
import { consumeRetirement, requestRetirement } from './retire-trigger.mjs';
import { retirementDeadline, retirementLock } from './retire-lock.mjs';
import { ownerAlive } from './process-owner.mjs';
import { lookupProcess } from './processes.mjs';
import { workerIdentityEvidence } from './worker-identity.mjs';
import { planRetirement, executeRetirement, laneRemovalReason, matchingRun, integratedLaneDecision } from './retire.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { retirementHold } from './retire-hold.mjs';
import { readStandardSlots } from '../sessions/receipts.mjs';
import { measureLaneEvidence, preserveLaneEvidence, preflightGitMetadata, readLaneCwdReferences } from './lane-removal.mjs';
import { holderState, slotPathOf, TEST_SLOT_PATH, COMPAT_PATH_ENV } from '../test-slot/test-slot.mjs';
import { readTestSlotQueue } from '../test-slot/ticket-queue.mjs';
import { readTestSlotOccupancy } from '../test-slot/occupancy.mjs';
import { retirementStatus, renderRetirementStatus } from './retire-status.mjs';
import { composerEmpty } from '../lanes/composer.mjs';
import { initialShellDirectory, initialShellFile, initialShellHistory, validInitialShell } from './initial-shell.mjs';

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
function laneWorkHistory(branch, tip, git) {
  const oldest = git(['reflog', 'show', '--format=%H%x00%gs', `refs/heads/${branch}`]).trim().split('\n').filter(Boolean).at(-1)?.split('\0');
  const baseTip = oldest?.[1]?.startsWith('branch: Created from ') ? oldest[0] : null;
  return { baseTip, hasOwnCommits: baseTip ? tip !== baseTip : null };
}
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
  const cleanupLanes = [];
  const attempt = (name, fn) => { try { fn(); } catch (e) { errors.push(`${name} unreadable: ${e.message}; project kept`); } };
  const add = (kind, job) => references.push({ kind, job: job.id ?? job.job ?? job.label, item: job.item,
    run: job.run, lane: job.topic ?? job.lane, cwd: job.cwd ? canonical(job.cwd) : undefined,
    pane: job.pane, head: job.sha, label: job.label });
  attempt('promotion queue', () => {
    const queue = optional(path.join(common, 'promote/queue.json'));
    if (!queue) return;
    if (canonical(queue.identity) !== common || !Array.isArray(queue.pending) || !Array.isArray(queue.results)) throw Error('invalid identity or contents');
    const members = batch => batch?.jobs ?? (batch ? [batch] : []);
    const activeIds = new Set([...queue.pending, ...(queue.interrupted ?? []).flatMap(members), ...members(queue.current)]
      .map(job => job.id).filter(Boolean));
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
    // Results are append-only history. A resumed request's durable current
    // checkpoint, or its latest saved result, supersedes its older refusal.
    // Pending/current/interrupted requests above retain their own live holds.
    const latest = new Map(queue.results.map(job => [job.id ?? job, job]));
    for (const job of latest.values()) if (job.outcome === 'promoted' && job.cleanup?.state === 'pending') cleanupLanes.push(job.topic);
    for (const job of members(queue.current)) {
      const result = queue.current?.results?.find(m => m.job.id === job.id)?.result ?? queue.current?.result;
      if (result?.outcome === 'promoted' && result.cleanup?.state === 'pending') cleanupLanes.push(job.topic);
    }
    for (const job of latest.values()) if (!activeIds.has(job.id) && job.reconciliation?.state === 'pending') add('reconcile pending', job);
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
    for (const row of readTestSlotOccupancy(lock)) if (row.state !== 'gone') {
      if (!row.record?.cwd && !row.record?.label) throw Error('unknown occupant target');
      add('test-slot occupant', row.record);
    }
  });
  return { references, diagnostics, errors, readOwner, cleanupLanes };
}

export function createRetirement({ cwd = process.cwd(), org, herdr = process.env.HERDR_RETIRE_HERDR ?? 'herdr', record,
  command = spawnSync, selfTab = process.env.HERDR_TAB_ID ?? null, main,
  env = process.env, log = () => {}, verifyStateDir, readOwner, allowAbsentHerdr = false, requireRecord = false, selfRetirement, deadline = Infinity, exitTimeoutMs = 60000 } = {}) {
  let exitDeadline = Infinity;
  if (!Number.isFinite(exitTimeoutMs) || exitTimeoutMs < 0 || exitTimeoutMs > 60000) throw Error('exit timeout must be within 0..60000 milliseconds');
  const remaining = () => {
    const now = Date.now();
    if (now >= deadline) throw retirementDeadline();
    if (now >= exitDeadline) throw Error('agent did not exit through its exit command');
    return Math.min(deadline, exitDeadline) - now;
  };
  const readProcess = pid => {
    remaining();
    const result = lookupProcess(pid, { identityOnly: true, allowance: ms => Math.min(ms, remaining()), pause: () => {} });
    remaining();
    return result;
  };
  readOwner ??= owner => ownerAlive(owner, readProcess);
  if (selfRetirement && (selfRetirement.pid !== process.pid || selfRetirement.tab !== env.HERDR_TAB_ID || selfRetirement.pane !== env.HERDR_PANE_ID)) throw Error('self-retirement must name this process and its own Herdr tab and pane');
  const invoke = (exe, args) => {
    const r = command(exe, args, { cwd, encoding: 'utf8', timeout: Math.min(loadTimeout(10000), remaining()), maxBuffer: 64 * 1024 * 1024,
      env: { ...env, ORG_DIR: org } });
    if (Number.isFinite(exitDeadline) && exitDeadline <= deadline && r.error?.code === 'ETIMEDOUT') throw Error('agent did not exit through its exit command');
    if (Number.isFinite(deadline) && r.error?.code === 'ETIMEDOUT') throw retirementDeadline();
    remaining();
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
  const hold = () => retirementHold(canonicalRoot);
  main ??= git(canonicalRoot, ['symbolic-ref', '--short', 'HEAD']);
  let recordDiscoveryError;
  try { org ??= findOrgDir({ cwd, env }); }
  catch (error) { recordDiscoveryError = error; }
  const recordUnavailable = 'retirement record is missing or unreadable; lane kept';
  const assertRecordFile = () => {
    try { if (org && fs.statSync(path.join(org, 'events.jsonl')).isFile()) return; }
    catch { /* Missing and inaccessible files have the same named keep reason. */ }
    throw Error(recordUnavailable);
  };
  const assertLaneRecord = () => {
    if (recordDiscoveryError) throw recordDiscoveryError;
    assertRecordFile();
    const binding = projectFleet(canonicalRoot, { ...env, ORG_DIR: org });
    const discovered = binding.project?.record ?? findOrgDir({ cwd: canonicalRoot, env: { ...env, ORG_DIR: '' } });
    if (discovered && canonical(discovered) !== canonical(org)) throw Error('retirement record differs from canonical project record; lane kept');
  };
  const archivedAt = (root, head, branch) => {
    if (!branch?.startsWith('lane/')) return false;
    try { return git(root, ['rev-parse', '--verify', `refs/tags/archive/${branch}^{commit}`]) === head; } catch { return false; }
  };
  // Keep-only memory of every agent seen during this adapter's observation
  // window, including bookkeeping observations before the close-edge check.
  const shellClaims = new Set();
  function observe(workspacePath, { tolerateRecordErrors = false } = {}) {
    if (commonAt(cwd) !== common || commonAt(canonicalRoot) !== common) throw Error('canonical common directory changed');
    const recordErrors = new Set();
    const readRecord = () => {
      try {
        if (recordDiscoveryError) throw recordDiscoveryError;
        if (requireRecord) assertLaneRecord();
        else if (org) assertRecordFile();
        let loaded;
        try { loaded = org ? loadEvents(org) : { events: [], tornTail: false }; }
        catch (error) { if (error.code) throw Error(recordUnavailable); throw error; }
        if (loaded.tornTail) throw Error('incomplete record tail');
        const events = loaded.events;
        const state = record ? json(invoke(record[0], [...record.slice(1), 'status', '--json'])) : fold(events);
        const runs = state.runs instanceof Map ? [...state.runs.values()] : array(state.runs, 'record runs');
        const items = state.items instanceof Map ? [...state.items.values()] : array(state.items, 'record items');
        return { state, events, runs, items };
      } catch (error) {
        if (!tolerateRecordErrors) throw error;
        // Status retains the native inventory, with an explicit keep. Mutation
        // observations still fail closed rather than using an empty record.
        recordErrors.add(error.message);
        return { state: fold([]), events: [], runs: [], items: [] };
      }
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
          initialShellHistory: branch?.startsWith('lane/') ? initialShellHistory(common, root, head, branch, args => git(root, args)) : 'unknown',
          clean: !git(root, ['status', '--porcelain']), integrated, archived: archivedAt(root, head, branch) });
      } catch (e) { gitState.push({ path: root, common: wt.repo_key, error: `Git observation ${root}: ${e.message}` }); }
    }
    let processRows;
    for (const pane of panes) {
      const info = pane.process_info;
      // A complete tree from the configured Herdr reader is useful for offline
      // adapters. Current Herdr supplies foreground rows, so use the shared
      // native source to include background descendants and birth identities.
      let tree = info.process_tree;
      if (info.process_tree_complete !== true || !Array.isArray(tree)) {
        processRows ??= readProcess(undefined);
        if (!processRows.ok) { errors.push(processRows.error); continue; }
        const roots = new Set([info.shell_pid, ...info.foreground_processes.map(p => p.pid)]);
        tree = [...processRows.value.values()].filter(row => {
          const seen = new Set();
          for (let pid = row.pid; !seen.has(pid); pid = processRows.value.get(pid)?.ppid) {
            if (roots.has(pid)) return true;
            if (!processRows.value.has(pid)) break;
            seen.add(pid);
          }
          return false;
        });
      }
      // Preserve ordinary retirement's dead/zombie filtering. Only the native
      // descendant check needs raw states to refuse an unhealthy agent tree.
      pane.process_info = { ...info, process_tree_complete: true, process_tree_raw: tree,
        process_tree: tree.filter(row => !/^[ZX]/.test(row.state)) };
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
          lane: branch.startsWith('lane/') ? branch.slice(5) : null, clean: !git(root, ['status', '--porcelain']), archived: archivedAt(root, head, branch) });
      } catch (e) { gitState.push({ path: root, error: `Git observation ${root}: ${e.message}` }); }
    }
    const agents = absent ? [] : array(h(['agent', 'list']).agents, 'agents').map(a => ({ ...a, cwd: canonical(a.cwd) }));
    for (const agent of agents) {
      if (agent.pane_id) shellClaims.add(agent.pane_id);
      for (const pane of panes.filter(p => p.tab_id === agent.tab_id)) shellClaims.add(pane.pane_id);
    }
    for (const pane of panes.filter(p => p.shellOnly && !agents.some(a => a.pane_id === p.pane_id || a.tab_id === p.tab_id))) {
      try {
        const current = h(['pane', 'get', pane.pane_id]).pane;
        if (current?.pane_id !== pane.pane_id || !current.terminal_id || !current.foreground_cwd ||
            (current.tab_id && current.tab_id !== pane.tab_id) || (current.workspace_id && current.workspace_id !== pane.workspace_id) ||
            (pane.terminal_id && pane.terminal_id !== current.terminal_id)) throw Error('incomplete or changed shell terminal observation');
        pane.terminal_id = current.terminal_id;
        pane.foreground_cwd = canonical(current.foreground_cwd);
        pane.focused = current.focused ?? pane.focused;
        if (current.agent || current.agent_session || current.display_agent || current.name || current.launch_pending) shellClaims.add(pane.pane_id);
      } catch (e) {
        if (e.code === 'RETIREMENT_DEADLINE') throw e;
        pane.shellObservationError = e.message;
      }
    }
    ({ state, events, runs, items } = readRecord());
    const refs = readLiveReferences({ common, org, env, verifyStateDir });
    for (const run of runs) if (run.meta?.watcher_pid) {
      try { if (readOwner({ pid: Number(run.meta.watcher_pid), identity: run.meta.watcher_identity })) refs.references.push({ kind: 'watcher callback', job: run.id, run: run.id, cwd: canonical(run.workspace), pid: Number(run.meta.watcher_pid), identity: run.meta.watcher_identity }); }
      catch (e) { if (e.code === 'RETIREMENT_DEADLINE') throw e;
        refs.references.push({ kind: 'unknown watcher callback', job: run.id, run: run.id, cwd: canonical(run.workspace) }); refs.diagnostics.push({ run: run.id, reason: e.message }); }
    }
    const callbacks = [], callbackPruning = [];
    if (org) try {
      const directory = path.join(org, 'retirement/occupants');
      if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
        const receipt = optional(path.join(directory, name));
        if (receipt?.schema !== 'retirement-occupant/v1' || !['watcher', 'settle', 'executive', 'plan'].includes(receipt.kind) ||
            ['common', 'cwd', 'workspace', 'tab', 'pane'].some(k => typeof receipt[k] !== 'string' || !receipt[k]) ||
            [receipt.shell, receipt.process].some(p => !Number.isSafeInteger(p?.pid) || p.pid < 1 || typeof p.identity !== 'string' || !p.identity || !p.command)) throw Error(`invalid callback receipt ${name}`);
        if (canonical(receipt.common) !== common) continue;
        if (!tabs.some(tab => tab.tab_id === receipt.tab)) {
          // Scoped observations cannot prove another workspace's tab absent.
          // They still skip its owner lookup. Full apply prunes absent tabs.
          if (!workspacePath || absent || workspaces.some(ws => ws.workspace_id === receipt.workspace) || canonical(receipt.cwd) === canonical(workspacePath)) {
            callbackPruning.push({ file: path.join(directory, name), receipt, absent: true });
          }
          continue;
        }
        callbackPruning.push({ file: path.join(directory, name), receipt, absent: false });
        let process_gone = false;
        try { process_gone = !readOwner(receipt.process); } catch (e) {
          if (e.code === 'RETIREMENT_DEADLINE') throw e;
          refs.diagnostics.push({ file: name, reason: e.message }); }
        callbacks.push({ ...receipt, cwd: canonical(receipt.cwd), common, process_gone });
      }
    } catch (e) { if (e.code === 'RETIREMENT_DEADLINE') throw e;
      errors.push(`callback receipts unreadable: ${e.message}; project kept`); }
    const exits = [], exitPruning = [];
    if (org) try {
      const directory = path.join(org, 'retirement/exits');
      if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(directory, name), receipt = optional(file), a = receipt?.occupant;
        if (typeof receipt?.common === 'string' && path.isAbsolute(receipt.common) && canonical(receipt.common) !== common) continue;
        if (receipt?.schema !== 'retirement-exit/v1' ||
            ['common', 'cwd', 'workspace', 'tab', 'pane', 'run'].some(k => typeof receipt[k] !== 'string' || !receipt[k]) ||
            ['name', 'agent', 'pane_id', 'workspace_id', 'cwd', 'terminal_id'].some(k => typeof a?.[k] !== 'string' || !a[k]) ||
            (a.agent_session_id !== undefined && (typeof a.agent_session_id !== 'string' || !a.agent_session_id)) ||
            a.pane_id !== receipt.pane || a.workspace_id !== receipt.workspace || a.cwd !== receipt.cwd ||
            !path.isAbsolute(receipt.common) || !path.isAbsolute(receipt.cwd) ||
            !Number.isSafeInteger(receipt.shell?.pid) || receipt.shell.pid < 1 ||
            ['identity', 'command'].some(k => typeof receipt.shell[k] !== 'string' || !receipt.shell[k])) throw Error(`invalid agent exit receipt ${name}`);
        const absentTab = !tabs.some(tab => tab.tab_id === receipt.tab);
        if (!absentTab || !workspacePath || absent || workspaces.some(ws => ws.workspace_id === receipt.workspace) || canonical(receipt.cwd) === canonical(workspacePath))
          exitPruning.push({ file, receipt, absent: absentTab });
        if (!absentTab) exits.push(receipt);
      }
    } catch (e) { if (e.code === 'RETIREMENT_DEADLINE') throw e;
      errors.push(`agent exit receipts unreadable: ${e.message}; project kept`); }
    const initialShells = [], initialShellErrors = [], initialPruning = [];
    try {
      const directory = initialShellDirectory(common);
      for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = path.join(directory, name);
        const target = tabs.find(tab => path.basename(initialShellFile(common, tab.tab_id)) === name);
        let contents, receipt;
        try {
          contents = fs.readFileSync(file, 'utf8'); receipt = JSON.parse(contents);
          if (!validInitialShell(receipt) || receipt.common !== common || path.basename(initialShellFile(common, receipt.tab)) !== name) throw Error('invalid initial shell receipt');
        } catch (e) {
          if (target) initialShellErrors.push({ tab: target.tab_id, reason: 'initial shell receipt is malformed or unreadable' });
          if (!workspacePath && contents !== undefined && !target) initialPruning.push({ file, contents, absent: true });
          refs.diagnostics.push({ file, tab: target?.tab_id, reason: `initial shell receipt unreadable: ${e.message}` });
          continue;
        }
        const covered = !workspacePath || workspaces.some(ws => ws.workspace_id === receipt.workspace) || canonical(receipt.cwd) === canonical(workspacePath);
        if (target || covered) initialPruning.push({ file, contents, receipt, absent: !target });
        if (target) initialShells.push(receipt);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        for (const tab of tabs.filter(t => !agents.some(a => a.tab_id === t.tab_id || panes.some(p => p.tab_id === t.tab_id && p.pane_id === a.pane_id))))
          initialShellErrors.push({ tab: tab.tab_id, reason: 'initial shell receipt is malformed or unreadable' });
        refs.diagnostics.push({ reason: `initial shell receipt directory unreadable: ${e.message}` });
      }
    }
    // Our synchronous observation helpers have exited by now. For narrow
    // self-retirement, discard only descendants proved gone by birth identity;
    // a surviving child or an unreadable process source still keeps the tab.
    if (selfRetirement?.pid === process.pid) for (const p of panes.filter(p => p.pane_id === selfRetirement.pane)) {
      p.process_info.process_tree = p.process_info.process_tree?.filter(row => {
        if (row.pid === p.process_info.shell_pid || row.pid === process.pid) return true;
        try { return readOwner(row); } catch (e) { if (e.code === 'RETIREMENT_DEADLINE') throw e; return true; }
      });
    }
    const held = hold();
    const standardSlots = readStandardSlots(common);
    let reviewVerdicts = [];
    try { reviewVerdicts = readReviewVerdicts(org, common); }
    catch (e) { errors.push(`review verdict receipts unreadable: ${e.message}; project kept`); }
    let sessionReleasePolicy = false;
    try { sessionReleasePolicy = readHousekeepingConfig(path.join(canonicalRoot, '.housekeeping.json')).release_sessions !== false; }
    catch (e) { errors.push(`session release policy unreadable: ${e.message}; project kept`); }
    return { common, workspaces, tabs, panes, agents, git: gitState,
      sessionReleasePolicy, reviewVerdicts,
      ...(held ? { retirementHold: held } : {}),
      events,
      record: { runs: runs.map(r => ({ ...r, workspace: canonical(r.workspace) })), items, links: state.links ?? [], revision: state.eventCount,
        ...workerIdentityEvidence(record ? fold(events) : state) },
      ...(recordErrors.size ? { recordError: [...recordErrors][0] } : {}),
      references: refs.references, cleanupLanes: refs.cleanupLanes, errors: [...errors, ...recordErrors, ...refs.errors, ...standardSlots.errors], diagnostics: refs.diagnostics, selfTab, standardSlots,
      handoffs: events.filter(e => e.type === 'retirement.handoff'),
      releases: events.filter(e => e.type === 'retirement.release').map(e => {
        try { return { ...e, cwd: canonical(e.cwd) }; }
        catch { return { ...e, cwd: null }; }
      }),
      callbacks, selfRetirement, callbackPruning, exits, exitPruning, initialShells, initialShellErrors, initialPruning,
      shellClaims: [...shellClaims].sort(), shellEvidence: { recordRead: Boolean(org || record), referencesRead: refs.errors.length === 0 },
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
      ...(run ? { run } : {}), ...(a ? { agent: a.name, terminal_id: a.terminal_id, agent_session_id: a.agent_session?.value ?? a.agent_session_id } : {}) };
    const file = path.join(org, 'retirement/occupants', createHash('sha256').update(p.tab_id).digest('hex') + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const previous = optional(file);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt) && readOwner(previous.process)) throw Error('callback launch receipt belongs to a live process');
    writeFileAtomic(file, JSON.stringify(receipt) + '\n');
    return receipt;
  };
  const recordReviewVerdict = ({ pane, run, verdict, head, evidence, sha256 }) => {
    if (!org || !['PASS', 'NEEDS-WORK', 'FAIL'].includes(verdict) || !/^[a-f\d]{40}$/i.test(head ?? '') ||
        !evidence || createHash('sha256').update(fs.readFileSync(evidence)).digest('hex') !== sha256) throw Error('review verdict evidence is incomplete');
    const snapshot = observe(), c = snapshot.callbacks.find(c => c.kind === 'settle' && c.pane === pane && c.run === run);
    const a = snapshot.agents.find(a => a.pane_id === pane && a.name === c?.agent);
    if (!c?.terminal_id || !c.agent_session_id || !a || a.terminal_id !== c.terminal_id ||
        (a.agent_session?.value ?? a.agent_session_id) !== c.agent_session_id || a.cwd !== c.cwd || a.workspace_id !== c.workspace) throw Error('review verdict launch identity changed or incomplete');
    const r = snapshot.record.runs.find(r => r.id === run);
    if (!r?.report || r.abandoned || r.workspace !== c.cwd) throw Error('review verdict requires its ingested worker run');
    const receipt = { schema: 'retirement-review/v1', common, run, verdict, head, evidence, sha256, pane, terminal: c.terminal_id,
      session: c.agent_session_id, workspace: c.workspace, cwd: c.cwd, agent: c.agent, record_seq: snapshot.events.at(-1).seq,
      at: new Date().toISOString() };
    receipt.id = reviewVerdictId(receipt);
    const file = path.join(org, 'retirement/reviews', `${receipt.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const prior = optional(file);
      if (Object.keys(receipt).some(k => !['record_seq', 'at'].includes(k) && receipt[k] !== prior[k])) throw Error('reviewer session already recorded a different verdict');
    }
    requestRetirement({ org, key: `review:${receipt.id}`, source: 'review verdict' });
    return receipt;
  };
  const pruneReceipt = ({ file, receipt }) => {
    remaining();
    if (hold()) return;
    // Never erase a newer launch that replaced the receipt since observation.
    const current = optional(file);
    if (current && JSON.stringify(current) === JSON.stringify(receipt) && !hold()) try { fs.unlinkSync(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
  const pruneInitialReceipt = ({ file, contents }, locked = false) => {
    const unlock = locked ? null : retirementLock(path.join(common, 'retirement/tabs', path.basename(file, '.json')), { deadline });
    try {
      if (hold()) return;
      // A scoped planner's absence is not enough. Verify against every native
      // workspace immediately before pruning, including moved or recycled IDs.
      for (const workspace of array(h(['workspace', 'list']).workspaces, 'workspaces')) {
        for (const tab of array(h(['tab', 'list', '--workspace', workspace.workspace_id]).tabs, 'tabs'))
          if (initialShellFile(common, tab.tab_id) === file) return;
      }
      if (!hold() && fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    finally { unlock?.(); }
  };
  const recordExit = (candidate, snapshot) => {
    exitDeadline = Infinity;
    const pane = snapshot.panes.find(p => p.pane_id === candidate.pane);
    const [name, agent, pane_id, workspace_id, agentCwd, terminal_id, agent_session_id] = candidate.occupant;
    // Legacy readers without a terminal ID cannot establish this new receipt.
    // Their ordinary occupant checks still govern any immediate close.
    if (!org || !candidate.run || !terminal_id || pane?.terminal_id !== terminal_id) return;
    const occupant = { name, agent, pane_id, workspace_id, cwd: agentCwd, terminal_id,
      ...(agent_session_id ? { agent_session_id } : {}) };
    const callback = snapshot.callbacks.find(c => c.kind === 'settle' && c.run === candidate.run && c.pane === pane_id &&
      c.agent === name && c.terminal_id === terminal_id && c.agent_session_id === agent_session_id && c.workspace === workspace_id && c.cwd === agentCwd);
    if (!callback && matchingRun(occupant, snapshot.record)?.id !== candidate.run) throw Error('recorded launch identity changed during agent exit');
    const receipt = { schema: 'retirement-exit/v1', common, cwd: agentCwd, workspace: workspace_id,
      tab: candidate.tab_id, pane: pane_id, run: candidate.run, occupant, shell: candidate.shell,
      at: new Date().toISOString(), ...(callback ? { callback } : {}) };
    const file = path.join(org, 'retirement/exits', createHash('sha256').update(`${common}\0${candidate.tab_id}`).digest('hex') + '.json');
    writeFileAtomic(file, JSON.stringify(receipt) + '\n');
    log({ action: 'exit-observed', ...receipt });
    remaining();
    const reason = hold(); if (reason) throw Error(reason);
  };
  let diagnostics = [];
  const hasReceipts = () => {
    return [initialShellDirectory(common), ...(org ? ['occupants', 'exits'].map(kind => path.join(org, 'retirement', kind)) : [])].some(directory => {
      try { return fs.readdirSync(directory).length > 0; }
      catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    });
  };
  const apply = (planned = plan(), workspacePath, pruningSnapshot) => {
    diagnostics = [];
    const held = hold() ?? planned.held;
    if (held) return executeRetirement({ ...planned, held }, { log });
    const releases = [];
    if (planned.sessionReleases?.length) {
      const tabs = new Set([...planned.close, ...planned.sessionReleases].map(c => c.tab_id));
      for (const candidate of planned.sessionReleases) try {
        remaining();
        recordPaneRelease({ org, common, run: candidate.run, opt: candidate.opt, actor: SESSION_RELEASE_POLICY,
          guard: events => {
            const fresh = observe(workspacePath);
            if (fresh.events.at(-1)?.seq !== events.at(-1)?.seq) throw Error('record changed since release observation');
            const freshPlan = planRetirement(fresh);
            const current = freshPlan.sessionReleases?.find(c => c.run === candidate.run && c.tab_id === candidate.tab_id && c.opt.pane === candidate.opt.pane);
            if (!current || JSON.stringify(current.opt) !== JSON.stringify(candidate.opt)) throw Error(fresh.retirementHold ??
              freshPlan.keep.find(t => t.tab_id === candidate.tab_id)?.why ?? 'per-run session release authority changed');
            remaining();
            const held = hold(); if (held) throw Error(held);
          } });
        const row = { action: 'session-released', run: candidate.run, pane: candidate.opt.pane, why: candidate.opt.why };
        releases.push(row); log(row);
      } catch (e) {
        const row = { action: e.code === 'RETIREMENT_DEADLINE' ? 'deferred' : 'release-kept', run: candidate.run, pane: candidate.opt.pane, why: e.message };
        releases.push(row); log(row);
      }
      planned = plan(workspacePath);
      planned = { ...planned, close: planned.close.filter(t => tabs.has(t.tab_id)) };
    }
    // Reuse a caller's current observation only for receipt garbage collection.
    // Closing still requires the executor's fresh observation below. Avoid a
    // bookkeeping scan when no receipts exist, especially during input recovery.
    let snapshot = pruningSnapshot ?? (hasReceipts() ? observe(workspacePath) : null);
    for (const receipt of [...(snapshot?.callbackPruning ?? []), ...(snapshot?.exitPruning ?? [])].filter(receipt => receipt.absent)) pruneReceipt(receipt);
    for (const receipt of (snapshot?.initialPruning ?? []).filter(receipt => receipt.absent)) try { pruneInitialReceipt(receipt); }
    catch (e) {
      if (e.code === 'RETIREMENT_DEADLINE') throw e;
      const diagnostic = { action: 'receipt-pruning-diagnostic', tab_id: receipt.receipt?.tab, file: receipt.file, code: e.code, reason: e.message };
      diagnostics.push(diagnostic);
      try { log(diagnostic); } catch {}
    }
    const results = executeRetirement(planned, { hold, observe: () => (snapshot = observe(workspacePath)), exitTimeoutMs,
      exitObserved: recordExit,
      pause: ms => { remaining(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, remaining())); remaining(); },
      // Serialize prompt and close together, including direct apply/tidy callers.
      lockTab: id => {
        const release = retirementLock(path.join(common, 'retirement/tabs', createHash('sha256').update(id).digest('hex')), { deadline });
        return () => { exitDeadline = Infinity; release(); };
      },
      exit: candidate => {
        const agent = h(['agent', 'get', candidate.agent]).agent;
        const identity = agent && [agent.name, agent.agent, agent.pane_id, agent.workspace_id, canonical(agent.cwd), agent.terminal_id,
          agent.agent_session?.value ?? agent.agent_session_id];
        if (JSON.stringify(identity) !== JSON.stringify(candidate.occupant) || agent.interactive_ready === false ||
            !['idle', 'done'].includes(agent.agent_status ?? agent.status)) throw Error('agent changed, working or composer is not ready');
        const screen = invoke(herdr, ['pane', 'read', candidate.pane, '--lines', '14', '--format', 'ansi']);
        if (!composerEmpty(screen, agent.agent)) throw Error('agent composer is not ready');
        const reason = hold(); if (reason) throw Error(reason);
        invoke(herdr, ['agent', 'prompt', candidate.agent, candidate.exit]);
        exitDeadline = Date.now() + exitTimeoutMs;
      }, close: id => {
      invoke(herdr, ['tab', 'close', id]);
      for (const receipt of snapshot.initialPruning.filter(row => row.receipt?.tab === id)) try { pruneInitialReceipt(receipt, true); }
      catch (e) { diagnostics.push({ action: 'receipt-pruning-diagnostic', tab_id: id, file: receipt.file, reason: e.message }); }
      for (const receipt of [...snapshot.callbackPruning, ...snapshot.exitPruning].filter(row => row.receipt.tab === id)) try { pruneReceipt(receipt); }
      catch (e) {
        const diagnostic = { action: 'receipt-pruning-diagnostic', tab_id: id, file: receipt.file, code: e.code, reason: e.message };
        diagnostics.push(diagnostic);
        // Bookkeeping after a successful close cannot change its result, even
        // if the diagnostic logger itself fails.
        try { log(diagnostic); } catch {}
      }
    }, closeWorkspace: id => invoke(herdr, ['workspace', 'close', id]), log });
    // A tab close may have emptied a policy-released workspace. Plan again;
    // the same executor rechecks native vacancy, references and identity.
    if (results.some(r => r.action === 'closed' && r.tab_id)) {
      const empty = plan(workspacePath);
      if (empty.workspaceClose?.length) results.push(...executeRetirement({ ...empty, close: [] }, {
        hold, observe: () => observe(workspacePath), closeWorkspace: id => invoke(herdr, ['workspace', 'close', id]), log }));
    }
    return [...releases, ...results];
  };
  const assertVacant = lane => {
    const held = hold(); if (held) throw Error(held);
    const reason = laneRemovalReason(observe(lane), canonical(lane));
    if (reason) throw Error(reason);
  };
  const closeEmptyWorkspace = (id, lane, proof) => {
    try {
      const held = hold(); if (held) throw Error(held);
      // Git has removed this path. Confirm that exact absence instead of treating
      // arbitrary Git errors as proof, then use the same guarded executor.
      const emptyObservation = () => {
        if (fs.existsSync(lane) || git(cwd, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${lane}`)) throw Error('worktree removal is not confirmed');
        const snapshot = observe(lane);
        const ws = snapshot.workspaces.find(w => w.workspace_id === id);
        if (!ws || ws.worktree.checkout_path !== canonical(lane) || ws.worktree.repo_key !== common || commonAt(ws.worktree.repo_root) !== common) throw Error('empty workspace identity changed');
        snapshot.git = snapshot.git.filter(g => g.path !== canonical(lane));
        if (proof?.integrated === true && proof.cwd === canonical(lane) && typeof proof.tip === 'string' && proof.tip) {
          // Absence cannot establish integration. Recheck the removed tip on
          // every observation, including the executor's final authority read.
          git(canonicalRoot, ['merge-base', '--is-ancestor', proof.tip, main]);
          snapshot.git.push({ path: canonical(lane), common, head: proof.tip, branch: proof.branch,
            lane: proof.branch?.slice(5), clean: true, integrated: true, archived: false });
        }
        return snapshot;
      };
      const snapshot = emptyObservation(), reason = laneRemovalReason(snapshot, canonical(lane));
      if (reason) throw Error(reason);
      const result = executeRetirement({ close: [], workspaceClose: [{ workspace_id: id, cwd: canonical(lane), token: planRetirement(snapshot).token }] }, {
        hold, observe: emptyObservation, closeWorkspace: workspace => invoke(herdr, ['workspace', 'close', workspace]), log });
      if (result.some(r => r.action !== 'closed')) throw Error(result.map(r => r.why).join('; '));
    } catch (error) {
      log({ action: hold() ? 'held' : 'keep', workspace_id: id, cwd: lane, why: error.message });
      throw error;
    }
  };
  // Called under the existing promotion/close lock. Every CLI mode uses this
  // adapter and the same pure planner/executor as pane and workspace retirement.
  const removeLane = ({ lane, branch, expectedTip, gitOnly = false, sweep = false }) => {
    if (!/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(branch ?? '') || !path.isAbsolute(lane ?? '')) throw Error('removal requires a named lane and absolute worktree path');
    const checkHold = () => { const reason = hold(); if (reason) throw Error(reason); };
    checkHold();
    lane = canonical(lane);
    const topic = branch.slice(5), ref = `refs/heads/${branch}`, tag = `archive/${branch}`;
    const tip = git(canonicalRoot, ['rev-parse', '--verify', ref]);
    const exists = fs.existsSync(lane);
    const clean = () => {
      if (git(canonicalRoot, ['rev-parse', '--verify', ref]) !== tip) throw Error('lane tip changed before removal; lane kept');
      if (exists && (commonAt(lane) !== common || git(lane, ['symbolic-ref', '--short', 'HEAD']) !== branch || git(lane, ['rev-parse', 'HEAD']) !== tip)) throw Error('lane Git identity changed; lane kept');
      if (exists && git(lane, ['ls-files', '-v', '-z']).split('\0').some(row => /^[a-zS] /.test(row))) throw Error('lane has assume-unchanged or skip-worktree index flags; clean Git cannot be proven');
      if (exists && git(lane, ['status', '--porcelain'])) throw Error('lane worktree is not clean');
    };
    clean();
    let integrated = false;
    try { git(canonicalRoot, ['merge-base', '--is-ancestor', tip, main]); integrated = true; } catch {}
    if (expectedTip !== undefined && (expectedTip !== tip || !integrated)) throw Error('lane tip changed or is not contained in main; lane kept');
    let gitDirectory;
    if (exists) {
      gitDirectory = canonical(git(lane, ['rev-parse', '--absolute-git-dir']));
      if (!gitDirectory.startsWith(path.join(common, 'worktrees') + path.sep)) throw Error('lane is not a linked worktree');
      if (fs.existsSync(path.join(gitDirectory, 'locked'))) throw Error('lane worktree is locked');
    }
    // A differing existing tag is never overwritten, including on retries.
    const tagRef = `refs/tags/${tag}`;
    const tagExists = git(canonicalRoot, ['tag', '--list', tag]) === tag;
    if (!integrated && tagExists && git(canonicalRoot, ['rev-parse', '--verify', `${tagRef}^{commit}`]) !== tip) throw Error(`archive tag collision: ${tag}; lane kept`);
    const initialPlan = plan(lane);
    for (const kept of initialPlan.keep) { log({ action: 'keep', ...kept }); throw Error(kept.why); }
    const initial = observe(lane);
    initial.references.push(...readLaneCwdReferences(lane, { command, env }));
    const sweepReason = snapshot => {
      if (!sweep) return null;
      const decision = integratedLaneDecision(snapshot, { worktree: lane, branch, tip, identity: common,
        linked: true, clean: true, integrated, ...laneWorkHistory(branch, tip, args => git(canonicalRoot, args)) });
      return decision.decision === 'keep' ? decision.why : null;
    };
    // Check chain disposition and references before creating any archive. The
    // planner may release occupants, but an open/parked chain remains a hold.
    const reason = sweepReason(initial) ?? laneRemovalReason({ ...initial, git: [{ path: lane, common, head: tip, clean: true, integrated, archived: !integrated }], panes: [], tabs: [], agents: [] }, lane);
    if (reason) { log({ action: 'keep', cwd: lane, branch, why: reason }); throw Error(reason); }
    const tracked = exists ? new Set(git(lane, ['ls-files', '-z']).split('\0').filter(Boolean)) : null;
    if (exists) try { measureLaneEvidence({ lane, tracked, env }); }
    catch (e) { log({ action: 'keep', cwd: lane, branch, why: e.message }); throw e; }
    try { preflightGitMetadata({ common, gitDirectory, branch }); }
    catch (e) { throw Error(`Git metadata preflight failed: ${e.message}; lane kept`); }
    checkHold();
    if (!integrated && !tagExists) git(canonicalRoot, ['tag', tag, tip]);
    const verifyTag = () => {
      if (!integrated && git(canonicalRoot, ['rev-parse', '--verify', `${tagRef}^{commit}`]) !== tip) throw Error('archive tag durability verification failed; lane kept');
    };
    verifyTag();
    const evidence = exists ? preserveLaneEvidence({ common, lane, topic, tip, tracked, env }) : null;
    const proof = { cwd: lane, branch, tip, integrated, archiveTag: integrated ? null : tag,
      evidence: evidence ? { directory: evidence.directory, manifest: evidence.manifest, sha256: evidence.sha256 } : null };
    let worktreeRemoved = !exists;
    try {
      log({ action: 'lane-preflight', ...proof });
      const freshPlan = plan(lane);
      for (const kept of freshPlan.keep) { log({ action: 'keep', ...kept }); throw Error(kept.why); }
      if (!gitOnly && exists) apply(plan(lane), lane);
      const observeRemoval = () => {
        checkHold(); clean(); verifyTag(); evidence?.verify();
        // Complete potentially slow filesystem proofs before the final live
        // authority read, so hashing cannot age the executor's observation.
        preflightGitMetadata({ common, gitDirectory, branch });
        if (integrated) git(canonicalRoot, ['merge-base', '--is-ancestor', tip, main]);
        const snapshot = observe(lane);
        if (!exists) snapshot.git = snapshot.git.filter(g => g.path !== lane);
        const g = snapshot.git.find(g => g.path === lane);
        if (g) Object.assign(g, { integrated, archived: !integrated });
        else snapshot.git.push({ path: lane, common, head: tip, branch, lane: topic, clean: true, integrated, archived: !integrated });
        snapshot.references.push(...readLaneCwdReferences(lane, { command, env }));
        const reason = sweepReason(snapshot);
        if (reason) throw Error(reason);
        return { ...snapshot, removal: proof };
      };
      const snapshot = observeRemoval(), planned = planRetirement(snapshot);
      if (planned.laneKeep.length) { log({ action: 'keep', ...planned.laneKeep[0] }); throw Error(planned.laneKeep[0].why); }
      const workspaces = snapshot.workspaces.filter(w => w.worktree.checkout_path === lane).map(w => w.workspace_id);
      const results = executeRetirement({ ...planned, close: [] }, { hold, observe: observeRemoval, log, removeLane: () => {
        // No --force: Git also retains its own clean and worktree-lock checks.
        clean(); verifyTag();
        if (expectedTip !== undefined) git(canonicalRoot, ['merge-base', '--is-ancestor', tip, `refs/heads/${main}`]);
        checkHold();
        if (exists) git(canonicalRoot, ['worktree', 'remove', lane]);
        worktreeRemoved = true;
        git(canonicalRoot, ['branch', '-D', branch]);
      } });
      if (!results.some(r => r.action === 'lane-removed')) throw Error(results.map(r => r.why).join('; ') || 'lane removal refused');
      const pending = [];
      for (const id of workspaces) try { closeEmptyWorkspace(id, lane, proof); } catch (e) { pending.push(e.message); }
      return { ...proof, pending };
    } catch (error) {
      // Failed removal must not accumulate a new copy on every cleanup tick.
      // Discard only a verified duplicate while its unchanged source survives;
      // after worktree removal (including branch-delete failure), it is recovery.
      if (evidence && !worktreeRemoved) try {
        evidence.verify();
        fs.rmSync(evidence.directory, { recursive: true });
        log({ action: 'lane-evidence-discarded', cwd: lane, branch, directory: evidence.directory, why: 'removal failed; verified source evidence remains' });
      } catch (cleanupError) {
        log({ action: 'keep', cwd: lane, branch, evidence: proof.evidence, why: `failed-removal evidence retained: ${cleanupError.message}` });
      }
      throw error;
    }
  };
  const sweepIntegratedLanes = ({ dryRun = false, initialSnapshot } = {}) => {
    requireRecord = true;
    const results = [], seen = new Set();
    const boundedCommand = (exe, args, options) => command(exe, args, { ...options, timeout: Math.min(options.timeout, remaining()) });
    const trees = readRetirementWorktrees(common, { main, command: boundedCommand, env, sweep: true });
    for (const tree of trees.filter(t => t.branch?.startsWith('lane/'))) {
      if (seen.has(tree.branch)) continue;
      seen.add(tree.branch);
      let release, candidate = { cwd: tree.worktree, branch: tree.branch, expectedTip: tree.tip };
      try {
        remaining();
        // A tick already knows which chains/references are open. Use that only
        // to keep lanes, avoiding extra record reads in input recovery. Ignore
        // its old occupants: the tab pass may just have retired them. A removal
        // always needs the fresh complete observation below and in removeLane.
        if (initialSnapshot) {
          candidate = integratedLaneDecision({ ...initialSnapshot, panes: [], tabs: [], agents: [] }, tree);
          if (candidate.decision === 'keep') { const row = { ...candidate, action: 'keep' }; log(row); results.push(row); continue; }
        }
        const snapshot = observe(tree.worktree);
        candidate = integratedLaneDecision(snapshot, tree);
        if (candidate.decision === 'keep') { const row = { ...candidate, action: 'keep' }; log(row); results.push(row); continue; }
        // Include native processes that have no Herdr pane or recorded job.
        snapshot.references.push(...readLaneCwdReferences(tree.worktree, { command: boundedCommand, env }));
        candidate = integratedLaneDecision(snapshot, tree);
        if (candidate.decision === 'keep') { const row = { ...candidate, action: 'keep' }; log(row); results.push(row); continue; }
        if (dryRun) { const row = { ...candidate, action: 'would-remove-lane' }; log(row); results.push(row); continue; }
        release = acquireLock(path.join(common, 'lane-promote.lock'));
        remaining();
        const proof = removeLane({ lane: tree.worktree, branch: tree.branch, expectedTip: tree.tip, gitOnly: true, sweep: true });
        results.push({ ...candidate, action: 'lane-removed', ...proof });
      } catch (error) {
        const row = { ...candidate, decision: 'keep', action: error.code === 'RETIREMENT_DEADLINE' ? 'deferred' : 'keep', why: error.message };
        log(row); results.push(row);
        if (error.code === 'RETIREMENT_DEADLINE') break;
      } finally { release?.(); }
    }
    return results;
  };
  return { common, main, hold, observe, plan, apply, assertVacant, assertLaneRecord, closeEmptyWorkspace, removeLane, sweepIntegratedLanes, recordCallback, recordReviewVerdict, get diagnostics() { return diagnostics; } };
}

// Read-only Git inventory. Sweep mode checks untracked dirt without counting
// payloads or visiting non-lane worktrees; evidence stays in removeLane.
export function readRetirementWorktrees(common, { main, command = spawnSync, env = process.env, details = true, sweep = false } = {}) {
  const git = (args, expected = [0]) => {
    const result = command('git', args, { encoding: 'utf8', env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || !expected.includes(result.status)) throw Error(`Git inventory: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
    return result;
  };
  const entries = git(['--git-dir', common, 'worktree', 'list', '--porcelain', '-z']).stdout.split('\0\0').filter(Boolean);
  return entries.flatMap(entry => {
    const fields = entry.split('\0'), rawPath = fields.find(s => s.startsWith('worktree '))?.slice(9);
    // Keep failures local to this entry, including missing/invalid path records.
    let worktree = rawPath;
    const fullHead = fields.find(s => s.startsWith('HEAD '))?.slice(5) ?? null;
    const branch = fields.find(s => s.startsWith('branch refs/heads/'))?.slice(18) ?? null;
    if (sweep && !branch?.startsWith('lane/')) return [];
    const row = { worktree, identity: common, branch, tip: fullHead, linked: false, head: fullHead?.slice(0, 12) ?? null, integrated: null, clean: null,
      archiveTag: null, archiveMatchesHead: null, untracked: null, ignored: null };
    try {
      worktree = canonical(rawPath); row.worktree = worktree;
      const prunable = fields.find(s => s === 'prunable' || s.startsWith('prunable '));
      if (prunable) { row.stale = true; throw Error(`prunable worktree: ${prunable.slice(9) || 'Git metadata is stale'}`); }
      if (!worktree || !fs.existsSync(worktree)) { row.stale = true; throw Error('missing worktree path'); }
      if (canonical(git(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()) !== common) throw Error('canonical repository identity changed');
      const gitDirectory = canonical(git(['-C', worktree, 'rev-parse', '--absolute-git-dir']).stdout.trim());
      row.linked = gitDirectory.startsWith(path.join(common, 'worktrees') + path.sep);
      if (!main) throw Error('Git inventory: integration branch is unavailable');
      row.integrated = git(['--git-dir', common, 'merge-base', '--is-ancestor', fullHead, `refs/heads/${main}`], [0, 1]).status === 0;
      const clean = !git(['-C', worktree, 'status', '--porcelain=v1', '-z', `--untracked-files=${details || sweep ? 'all' : 'no'}`]).stdout;
      if (details || sweep) row.clean = clean;
      if (details && !sweep) {
        const count = args => git(['-C', worktree, 'ls-files', ...args, '-z']).stdout.split('\0').filter(Boolean).length;
        row.untracked = count(['--others', '--exclude-standard']);
        row.ignored = count(['--others', '--ignored', '--exclude-standard']);
      }
      if (branch?.startsWith('lane/')) {
        if (details || sweep) Object.assign(row, laneWorkHistory(branch, fullHead, args => git(['--git-dir', common, ...args]).stdout));
        if (sweep) return [row];
        const tag = `archive/${branch}`;
        const archived = git(['--git-dir', common, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], [0, 1]);
        if (archived.status === 0) { row.archiveTag = tag; row.archiveMatchesHead = archived.stdout.trim() === fullHead; }
      }
    } catch (error) { row.error = error.message; }
    return [row];
  });
}

export async function readRetirementStatus({ sources = [], env = process.env, ...options } = {}) {
  env = { ...env, GIT_OPTIONAL_LOCKS: '0', ...(options.org ? { ORG_DIR: path.resolve(options.org) } : {}) };
  const retirement = createRetirement({ ...options, env });
  let snapshot;
  try { snapshot = retirement.observe(undefined, { tolerateRecordErrors: true }); }
  catch (error) { snapshot = { common: retirement.common, errors: [error.message], retirementHold: retirement.hold() }; }
  let worktrees;
  try { worktrees = readRetirementWorktrees(retirement.common, { main: retirement.main, command: options.command, env }); }
  catch (error) { worktrees = []; snapshot = { ...snapshot, errors: [...(snapshot.errors ?? []), error.message] }; }
  worktrees = worktrees.map(row => ({ ...row, lane: row.branch?.startsWith('lane/') ? row.branch.slice(5) : null,
    paneCount: (snapshot.panes ?? []).filter(p => (snapshot.workspaces ?? []).some(w => w.workspace_id === p.workspace_id && w.worktree.checkout_path === row.worktree)).length }));
  for (const tree of worktrees.filter(t => t.branch?.startsWith('lane/'))) {
    if (tree.clean !== true || tree.integrated !== true) continue;
    const eligibility = snapshot.recordError ? { ...snapshot, errors: snapshot.errors.filter(reason => reason !== snapshot.recordError) } : snapshot;
    if (integratedLaneDecision(eligibility, tree).decision !== 'release') continue;
    if (snapshot.recordError) { tree.recordError = snapshot.recordError; continue; }
    try { retirement.assertLaneRecord(); }
    catch (error) { tree.recordError = error.message; continue; }
    try {
      snapshot.references.push(...readLaneCwdReferences(tree.worktree, { command: options.command, env }));
    }
    catch (error) { tree.error = error.message; }
  }
  const canonicalRoot = worktrees[0]?.worktree ?? canonical(options.cwd ?? process.cwd());
  // Lazy imports keep ordinary retirement consumers independent of presentation.
  const [{ brainSource }, { scriptSource }, { validateDocument }] = await Promise.all([
    import('../board/brain.mjs'), import('../board/source.mjs'), import('../board/rows.mjs'),
  ]);
  const project = { identity: retirement.common, canonical: canonicalRoot, checkout: canonical(options.cwd ?? process.cwd()), name: path.basename(canonicalRoot), worktrees: worktrees.map(w => ({ cwd: w.worktree, topic: w.lane })) };
  // The built-in source works for any project using Brain's promotion queue.
  // Reuse the observed fold rather than spawning another record fold for rows.
  const observed = value => typeof value === 'string' ? snapshot.record?.[value.startsWith('R-') ? 'runs' : 'items'] ?? [] : [];
  const documents = await Promise.all([
    brainSource(project, { show: async (_project, _job, value) => {
      const rows = observed(value); return (rows instanceof Map ? [...rows.values()] : rows).find(r => r.id === value) ?? null;
    } }),
    ...sources.map(source => scriptSource({ ...source, project: canonicalRoot, env }).read()),
  ]);
  const promotions = documents.filter(Boolean).flatMap(doc => validateDocument(doc, { roots: [retirement.common], panes: new Set((snapshot.panes ?? []).map(p => p.pane_id)) }).rows);
  return retirementStatus(snapshot, { project: canonicalRoot, worktrees, promotions });
}

export function writeRetirementStatus(file, content) {
  file = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function retirementMain() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, herdr: { type: 'string', default: 'herdr' },
    'verify-state-dir': { type: 'string' }, lane: { type: 'string' },
    'budget-ms': { type: 'string', default: '11000' },
    json: { type: 'boolean' }, out: { type: 'string' }, source: { type: 'string', multiple: true, default: [] },
  }, usage: 'Usage: node supervisor/retire.mjs plan|apply|consume|status --repo CHECKOUT --org RECORD [--lane PATH] [--verify-state-dir DIR]\nStatus: [--json] [--out FILE.md] [--source NAME=SCRIPT]...' });
  if (positionals.length !== 1 || !['plan', 'apply', 'consume', 'status'].includes(positionals[0])) throw Error('expected plan, apply, consume or status');
  if (positionals[0] === 'status') {
    if (opt.lane) throw Error('status inventories the whole canonical repository; --lane is not supported');
    const sources = opt.source.map(value => {
      const match = /^([a-z0-9._-]{1,40})=(.+)$/.exec(value);
      if (!match || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw Error('invalid-source');
      return { name: match[1], script: path.resolve(opt.repo, match[2]) };
    });
    const status = await readRetirementStatus({ cwd: canonical(opt.repo), org: opt.org, herdr: opt.herdr, verifyStateDir: opt['verify-state-dir'], sources });
    if (opt.out) writeRetirementStatus(opt.out, renderRetirementStatus(status, { markdown: true }));
    process.stdout.write(opt.json ? JSON.stringify(status) + '\n' : renderRetirementStatus(status));
    return;
  }
  if (opt.json || opt.out || opt.source.length) throw Error('--json, --out and --source require status');
  if (positionals[0] === 'consume') {
    const budget = Number(opt['budget-ms']);
    if (!Number.isSafeInteger(budget) || budget < 1) throw Error('consume budget must be a positive integer');
    const deadline = Date.now() + budget;
    const org = opt.org ?? findOrgDir({ cwd: opt.repo });
    const result = org ? consumeRetirement({ org, deadline, retirement: () => createRetirement({ cwd: canonical(opt.repo), org, herdr: opt.herdr, deadline }) }) : { handled: false };
    process.stdout.write(JSON.stringify(result) + '\n'); return;
  }
  const retirement = createRetirement({ cwd: canonical(opt.repo), org: opt.org, herdr: opt.herdr, verifyStateDir: opt['verify-state-dir'] });
  const plan = retirement.plan(opt.lane);
  process.stdout.write(JSON.stringify(positionals[0] === 'plan' ? plan : { plan, results: retirement.apply(plan, opt.lane) }) + '\n');
}
