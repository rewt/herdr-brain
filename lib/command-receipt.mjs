// A finite foreground helper owns its terminal receipt even if its caller dies.
// An intent without that receipt remains UNKNOWN; age and PID absence are not
// permission to repeat a command or declare a maintenance quiet point.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {plainDirectory,readPlainFile} from './files.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function immutable(file,value){
  const bytes=JSON.stringify(value)+'\n';
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  return bytes;
}
export function commandIntent(directory,{exe,args,cwd,...binding}){
  const id=randomUUID(),pending=plainDirectory(path.join(directory,'active-commands')),
    receipts=plainDirectory(path.join(directory,'command-receipts'));
  const intent={schema:'line-command/v1',id,exe,args,cwd,caller:process.pid,at:new Date().toISOString(),...binding};
  const file=path.join(pending,id+'.json'),receipt=path.join(receipts,id+'.json');
  return{file,receipt,sha256:hash(immutable(file,intent))};
}
function readIntent(ref){
  const bytes=readPlainFile(ref.file),intent=JSON.parse(bytes);
  if(hash(bytes)!==ref.sha256||intent.schema!=='line-command/v1'||path.basename(ref.file)!==intent.id+'.json'||
    ref.receipt!==path.join(path.dirname(path.dirname(ref.file)),'command-receipts',intent.id+'.json'))throw Error('command intent binding changed');
  return intent;
}
export function validateCommandIntent(ref,{exe,args,cwd}){
  const intent=readIntent(ref);
  if(intent.exe!==exe||JSON.stringify(intent.args)!==JSON.stringify(args)||intent.cwd!==cwd)throw Error('foreground command differs from its saved intent');
}
export function commandResult(result){
  return {status:result.status??null,signal:result.signal??null,stdout:result.stdout??'',stderr:result.stderr??'',
    ...(result.error?{error:{code:result.error.code??'COMMAND_FAILED',message:result.error.message??String(result.error)}}:{}),
    ...(result.activity?{activity:result.activity,signal_sent:result.signal_sent}:{})};
}
export function finishCommand(ref,result,execution){
  const intent=readIntent(ref),value={schema:'line-command-result/v1',intent,intent_sha256:ref.sha256,
    finished_at:new Date().toISOString(),executor:process.pid,...(execution?{execution}:{}),result:commandResult(result)};
  try{immutable(ref.receipt,value);}catch(error){
    if(error.code!=='EEXIST')throw error;
    const prior=readCommandResult(ref);
    if(JSON.stringify(prior.result)!==JSON.stringify(value.result))throw Error('original command result differs; retain both observations');
    return prior;
  }
  return value;
}
export function readCommandResult(ref){
  const result=JSON.parse(readPlainFile(ref.receipt));let intent;
  try{intent=readIntent(ref);}catch(error){
    if(error.code!=='ENOENT')throw error;
    intent=result.intent;
    if(!intent||hash(JSON.stringify(intent)+'\n')!==ref.sha256||path.basename(ref.file)!==intent.id+'.json'||
      ref.receipt!==path.join(path.dirname(path.dirname(ref.file)),'command-receipts',intent.id+'.json'))throw Error('retained command intent binding changed');
  }
  if(result.schema!=='line-command-result/v1'||result.intent_sha256!==ref.sha256||JSON.stringify(result.intent)!==JSON.stringify(intent)||
    !Number.isSafeInteger(result.executor)||!Number.isFinite(Date.parse(result.finished_at))||!result.result)throw Error('command completion binding changed');
  return result;
}
export function forgetActiveCommand(ref){readCommandResult(ref);fs.unlinkSync(ref.file);}

// Call while holding pass.lock. A command publishes its intent under that same
// lock before yielding it, so no new command can cross this maintenance fence.
export function assertCommandQuiescence(directory,{commands=[]}={}){
  const pending=path.join(directory,'active-commands');if(!fs.existsSync(pending))return;
  plainDirectory(pending,{create:false});
  for(const name of fs.readdirSync(pending)){
    const file=path.join(pending,name);let intent,ref={file,receipt:path.join(directory,'command-receipts',name)};
    try{
      try{const bytes=readPlainFile(file);intent=JSON.parse(bytes);ref.sha256=hash(bytes);}
      catch(error){
        if(error.code!=='ENOENT')throw error;
        // Cleanup may follow the listing. Only the original journal's exact
        // reference can supply the intent hash when its marker has vanished.
        const saved=commands.filter(c=>c.file===file);
        if(!saved.length||saved.some(c=>c.receipt!==ref.receipt||!c.sha256||c.sha256!==saved[0].sha256))throw error;
        ref=saved[0];
      }
      try{readCommandResult(ref);}catch(error){
        if(error.code!=='ENOENT'||fs.existsSync(file))throw error;
        // Completion/cleanup can overtake a missing-result observation. This
        // is one fresh proof read, never a command retry or absence inference.
        readCommandResult(ref);
      }
    }catch(error){
      const owner=intent?.stuck_owner??'project supervisor';
      throw Object.assign(Error(`line command is active or UNKNOWN; retain ${owner} ownership: ${file}; cannot validate terminal receipt ${ref.receipt}; ${error.message}`,{cause:error}),
        {code:'LINE_COMMAND_OUTCOME_UNKNOWN',command:ref,stuck_owner:owner});
    }
  }
}
export function pendingSubjectCommand(directory,subject){
  const pending=path.join(directory,'active-commands');if(!fs.existsSync(pending))return null;
  plainDirectory(pending,{create:false});
  for(const name of fs.readdirSync(pending)){
    const file=path.join(pending,name),bytes=readPlainFile(file),intent=JSON.parse(bytes);
    if(intent.subject!==subject)continue;
    const ref={file,receipt:path.join(directory,'command-receipts',name),sha256:hash(bytes)};
    try{readCommandResult(ref);}catch{return{intent,command:ref};}
  }
  return null;
}
