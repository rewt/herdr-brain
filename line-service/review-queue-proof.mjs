// Two audited historical planner exits, not a classifier for arbitrary status 1.
// Full stderr (including the pre-append stack and runtime) is matched after
// substituting only the actual canonical repository path. See DEC-445/R-1567.
import path from 'node:path';
import {readCommandResult} from '../lib/command-receipt.mjs';
import {outcomeFailure} from '../lib/uncertain-outcome.mjs';
import {reviewDigest as hash,reviewPlain} from './review-resolutions.mjs';

const signatures=new Map([
  ['b99e19367af0d2266f495ea003ad418fabdebf377a263038203d33bc8938296d','pre-append-record-observation'],
  ['534218680008ea4e4e7c2c4dd98d5e24699fdc917e5fb922d42a670ca2cd7f60','pre-append-source-selection'],
]);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const time=v=>Number.isFinite(Date.parse(v));
export function unconsumedQueueEntry({entry,key,item,target}){
  return Boolean(entry&&entry.state==='held'&&entry.owner==='line-service'&&entry.subject===key&&
    key===`review:${item}:${target?.head}`&&entry.review_operation==='record-queue'&&same(entry.review_target,target)&&
    entry.result==null&&(entry.history==null||Array.isArray(entry.history)&&!entry.history.length)&&
    !entry.queue_recovery&&!entry.recorded_review_status&&outcomeFailure(entry).kind!=='fence'&&
    !['worker','reviewer','launchProcess','native_qualification','review_item','review_run'].some(k=>entry[k]!=null)&&
    entry.native_launch_attempted!==true&&time(entry.at)&&time(entry.finished_at)&&Date.parse(entry.finished_at)>=Date.parse(entry.at));
}
export function terminalQueuePlanningProof({entry,key,repo,org,identity,item,run}){
  if(!unconsumedQueueEntry({entry,key,item,target:entry?.review_target})||!entry.attempt)return null;
  const r=entry.receipt,kind=r&&typeof r.stderr==='string'&&signatures.get(hash(r.stderr.replaceAll(repo,'<repo>')));
  if(!kind||r.status!==1||r.signal!==null||r.stdout!==''||r.error!=null||r.signal_sent!==false||entry.error!==r.stderr.trim()||entry.commands?.length!==1)return null;
  const ref=entry.commands[0],directory=path.join(org,'line-service',hash(JSON.stringify(identity)).slice(0,20));
  if(path.dirname(ref.file??'')!==path.join(directory,'active-commands')||path.dirname(ref.receipt??'')!==path.join(directory,'command-receipts'))return null;
  // Register the retained bytes in read-only record planning as well as checking
  // the foreground helper's original intent hash (even after active cleanup).
  const bytes=reviewPlain(ref.receipt),command=readCommandResult(ref),i=command.intent,t=entry.review_target;
  if(!same(command.result,r)||i.project!==identity||i.org!==org||i.cwd!==repo||i.subject!==item||i.key!==key||i.consumer!=='line-service'||
    !same(i.args,[path.join(repo,'bin/org.mjs'),'queue-review',run,'--head',t.head,'--base',t.base])||
    !time(i.at)||Date.parse(i.at)<Date.parse(entry.at)||Date.parse(command.finished_at)>Date.parse(entry.finished_at)||
    !Number.isSafeInteger(command.execution?.pid)||!time(command.execution?.started_at)||
    Date.parse(command.execution.started_at)<Date.parse(i.at)||Date.parse(command.execution.started_at)>Date.parse(command.finished_at))return null;
  return{schema:'review-queue-no-mutation/v1',kind,project:identity,org,subject:key,item,run,target:t,attempt:entry.attempt,
    original_sha256:hash(JSON.stringify(entry)),receipt_sha256:hash(JSON.stringify(r)),command_sha256:hash(bytes),intent_sha256:ref.sha256};
}

// A disposition settles only the exact original entry. A changed/lost-reply
// continuation is a different entry and cannot spend this proof again.
export function resolvedQueuePlanning({events,state,repo,org,identity,item,run,key,entry}){
  const found=events.filter(e=>e.type==='line-service.review-queue-reconciled'&&e.project===identity&&e.org===org&&e.item===item&&e.run===run&&e.key===key);
  if(!found.length)return null;
  if(found.length!==1)throw Error('queue planning disposition is ambiguous; retain original attempt');
  const e=found[0];
  if(hash(JSON.stringify(entry))!==e.proof?.original_sha256)return null;
  const current=state.runs.get(run);
  if(!current||current.item!==item||e.claim_generation!==current.owner_generation||!same(e.owner,current.owner)||e.by!==e.native_caller?.name)throw Error('queue planning disposition owner/claim changed');
  const file=path.join(org,'evidence/review-queue-reconciliation',`${e.id}.json`);
  if(e.archive?.file!==file)throw Error('queue planning archive path changed');
  const bytes=reviewPlain(file),archive=JSON.parse(bytes);
  if(hash(bytes)!==e.archive.sha256||!same(archive.proof,e.proof)||!same(archive.original,entry))throw Error('queue planning archive changed');
  const decision=events.find(d=>d.seq===e.decision_seq&&d.type==='note.added'&&d.decision&&d.by===e.native_caller?.name&&[item,run].includes(d.id));
  if(!decision||decision.seq>=e.seq||![e.id,item,run,entry.attempt,e.proof.original_sha256,e.proof.command_sha256].every(v=>typeof v==='string'&&decision.text.includes(v)))throw Error('queue planning disposition lost its exact supervisor decision');
  const proof=terminalQueuePlanningProof({entry,key,repo,org,identity,item,run});
  if(!proof||!same(proof,e.proof))throw Error('original terminal queue proof changed');
  return{...proof,reconciliation_seq:e.seq};
}
