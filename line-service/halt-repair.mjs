// Completed engineering-idle counts stay in the existing diagnostic journal.
// The record transaction deduplicates only the repair intent across lost replies.
// This module files ordinary engineering work, never grants launch authority.
import fs from 'node:fs';
import {uncertainOutcomeDoctrine} from '../lib/uncertain-outcome.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {transact} from '../lib/store.mjs';
import {ancestors,itemStatus,nextItemId} from '../lib/state.mjs';
import {roleIs} from '../lib/roles.mjs';
import {intentFirstCreation} from '../lib/dispatch-template.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {serviceRecordBinding,canonicalFailure} from './record-inbox.mjs';
import {queuePolicy,queueClass,queueSelected} from './priority-order.mjs';
import {dispatchInput} from './phase1.mjs';
import {itemLaunchHold} from '../lib/item-launch-hold.mjs';
import {judgmentDispatchAllowed} from './decision-policy.mjs';
import {observeOutcomeDecisions} from './outcome-decision.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {contentDigest} from '../lib/config-home.mjs';
import {readPlainFile} from '../lib/files.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const repair=item=>item?.meta?.halt_repair===1;
// Record READY alone includes held ancestry and blocked reports whose linked
// dependencies have closed. Only normal admission's current input is work an
// idle diagnosis can help; this observation never clears an original attempt.
const readyItems=({state,events,org,identity,actions={},ordinaryAdmission})=>{
  const obsoleteDecision=observeOutcomeDecisions({identity,org});
  return [...state.items.values()].filter(i=>{
    if(i.kind==='goal'||!queueSelected(i,state,ordinaryAdmission)||repair(i)||roleIs(i,'REV')||itemLaunchHold(state,i.id,events)||
      ['security','funds-and-chain','publish','delete-data','licensing','priorities'].includes(i.meta.category))return false;
    if(obsoleteDecision(i,{events}))return false;
    const input=dispatchInput({state,events,item:i,org,identity});
    return input&&judgmentDispatchAllowed(i,input,actions);
  });
};
const held=i=>[i.id,i.meta.hold??null,i.meta.held??null,i.meta.reserved??null,i.meta.operator_reserved??null,i.meta.category??null];

export function haltObservation({state,events,org,identity,config,occupancy,actions={}}) {
  const ready=readyItems({state,events,org,identity,actions,ordinaryAdmission:config.ordinary_admission}).sort((a,b)=>a.id.localeCompare(b.id));
  const engineering=id=>{const r=state.runs.get(id),i=state.items.get(r?.item);return roleIs(i,'ENG')&&!repair(i)&&r.meta?.dispatch_project===identity;};
  const productive=(occupancy?.sessions??[]).filter(s=>s.occupancy==='observed live'&&s.kind==='worker'&&s.runs?.some(engineering)).map(s=>s.runs);
  const progress=events.filter(e=>e.type==='change.landed'&&e.project===identity&&e.landed_at&&e.producer&&engineering(e.run)||
    e.type==='run.session_bound'&&engineering(e.run)||e.type==='report.ingested'&&engineering(e.run??e.id)).at(-1)?.seq??0;
  const policy=queuePolicy(state);
  const causes=ready.map(i=>({item:i.id,created:i.created.seq,role:i.role,capability:i.capability,route:i.meta.route,queue_class:queueClass(state,i,policy),priority:i.priority,last_run:i.runs.at(-1)??null,report:state.runs.get(i.runs.at(-1))?.report?.file??null,
    holds:[held(i),...ancestors(state,i.id).map(held)],
    failures:Object.entries(actions).filter(([key])=>key.startsWith(`dispatch:${i.id}:`)).map(([key,e])=>[key,canonicalFailure(e.error)])}));
  const source=['line-service/line-service.mjs','line-service/priority-order.mjs','line-service/halt-repair.mjs','line-service/decision-policy.mjs','line-service/outcome-decision.mjs','line-service/phase1.mjs','line-service/review.mjs','line-service/review-observation.mjs','dispatch/preflight.mjs','lib/worker-brief.mjs','lib/item-launch-hold.mjs','lib/ordinary-admission.mjs'].map(file=>[file,hash(fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8'))]);
  return {ready:ready.map(i=>i.id),productive,progress,causes,signature:hash([causes,policy,progress,config.routes,config.selection_policy,config.ordinary_admission,source])};
}

export function completeHaltPass({repo,org,env,pass,previous,observation,route,after=3,audit,effects,actions={}}) {
  if(!Number.isSafeInteger(after)||after<1)throw Error('halt repair threshold must be a positive completed-pass count');
  const binding=serviceRecordBinding({repo,org,env});
  if(previous&&(previous.project!==binding.identity||previous.org!==org||!Number.isSafeInteger(previous.count)||previous.count<0))throw Error('halt progress project/count binding changed');
  if(previous?.pass===pass)return {...previous,progress:previous,existing:true,dispatch:false};
  const idle=observation.ready.length>0&&observation.productive.length===0;
  const count=idle?(previous?.signature===observation.signature?previous.count+1:1):0;
  const episode=hash([binding.identity,org,observation.signature]);
  const progress={project:binding.identity,org,pass,signature:observation.signature,episode,count,item:null};
  if(!idle||count<after)return {progress,episode,count,item:null,dispatch:false};
  // Audited policy reads may append a recovered/hand-edited config revision.
  // Finish that outside the record transaction; fence its bytes at the intent.
  const admission=readProjectPolicy(repo,'lane',env),ordinaryAdmission=admission.config.ordinary_admission;
  return transact(org,(events,state)=>{
    serviceRecordBinding({repo,org,env});
    for(const file of [path.join(binding.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])
      if(fs.existsSync(file))throw Error('STOP/HOLD prevents halt repair intent');
    // Input changed after the completed scan: let the next real pass observe it.
    if((fs.existsSync(admission.file)?contentDigest(readPlainFile(admission.file,null)):undefined)!==admission.source_digest)throw Error('halt admission policy changed before record intent');
    if(JSON.stringify(readyItems({state,events,org,identity:binding.identity,actions,ordinaryAdmission}).map(i=>i.id).sort())!==JSON.stringify([...observation.ready].sort()))throw Error('halt ready inputs changed before record intent');
    const previous=[...state.items.values()].filter(repair);
    // Pending, working, held and ambiguous owners are exclusive even if the
    // cause changes. A completed owner is exclusive for its unchanged episode.
    const existing=previous.find(i=>!['done','dropped'].includes(itemStatus(state,i.id)))??previous.find(i=>i.meta.halt_episode===episode);
    let item=existing?.id,add=[];
    if(idle&&count>=after&&!existing){
      item=nextItemId(state,{kind:'work',role:'engineer'});
      const evidence=`Completed pass ${pass}; ${audit}; ${effects}; ready items ${observation.ready.join(', ')}. Original effects and uncertain requests remain authoritative.`;
      add.push(intentFirstCreation({type:'item.added',id:item,kind:'work',role:'engineer',priority:2600,
        title:'Diagnose and repair stalled engineering admission',
        accept:['Diagnose this exact engineering-idle episode and fix its concrete admission cause through normal native dispatch. Preserve item/ancestor/reserved holds, ownership, STOP/HOLD and resource guards. '+uncertainOutcomeDoctrine],
        meta:{halt_repair:1,halt_episode:episode,route,purpose:'Restore productive engineering admission for the recorded idle episode.',
          scope:`One bounded diagnosis/fix of episode ${episode}. ${evidence} Do not create recursive halt repairs or take reserved actions. File unrelated work separately.`,
          evidence,halt_evidence:{audit,effects,pass,signature:observation.signature},halt_pass:pass,halt_threshold:after}}));
    }
    progress.item=item??null;
    const mutation={add,result:{progress,episode,count,item:item??null,existing:Boolean(existing),dispatch:Boolean(item)&&!['done','dropped'].includes(itemStatus(state,item))}};
    return protectRecordMutation({org,state,events,command:'automatic halt repair',mutation});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;
}
