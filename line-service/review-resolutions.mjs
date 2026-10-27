// An explicit exact-change resolution never erases the original attempt.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const reviewDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function reviewPlain(file){const s=fs.lstatSync(file);if(!s.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error(`redirected review evidence: ${file}`);return fs.readFileSync(file);}
export function reviewResolution({events,org,item,head}){
  const matches=events.filter(e=>e.type==='review.recovery-completed'&&e.item===item&&e.target?.head===head);
  if(!matches.length)return null;if(matches.length!==1)throw Error('review replacement budget is ambiguous; retain attempts');
  const e=matches[0],root=path.join(org,'evidence/review-recovery');
  if(!e.archive?.file?.startsWith(root+path.sep)||reviewDigest(reviewPlain(e.archive.file))!==e.archive.sha256)throw Error('review archive manifest changed; retain attempts');
  const manifest=JSON.parse(reviewPlain(e.archive.file));
  if(manifest.id!==e.id||manifest.item!==item||JSON.stringify(manifest.target)!==JSON.stringify(e.target))throw Error('review archive target changed');
  const decision=events.find(d=>d.seq===e.decision_seq&&d.type==='note.added'&&d.decision&&d.by===e.native_caller?.name);
  if(!decision||!decision.text.includes(item)||!decision.text.includes(head))throw Error('review resolution lost its scoped native supervisor decision');
  const files=new Map();for(const f of manifest.files){if(!f.archive.startsWith(path.dirname(e.archive.file)+path.sep)||reviewDigest(reviewPlain(f.archive))!==f.sha256)throw Error('archived review bytes changed');files.set(f.original,f);}
  return{event:e,manifest,files,effects:manifest.effects??[]};
}
export function archivedReviewFile(resolution,file){
  const entry=resolution?.files.get(path.resolve(file));if(!entry)return false;
  try{if(reviewDigest(reviewPlain(file))!==entry.sha256)throw Error('resolved original review evidence changed; retain new progress');}catch(e){if(e.code!=='ENOENT')throw e;}
  return true;
}
