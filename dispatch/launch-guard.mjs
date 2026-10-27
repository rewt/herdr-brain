// Read current launch inputs at the effect boundary, not an admission snapshot.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadEvents} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {assertOwner,readOwnedRun} from '../lib/run-owner-guard.mjs';
import {gitProject} from '../lib/project.mjs';
import {bundleRelease} from '../lib/releases.mjs';
import {dispatchInput} from '../line-service/phase1.mjs';

export const launchDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const changed = (reason, input) => {
  throw Object.assign(Error(`dispatch launch input changed: ${reason}`), {code:'DISPATCH_INPUT_CHANGED',launch_input:input});
};

export function checkDispatchEligibility(job, journal) {
  const {events,tornTail}=loadEvents(job.org),state=fold(events);
  const input={journal,token:job.token,item:job.item,run:job.run??null,project:job.common,
    release:job.release,observed_seq:events.at(-1)?.seq??0};
  const refuse=(reason,subject=job.item)=>changed(reason,{...input,subject});
  if(tornTail)refuse('incomplete record input');
  const item=state.items.get(job.item),seen=new Set();
  for(let id=job.item;id;){
    if(seen.has(id))refuse(`ancestor cycle at ${id}`,id);
    seen.add(id);
    const current=state.items.get(id);
    if(!current)refuse(`item/ancestor ${id} is missing`,id);
    if(current.closed||current.meta.hold||current.meta.held||current.meta.operator_reserved||current.meta.reserved||current.role==='human')
      refuse(`item/ancestor ${id} is closed/held/reserved`,id);
    id=current.parent;
  }
  if(job.run){
    const run=assertOwner(readOwnedRun(job.org,job.run,events),job.ownership);
    if(item.runs.at(-1)!==job.run||run.report||run.abandoned)refuse('current run was superseded or finished');
    if(run.item!==job.item||run.meta.dispatch_journal!==journal||run.meta.dispatch_attempt!==job.token||
        run.meta.dispatch_project!==job.common||run.meta.dispatch_record!==job.org||
        fs.realpathSync(run.workspace)!==job.workspace||run.meta.route!==job.route||
        Object.entries(job.declared).some(([key,value])=>(run.meta[key]??null)!==value))
      refuse('run/intent no longer matches the saved request');
  }
  if(job.lineInput){
    // Exclude only this request's own admission. Its original predecessor and
    // all unrelated events remain intact, including qualified pending effects.
    if(job.run){
      state.items.set(item.id,{...item,runs:item.runs.filter(id=>id!==job.run)});
      state.runs.delete(job.run);
    }
    if(dispatchInput({events,state,item:state.items.get(job.item),org:job.org,identity:job.common})!==job.lineInput)
      refuse('readiness or genuine changed input differs from its frozen request');
  }
  return input;
}

// The parent holds its existing request/admission locks. Bind the child to the
// exact pending intent bytes; these checks confer no new launch authority.
export function checkDispatchLaunch({journal,sha256,repo,workspace,topic}) {
  if(!fs.lstatSync(journal).isFile()||fs.realpathSync(journal)!==path.resolve(journal))throw Error('dispatch request is redirected');
  const bytes=fs.readFileSync(journal);
  if(!/^[a-f0-9]{64}$/.test(sha256??'')||launchDigest(bytes)!==sha256)
    changed('pending request bytes differ from the captured launch',{journal,request_sha256:sha256});
  const job=JSON.parse(bytes),actual=gitProject(repo),target=gitProject(workspace);
  if(job.common!==actual.identity||target.identity!==actual.identity||job.repo!==repo||
      target.checkout!==workspace||job.workspace!==workspace||job.lane!==topic||
      fs.realpathSync(job.org)!==job.org||path.dirname(journal)!==path.join(job.org,'dispatch')||
      job.release?.root!==bundleRelease().root||job.stage!=='launching'||job.native_launch_attempted!==true||job.worker)
    throw Error('dispatch source/project/pending-effect identity changed');
  const directory=path.join(actual.canonical,'.lane/supervisor');
  const stops=[path.join(directory,'STOP'),path.join(directory,'HOLD')];
  if(job.detached||job.detachedRequested)stops.push(path.join(job.org,'line-service',launchDigest(JSON.stringify(job.common)).slice(0,20),'STOP'));
  if(stops.some(file=>fs.existsSync(file)))throw Object.assign(Error('STOP/HOLD prevents native dispatch effect'),{code:'DISPATCH_STOPPED'});
  return {...checkDispatchEligibility(job,journal),request_sha256:sha256};
}
