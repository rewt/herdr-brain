// Lossless pass-journal rotation. Offsets always address the concatenation of
// retired bytes and the live file, including during an interrupted rotation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {writeFileAtomic} from '../lib/files.mjs';

export const PASS_JOURNAL_LIMIT = 16 * 1024 * 1024;
const BLOCK = 1024 * 1024;
const deployedAt=fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;
function legacyOwner(file){
  // A pre-upgrade scheduling owner still writes physical offsets. Let its
  // finite turn drain; changing its checkpoint underneath it is unsafe.
  for(const name of ['general-0.lock','general-1.lock','pass.lock','closeout-turn.lock','closeout-measurement.lock']){
    const owner=path.join(path.dirname(file),name,'owner.json');
    if(fs.existsSync(owner)){
      let value;try{value=JSON.parse(fs.readFileSync(owner,'utf8'));}catch{return true;}
      if(!Number.isFinite(Date.parse(value.at))||Date.parse(value.at)<deployedAt){
        if(Number.isSafeInteger(value.pid)&&value.pid>0){try{process.kill(value.pid,0);}catch(error){if(error.code==='ESRCH')continue;}}
        return true;
      }
    }
  }
  return false;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = file => file + '.segments';
const indexFile = file => path.join(archive(file),'index.json');
const syncDir = dir => {const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
function open(file,flags=fs.constants.O_RDONLY){
  const fd=fs.openSync(file,flags|fs.constants.O_NOFOLLOW,0o600);
  if(!fs.fstatSync(fd).isFile()){fs.closeSync(fd);throw Error('pass journal is not a regular file');}
  return fd;
}
function stat(file){
  const s=fs.lstatSync(file,{throwIfNoEntry:false});
  if(s&&(!s.isFile()||fs.realpathSync(file)!==file))throw Error('pass journal is redirected');
  return s;
}
function readIndex(file){
  const dir=archive(file);
  if(!fs.existsSync(dir))return {schema:'line-pass-journal/v1',segments:[],pending:null};
  if(!fs.lstatSync(dir).isDirectory()||fs.realpathSync(dir)!==dir)throw Error('pass archive is redirected');
  const target=indexFile(file);if(!stat(target))return {schema:'line-pass-journal/v1',segments:[],pending:null};
  const fd=open(target);let index;try{index=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
  if(index.schema!=='line-pass-journal/v1'||!Array.isArray(index.segments))throw Error('invalid pass journal index');
  let end=0;
  for(const s of [...index.segments,...(index.pending?[index.pending]:[])]){
    if(s.start!==end||!Number.isSafeInteger(s.end)||s.end<=s.start||!/^\d{4}-\d\d-\d\dT[\d-]+Z-\d+$/.test(s.name))throw Error('pass journal index range is inconsistent');
    end=s.end;
  }
  return index;
}
function saveIndex(file,index){
  fs.mkdirSync(archive(file),{recursive:true,mode:0o700});
  writeFileAtomic(indexFile(file),JSON.stringify(index)+'\n',0o600);syncDir(archive(file));syncDir(path.dirname(file));
}
function tail(fd,size){
  if(!size)return;
  const b=Buffer.alloc(1);if(fs.readSync(fd,b,0,1,size-1)!==1||b[0]!==10)throw Error('incomplete pass journal tail; preserve original bytes');
}
function exact(fd,start,length){
  const bytes=Buffer.alloc(length);let n=0;
  while(n<length){const got=fs.readSync(fd,bytes,n,length-n,start+n);if(!got)throw Error('pass journal changed during read');n+=got;}
  return bytes;
}
function withLock(file,operation){
  // All production appenders and snapshots share this lock. Never reuse an FD
  // opened before acquiring it: rename must not strand a concurrent append.
  const release=noticeLock(file+'.lock',{waitMs:30000});
  try{return operation();}finally{release();}
}
function finishRotation(file,index,fault=()=>{}){
  const p=index.pending;if(!p)return null;
  const raw=path.join(archive(file),p.name+'.jsonl'),gzip=path.join(archive(file),p.name+'.jsonl.gz');
  if(!stat(raw)){
    const live=stat(file);
    if(!live||live.dev!==p.dev||live.ino!==p.ino||live.size!==p.end-p.start)throw Error('pending pass rotation source changed');
    fs.renameSync(file,raw);syncDir(archive(file));syncDir(path.dirname(file));
  }
  const retired=stat(raw);if(retired.dev!==p.dev||retired.ino!==p.ino||retired.size!==p.end-p.start)throw Error('pending pass segment source changed');
  const fd=open(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(file));
  fault('renamed');
  const source=open(raw),temporary=gzip+'.'+randomUUID()+'.tmp',out=open(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL);
  const members=[],hash=createHash('sha256');let compressed=0;
  try{
    const original=fs.fstatSync(source),size=original.size;if(size!==p.end-p.start)throw Error('retired pass journal size changed');tail(source,size);
    for(let at=0;at<size;at+=BLOCK){
      const bytes=exact(source,at,Math.min(BLOCK,size-at)),packed=gzipSync(bytes);hash.update(bytes);
      fs.writeFileSync(out,packed);members.push({start:at,bytes:bytes.length,offset:compressed,compressed:packed.length,sha256:sha(bytes)});compressed+=packed.length;
    }
    const final=fs.fstatSync(source);if(final.size!==original.size||final.mtimeMs!==original.mtimeMs)throw Error('retired pass journal changed during compression; preserve it');
    fs.fsyncSync(out);
  }finally{fs.closeSync(source);fs.closeSync(out);}
  // An interrupted compressor's old files are retained, never used as proof.
  // Only the fully fsynced temporary becomes this segment's indexed gzip.
  fs.renameSync(temporary,gzip);syncDir(archive(file));fault('compressed');
  const segment={...p,members,compressed_bytes:compressed,sha256:hash.digest('hex')};
  index.segments.push(segment);index.pending=null;saveIndex(file,index);fault('indexed');
  fs.unlinkSync(raw);syncDir(archive(file));
  return segment;
}
function rotateLocked(file,{maxBytes=PASS_JOURNAL_LIMIT,now=new Date().toISOString(),fault}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('invalid pass journal limit');
  const index=readIndex(file),recovered=finishRotation(file,index,fault),live=stat(file);
  const last=index.segments.at(-1);
  if(last){
    const raw=path.join(archive(file),last.name+'.jsonl'),saved=stat(raw);
    if(saved){
      if(saved.dev!==last.dev||saved.ino!==last.ino||saved.size!==last.end-last.start)throw Error('indexed raw segment changed; preserve it');
      const part=snapshot(file).parts.find(p=>p.start===last.start),hash=createHash('sha256');
      for(const bytes of chunks(part,last.start))hash.update(bytes);
      if(hash.digest('hex')!==last.sha256)throw Error('indexed pass segment hash changed; preserve raw bytes');
      fs.unlinkSync(raw);syncDir(archive(file));
    }
  }
  if(!index.segments.length&&!index.pending&&legacyOwner(file))return {rotated:false,deferred:'pre-upgrade finite journal owner'};
  if(!live||live.size<maxBytes)return {rotated:Boolean(recovered),recovered:Boolean(recovered),segment:recovered};
  const fd=open(file);try{tail(fd,live.size);}finally{fs.closeSync(fd);}
  const start=index.segments.at(-1)?.end??0;
  const date=new Date(now).toISOString().replace(/[:.]/g,'-');
  index.pending={start,end:start+live.size,name:date+'-'+start,at:now,dev:live.dev,ino:live.ino};
  saveIndex(file,index);fault?.('intent');
  return {rotated:true,recovered:Boolean(recovered),segment:finishRotation(file,index,fault)};
}
export function rotatePassJournal(file,options){return withLock(file,()=>rotateLocked(file,options));}
export function appendPassJournal(file,row){
  return withLock(file,()=>{
    const rotation=rotateLocked(file);
    const fd=open(file,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_APPEND);
    try{tail(fd,fs.fstatSync(fd).size);fs.writeFileSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return rotation;
  });
}
function snapshot(file){
  const index=readIndex(file),parts=[];let end=0;
  for(const s of index.segments){
    const f=path.join(archive(file),s.name+'.jsonl.gz'),size=stat(f)?.size;
    if(size!==s.compressed_bytes||!Array.isArray(s.members))throw Error('pass segment is missing or changed');
    let at=0,packed=0;
    for(const m of s.members){if(m.start!==at||m.offset!==packed||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>BLOCK||!Number.isSafeInteger(m.compressed)||m.compressed<1||m.compressed>2*BLOCK)throw Error('invalid pass segment member');at+=m.bytes;packed+=m.compressed;}
    if(at!==s.end-s.start||packed!==size)throw Error('pass segment index size changed');
    parts.push({...s,file:f});end=s.end;
  }
  if(index.pending){
    const p=index.pending,raw=path.join(archive(file),p.name+'.jsonl'),s=stat(raw);
    if(s){if(s.dev!==p.dev||s.ino!==p.ino||s.size!==p.end-p.start)throw Error('pending pass segment size changed');parts.push({...p,file:raw});end=p.end;}
    else {const live=stat(file);if(!live||live.dev!==p.dev||live.ino!==p.ino||live.size!==p.end-p.start)throw Error('pending pass rotation source changed');}
  }
  const live=stat(file);if(live)parts.push({start:end,end:end+live.size,file});
  return {parts,size:end+(live?.size??0)};
}
function* chunks(part,offset){
  const fd=open(part.file);
  try{
    if(part.members){for(const m of part.members){
      if(part.start+m.start+m.bytes<=offset)continue;
      const bytes=gunzipSync(exact(fd,m.offset,m.compressed),{maxOutputLength:BLOCK});
      if(bytes.length!==m.bytes||sha(bytes)!==m.sha256)throw Error('pass segment member hash changed');
      yield bytes.subarray(Math.max(0,offset-part.start-m.start));
    }}else{
      tail(fd,part.end-part.start);
      for(let at=Math.max(0,offset-part.start);at<part.end-part.start;at+=BLOCK)yield exact(fd,at,Math.min(BLOCK,part.end-part.start-at));
    }
  }finally{fs.closeSync(fd);}
}
function* rows(view,offset){
  if(!Number.isSafeInteger(offset)||offset<0||offset>view.size)throw Error('notice audit checkpoint is inconsistent');
  let pending=Buffer.alloc(0),boundary=offset>0;
  for(const part of view.parts){if(part.end<=offset-(boundary?1:0))continue;
    for(let bytes of chunks(part,offset-(boundary?1:0))){
      if(boundary){if(bytes[0]!==10)throw Error('notice audit checkpoint is not a row boundary');bytes=bytes.subarray(1);boundary=false;}
      if(pending.length)bytes=Buffer.concat([pending,bytes]);
      let start=0,next;while((next=bytes.indexOf(10,start))!==-1){if(next>start)yield JSON.parse(bytes.subarray(start,next).toString('utf8'));start=next+1;}
      pending=Buffer.from(bytes.subarray(start));
    }
  }
  if(pending.length)throw Error('incomplete pass journal tail; preserve original bytes');
}
export function withPassJournal(file,consume){return withLock(file,()=>{const view=snapshot(file);return consume({size:view.size,rows:(offset=0)=>rows(view,offset)});});}
export function passJournalSize(file){return withPassJournal(file,view=>view.size);}
export function passJournalExtent(file){return withLock(file,()=>{const index=readIndex(file);return {retired:index.pending?.end??index.segments.at(-1)?.end??0,size:snapshot(file).size};});}
export function activeJournalWriters(file){
  return ['closeout-turn.lock','closeout-measurement.lock'].filter(name=>{
    const owner=path.join(path.dirname(file),name,'owner.json');
    if(!fs.existsSync(owner))return false;
    try{process.kill(JSON.parse(fs.readFileSync(owner,'utf8')).pid,0);return true;}catch(error){return error.code!=='ESRCH';}
  });
}
export function* readPassJournal(file,{offset=0}={}){
  const release=noticeLock(file+'.lock',{waitMs:30000});
  try{yield* rows(snapshot(file),offset);}finally{release();}
}
