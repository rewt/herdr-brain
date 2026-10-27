// Completed engineering-idle passes are record facts. One existing line owns
// the pass lock; the record transaction deduplicates intent across lost replies.
// This module files ordinary engineering work, never grants launch authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {transact} from '../lib/store.mjs';
import {ancestors,itemStatus,nextItemId} from '../lib/state.mjs';
import {roleIs} from '../lib/roles.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {serviceRecordBinding,canonicalFailure} from './record-inbox.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const repair=item=>item?.meta?.halt_repair===1;
const readyItems=state=>[...state.items.values()].filter(i=>i.kind!=='goal'&&!repair(i)&&!roleIs(i,'REV')&&i.role!=='human'&&itemStatus(state,i.id)==='ready');
const held=i=>[i.id,i.meta.hold??null,i.meta.held??null,i.meta.reserved??null,i.meta.operator_reserved??null,i.meta.category??null];

export function haltObservation({state,events,identity,config,occupancy,actions={}}) {
  const ready=readyItems(state).sort((a,b)=>a.id.localeCompare(b.id));
  const engineering=id=>{const r=state.runs.get(id),i=state.items.get(r?.item);return roleIs(i,'ENG')&&!repair(i)&&r.meta?.dispatch_project===identity;};
  const productive=(occupancy?.sessions??[]).filter(s=>s.occupancy==='observed live'&&s.kind==='worker'&&s.runs?.some(engineering)).map(s=>s.runs);
  const progress=events.filter(e=>e.type==='change.landed'&&e.project===identity&&e.landed_at&&e.producer&&engineering(e.run)||
    e.type==='run.session_bound'&&engineering(e.run)||e.type==='report.ingested'&&engineering(e.run??e.id)).at(-1)?.seq??0;
  const causes=ready.map(i=>({item:i.id,created:i.created.seq,role:i.role,capability:i.capability,route:i.meta.route,last_run:i.runs.at(-1)??null,report:state.runs.get(i.runs.at(-1))?.report?.file??null,
    holds:[held(i),...ancestors(state,i.id).map(held)],
    failures:Object.entries(actions).filter(([key])=>key.startsWith(`dispatch:${i.id}:`)).map(([key,e])=>[key,canonicalFailure(e.error)])}));
  const source=['line-service/line-service.mjs','dispatch/preflight.mjs','lib/worker-brief.mjs'].map(file=>[file,hash(fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8'))]);
  return {ready:ready.map(i=>i.id),productive,progress,causes,signature:hash([causes,progress,config.routes,config.selection_policy,source])};
}

export function completeHaltPass({repo,org,env,pass,observation,route,after=3,audit,effects}) {
  if(!Number.isSafeInteger(after)||after<1)throw Error('halt repair threshold must be a positive completed-pass count');
  const binding=serviceRecordBinding({repo,org,env});
  return transact(org,(events,state)=>{
    serviceRecordBinding({repo,org,env});
    for(const file of [path.join(binding.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])
      if(fs.existsSync(file))throw Error('STOP/HOLD prevents halt repair intent');
    // Input changed after the completed scan: let the next real pass observe it.
    if(JSON.stringify(readyItems(state).map(i=>i.id).sort())!==JSON.stringify([...observation.ready].sort()))throw Error('halt ready inputs changed before record intent');
    const rows=events.filter(e=>e.type==='line-service.halt-pass'&&e.project===binding.identity&&e.org===org);
    const repeated=rows.find(e=>e.pass===pass);if(repeated)return {add:[],result:{...repeated,existing:true}};
    const prior=rows.at(-1),idle=observation.ready.length>0&&observation.productive.length===0;
    const count=idle?(prior?.signature===observation.signature?prior.count+1:1):0;
    const episode=hash([binding.identity,org,observation.signature]);
    const row={type:'line-service.halt-pass',project:binding.identity,org,pass,signature:observation.signature,episode,count,threshold:after,audit,effects};
    if(!idle&&!prior?.count)return {add:[],result:{count:0,item:null,dispatch:false}};
    const previous=[...state.items.values()].filter(repair);
    // Pending, working, held and ambiguous owners are exclusive even if the
    // cause changes. A completed owner is exclusive for its unchanged episode.
    const existing=previous.find(i=>!['done','dropped'].includes(itemStatus(state,i.id)))??previous.find(i=>i.meta.halt_episode===episode);
    let item=existing?.id,add=[row];
    if(idle&&count>=after&&!existing){
      item=nextItemId(state,{kind:'work',role:'engineer'});
      const evidence=`Completed pass ${pass}; ${audit}; ${effects}; ready items ${observation.ready.join(', ')}. Original effects and uncertain requests remain authoritative.`;
      add.push({type:'item.added',id:item,kind:'work',role:'engineer',priority:2600,
        title:'Diagnose and repair stalled engineering admission',
        accept:['Diagnose this exact engineering-idle episode and fix its concrete admission cause through normal native dispatch. Preserve uncertain attempts, item/ancestor/reserved holds, ownership, STOP/HOLD and resource guards.'],
        meta:{halt_repair:1,halt_episode:episode,route,purpose:'Restore productive engineering admission for the recorded idle episode.',
          scope:`One bounded diagnosis/fix of episode ${episode}. ${evidence} Do not create recursive halt repairs or take reserved actions. File unrelated work separately.`,
          evidence,halt_evidence:{audit,effects,pass,signature:observation.signature},halt_pass:pass,halt_threshold:after}});
    }
    row.repair_item=item??null;
    const mutation={add,result:{episode,count,item:item??null,existing:Boolean(existing),dispatch:idle&&count>=after&&Boolean(item)&&itemStatus(state,item)!=='done'}};
    return protectRecordMutation({org,state,events,command:'automatic halt repair',mutation});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;
}
