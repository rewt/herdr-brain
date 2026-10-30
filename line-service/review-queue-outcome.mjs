// Settle only a completed, positively pre-append record command. An absent
// reviewer/process alone never proves that an UNKNOWN command created nothing.
import path from 'node:path';
import {reviewDigest} from './review-resolutions.mjs';
import {resolvedReference} from './review-reference-proof.mjs';
import {sameCapturedTarget,sameProducerQueue} from './review-group.mjs';
import {roleIs} from '../lib/roles.mjs';
import {outcomeFailure} from '../lib/uncertain-outcome.mjs';

export function reviewQueueNoMutation({entry,key,events,state,repo,org,identity,item,run,target}){
  if(!entry||entry.state!=='held'||entry.owner!=='line-service'||entry.subject!==key||
    key!==`review:${item.id}:${target.head}`||entry.review_operation!=='record-queue'||
    JSON.stringify(entry.review_target)!==JSON.stringify(target)||entry.result!=null||
    entry.history!=null&&(!Array.isArray(entry.history)||entry.history.length)||
    entry.queue_recovery||entry.recorded_review_status||outcomeFailure(entry).kind==='fence'||
    ['worker','reviewer','launchProcess','native_qualification','review_item','review_run'].some(k=>entry[k]!=null)||
    entry.native_launch_attempted===true||
    !Number.isFinite(Date.parse(entry.at))||!Number.isFinite(Date.parse(entry.finished_at))||
    Date.parse(entry.finished_at)<Date.parse(entry.at))return null;
  const r=entry.receipt;
  if(!r||r.status!==3||r.signal!==null||r.stdout!==''||r.error!=null||r.signal_sent!==false)return null;
  // This exact legacy diagnostic is thrown by protectRecordMutation while
  // deriving a pure queue-review plan, before plannedAppend's commit/append.
  // Genuine queue/STOP/native refusals and arbitrary status-3 errors stay held.
  const queue=path.join(identity,'promote/queue.json');
  const diagnostic=`record: promotion write guard REFUSED (fail-closed): cannot read the project's promotion queue ${queue}: record changed repeatedly while preparing a consistent read; no mutation attempted. Stale entries never expire; repair/inspect the queue before writing. Write the information on an unguarded parent or in the supervisor digest meanwhile, and copy it to the member after landing and reconciliation.\n`;
  if(r.stderr!==diagnostic||entry.error!==diagnostic.trim())return null;
  if([...state.items.values()].some(q=>roleIs(q,'REV')&&(q.parent===item.id||
    sameProducerQueue(q,item.id,run.id)||q.meta.review_source_item===item.id&&q.meta.review_target?.head===target.head)))return null;
  if([...state.runs.values()].some(r=>r.meta?.reviewQueue&&(r.meta.reviewQueue.head===target.head||r.meta.review_source_run===run.id)))return null;
  if(events.some(e=>e.type==='change.reviewed'&&e.item===item.id&&e.head===target.head||
    e.type.startsWith('review.')&&e.type!=='review.reference-resolved'&&
    (e.run===run.id||(e.item===item.id||e.source_item===item.id)&&(e.head===target.head||e.target?.head===target.head))))return null;
  const resolutions=events.filter(e=>e.type==='review.reference-resolved'&&e.project===identity&&e.org===org&&
    e.item===item.id&&e.run===run.id&&sameCapturedTarget(e.target,target));
  if(!resolutions.length||resolutions.some(e=>e.disposition!=='needs-review'||
    !resolvedReference({events,state,repo,org,identity,item:item.id,run:run.id,target,file:e.reference})))return null;
  return{schema:'review-queue-no-mutation/v1',kind:'pre-append-record-contention',project:identity,org,
    subject:key,item:item.id,run:run.id,target,original_sha256:reviewDigest(JSON.stringify(entry)),
    receipt_sha256:reviewDigest(JSON.stringify(r)),record_seq:events.at(-1)?.seq,
    reference_resolution_seqs:resolutions.map(e=>e.seq)};
}
