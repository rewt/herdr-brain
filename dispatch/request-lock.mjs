// Existing request serialization. Only positive ESRCH permits recovery;
// denied, live or unknown owners retain the original request.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {loadTimeout} from '../lib/deadline.mjs';
export function lockRequest(journal,{kill=process.kill}={}){
  const lock=journal+'.lock',directory=lock+'s',name=`${process.pid}-${randomUUID()}`,contender=directory+'/'+name;
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(contender,'',{flag:'wx',mode:0o600});let owned=false;
  const busy=pid=>Error(`dispatch is already running (pid ${pid})`);
  const gone=pid=>{if(!Number.isInteger(pid)||pid<1)throw Error('invalid dispatch lock owner; inspect request lock');try{kill(pid,0);return false;}catch(e){if(e.code!=='ESRCH')throw e;return true;}};
  try{
    const deadline=Date.now()+loadTimeout(5000),pause=new Int32Array(new SharedArrayBuffer(4));
    for(;;){
      // An established owner never participates in contender arbitration.
      try{const pid=Number(fs.readFileSync(lock,'utf8'));if(!gone(pid))throw busy(pid);}catch(e){if(e.code!=='ENOENT')throw e;}
      let waiting;
      for(const entry of fs.readdirSync(directory)){
        const file=directory+'/'+entry;if(file===contender)continue;
        // A losing contender may have withdrawn since the directory snapshot.
        try{fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
        const pid=Number(entry.split('-')[0]);
        if(gone(pid)){try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}continue;}
        // Lower names stay published while higher names withdraw. Never ignore
        // a live peer: doing so could race another stale-lock recovery.
        if(entry<name||pid===process.pid)throw busy(pid);
        waiting=pid;
      }
      if(waiting===undefined)break;
      if(Date.now()>=deadline)throw busy(waiting);
      Atomics.wait(pause,0,0,10);
    }
    try{const pid=Number(fs.readFileSync(lock,'utf8'));if(!gone(pid))throw busy(pid);fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw e;}
    fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});owned=true;
  }finally{if(!owned)fs.rmSync(contender,{force:true});}
  return{lock,contender,release(){if(fs.readFileSync(lock,'utf8')!==String(process.pid))throw Error('original request lock changed before release');fs.unlinkSync(lock);fs.unlinkSync(contender);}};
}
