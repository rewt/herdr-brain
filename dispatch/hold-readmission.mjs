// A launch hold refused this request before any allocation or native effect.
// Its own terminal and saved receipt prove that; the shared launch predicate,
// re-read now, proves the hold no longer stands. Together they authorize one
// fresh intent. The request is never retried and a current hold keeps it held.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {originalDispatchOutcome} from './outcome.mjs';
import {itemLaunchHold} from '../lib/item-launch-hold.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused=/^dispatch launch input changed: item\/ancestor (\S+) is closed\/held\/reserved$/;
export function clearedHoldReadmission({entry,journal,repo,org,common,item,brief,events,state}){
  const at=Date.parse(entry?.at);
  if(!journal||!Number.isFinite(at)||entry.state!=='held'||entry.history?.length||entry.stop_recovery||entry.prejournal_recovery||
      entry.failure?.kind==='fence'||entry.receipt?.status!==1||entry.receipt.signal||entry.receipt.signal_sent||entry.receipt.error)return null;
  let outcome,result;
  try{outcome=originalDispatchOutcome({repo,org,common,item,brief,journal,events});result=JSON.parse(entry.receipt.stdout);}catch{return null;}
  const failure=outcome.failure,launch=failure?.launch_input,subject=refused.exec(outcome.error??'')?.[1];
  // Stage open allocated nothing. Later stages keep their allocation owner.
  if(outcome.status!=='not-started'||outcome.stage!=='open'||outcome.run||outcome.native_launch_attempted!==false||
      failure.code!=='DISPATCH_INPUT_CHANGED'||failure.kind==='fence'||!subject||
      launch?.subject!==subject||launch.journal!==journal||launch.item!==item||launch.run||path.basename(journal)!==`${launch.token}.json`||
      result.result!=='failed'||result.code!==failure.code||result.journal!==journal||result.reason!==outcome.error)return null;
  if(events.some(e=>e.type==='run.started'&&(e.item===item&&Date.parse(e.at)>=at||e.meta?.dispatch_journal===journal||e.meta?.dispatch_attempt===launch.token)))return null;
  // Never probe, reclaim or replace a still-owned original driver.
  try{fs.lstatSync(journal+'.lock');return null;}catch(e){if(e.code!=='ENOENT')return null;}
  try{if(fs.readdirSync(journal+'.locks').length)return null;}catch(e){if(e.code!=='ENOENT')return null;}
  if(itemLaunchHold(state,item,events))return null;
  return{schema:'dispatch-readmission/v1',kind:'launch-hold-cleared',journal,attempt:launch.token,subject,
    request_sha256:outcome.request_sha256,terminal_sha256:outcome.proof.terminal_sha256,receipt_sha256:hash(entry.receipt),native_launch_attempted:false};
}
