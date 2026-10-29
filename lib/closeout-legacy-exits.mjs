// ENG-931: disposition of the pre-fix exit-identity producer, never a resend
// or a claim that its historical command returned successfully.
import path from 'node:path';
import {ownsCloseoutFact,recordedCloseoutRefusal} from './closeout-facts.mjs';

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
    e.schema==='legacy-exit-settlement/v1'&&e.intent===intent.effect&&e.intent_seq===intent.seq&&
    e.original_outcome==='UNKNOWN'&&e.disposition==='allocation-absent'&&
    same(e.qualification,legacyExitQualification(entry,intent,events.filter(prior=>prior.seq<e.seq)))&&e.qualification&&
    absent(entry,intent,e.observation));
}

export function legacyExitIntent(entry,events) {
  return events.find(e=>legacyExitQualification(entry,e,events)&&!legacyExitSettlement(entry,e,events));
}

export function observeLegacyExitAbsence(entry,intent,events,snapshot,at) {
  const qualification=legacyExitQualification(entry,intent,events);
  if(!qualification||snapshot.errors.length||snapshot.retirementHold||snapshot.nativeInventory?.complete!==true)return;
  const observation={at,complete:true,
    panes:snapshot.nativeInventory.panes.map(p=>({pane_id:p.pane_id,terminal_id:p.terminal_id,workspace_id:p.workspace_id})),
    agents:snapshot.agents.map(p=>({name:p.name,pane_id:p.pane_id,terminal_id:p.terminal_id,
      session:p.agent_session?.value??p.agent_session_id,cwd:p.cwd,foreground_cwd:p.foreground_cwd}))};
  if(!absent(entry,intent,observation))return;
  return{type:'closeout.exit-settled',schema:'legacy-exit-settlement/v1',identity:entry.common,key:entry.key,
    run:entry.run,item:entry.item,source:entry.source,intent:intent.effect,intent_seq:intent.seq,
    original_outcome:'UNKNOWN',disposition:'allocation-absent',qualification,observation,
    explanation:'Fresh complete native inventory proves the original pane and terminal absent and no original or lane agent present. Historical command outcome remains UNKNOWN; no input or close is replayed.'};
}
