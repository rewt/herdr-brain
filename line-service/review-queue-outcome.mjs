// Settle only a completed, positively pre-append record command. An absent
// reviewer/process alone never proves that an UNKNOWN command created nothing.
import path from 'node:path';
import {reviewDigest} from './review-resolutions.mjs';
import {resolvedReference} from './review-reference-proof.mjs';
import {sameCapturedTarget,sameProducerQueue,capturedReviewCommits} from './review-group.mjs';
import {roleIs} from '../lib/roles.mjs';
import {outcomeFailure} from '../lib/uncertain-outcome.mjs';
import {resolvedQueuePlanning} from './review-queue-proof.mjs';

// These record fences throw before plannedAppend's append, naming that in the
// message. Bound to the uncaught stack's first frame: a refusal, a revalidation
// failure carrying a cause, or any other status 1 is not this retry.
const conflicts=[
  {frame:/^recordSourceConflict \(file:\/\/\/[^\n)]*\/lib\/record-observation\.mjs:\d+:\d+\)$/,message:/^record (?:Git )?observation conflict: (?![^\n]*could not be revalidated)[^\n]+ changed; no append was made$|^record (?:Git )?observation changed while planning: [^\n]+$/},
  {frame:/^readRecord \(file:\/\/\/[^\n)]*\/lib\/record-snapshot\.mjs:\d+:\d+\)$/,message:/^record changed repeatedly while preparing a consistent read; no mutation attempted$/},
];
function transientConflict(entry){
  const r=entry?.receipt;
  if(r?.status!==1||typeof r.stderr!=='string'||entry.error!==r.stderr.trim())return null;
  const found=/^file:\/\/\/[^\n]+\n[^\n]*\n *\^+\n\nError: ([^\n]+)\n {4}at ([^\n]+)\n/.exec(r.stderr);
  return found&&conflicts.some(c=>c.message.test(found[1])&&c.frame.test(found[2]))?found[1]:null;
}
// A retry that met another conflict may retry again. Any other outcome ends it.
const transientRetry=entry=>entry?.queue_recovery?.kind==='pre-append-transient-conflict'&&
  Array.isArray(entry.history)&&entry.history.length>0&&entry.history.every(transientConflict);

export function reviewQueueNoMutation({entry,key,events,state,repo,org,identity,item,run,target}){
  const local=entry?.error==='immutable landed target/evidence changed before queue mutation'&&
    resolvedQueuePlanning({events,state,repo,org,identity,item:item.id,run:run.id,key,entry});
  // A final report can replace the pre-report evidence representation. Permit
  // that continuation only for the identical source range, never a retarget.
  const sameRange=local&&['head','base','diff_sha256','dispatch'].every(k=>entry.review_target[k]===target[k])&&
    JSON.stringify(capturedReviewCommits(entry.review_target))===JSON.stringify(capturedReviewCommits(target));
  if(!entry||entry.state!=='held'||entry.owner!=='line-service'||entry.subject!==key||
    key!==`review:${item.id}:${target.head}`||entry.review_operation!=='record-queue'||
    !sameRange&&JSON.stringify(entry.review_target)!==JSON.stringify(target)||entry.result!=null||
    !transientRetry(entry)&&(entry.history!=null&&(!Array.isArray(entry.history)||entry.history.length)||entry.queue_recovery)||
    entry.recorded_review_status||outcomeFailure(entry).kind==='fence'||
    ['worker','reviewer','launchProcess','native_qualification','review_item','review_run'].some(k=>entry[k]!=null)||
    entry.native_launch_attempted===true||
    !Number.isFinite(Date.parse(entry.at))||!Number.isFinite(Date.parse(entry.finished_at))||
    Date.parse(entry.finished_at)<Date.parse(entry.at))return null;
  const r=entry.receipt;
  if(!local&&(!r||![1,3].includes(r.status)||r.signal!==null||r.stdout!==''||r.error!=null||r.signal_sent!==false))return null;
  // This exact legacy diagnostic is thrown by protectRecordMutation while
  // deriving a pure queue-review plan, before plannedAppend's commit/append.
  // Genuine queue/STOP/native refusals and arbitrary status-3 errors stay held.
  const queue=path.join(identity,'promote/queue.json');
  // recordProject can exhaust its snapshot before the queue path is resolved.
  const diagnostics=['',` ${queue}`].map(location=>`record: promotion write guard REFUSED (fail-closed): cannot read the project's promotion queue${location}: record changed repeatedly while preparing a consistent read; no mutation attempted. Stale entries never expire; repair/inspect the queue before writing. Write the information on an unguarded parent or in the supervisor digest meanwhile, and copy it to the member after landing and reconciliation.\n`);
  if(!local&&r.status===3&&(!diagnostics.includes(r.stderr)||entry.error!==r.stderr.trim()))return null;
  if([...state.items.values()].some(q=>roleIs(q,'REV')&&(q.parent===item.id||
    sameProducerQueue(q,item.id,run.id)||q.meta.review_source_item===item.id&&q.meta.review_target?.head===target.head)))return null;
  if([...state.runs.values()].some(r=>r.meta?.reviewQueue&&(r.meta.reviewQueue.head===target.head||r.meta.review_source_run===run.id)))return null;
  if(events.some(e=>e.type==='change.reviewed'&&e.item===item.id&&e.head===target.head||
    e.type.startsWith('review.')&&e.type!=='review.reference-resolved'&&
    (e.run===run.id||(e.item===item.id||e.source_item===item.id)&&(e.head===target.head||e.target?.head===target.head))))return null;
  if(local)return sameRange?local:null;
  const conflict=transientConflict(entry);
  if(transientRetry(entry)&&!conflict)return null;
  if(r.status===1)return resolvedQueuePlanning({events,state,repo,org,identity,item:item.id,run:run.id,key,entry})??(conflict&&{
    schema:'review-queue-no-mutation/v1',kind:'pre-append-transient-conflict',project:identity,org,subject:key,item:item.id,run:run.id,target,
    original_sha256:reviewDigest(JSON.stringify(entry)),receipt_sha256:reviewDigest(JSON.stringify(r)),record_seq:events.at(-1)?.seq,conflict});
  const resolutions=events.filter(e=>e.type==='review.reference-resolved'&&e.project===identity&&e.org===org&&
    e.item===item.id&&e.run===run.id&&sameCapturedTarget(e.target,target));
  if(!resolutions.length||resolutions.some(e=>e.disposition!=='needs-review'||
    !resolvedReference({events,state,repo,org,identity,item:item.id,run:run.id,target,file:e.reference})))return null;
  return{schema:'review-queue-no-mutation/v1',kind:'pre-append-record-contention',project:identity,org,
    subject:key,item:item.id,run:run.id,target,original_sha256:reviewDigest(JSON.stringify(entry)),
    receipt_sha256:reviewDigest(JSON.stringify(r)),record_seq:events.at(-1)?.seq,
    reference_resolution_seqs:resolutions.map(e=>e.seq)};
}
