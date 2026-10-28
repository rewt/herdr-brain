// Narrow cleanup dependency links in the existing record, not a transport/bus.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fold} from './state.mjs';
import {outcomeFailure} from './uncertain-outcome.mjs';
import {unresolvedCloseoutEffect,directCloseoutObservation} from './closeout.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const closeoutWaitId=(entry,prior)=>hash([entry.common,entry.key,entry.source,prior.revision,prior.reason]);

export function unresolvedGitRemoval(entry,events) {
  const mine=e=>e.type==='closeout.effect'&&e.identity===entry.common&&e.key===entry.key&&same(e.source,entry.source);
  const rows=events.filter(mine);
  return rows.some(start=>start.outcome?.action==='git-removal-started'&&!rows.some(end=>
    end.seq>start.seq&&end.outcome?.action==='git-removal-finished'&&Number.isSafeInteger(end.outcome.exit_status)&&end.outcome.exit_status>=0&&
    !end.outcome.code&&['attempt','operation','cwd','branch','tip','evidence','branchGeneration'].every(k=>same(start.outcome[k],end.outcome[k]))));
}

// The landed/parked request that still owns a ready twin's bound sessions.
export function pendingRemovalOwner(entry,entries,events) {
  if(entry.signal!=='ready')return;
  return entries.find(other=>other.org===entry.org&&other.project===entry.project&&
    ['landed','parked'].includes(other.signal)&&other.cwd===entry.cwd&&other.head===entry.head&&
    same(other.worktreeIdentity,entry.worktreeIdentity)&&same(other.branchLog,entry.branchLog)&&
    events.some(e=>e.seq===other.source.seq&&e.closeout_targets?.some(t=>t.key===other.key&&same(t.panes,other.panes)))&&
    !events.findLast(e=>e.type==='closeout.evaluated'&&e.key===other.key)?.completed);
}

// A deferral whose next stage this same closer owns is progress, not a wait on
// an outside producer: it registers no wait and never becomes a decision. Only
// recorded stage facts qualify; an unresolved native intent never does.
export function closeoutNextStage(entry,prior,events,entries=[]) {
  if(!prior||prior.completed||unresolvedCloseoutEffect(entry,events))return;
  // Positive non-execution unlocks a fresh ordinary observation, including
  // legacy defect waits. Never let that evidence repeatedly reopen a later
  // refusal or a still-live allocation's unchanged keep.
  if(!prior.failure&&!/EPERM|EACCES|native refusal|HOLD|STOP/i.test(prior.reason??'')&&events.some(e=>e.type==='closeout.command-not-started'&&e.identity===entry.common&&e.key===entry.key&&
      same(e.source,entry.source)&&e.native_started===false&&e.seq>(prior.seq??prior.observed_seq??prior.revision)&&
      events.some(i=>i.type==='closeout.effect'&&i.effect===e.intent&&i.identity===entry.common&&i.key===entry.key&&
        same(i.source,entry.source)&&i.seq<e.seq)))return{stage:'never-sent',ready:true};
  const own=actions=>events.some(e=>e.type==='closeout.effect'&&e.key===entry.key&&e.identity===entry.common&&
    same(e.source,entry.source)&&actions.includes(e.outcome?.action));
  if(prior.sessions_retired===true&&prior.reason==='bound sessions retired; physical cleanup remains queued'||
    prior.reason==='no bound session target; physical cleanup remains separate')return{stage:'physical',ready:true};
  if(prior.reason==='original native outcome reconciled; fresh drain required'&&own(['exit-observed','closed'])||
    prior.reason==='original allocation absence observed; fresh drain required'&&own(['allocation-absent']))return{stage:'fresh-drain',ready:true};
  // The twin's sibling is drained by this line; its removal receipt (or its
  // absence from the queue) makes the twin's own next evaluation ready.
  if(/^landed or parked request owns/.test(prior.reason??''))return{stage:'twin-removal',ready:!pendingRemovalOwner(entry,entries,events)};
}

export function closeoutProducer(entry,prior,{events,entries}) {
  const state=fold(events),reason=prior.reason??'';
  const defect=why=>({owner:'line-service',defect:why,producers:[]});
  if(prior.failure?.kind==='fence'||outcomeFailure(prior).kind==='fence'||/EPERM|EACCES|native refusal/i.test(reason))return defect('Recorded native refusal has stopped this effect; owner judgment is required.');
  if(/HOLD/.test(reason))return defect('HOLD removal has no existing record completion writer; retain the hold and its exact entry.');
  if(unresolvedGitRemoval(entry,events))return defect('The original Git removal command has no known completion; retain its intent and preservation proof.');
  if(reason==='reviewer same-session follow-up is expected'){
    const reviews=events.filter(e=>e.type==='review.verdict'&&e.common===entry.common&&e.review?.followup_expected===true&&
      e.review.record_seq===e.seq&&e.review.run===e.run&&e.review.cwd===entry.cwd&&e.review.head===entry.head&&
      entry.panes.some(p=>(p.run??entry.run)===e.run&&p.pane===e.review.pane&&p.terminal===e.review.terminal&&p.session===e.review.session));
    return reviews.length?{owner:'review-followup',producers:reviews.map(e=>({kind:'review-followup',review_id:e.review.id,run:e.run,item:e.item,source_seq:e.seq}))}:
      defect('Reviewer follow-up has no exact recorded verdict and bound session.');
  }
  // A synchronous Git result completes only its own command, not removal.
  // The closer still owns replanning/revalidation of the preserved lane.
  const finished=events.findLast(e=>e.type==='closeout.effect'&&e.identity===entry.common&&e.key===entry.key&&same(e.source,entry.source)&&
    e.outcome?.action==='git-removal-finished'&&e.outcome.reason===reason&&e.seq>(prior.revision??entry.source.seq));
  if(finished&&!unresolvedCloseoutEffect(entry,events)){
    const p={kind:'git-removal',key:entry.key,source:entry.source,attempt:finished.outcome.attempt};
    const wait={identity:entry.common,revision:prior.revision};
    if(producedStatus(wait,p,finished,events)==='complete')return{owner:'lane-closeout',producers:[p]};
  }
  if(/^landed or parked request owns/.test(reason)){
    const owner=entries.find(e=>e.key!==entry.key&&['landed','parked'].includes(e.signal)&&e.cwd===entry.cwd&&e.head===entry.head&&same(e.worktreeIdentity,entry.worktreeIdentity)&&e.org===entry.org);
    return owner?{owner:'lane-closeout',producers:[{kind:'lane-removal',key:owner.key,source:owner.source,cwd:owner.cwd,head:owner.head}]}:defect('The named lane-removal owner has no exact bound queue entry.');
  }
  const runId=/^([A-Z]+-\d+) report is not ingested$/.exec(reason)?.[1],itemId=/^open run on ([A-Z]+-\d+)$/.exec(reason)?.[1];
  if(runId||itemId||/^(open run in lane|open run uses callback checkout|callback report is not ingested)$/.test(reason)){
    const runs=[...state.runs.values()].filter(r=>runId?r.id===runId:itemId?r.item===itemId:r.workspace===entry.cwd).filter(r=>!r.abandoned&&(!r.report||r.report.seq>prior.revision));
    if(runs.length&&runs.every(r=>r.owner&&!r.owner.legacy&&r.owner.controller==='brain'))return{owner:'worker-report',producers:runs.map(r=>({kind:'worker-report',run:r.id,item:r.item,claim:r.owner_generation,workspace:r.workspace}))};
    return defect('The report wait has no current claimed worker-report producer.');
  }
  if(/^locked:/.test(reason)){
    let queue;try{queue=JSON.parse(fs.readFileSync(path.join(entry.common,'promote/queue.json'),'utf8'));}catch{}
    const members=v=>v?.jobs??(v?[v]:[]),jobs=queue?.identity===entry.common?[...(queue.pending??[]),...members(queue.current),...(queue.interrupted??[]).flatMap(members)]:[];
    const completed=events.filter(e=>e.type==='closeout.lifecycle-released'&&e.identity===entry.common&&e.seq>prior.revision).flatMap(e=>e.jobs??[]);
    const job=[...jobs,...completed].find(j=>j.run===entry.run&&j.tip===entry.head&&`lane/${j.topic}`===entry.branch&&j.id);
    return job?{owner:'promotion-closeout',producers:[{kind:'lifecycle-release',job:job.id,run:entry.run,head:entry.head,branch:entry.branch}]}:defect('Lifecycle-lock wait has no exact owning promotion job with a completion callback.');
  }
  if(/unresolved native|agent did not exit|native.*outcome|exit.*intent|close.*intent/i.test(reason))return defect('The original native command returned without completion; no existing runtime transport writes a later exit/close status for this intent.');
  return defect(`No existing completion writer for this exact wait: ${reason}`);
}

export function closeoutWait(entry,prior,events) {
  const id=closeoutWaitId(entry,prior);
  return events.findLast(e=>e.type==='closeout.waiting'&&e.identity===entry.common&&e.key===entry.key&&e.wait_id===id&&same(e.source,entry.source));
}
function producedStatus(wait,p,event,events) {
  if(wait.revision!==undefined&&event.seq<=wait.revision)return;
  if(p.kind==='review-followup'&&event.type==='review.followup-ended'&&event.review_id===p.review_id&&event.run===p.run&&event.item===p.item&&event.source_seq===p.source_seq){
    const source=events.find(e=>e.seq===p.source_seq&&e.type==='review.verdict'&&e.common===wait.identity&&e.run===p.run&&e.item===p.item&&
      e.review?.id===p.review_id&&e.review.record_seq===e.seq&&e.review.followup_expected===true);
    if(source&&event.seq>source.seq)return 'complete';
  }
  if(p.kind==='git-removal'&&event.type==='closeout.effect'&&event.identity===wait.identity&&event.key===p.key&&same(event.source,p.source)){
    const o=event.outcome;
    if(o?.action!=='git-removal-finished'||o.attempt!==p.attempt||!Number.isSafeInteger(o.exit_status)||o.exit_status<1||
      o.code||/EPERM|EACCES|native refusal|permission denied|operation not permitted/i.test(o.reason??''))return;
    const start=events.find(e=>e.type==='closeout.effect'&&e.identity===wait.identity&&e.key===p.key&&same(e.source,p.source)&&
      e.outcome?.action==='git-removal-started'&&e.outcome.attempt===p.attempt&&e.seq<event.seq);
    if(!start||!['worktree','branch'].includes(start.outcome.operation))return;
    const proof=events.find(e=>e.type==='closeout.effect'&&e.identity===wait.identity&&e.key===p.key&&same(e.source,p.source)&&
      e.outcome?.action==='lane-preflight'&&e.seq<start.seq&&['cwd','branch','tip','evidence','branchGeneration'].every(k=>same(e.outcome[k],start.outcome[k])));
    if(proof?.outcome.evidence?.directory&&proof.outcome.branchGeneration&&
      ['operation','cwd','branch','tip','evidence','branchGeneration'].every(k=>same(start.outcome[k],o[k])))return 'complete';
  }
  if(p.kind==='worker-report'&&event.type==='report.ingested'&&event.run===p.run){
    const claim=events.findLast(e=>e.type==='run.claimed'&&e.run===p.run&&(event.seq===undefined||e.seq<event.seq));
    if(claim?.seq===p.claim)return event.report?.outcome==='done'?'complete':'failed';
  }
  if(p.kind==='lane-removal'&&event.type==='closeout.effect'&&event.identity===wait.identity&&event.key===p.key&&same(event.source,p.source)&&event.outcome?.action==='lane-removed'&&event.outcome.cwd===p.cwd&&event.outcome.tip===p.head)return 'complete';
  if(p.kind==='lifecycle-release'&&event.type==='closeout.lifecycle-released'&&event.identity===wait.identity&&event.jobs?.some(j=>j.id===p.job&&j.run===p.run&&`lane/${j.topic}`===p.branch&&j.tip===p.head))return 'complete';
  if(p.kind==='native-command'&&event.identity===wait.identity&&event.key===p.key&&same(event.source,p.source)){
    const intent=events.find(e=>e.type==='closeout.effect'&&e.effect===p.intent&&e.key===p.key&&same(e.source,p.source));
    if(!intent||intent.identity!==wait.identity||intent.seq>=event.seq||event.intent!==undefined&&event.intent!==p.intent)return;
    const o=event.outcome;
    if(event.type==='closeout.effect'&&(p.action==='agent-exit-requested'&&o?.action==='exit-observed'&&o.pane===p.pane&&o.occupant?.terminal_id===p.terminal&&o.occupant?.agent_session_id===p.session||p.action==='shell-close-requested'&&o?.action==='closed'&&o.tab_id===p.tab||p.action==='workspace-close-requested'&&o?.action==='closed'&&o.workspace_id===p.workspace))return 'complete';
    if(event.type==='closeout.command-failed')return 'failed';
    if(event.type==='closeout.command-not-started'&&event.intent===p.intent&&event.native_started===false)return 'complete';
  }
}
const statuses=(wait,events)=>events.filter(e=>{
  if(e.type!=='closeout.producer-status'||e.identity!==wait.identity||e.key!==wait.key||e.wait_id!==wait.wait_id||!same(e.source,wait.source)||!wait.waiting.producers.some(p=>same(p,e.producer)))return false;
  const completion=events.find(c=>c.seq===e.completion?.seq&&c.type===e.completion?.type);
  return completion&&producedStatus(wait,e.producer,completion,events)===e.status;
});
export function closeoutWaitState(wait,events) {
  if(!wait)return 'unlinked';
  if(wait.waiting.defect)return 'defect';
  const rows=statuses(wait,events);
  const current=wait.waiting.producers.map(p=>p.kind==='native-command'?
    rows.findLast(e=>same(e.producer,p))?.status:
    rows.some(e=>same(e.producer,p)&&e.status==='failed')?'failed':rows.find(e=>same(e.producer,p))?.status);
  if(current.includes('failed'))return 'failed';
  return current.length&&current.every(status=>status==='complete')?'complete':'pending';
}

// Called in the SAME transaction by actual report and native/removal writers.
export function linkedCloseoutStatuses(events,added) {
  const waits=[...events,...added].filter(e=>e.type==='closeout.waiting'),out=[],start=events.at(-1)?.seq??0;
  for(const [index,raw]of added.entries()){
    const event={...raw,seq:raw.seq??start+index+1};
    for(const wait of waits){
      if(wait.waiting.defect)continue;
      for(const p of wait.waiting.producers){
        const status=producedStatus(wait,p,event,events);
        const prior=[...events,...out].findLast(e=>e.type==='closeout.producer-status'&&e.wait_id===wait.wait_id&&same(e.producer,p));
        if(!status||prior&&(p.kind!=='native-command'||prior.status==='complete'||prior.status===status))continue;
        out.push({type:'closeout.producer-status',identity:wait.identity,key:wait.key,source:wait.source,wait_id:wait.wait_id,producer:p,status,completion:{type:event.type,seq:event.seq}});
      }
    }
  }
  return out;
}

export function registerCloseoutWait(entry,prior,events,entries) {
  if(directCloseoutObservation(entry,prior,events))return[];
  if(prior.completed||closeoutNextStage(entry,prior,events,entries)||closeoutWait(entry,prior,events))return[];
  const wait={type:'closeout.waiting',identity:entry.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,revision:prior.revision,wait_id:closeoutWaitId(entry,prior),waiting:closeoutProducer(entry,prior,{events,entries})};
  return[wait,...linkedCloseoutStatuses(events,[wait,...events.filter(e=>e.seq>prior.revision)])];
}

// Written only when the pre-command guard refused after the intent was
// journaled: the native command was positively never invoked.
export function closeoutCommandNotStarted(entry,intent,action,error) {
  return{type:'closeout.command-not-started',identity:entry.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,intent,action,native_started:false,
    reason:error.message,...(error.code?{code:error.code}:{}),qualification:'The pre-command guard refused before the native command was invoked; no native command was sent.'};
}

export function nativeCloseoutWait(entry,row,intent) {
  const p={kind:'native-command',key:entry.key,source:entry.source,action:row.action,intent,
    ...(row.action==='agent-exit-requested'?{pane:row.pane,terminal:row.occupant?.[5],session:row.occupant?.[6]}:row.action==='shell-close-requested'?{tab:row.tab_id}:{workspace:row.workspace_id})};
  return{type:'closeout.waiting',identity:entry.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,wait_id:hash([entry.key,entry.source,intent]),waiting:{owner:'native-closeout-command',producers:[p]}};
}
