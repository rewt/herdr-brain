// The original command publishes its own result; readers never poll its files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {assertOwner,readOwnedRun} from '../lib/run-owner-guard.mjs';
export function recordDispatchCompletion({job,journal,exitCode}) {
  if(job.completion_protocol!==1)return;
  if(gitProject(job.repo).identity!==job.common||path.dirname(journal)!==path.join(job.org,'dispatch')||path.basename(journal)!==`${job.token}.json`||fs.readFileSync(journal+'.lock','utf8')!==String(process.pid))throw Error('dispatch completion original command ownership changed');
  const bytes=fs.readFileSync(journal),actual=JSON.parse(bytes);
  if(actual.token!==job.token||actual.stage!==job.stage||actual.run!==job.run||actual.common!==job.common||actual.org!==job.org)throw Error('dispatch completion source changed');
  return transact(job.org,(events,state)=>{
    if(!state.items.has(job.item))throw Error('dispatch completion lost its owning item');
    if(job.run){if(!job.ownership)throw Error('dispatch completion lacks its current claim');assertOwner(readOwnedRun(job.org,job.run,events),job.ownership);}
    const status={type:'dispatch.completed',project:job.common,journal,attempt:job.token,item:job.item,run:job.run,stage:job.stage,exit_code:exitCode,
      native_launch_attempted:job.native_launch_attempted??null,failure:job.failure??null,request_sha256:createHash('sha256').update(bytes).digest('hex')};
    const prior=events.findLast(e=>e.type==='dispatch.completed'&&e.journal===journal&&e.attempt===job.token&&e.request_sha256===status.request_sha256);
    return{add:prior?[]:[status]};
  },{actor:'dispatch',strictTail:true,lockOptions:{recover:false}});
}
