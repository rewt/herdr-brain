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
  const ticketFor=file=>{try{const value=fs.readFileSync(file,'utf8');return /^[1-9]\d*$/.test(value)?BigInt(value):0n;}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  try{
    // Publish a ticket before probing any owner. A later arrival must follow
    // an already-checking contender even when PID/name ordering wraps around.
    // Empty/legacy peers are still choosing; wait for publication or ESRCH.
    let ticket=1n;
    for(const entry of fs.readdirSync(directory)){
      const file=directory+'/'+entry;if(file===contender)continue;
      const peer=ticketFor(file);if(peer!==null&&peer>=ticket)ticket=peer+1n;
    }
    fs.writeFileSync(contender,String(ticket),{flag:'r+'});
    const deadline=Date.now()+loadTimeout(5000),pause=new Int32Array(new SharedArrayBuffer(4));
    for(;;){
      // An established owner never participates in contender arbitration.
      try{const pid=Number(fs.readFileSync(lock,'utf8'));if(!gone(pid))throw busy(pid);}catch(e){if(e.code!=='ENOENT')throw e;}
      let waiting;
      for(const entry of fs.readdirSync(directory)){
        const file=directory+'/'+entry;if(file===contender)continue;
        // A losing contender may have withdrawn since the directory snapshot.
        const peer=ticketFor(file);if(peer===null)continue;
        const pid=Number(entry.split('-')[0]);
        if(gone(pid)){try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}continue;}
        // Earlier tickets stay published while later ones withdraw. Equal
        // tickets use stable names; an unfinished publication cannot be ignored.
        if(pid===process.pid||peer!==0n&&(peer<ticket||peer===ticket&&entry<name))throw busy(pid);
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
