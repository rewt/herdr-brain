// Evidence for the existing report-released logical admission pool. Selection
// runs only under the dispatch session-cap lock; it never grants admission.
import {createHash} from 'node:crypto';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=reason=>{throw Error(`capacity lineage: ${reason}`);};
const stamp=n=>Number.isSafeInteger(n)&&n>0;
const ms=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const payload=receipt=>Object.fromEntries(Object.entries(receipt).filter(([k])=>k!=='id'));
export const capacityIdentity=({common,org,kind,cap,build_cap,review_cap,decision_cap,shared_cap=null})=>({project:common,org,pool:kind,cap,
  build_cap,review_cap,decision_cap,shared_cap,
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

const fence=receipt=>receipt.admission_seq??receipt.allocation.started_seq-1;
function abandoned(receipt,events){
  const e=events.find(e=>e.type==='run.abandoned'&&(e.id??e.run)===receipt.allocation.run&&e.seq>receipt.allocation.claim_generation);
  return e?{type:e.type,seq:e.seq,run:receipt.allocation.run}:null;
}
const consumed=r=>r.predecessor??r.reset_after;

function validateOriginal(receipt,{events,journals,capacity}){
  if(!receipt||receipt.schema!=='brain.capacity-allocation/v1'||receipt.id!==hash(payload(receipt)))fail('missing or changed receipt');
  if(!same(receipt.capacity,capacity)||!stamp(receipt.slot)||receipt.slot>capacity.cap||!['build','review','decision'].includes(capacity.pool))fail('mismatched capacity');
  const job=journals.find(j=>j.journal===receipt.allocation?.journal);
  if(!job||!same(job.capacityAllocation,receipt)||!same(allocation(job,job.journal,events),receipt.allocation))fail('wrong generation or disconnected allocation');
  const start=events.find(e=>e.seq===receipt.allocation.started_seq);
  if(ms(receipt.selected_at)===null||ms(start.at)===null||ms(receipt.selected_at)<ms(start.at))fail('selection predates original allocation');
  if(receipt.admission_seq!==undefined&&(!stamp(receipt.admission_seq)||receipt.admission_seq<receipt.allocation.claim_generation||
      !events.some(e=>e.seq===receipt.admission_seq)))fail('missing admission fence');
  return receipt;
}
// Full capture validation walks report predecessors. Admission only checks the
// head's immediate link, keeping its work independent of historical chain depth.
function validateLink(receipt,context,walk,seen=new Set()){
  const {events,journals,capacity}=context;
  validateOriginal(receipt,context);
  if(seen.has(receipt.id))fail('disconnected or cyclic allocation');seen.add(receipt.id);
  if(receipt.predecessor){
    if(receipt.reset_after)fail('reset cannot claim a report predecessor');
    const parent=journals.find(j=>j.journal===receipt.predecessor.journal)?.capacityAllocation;
    if(!parent||parent.id!==receipt.predecessor.id||parent.slot!==receipt.slot)fail('disconnected predecessor');
    if(walk)validateLink(parent,context,true,seen);else validateOriginal(parent,context);
    const freed=release(parent,events);
    if(!freed||!same(freed,{freeAt:receipt.freeAt,freedBy:receipt.freedBy})||
        receipt.freedBy.seq>fence(receipt)||ms(receipt.freeAt)>ms(receipt.selected_at))fail('missing or disconnected release');
  }else if(receipt.freeAt!==null||receipt.freedBy!==null)fail('initial capacity has no causal release');
  if(receipt.reset_after){
    const reset=receipt.reset_after,parent=journals.find(j=>j.journal===reset.journal)?.capacityAllocation;
    if(!parent||parent.id!==reset.id||parent.slot!==receipt.slot)fail('disconnected reset');
    // A new chain does not claim report causality through the abandoned chain.
    validateOriginal(parent,context);
    const source=abandoned(parent,events);
    if(!source||!same(source,reset.source)||source.seq>fence(receipt)||
        release(parent,events)?.freedBy.seq<=source.seq)fail('missing or disconnected abandonment');
  }
  const previous=consumed(receipt);
  if(previous&&journals.some(j=>j.capacityAllocation?.id!==receipt.id&&consumed(j.capacityAllocation??{})?.id===previous.id))
    fail('release already selected by another allocation');
  return receipt;
}

// Hashes detect changed transport bytes; original start/claim/report joins and
// explicit reset sources remain authoritative.
export function validateCapacityAllocation(receipt,context){return validateLink(receipt,context,true);}

export function selectCapacityAllocation({job,journal,events,journals,evidence,now=()=>new Date().toISOString()}){
  const capacity=capacityIdentity({common:job.common,org:job.org,...evidence});
  const original=allocation(job,journal,events);
  if(job.capacityAllocation)return validateLink(job.capacityAllocation,{events,journals,capacity},false);
  const known=journals.map(j=>j.capacityAllocation).filter(r=>r&&same(r.capacity,capacity));
  const used=new Set(known.map(r=>r.slot)),parents=new Set(known.map(r=>consumed(r)?.id).filter(Boolean));
  const admission_seq=events.at(-1)?.seq,selected_at=now();
  // Choose the exact released token explicitly, rather than attributing a drop
  // in occupancy to a convenient prior completion timestamp.
  let parent,freed,reset;
  for(const candidate of known.filter(r=>!parents.has(r.id)).sort((a,b)=>a.slot-b.slot)){
    try{validateLink(candidate,{events,journals,capacity},false);}catch{continue;}
    const fact=release(candidate,events);
    if(fact&&fact.freedBy.seq<=admission_seq&&ms(fact.freeAt)<=ms(selected_at)){parent=candidate;freed=fact;break;}
    const source=abandoned(candidate,events);
    if(source&&source.seq<=admission_seq){reset={id:candidate.id,journal:candidate.allocation.journal,source};break;}
  }
  const slot=parent?.slot??known.find(r=>r.id===reset?.id)?.slot??Array.from({length:capacity.cap},(_,i)=>i+1).find(n=>!used.has(n));
  if(!slot)fail('no proven reusable token; occupancy alone cannot supply lineage');
  const receipt={schema:'brain.capacity-allocation/v1',capacity,slot,allocation:original,admission_seq,selected_at,reset_after:reset??null,
    predecessor:parent?{id:parent.id,journal:parent.allocation.journal}:null,freeAt:freed?.freeAt??null,freedBy:freed?.freedBy??null};
  return{id:hash(receipt),...receipt};
}
