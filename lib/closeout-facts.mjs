// Effect-specific facts. Report prose is never native execution evidence.
import {createHash} from 'node:crypto';
import {SCOPED_REMOVAL_AUTHORITY_CHANGED} from './retire-local.mjs';
import {LANE_REMOVAL_AUTHORITY_CHANGED} from './retire.mjs';
import {legacyExitSettlement} from './closeout-legacy-exits.mjs';
import {finishedOlderAllocation,supersededSessionAllocation} from './closeout-finished.mjs';
import {fold} from './state.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const ownsCloseoutFact=(entry,e)=>e.identity===entry.common&&e.key===entry.key&&same(e.source,entry.source);
const retryable=new Set(['contention','active-process','dirty-work','pre-effect-budget','pre-effect-change','corrected-pre-effect-defect']);

// These producer formats put arbitrary paths, branch names or agent names in
// the reason. Classify their bounded message, not keywords inside that payload.
// Other prose retains the conservative safety/owner-evidence fallback below.
function namedPreEffectKind(reason) {
  if(/^removal preflight input changed: [^\n]+; prepare and observe again; lane kept$/.test(reason))return 'pre-effect-change';
  if(/^locked: [^;\n]+; (?:owner is live or unknown|inspect owner\.json and surviving processes before removing a stale lock)$/.test(reason)||
      /^locked Git metadata [^;\n]+$/.test(reason))return 'contention';
  if(/^(?:process cwd|settle callback|watcher callback) reference [^;\n]+$/.test(reason)||
      /^occupant [^;\n]+ is (?:working|running|busy|blocked)$/.test(reason))return 'active-process';
}

export function closeoutCondition(entry,outcome,events,{uncertain=false}={}) {
  const reason=outcome.reason??'',failure=outcome.failure,namedKind=namedPreEffectKind(reason);
  let kind='owner-evidence-required',resources=['session','folder','branch'];
  if(failure?.kind==='fence')kind='native-refusal';
  else if(uncertain)kind='uncertain-invocation';
  else if(/original native session identity missing/.test(reason))kind='missing-identity';
  else if(/queued worktree absent without a preservation proof/.test(reason))kind='unproven-removal';
  else if(/queued branch generation changed|queued worktree identity or expected head changed/.test(reason))kind='allocation-changed';
  else if(/^retirement ownership transfer waits for legacy housekeeping to stop\/restart;/.test(reason))kind='contention';
  else if(reason==='row.schema?.startsWith is not a function')kind='corrected-pre-effect-defect';
  else if(namedKind)kind=namedKind;
  else if(/STOP|HOLD|ownership|claim|source binding|generation|identity|preservation|evidence.*changed|archive.*changed/i.test(reason))kind='safety-hold';
  else if(/^locked:|locked Git metadata|worktree is locked/.test(reason))kind='contention';
  else if(/worktree is not clean|assume-unchanged|skip-worktree/.test(reason)){kind='dirty-work';resources=['folder','branch'];}
  else if(/process cwd reference |settle callback reference |watcher callback reference |another process remains|occupant .* is (working|running|busy|blocked)|unbound allocation still has a native occupant|open run|reference |operator focus|this tab/.test(reason))kind='active-process';
  else if(/retirement deadline reached|removal needs .*pass has/.test(reason))kind='pre-effect-budget';
  else if(/^removal preflight input changed:/.test(reason)||
      [SCOPED_REMOVAL_AUTHORITY_CHANGED,LANE_REMOVAL_AUTHORITY_CHANGED].includes(reason))kind='pre-effect-change';
  const original=events.find(e=>e.type==='closeout.evaluated'&&ownsCloseoutFact(entry,e)&&!e.completed&&
    (e.condition?.kind===kind||!e.condition&&e.reason===reason));
  const origin=events.find(e=>(e.type==='report.ingested'&&e.run===entry.run||e.type==='run.abandoned'&&(e.run??e.id)===entry.run));
  const intent=uncertain&&events.findLast(e=>e.type==='closeout.effect'&&ownsCloseoutFact(entry,e)&&
    ['agent-exit-requested','shell-close-requested','workspace-close-requested','git-removal-started'].includes(e.outcome?.action));
  if(intent)resources=[intent.outcome.action==='git-removal-started'&&intent.outcome.operation==='branch'?'branch':
    ['git-removal-started','workspace-close-requested'].includes(intent.outcome.action)?'folder':'session'];
  const firstSeen=[original?.condition?.first_seen,original?.at,origin?.at,events.find(e=>e.seq===entry.source.seq)?.at]
    .filter(v=>Number.isFinite(Date.parse(v))).sort((a,b)=>Date.parse(a)-Date.parse(b))[0];
  const continuation=kind==='unproven-removal'?{kind:'owner-evidence',owner:entry.run,
    reason:'Original allocation owner must supply its existing exact preservation/removal proof; current folder absence or landed branch alone cannot prove saved work.',
    next_observation:'Native allocation absence may be observed independently; no Git removal or historical success is inferred.'}:undefined;
  return{schema:'closeout-condition/v1',kind,resources,reason,owner:retryable.has(kind)?'lane-closeout':entry.run,
    evidence:{source:entry.source,...(intent?{intent:{effect:intent.effect,seq:intent.seq,action:intent.outcome.action}}:{}),
      ...(failure?{failure}:{}),...(outcome.observation_error?{observation_error:outcome.observation_error}:{})},
    first_seen:firstSeen,
    continuation:continuation??(retryable.has(kind)?{kind:'pre-effect-observation',owner:'lane-closeout',guards:'fresh original source/allocation/native/Git/STOP/HOLD/preservation'}:
      {kind:'owner-evidence',owner:entry.run,reason:kind==='uncertain-invocation'?'original exact producer completion or admitted never-started proof required':'original owner must supply admissible evidence'}),
    escalation:{owner:'project-supervisor',turns:3,age_ms:1800000,authority:'visibility only'}};
}

export function preEffectCloseout(entry,prior,events,{uncertain=false}={}) {
  if(!prior||prior.completed||uncertain)return false;
  if(prior.reason==='original report allocation/current run/claim changed; keep'&&
      (finishedOlderAllocation(entry,fold(events))||supersededSessionAllocation(entry,fold(events)))&&
      !events.some(e=>ownsCloseoutFact(entry,e)&&(['closeout.command-failed','closeout.invalid'].includes(e.type)||
        e.type==='closeout.effect'&&e.outcome?.action!=='report-evidence')))return true;
  // Historical holds remain immutable. Only named ordinary pre-effect reasons
  // can acquire a new observation, including old generic UNKNOWN labels.
  const fact=prior.condition?.kind==='owner-evidence-required'?closeoutCondition(entry,prior,events):prior.condition??closeoutCondition(entry,prior,events);
  if(fact.kind==='unproven-removal'&&entry.panes?.length&&!recordedCloseoutRefusal(entry,events)&&
      !entry.panes.every(p=>events.some(e=>ownsCloseoutFact(entry,e)&&e.type==='closeout.effect'&&
        e.outcome?.action==='allocation-absent'&&e.outcome.pane===p.pane&&e.outcome.terminal===p.terminal&&e.outcome.session===p.session)))return true;
  if(fact.kind==='missing-identity'&&entry.reportCloseout&&entry.allocation&&entry.panes.length===0&&
      !events.some(e=>ownsCloseoutFact(entry,e)&&['closeout.command-failed','closeout.invalid'].includes(e.type)||
        ownsCloseoutFact(entry,e)&&e.type==='closeout.effect'&&e.outcome?.action!=='report-evidence'))return true;
  return retryable.has(fact.kind)&&fact.continuation.kind==='pre-effect-observation';
}

export function recordedCloseoutRefusal(entry,events,resource) {
  // Historical typed holds and untyped original-refusal rows stay immutable.
  // New evaluations acquire refusal authority only from structured failures.
  return events.find(e=>ownsCloseoutFact(entry,e)&&
    (e.type==='closeout.command-failed'&&e.failure?.kind==='fence'||
     e.type==='closeout.evaluated'&&(e.failure?.kind==='fence'||['native-refusal','legacy-refusal'].includes(e.condition?.kind)||
       !e.condition&&/original native refusal/.test(e.reason??'')))&&
    (!resource||!e.condition?.resources||e.condition.resources.includes(resource)));
}

export function closeoutResources(entry,events,condition) {
  const rows=events.filter(e=>e.type==='closeout.effect'&&ownsCloseoutFact(entry,e));
  const last=action=>rows.findLast(e=>e.outcome?.action===action),receipt=e=>e&&{seq:e.seq,effect:e.effect};
  const closed=entry.panes.length>0&&entry.panes.every(p=>rows.some(e=>e.outcome.action==='closed'&&
    (e.outcome.sessions??[e.outcome]).some(s=>s.run===(p.run??entry.run)&&s.session===p.session))||
    rows.some(e=>e.outcome.action==='shell-close-requested'&&e.outcome.panes?.some(b=>b.pane===p.pane&&b.terminal===p.terminal)&&
      rows.some(c=>c.outcome.action==='closed'&&c.outcome.tab_id===e.outcome.tab_id)));
  const settlements=rows.map(e=>legacyExitSettlement(entry,e,events)).filter(Boolean);
  const absent=entry.panes.length>0&&entry.panes.every(p=>rows.some(e=>e.outcome.action==='allocation-absent'&&e.outcome.pane===p.pane&&e.outcome.terminal===p.terminal&&e.outcome.session===p.session)||
    settlements.some(e=>rows.some(i=>i.effect===e.intent&&i.outcome.pane===p.pane&&i.outcome.occupant?.[5]===p.terminal&&i.outcome.occupant?.[6]===p.session)));
  const folder=last('worktree-removed'),branch=last('branch-removed'),kept=last('branch-kept'),packet=last('report-evidence');
  const keep=resource=>({status:'kept',scope:{resource,key:entry.key,source:entry.source,run:entry.run,cwd:entry.cwd},reason:condition?.reason??'no effect receipt',owner:condition?.owner??entry.run,
    continuation:condition?.continuation??{kind:'owner-evidence',owner:entry.run},evidence:condition?.evidence??{source:entry.source},first_seen:condition?.first_seen,escalation:condition?.escalation});
  return{session:last('session-unbound')?{status:'unbound',completion:'UNKNOWN',receipt:receipt(last('session-unbound'))}:
      closed?{status:'closed',receipts:rows.filter(e=>e.outcome.action==='closed').map(receipt)}:
      absent?{status:'absent',receipts:[...rows.filter(e=>e.outcome.action==='allocation-absent'),...settlements].map(receipt)}:
      {...keep('session'),...(!entry.panes.length?{reason:'original native identity missing; no empty-target completion'}:{})},
    folder:folder?{status:'removed',receipt:receipt(folder)}:keep('folder'),
    branch:branch?{status:'deleted',receipt:receipt(branch)}:kept?{status:'retained',ref:entry.branch,head:entry.head,receipt:receipt(kept)}:
      {...keep('branch'),ref:entry.branch,head:entry.head},
    author_packet:packet?{status:'preserved',receipt:receipt(packet),packet:packet.outcome.packet,sha256:packet.outcome.sha256}:{status:'unproven'}};
}

// A missing envelope is a typed binding exception, never a guessed executable
// target or a second opportunity to retire an old allocation.
export function missingCloseoutBinding({project,org,source,run,signal,events}) {
  const entry={common:project.identity,project:project.canonical,org,run:run.id,item:run.item,cwd:run.workspace,panes:[],
    source:{seq:source.seq,type:source.type},key:createHash('sha256').update(JSON.stringify([project.identity,run.id,source.seq,signal,'missing-binding'])).digest('hex')};
  const reason='original native session identity missing; original source has no durable target binding',condition=closeoutCondition(entry,{reason},events);
  condition.continuation={kind:'owner-evidence',owner:run.id,defect:'Original immutable allocation/session binding is missing; no completion subscription is claimed.',
    original_binding_error:source.closeout_binding_errors?.find(e=>e.run===run.id)??source.closeout_binding_error??null,
    next_observation:'existing finite original-binding refresh; unattempted original launch/session evidence or unchanged finished allocation plus complete native vacancy; no session reconstruction'};
  return{type:'closeout.binding-kept',identity:entry.common,key:entry.key,run:run.id,item:run.item,source:entry.source,
    reason,condition,resources:closeoutResources(entry,events,condition),signal,completed:false};
}
