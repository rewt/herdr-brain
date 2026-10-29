// A disposition identifies an original reference; it never cancels an attempt.
import path from 'node:path';
import {reviewDigest as hash,reviewPlain} from './review-resolutions.mjs';
import {capturedRange,captureEvidence} from './review-targets.mjs';
import {sameCapturedTarget,sameProducerQueue} from './review-group.mjs';
import {roleIs} from '../lib/roles.mjs';

export const referenceRevision=({events,identity,org,item,run,target})=>Math.max(0,...events.filter(e=>e.type==='review.reference-resolved'&&e.project===identity&&e.org===org&&e.item===item&&e.run===run&&sameCapturedTarget(e.target,target)).map(e=>e.seq));

export function referenceProof({events,state,repo,org,item,run,target,input}){
  const bytes=reviewPlain(input.reference),value=JSON.parse(bytes);
  if(hash(bytes)!==input.reference_sha256)throw Error('original review reference bytes changed');
  capturedRange({repo,target});captureEvidence(target);
  const heads=[value.head,value.deliveryRange?.head,value.review_target?.head,value.reviewed_head,value.commit].filter(v=>v!=null);
  const bases=[value.base,value.deliveryRange?.base,value.review_target?.base].filter(v=>v!=null);
  if(!heads.length||heads.some(h=>h!==target.head)||bases.some(b=>b!==target.base))throw Error('reference needs one exact landed head/base; scope is UNKNOWN or contradictory');
  if(input.disposition==='needs-review'){
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
  const proof=referenceProof({events,state,repo,org,item,run,target,input:request});
  if(JSON.stringify(proof)!==JSON.stringify(e.proof)||JSON.stringify(archived.proof)!==JSON.stringify(proof))throw Error('review reference resolution proof changed');
  return true;
}
