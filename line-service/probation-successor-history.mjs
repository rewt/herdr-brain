// Append-only successor history. Frozen recovery readers see only the original
// legacy anchor, plus deliberate extra-file fences until a recorded rollback.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPlainFile,plainDirectory} from '../lib/files.mjs';
import {canonical} from '../messages/schema.mjs';

export const successorDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const successorJSON=v=>JSON.stringify(v)+'\n';
const same=(a,b)=>canonical(a)===canonical(b),valid=id=>/^[-a-zA-Z0-9_]{1,80}$/.test(id??'');
export const successorRows=(events,c)=>events.filter(e=>e.type==='line-service.probation-successor-switched'&&e.project===c.identity&&e.org===c.org);
export const successorFence=(c,id)=>path.join(c.directory,'probation-switches',`.successor-${id}`);
export const successorFenceBytes=a=>successorJSON({schema:'brain-probation-successor-fence/v1',trial:a.trial,id:a.id,archive:a.archive,extension:a.extension});
function archive(ref,file){
  if(ref?.file!==file)throw Error('successor archive binding differs');
  const bytes=readPlainFile(file);
  if(successorDigest(bytes)!==ref.sha256||(fs.statSync(file).mode&0o222))throw Error('successor archive changed/mutable');
  return JSON.parse(bytes);
}
function inventory(folder,names){
  if(fs.existsSync(folder)){
    plainDirectory(folder,{create:false});
    if(!same(fs.readdirSync(folder).sort(),names.sort()))throw Error('existing/UNKNOWN probation successor retained; no replay or replacement');
  }else if(names.length)throw Error('successor archive missing');
}
export const successorExtensionFile=(c,trial,id,first=false)=>path.join(c.directory,'probation-successors',first?trial+'.json':`${trial}--${id}.json`);
export function successorExtensions(events,c,original){
  const rows=events.filter(e=>e.type==='line-service.probation-successor-authorized'&&e.project===c.identity&&e.org===c.org);
  inventory(path.join(c.directory,'probation-successors'),rows.map((e,i)=>path.basename(successorExtensionFile(c,e.trial,e.id,i===0))));
  const ids=new Set(),roots=new Set();let seq=original.seq;
  return rows.map((event,i)=>{
    if(!valid(event.id)||ids.has(event.id)||event.trial!==original.id||event.repo!==c.repo||event.seq<=seq)
      throw Error('successor authority ambiguous; one original trial and unique extensions only');
    const scope=archive(event.archive,successorExtensionFile(c,original.id,event.id,i===0));
    const note=events.find(e=>e.seq===event.authority),originalNote=events.find(e=>e.seq===original.authority);
    const first=events.find(e=>e.seq===event.seq+1);
    if(scope.schema!=='brain-probation-successor/v1'||scope.trial!==original.id||scope.repo!==c.repo||scope.org!==c.org||scope.identity!==c.identity||
        scope.original.seq!==original.seq||!same(scope.original.archive,original.archive)||scope.original.scope_sha256!==successorDigest(canonical(original.scope))||
        scope.original.recovery_sha256!==successorDigest(canonical(original.scope.previous))||!same(scope.candidate,event.candidate)||
        !path.isAbsolute(scope.candidate?.release?.root??'')||roots.has(scope.candidate.release.root)||
        [original.scope.candidate.release.root,original.scope.previous.release.root].includes(scope.candidate.release.root)||
        scope.owner.native.name!==original.owner.native.name||!same(scope.owner.native,event.native_caller)||
        event.by!==scope.owner.native.name||note?.type!=='note.added'||note.decision!==true||note.seq>=event.seq||note.by!==scope.owner.native.name||note.id!==originalNote?.id||
        note.text!==`Brain probation successor authorized: ${event.id} ${event.plan_sha256}`)
      throw Error('successor original scope/recovery/authority changed');
    if(first?.type!=='line-service.probation-successor-switched'||first.project!==c.identity||first.org!==c.org||first.trial!==original.id||
        first.id!==event.id||first.rollback!==false||first.authority!==event.authority||first.archive?.sha256!==event.plan_sha256)
      throw Error('successor extension lacks its first exact authorizing entry');
    ids.add(event.id);roots.add(scope.candidate.release.root);seq=event.seq;
    return{event,scope};
  });
}

export function successorHistory(events,c,{trial,scope,saved,savedBytes,plist,last}){
  const original=events.find(e=>e.seq===trial.seq),extensions=successorExtensions(events,c,original),rows=successorRows(events,c);
  inventory(path.join(c.directory,'probation-successor-effects'),rows.map(e=>e.id+'.json'));
  const clears=rows.filter(e=>e.rollback);
  inventory(path.join(c.directory,'probation-successor-clears'),clears.map(e=>e.id+'.json'));
  if(rows.length&&!extensions.length)throw Error('successor effect lacks original authority');
  const anchor={installation:savedBytes,plist,last};
  const legacyIds=new Set(events.filter(e=>e.type==='line-service.probation-switched'&&e.project===c.identity&&e.org===c.org).map(e=>e.id));
  const expectedFences=new Map(),ids=new Set(),used=new Set();let installed=null;
  for(const event of rows){
    const a=archive(event.archive,path.join(c.directory,'probation-successor-effects',event.id+'.json'));
    const extension=extensions.find(e=>same(e.event.archive,a.extension));
    if(!extension)throw Error('successor effect lacks exact extension authority');
    const note=events.find(e=>e.seq===event.authority),originalNote=events.find(e=>e.seq===original.authority);
    const target=event.rollback?scope.previous.release:extension.scope.candidate.release;
    if(!valid(event.id)||ids.has(event.id)||legacyIds.has(event.id)||event.trial!==trial.id||event.repo!==c.repo||event.previous_seq!==last.seq||event.seq<=last.seq||
        a.schema!=='brain-probation-successor-effect/v1'||a.id!==event.id||a.trial!==trial.id||a.repo!==c.repo||a.org!==c.org||a.identity!==c.identity||
        !same(a.extension,extension.event.archive)||!same(a.successor_scope,extension.scope)||a.previous_seq!==last.seq||
        a.scope_sha256!==trial.scope_sha256||a.recovery_sha256!==successorDigest(canonical(scope.previous))||
        a.previous_source!==saved.source||event.previous_source!==saved.source||a.source!==target.root||event.source!==target.root||
        typeof event.rollback!=='boolean'||a.rollback!==event.rollback||!same(a.runtime,target)||!same(event.runtime,target)||a.before.installation!==savedBytes||a.before.plist!==plist||
        !same(a.owner.native,event.native_caller)||a.owner.native.name!==original.owner.native.name||
        event.by!==a.owner.native.name||note?.type!=='note.added'||note.decision!==true||note.seq>=event.seq||note.id!==originalNote?.id||note.by!==a.owner.native.name||
        note.text!==`Brain probation successor authorized: ${event.id} ${event.archive.sha256}`)
      throw Error('successor effect history/authority changed');
    if(!used.has(extension.event.seq)&&(event.rollback||saved.source!==scope.previous.release.root||
        extension.event.seq<=last.seq||extension.event.seq>=event.seq||expectedFences.size||
        extension.event.id!==event.id||extension.event.plan_sha256!==event.archive.sha256||extension.event.authority!==event.authority))
      throw Error('successor requires the original completed recovery anchor');
    if(!ids.size&&last.type!=='line-service.probation-switched')throw Error('successor requires completed legacy recovery anchor');
    if(event.rollback?installed!==extension:installed!==null||expectedFences.size)
      throw Error('successor rollback/entry must name the installed extension and cleared recovery');
    used.add(extension.event.seq);
    ids.add(event.id);
    const base=JSON.parse(anchor.installation);
    const after=event.rollback?base:{...base,source:target.root,runtime:target};
    if(a.after.installation!==successorJSON(after)||event.rollback&&a.after.plist!==anchor.plist||
        (event.rollback?saved.source!==extension.scope.candidate.release.root:saved.source!==scope.previous.release.root))
      throw Error('successor direction/installation differs');
    saved=event.rollback?after:{...after,probation_successor:{trial:trial.id,id:event.id,...event.archive,extension:event.archive&&a.extension}};
    savedBytes=successorJSON(saved);plist=a.after.plist;last=event;
    installed=event.rollback?null:extension;
    expectedFences.set(event.id,successorFenceBytes({...a,archive:event.archive}));
    if(event.rollback){
      const clearFile=path.join(c.directory,'probation-successor-clears',event.id+'.json'),bytes=readPlainFile(clearFile);
      const clear=JSON.parse(bytes);
      if((fs.statSync(clearFile).mode&0o222)||!same(clear,{schema:'brain-probation-successor-clear/v1',trial:trial.id,id:event.id,
        completion_seq:event.seq,archive:event.archive,fences:Object.fromEntries(expectedFences)}))throw Error('successor rollback clear receipt changed');
      expectedFences.clear();
    }
  }
  if(used.size!==extensions.length)throw Error('successor extension lacks completed entry');
  const folder=path.join(c.directory,'probation-switches');
  const actual=fs.existsSync(folder)?fs.readdirSync(folder).filter(n=>n.startsWith('.successor-')).sort():[];
  if(!same(actual,[...expectedFences.keys()].map(id=>`.successor-${id}`).sort()))throw Error('incomplete/UNKNOWN successor compatibility fence retained');
  for(const [id,bytes]of expectedFences)if(readPlainFile(successorFence(c,id))!==bytes||(fs.statSync(successorFence(c,id)).mode&0o222))throw Error('successor compatibility fence changed/mutable');
  return{installation:saved,installationBytes:savedBytes,plist,last,anchor,extensions,installed,fences:expectedFences};
}
