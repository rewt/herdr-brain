// Exact terminal refusals from a fresh dispatcher before journal allocation.
// Absence alone, a diagnostic substring, or an interrupted command proves nothing.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readCommandResult,commandResult} from '../lib/command-receipt.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refusals=new Set([
  'record changed repeatedly while preparing a consistent read; no mutation attempted',
  'fix base differs from actual saved author branch or main',
]);
export function prejournalReadmission({entry,key,repo,org,common,directory,item,brief,events,outcome}){
  if(entry?.state!=='held'||entry.owner!=='line-service'||entry.consumer!=='line-service'||
      entry.subject!==key||entry.execution_subject!==item||!entry.attempt||entry.history?.length||
      entry.prejournal_recovery||entry.stop_recovery||entry.failure?.kind==='fence'||entry.failure?.native_launch_attempted===true||
      entry.native_launch_attempted===true||entry.run||entry.worker||entry.launchProcess||entry.sessionBinding||
      entry.result||entry.commands?.length!==1||
      outcome?.status!=='unknown'||outcome.reason!=='original request outcome unavailable; no replacement'||
      outcome.journal||outcome.run||outcome.producer||outcome.native_launch_attempted===true)return null;
  const receipt=entry.receipt;
  if(receipt?.status!==1||receipt.signal||receipt.signal_sent||receipt.error)return null;
  let result;try{result=JSON.parse(receipt.stdout);}catch{return null;}
  if(result.result!=='failed'||result.code!=='DISPATCH_FAILED'||
      Object.keys(result).some(k=>!['result','code','reason'].includes(k))||
      !(refusals.has(result.reason)||/^(?:session|review) cap [1-9]\d* reached: [^\n]+$/.test(result.reason))||
      receipt.stderr!==`dispatch: ${result.reason}\n`||entry.error!==`dispatch: ${result.reason}`)return null;
  // The catch path emits journal/retry whenever allocation was reached. The
  // immutable foreground receipt binds this terminal output to this invocation.
  const [ref]=entry.commands;
  if(path.dirname(ref.file)!==path.join(directory,'active-commands'))return null;
  const terminal=readCommandResult(ref),intent=terminal.intent,args=intent.args;
  const flag=name=>args?.[args.indexOf(name)+1];
  if(intent.project!==common||intent.org!==org||intent.cwd!==repo||intent.key!==key||
      intent.subject!==item||intent.consumer!=='line-service'||!Array.isArray(args)||
      path.basename(args[0]??'')!=='dispatch.mjs'||path.basename(path.dirname(args[0]??''))!=='dispatch'||
      args[1]!==item||flag('--repo')!==repo||flag('--org')!==org||flag('--brief')!==brief||
      !args.includes('--detach')||args.includes('--retry')||
      JSON.stringify(commandResult(receipt))!==JSON.stringify(commandResult(terminal.result)))return null;
  const at=Date.parse(entry.at),started=Date.parse(intent.at),finished=Date.parse(terminal.finished_at);
  if(!Number.isFinite(at)||!Number.isFinite(started)||!Number.isFinite(finished)||started<at||finished<started||
      !Number.isFinite(Date.parse(entry.finished_at))||Date.parse(entry.finished_at)<finished||
      events.some(e=>e.type==='run.started'&&e.item===item&&Date.parse(e.at)>=at))return null;
  return{schema:'dispatch-readmission/v1',kind:'terminal-prejournal-refusal',native_launch_attempted:false,
    original_sha256:hash(entry),command:ref,terminal_sha256:hash(terminal),reason:result.reason};
}
