// An explicit exact-change resolution never erases the original attempt.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const reviewDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function reviewPlain(file){const s=fs.lstatSync(file);if(!s.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error(`redirected review evidence: ${file}`);return fs.readFileSync(file);}
const callerTuple=a=>[a?.name,a?.cwd,a?.pane_id,a?.workspace_id,a?.terminal_id,a?.agent_session?.value];
export function reviewPredecessor({events,org,project,item,run,target,caller,id,decisionSeq,predecessor,attempts}){
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(predecessor??'')||predecessor===id)throw Error('invalid predecessor preparation');
  const intents=events.filter(e=>e.type==='review.recovery-intent'&&e.id===predecessor),old=intents[0];
  if(intents.length!==1||old.project!==project||old.item!==item||old.run!==run||JSON.stringify(old.target)!==JSON.stringify(target)||old.predecessor_preparation||JSON.stringify(callerTuple(old.native_caller))!==JSON.stringify(callerTuple(caller)))throw Error('predecessor source/native caller differs from this exact preparation');
  if(events.some(e=>e.type==='review.recovery-completed'&&(e.id===predecessor||e.item===item&&e.target?.head===target.head&&e.id!==id))||events.some(e=>e.type==='review.recovery-intent'&&e.predecessor_preparation?.id===predecessor&&e.id!==id))throw Error('predecessor replacement budget already completed or claimed by another preparation');
  const decision=events.find(e=>e.seq===old.decision_seq&&e.type==='note.added'&&e.decision&&e.by===caller.name&&[item,run].includes(e.id)&&e.text.includes(item)&&e.text.includes(target.head)&&e.text.includes(predecessor)),correction=events.find(e=>e.seq===decisionSeq&&e.type==='note.added'&&e.decision&&e.by===caller.name&&[item,run].includes(e.id)&&e.text.includes(item)&&e.text.includes(target.head)&&e.text.includes(predecessor)&&e.text.includes(id)&&e.text.includes(String(old.seq)));
  if(!decision||!correction||correction.seq<=old.seq)throw Error('predecessor needs its original authority and exact linked input-correction decision');
  const request={id:old.id,item,run,target,decision_seq:old.decision_seq,resolution_sha256:old.resolution_sha256,files:old.files,effects:old.effects};
  if(reviewDigest(JSON.stringify(request))!==old.request_sha256||old.effects?.length)throw Error('predecessor request/effects need their original outcome; no input-only correction');
  const file=path.join(org,'evidence/review-recovery',predecessor,'manifest.json'),bytes=reviewPlain(file),manifest=JSON.parse(bytes);
  if(manifest.id!==predecessor||manifest.item!==item||manifest.run!==run||manifest.request_sha256!==old.request_sha256||JSON.stringify(manifest.target)!==JSON.stringify(target)||manifest.files.length!==old.files.length)throw Error('predecessor archive manifest differs from its immutable intent');
  for(const row of manifest.files)if(!row.archive.startsWith(path.dirname(file)+path.sep)||reviewDigest(reviewPlain(row.archive))!==row.sha256||!old.files.some(f=>f.original===row.original&&f.sha256===row.sha256))throw Error('predecessor archived bytes changed');
  const inputFile=manifest.files.find(f=>f.sha256===old.resolution_sha256),input=inputFile&&JSON.parse(reviewPlain(inputFile.archive));
  if(!input||input.item!==item||input.run!==run||input.head!==target.head||input.base!==target.base||input.evidence!==target.evidence||input.inactive?.verified_by!==caller.name||!Array.isArray(input.attempts))throw Error('predecessor original input/source differs');
  const originals=attempts.map(a=>({original:a.original,sha256:a.sha256}));
  if(!originals.length||originals.some(f=>path.dirname(f.original)!==path.join(org,'settle')||!path.basename(f.original).startsWith(`${run}.`)))throw Error('predecessor correction needs exact original named settle paths, not archive copies');
  for(const original of input.attempts){const archived=manifest.files.find(f=>f.original===original);if(!archived||!originals.some(f=>f.sha256===archived.sha256))throw Error('predecessor original review evidence changed or is omitted');}
  return{id:predecessor,intent_seq:old.seq,decision_seq:old.decision_seq,request_sha256:old.request_sha256,archive:{file,sha256:reviewDigest(bytes)},inactive_kind:input.inactive.kind,original_attempts:originals};
}
export function reviewResolution({events,org,item,head}){
  const matches=events.filter(e=>e.type==='review.recovery-completed'&&e.item===item&&e.target?.head===head);
  if(!matches.length)return null;if(matches.length!==1)throw Error('review replacement budget is ambiguous; retain attempts');
  const e=matches[0],root=path.join(org,'evidence/review-recovery');
  if(!e.archive?.file?.startsWith(root+path.sep)||reviewDigest(reviewPlain(e.archive.file))!==e.archive.sha256)throw Error('review archive manifest changed; retain attempts');
  const manifest=JSON.parse(reviewPlain(e.archive.file));
  if(manifest.id!==e.id||manifest.item!==item||JSON.stringify(manifest.target)!==JSON.stringify(e.target))throw Error('review archive target changed');
  if(e.service_authority){
    const intent=events.find(i=>i.type==='review.recovery-intent'&&i.id===e.id&&i.project===e.project&&i.org===org&&i.request_sha256===manifest.request_sha256);
    if(e.by!=='line-service'||!intent||intent.by!=='line-service'||e.service_authority.kind!=='installed-service-progress'||e.service_authority.project!==e.project||e.service_authority.org!==org||JSON.stringify(intent.service_authority)!==JSON.stringify(e.service_authority)||JSON.stringify(intent.inactivity)!==JSON.stringify(e.inactivity)||JSON.stringify(manifest.inactivity)!==JSON.stringify(e.inactivity)||JSON.stringify(intent.target)!==JSON.stringify(e.target))throw Error('review resolution lost its actual installed-service progress authority');
  }else{
    const decision=events.find(d=>d.seq===e.decision_seq&&d.type==='note.added'&&d.decision&&d.by===e.native_caller?.name&&[item,e.run].includes(d.id));
    if(!decision||!decision.text.includes(item)||!decision.text.includes(head))throw Error('review resolution lost its scoped native supervisor decision');
  }
  const files=new Map();for(const f of manifest.files){if(!f.archive.startsWith(path.dirname(e.archive.file)+path.sep)||reviewDigest(reviewPlain(f.archive))!==f.sha256)throw Error('archived review bytes changed');files.set(f.original,f);}
  const authorized_decision_seqs=[e.decision_seq].filter(Number.isSafeInteger);
  if(e.predecessor_preparation){
    if(JSON.stringify(manifest.predecessor_preparation)!==JSON.stringify(e.predecessor_preparation))throw Error('predecessor archive lineage changed');
    const lineage=reviewPredecessor({events,org,project:e.project,item,run:e.run,target:e.target,caller:e.native_caller,id:e.id,decisionSeq:e.decision_seq,predecessor:e.predecessor_preparation.id,attempts:e.predecessor_preparation.original_attempts});
    if(JSON.stringify(lineage)!==JSON.stringify(e.predecessor_preparation)||lineage.original_attempts.some(a=>files.get(a.original)?.sha256!==a.sha256))throw Error('predecessor original-path correction lost its immutable archive binding');authorized_decision_seqs.push(lineage.decision_seq);
  }
  return{event:e,manifest,files,effects:manifest.effects??[],authorized_decision_seqs};
}
export function resolvedReviewJournal({events,org,journal}){
  for(const e of events)if(e.type==='review.recovery-completed'&&e.org===org&&e.inactivity?.original_journal===journal){
    const resolution=reviewResolution({events,org,item:e.item,head:e.target.head});return archivedReviewFile(resolution,journal);
  }
  return false;
}
export function originalPrestartProof({events,org,common,journal,job,requestHash}){
  const rows=events.filter(e=>e.type==='review.original-prestart'&&e.project===common&&e.org===org&&e.journal===journal&&e.review_item===job.item);
  for(const e of rows.reverse()){
    const linked=e.request_sha256===requestHash||job.preflightContinuations?.some(c=>c.original_prestart_seq===e.seq&&c.request_sha256===e.request_sha256);
    if(!linked)continue;
    if(e.by!=='line-service'||e.service_authority?.kind!=='installed-service-progress'||e.service_authority.project!==common||e.service_authority.org!==org||JSON.stringify(e.target)!==JSON.stringify(job.reviewQueue)||!e.archive?.file?.startsWith(path.join(org,'evidence/review-recovery')+path.sep)||reviewDigest(reviewPlain(e.archive.file))!==e.archive.sha256)throw Error('original prestart proof lost its service/source/archive authority');
    const manifest=JSON.parse(reviewPlain(e.archive.file));if(manifest.id!==e.id||manifest.request_sha256!==e.request_sha256||JSON.stringify(manifest.target)!==JSON.stringify(e.target))throw Error('original prestart archive scope changed');
    let original;
    for(const f of manifest.files){if(!f.archive.startsWith(path.dirname(e.archive.file)+path.sep)||reviewDigest(reviewPlain(f.archive))!==f.sha256)throw Error('original prestart archived bytes changed');if(f.original===journal){if(f.sha256!==e.request_sha256)throw Error('original prestart request SHA differs');original=JSON.parse(reviewPlain(f.archive));}}
    if(!original)throw Error('original prestart request bytes missing');
    for(const key of ['token','repo','org','common','item','lane','route','base','brief','release','reviewQueue','reviewQueueProtocol'])if(JSON.stringify(original[key])!==JSON.stringify(job[key]))throw Error('original request continuation changes immutable ownership/scope');
    return e;
  }
  return null;
}
export function archivedReviewFile(resolution,file){
  const entry=resolution?.files.get(path.resolve(file));if(!entry)return false;
  try{if(reviewDigest(reviewPlain(file))!==entry.sha256)throw Error('resolved original review evidence changed; retain new progress');}catch(e){if(e.code!=='ENOENT')throw e;}
  return true;
}
