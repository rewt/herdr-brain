// Immutable supplemental/canonical captures use the ordinary record queue.
// Historical attribution and current review responsibility are separate facts.
import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {capturedReviewCommits,sameProducerQueue} from './review-group.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export const additionalTarget=t=>['supplemental-review/v1','canonical-unattributed/v1'].includes(t?.evidence_kind);
export const canonicalSelector=head=>`canonical:${head}`;
export const reviewCutoff=boundary=>({id:boundary.id,seq:boundary.seq,head:boundary.canonical_head,main:boundary.main??'main',time_qualification:boundary.time_qualification??'intended source boundary; exact adoption-time head UNKNOWN'});

export function capturedRange({repo,target}){
  const owned=capturedReviewCommits(target);
  if(!target?.base||!target.head||!owned.length||target.scope?.unresolved?.length||target.scope?.deferred)throw Error('retained review scope is UNKNOWN');
  git(repo,['merge-base','--is-ancestor',target.base,target.head]);
  const range=git(repo,['rev-list','--reverse',`${target.base}..${target.head}`]).split('\n').filter(Boolean);
  if(!same(range,target.scope?.commits)||!owned.includes(target.head)||owned.some(h=>!range.includes(h))||hash(git(repo,['diff','--no-ext-diff','--no-textconv',target.base,target.head]))!==target.diff_sha256)throw Error('retained review range/diff is UNKNOWN or changed');
  return owned;
}
export function captureEvidence(target){
  const file=target?.evidence,stat=file&&fs.lstatSync(file);
  if(!stat?.isFile()||fs.realpathSync(file)!==file||hash(fs.readFileSync(file))!==target.reportHash)throw Error('immutable captured review evidence changed');
  if(additionalTarget(target)){
    const d=target.landed_evidence;
    if(!d||hash(JSON.stringify(d,null,2)+'\n')!==target.reportHash||d.schema!==target.evidence_kind||d.head!==target.head||d.base!==target.base||!same(d.owned_commits,capturedReviewCommits(target))||target.evidence!==path.join(d.org,'evidence','review-targets',`source-${target.reportHash}.json`))throw Error('additional evidence/target binding changed');
  }
}
function capture({repo,org,identity,boundary,heads,document,dispatch=null}){
  const head=heads.at(-1),base=git(repo,['rev-parse',`${heads[0]}^1`]),range=git(repo,['rev-list','--reverse',`${base}..${head}`]).split('\n').filter(Boolean);
  const evidenceDocument={...document,project:identity,org,boundary:reviewCutoff(boundary),base,head,owned_commits:heads,validation:'No test, verdict or final-release PASS inferred from canonical containment.'};
  const reportHash=hash(JSON.stringify(evidenceDocument,null,2)+'\n'),evidence=path.join(org,'evidence','review-targets',`source-${reportHash}.json`),key=`${document.schema}:${reportHash}`;
  return{head,base,reportHash,evidence,evidence_kind:document.schema,landed_evidence:evidenceDocument,diff_sha256:hash(git(repo,['diff','--no-ext-diff','--no-textconv',base,head])),dispatch,
    scope:{base,commits:range,claims:heads,unresolved:[],deferred:false},source_group:{key,run:document.producer?.run??null,report_sha256:null,evidence_sha256:reportHash,owned_commits:heads}};
}
export function supplementalTarget({events,state,repo,org,identity,index,item,run,queues}){
  if(!queues.length)return null;
  const covered=new Set(),prior=[];
  for(const q of queues){
    if(q.meta.review_round_cap!==1)throw Error('retained producer capture has UNKNOWN cap');
    const owned=capturedRange({repo,target:q.meta.review_target});captureEvidence(q.meta.review_target);
    if(owned.some(h=>covered.has(h)))throw Error('overlapping/UNKNOWN producer captures retained');
    for(const h of owned)covered.add(h);
    prior.push({item:q.id,target_sha256:hash(JSON.stringify(q.meta.review_target)),head:q.meta.review_target.head,owned_commits:owned});
  }
  const rows=index.entries.filter(e=>e.item===item.id&&e.run===run.id&&!e.exemption&&!covered.has(e.head));
  const later=rows.filter(e=>prior.every(p=>{try{git(repo,['merge-base','--is-ancestor',p.head,e.head]);return p.head!==e.head;}catch{return false;}}));
  if(!later.length)return null;
  const order=git(repo,['rev-list','--reverse',`${index.boundary.canonical_head}..${index.tip}`]).split('\n'),heads=order.filter(h=>later.some(e=>e.head===h));
  const provenance=heads.map(head=>{
    const landings=events.filter(e=>e.type==='change.landed'&&e.project===identity&&e.item===item.id&&e.run===run.id&&e.head===head);
    if(landings.length)return{head,landings};
    const report=events.findLast(e=>e.type==='report.ingested'&&e.run===run.id&&e.sha256===run.report?.sha256);
    if(!report)throw Error('later source attribution is UNKNOWN');
    const file=path.resolve(org,run.report.file??'');if(!file.startsWith(path.resolve(org)+path.sep)||hash(fs.readFileSync(file))!==run.report.sha256)throw Error('later producer report bytes changed');
    return{head,report:{seq:report.seq,sha256:report.sha256,file}};
  });
  return capture({repo,org,identity,boundary:index.boundary,heads,dispatch:queues[0].meta.review_target.dispatch,document:{schema:'supplemental-review/v1',producer:{item:item.id,run:run.id},prior,provenance}});
}
export function canonicalTarget({repo,org,identity,index,head}){
  const row=index.entries.find(e=>e.head===head);
  if(!row||row.item||row.run||row.attribution!=='missing')throw Error('canonical target is not an unattributed post-boundary commit; preserve ambiguous ownership');
  return capture({repo,org,identity,boundary:index.boundary,heads:[head],document:{schema:'canonical-unattributed/v1',historical_producer:{item:null,run:null,owner:null,attribution:'missing'},responsibility:'Assigned now to the ordinary reviewer record; no historical producer or native identity inferred.'}});
}
export function validateAdditionalTarget({repo,org,identity,index,state,events,target}){
  if(!additionalTarget(target))throw Error('not an additional immutable review target');
  capturedRange({repo,target});captureEvidence(target);
  const d=target.landed_evidence,heads=capturedReviewCommits(target);
  if(!d||d.schema!==target.evidence_kind||d.project!==identity||d.org!==org||!same(d.boundary,reviewCutoff(index.boundary))||d.base!==target.base||d.head!==target.head||!same(d.owned_commits,heads)||hash(JSON.stringify(d,null,2)+'\n')!==target.reportHash||heads.some(h=>!index.heads.includes(h)))throw Error('additional captured source/provenance changed');
  if(d.schema==='canonical-unattributed/v1'){
    if(!same(canonicalTarget({repo,org,identity,index,head:target.head}),target))throw Error('canonical unattributed provenance changed');
  }else{
    const producer=d.producer;
    if(!state.runs.has(producer?.run)||state.runs.get(producer.run).item!==producer.item||heads.some(h=>!index.entries.some(e=>e.head===h&&e.item===producer.item&&e.run===producer.run)))throw Error('supplemental producer attribution changed');
    const covered=new Set();
    for(const p of d.prior??[]){const q=state.items.get(p.item);if(!q||!sameProducerQueue(q,producer.item,producer.run)||hash(JSON.stringify(q.meta.review_target))!==p.target_sha256||!same(capturedRange({repo,target:q.meta.review_target}),p.owned_commits))throw Error('prior immutable capture changed/UNKNOWN');captureEvidence(q.meta.review_target);for(const h of p.owned_commits)covered.add(h);for(const h of heads)git(repo,['merge-base','--is-ancestor',p.head,h]);}
    if(!d.prior?.length||heads.some(h=>covered.has(h)))throw Error('supplemental capture overlaps prior source');
    for(const p of d.provenance??[])if(p.landings){if(p.landings.some(row=>!events.some(e=>e.seq===row.seq&&same(e,row))))throw Error('supplemental landing provenance changed');}else if(!events.some(e=>e.seq===p.report?.seq&&e.type==='report.ingested'&&e.run===producer.run&&e.sha256===p.report.sha256)||hash(fs.readFileSync(p.report.file))!==p.report.sha256)throw Error('supplemental report provenance changed');
    if(!same(d.provenance?.map(p=>p.head),heads))throw Error('supplemental attribution provenance incomplete');
  }
  return target;
}

// Only new, explicitly partitioned captures may coexist with older targets.
// Unknown inventory remains a refusal; disjointness is proved from exact ranges.
export function disjointCapture({repo,target,peer}){
  if(!additionalTarget(target)&&!additionalTarget(peer))return false;
  const ours=capturedRange({repo,target}),theirs=capturedRange({repo,target:peer});captureEvidence(peer);
  return !ours.some(h=>theirs.includes(h));
}
