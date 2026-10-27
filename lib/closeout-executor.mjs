// Finite, demand-driven consumer. No clock-based eligibility or idle polling.
import { bindCloseoutCode } from './closeout-code.mjs';
import { verifyCloseoutHandoff } from './closeout-handoff.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitProject } from './project.mjs';
import { findOrgDir, loadEvents, transact } from './store.mjs';
import { fold } from './state.mjs';
import { boundSuccessor } from './session-release.mjs';
import { createRetirement } from './retire-runtime.mjs';
import { retirementHold } from './retire-hold.mjs';
import { retirementLock } from './retire-lock.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { closeoutDirectory, closeoutPolicy, closeoutRevision, readCloseoutEntries, queueTransaction,
  retirementOwnerLock, sameFileIdentity, assertQueueOwnership, closeoutRemovalReceipt, pruneCompletedCloseout, closeoutRecordMatches,
  observeCloseoutContent, actionableCloseout, closeoutBindingMatches, closeoutSourceEnabled, safeCloseoutRetry, lineServiceOwnsCleanup,unresolvedCloseoutEffect,closeoutOutcomeObservation,CLOSEOUT_EXIT_PENDING } from './closeout.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const session = a => a.agent_session?.value ?? a.agent_session_id;
const effectId = (entry, row) => createHash('sha256').update(JSON.stringify([
  entry.key, row.action, row.tab_id ?? row.tab ?? row.workspace_id ?? row.pane ?? row.branch ?? row.cwd,
  ...(row.action === 'lane-preflight' ? [row.evidence?.directory] : []),
])).digest('hex');

function recordEffect(org, entry, row) {
  // Named effects are immutable and reconciled by identity on restart. Keeps
  // belong in evaluations, so failures can be retried after their named event.
  if (!['session-released', 'exit-observed', 'closed', 'archive-created', 'lane-preflight', 'worktree-removed', 'branch-removed', 'lane-removed',
    'agent-exit-requested', 'shell-close-requested', 'workspace-close-requested'].includes(row.action)) return;
  const id = effectId(entry, row);
  transact(org, events => ({ add: events.some(e => e.type === 'closeout.effect' && e.effect === id) ? [] : [{
    type: 'closeout.effect', key: entry.key, effect: id, identity: entry.common, run: entry.run, item: entry.item,
    source: entry.source, outcome: row,
  }] }), { actor: 'lane closeout' });
}

function waitFor(reason, entry) {
  const retry = `node supervisor/closeout.mjs retry ${entry.key} --why '<resolved condition>' --repo ${entry.project}`;
  if (/HOLD-WORKER-TAB-CLOSE/.test(reason)) return { event: 'hold-removed', observation: 'explicit retry required after HOLD removal', retry };
  if (/^landed or parked request owns/.test(reason)) return { event: 'closeout.effect:lane-removed', observation: 'the matching bound retirement receipt re-enqueues this request', retry };
  if (/reference|callback.*live|open run|chain|continuation|successor|follow.up|report.*ingested/.test(reason)) return {
    event: 'target-record-changed', observation: 'related record events re-enqueue; external reference removal requires explicit retry', retry };
  if (/focus|this tab/.test(reason)) return { event: 'focus-released', observation: 'explicit retry required after focus changes', retry };
  if (/locked:/.test(reason)) return { event: 'lifecycle-lock-released', observation: 'promotion completion re-enqueues; otherwise explicit retry required', retry };
  return { event: 'target-revised', observation: 'explicit retry required; stale identity/head requires a new bound source event', retry };
}

function evaluateEntry(entry, { env, retirementOptions = {}, code, observationOnly=false }) {
  const currentEvents = loadEvents(entry.org).events;
  const retiredReceipt = !fs.existsSync(entry.cwd) && closeoutRemovalReceipt(entry, currentEvents);
  if (retiredReceipt && retiredReceipt.key !== entry.key) return { resolved_by: retiredReceipt.seq, reason: 'same worktree retired by a later bound request' };
  const held = retirementHold(entry.project);
  if (held) return { deferred: true, reason: held };
  if (entry.signal === 'ready') {
    const pendingRemoval = readCloseoutEntries(entry.common, { onInvalid: () => {} }).find(other =>
      other.org === entry.org && other.project === entry.project &&
      ['landed', 'parked'].includes(other.signal) && other.cwd === entry.cwd && other.head === entry.head &&
      JSON.stringify(other.worktreeIdentity) === JSON.stringify(entry.worktreeIdentity) &&
      JSON.stringify(other.branchLog) === JSON.stringify(entry.branchLog) &&
      currentEvents.some(e => e.seq === other.source.seq && e.closeout_targets?.some(t => t.key === other.key && JSON.stringify(t.panes) === JSON.stringify(other.panes))) &&
      !currentEvents.findLast(e => e.type === 'closeout.evaluated' && e.key === other.key)?.completed);
    if (pendingRemoval) return { deferred: true, reason: 'landed or parked request owns the remaining bound sessions; awaiting its retirement effects' };
  }
  const effects = () => loadEvents(entry.org).events.filter(e => e.type === 'closeout.effect' && e.key === entry.key);
  const proof = () => {
    const saved = effects().findLast(e => e.outcome.action === 'lane-preflight')?.outcome;
    if (!saved) return undefined;
    const { action, ...value } = saved;
    return { ...value, branchGeneration: value.branchGeneration ?? entry.branchLog };
  };
  const guard = () => {
    code.verify();
    const loaded = loadEvents(entry.org);
    if (loaded.tornTail || !closeoutBindingMatches(entry, loaded.events.find(e => e.seq === entry.source.seq && e.type === entry.source.type), loaded.events)) throw Error('queued source binding changed; keep');
    verifyCloseoutHandoff(entry, loaded.events);
    assertQueueOwnership({ canonical: entry.project }, entry.org);
    if (!closeoutSourceEnabled(entry, loaded.events) || gitProject(entry.project).identity !== entry.common) throw Error('queue retirement ownership or project identity changed; keep');
    if (entry.signal === 'ready') {
      const state = fold(loadEvents(entry.org).events), boundRuns = new Set(entry.panes.map(p => p.run ?? entry.run));
      for (const old of state.runs.values()) if (old.workspace === entry.cwd && old.abandoned && !old.report &&
          !boundRuns.has(old.id) && boundRuns.has(boundSuccessor(state, old)?.id))
        throw Error('retained successor awaits a request binding its newly superseded predecessor');
    }
    const branch = git(entry.project, ['for-each-ref', '--format=%(objectname)', `refs/heads/${entry.branch}`]);
    if (branch && entry.branchLog && (!sameFileIdentity(entry.branchLog.path, entry.branchLog.identity) ||
        createHash('sha256').update(fs.readFileSync(entry.branchLog.path)).digest('hex') !== entry.branchLog.sha256)) throw Error('queued branch generation changed; keep');
    if (fs.existsSync(entry.cwd)) {
      if (!sameFileIdentity(entry.cwd, entry.worktreeIdentity) || !sameFileIdentity(entry.gitDirectory, entry.gitIdentity) ||
          git(entry.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== entry.common ||
          git(entry.cwd, ['rev-parse', '--absolute-git-dir']) !== entry.gitDirectory ||
          git(entry.cwd, ['symbolic-ref', '--short', 'HEAD']) !== entry.branch || git(entry.cwd, ['rev-parse', 'HEAD']) !== entry.head)
        throw Error('queued worktree identity or expected head changed; keep');
    } else {
      const saved = proof();
      if (!saved || saved.cwd !== entry.cwd || saved.branch !== entry.branch || saved.tip !== entry.head ||
          git(entry.project, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${entry.cwd}`)) throw Error('queued worktree absent without a preservation proof; keep');
      // A different branch under the old name is never the removed branch.
      const refs = git(entry.project, ['for-each-ref', '--format=%(objectname)', `refs/heads/${entry.branch}`]);
      if (refs && refs !== entry.head) throw Error('queued branch identity changed after partial removal; keep');
      if (refs && !entry.branchLog) throw Error('queued branch generation is unknown after partial removal; keep');
    }
  };
  let selectedPane;
  const allowed = snapshot => {
    const tabs = new Set();
    for (const bound of entry.panes) {
      if (selectedPane && selectedPane !== bound.pane) continue;
      const pane = snapshot.panes.find(p => p.pane_id === bound.pane);
      if (!pane) {
        if (snapshot.agents.some(a => a.terminal_id === bound.terminal || session(a) === bound.session)) throw Error('queued native session moved to another pane; keep');
        continue;
      }
      const agents = snapshot.agents.filter(a => a.pane_id === bound.pane || a.tab_id === pane.tab_id);
      const exited = snapshot.exits.find(e => e.run === (bound.run ?? entry.run) && e.pane === bound.pane &&
        e.occupant.terminal_id === bound.terminal && e.occupant.agent_session_id === bound.session);
      const callback = snapshot.callbacks.find(c => c.kind === 'settle' && c.pane === bound.pane &&
        c.run === (bound.run ?? entry.run) &&
        c.terminal_id === bound.terminal && c.agent_session_id === bound.session);
      const shell = pane.process_info?.process_tree?.find(p => p.pid === pane.process_info.shell_pid);
      if (pane.workspace_id !== bound.workspace || pane.terminal_id !== bound.terminal ||
          (bound.tab && pane.tab_id !== bound.tab) ||
          (bound.shell && ['pid', 'identity', 'command'].some(k => shell?.[k] !== bound.shell[k])) ||
          (bound.process && agents.length && !pane.process_info.process_tree.some(p =>
            ['pid', 'identity', 'command'].every(k => p[k] === bound.process[k]))) ||
          agents.some(a => a.name !== bound.agent || a.terminal_id !== bound.terminal || session(a) !== bound.session || a.cwd !== entry.cwd) ||
          (!agents.length && !exited && !callback) || snapshot.panes.some(p => p.tab_id === pane.tab_id && p.pane_id !== bound.pane))
        throw Error('queued pane, terminal, native session or process identity changed; keep');
      tabs.add(pane.tab_id);
    }
    return tabs;
  };
  const results = [];
  const adapter = createRetirement({ ...retirementOptions, cwd: entry.project, org: entry.org, env, requireRecord: true,
    guard, lockRemoval: () => acquireLock(path.join(entry.common, 'lane-promote.lock')), selectPlan: (plan, snapshot) => {
      const tabs = allowed(snapshot);
      return { ...plan, close: plan.close.filter(t => tabs.has(t.tab_id)),
        sessionReleases: (plan.sessionReleases ?? []).filter(t => tabs.has(t.tab_id)), workspaceClose: [] };
    }, log: row => { recordEffect(entry.org, entry, row); results.push(row); retirementOptions.log?.(row); } });
  guard(); adapter.assertLaneRecord();
  if (!fs.existsSync(entry.cwd)) {
    if(observationOnly)return{deferred:true,reason:'original exit target is absent without a fresh native outcome readback; keep'};
    if (!['landed', 'parked'].includes(entry.signal)) return { deferred: true, reason: 'worktree already removed; pane-only signal has no removal authority' };
    adapter.resumeLaneRemoval(proof());
    return { results };
  }
  const reconcileExits = () => {
    const prior = effects(); let reconciled = false;
    for (const event of prior.filter(e => e.outcome.action === 'agent-exit-requested')) {
      const intent = event.outcome;
      if (prior.some(e => e.outcome.action === 'exit-observed' && e.outcome.pane === intent.pane) ||
          !entry.panes.some(b => (b.run ?? entry.run) === intent.run && b.pane === intent.pane && b.terminal === intent.occupant?.[5] && b.session === intent.occupant?.[6])) continue;
      reconciled = adapter.reconcileAgentExit(intent) || reconciled;
    }
    return reconciled;
  };
  const reconcileClosures = snapshot => {
    allowed(snapshot);
    for (const event of effects().filter(e => e.outcome.action === 'shell-close-requested')) {
      const intent = event.outcome;
      if (!snapshot.tabs.some(t => t.tab_id === intent.tab_id) && intent.panes?.every(p =>
          entry.panes.some(b => b.pane === p.pane && b.terminal === p.terminal) && !snapshot.panes.some(live => live.pane_id === p.pane)))
        recordEffect(entry.org, entry, { action: 'closed', tab_id: intent.tab_id, reconciled: true });
    }
  };
  reconcileExits();
  if(observationOnly)return{deferred:true,reason:unresolvedCloseoutEffect(entry,loadEvents(entry.org).events)?
    CLOSEOUT_EXIT_PENDING:
    'original native outcome reconciled; fresh drain required',results};
  if(effects().some(e=>e.outcome.action==='shell-close-requested'))reconcileClosures(adapter.observe(entry.cwd));
  if(unresolvedCloseoutEffect(entry,loadEvents(entry.org).events))return {deferred:true,reason:CLOSEOUT_EXIT_PENDING,results};
  // Replan each bound session after the preceding effect's record append. That
  // append changes the authority revision; an old plan must never be replayed.
  for (const pane of entry.panes) {
    selectedPane = pane.pane;
    const planned = adapter.plan(entry.cwd);
    results.push(...adapter.apply(planned, entry.cwd));
    if (reconcileExits()) results.push(...adapter.apply(adapter.plan(entry.cwd), entry.cwd));
  }
  selectedPane = undefined;
  const snapshot = adapter.observe(entry.cwd), tabs = allowed(snapshot), planned = adapter.plan(entry.cwd);
  reconcileClosures(snapshot);
  const kept = planned.keep.filter(t => tabs.has(t.tab_id));
  if (kept.length || snapshot.retirementHold) return { deferred: true, reason: snapshot.retirementHold ?? kept.map(t => t.why).join('; '), results };
  if (entry.signal === 'ready' || entry.signal === 'review-done') {
    const remaining = snapshot.panes.filter(p => entry.panes.some(b => b.pane === p.pane_id));
    return remaining.length ? { deferred: true, reason: 'bound session remains; release or same-session follow-up awaits record change', results } : { results };
  }
  // Source observations never authorize removal. Re-read the named head's
  // ancestry, patch history or exact archive, including for legacy train entries.
  // Parked requests retain their explicit dropped-item/archive preflight.
  let removal = {};
  if (entry.signal === 'landed') {
    const { content, archival } = observeCloseoutContent({ project: entry.project, branch: entry.branch, head: entry.head });
    if (content.main !== adapter.main) throw Error('closeout integration branch changed; lane kept');
    removal = content.kind === 'archival-retirement' ? { archival, sweep: true } :
      content.kind === 'archive-tagged' ? { archiveTip: entry.head } : { expectedTip: entry.head };
  }
  // removeLane independently proves disposition, references, vacancy, Git,
  // preservation and the freshly selected content proof before its effects.
  const removed = adapter.removeLane({ lane: entry.cwd, branch: entry.branch, gitOnly: true,
    ...removal });
  if (removed.pending.length) return { deferred: true, reason: removed.pending.join('; '), results };
  return { results };
}

export function drainCloseout({ cwd = process.cwd(), org = findOrgDir({ cwd }), env = process.env,
  retirementOptions, beforeExit = () => {}, onClaim = () => {}, keys, loadedCode, retrySafe = false } = {}) {
  if (keys !== undefined && (!Array.isArray(keys) || keys.some(k => !/^[a-f0-9]{64}$/.test(k)))) throw Error('invalid closer keys');
  if (keys?.length === 0) return { evaluated: [] };
  const project = gitProject(cwd), directory = closeoutDirectory(project.identity);
  if (!closeoutRecordMatches(project, org, env)) return { evaluated: [] };
  if (keys === undefined && lineServiceOwnsCleanup(project, org)) return { owned_by: 'line-service', evaluated: [] };
  const record = fs.realpathSync(org);
  let code;
  let release, ownership;
  queueTransaction(project.identity, () => {
    try { release = retirementLock(path.join(directory, 'consumer.lock')); }
    catch (e) { if (!e.message.startsWith('locked:')) throw e; }
  });
  if (!release) return { already_running: true };
  const attempted = new Map(), evaluated = [];
  try {
    code = bindCloseoutCode(project, loadedCode);
    onClaim(code.binding);
    // The legacy tick and queue share the retirement ownership lock. Read the
    // policy under that lock, so activation cannot overlap an in-flight tick.
    ownership = retirementLock(retirementOwnerLock(project.identity), { waitMs: 60000 });
    if (!closeoutPolicy(project.canonical)) return { disabled: true };
    const consume = () => {
      code.verify();
      let pending;
      queueTransaction(project.identity, () => {
        const { events, tornTail } = loadEvents(org);
        if (tornTail) throw Error('incomplete closeout record');
        const state = fold(events);
        const invalid = diagnostic => {
          const id = createHash('sha256').update(JSON.stringify(diagnostic)).digest('hex');
          transact(org, current => ({ add: current.some(e => e.type === 'closeout.invalid' && e.id === id) ? [] : [
            { type: 'closeout.invalid', id, identity: project.identity, ...diagnostic }],
          }), { actor: 'lane closeout' });
        };
        const entries = readCloseoutEntries(project.identity, { onInvalid: invalid, keys }).filter(entry =>
          entry.org === record || events.some(source => source.seq === entry.source.seq && source.type === entry.source.type &&
            source.closeout_targets?.some(target => target.key === entry.key && target.org === record && target.project === project.canonical)));
        pruneCompletedCloseout(project.identity, org, entries, events);
        pending = entries.filter(entry => {
          try {
          if (entry.org !== fs.realpathSync(org) || entry.project !== project.canonical) throw Error('closeout record/project binding changed');
          const source = events.find(e => e.seq === entry.source.seq && e.type === entry.source.type);
          if (!source) throw Error('closeout source event is missing; keep');
          const bound = source.closeout_targets?.find(e => e.key === entry.key);
          if (!bound || !closeoutBindingMatches(entry, source, events)) throw Error('closeout target differs from its source record binding; keep');
          if (!closeoutSourceEnabled(entry, events)) return false;
          const prior = events.findLast(e => e.type === 'closeout.evaluated' && e.key === entry.key);
          if (prior?.completed) return false;
          if (!actionableCloseout(entry, events)) return false;
          verifyCloseoutHandoff(entry, events);
          const revision = closeoutRevision(entry, events, state);
          return revision > Math.max(prior?.revision ?? 0, attempted.get(entry.key) ?? 0) ||
            retrySafe && keys !== undefined && !attempted.has(entry.key) &&
              (safeCloseoutRetry(prior,{entry,events})||closeoutOutcomeObservation(prior,{entry,events}));
          } catch (e) {
            invalid({ key: entry.key, reason: e.message, waiting: { event: 'source-repaired', observation: 'restore the original source binding, then explicitly drain' } });
            return false;
          }
        }).map(entry => ({ entry, revision: closeoutRevision(entry, events, state),
          observationOnly:retrySafe&&Boolean(unresolvedCloseoutEffect(entry,events)) }));
        if (!pending.length) {
          beforeExit();
          release(); release = null;
        }
      });
      if (!pending.length) return;
      for (const { entry, revision,observationOnly } of pending) {
        attempted.set(entry.key, revision);
        code.verify();
        let outcome;
        try {
          assertQueueOwnership(project, org);
          outcome = evaluateEntry(entry, { env, retirementOptions, code,observationOnly });
        } catch (e) { if (e.code === 'CLOSEOUT_CODE_CHANGED') throw e; outcome = { deferred: true, reason: e.message }; }
        const row = { type: 'closeout.evaluated', key: entry.key, identity: entry.common, run: entry.run, item: entry.item,
          source: entry.source, revision, code: code.binding, completed: !outcome.deferred,
          ...(entry.handoff ? { handoff: entry.handoff } : {}),
          ...(outcome.resolved_by ? { resolved_by: outcome.resolved_by, reason: outcome.reason } : {}),
          ...(outcome.deferred ? { reason: outcome.reason, waiting: waitFor(outcome.reason, entry) } : {}) };
        transact(org, () => ({ add: [row] }), { actor: 'lane closeout' });
        evaluated.push(row);
      }
      // Catch only entries/revisions enqueued while this finite batch ran.
      // The empty check and claim release are atomic with enqueue, not a timer.
      consume();
    };
    consume();
    return { evaluated };
  } catch (error) {
    if (error.code !== 'CLOSEOUT_CODE_CHANGED') throw error;
    let pending;
    queueTransaction(project.identity, () => {
      pending = readCloseoutEntries(project.identity, { onInvalid: () => {}, keys }).filter(e => e.org === record).map(e => e.key);
      const handoff = { type: 'closeout.code-handoff', identity: project.identity, keys: pending, old: error.binding, current: error.current };
      transact(org, () => ({ add: [handoff] }), { actor: 'closer code freshness' });
      // Pair this exit with producers just like the ordinary empty handoff:
      // publication is either in these exact keys or sees a released owner.
      ownership?.(); ownership = null; release?.(); release = null;
    });
    return { evaluated, restart: { keys: pending, old: error.binding, current: error.current } };
  } finally { ownership?.(); release?.(); }
}
