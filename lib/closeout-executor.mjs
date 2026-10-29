// Finite, demand-driven consumer. No clock-based eligibility or idle polling.
import { bindCloseoutCode } from './closeout-code.mjs';
import { verifyCloseoutHandoff } from './closeout-handoff.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {performance} from 'node:perf_hooks';
import { gitProject } from './project.mjs';
import { findOrgDir, loadEvents, planTransaction } from './store.mjs';
import { fold } from './state.mjs';
import { closedSessionCompletion } from './completion-session.mjs';
import { effectiveWorkerIdentity } from './worker-identity.mjs';
import { boundSuccessor } from './session-release.mjs';
import { createRetirement } from './retire-runtime.mjs';
import { retirementHold } from './retire-hold.mjs';
import { retirementLock } from './retire-lock.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { closeoutDirectory, closeoutPolicy, closeoutRevision, readCloseoutEntries, queueTransaction,
  retirementOwnerLock, sameFileIdentity, assertQueueOwnership, closeoutRemovalReceipt, pruneCompletedCloseout, closeoutRecordMatches,
  observeCloseoutContent, actionableCloseout, closeoutBindingMatches, closeoutSourceEnabled, safeCloseoutRetry, lineServiceOwnsCleanup,unresolvedCloseoutEffect,closeoutOutcomeObservation,CLOSEOUT_EXIT_PENDING,closeoutEvaluations } from './closeout.mjs';
import {appendCloseoutObservation,routineCloseoutObservation} from './closeout-diagnostics.mjs';
import {outcomeFailure} from './uncertain-outcome.mjs';
import {recoverNeverStartedCloseouts} from './closeout-unsent.mjs';
import { preserveReportContext } from './report-closeout.mjs';
import {closeoutCondition,closeoutResources,recordedCloseoutRefusal} from './closeout-facts.mjs';
import { directCloseoutObservation, currentCloseoutEntries, closeoutEvaluation } from './closeout.mjs';
import {linkedCloseoutStatuses,nativeCloseoutWait,registerCloseoutWait,closeoutWait,closeoutWaitState,closeoutProducer,closeoutNextStage,pendingRemovalOwner,closeoutCommandNotStarted,unresolvedGitRemoval} from './closeout-status.mjs';
export {refreshCloseouts} from './closeout-recovery.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const session = a => a.agent_session?.value ?? a.agent_session_id;
const nativeIntent = action => ['agent-exit-requested', 'shell-close-requested', 'workspace-close-requested'].includes(action);
const effectId = (entry, row) => createHash('sha256').update(JSON.stringify([
  entry.key, row.action, row.tab_id ?? row.tab ?? row.workspace_id ?? row.pane ?? row.branch ?? row.cwd,
  ...(['lane-preflight','lane-evidence-discarded'].includes(row.action) ? [row.evidence?.directory??row.directory] : []),
  ...(['git-removal-started','git-removal-finished'].includes(row.action) ? [row.attempt] : []),
])).digest('hex');

function recordEffect(org, entry, row) {
  // Named effects are immutable and reconciled by identity on restart. Keeps
  // belong in evaluations, so failures can be retried after their named event.
  // Returns the effect id only when this call journaled it.
  if (!['report-evidence', 'branch-kept', 'session-unbound', 'session-released', 'exit-observed', 'closed', 'allocation-absent', 'archive-created', 'lane-preflight', 'lane-evidence-discarded', 'worktree-removed', 'branch-removed', 'lane-removed',
    'agent-exit-requested', 'shell-close-requested', 'workspace-close-requested', 'git-removal-started', 'git-removal-finished'].includes(row.action)) return;
  const base = effectId(entry, row);
  const original = row;
  const result = planTransaction(org, events => {
    let id = base;
    row = original;
    if (nativeIntent(row.action)) {
      // Only positive no-execution permits another attempt. Keep the original
      // immutable identity, and journal its successor before allowing a send.
      let prior;
      while ((prior = events.find(e => e.type === 'closeout.effect' && e.effect === id))) {
        if (!events.some(e => e.type === 'closeout.command-not-started' && e.intent === id &&
            e.native_started === false && e.seq > prior.seq && e.identity === entry.common && e.key === entry.key &&
            e.source?.seq === entry.source.seq && e.source?.type === entry.source.type))
          throw Error('original native intent already journaled; retain without replay');
        id = createHash('sha256').update(JSON.stringify([base, prior.effect])).digest('hex');
      }
    } else if(events.some(e=>e.type==='closeout.effect'&&e.effect===id))return{add:[]};
    if (row.action === 'closed') {
      const state = fold(events);
      const intent = events.findLast(e => e.type === 'closeout.effect' && e.key === entry.key &&
        e.outcome.action === 'shell-close-requested' && e.outcome.tab_id === row.tab_id)?.outcome;
      const bound = entry.panes.filter(p => row.workspace_id ? p.workspace === row.workspace_id
        : intent?.panes?.some(target => target.pane === p.pane && target.terminal === p.terminal) || p.tab === row.tab_id);
      const sessions = bound.map(p => {
        const run = state.runs.get(p.run ?? entry.run);
        const exit = events.findLast(e => e.type === 'closeout.effect' && e.key === entry.key &&
          e.outcome.action === 'agent-exit-requested' && e.outcome.pane === p.pane)?.outcome;
        return { run: p.run ?? entry.run, item: run?.item ?? entry.item,
          ...closedSessionCompletion(run, state, { session: p.session, harness: exit?.occupant?.[1],
            workspace: entry.cwd, branch: entry.branch }) };
      });
      row = { ...row, ...(sessions.length === 1 ? sessions[0] : {}), sessions };
    }
    const intent=events.findLast(e=>e.type==='closeout.effect'&&e.identity===entry.common&&e.key===entry.key&&
      e.source?.seq===entry.source.seq&&e.source?.type===entry.source.type&&
      (row.action==='exit-observed'&&e.outcome?.action==='agent-exit-requested'&&e.outcome.pane===row.pane&&
        e.outcome.occupant?.[5]===row.occupant?.terminal_id&&e.outcome.occupant?.[6]===row.occupant?.agent_session_id||
       row.action==='closed'&&(e.outcome?.action==='shell-close-requested'&&e.outcome.tab_id===row.tab_id||
         e.outcome?.action==='workspace-close-requested'&&e.outcome.workspace_id===row.workspace_id)));
    const add=[{type:'closeout.effect',key:entry.key,effect:id,identity:entry.common,run:entry.run,item:entry.item,source:entry.source,
      ...(intent?{intent:intent.effect}:{}),...(nativeIntent(row.action)?{producer:'native-closeout/v2'}:{}),outcome:row}];
    if(nativeIntent(row.action))add.push(nativeCloseoutWait(entry,row,id));
    return{add:[...add,...linkedCloseoutStatuses(events,add)],result:id};
  }, { actor: 'lane closeout', replaySafe: true });
  return result.result;
}

function nextStage(entry, outcome, events) {
  const next=closeoutNextStage(entry,{...outcome,completed:false},events,readCloseoutEntries(entry.common,{onInvalid:()=>{}}));
  return next&&{owner:'lane-closeout',next:next.stage,producers:[]};
}

function waitFor(reason, entry, events, failure) {
  return closeoutProducer(entry,{reason,failure},{events,entries:readCloseoutEntries(entry.common,{onInvalid:()=>{}})});
}

function evaluateEntry(entry, { env, retirementOptions = {}, code, observationOnly=false,sessionsOnly=false,stages={} }) {
  const measured=(stage,fn)=>{const at=performance.now();try{return fn();}finally{stages[stage]=(stages[stage]??0)+performance.now()-at;}};
  const currentEvents = loadEvents(entry.org).events;
  const unbound = entry.reportCloseout && entry.panes.length === 0;
  const retiredReceipt = !fs.existsSync(entry.cwd) && closeoutRemovalReceipt(entry, currentEvents);
  if (retiredReceipt && retiredReceipt.key !== entry.key) return { resolved_by: retiredReceipt.seq, reason: 'same worktree retired by a later bound request' };
  const held = retirementHold(entry.project);
  if (held) return { deferred: true, reason: held };
  if (!entry.reportCloseout && pendingRemovalOwner(entry, readCloseoutEntries(entry.common, { onInvalid: () => {} }), currentEvents))
    return { deferred: true, reason: 'landed or parked request owns the remaining bound sessions; awaiting its retirement effects' };
  const effects = () => loadEvents(entry.org).events.filter(e => e.type === 'closeout.effect' && e.key === entry.key &&
    e.identity===entry.common && e.source?.seq===entry.source.seq && e.source?.type===entry.source.type);
  const neverSent=()=>loadEvents(entry.org).events.filter(e=>e.type==='closeout.command-not-started'&&e.native_started===false&&
    e.identity===entry.common&&e.key===entry.key&&e.source?.seq===entry.source.seq&&e.source?.type===entry.source.type);
  const proof = () => {
    const rows=effects();
    const saved = rows.findLast(e => e.outcome.action === 'lane-preflight'&&
      typeof e.outcome.evidence?.directory==='string'&&fs.existsSync(e.outcome.evidence.directory)&&
      !rows.some(d=>d.outcome.action==='lane-evidence-discarded'&&d.outcome.directory===e.outcome.evidence?.directory))?.outcome;
    if (!saved) return undefined;
    const { action, ...value } = saved;
    return { ...value, branchGeneration: value.branchGeneration ?? entry.branchLog };
  };
  const guard = ({missingObservation=false}={}) => {
    code.verify();
    for(const file of [path.join(entry.project,'.lane/supervisor/STOP'),path.join(entry.project,'.lane/supervisor/HOLD'),
      path.join(entry.org,'line-service',createHash('sha256').update(JSON.stringify(entry.common)).digest('hex').slice(0,20),'STOP')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents queued retirement effect');
    const loaded = loadEvents(entry.org);
    if (loaded.tornTail || !closeoutBindingMatches(entry, loaded.events.find(e => e.seq === entry.source.seq && e.type === entry.source.type), loaded.events)) throw Error('queued source binding changed; keep');
    verifyCloseoutHandoff(entry, loaded.events);
    const state=fold(loaded.events);
    if(entry.allocation){
      const run=state.runs.get(entry.run),a=entry.allocation,item=state.items.get(entry.item);
      if(!run||run.started.seq!==a.started_seq||(run.owner_generation??null)!==a.claim_generation||
          (run.meta?.dispatch_attempt??null)!==a.dispatch||
          (run.report?.sha256??null)!==a.report_sha256||item?.runs.at(-1)!==entry.run)
        throw Error('original report allocation/current run/claim changed; keep');
    }
    if(recordedCloseoutRefusal(entry,loaded.events))
      throw Error('original native refusal remains held; explicit owner clearing evidence required');
    if(entry.reportCloseout&&!entry.panes.some(p=>(p.run??entry.run)===entry.run)&&!unbound)
      throw Error('original native session identity missing; keep allocation for original binding producer');
    if(unbound){
      const run=state.runs.get(entry.run),identity=effectiveWorkerIdentity(run,state);
      if(!entry.allocation||identity.identity_conflict||identity.agent_session_id||
          !(run?.report||run?.abandoned)||
          JSON.stringify(state.workerReceipts?.get(run.id)??null)!==JSON.stringify(entry.allocation.worker))
        throw Error('unbound allocation original worker/claim changed; keep');
    }
    if((entry.cleanup||entry.reportCloseout)&&loaded.events.some(source=>source.closeout_targets?.some(target=>target.common===entry.common&&target.cwd===entry.cwd&&!(target.key===entry.key&&source.seq===entry.source.seq)&&
      unresolvedCloseoutEffect({...target,source:{seq:source.seq,type:source.type}},loaded.events))))
      throw Error('original uncertain allocation remains held; cleanup binding cannot replace its request');
    assertQueueOwnership({ canonical: entry.project }, entry.org);
    if (!closeoutSourceEnabled(entry, loaded.events, { requireServiceSource: true }) || gitProject(entry.project).identity !== entry.common) throw Error('queue retirement ownership or project identity changed; keep');
    if (entry.signal === 'ready') {
      const state = fold(loadEvents(entry.org).events), boundRuns = new Set(entry.panes.map(p => p.run ?? entry.run));
      for (const old of state.runs.values()) if (old.workspace === entry.cwd && old.abandoned && !old.report &&
          !boundRuns.has(old.id) && boundRuns.has(boundSuccessor(state, old)?.id))
        throw Error('retained successor awaits a request binding its newly superseded predecessor');
    }
    // A proven never-sent allocation can be observed absent without granting
    // any Git effect or claiming that its missing folder was preserved.
    if(missingObservation&&!fs.existsSync(entry.cwd))return;
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
    if(unbound){
      // No session is reconstructed. Only an original terminal's inert shell
      // can use the existing inert-shell planner; any agent row stays owned.
      const worker=entry.allocation.worker;
      if(snapshot.errors.length)throw Error('unbound allocation native inventory incomplete; keep');
      if(snapshot.agents.some(a=>a.cwd===entry.cwd||worker?.agent&&a.name===worker.agent||
          worker?.pane&&a.pane_id===worker.pane||worker?.terminal_id&&a.terminal_id===worker.terminal_id))
        throw Error('unbound allocation still has a native occupant; original session remains unknown');
      for(const pane of snapshot.panes.filter(p=>p.cwd===entry.cwd||p.foreground_cwd===entry.cwd||
          snapshot.workspaces.some(w=>w.workspace_id===p.workspace_id&&w.worktree?.checkout_path===entry.cwd))){
        if(!worker||pane.pane_id!==worker.pane||pane.terminal_id!==worker.terminal_id||pane.workspace_id!==worker.worker_workspace)
          throw Error('unbound allocation has an unproven native pane; keep');
        tabs.add(pane.tab_id);
      }
      return tabs;
    }
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
  const pendingNative=()=>{
    const refused=results.findLast(r=>r.failure?.kind==='fence'||/EPERM|EACCES|native refusal|permission denied|operation not permitted/i.test(r.why??''));
    const terminal=results.findLast(r=>['skip-close','close-failed','deferred'].includes(r.action));
    if(refused||unresolvedCloseoutEffect(entry,loadEvents(entry.org).events))return{deferred:true,
      reason:refused?.why??CLOSEOUT_EXIT_PENDING,...(refused?.failure?{failure:refused.failure}:{}),
      ...(terminal?{native_result:{action:terminal.action,reason:terminal.why,...(terminal.command_error?{error:terminal.command_error}:{}),
        ...(terminal.exit_observation?{exit_observation:terminal.exit_observation}:{})}}:{}),results};
    if(terminal?.action==='deferred')return{deferred:true,reason:terminal.why,results};
  };
  // The adapter journals an exit/close intent, then invokes the native command,
  // whose first step is this guard. A refusal there means the command was never
  // sent: record that once, so the intent is not stranded as UNKNOWN.
  let unsent;
  const commandGuard = () => {
    const intent = unsent; unsent = undefined;
    try { guard(); }
    catch (error) {
      if (intent) planTransaction(entry.org, events => {
        if (events.some(e => e.type === 'closeout.command-not-started' && e.identity === entry.common && e.key === entry.key && e.intent === intent.id)) return { add: [] };
        const add = [closeoutCommandNotStarted(entry, intent.id, intent.action, error)];
        return { add: [...add, ...linkedCloseoutStatuses(events, add)] };
      }, { actor: 'lane closeout', replaySafe: true });
      throw error;
    }
  };
  const adapter = createRetirement({ ...retirementOptions, cwd: entry.project, org: entry.org, env, requireRecord: true,
    ...(entry.reportCloseout ? { reportCloseout: { run: entry.run, cwd: entry.cwd } } : {}),
    guard: commandGuard, lockRemoval: () => acquireLock(path.join(entry.common, 'lane-promote.lock')), selectPlan: (plan, snapshot) => {
      const tabs = allowed(snapshot);
      return { ...plan, close: plan.close.filter(t => tabs.has(t.tab_id)),
        sessionReleases: (plan.sessionReleases ?? []).filter(t => tabs.has(t.tab_id)), workspaceClose: [] };
    }, log: row => {
      const id = recordEffect(entry.org, entry, row);
      unsent = id && nativeIntent(row.action) ? { id, action: row.action } : undefined;
      results.push(row); retirementOptions.log?.(row);
    } });
  const reconcileExits = () => {
    const prior = effects(); let reconciled = false;
    for (const event of prior.filter(e => e.outcome.action === 'agent-exit-requested')) {
      const intent = event.outcome;
      if (prior.some(e => e.outcome.action === 'exit-observed' && e.outcome.pane === intent.pane || e.outcome.action==='allocation-absent'&&e.outcome.pane===intent.pane&&e.outcome.terminal===intent.occupant?.[5]&&e.outcome.session===intent.occupant?.[6]) ||
          !entry.panes.some(b => (b.run ?? entry.run) === intent.run && b.pane === intent.pane && b.terminal === intent.occupant?.[5] && b.session === intent.occupant?.[6])) continue;
      reconciled = adapter.reconcileAgentExit(intent) || reconciled;
    }
    return reconciled;
  };
  const reconcileClosures = snapshot => {
    guard();
    if(snapshot.retirementHold)throw Error(snapshot.retirementHold);
    allowed(snapshot);
    for (const event of effects().filter(e => e.outcome.action === 'shell-close-requested')) {
      const intent = event.outcome;
      if (typeof intent.tab_id==='string' && intent.panes?.length>0 &&
          !snapshot.tabs.some(t => t.tab_id === intent.tab_id) && intent.panes.every(p =>
          entry.panes.some(b => b.pane === p.pane && b.terminal === p.terminal && (!b.tab||b.tab===intent.tab_id)) && !snapshot.panes.some(live => live.pane_id === p.pane)))
        recordEffect(entry.org, entry, { action: 'closed', tab_id: intent.tab_id, reconciled: true });
    }
  };
  const reconcileAbsence=({missingObservation=false}={})=>{
    if(!entry.panes.length)return false;
    guard({missingObservation});
    const snapshot=measured('native_absence_read_ms',()=>adapter.observe(entry.cwd,{globalPanes:true}));
    if(snapshot.errors.length||snapshot.retirementHold||!snapshot.nativeInventory?.complete)return false;
    let observed=false;
    for(const bound of entry.panes){
      if(!bound.pane||!bound.terminal||!bound.session||!bound.agent||!bound.workspace)continue;
      if(snapshot.nativeInventory.panes.some(p=>p.pane_id===bound.pane||p.terminal_id===bound.terminal)||
        snapshot.agents.some(a=>a.name===bound.agent||a.pane_id===bound.pane||a.terminal_id===bound.terminal||session(a)===bound.session))continue;
      // A current allocation observation resolves no historical signal, kernel
      // process outcome or consumer claim. It never creates an exit receipt.
      recordEffect(entry.org,entry,{action:'allocation-absent',run:bound.run??entry.run,pane:bound.pane,terminal:bound.terminal,session:bound.session,
        ...(bound.tab?{tab_id:bound.tab}:{}),evidence:'complete native readback; original pane and terminal absent; no moved session'});
      const unsent=neverSent().find(e=>effects().some(i=>i.effect===e.intent&&
        (i.outcome.action==='agent-exit-requested'&&i.outcome.pane===bound.pane||
          i.outcome.action==='shell-close-requested'&&i.outcome.panes?.some(p=>p.pane===bound.pane&&p.terminal===bound.terminal))));
      const tab=unsent&&effects().find(e=>e.effect===unsent.intent)?.outcome.tab_id;
      if(tab&&!snapshot.tabs.some(t=>t.tab_id===tab))recordEffect(entry.org,entry,
        {action:'closed',tab_id:tab,observed_absent:true,never_sent_intent:unsent.intent,
          evidence:'current bound allocation absent; original command proven never sent; no historical exit or claim release inferred'});
      observed=true;
    }
    return observed;
  };
  if(!fs.existsSync(entry.cwd)&&!proof()&&neverSent().some(e=>['agent-exit-requested','shell-close-requested'].includes(e.action))&&
      !unresolvedCloseoutEffect(entry,loadEvents(entry.org).events)){
    const absent=reconcileAbsence({missingObservation:true});
    return{deferred:true,reason:`never-sent allocation ${absent?'absence observed':'absence unproven'}; worktree absent without a preservation proof; keep`,results};
  }
  guard(); adapter.assertLaneRecord();
  if (entry.reportCloseout && fs.existsSync(entry.cwd))
    recordEffect(entry.org, entry, { action: 'report-evidence', ...preserveReportContext(entry, currentEvents) });
  if(unbound){
    const observed=adapter.observe(entry.cwd,{globalPanes:true});
    if(!observed.nativeInventory?.complete)throw Error('unbound allocation native inventory incomplete; keep');
    const worker=entry.allocation.worker;
    if(worker&&observed.nativeInventory.panes.some(p=>(p.pane_id===worker.pane||p.terminal_id===worker.terminal_id)&&
        (p.pane_id!==worker.pane||p.terminal_id!==worker.terminal_id||p.workspace_id!==worker.worker_workspace)))
      throw Error('unbound allocation original native pane moved or changed; keep');
    allowed(observed);
    recordEffect(entry.org,entry,{action:'session-unbound',run:entry.run,
      reason:'No durable session binding; physical disposition only, no native session completion inferred.',worker:entry.allocation.worker});
    const plan=adapter.plan(entry.cwd);
    results.push(...adapter.apply(plan,entry.cwd));
    const pending=pendingNative();if(pending)return pending;
  }
  if (!fs.existsSync(entry.cwd)) {
    if(observationOnly)return{deferred:true,reason:'original exit target is absent without a fresh native outcome readback; keep'};
    if (!entry.reportCloseout && !['landed', 'parked'].includes(entry.signal)) return { deferred: true, reason: 'worktree already removed; pane-only signal has no removal authority' };
    adapter.resumeLaneRemoval(proof());
    return { results };
  }
  const absenceObserved=reconcileAbsence();
  measured('exit_reconciliation_ms',reconcileExits);
  if(effects().some(e=>e.outcome.action==='shell-close-requested'))reconcileClosures(adapter.observe(entry.cwd));
  if(observationOnly)return{deferred:true,reason:unresolvedCloseoutEffect(entry,loadEvents(entry.org).events)?
    CLOSEOUT_EXIT_PENDING:
    absenceObserved?'original allocation absence observed; fresh drain required':'original native outcome reconciled; fresh drain required',results};
  if(unresolvedCloseoutEffect(entry,loadEvents(entry.org).events))return {deferred:true,reason:CLOSEOUT_EXIT_PENDING,results};
  // Replan each bound session after the preceding effect's record append. That
  // append changes the authority revision; an old plan must never be replayed.
  for (const pane of entry.panes) {
    selectedPane = pane.pane;
    const planned = measured('plan_ms',()=>adapter.plan(entry.cwd));
    results.push(...measured('apply_ms',()=>adapter.apply(planned, entry.cwd)));
    // The synchronous producer has returned. A lost reply must stop this
    // effect before any follow-on native inventory can turn absence into a
    // completion. Successful original exit observations are already receipted.
    const pending=pendingNative();if(pending)return pending;
    if (measured('exit_reconciliation_ms',reconcileExits)) results.push(...measured('apply_after_exit_ms',()=>adapter.apply(adapter.plan(entry.cwd), entry.cwd)));
    const after=pendingNative();if(after)return after;
  }
  selectedPane = undefined;
  const snapshot = measured('final_native_read_ms',()=>adapter.observe(entry.cwd)), tabs = allowed(snapshot), planned = measured('final_plan_ms',()=>adapter.plan(entry.cwd));
  reconcileClosures(snapshot);
  const kept = planned.keep.filter(t => tabs.has(t.tab_id));
  if (kept.length || snapshot.retirementHold) return { deferred: true, reason: snapshot.retirementHold ?? kept.map(t => t.why).join('; '), results };
  if(sessionsOnly && !entry.reportCloseout){
    if(!entry.panes.length)return{deferred:true,reason:'no bound session target; physical cleanup remains separate',results};
    if(snapshot.panes.some(p=>entry.panes.some(b=>b.pane===p.pane_id)))return{deferred:true,reason:'bound session remains; physical cleanup remains separate',results};
    const native=effects();
    if(!entry.panes.every(bound=>native.some(e=>e.outcome.action==='allocation-absent'&&e.outcome.pane===bound.pane&&e.outcome.terminal===bound.terminal&&e.outcome.session===bound.session)||
      native.some(e=>e.outcome.action==='shell-close-requested'&&e.outcome.panes?.some(p=>p.pane===bound.pane&&p.terminal===bound.terminal)&&
      native.some(closed=>closed.outcome.action==='closed'&&closed.outcome.tab_id===e.outcome.tab_id))))return{deferred:true,reason:'bound session close outcome UNKNOWN; preserve original ownership',results};
    return{deferred:true,sessions_retired:true,reason:'bound sessions retired; physical cleanup remains queued',results};
  }
  if (!entry.reportCloseout && (entry.signal === 'ready' || entry.signal === 'review-done')) {
    const remaining = snapshot.panes.filter(p => entry.panes.some(b => b.pane === p.pane_id));
    return remaining.length ? { deferred: true, reason: 'bound session remains; release or same-session follow-up awaits record change', results } : { results };
  }
  // Source observations never authorize removal. Re-read the named head's
  // ancestry, patch history or exact archive, including for legacy train entries.
  // Parked requests retain their explicit dropped-item/archive preflight.
  let removal = {};
  if (entry.signal === 'landed' && !entry.reportCloseout) {
    const { content, archival } = observeCloseoutContent({ project: entry.project, branch: entry.branch, head: entry.head });
    if (content.main !== adapter.main) throw Error('closeout integration branch changed; lane kept');
    removal = content.kind === 'archival-retirement' ? { archival, sweep: true } :
      content.kind === 'archive-tagged' ? { archiveTip: entry.head } : { expectedTip: entry.head };
  }
  // removeLane independently proves disposition, references, vacancy, Git,
  // preservation and the freshly selected content proof before its effects.
  const removed = measured('remove_lane_ms',()=>adapter.removeLane({ lane: entry.cwd, branch: entry.branch, gitOnly: true,
    ...removal }));
  if (removed.pending.length) return { deferred: true, reason: removed.pending.join('; '), results };
  return { results };
}

export function drainCloseout({ cwd = process.cwd(), org = findOrgDir({ cwd }), env = process.env,
  retirementOptions, beforeExit = () => {}, onClaim = () => {}, keys, loadedCode, retrySafe = false,sessionsOnly=false } = {}) {
  if (keys !== undefined && (!Array.isArray(keys) || keys.some(k => !/^[a-f0-9]{64}$/.test(k)))) throw Error('invalid closer keys');
  if (keys?.length === 0) return { evaluated: [] };
  if(sessionsOnly&&keys===undefined)throw Error('session phase requires exact named closeout targets');
  const project = gitProject(cwd), directory = closeoutDirectory(project.identity);
  if (!closeoutRecordMatches(project, org, env)) return { evaluated: [] };
  if (keys === undefined && lineServiceOwnsCleanup(project, org, { requireSource: false })) return { owned_by: 'line-service', evaluated: [] };
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
    ownership = retirementLock(retirementOwnerLock(project.identity), { waitMs: 60000,deadline:retirementOptions?.deadline??Infinity });
    if (!closeoutPolicy(project.canonical, undefined, { requireServiceSource: true })) return { disabled: true };
    const consume = () => {
      code.verify();
      let pending;
      queueTransaction(project.identity, () => {
        let { events, tornTail } = loadEvents(org);
        if (tornTail) throw Error('incomplete closeout record');
        const state = fold(events);
        const evaluations=new Map(closeoutEvaluations(project.identity,record,events).map(e=>[e.key,e]));
        const invalid = diagnostic => {
          const id = createHash('sha256').update(JSON.stringify(diagnostic)).digest('hex');
          planTransaction(org, current => ({ add: current.some(e => e.type === 'closeout.invalid' && e.id === id) ? [] : [
            { type: 'closeout.invalid', id, identity: project.identity, ...diagnostic }],
          }), { actor: 'lane closeout', replaySafe: true });
        };
        const entries = currentCloseoutEntries(project.identity, record, events, { onInvalid: invalid, keys }).filter(entry =>
          entry.org === record || events.some(source => source.seq === entry.source.seq && source.type === entry.source.type &&
            source.closeout_targets?.some(target => target.key === entry.key && target.org === record && target.project === project.canonical)));
        const recovered=recoverNeverStartedCloseouts({project,org:record,entries,guard:()=>{code.verify();assertQueueOwnership(project,org);}});
        if(recovered.length)events=loadEvents(org).events;
        pruneCompletedCloseout(project.identity, org, entries, events);
        pending = entries.filter(entry => {
          try {
          if (entry.org !== fs.realpathSync(org) || entry.project !== project.canonical) throw Error('closeout record/project binding changed');
          const source = events.find(e => e.seq === entry.source.seq && e.type === entry.source.type);
          if (!source) throw Error('closeout source event is missing; keep');
          const bound = source.closeout_targets?.find(e => e.key === entry.key);
          if (!bound || !closeoutBindingMatches(entry, source, events)) throw Error('closeout target differs from its source record binding; keep');
          if (!closeoutSourceEnabled(entry, events)) return false;
          const prior = entry.reportCloseout ? closeoutEvaluation(entry,events) : evaluations.get(entry.key);
          if (prior?.completed) return false;
          if(recordedCloseoutRefusal(entry,events))return false;
          // Even a fresh pre-effect budget cannot replay an interrupted Git
          // removal whose original synchronous result was never recorded.
          if(unresolvedGitRemoval(entry,events))return false;
          if(directCloseoutObservation(entry,prior,events))return !attempted.has(entry.key);
          // The closer's own next stage runs once per named retry-safe drain.
          const next=prior&&closeoutNextStage(entry,prior,events,readCloseoutEntries(project.identity,{onInvalid:()=>{}}));
          if(next)return next.ready&&retrySafe&&keys!==undefined&&!attempted.has(entry.key)&&actionableCloseout(entry,events)&&(verifyCloseoutHandoff(entry,events),true);
          // A spent allowance before any native intent can use one fresh named
          // budget. Keep its original wait; this is no producer completion and
          // never opens the unresolved/refused native-command path.
          if(retrySafe&&keys!==undefined&&!attempted.has(entry.key)&&
              prior?.reason==='retirement deadline reached; request remains pending'&&safeCloseoutRetry(prior,{entry,events}))
            return actionableCloseout(entry,events)&&(verifyCloseoutHandoff(entry,events),true);
          if(prior){
            if(!closeoutWait(entry,prior,events)){
              planTransaction(org,current=>({add:registerCloseoutWait(entry,prior,current,entries)}),{actor:'lane closeout', replaySafe:true});
              events=loadEvents(org).events;
            }
            const wait=closeoutWait(entry,prior,events);
            // The retained reviewer-end writer predates status links. Join its
            // exact immutable completion on demand; never infer an end from
            // elapsed time, session absence or a manual retry.
            if(wait?.waiting.producers.some(p=>p.kind==='review-followup')&&closeoutWaitState(wait,events)!=='complete'){
              planTransaction(org,current=>({add:linkedCloseoutStatuses(current,current.filter(e=>e.type==='review.followup-ended'))
                .filter(e=>e.identity===entry.common&&e.key===entry.key&&e.wait_id===wait.wait_id)}),{actor:'review follow-up completion', replaySafe:true});
              events=loadEvents(org).events;
            }
            if(closeoutWaitState(wait,events)!=='complete')return false;
            // A known Git result admits the owner's next fresh pass, never an
            // in-drain retry loop. UNKNOWN commands have no completion to link.
            if(wait.waiting.producers.some(p=>p.kind==='git-removal')&&attempted.has(entry.key))return false;
          }
          if (!actionableCloseout(entry, events)) return false;
          verifyCloseoutHandoff(entry, events);
          const revision = closeoutRevision(entry, events, state);
          return revision > Math.max(prior?.revision ?? 0, attempted.get(entry.key) ?? 0);
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
        const started=performance.now(),stages={};
        try {
          assertQueueOwnership(project, org);
          outcome = unresolvedCloseoutEffect(entry,loadEvents(org).events)?{deferred:true,reason:CLOSEOUT_EXIT_PENDING}:evaluateEntry(entry, { env, retirementOptions, code,observationOnly,sessionsOnly,stages });
        } catch (e) { if (e.code === 'CLOSEOUT_CODE_CHANGED') throw e;
          const failure=outcomeFailure(e),uncertain=unresolvedCloseoutEffect(entry,loadEvents(org).events)||unresolvedGitRemoval(entry,loadEvents(org).events);
          outcome = { deferred: true, reason: e.message,observation_error:{...(e.code?{code:e.code}:{}),...(e.status!==undefined?{status:e.status}:{})},
            ...(failure.kind==='fence'||uncertain?{failure}:{}) }; }
        // A code-change refusal caught inside the adapter (post-removal workspace close)
        // is a code handoff, not a defect wait. Uncertain effects keep their failure path.
        if (outcome.deferred && outcome.reason?.includes('closer code identity or main branch changed') &&
          !unresolvedCloseoutEffect(entry, loadEvents(org).events)) code.verify();
        const facts=loadEvents(org).events,condition=outcome.deferred?closeoutCondition(entry,outcome,facts,
          {uncertain:Boolean(unresolvedCloseoutEffect(entry,facts)||unresolvedGitRemoval(entry,facts))}):undefined;
        const row = { type: 'closeout.evaluated', key: entry.key, identity: entry.common, run: entry.run, item: entry.item,
          source: entry.source, revision, code: code.binding, completed: !outcome.deferred,evaluation_ms:performance.now()-started,
          ...(condition?{condition}:{}),resources:closeoutResources(entry,facts,condition),
          ...(entry.reportCloseout ? { reportCloseout: true, disposition: outcome.deferred ? 'kept' : 'closed',
            owner: entry.run,
            reason: outcome.reason ?? (entry.panes.length?'session closed and clean folder removed; unlanded branch retained, main-ancestor branch deleted':
              'unbound session remains unknown; clean folder removed, unlanded branch retained, main-ancestor branch deleted') } : {}),
          stages,...(outcome.failure?{failure:outcome.failure}:{}),...(outcome.native_result?{native_result:outcome.native_result}:{}),
          ...(outcome.sessions_retired?{sessions_retired:true}:{}),
          ...(entry.handoff ? { handoff: entry.handoff } : {}),
          ...(outcome.resolved_by ? { resolved_by: outcome.resolved_by, reason: outcome.reason } : {}),
          ...(outcome.deferred ? { reason: outcome.reason, waiting: nextStage(entry,outcome,loadEvents(org).events)??waitFor(outcome.reason, entry,loadEvents(org).events,outcome.failure) } : {}) };
        const current=loadEvents(org);
        if(current.tornTail)throw Error('incomplete closeout record; preserve outcome');
        if(!entry.reportCloseout&&routineCloseoutObservation(row)&&!unresolvedCloseoutEffect(entry,current.events)){
          appendCloseoutObservation(entry.common,record,row,current.events);
          row.diagnostic=true;
        }else planTransaction(org,events=>{
          const same=e=>['key','identity','run','item','source','revision','completed','sessions_retired','resolved_by','reason','handoff','resources'].every(k=>JSON.stringify(e[k])===JSON.stringify(row[k]));
          return{add:events.some(e=>e.type==='closeout.evaluated'&&same(e))?[]:[row]};
        }, { actor: 'lane closeout', replaySafe: true });
        if(!row.completed)planTransaction(org,events=>{
          const add=registerCloseoutWait(entry,row,events,readCloseoutEntries(entry.common,{onInvalid:()=>{}}));
          const pending=unresolvedCloseoutEffect(entry,events);
          if(pending)add.unshift({type:'closeout.command-failed',identity:entry.common,key:entry.key,source:entry.source,
            intent:events.find(e=>e.type==='closeout.effect'&&e.outcome===pending)?.effect,
            reason:row.reason,...(row.native_result?{native_result:row.native_result}:{}),failure:row.failure??{code:'OUTCOME_UNKNOWN',kind:'unknown'},qualification:'The command returned without a native completion receipt; this is not process absence or exit proof.'});
          return{add:[...add,...linkedCloseoutStatuses(events,add)]};
        },{actor:'lane closeout', replaySafe:true});
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
      planTransaction(org, () => ({ add: [handoff] }), { actor: 'closer code freshness', replaySafe: true });
      // Pair this exit with producers just like the ordinary empty handoff:
      // publication is either in these exact keys or sees a released owner.
      ownership?.(); ownership = null; release?.(); release = null;
    });
    return { evaluated, restart: { keys: pending, old: error.binding, current: error.current } };
  } finally { ownership?.(); release?.(); }
}
