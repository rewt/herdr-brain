// One foreground owned child, using the existing measured-inactivity policy.
// Elapsed time alone never kills a helper. This creates no persistent monitor.
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {watchRun} from '../test-slot/watch.mjs';
import {readOwnerProcess} from '../lib/process-owner.mjs';
import {isMain} from '../lib/cli-help.mjs';
import {finishCommand,validateCommandIntent} from '../lib/command-receipt.mjs';

export function executeForeground({exe,args,cwd,env=process.env,commandReceipt},{launch=spawn,watch=watchRun,readProcess=readOwnerProcess}={}){
  if(commandReceipt)validateCommandIntent(commandReceipt,{exe,args,cwd});
  return new Promise(resolve=>{
    const startedAt=new Date().toISOString();
    const child=launch(exe,args,{cwd,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',error,signalSent=false,birth;
    try{const r=readProcess(child.pid);if(r?.ok&&r.value?.pid===child.pid)birth=r.value.identity;}catch{/* Unknown never authorizes a signal. */}
    const watcher=watch({pid:child.pid,ownsGroup:false,onFrozen:()=>{
      if(signalSent||child.exitCode!==null||child.signalCode!==null||!birth)return;
      let current;try{current=readProcess(child.pid);}catch{return;}
      if(!current?.ok||current.value?.pid!==child.pid||current.value.identity!==birth)return;
      signalSent=child.kill('SIGTERM');
    }});
    child.stdout.on('data',b=>{stdout+=b;watcher.output();});child.stderr.on('data',b=>{stderr+=b;watcher.output();});
    child.once('error',e=>{error={code:e.code??'COMMAND_FAILED',message:e.message};});
    child.once('close',(status,signal)=>{watcher.stop();const result={status,signal,stdout,stderr,...(error?{error}:{}),signal_sent:signalSent,activity:watcher.snapshot()};
      // Persist before replying. Parent death must not discard the real exit.
      try{if(commandReceipt)finishCommand(commandReceipt,result,{started_at:startedAt,pid:child.pid??null,identity:birth??null});resolve(result);}catch(error){resolve({status:null,stdout:'',stderr:error.message,error});}
    });
  });
}

export function foregroundCommand(exe,args,options={}){
  const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--owned-command'],{cwd:options.cwd,env:options.env,encoding:'utf8',
    input:JSON.stringify({exe,args,cwd:options.cwd,...(options.commandReceipt?{commandReceipt:options.commandReceipt}:{})}),maxBuffer:64*1024*1024,timeout:0});
  if(r.error||r.status!==0)return r;
  const result=JSON.parse(r.stdout);if(result.error)result.error=Object.assign(Error(result.error.message),{code:result.error.code});return result;
}

if(isMain(import.meta.url)){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--owned-command')throw Error('internal foreground command entry requires its original request on stdin');
    const fs=await import('node:fs'),request=JSON.parse(fs.readFileSync(0,'utf8'));
    if(typeof request.exe!=='string'||!Array.isArray(request.args)||!request.args.every(a=>typeof a==='string'))throw Error('invalid owned foreground command');
    process.stdout.write(JSON.stringify(await executeForeground(request))+'\n');
  }catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
}
