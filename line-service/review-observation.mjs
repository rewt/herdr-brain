// Recognize a producer's readback of existing record facts, never an
// independent review attempt. Every copied row must bind real owning evidence.
import {canonical} from '../messages/schema.mjs';
import {roleIs} from '../lib/roles.mjs';

export function producerReviewObservation(value,{events,state,item,run,identity,nativeHeads}) {
  if(!value||Object.keys(value).some(k=>!['observed_at','landed','reviews'].includes(k))||!Number.isFinite(Date.parse(value.observed_at))||
      !Array.isArray(value.landed)||!value.landed.length||!Array.isArray(value.reviews))return false;
  if(!value.landed.every(row=>row.type==='change.landed'&&row.item===item&&row.run===run&&row.project===identity&&nativeHeads.has(row.head)&&
      events.some(e=>e.seq===row.seq&&canonical(e)===canonical(row))))return false;
  return value.reviews.every(row=>{
    if(!row||Object.keys(row).some(k=>!['item','run','head','base','cap','runs','closed','evidence_kind'].includes(k)))return false;
    const q=state.items.get(row.item),target=q?.meta.review_target;
    return Boolean(target)&&nativeHeads.has(row.head)&&roleIs(q,'REV')&&q.meta.review_source_item===item&&q.meta.review_source_run===run&&row.run===run&&
      row.head===target.head&&row.base===target.base&&row.evidence_kind===target.evidence_kind&&row.cap===1&&q.meta.review_round_cap===1&&
      Array.isArray(row.runs)&&row.runs.every(id=>q.runs.includes(id)&&state.runs.get(id)?.item===q.id)&&
      (row.closed===null||Boolean(row.closed&&q.closed)&&canonical(row.closed)===canonical(q.closed));
  });
}
