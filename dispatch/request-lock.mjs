// Existing request serialization. Only positive ESRCH permits recovery;
// denied, live or unknown owners retain the original request.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
export function lockRequest(journal,{kill=process.kill}={}){
  const lock=journal+'.lock',directory=lock+'s',contender=directory+`/${process.pid}-${randomUUID()}`;
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(contender,'',{flag:'wx',mode:0o600});let owned=false;
  const gone=pid=>{if(!Number.isInteger(pid)||pid<1)throw Error('invalid dispatch lock owner; inspect request lock');try{kill(pid,0);throw Error(`dispatch is already running (pid ${pid})`);}catch(e){if(e.code!=='ESRCH')throw e;}};
  try{
    for(const entry of fs.readdirSync(directory)){const file=directory+'/'+entry;if(file===contender)continue;gone(Number(entry.split('-')[0]));try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
    try{gone(Number(fs.readFileSync(lock,'utf8')));fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw e;}
    fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});owned=true;
  }finally{if(!owned)fs.rmSync(contender,{force:true});}
  return{lock,contender,release(){if(fs.readFileSync(lock,'utf8')!==String(process.pid))throw Error('original request lock changed before release');fs.unlinkSync(lock);fs.unlinkSync(contender);}};
}
