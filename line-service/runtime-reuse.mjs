// One line process's reuse of runtime byte verification across its snapshots.
// Only hashing is reused. Trial, owner, pin and compatibility decisions still run
// on every snapshot. Nothing is persisted, so each new process hashes once.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Identity, mode, size, mtime and ctime of every entry under each path. Any write
// moves ctime, even one that restores the size and mtime afterwards.
function physicalInputs(paths){
  const hash=createHash('sha256');
  const visit=file=>{
    const s=fs.lstatSync(file,{bigint:true});
    hash.update(JSON.stringify([file,...[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String)]));
    if(s.isDirectory())for(const name of fs.readdirSync(file).sort())visit(path.join(file,name));
  };
  for(const file of paths){
    const real=fs.realpathSync(file);
    hash.update(JSON.stringify([file,real]));
    visit(file);
    if(real!==file)visit(real);
  }
  return hash.digest('hex');
}

// reuse(key,paths,verify) returns verify's earlier result only while its key and
// physical inputs are unchanged. A failure is never kept, and neither is a result
// whose inputs moved while it ran. Unreadable inputs fall through to verify, so
// the line stops on the original check's own refusal.
export function runtimeReuse(count=()=>{}){
  const kept=new Map();
  const observed=paths=>{try{return physicalInputs(paths);}catch{return null;}};
  return (key,paths,verify)=>{
    const inputs=observed(paths),prior=kept.get(key);
    if(inputs!==null&&prior?.inputs===inputs){count('reused');return prior.value;}
    kept.delete(key);
    const value=verify();
    count('verified');
    if(inputs!==null&&observed(paths)===inputs)kept.set(key,{inputs,value});
    return value;
  };
}
