// Narrow cleanup dependency links in the existing record, not a transport/bus.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fold} from './state.mjs';
import {outcomeFailure} from './uncertain-outcome.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const closeoutWaitId=(entry,prior)=>hash([entry.common,entry.key,entry.source,prior.revision,prior.reason]);

export function closeoutProducer(entry,prior,{events,entries}) {
  const state=fold(events),reason=prior.reason??'';
  const defect=why=>({owner:'line-service',defect:why,producers:[]});
  if(prior.failure?.kind==='fence'||outcomeFailure(prior).kind==='fence'||/EPERM|EACCES|native refusal/i.test(reason))return defect('Recorded native refusal has stopped this effect; owner judgment is required.');
  if(/HOLD/.test(reason))return defect('HOLD removal has no existing record completion writer; retain the hold and its exact entry.');
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
  if(p.kind==='worker-report'&&event.type==='report.ingested'&&event.run===p.run){
    const claim=events.findLast(e=>e.type==='run.claimed'&&e.run===p.run&&(event.seq===undefined||e.seq<event.seq));
    if(claim?.seq===p.claim)return event.report?.outcome==='done'?'complete':'failed';
  }
  if(p.kind==='lane-removal'&&event.type==='closeout.effect'&&event.identity===wait.identity&&event.key===p.key&&same(event.source,p.source)&&event.outcome?.action==='lane-removed'&&event.outcome.cwd===p.cwd&&event.outcome.tip===p.head)return 'complete';
  if(p.kind==='lifecycle-release'&&event.type==='closeout.lifecycle-released'&&event.identity===wait.identity&&event.jobs?.some(j=>j.id===p.job&&j.run===p.run&&`lane/${j.topic}`===p.branch&&j.tip===p.head))return 'complete';
  if(p.kind==='native-command'&&event.identity===wait.identity&&event.key===p.key&&same(event.source,p.source)){
    const intent=events.find(e=>e.type==='closeout.effect'&&e.effect===p.intent&&e.key===p.key&&same(e.source,p.source));
    if(!intent||intent.seq>=event.seq)return;
    const o=event.outcome;
    if(event.type==='closeout.effect'&&(p.action==='agent-exit-requested'&&o?.action==='exit-observed'&&o.pane===p.pane&&o.occupant?.terminal_id===p.terminal&&o.occupant?.agent_session_id===p.session||p.action==='shell-close-requested'&&o?.action==='closed'&&o.tab_id===p.tab||p.action==='workspace-close-requested'&&o?.action==='closed'&&o.workspace_id===p.workspace))return 'complete';
    if(event.type==='closeout.command-failed')return 'failed';
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
  if(rows.some(e=>e.status==='failed'))return 'failed';
  return wait.waiting.producers.length&&wait.waiting.producers.every(p=>rows.some(e=>same(e.producer,p)&&e.status==='complete'))?'complete':'pending';
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
        if(!status||[...events,...out].some(e=>e.type==='closeout.producer-status'&&e.wait_id===wait.wait_id&&same(e.producer,p)))continue;
        out.push({type:'closeout.producer-status',identity:wait.identity,key:wait.key,source:wait.source,wait_id:wait.wait_id,producer:p,status,completion:{type:event.type,seq:event.seq}});
      }
    }
  }
  return out;
}

export function registerCloseoutWait(entry,prior,events,entries) {
  if(prior.completed||closeoutWait(entry,prior,events))return[];
  const wait={type:'closeout.waiting',identity:entry.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,revision:prior.revision,wait_id:closeoutWaitId(entry,prior),waiting:closeoutProducer(entry,prior,{events,entries})};
  return[wait,...linkedCloseoutStatuses(events,[wait,...events.filter(e=>e.seq>prior.revision)])];
}

export function nativeCloseoutWait(entry,row,intent) {
  const p={kind:'native-command',key:entry.key,source:entry.source,action:row.action,intent,
    ...(row.action==='agent-exit-requested'?{pane:row.pane,terminal:row.occupant?.[5],session:row.occupant?.[6]}:row.action==='shell-close-requested'?{tab:row.tab_id}:{workspace:row.workspace_id})};
  return{type:'closeout.waiting',identity:entry.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,wait_id:hash([entry.key,entry.source,intent]),waiting:{owner:'native-closeout-command',producers:[p]}};
}
