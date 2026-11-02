// Evidence for the existing report-released logical admission pool. Selection
// runs only under the dispatch session-cap lock; it never grants admission.
import {createHash} from 'node:crypto';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=reason=>{throw Error(`capacity lineage: ${reason}`);};
const stamp=n=>Number.isSafeInteger(n)&&n>0;
const ms=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const payload=receipt=>Object.fromEntries(Object.entries(receipt).filter(([k])=>k!=='id'));
export const capacityIdentity=({common,org,kind,cap,native_cap})=>({project:common,org,pool:kind,cap,native_cap,
  scope:'report-released logical admission; not physical retirement'});

function allocation(job,journal,events){
  const start=events.find(e=>e.type==='run.started'&&e.id===job.run),
    claim=events.findLast(e=>e.type==='run.claimed'&&e.run===job.run);
  if(!start||!claim||!stamp(claim.seq)||job.ownership?.generation!==claim.seq||
      claim.project!==job.common||claim.record!==job.org||
      start.meta?.dispatch_project!==job.common||start.meta?.dispatch_record!==job.org||
      start.meta?.dispatch_attempt!==job.token||start.meta?.dispatch_journal!==journal||start.workspace!==job.workspace)
    fail('original start/claim/allocation missing or changed');
  return{run:job.run,started_seq:start.seq,claim_generation:claim.seq,attempt:job.token,journal,workspace:job.workspace};
}
function release(receipt,events){
  const source=events.find(e=>e.type==='report.ingested'&&e.run===receipt.allocation.run&&e.seq>receipt.allocation.claim_generation);
  if(!source||!source.sha256||ms(source.at)===null)return null;
  return{freeAt:source.at,freedBy:{type:source.type,seq:source.seq,run:source.run,sha256:source.sha256}};
}

// Re-resolve every link against original journals and events. Hashes detect
// changed transport bytes; they do not replace the source/claim joins.
export function validateCapacityAllocation(receipt,{events,journals,capacity},seen=new Set()){
  if(!receipt||receipt.schema!=='brain.capacity-allocation/v1'||receipt.id!==hash(payload(receipt)))fail('missing or changed receipt');
  if(!same(receipt.capacity,capacity)||!stamp(receipt.slot)||receipt.slot>capacity.cap||!['build','review','decision'].includes(capacity.pool))fail('mismatched capacity');
  if(seen.has(receipt.id))fail('disconnected or cyclic allocation');seen.add(receipt.id);
  const job=journals.find(j=>j.journal===receipt.allocation?.journal);
  if(!job||!same(job.capacityAllocation,receipt)||!same(allocation(job,job.journal,events),receipt.allocation))fail('wrong generation or disconnected allocation');
  const start=events.find(e=>e.seq===receipt.allocation.started_seq);
  if(ms(receipt.selected_at)===null||ms(start.at)===null||ms(receipt.selected_at)<ms(start.at))fail('selection predates original allocation');
  if(receipt.predecessor){
    const parent=journals.find(j=>j.journal===receipt.predecessor.journal)?.capacityAllocation;
    if(!parent||parent.id!==receipt.predecessor.id||parent.slot!==receipt.slot)fail('disconnected predecessor');
    validateCapacityAllocation(parent,{events,journals,capacity},seen);
    const freed=release(parent,events);
    if(!freed||!same(freed,{freeAt:receipt.freeAt,freedBy:receipt.freedBy})||
        receipt.freedBy.seq>=receipt.allocation.started_seq||ms(receipt.freeAt)>ms(receipt.selected_at))fail('missing or disconnected release');
    if(journals.some(j=>j.capacityAllocation?.id!==receipt.id&&j.capacityAllocation?.predecessor?.id===parent.id))fail('release already selected by another allocation');
  }else if(receipt.freeAt!==null||receipt.freedBy!==null)fail('initial capacity has no causal release');
  return receipt;
}

export function selectCapacityAllocation({job,journal,events,journals,evidence,now=()=>new Date().toISOString()}){
  const capacity=capacityIdentity({common:job.common,org:job.org,...evidence});
  const original=allocation(job,journal,events);
  if(job.capacityAllocation)return validateCapacityAllocation(job.capacityAllocation,{events,journals,capacity});
  const known=journals.map(j=>j.capacityAllocation).filter(r=>r&&same(r.capacity,capacity));
  const used=new Set(known.map(r=>r.slot)),parents=new Set(known.map(r=>r.predecessor?.id).filter(Boolean));
  // Choose the exact released token explicitly, rather than attributing a drop
  // in occupancy to a convenient prior completion timestamp.
  let parent,freed;
  for(const candidate of known.filter(r=>!parents.has(r.id)).sort((a,b)=>a.slot-b.slot)){
    try{validateCapacityAllocation(candidate,{events,journals,capacity});}catch{continue;}
    const fact=release(candidate,events);
    if(fact&&fact.freedBy.seq<original.started_seq){parent=candidate;freed=fact;break;}
  }
  const slot=parent?.slot??Array.from({length:capacity.cap},(_,i)=>i+1).find(n=>!used.has(n));
  if(!slot)fail('no proven reusable token; occupancy alone cannot supply lineage');
  const receipt={schema:'brain.capacity-allocation/v1',capacity,slot,allocation:original,selected_at:now(),
    predecessor:parent?{id:parent.id,journal:parent.allocation.journal}:null,freeAt:freed?.freeAt??null,freedBy:freed?.freedBy??null};
  return{id:hash(receipt),...receipt};
}
