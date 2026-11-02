// Read-only observation and the shared guarded retirement adapter. No schedule.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from './cli-help.mjs';
import { loadTimeout } from './deadline.mjs';
import { findOrgDir, loadEvents, writeFileAtomic, transact } from './store.mjs';
import { bindCloseoutSources, publishCloseoutEvents, closeoutPolicy, claimLegacyRetirement, fileIdentity, sameFileIdentity, sameBranchLog } from './closeout.mjs';
import { recordPaneRelease } from './retire-command.mjs';
import { boundSuccessor, SESSION_RELEASE_POLICY } from './session-release.mjs';
import { readConfig as readHousekeepingConfig } from '../housekeeping/config.mjs';
import { readReviewVerdicts, reviewVerdictId } from './review-verdict.mjs';
import { projectFleet } from './fleet.mjs';
import { fold } from './state.mjs';
import { consumeRetirement, requestRetirement } from './retire-trigger.mjs';
import { retirementDeadline, retirementLock } from './retire-lock.mjs';
import { ownerAlive } from './process-owner.mjs';
import { lookupProcess } from './processes.mjs';
import { effectiveWorkerIdentity, workerIdentityEvidence } from './worker-identity.mjs';
import { planRetirement, executeRetirement, laneRemovalReason, matchingRun, chainFor, integratedLaneDecision, archivalHistorySummary, validateLaneRemoval, sameExitShell } from './retire.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { retirementHold } from './retire-hold.mjs';
import { readStandardSlots } from '../sessions/receipts.mjs';
import { measureLaneEvidence, preserveLaneEvidence, verifyPreservedLaneEvidence, preflightGitMetadata, readLaneCwdReferences } from './lane-removal.mjs';
import { holderState, slotPathOf, TEST_SLOT_PATH, COMPAT_PATH_ENV } from '../test-slot/test-slot.mjs';
import { readProvingReservations } from '../test-slot/reservations.mjs';
import { readTestSlotQueue } from '../test-slot/ticket-queue.mjs';
import { readTestSlotOccupancy } from '../test-slot/occupancy.mjs';
import { retirementStatus, renderRetirementStatus } from './retire-status.mjs';
import { composerEmpty } from '../lanes/composer.mjs';
import { initialShellDirectory, initialShellFile, initialShellHistory, validInitialShell } from './initial-shell.mjs';
import { readArchivalRetirementPolicy, observeArchivalHistory, patchesIntegrated } from './retire-archive.mjs';
import { sealRemovalInputs,sealHousekeepingOwners,sealScopedRemovalInputs,canonical } from './retire-local.mjs';
import { readProjectPolicy, homePolicyDigest } from './config-policy.mjs';
import { prepareScratchSweep } from './scratch-sweep.mjs';
import { reportWatcherHandedOff } from './report-watcher-release.mjs';
import { sharedWatcherDischarged } from './shared-watcher-release.mjs';

const array = (data, name) => { if (!Array.isArray(data)) throw Error(`incomplete ${name}`); return data; };
const optional = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
// Reference names must reach their lstat guard, including non-regular entries.
const jsonFiles = directory => fs.readdirSync(directory)
  .filter(name => !name.startsWith('.') && name.endsWith('.json')).sort();
const regularJsonFiles = directory => fs.readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.json'))
  .map(entry => entry.name).sort();
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
// Unreadable/unknown JSON receipts hold the project, even when apparently expired.
export function readDeclaredReferences(org, now = Date.now()) {
  const directory = path.join(org, 'references'), references = [], diagnostics = [], errors = [];
  let files;
  try { files = jsonFiles(directory); }
  catch (e) { if (e.code === 'ENOENT') return { references, diagnostics, errors }; return { references, diagnostics, errors: [`reference directory unreadable: ${e.message}`] }; }
  for (const name of files) {
    const file = path.join(directory, name);
    try {
      if (!fs.lstatSync(file).isFile()) throw Error('reference is not a regular JSON file');
      const ref = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (ref.schema !== 'herdr-reference/v1' || !['pending', 'running'].includes(ref.state) ||
          ['owner', 'kind', 'job', 'item', 'created_at', 'expires_at'].some(k => typeof ref[k] !== 'string' || !ref[k].trim()) ||
          ['run', 'lane', 'cwd', 'pane', 'tab', 'terminal', 'pane_id', 'tab_id', 'terminal_id'].some(k => ref[k] !== undefined && (typeof ref[k] !== 'string' || !ref[k].trim())) ||
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
    pane: job.pane ?? job.pane_id, tab: job.tab ?? job.tab_id, terminal: job.terminal ?? job.terminal_id,
    pane_id: job.pane_id, tab_id: job.tab_id, terminal_id: job.terminal_id,
    head: job.sha, label: job.label });
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
  for (const lock of new Set([slotPathOf(env, { readOnly: true }), env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH])) attempt('host test slot', () => {
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
    for (const row of readProvingReservations(lock)) if (row.state !== 'gone') {
      if (!row.record?.cwd && !row.record?.label) throw Error('unknown reservation target');
      add('test-slot occupant', row.record);
    }
  });
  return { references, diagnostics, errors, readOwner, cleanupLanes };
}

export function createRetirement({ cwd = process.cwd(), org, herdr = process.env.HERDR_RETIRE_HERDR ?? 'herdr', record,
  command = spawnSync, selfTab = process.env.HERDR_TAB_ID ?? null, main,
  env = process.env, log = () => {}, verifyStateDir, readOwner, allowAbsentHerdr = false, requireRecord = false, selfRetirement, deadline = Infinity, exitTimeoutMs = 60000,
  guard = () => {}, selectPlan = plan => plan, scratchRoots, lockRemoval = () => () => {}, reportCloseout } = {}) {
  // Offline CLI and queue fixtures must never inventory the host temp roots.
  // The explicit option still wins for focused disposal fixtures.
  if (scratchRoots === undefined && env.HERDR_TEST_SCRATCH_ROOTS !== undefined)
    scratchRoots = JSON.parse(env.HERDR_TEST_SCRATCH_ROOTS);
  if (scratchRoots !== undefined && (!Array.isArray(scratchRoots) ||
      scratchRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))))
    throw Error('scratch roots must be an array of absolute paths');
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
  const invoke = (exe, args, timeoutMs = loadTimeout(10000)) => {
    const nativeEffect=exe===herdr&&((args[0]==='agent'&&args[1]==='prompt')||(['tab','workspace'].includes(args[0])&&args[1]==='close'));
    if (nativeEffect) guard();
    const r = command(exe, args, { cwd, encoding: 'utf8', timeout: Math.min(timeoutMs, remaining()), maxBuffer: 64 * 1024 * 1024,
      env: { ...env, ORG_DIR: org, GIT_OPTIONAL_LOCKS: '0' } });
    if (Number.isFinite(exitDeadline) && exitDeadline <= deadline && r.error?.code === 'ETIMEDOUT') throw Error('agent did not exit through its exit command');
    if (Number.isFinite(deadline) && r.error?.code === 'ETIMEDOUT') throw retirementDeadline();
    if (r.error || r.status !== 0) {
      let code=r.error?.code;for(const raw of [r.stdout,r.stderr])try{const value=JSON.parse(raw);code=value.error?.code??value.code??code;}catch{}
      throw Object.assign(Error(`${exe} ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.error?.message || r.stdout || `exit ${r.status}`).trim()}`), { code, status: r.status });
    }
    // Let the original successful native return reach its completion writer
    // even at the deadline. Every subsequent read/effect checks remaining().
    if(!nativeEffect)remaining();
    return r.stdout.trim();
  };
  const json = text => { const d = JSON.parse(text); if (d.error) throw Error(JSON.stringify(d.error)); return d.result ?? d; };
  const h = args => json(invoke(herdr, args));
  const git = (root, args, timeoutMs) => invoke('git', ['-C', root, ...args], timeoutMs);
  const withGitRemoval = (execute, proof, operation) => {
    const command = { attempt: randomUUID(), operation, cwd: proof.cwd, branch: proof.branch, tip: proof.tip,
      evidence: proof.evidence, branchGeneration: proof.branchGeneration };
    log({ action: 'git-removal-started', ...command });
    try {
      guard();
      const result = execute();
      log({ action: 'git-removal-finished', ...command, exit_status: 0 });
      return result;
    }
    catch (error) {
      // No completion for a spawn error, signal, timeout, refusal or guard.
      // A returned nonzero exit is a terminal result, not an UNKNOWN send.
      if (!error.code && Number.isSafeInteger(error.status) && error.status > 0 &&
          !/EPERM|EACCES|native refusal|permission denied|operation not permitted/i.test(error.message))
        log({ action: 'git-removal-finished', ...command, exit_status: error.status, reason: error.message });
      throw error;
    }
  };
  const isIntegrated = (tip, base) => {
    try { git(canonicalRoot, ['merge-base', '--is-ancestor', tip, base]); return true; }
    catch (error) { if (!error.code && error.status === 1) return false; throw error; }
  };
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
  const laneGitState = (root, head, branch) => {
    const clean = !git(root, ['status', '--porcelain']), integrated = isIntegrated(head, main);
    const archived = archivedAt(root, head, branch);
    const result = { clean, integrated, archived };
    if (clean && !integrated && !archived && branch?.startsWith('lane/') && !hold() &&
        readArchivalRetirementPolicy(canonicalRoot).archivalRetirementPolicy === true) {
      const mainTip = git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${main}`]);
      const observation = observeArchivalHistory({ branch, tip: head, main, mainTip, git: args => git(root, args) });
      result.patchIntegrated = patchesIntegrated(observation);
    }
    return result;
  };
  // Keep-only memory of every agent seen during this adapter's observation
  // window, including bookkeeping observations before the close-edge check.
  const shellClaims = new Set();
  function observe(workspacePath, { tolerateRecordErrors = false, globalPanes = Boolean(reportCloseout?.physical_identity) } = {}) {
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
    if (workspacePath) for (const run of runs.filter(r => canonical(r.workspace) === canonical(workspacePath))) {
      const successor = boundSuccessor(state, run);
      if (successor) successorWorkspaces.add(effectiveWorkerIdentity(successor, state).worker_workspace);
    }
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
    const absentNativeState=root=>{
      const scope=reportCloseout?.native_only;
      if(!scope||canonical(root)!==reportCloseout.cwd||fs.lstatSync(root,{throwIfNoEntry:false}))return null;
      guard();
      // This is explicitly an absent Git allocation, never a clean/integrated
      // worktree. The report consumer's fresh guard binds its project/native
      // tuple and restricts effects to the original tab; no removal uses it.
      return{path:root,common,branch:scope.branch,head:scope.head,lane:scope.branch.slice(5),nativeOnly:true};
    };
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
        gitState.push({ path: root, common: identity, head, branch, lane: branch?.startsWith('lane/') ? branch.slice(5) : null,
          initialShellHistory: branch?.startsWith('lane/') ? initialShellHistory(common, root, head, branch, args => git(root, args)) : 'unknown',
          ...laneGitState(root, head, branch) });
      } catch (e) { gitState.push(absentNativeState(root)??{ path: root, common: wt.repo_key, error: `Git observation ${root}: ${e.message}` }); }
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
          lane: branch.startsWith('lane/') ? branch.slice(5) : null, ...laneGitState(root, head, branch) });
      } catch (e) { gitState.push(absentNativeState(root)??{ path: root, error: `Git observation ${root}: ${e.message}` }); }
    }
    const agents = absent ? [] : array(h(['agent', 'list']).agents, 'agents').map(a => {
      // Herdr's list is a summary and can omit agent_session. Fetch the native
      // detail for an in-scope occupant before recording or comparing identity.
      // Never merge detail from a replacement occupant into an older list row.
      // An unnamed operator occupant cannot be queried by native agent name.
      // Leave it to the ordinary keep guard instead of blocking other tabs.
      if (a.name && !(a.agent_session?.value ?? a.agent_session_id) && (globalPanes||panes.some(p => p.pane_id === a.pane_id))) {
        const detail = h(['agent', 'get', a.name]).agent;
        if (!detail || ['name', 'pane_id', 'workspace_id'].some(k => !a[k] || detail[k] !== a[k]) ||
            !a.cwd || canonical(detail.cwd) !== canonical(a.cwd) ||
            (a.terminal_id && detail.terminal_id !== a.terminal_id) || (a.agent && detail.agent !== a.agent))
          throw Error(`native agent detail identity changed for ${a.name}`);
        a = { ...a, ...detail };
      }
      return { ...a, cwd: canonical(a.cwd) };
    });
    // Absence reconciliation needs the original terminal and session absent
    // across all workspaces, including a move outside this project's lane.
    const nativePanes=globalPanes?[...panes,...all.filter(w=>!workspaces.some(selected=>selected.workspace_id===w.workspace_id))
      .flatMap(w=>array(h(['pane','list','--workspace',w.workspace_id]).panes,'global panes').map(p=>({...p,workspace_id:w.workspace_id})))]:undefined;
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
    // A lane-specific observation cannot use an unrelated historical watcher.
    // Select from fresh record/native scope before owner reads, not from age or
    // a cached liveness result. Unknown paths and contradictory native aliases
    // stay in scope; a full-project observation still checks every watcher.
    const scopePaths = workspacePath ? [canonical(workspacePath), ...workspaces.map(w => w.worktree.checkout_path)] : [];
    const overlapsScope = value => typeof value === 'string' && path.isAbsolute(value) && scopePaths.some(root => {
      const target = canonical(value); return target === root || target.startsWith(root + path.sep) || root.startsWith(target + path.sep);
    });
    const scopeAgents = agents.filter(a => panes.some(p => p.pane_id === a.pane_id));
    const directScope = run => {
      const m = effectiveWorkerIdentity(run, state);
      return overlapsScope(run.workspace) || panes.some(p => m.pane === p.pane_id || m.terminal_id && m.terminal_id === p.terminal_id) ||
        scopeAgents.some(a => m.agent === a.name || m.agent_session_id && m.agent_session_id === (a.agent_session?.value ?? a.agent_session_id));
    };
    const directRuns = workspacePath ? new Set(runs.filter(directScope)) : new Set(), scopeItems = new Set();
    const reviewCompletions=events.filter(e=>e.type==='change.reviewed'||e.type==='item.closed');
    for (const run of directRuns) for (const id of chainFor({...state,reviewCompletions}, run).ids) scopeItems.add(id);
    const watcherRuns = workspacePath ? runs.filter(run => !run.workspace || !path.isAbsolute(run.workspace) || directRuns.has(run) || scopeItems.has(run.item)) : runs;
    for (const run of watcherRuns) if (run.meta?.watcher_pid||run.meta?.watcher_shared) {
      const ref = { job: run.id, run: run.id, cwd: run.workspace ? canonical(run.workspace) : undefined,
        ...(!run.workspace || !path.isAbsolute(run.workspace) ? { global: true } : {}) };
      if(run.meta.watcher_shared){
        if(sharedWatcherDischarged({run,state,events,scope:reportCloseout,org,common,project:canonicalRoot,diagnostics:refs.diagnostics})!==true)
          refs.references.push({...ref,kind:'shared watcher duty',registration:run.meta.watcher_shared});
        continue;
      }
      try { if (readOwner({ pid: Number(run.meta.watcher_pid), identity: run.meta.watcher_identity }) &&
          !(sharedWatcherDischarged({run,state,events,scope:reportCloseout,org,common,project:canonicalRoot,diagnostics:refs.diagnostics}) ??
            reportWatcherHandedOff({run,state,scope:reportCloseout,org,common,project:canonicalRoot})))
        refs.references.push({ ...ref, kind: 'watcher callback', pid: Number(run.meta.watcher_pid), identity: run.meta.watcher_identity }); }
      catch (e) { if (e.code === 'RETIREMENT_DEADLINE') throw e;
        refs.references.push({ ...ref, kind: 'unknown watcher callback' }); refs.diagnostics.push({ run: run.id, reason: e.message }); }
    }
    const callbacks = [], callbackPruning = [];
    if (org) try {
      const directory = path.join(org, 'retirement/occupants');
      if (fs.existsSync(directory)) for (const name of regularJsonFiles(directory)) {
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
      if (fs.existsSync(directory)) for (const name of regularJsonFiles(directory)) {
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
      for (const name of regularJsonFiles(directory)) {
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
    const archivalPolicy = readArchivalRetirementPolicy(canonicalRoot);
    let closeoutQueuePolicy = false;
    try { closeoutQueuePolicy = closeoutPolicy(canonicalRoot, undefined, { requireServiceSource: false }); }
    catch (e) {
      // Both readers validate the same lane policy. Preserve the established
      // archival KEEP reason, then retain the closeout reader's full diagnostic.
      if (archivalPolicy.archivalRetirementPolicyError) errors.push('archival retirement policy is unavailable; lane kept');
      errors.push(`closeout policy unreadable: ${e.message}; project kept`);
    }
    return { common, workspaces, nativeWorkspaceIds: all.map(w => w.workspace_id), tabs, panes, agents, git: gitState,
      ...(globalPanes?{nativeInventory:{complete:!absent,panes:nativePanes}}:{}),
      sessionReleasePolicy, closeoutQueuePolicy, reviewVerdicts, ...archivalPolicy, reportCloseout,
      ...(held ? { retirementHold: held } : {}),
      events,
      record: { runs: runs.map(r => ({ ...r, workspace: canonical(r.workspace) })), items, links: state.links ?? [], revision: state.eventCount,reviewCompletions,
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
    const snapshot = observe(workspacePath), result = selectPlan(planRetirement(snapshot), snapshot);
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
    if (kind === 'settle' && (!a?.terminal_id || !(a.agent_session?.value ?? a.agent_session_id))) throw Error('reviewer launch native session identity is incomplete');
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
  const recordReviewVerdict = ({ pane, run, verdict, head, evidence, sha256, followup_expected = false, deferCloseout = false }) => {
    if (!org || !['PASS', 'NEEDS-WORK', 'FAIL'].includes(verdict) || !/^[a-f\d]{40}$/i.test(head ?? '') ||
        !evidence || createHash('sha256').update(fs.readFileSync(evidence)).digest('hex') !== sha256) throw Error('review verdict evidence is incomplete');
    const snapshot = observe(), c = snapshot.callbacks.find(c => c.kind === 'settle' && c.pane === pane && c.run === run);
    const a = snapshot.agents.find(a => a.pane_id === pane && a.name === c?.agent);
    if (!c?.terminal_id || !c.agent_session_id || !a || a.terminal_id !== c.terminal_id ||
        (a.agent_session?.value ?? a.agent_session_id) !== c.agent_session_id || a.cwd !== c.cwd || a.workspace_id !== c.workspace) throw Error('review verdict launch identity changed or incomplete');
    const r = snapshot.record.runs.find(r => r.id === run);
    if (!r?.report || r.abandoned || r.workspace !== c.cwd) throw Error('review verdict requires its ingested worker run');
    if (typeof followup_expected !== 'boolean') throw Error('review verdict needs a boolean followup_expected');
    let receipt = { schema: 'retirement-review/v1', common, run, verdict, head, evidence, sha256, pane, terminal: c.terminal_id,
      session: c.agent_session_id, workspace: c.workspace, cwd: c.cwd, agent: c.agent, record_seq: snapshot.events.at(-1).seq,
      process: c.process, shell: c.shell, tab: c.tab, followup_expected, at: new Date().toISOString() };
    receipt.id = reviewVerdictId(receipt);
    const recorded = deferCloseout ? { added: [], result: receipt } : transact(org, events => {
      const prior = events.find(e => e.type === 'review.verdict' && e.review?.id === receipt.id);
      if (prior && ['verdict', 'head', 'sha256', 'followup_expected'].some(k => prior.review[k] !== receipt[k])) throw Error('reviewer session already recorded a different verdict');
      if (prior) return { result: prior.review };
      receipt.record_seq = (events.at(-1)?.seq ?? 0) + 1;
      return bindCloseoutSources({ cwd: canonicalRoot, org, env, events, mutation: { add: [{ type: 'review.verdict', common, run, item: r.item, head, review: receipt }], result: receipt } });
    }, { actor: 'lane review' });
    receipt = recorded.result;
    const file = path.join(org, 'retirement/reviews', `${receipt.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const prior = optional(file);
      if (Object.keys(receipt).some(k => !['record_seq', 'at'].includes(k) && JSON.stringify(receipt[k]) !== JSON.stringify(prior[k]))) throw Error('reviewer session already recorded a different verdict');
    }
    publishCloseoutEvents({ cwd: canonicalRoot, org, added: recorded.added, env });
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
    const observedShell = pane.process_info?.process_tree?.[0];
    if (!sameExitShell(candidate.shell, observedShell)) throw Error('shell identity changed during agent exit');
    const receipt = { schema: 'retirement-exit/v1', common, cwd: agentCwd, workspace: workspace_id,
      tab: candidate.tab_id, pane: pane_id, run: candidate.run, occupant,
      shell: { pid: observedShell.pid, identity: observedShell.identity, command: observedShell.command },
      at: new Date().toISOString(), ...(callback ? { callback } : {}) };
    const file = path.join(org, 'retirement/exits', createHash('sha256').update(`${common}\0${candidate.tab_id}`).digest('hex') + '.json');
    writeFileAtomic(file, JSON.stringify(receipt) + '\n');
    log({ action: 'exit-observed', ...receipt });
    remaining();
    const reason = hold(); if (reason) throw Error(reason);
  };
  const reconcileAgentExit = candidate => {
    guard();
    const scope = candidate.occupant?.[4];
    if (!scope) throw Error('agent exit intent lacks its original occupant');
    const snapshot = observe(scope), ps = snapshot.panes.filter(p => p.tab_id === candidate.tab_id), p = ps[0];
    if (ps.length !== 1 || p.pane_id !== candidate.pane || p.workspace_id !== candidate.occupant[3] ||
        p.terminal_id !== candidate.occupant[5] || !p.shellOnly || p.process_info?.process_tree?.length !== 1) return false;
    const shell = p.process_info.process_tree[0];
    if (p.process_info.shell_pid !== candidate.shell?.pid || !sameExitShell(candidate.shell, shell) ||
        snapshot.agents.filter(a => a.tab_id === candidate.tab_id || a.pane_id === candidate.pane).some(a =>
          JSON.stringify([a.name, a.agent, a.pane_id, a.workspace_id, a.cwd, a.terminal_id, a.agent_session?.value ?? a.agent_session_id]) !== JSON.stringify(candidate.occupant)))
      throw Error('agent exit intent shell or native identity changed; keep');
    const prior = snapshot.exits.find(e => e.pane === candidate.pane && e.run === candidate.run);
    if (prior) log({ action: 'exit-observed', ...prior, reconciled: true });
    else recordExit(candidate, snapshot);
    return true;
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
            guard();
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
        // Do not send an exit at the tail of a turn that cannot observe its
        // original result. A pre-effect budget keep can use the next wake.
        if(remaining()<exitTimeoutMs+10000)throw retirementDeadline();
        log({ action: 'agent-exit-requested', run: candidate.run, pane: candidate.pane, tab_id: candidate.tab_id, occupant: candidate.occupant, shell: candidate.shell });
        invoke(herdr, ['agent', 'prompt', candidate.agent, candidate.exit]);
        exitDeadline = Date.now() + exitTimeoutMs;
      }, close: id => {
      log({ action: 'shell-close-requested', tab_id: id, panes: snapshot.panes.filter(p => p.tab_id === id).map(p => ({ pane: p.pane_id, terminal: p.terminal_id })) });
      invoke(herdr, ['tab', 'close', id]);
    }, afterClose: id => {
      // The executor has already recorded the original native completion.
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
    }, closeWorkspace: workspace => invoke(herdr, ['workspace', 'close', workspace]), log });
    // A tab close may have emptied a policy-released workspace. Plan again;
    // the same executor rechecks native vacancy, references and identity.
    const pristineWorkspaces = new Set(results.filter(r => r.rule === 'pristine-first-tab/v1').map(r => r.workspace_id));
    if (results.some(r => r.action === 'closed' && r.tab_id && r.rule !== 'pristine-first-tab/v1')) {
      const empty = plan(workspacePath);
      empty.workspaceClose = empty.workspaceClose?.filter(w => !pristineWorkspaces.has(w.workspace_id));
      if (empty.workspaceClose?.length) results.push(...executeRetirement({ ...empty, close: [] }, {
        hold, observe: () => observe(workspacePath), closeWorkspace: workspace => invoke(herdr, ['workspace', 'close', workspace]), log }));
    }
    return [...releases, ...results];
  };
  const assertVacant = lane => {
    const held = hold(); if (held) throw Error(held);
    const reason = laneRemovalReason(observe(lane), canonical(lane));
    if (reason) throw Error(reason);
  };
  // The line's DEC-331 exception uses the ordinary planner/executor and tab
  // lock, with additional global original-identity proof on every observation.
  // It sends a new close only; it never invokes the old agent-exit transport.
  const closeLegacyInertShell = (workspacePath, verify) => {
    let snapshot, proof;
    const fresh = () => {
      guard(); remaining();
      if (git(workspacePath, ['ls-files', '-v', '-z']).split('\0').some(row => /^[a-zS] /.test(row)))
        throw Error('legacy inert shell index hides tracked work; clean folder cannot be proven; keep');
      snapshot = observe(workspacePath, { globalPanes: true });
      proof = verify(snapshot);
      if (!proof) throw Error('legacy inert original shell proof incomplete or changed; keep');
      proof.index_flags_clear = true;
      // verify consumed the full global identity census. Keep the executor's
      // ordinary scoped token free of unrelated titles/activity in that census.
      const { nativeInventory, ...ordinary } = snapshot;
      return ordinary;
    };
    fresh();
    return executeRetirement({ close: [proof.decision] }, {
      hold, observe: fresh,
      lockTab: id => retirementLock(path.join(common, 'retirement/tabs', createHash('sha256').update(id).digest('hex')), { deadline }),
      close: id => {
        // Repeat the complete proof at the actual close boundary, under the
        // same tab lock. A changed planner decision stops before journaling.
        const planned = proof.decision;
        fresh();
        if (proof.decision.tab_id !== id || proof.decision.token !== planned.token)
          throw Error('legacy inert original shell authority changed; keep');
        log({ action: 'shell-close-requested', tab_id: id,
          panes: [{ pane: proof.pane.pane_id, terminal: proof.pane.terminal_id }], legacy_exit: proof });
        fresh();
        if (proof.decision.token !== planned.token) throw Error('legacy inert original shell authority changed; keep');
        log({ action: 'legacy-shell-verified', tab_id: id, legacy_exit: proof });
        invoke(herdr, ['tab', 'close', id]);
      }, log,
    });
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
        } else if (proof?.archiveTag && proof.cwd === canonical(lane)) {
          if (git(canonicalRoot, ['rev-parse', '--verify', `refs/tags/${proof.archiveTag}^{commit}`]) !== proof.tip ||
              (proof.mainTip && git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${main}`]) !== proof.mainTip)) throw Error('archival recovery identity changed; empty workspace kept');
          snapshot.git.push({ path: canonical(lane), common, head: proof.tip, branch: proof.branch,
            lane: proof.branch.slice(5), clean: true, integrated: false, archived: true });
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
  const prepareLaneScratch = (proof, record) => {
    const lane = proof.cwd, topic = proof.branch.slice(5);
    const ownership = record => ({
      runs: record.runs.filter(run => run.workspace && canonical(run.workspace) === lane),
      topics: [...record.runs.map(run => run.meta?.lane).filter(Boolean), topic,
        ...git(canonicalRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads/lane/', 'refs/tags/archive/lane/'])
          .split('\n').map(ref => ref.replace(/^refs\/(?:heads|tags\/archive)\/lane\//, '')).filter(Boolean)],
    });
    return prepareScratchSweep({ common, canonical: canonicalRoot, lane, topic, tip: proof.tip,
      integrated: proof.integrated, evidence: proof.evidence,
      ...(proof.scratchManifest ? { recovery: { manifest: proof.scratchManifest, evidence: proof.evidence } } : {}),
      ...ownership(record), readOwnership: () => {
        assertRecordFile();
        const { events, tornTail } = loadEvents(org);
        if (tornTail) throw Error('incomplete record tail');
        return ownership({ runs: [...fold(events).runs.values()] });
      }, env, command, hold, guard: () => {
        guard(); remaining();
        if (commonAt(canonicalRoot) !== common) throw Error('canonical common directory changed; scratch kept');
      }, log, ...(scratchRoots !== undefined ? { roots: scratchRoots } : {}) });
  };
  // Seal every local source used by the selected token before the final native
  // observation. Under the lock equality proves these inputs are still current;
  // native/process facts are re-observed immediately before acquisition instead.
  const sealLocalRemoval = (lane, gitDirectory, evidence, scratchManifest, snapshot) => {
    const verify = verifyStateDir ?? env.HERDR_RETIRE_VERIFY_STATE_DIR ?? path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'herdr-monitor/verify', createHash('sha256').update(common).digest('hex'));
    const selected = readProjectPolicy(canonicalRoot, 'lane', env, { canonical: canonicalRoot });
    const policy = JSON.stringify(selected.config), home = homePolicyDigest(canonicalRoot, env);
    // Only effective Git settings used by identity/cleanliness/removal belong
    // to this effect. Color, unrelated includes and the main index are not its
    // inputs. Fresh target/index and main CAS checks still run under the lock.
    const gitPolicy=()=>{
      try{return git(canonicalRoot,['config','--null','--get-regexp','^(core\\.(repositoryformatversion|bare|worktree|sharedrepository|hookspath|fsmonitor|ignorecase|symlinks|filemode|logallrefupdates)|extensions\\.|safe\\.directory|worktree\\.)']);}
      catch(error){if(error.status===1&&!error.code)return '';throw error;}
    };
    const gitSettings=gitPolicy();
    const slots = [...new Set([slotPathOf(env, { readOnly: true }), env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH])];
    const local = sealRemovalInputs([
      path.join(common, 'promote/queue.json'), path.join(verify, 'queue.json'),
      path.join(common, 'sessions/standard-slots.json'), selected.file,
      path.join(common, 'refs/replace'), path.join(common, 'shallow'), path.join(common, 'objects/info/alternates'),
      scratchManifest, path.join(canonicalRoot, '.housekeeping.json'), path.join(common, 'info'),
      ...slots.flatMap(file => [file, `${file}.queue`, `${file}.occupancy`]),
      gitDirectory && path.join(gitDirectory, 'index'),
    ], { inertLinkParents: org ? [path.join(org, 'retirement/occupants'), path.join(org, 'retirement/exits')] : [] });
    const targetRuns=snapshot.record.runs.filter(r=>r.workspace===lane||r.workspace?.startsWith(lane+path.sep));
    const targetItems=[...new Set(targetRuns.flatMap(r=>[...chainFor(snapshot.record,r).ids]))];
    const context={common,cwd:lane,runs:targetRuns.map(r=>r.id),items:targetItems,lane:snapshot.removal?.branch.slice(5),head:snapshot.removal?.tip,
      panes:snapshot.panes.map(p=>p.pane_id),tabs:snapshot.tabs.map(t=>t.tab_id),terminals:snapshot.panes.map(p=>p.terminal_id),
      workspaces:[...new Set([...(snapshot.removal?.workspaces??[]),...snapshot.workspaces.filter(w=>w.worktree.checkout_path===lane).map(w=>w.workspace_id)])],
      sessions:snapshot.agents.filter(a=>snapshot.panes.some(p=>p.pane_id===a.pane_id)).map(a=>a.agent_session?.value??a.agent_session_id)};
    // The native readers consume these three receipt inventories. The parent
    // retirement/request.json and handled.json only coalesce wake hints; a
    // different subject's completion must not invalidate this removal seal.
    // Unknown/malformed rows in the consumed inventories remain fail-closed.
    const scoped=org?sealScopedRemovalInputs(['references','settle','retirement/occupants','retirement/exits','retirement/reviews'].map(dir=>path.join(org,dir)),context,
      {inertLinkParents:['occupants','exits'].map(dir=>path.join(org,'retirement',dir)),referenceDirectories:[path.join(org,'references')],identityDirectories:[path.join(org,'retirement')]}):()=>{};
    const housekeeping=org?sealHousekeepingOwners(path.join(org,'housekeeping')):()=>{};
    const baseline = org ? loadEvents(org) : { events: [] };
    if (baseline.tornTail) throw Error('incomplete preservation claim record; lane kept');
    const recordDigest = createHash('sha256').update(JSON.stringify(baseline.events)).digest('hex');
    const preserved = evidence ? sealRemovalInputs([...(fs.existsSync(lane) ? [lane] : []), evidence.directory], { evidence: true }) : () => {};
    return snapshot => {
      local(); scoped(); housekeeping(); preserved();
      if(gitPolicy()!==gitSettings)throw Error('removal Git policy changed; prepare again; lane kept');
      if (requireRecord) assertLaneRecord();
      const loaded = org ? loadEvents(org) : { events: [] };
      if (loaded.tornTail || createHash('sha256').update(JSON.stringify(loaded.events.slice(0, baseline.events.length))).digest('hex') !== recordDigest)
        throw Error('preservation source record changed; prepare again; lane kept');
      if (loaded.events.slice(baseline.events.length).some(e => {
        const claims=[e.report?.artifacts,e.evidence,e.references,e.artifacts,e.file,e.report_path].filter(v=>v!==undefined);
        if(!claims.length)return false;
        const text=JSON.stringify(claims);
        // The supervisor's audit/incident receipt is diagnostic metadata, not
        // an unscoped preservation claim. Explicit subject/path matches below
        // still win; unknown rows and other claim-bearing fields stay sealed.
        const auditOnly=e.type==='supervisor.exception-disposition'&&
          typeof e.evidence?.audit==='string'&&path.isAbsolute(e.evidence.audit)&&
          Object.keys(e.evidence).every(k=>['audit','incident'].includes(k))&&
          [e.report?.artifacts,e.references,e.artifacts,e.file,e.report_path].every(v=>v===undefined);
        return context.runs.includes(e.run??e.id)||context.items.includes(e.item??e.id)||text.includes(lane)||
          evidence&&text.includes(evidence.directory)||scratchManifest&&text.includes(scratchManifest)||(!e.run&&!e.id&&!e.item&&!auditOnly);
      }))
        throw Error('preservation claim inputs changed; prepare again; lane kept');
      if (JSON.stringify(readProjectPolicy(canonicalRoot, 'lane', env, { canonical: canonicalRoot }).config) !== policy ||
          homePolicyDigest(canonicalRoot, env) !== home) throw Error('retirement policy inputs changed; prepare again; lane kept');
      // Preserve the scoped token's unrelated-append oracle. Read local record
      // authority again under the lock, while retaining the immediately prior
      // live native proof; never run a planner or native inventory here.
      const state = record ? json(invoke(record[0], [...record.slice(1), 'status', '--json'])) : fold(loaded.events);
      const runs = state.runs instanceof Map ? [...state.runs.values()] : array(state.runs, 'record runs');
      const items = state.items instanceof Map ? [...state.items.values()] : array(state.items, 'record items');
      return { ...snapshot, events: loaded.events, record: { runs: runs.map(r => ({ ...r, workspace: canonical(r.workspace) })),
        items, links: state.links ?? [], revision: state.eventCount,reviewCompletions:loaded.events.filter(e=>e.type==='change.reviewed'||e.type==='item.closed'), ...workerIdentityEvidence(record ? fold(loaded.events) : state) } };
    };
  };
  const removeLane = ({ lane, branch, expectedTip, archiveTip, archival, gitOnly = false, sweep = false }) => {
    if (sweep) requireRecord = true;
    if (!/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(branch ?? '') || !path.isAbsolute(lane ?? '')) throw Error('removal requires a named lane and absolute worktree path');
    const checkHold = () => { guard(); const reason = hold(); if (reason) throw Error(reason); };
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
    const integrated = isIntegrated(tip, main);
    if (expectedTip !== undefined && (expectedTip !== tip || !integrated)) throw Error('lane tip changed or is not contained in main; lane kept');
    const checkArchivalSnapshot = () => {
      if (archival && (!sweep || integrated || archival.tip !== tip ||
          git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${main}`]) !== archival.mainTip)) throw Error('archival retirement Git snapshot changed; lane kept');
      if (archival && readArchivalRetirementPolicy(canonicalRoot).archivalRetirementPolicy !== true) throw Error('archival retirement policy is off or unavailable; lane kept');
    };
    checkArchivalSnapshot();
    let gitDirectory;
    if (exists) {
      gitDirectory = canonical(git(lane, ['rev-parse', '--absolute-git-dir']));
      if (!gitDirectory.startsWith(path.join(common, 'worktrees') + path.sep)) throw Error('lane is not a linked worktree');
      if (fs.existsSync(path.join(gitDirectory, 'locked'))) throw Error('lane worktree is locked');
    }
    // A differing existing tag is never overwritten, including on retries.
    const tagRef = `refs/tags/${tag}`;
    const tagExists = git(canonicalRoot, ['tag', '--list', tag]) === tag;
    const tagTarget = tagExists ? git(canonicalRoot, ['rev-parse', '--verify', `${tagRef}^{commit}`]) : null;
    if (!integrated && tagExists && git(canonicalRoot, ['rev-parse', '--verify', `${tagRef}^{commit}`]) !== tip) throw Error(`archive tag collision: ${tag}; lane kept`);
    if (archiveTip !== undefined && (archiveTip !== tip || !archivedAt(canonicalRoot, tip, branch))) throw Error('archive-tagged lane tip changed; lane kept');
    const initialPlan = plan(lane);
    for (const kept of initialPlan.keep) { log({ action: 'keep', ...kept }); throw Error(kept.why); }
    const initial = observe(lane);
    initial.references.push(...readLaneCwdReferences(lane, { command, env }));
    if (!exists) initial.git = [{ path: lane, common, head: tip, branch, lane: topic, clean: true,
      integrated, archived: tagExists && archivedAt(canonicalRoot, tip, branch) }];
    const sweepReason = snapshot => {
      if (!sweep) return null;
      checkArchivalSnapshot();
      const decision = integratedLaneDecision(snapshot, { worktree: lane, branch, tip, identity: common,
        linked: true, clean: true, integrated, ...laneWorkHistory(branch, tip, args => git(canonicalRoot, args)),
        ...(archivedAt(canonicalRoot, tip, branch) ? { archiveTag: tag, archiveMatchesHead: true } : {}),
        ...(archival ? { mainTip: archival.mainTip,
          archival: observeArchivalHistory({ branch, tip, main, mainTip: archival.mainTip, git: args => git(canonicalRoot, args) }) } : {}) });
      return decision.decision === 'keep' ? decision.why : null;
    };
    // An archive promise cannot lift a chain hold. Only an existing exact tag
    // or a freshly observed ancestry/patch landing can do so before tagging.
    const reason = sweepReason(initial) ?? laneRemovalReason({ ...initial, panes: [], tabs: [], agents: [] }, lane);
    if (reason) { log({ action: 'keep', cwd: lane, branch, why: reason }); throw Error(reason); }
    const tracked = exists ? new Set(git(lane, ['ls-files', '-z']).split('\0').filter(Boolean)) : null;
    if (exists) try { measureLaneEvidence({ lane, tracked, env }); }
    catch (e) { log({ action: 'keep', cwd: lane, branch, why: e.message }); throw e; }
    try { preflightGitMetadata({ common, gitDirectory, branch }); }
    catch (e) { throw Error(`Git metadata preflight failed: ${e.message}; lane kept`); }
    checkHold(); clean(); checkArchivalSnapshot();
    const verifyTag = () => {
      const present = git(canonicalRoot, ['tag', '--list', tag]) === tag;
      if (present !== tagExists || (present && git(canonicalRoot, ['rev-parse', '--verify', `${tagRef}^{commit}`]) !== tagTarget)) throw Error('archive tag durability verification failed; lane kept');
    };
    verifyTag();
    const evidence = exists ? preserveLaneEvidence({ common, lane, topic, tip, tracked, env }) : null;
    const generationPath = path.join(common, 'logs/refs/heads', branch);
    if (!fs.existsSync(generationPath)) throw Error('branch generation is unproven; lane kept');
    const generationProof = { path: generationPath, identity: fileIdentity(generationPath), sha256: createHash('sha256').update(fs.readFileSync(generationPath)).digest('hex') };
    const proof = { cwd: lane, branch, tip, integrated, archiveTag: integrated ? null : tag, branchGeneration: generationProof,
      ...(reportCloseout && !integrated ? { keepBranch: true } : {}),
      ...(exists ? { worktreeIdentity: fileIdentity(lane), gitIdentity: fileIdentity(gitDirectory) } : {}),
      ...(archival ? { eligibility: 'archival-retirement', mainTip: archival.mainTip, archival: archivalHistorySummary(archival) } : {}),
      evidence: evidence ? { directory: evidence.directory, manifest: evidence.manifest, sha256: evidence.sha256 } : null,
      workspaces: initial.workspaces.filter(w => w.worktree.checkout_path === lane).map(w => w.workspace_id) };
    let worktreeRemoved = !exists, scratch;
    try {
      scratch = prepareLaneScratch(proof, initial.record);
      proof.scratchManifest = scratch.manifest;
      log({ action: 'lane-preflight', ...proof });
      const freshPlan = plan(lane);
      for (const kept of freshPlan.keep) { log({ action: 'keep', ...kept }); throw Error(kept.why); }
      if (!gitOnly && exists) apply(plan(lane), lane);
      const observeRemoval = ({ final = false } = {}) => {
        checkHold(); clean(); checkArchivalSnapshot(); verifyTag(); evidence?.verify();
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
        const reason = final ? null : sweepReason(snapshot);
        if (reason) throw Error(reason);
        return { ...snapshot, removal: proof };
      };
      const snapshot = observeRemoval(), planned = planRetirement(snapshot);
      if (planned.laneKeep.length) { log({ action: 'keep', ...planned.laneKeep[0] }); throw Error(planned.laneKeep[0].why); }
      const candidate = planned.laneClose.find(row => row.cwd === lane && row.branch === branch);
      if (!candidate) throw Error('no selected lane removal; keep');
      const workspaces = snapshot.workspaces.filter(w => w.worktree.checkout_path === lane).map(w => w.workspace_id);
      const branchGeneration = sealRemovalInputs([path.join(common, 'logs/refs/heads', branch)]);
      const identities = sealRemovalInputs(exists ? [path.join(lane, '.git'), path.join(gitDirectory, 'HEAD'), path.join(gitDirectory, 'gitdir'), path.join(gitDirectory, 'commondir')] : []);
      const mainTip = git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${main}`]);
      const verifyLocal = sealLocalRemoval(lane, gitDirectory, evidence, proof.scratchManifest, snapshot);
      // Full hashing and metadata permission probes precede the last live read.
      // There is no wait, planner, copy or asynchronous yield after that read.
      const final = observeRemoval({ final: true });
      const unlock = lockRemoval();
      try {
        if (exists && (!sameFileIdentity(lane, proof.worktreeIdentity) || !sameFileIdentity(gitDirectory, proof.gitIdentity))) throw Error('removal filesystem identity changed; lane kept');
        checkHold(); identities(); branchGeneration(); clean(); verifyTag();
        const fresh = verifyLocal(final);
        if (commonAt(canonicalRoot) !== common || git(canonicalRoot, ['symbolic-ref', '--short', 'HEAD']) !== main ||
            git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${main}`]) !== mainTip)
          throw Error('removal main epoch or project changed; lane kept');
        if (exists && (!fs.existsSync(lane) || canonical(git(lane, ['rev-parse', '--absolute-git-dir'])) !== gitDirectory ||
            !git(canonicalRoot, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${lane}`))) throw Error('worktree registration changed; lane kept');
        // Metadata preflight already proved write access. Locks are read again
        // locally; no native command or payload hash runs in this section.
        const locked = directory => {
          for (const name of fs.readdirSync(directory)) {
            if (name.endsWith('.lock') || name === 'locked') throw Error(`locked Git metadata ${path.join(directory, name)}`);
            if (fs.lstatSync(path.join(directory, name)).isDirectory()) locked(path.join(directory, name));
          }
        };
        if (gitDirectory) locked(gitDirectory);
        for (const file of ['packed-refs.lock', `refs/heads/${branch}.lock`, `refs/tags/${tag}.lock`])
          if (fs.existsSync(path.join(common, file))) throw Error(`locked Git metadata ${file}`);
        if (integrated) git(canonicalRoot, ['merge-base', '--is-ancestor', tip, `refs/heads/${main}`]);
        checkArchivalSnapshot();
        validateLaneRemoval(fresh, candidate);
        const removalBaseMs = exists ? Math.min(600000, 30000 + evidence.entryCount * 10) : 0;
        const branchBaseMs = proof.keepBranch ? 0 : 30000, neededMs = removalBaseMs + branchBaseMs;
        let removalMs = Math.min(600000, loadTimeout(removalBaseMs));
        let branchMs = Math.min(60000, loadTimeout(branchBaseMs));
        const availableMs = remaining();
        const firstBaseMs=exists?removalBaseMs:branchBaseMs;
        if (availableMs < firstBaseMs) throw Object.assign(Error(`removal needs ${Math.ceil(firstBaseMs / 1000)} s; pass has ${Math.floor(availableMs / 1000)} s`), { code: 'RETIREMENT_DEADLINE' });
        // Load adds response headroom, not mandatory work. Fit that headroom
        // inside the finite pass while reserving both inventory-sized bases.
        // Otherwise a busy host can make even an untouched three-minute pass
        // too short for its own desired command allowances, stranding cleanup.
        const desiredMs = removalMs + branchMs;
        if(availableMs<neededMs){removalMs=availableMs;branchMs=branchBaseMs;}
        else if (availableMs < desiredMs) {
          const headroomMs = availableMs - neededMs;
          const removalExtraMs = Math.floor(headroomMs * (removalMs - removalBaseMs) / (desiredMs - neededMs));
          branchMs = branchBaseMs + Math.min(branchMs - branchBaseMs, headroomMs - removalExtraMs);
          removalMs = removalBaseMs + removalExtraMs;
        }
        if (!integrated) {
          checkHold();
          if (!tagExists) git(canonicalRoot, ['tag', tag, tip]);
          if (git(canonicalRoot, ['rev-parse', '--verify', `${tagRef}^{commit}`]) !== tip) throw Error('archive tag durability verification failed; lane kept');
          log({ action: 'archive-created', cwd: lane, branch, tip, archiveTag: tag });
        }
        checkHold();
        if (exists) withGitRemoval(() => git(canonicalRoot, ['worktree', 'remove', lane], removalMs), proof, 'worktree');
        worktreeRemoved = true;
        log({ action: 'worktree-removed', ...proof });
        checkHold(); branchGeneration();
        if (git(canonicalRoot, ['rev-parse', '--verify', ref]) !== tip) throw Error('branch changed after worktree removal; keep');
        checkHold();
        if (!proof.keepBranch) {
          const branchAvailable=remaining();
          if(branchAvailable<branchBaseMs)throw Object.assign(Error(`removal needs ${Math.ceil(branchBaseMs/1000)} s; pass has ${Math.floor(branchAvailable/1000)} s`),{code:'RETIREMENT_DEADLINE'});
          branchMs=Math.min(branchMs,branchAvailable);
          // The direct report path deletes only an actual main ancestor.
          if (reportCloseout) git(canonicalRoot, ['merge-base', '--is-ancestor', tip, `refs/heads/${main}`]);
          withGitRemoval(() => git(canonicalRoot, ['branch', '-D', branch], branchMs), proof, 'branch');
        }
        log({ action: proof.keepBranch ? 'branch-kept' : 'branch-removed', ...proof });
        log({ ...candidate, action: 'lane-removed' });
      } finally { unlock(); }
      scratch.execute();
      const pending = [];
      for (const id of workspaces) try { closeEmptyWorkspace(id, lane, proof); } catch (e) { pending.push(e.message); }
      return { ...proof, pending };
    } catch (error) {
      // A refused/deferred close did not execute its scratch intent. Finalize
      // that diagnostic before discarding any duplicate preservation bundle.
      scratch?.cancel(error.message);
      // Failed removal must not accumulate a new copy on every cleanup tick.
      // Discard only a verified duplicate while its unchanged source survives;
      // after worktree removal (including branch-delete failure), it is recovery.
      if (evidence && !worktreeRemoved) try {
        evidence.verify();
        fs.rmSync(evidence.directory, { recursive: true });
        scratch?.discardAttempt();
        log({ action: 'lane-evidence-discarded', cwd: lane, branch, directory: evidence.directory, why: 'removal failed; verified source evidence remains' });
      } catch (cleanupError) {
        log({ action: 'keep', cwd: lane, branch, evidence: proof.evidence, why: `failed-removal evidence retained: ${cleanupError.message}` });
      }
      throw error;
    }
  };
  // Recovery accepts only a previously recorded preservation proof and exact
  // absence. No force/prune and no adoption of a replacement lane or workspace.
  const resumeLaneRemoval = proof => {
    guard();
    if (proof.cwd === canonicalRoot || !/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(proof.branch ?? '') ||
        !proof.evidence || fs.existsSync(proof.cwd) || git(canonicalRoot, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${proof.cwd}`)) throw Error('partial removal identity is not proven; keep');
    verifyPreservedLaneEvidence({ common, proof, env });
    if (proof.integrated) git(canonicalRoot, ['merge-base', '--is-ancestor', proof.tip, main]);
    else if (git(canonicalRoot, ['rev-parse', '--verify', `refs/tags/${proof.archiveTag}^{commit}`]) !== proof.tip) throw Error('partial removal archive identity changed');
    const observePartial = () => {
      guard();
      const snapshot = observe(proof.cwd);
      snapshot.git = [{ path: proof.cwd, common, head: proof.tip, branch: proof.branch, lane: proof.branch.slice(5), clean: true, integrated: proof.integrated, archived: !proof.integrated }];
      snapshot.references.push(...readLaneCwdReferences(proof.cwd, { command, env }));
      return { ...snapshot, removal: proof };
    };
    const snapshot = observePartial();
    const reason = laneRemovalReason(snapshot, proof.cwd);
    if (reason) throw Error(reason);
    // Reuse the same pre-effect manifest and final disposal checks on recovery.
    // Preserve the earlier proof so the new manifest explains the interrupted attempt.
    const scratch = prepareLaneScratch(proof, snapshot.record);
    const resumed = { ...proof, scratchManifest: scratch.manifest };
    let removed = false;
    try {
      const candidate = planRetirement(snapshot).laneClose.find(row => row.cwd === proof.cwd);
      if (!candidate) throw Error('partial removal candidate is not releasable');
      preflightGitMetadata({ common, branch: proof.branch });
      const generation = sealRemovalInputs([path.join(common, 'logs/refs/heads', proof.branch)]);
      const verifyLocal = sealLocalRemoval(proof.cwd, undefined, proof.evidence, resumed.scratchManifest, snapshot);
      const mainTip = git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${main}`]);
      const final = observePartial();
      const unlock = lockRemoval();
      try {
        guard(); const held = hold(); if (held) throw Error(held);
        const fresh = verifyLocal(final);
        generation(); validateLaneRemoval(fresh, candidate);
        if (fs.existsSync(proof.cwd) || git(canonicalRoot, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${proof.cwd}`) ||
            commonAt(canonicalRoot) !== common || git(canonicalRoot, ['symbolic-ref', '--short', 'HEAD']) !== main ||
            git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${main}`]) !== mainTip) throw Error('partial removal identity or epoch changed; keep');
        if (proof.integrated) git(canonicalRoot, ['merge-base', '--is-ancestor', proof.tip, main]);
        else if (git(canonicalRoot, ['rev-parse', '--verify', `refs/tags/${proof.archiveTag}^{commit}`]) !== proof.tip) throw Error('partial removal archive identity changed');
        let branch;
        try { branch = git(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${proof.branch}`]); }
        catch (e) { if (e.status !== 128) throw e; }
        if (branch && (branch !== proof.tip || !proof.branchGeneration || !sameBranchLog(proof.branchGeneration))) throw Error('partial removal branch generation changed or unknown; keep');
        for (const file of ['packed-refs.lock', `refs/heads/${proof.branch}.lock`])
          if (fs.existsSync(path.join(common, file))) throw Error(`locked Git metadata ${file}`);
        log({ action: 'worktree-removed', ...proof, reconciled: true });
        if (proof.keepBranch && branch !== proof.tip) throw Error('saved unlanded branch is missing; keep recovery proof');
        if (branch && !proof.keepBranch) {
          const availableMs = remaining(),branchMs = Math.min(60000, loadTimeout(30000),availableMs);
          if (availableMs < 30000) throw Object.assign(Error(`removal needs 30 s; pass has ${Math.floor(availableMs / 1000)} s`), { code: 'RETIREMENT_DEADLINE' });
          withGitRemoval(() => git(canonicalRoot, ['branch', '-D', proof.branch], branchMs), proof, 'branch');
        }
        log({ action: proof.keepBranch ? 'branch-kept' : 'branch-removed', ...proof, reconciled: true });
        log({ action: 'lane-removed', ...resumed, reconciled: true });
        removed = true;
      } finally { unlock(); }
      scratch.execute();
      const present = snapshot.workspaces.map(w => w.workspace_id);
      for (const id of proof.workspaces ?? []) {
        if (present.includes(id)) closeEmptyWorkspace(id, proof.cwd, proof);
        else if (snapshot.nativeWorkspaceIds.includes(id)) throw Error('removed lane workspace identity changed; keep');
        else log({ action: 'closed', workspace_id: id, cwd: proof.cwd, reconciled: true });
      }
      return resumed;
    } catch (error) {
      if (!removed) scratch.cancel(error.message);
      throw error;
    }
  };
  const sweepIntegratedLanes = ({ dryRun = false, initialSnapshot } = {}) => {
    requireRecord = true;
    const results = [], seen = new Set();
    const boundedCommand = (exe, args, options) => command(exe, args, { ...options, timeout: Math.min(options.timeout, remaining()) });
    const trees = readRetirementWorktrees(common, { main, command: boundedCommand, env, sweep: true,
      archivalRetirement: readArchivalRetirementPolicy(canonicalRoot).archivalRetirementPolicy });
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
        const proof = removeLane({ lane: tree.worktree, branch: tree.branch,
          ...(candidate.eligibility === 'archival-retirement' ? { archival: tree.archival } :
            candidate.eligibility === 'archive-tagged' ? { archiveTip: tree.tip } : { expectedTip: tree.tip }), gitOnly: true, sweep: true });
        results.push({ ...candidate, action: 'lane-removed', ...proof });
      } catch (error) {
        const row = { ...candidate, decision: 'keep', action: error.code === 'RETIREMENT_DEADLINE' ? 'deferred' : 'keep', why: error.message };
        log(row); results.push(row);
        if (error.code === 'RETIREMENT_DEADLINE') break;
      } finally { release?.(); }
    }
    return results;
  };
  return { common, canonical: canonicalRoot, main, hold, observe, plan, apply, assertVacant, assertLaneRecord, closeLegacyInertShell, closeEmptyWorkspace, removeLane, resumeLaneRemoval, reconcileAgentExit, sweepIntegratedLanes, recordCallback, recordReviewVerdict, get diagnostics() { return diagnostics; } };
}

// Read-only Git inventory. Sweep mode checks untracked dirt without counting
// payloads or visiting non-lane worktrees; evidence stays in removeLane.
export function readRetirementWorktrees(common, { main, command = spawnSync, env = process.env, details = true, sweep = false, archivalRetirement = false } = {}) {
  const git = (args, expected = [0]) => {
    const result = command('git', args, { encoding: 'utf8', env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || !expected.includes(result.status)) throw Error(`Git inventory: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
    return result;
  };
  const entries = git(['--git-dir', common, 'worktree', 'list', '--porcelain', '-z']).stdout.split('\0\0').filter(Boolean);
  const canonicalRoot = entries[0]?.split('\0').find(s => s.startsWith('worktree '))?.slice(9);
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
      row.mainTip = git(['--git-dir', common, 'rev-parse', '--verify', `refs/heads/${main}`]).stdout.trim();
      row.integrated = git(['--git-dir', common, 'merge-base', '--is-ancestor', fullHead, row.mainTip], [0, 1]).status === 0;
      const clean = !git(['-C', worktree, 'status', '--porcelain=v1', '-z', `--untracked-files=${details || sweep ? 'all' : 'no'}`]).stdout;
      if (details || sweep) row.clean = clean;
      if (details && !sweep) {
        const count = args => git(['-C', worktree, 'ls-files', ...args, '-z']).stdout.split('\0').filter(Boolean).length;
        row.untracked = count(['--others', '--exclude-standard']);
        row.ignored = count(['--others', '--ignored', '--exclude-standard']);
      }
      if (branch?.startsWith('lane/')) {
        if (details || sweep) Object.assign(row, laneWorkHistory(branch, fullHead, args => git(['--git-dir', common, ...args]).stdout));
        if (archivalRetirement === true && canonicalRoot && !retirementHold(canonicalRoot) && row.clean === true && row.linked === true && row.integrated === false &&
            row.hasOwnCommits !== false && /^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(branch) && /^[a-f0-9]{40,64}$/.test(fullHead ?? '')) row.archival = observeArchivalHistory({
          branch, tip: fullHead, main, mainTip: row.mainTip, git: args => git(['--git-dir', common, ...args]).stdout.trim() });
        const tag = `archive/${branch}`;
        const archived = git(['--git-dir', common, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], [0, 1]);
        if (archived.status === 0) { row.archiveTag = tag; row.archiveMatchesHead = archived.stdout.trim() === fullHead; }
        row.patchIntegrated = patchesIntegrated(row.archival);
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
  try { worktrees = readRetirementWorktrees(retirement.common, { main: retirement.main, command: options.command, env,
    archivalRetirement: snapshot.archivalRetirementPolicy }); }
  catch (error) { worktrees = []; snapshot = { ...snapshot, errors: [...(snapshot.errors ?? []), error.message] }; }
  worktrees = worktrees.map(row => ({ ...row, lane: row.branch?.startsWith('lane/') ? row.branch.slice(5) : null,
    paneCount: (snapshot.panes ?? []).filter(p => (snapshot.workspaces ?? []).some(w => w.workspace_id === p.workspace_id && w.worktree.checkout_path === row.worktree)).length }));
  for (const tree of worktrees.filter(t => t.branch?.startsWith('lane/'))) {
    if (tree.clean !== true || (tree.integrated !== true && tree.archiveMatchesHead !== true && !snapshot.archivalRetirementPolicy)) continue;
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
  if (positionals.length !== 1 || !['plan', 'apply', 'consume', 'status', 'sweep'].includes(positionals[0])) throw Error('expected plan, apply, consume, status or sweep');
  if (positionals[0] === 'sweep') {
    if (!opt.lane) throw Error('manual recovery requires a named --lane PATH; no project scan');
    const { retryCloseout, readCloseoutEntries, closeoutPolicy, recoverLane } = await import('./closeout.mjs');
    const { gitProject } = await import('./project.mjs');
    const project = gitProject(opt.repo), org = opt.org ?? findOrgDir({ cwd: opt.repo });
    const entry = readCloseoutEntries(project.identity).find(e => e.cwd === canonical(opt.lane) && ['landed', 'parked'].includes(e.signal));
    if (closeoutPolicy(project.canonical, undefined, { requireServiceSource: false })) {
      process.stdout.write(JSON.stringify(entry ? retryCloseout({ cwd: opt.repo, org, topic: entry.key, why: 'explicit named manual recovery' }) :
        recoverLane({ cwd: opt.repo, org, lane: canonical(opt.lane) })) + '\n');
    } else {
      const release = claimLegacyRetirement(project.identity);
      try {
        const retirement = createRetirement({ cwd: opt.repo, org, herdr: opt.herdr, requireRecord: true });
        const branch = spawnSync('git', ['-C', opt.lane, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' });
        if (branch.status !== 0) throw Error('named recovery lane Git identity unavailable');
        const unlock = acquireLock(path.join(project.identity, 'lane-promote.lock'));
        try { process.stdout.write(JSON.stringify(retirement.removeLane({ lane: canonical(opt.lane), branch: branch.stdout.trim() })) + '\n'); }
        finally { unlock(); }
      } finally { release(); }
    }
    return;
  }
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
