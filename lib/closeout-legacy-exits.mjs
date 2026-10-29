// ENG-931: disposition of the pre-fix exit-identity producer, never a resend
// or a claim that its historical command returned successfully.
import path from 'node:path';
import {ownsCloseoutFact,recordedCloseoutRefusal} from './closeout-facts.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {planRetirement,sameExitShell} from './retire.mjs';

// The immutable closer-imports/v1 graph shared by the seven pre-1beac8c2
// attempts. New UNKNOWN producers cannot enter this observation path.
const graph='b52b10e3883eb09e2692c14e41ea771cb4604ce38363e3693d2cea88dc50bce5';
const diagnostic='occupant or shell identity changed during agent exit';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const text=v=>typeof v==='string'&&v.length>0;
const inLane=(cwd,lane)=>typeof cwd==='string'&&(cwd===lane||cwd.startsWith(lane+path.sep));

export function legacyExitQualification(entry,intent,events) {
  const o=intent?.outcome,a=o?.occupant;
  if(!entry.reportCloseout||!intent?.effect||!ownsCloseoutFact(entry,intent)||intent.type!=='closeout.effect'||
      !Number.isSafeInteger(intent.seq)||!Number.isFinite(Date.parse(intent.at))||
      intent.producer!=='native-closeout/v2'||o?.action!=='agent-exit-requested'||!Array.isArray(a)||
      !Number.isSafeInteger(o.shell?.pid)||o.shell.pid<1||!text(o.shell.identity)||!text(o.shell.command)||
      !entry.panes.some(p=>(p.run??entry.run)===o.run&&p.pane===o.pane&&p.pane===a[2]&&p.agent===a[0]&&
        p.workspace===a[3]&&entry.cwd===a[4]&&p.terminal===a[5]&&p.session===a[6]&&(!p.tab||p.tab===o.tab_id))||!text(o.tab_id)||
      !a.slice(0,7).every(text)||recordedCloseoutRefusal(entry,events))return;
  const own=events.filter(e=>ownsCloseoutFact(entry,e));
  if(own.some(e=>e.type==='closeout.command-not-started'&&e.intent===intent.effect||
      e.type==='closeout.effect'&&e.seq>intent.seq&&
        ['agent-exit-requested','shell-close-requested','workspace-close-requested','git-removal-started','exit-observed','closed'].includes(e.outcome?.action)))return;
  const evaluation=own.find(e=>e.type==='closeout.evaluated'&&e.seq>intent.seq),c=evaluation?.code?.code;
  const failure=own.find(e=>e.type==='closeout.command-failed'&&e.intent===intent.effect&&e.seq>intent.seq);
  const mismatch=row=>row?.native_result?.action==='skip-close'&&row.native_result.reason===diagnostic&&
    !row.native_result.exit_observation&&!row.native_result.error;
  if(!evaluation||evaluation.completed||!mismatch(evaluation)||!mismatch(failure)||failure.seq<=evaluation.seq||
      failure.failure?.kind!=='unknown'||failure.failure.code!=='OUTCOME_UNKNOWN'||
      c?.kind!=='checkout'||c.root!==entry.project||c.common!==entry.common||c.graph!=='closer-imports/v1'||c.files!==graph||
      !/^[a-f0-9]{40}$/.test(c.commit??'')||evaluation.code.epoch?.branch!=='main'||evaluation.code.epoch.tip!==c.commit)return;
  return{evaluation:evaluation.seq,failure:failure.seq,graph};
}

function absent(entry,intent,observation) {
  const o=intent.outcome,a=o.occupant;
  if(observation?.complete!==true||!Number.isFinite(Date.parse(observation.at))||
      Date.parse(observation.at)<Date.parse(intent.at)||!Array.isArray(observation.panes)||!Array.isArray(observation.agents)||
      !observation.panes.every(p=>text(p.pane_id)&&text(p.terminal_id))||
      !observation.agents.every(p=>text(p.pane_id)&&text(p.terminal_id)&&text(p.cwd)))return false;
  return !observation.panes.some(p=>p.pane_id===o.pane||p.terminal_id===a[5])&&
    !observation.agents.some(p=>p.name===a[0]||p.pane_id===o.pane||p.terminal_id===a[5]||p.session===a[6]||
      inLane(p.cwd,entry.cwd)||inLane(p.foreground_cwd,entry.cwd));
}

export function legacyExitSettlement(entry,intent,events) {
  if(intent?.outcome?.action!=='agent-exit-requested'||!ownsCloseoutFact(entry,intent))return;
  return events.find(e=>e.type==='closeout.exit-settled'&&ownsCloseoutFact(entry,e)&&e.seq>intent.seq&&
    ['legacy-exit-settlement/v1','legacy-exit-settlement/v2'].includes(e.schema)&&e.intent===intent.effect&&e.intent_seq===intent.seq&&
    e.original_outcome==='UNKNOWN'&&e.disposition==='allocation-absent'&&
    same(e.qualification,legacyExitEvidence(entry,intent,events.filter(prior=>prior.seq<e.seq)))&&e.qualification&&
    (e.schema==='legacy-exit-settlement/v1'?!legacyShellClose(entry,intent,events):
      e.close_intent===legacyShellClose(entry,intent,events)?.effect&&
      legacyShellCompletion(entry,intent,events)?.seq===e.close_receipt&&e.close_receipt<e.seq&&
      Date.parse(e.observation?.at)>=Date.parse(events.find(c=>c.seq===e.close_receipt)?.at))&&
    absent(entry,intent,e.observation));
}

export function legacyShellClose(entry,intent,events) {
  return events.find(e=>e.type==='closeout.effect'&&ownsCloseoutFact(entry,e)&&e.seq>intent.seq&&
    e.outcome?.action==='shell-close-requested'&&e.outcome.legacy_exit?.intent===intent.effect&&
    e.outcome.legacy_exit.intent_seq===intent.seq);
}

function legacyExitEvidence(entry,intent,events) {
  const close=legacyShellClose(entry,intent,events);
  return legacyExitQualification(entry,intent,close?events.filter(e=>e.seq<close.seq):events);
}

function legacyShellCompletion(entry,intent,events) {
  const close=legacyShellClose(entry,intent,events),proof=close?.outcome.legacy_exit;
  if(!close||!validShellProof(entry,intent,proof)||!legacyExitEvidence(entry,intent,events))return;
  const verified=events.find(e=>e.type==='closeout.effect'&&ownsCloseoutFact(entry,e)&&e.seq>close.seq&&
    e.intent===close.effect&&e.outcome?.action==='legacy-shell-verified'&&
    validShellProof(entry,intent,e.outcome.legacy_exit)&&
    e.outcome.legacy_exit.decision.token===proof.decision.token&&Date.parse(e.outcome.legacy_exit.at)>=Date.parse(close.at));
  if(!verified)return;
  return events.find(e=>e.type==='closeout.effect'&&ownsCloseoutFact(entry,e)&&e.seq>close.seq&&
    e.seq>verified.seq&&e.intent===close.effect&&e.outcome?.action==='closed'&&e.outcome.tab_id===intent.outcome.tab_id);
}

export function legacyExitIntent(entry,events) {
  return events.find(e=>e.type==='closeout.effect'&&e.outcome?.action==='agent-exit-requested'&&
    legacyExitEvidence(entry,e,events)&&!legacyExitSettlement(entry,e,events)&&
    (!legacyShellClose(entry,e,events)||legacyShellCompletion(entry,e,events)));
}

// A finished later check run can use a different lane (R-1256/R-1262). It does
// not replace the old allocation's claim. Admit only this audited allocation,
// with all later runs final and disjoint; reuse or active successors still keep.
export function legacyExitAllocation(entry,events,state) {
  if(!events.some(e=>e.type==='closeout.effect'&&ownsCloseoutFact(entry,e)&&
      (e.outcome?.action==='agent-exit-requested'&&legacyExitEvidence(entry,e,events)||legacyExitSettlement(entry,e,events))))return false;
  const item=state.items.get(entry.item),index=item?.runs.indexOf(entry.run)??-1;
  return index>=0&&item.runs.slice(index+1).every(id=>{
    const run=state.runs.get(id),worker=effectiveWorkerIdentity(run,state);
    return run&&(run.report||run.abandoned)&&run.workspace!==entry.cwd&&!worker.identity_conflict&&
      !entry.panes.some(p=>p.pane===worker.pane||p.terminal===worker.terminal_id||p.session===worker.agent_session_id||p.agent===worker.agent);
  });
}

export function observeLegacyExitAbsence(entry,intent,events,snapshot,at) {
  const qualification=legacyExitEvidence(entry,intent,events),close=legacyShellClose(entry,intent,events);
  const completion=close&&legacyShellCompletion(entry,intent,events);
  if(close&&!completion)return;
  if(!qualification||snapshot.errors.length||snapshot.retirementHold||snapshot.nativeInventory?.complete!==true)return;
  const observation={at,complete:true,
    panes:snapshot.nativeInventory.panes.map(p=>({pane_id:p.pane_id,terminal_id:p.terminal_id,workspace_id:p.workspace_id})),
    agents:snapshot.agents.map(p=>({name:p.name,pane_id:p.pane_id,terminal_id:p.terminal_id,
      session:p.agent_session?.value??p.agent_session_id,cwd:p.cwd,foreground_cwd:p.foreground_cwd}))};
  if(!absent(entry,intent,observation))return;
  return{type:'closeout.exit-settled',schema:close?'legacy-exit-settlement/v2':'legacy-exit-settlement/v1',identity:entry.common,key:entry.key,
    run:entry.run,item:entry.item,source:entry.source,intent:intent.effect,intent_seq:intent.seq,
    original_outcome:'UNKNOWN',disposition:'allocation-absent',qualification,observation,
    ...(close?{close_intent:close.effect,close_receipt:completion.seq}:{}),
    explanation:'Fresh complete native inventory proves the original pane and terminal absent and no original or lane agent present. Historical command outcome remains UNKNOWN; no input or close is replayed.'};
}

function validShellProof(entry,intent,proof) {
  const o=intent.outcome,a=o.occupant,p=proof?.pane,info=p?.process_info,tree=info?.process_tree_raw??info?.process_tree;
  return proof?.schema==='legacy-inert-shell/v1'&&proof.intent===intent.effect&&proof.intent_seq===intent.seq&&
    Number.isFinite(Date.parse(proof.at))&&Date.parse(proof.at)>=Date.parse(intent.at)&&
    proof.decision?.decision==='release'&&['initial-shell/v1','legacy inert-shell retirement'].includes(proof.decision.rule)&&
    text(proof.decision.token)&&proof.decision.tab_id===o.tab_id&&
    p?.pane_id===o.pane&&p.tab_id===o.tab_id&&p.workspace_id===a[3]&&p.terminal_id===a[5]&&
    p.foreground_cwd===entry.cwd&&!p.shellObservationError&&p.shellOnly===true&&
    !p.agent&&!p.agent_session&&!p.display_agent&&!p.name&&!p.launch_pending&&
    info?.process_tree_complete===true&&Array.isArray(tree)&&tree.length===1&&
    info.shell_pid===o.shell.pid&&sameExitShell(o.shell,tree[0])&&
    /^\[?-?(?:zsh|bash|sh|fish|dash|ash|ksh)\]?$/.test(tree[0].command??'')&&
    text(tree[0].state)&&!/^[TXZ]/i.test(tree[0].state)&&
    info.foreground_processes?.length===1&&info.foreground_processes[0].pid===info.shell_pid&&
    (!info.foreground_processes[0].identity||info.foreground_processes[0].identity===tree[0].identity)&&
    proof.inventory?.complete===true&&Array.isArray(proof.inventory.panes)&&Array.isArray(proof.inventory.agents)&&
    proof.inventory.panes.every(p=>text(p.pane_id)&&text(p.terminal_id))&&
    proof.inventory.panes.filter(p=>p.pane_id===o.pane||p.terminal_id===a[5]).length===1&&
    proof.inventory.panes.some(p=>p.pane_id===o.pane&&p.terminal_id===a[5]&&p.workspace_id===a[3])&&
    proof.inventory.agents.every(p=>text(p.pane_id)&&text(p.terminal_id)&&text(p.cwd))&&
    !proof.inventory.agents.some(p=>p.name===a[0]||p.pane_id===o.pane||p.terminal_id===a[5]||p.session===a[6]||
      inLane(p.cwd,entry.cwd)||inLane(p.foreground_cwd,entry.cwd));
}

// DEC-331 adds original-identity proof to the ordinary inert-shell planner.
// No prospective agent exit or callback close can qualify for this exception.
export function observeLegacyInertShell(entry,intent,events,snapshot,at) {
  if(!legacyExitEvidence(entry,intent,events)||recordedCloseoutRefusal(entry,events)||snapshot.errors.length||snapshot.retirementHold||
      snapshot.nativeInventory?.complete!==true)return;
  const proof={schema:'legacy-inert-shell/v1',intent:intent.effect,intent_seq:intent.seq,at,
    pane:snapshot.panes.find(p=>p.pane_id===intent.outcome.pane),
    decision:planRetirement(snapshot).close.find(p=>p.tab_id===intent.outcome.tab_id),
    inventory:{complete:true,panes:snapshot.nativeInventory.panes.map(p=>({pane_id:p.pane_id,terminal_id:p.terminal_id,workspace_id:p.workspace_id})),
      agents:snapshot.agents.map(p=>({name:p.name,pane_id:p.pane_id,terminal_id:p.terminal_id,
        session:p.agent_session?.value??p.agent_session_id,cwd:p.cwd,foreground_cwd:p.foreground_cwd}))}};
  return validShellProof(entry,intent,proof)?proof:undefined;
}
