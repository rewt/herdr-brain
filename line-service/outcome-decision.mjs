// Missing completion producers and native refusals are ordinary record work.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {transact} from '../lib/store.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {serviceRecordBinding} from './record-inbox.mjs';
import {closeoutNextStage,closeoutWait,closeoutWaitState} from '../lib/closeout-status.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// A queued cleanup decision launches only while its exact request still shows a
// defect or failure. An owned progress stage, a completed or unqueued request or
// a changed source binding makes the captured proposal obsolete: it is deferred,
// never closed or rewritten here. Other subjects keep their recorded ownership.
export function obsoleteOutcomeDecision(item,{events,entries,evaluations}) {
  const check=item?.meta?.uncertain_outcome?.check;
  if(typeof check?.key!=='string'||!check.key.startsWith('closeout:'))return null;
  const entry=entries.find(e=>e.key===check.subject?.key);
  if(!entry)return 'cleanup request is no longer queued';
  if(!same(entry.source,check.subject.source))return 'cleanup request source binding changed';
  const prior=evaluations.get(entry.key);
  if(prior?.completed)return 'cleanup request completed';
  const next=prior&&closeoutNextStage(entry,prior,events,entries);
  if(next)return `owned ${next.stage} progress`;
  if(!['defect','failed'].includes(closeoutWaitState(prior&&closeoutWait(entry,prior,events),events)))return 'no current defect or failure for this cleanup request';
  return null;
}
export function queueOutcomeDecision({repo,org,env,check}) {
  const binding=serviceRecordBinding({repo,org,env}),key=createHash('sha256').update(JSON.stringify([binding.identity,org,check.key])).digest('hex');
  return transact(org,(events,state)=>{
    serviceRecordBinding({repo,org,env});
    for(const file of [path.join(binding.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents outcome decision');
    const existing=[...state.items.values()].find(i=>i.meta.uncertain_outcome?.key===key);
    if(existing)return {add:[],result:{item:existing.id,key}};
    // The original effect journal already owns this diagnostic. Retain the
    // compatibility entry and all historical decision items, without making
    // a fresh judge/session from a missing receipt or refusal.
    const mutation={add:[],result:{record_only:true,key}};
    return protectRecordMutation({org,state,events,command:'queue outcome decision',mutation});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;
}
