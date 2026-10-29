// A disposition identifies an original reference; it never cancels an attempt.
import path from 'node:path';
import {reviewDigest as hash,reviewPlain} from './review-resolutions.mjs';
import {capturedRange,captureEvidence} from './review-targets.mjs';
import {sameCapturedTarget,sameProducerQueue} from './review-group.mjs';
import {roleIs} from '../lib/roles.mjs';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {lineDirectory} from './cutoff.mjs';

export const referenceRevision=({events,identity,org,item,run,target})=>Math.max(0,...events.filter(e=>e.type==='review.reference-resolved'&&e.project===identity&&e.org===org&&e.item===item&&e.run===run&&sameCapturedTarget(e.target,target)).map(e=>e.seq));

// This marker attributes worker to the producer. It is not an automatic queue
// exemption: original bytes, exact landed scope and supervisor disposition bind
// the positive never-queued proof below.
const producerSchemas=['record-review-handoff/v1','bch-single-record-review-handoff/1'];
export const producerReportHandoff=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&(
  producerSchemas.includes(value.schema)||
  ['schema','type','kind','role'].every(k=>value[k]==null)&&typeof value.run==='string'&&typeof value.worker==='string'&&value.producerEvidence!=null&&(value.head!=null||value.source!=null||value.ownedScope?.head!=null)));

function producerRecordProof({events,repo,org,item,run,target,input,observation}){
  const recordSeq=observation?.record_seq??events.at(-1)?.seq;
  if(!Number.isSafeInteger(recordSeq)||recordSeq<1||!events.some(e=>e.seq===recordSeq))throw Error('producer record checkpoint is UNKNOWN');
  const prefix=events.filter(e=>e.seq<=recordSeq),state=fold(prefix),source=state.runs.get(run);
  const reports=prefix.filter(e=>e.type==='report.ingested'&&e.run===run),report=reports[0];
  if(reports.length!==1||source?.item!==item||source.report?.seq!==report.seq||!Number.isFinite(Date.parse(report.at)))throw Error('producer ingested handoff checkpoint is missing/ambiguous');
  const file=path.resolve(org,report.file??'');
  if(!file.startsWith(org+path.sep)||hash(reviewPlain(file))!==report.sha256||
    !(report.report?.artifacts??[]).some(a=>typeof a==='string'&&a.split(/[ #]/)[0]===input.reference)||
    target.source_group?.report_sha256&&target.source_group.report_sha256!==report.sha256)throw Error('producer ingested report bytes/reference binding changed');
  if([...state.items.values()].some(q=>roleIs(q,'REV')&&(sameProducerQueue(q,item,run)||q.meta.review_source_item===item&&q.meta.review_target?.head===target.head))||
    prefix.some(e=>(e.type==='change.reviewed'||e.type.startsWith('review.')&&e.type!=='review.reference-resolved')&&
      [run,item,target.head].some(v=>JSON.stringify(e).includes(JSON.stringify(v)))))throw Error('producer record retains a review attempt/verdict; no replacement');
  const directory=lineDirectory(org,gitProject(repo).identity),controls=path.join(directory,'controls.jsonl'),all=reviewPlain(controls);
  const length=observation?.stop?.length??all.length;
  if(!Number.isSafeInteger(length)||length<1||length>all.length)throw Error('producer STOP audit prefix changed');
  const bytes=all.subarray(0,length);
  if(bytes.at(-1)!==10||observation&&(observation.stop?.file!==controls||observation.stop.sha256!==hash(bytes)))throw Error('producer STOP audit prefix changed');
  const rows=bytes.toString().trimEnd().split('\n').map(s=>JSON.parse(s)),checkpoint=Date.parse(report.at);
  const serviceTarget=`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`;
  let previous=-Infinity,stopped=null;
  for(let i=0;i<rows.length;i++){
    const row=rows[i],at=Date.parse(row.at);
    if(!Number.isFinite(at)||at<previous||row.target!==serviceTarget)throw Error('producer STOP audit time/target is UNKNOWN');
    previous=at;if(at>checkpoint)continue;
    // Every later control edge invalidates the earlier stopped observation,
    // including failed/uncertain restart and partial stop attempts.
    stopped=['stop','revert'].includes(row.action)&&row.phase==='stopped'?i:null;
  }
  if(stopped==null)throw Error('producer handoff has no positive historical STOP window');
  return{kind:'producer-record-no-attempt',reference_sha256:input.reference_sha256,record_seq:recordSeq,
    report:{seq:report.seq,file,sha256:report.sha256,at:report.at},stop:{file:controls,length,sha256:hash(bytes),row:stopped,at:rows[stopped].at}};
}

export function referenceProof({events,state,repo,org,item,run,target,input,observation}){
  const bytes=reviewPlain(input.reference),value=JSON.parse(bytes);
  if(hash(bytes)!==input.reference_sha256)throw Error('original review reference bytes changed');
  capturedRange({repo,target});captureEvidence(target);
  const producer=producerReportHandoff(value);
  const heads=[value.head,value.deliveryRange?.head,value.review_target?.head,value.reviewed_head,value.commit,
    ...(producer?[value.ownedScope?.head,value.source]:[])].filter(v=>v!=null);
  const bases=[value.base,value.deliveryRange?.base,value.review_target?.base,
    ...(producer?[value.ownedScope?.base]:[])].filter(v=>v!=null);
  if(!heads.length||heads.some(h=>h!==target.head)||bases.some(b=>b!==target.base))throw Error('reference needs one exact landed head/base; scope is UNKNOWN or contradictory');
  if(input.disposition==='needs-review'){
    if(producer){
      const worker=effectiveWorkerIdentity(state.runs.get(run),state),review=value.review;
      const queueFlags=[...['queueAttempted','queueMutation','queueCommandAttempted','parallelReviewStarted','waitedForVerdict'].filter(k=>Object.hasOwn(value,k)).map(k=>value[k]),
        ...['queueAttempted','queueCommandAttempted','parallelReviewStarted','waitedForVerdict'].filter(k=>review&&Object.hasOwn(review,k)).map(k=>review[k])];
      if(input.review_item!=null||![value.run,value.source_run].filter(v=>v!=null).length||
        [value.run,value.source_run].some(v=>v!=null&&v!==run)||[value.item,value.source_item].some(v=>v!=null&&v!==item)||
        worker.identity_conflict||typeof value.worker!=='string'||value.worker!==worker.agent||
        ['type','kind','role'].some(k=>value[k]!=null)||queueFlags.some(v=>v!==false)||
        Object.hasOwn(value,'stage')||
        Object.hasOwn(value,'native_launch_attempted')&&value.native_launch_attempted!==false||
        ['reviewer','launchProcess','sessionBinding','watcher','verdict','qualification','native_qualification','review_item','review_run','agent','pane','terminal','session','pid','reviewer_session','reviewer_pane'].some(k=>value[k]!=null||review&&typeof review==='object'&&review[k]!=null)||
        review!=null&&typeof review!=='string'&&(typeof review!=='object'||Array.isArray(review))||
        review?.worker!=null||review?.item!=null||review?.run!=null||review?.native_launch_attempted!=null||
        review?.cap!=null&&review.cap!==1||review?.reviewerSuites!=null&&review.reviewerSuites!==0||
        value.error!=null)throw Error('producer handoff queue outcome remains UNKNOWN/started/refused; retain the original reference');
      if(value.queueAttempted===false&&value.queueMutation===false)return{kind:'producer-queue-not-attempted',reference_sha256:hash(bytes)};
      return producerRecordProof({events,repo,org,item,run,target,input,observation});
    }
    // A missing launch flag or missing process is not positive zero-native proof.
    // Only a serialized pre-native barrier may enter ordinary queue admission.
    if(input.review_item!=null||(value.source_run??value.run)!==run||value.item&&value.item!==item||value.source_item&&value.source_item!==item||value.native_launch_attempted!==false||!['open','start','worker'].includes(value.stage)||
      ['worker','reviewer','review','launchProcess','sessionBinding','watcher','verdict','review_item','review_run','agent','pane','terminal','session','pid','reviewer_session','reviewer_pane'].some(k=>value[k]!=null)||
      /EPERM|EACCES|refus|identity|ownership|reserved|HOLD|STOP/i.test(value.error??''))throw Error('reference native outcome remains UNKNOWN/started/refused; retain the original attempt');
    return{kind:'positive-pre-native-barrier',reference_sha256:hash(bytes)};
  }
  if(!['mapped-review','superseded'].includes(input.disposition))throw Error('choose mapped-review, superseded or needs-review');
  const q=state.items.get(input.review_item),named=[value.review_item,value.review?.item].filter(Boolean),runs=[value.review_run,value.review?.run].filter(Boolean);
  if(!roleIs(q,'REV')||q.meta.review_round_cap!==1||!sameProducerQueue(q,item,run)||!sameCapturedTarget(q.meta.review_target,target)||
    q.runs.length!==1||!state.runs.has(q.runs[0])||named.some(id=>id!==q.id)||runs.some(id=>id!==q.runs[0])||
    !named.includes(q.id)&&!runs.includes(q.runs[0])||
    ['worker','reviewer','launchProcess','sessionBinding','agent','pane','terminal','session','pid','reviewer_session','reviewer_pane'].some(k=>value[k]!=null))throw Error('reference does not identify exactly this existing immutable review attempt/target');
  capturedRange({repo,target:q.meta.review_target});captureEvidence(q.meta.review_target);
  const verdicts=events.filter(e=>e.type==='change.reviewed'&&e.item===item&&e.head===target.head&&e.review_item===q.id&&q.runs.includes(e.review_run));
  if(input.disposition==='superseded'&&(verdicts.length!==1||!['PASS','FAIL','NEEDS-WORK'].includes(verdicts[0].verdict)))throw Error('superseded reference needs its one recorded exact-target verdict');
  return{kind:input.disposition,review_item:q.id,target_sha256:hash(JSON.stringify(q.meta.review_target)),verdict_seq:input.disposition==='superseded'?verdicts[0].seq:null};
}

export function resolvedReference({events,state,repo,org,identity,item,run,target,file}){
  const rows=events.filter(e=>e.type==='review.reference-resolved'&&e.project===identity&&e.org===org&&e.item===item&&e.run===run&&e.reference===file&&sameCapturedTarget(e.target,target));
  if(!rows.length)return false;
  if(rows.length!==1)throw Error('review reference dispositions are ambiguous; retain the original');
  const e=rows[0],decision=events.find(d=>d.seq===e.decision_seq&&d.type==='note.added'&&d.decision&&d.by===e.native_caller?.name&&[item,run].includes(d.id));
  if(e.by!==e.native_caller?.name||!decision||![e.id,item,run,target.head,e.reference_sha256,e.disposition].every(v=>decision.text.includes(v)))throw Error('review reference lost its exact native supervisor decision');
  if(!e.archive?.file?.startsWith(path.join(org,'evidence/review-references')+path.sep)||hash(reviewPlain(e.archive.file))!==e.archive.sha256)throw Error('review reference archive changed');
  const archived=JSON.parse(reviewPlain(e.archive.file));
  const request={id:e.id,item,run,target,reference:e.reference,reference_sha256:e.reference_sha256,disposition:e.disposition,review_item:e.review_item??null,decision_seq:e.decision_seq};
  if(JSON.stringify(archived.request)!==JSON.stringify(request)||hash(reviewPlain(file))!==e.reference_sha256||hash(Buffer.from(archived.original,'base64'))!==e.reference_sha256)throw Error('original review reference/archive binding changed');
  if(e.proof?.kind==='producer-record-no-attempt'&&!(e.proof.record_seq<e.seq))throw Error('producer observation must precede its disposition');
  const proof=referenceProof({events,state,repo,org,item,run,target,input:request,observation:e.proof});
  if(JSON.stringify(proof)!==JSON.stringify(e.proof)||JSON.stringify(archived.proof)!==JSON.stringify(proof))throw Error('review reference resolution proof changed');
  return true;
}
