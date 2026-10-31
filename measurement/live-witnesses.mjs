// Evidence only. No model, executor, record writer, service or implicit clock.
import {createHash} from 'node:crypto';
import {measureLifecycle,timestamp,distribution} from './lifecycle.mjs';
import {measureLinePasses} from './line-passes.mjs';

export const SPEC_PREFIX='Live witness spec: ';
export const RESULT_PREFIX='Live witness result: ';
export const witnessHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const named=value=>typeof value==='string'&&value.trim().length>0;
const ref=e=>e?{seq:e.seq,type:e.type,at:e.at}:null;
const parse=(note,prefix)=>{try{return note.text.startsWith(prefix)?JSON.parse(note.text.slice(prefix.length)):null;}catch{return null;}};

export function witnessSpecs(item){
  const specs=new Map();
  for(const note of item.notes??[]){
    const spec=parse(note,SPEC_PREFIX);
    if(spec?.schema==='brain.live-witness/v1'&&named(spec.id))specs.set(spec.id,{spec,note});
  }
  return [...specs.values()];
}
export function witnessResults(item){return(item.notes??[]).map(note=>({result:parse(note,RESULT_PREFIX),note})).filter(row=>row.result?.schema==='brain.live-witness-result/v1');}
export function pendingWitnesses(item){return witnessSpecs(item).filter(({spec,note})=>!witnessResults(item).some(({result,note:r})=>r.seq>note.seq&&result.spec_sha256===witnessHash(spec)&&result.terminal===true));}

export function validateWitness(spec,project){
  if(spec.schema!=='brain.live-witness/v1'||!named(spec.id)||spec.project!==project||!named(spec.owner)||!named(spec.next))throw Error('spec requires schema, id, matching project, owner and next event');
  const from=timestamp(spec.from),cutoff=timestamp(spec.cutoff);
  if(from===null||cutoff===null||from>=cutoff)throw Error('spec requires an explicit ordered window with timezone');
  if(!['start-within-pass','same-revision-skips','folder-median','unavailable'].includes(spec.kind))throw Error('unsupported witness kind');
  if(spec.kind==='start-within-pass'&&(!named(spec.subject)||!['item.reopened','item.added','item.updated'].includes(spec.trigger?.type)||!Number.isSafeInteger(spec.trigger?.after_seq)||spec.trigger.after_seq<0))throw Error('start witness requires subject and explicit trigger type/sequence fence');
  if(spec.required_class!==undefined&&(!named(spec.required_class)||spec.kind!=='start-within-pass'))throw Error('required_class is only supported by start-within-pass');
  if(spec.kind==='folder-median'&&(!Number.isFinite(spec.under_ms)||spec.under_ms<=0))throw Error('folder median requires a positive under_ms target');
  if(spec.kind==='unavailable'&&!named(spec.reason))throw Error('unavailable witness requires the missing evidence reason');
}

// A finite, explicitly scoped projection. All parsers/joins are the existing
// store, pass and lifecycle readers; free-text verdicts are never evidence.
export async function evaluateWitness({spec,events,project,passes,now,readPasses=measureLinePasses}){
  validateWitness(spec,project);
  if(timestamp(now)===null)throw Error('evaluation requires an explicit recording time');
  const end=Math.min(timestamp(now),timestamp(spec.cutoff)),cutoff=new Date(end).toISOString(),closed=timestamp(now)>=timestamp(spec.cutoff);
  const selected=events.filter(e=>timestamp(e.at)===null||timestamp(e.at)<=end);
  const evidence={record:{through_seq:selected.at(-1)?.seq??0,sha256:witnessHash(selected)},window:{from:spec.from,cutoff}};
  const result=(status,reason,detail={},conditionAt=null,terminal=closed)=>({schema:'brain.live-witness-result/v1',id:spec.id,spec_sha256:witnessHash(spec),kind:spec.kind,
    project,owner:spec.owner,next:spec.next,status,reason,terminal,recorded_at:now,condition_at:conditionAt,
    delay_ms:timestamp(conditionAt)===null?null:Math.max(0,timestamp(now)-timestamp(conditionAt)),evidence:{...evidence,...detail}});
  if(end<timestamp(spec.from))return result('UNRUN','window has not opened',{},null,false);
  // Transactions capture their time before append: complete sequence order
  // need not be clock order. Check the original snapshot before time selection.
  if(!selected.length||events.some((e,i)=>!Number.isSafeInteger(e.seq)||e.seq!==(i?events[i-1].seq+1:1))||selected.some(e=>timestamp(e.at)===null))return result('UNRUN','record sequence or timestamp coverage is incomplete',{},null,false);
  if(spec.kind==='unavailable')return result('UNRUN',spec.reason);
  if(spec.kind==='folder-median'){
    const lifecycle=measureLifecycle({events:selected,project,from:spec.from,cutoff,throughSeq:selected.at(-1)?.seq??0});
    const cohort=lifecycle.runs.filter(r=>r.report_in_window),latency=distribution(cohort.map(r=>r.latency.report_to_folder_removed.ms));
    const detail={lifecycle:{source:lifecycle.source,latency,runs:cohort.map(r=>({run:r.run,item:r.item,report:r.report,ingest:r.ingest,folder:r.resources.folder,latency:r.latency.report_to_folder_removed}))}};
    if(!closed)return result('UNRUN','report cohort window is still open',detail,null,false);
    if(!cohort.length)return result('UNRUN','no reports occurred in the window',detail);
    if(latency.unknown||lifecycle.source.unscoped_starts_in_window.length)return result('UNRUN','full report cohort has unknown folder latency or project scope',detail);
    return result(latency.median_ms<spec.under_ms?'MET':'NOT MET',`folder median ${latency.median_ms} ms; target under ${spec.under_ms} ms`,detail,spec.cutoff);
  }
  const measured=await readPasses({file:passes,from:spec.from,cutoff});
  evidence.passes=measured.source;
  const rows=measured.passes.filter(p=>p.counts_known&&p.identity===project);
  if(spec.kind==='same-revision-skips'){
    const pairs=[];
    // Consecutive *completed* passes, in journal completion order, must carry
    // their own PID-bound starts. Missing attribution interrupts the chain.
    for(let i=1;i<measured.passes.length;i++){
      const a=measured.passes[i-1],b=measured.passes[i];
      if(!rows.includes(a)||!rows.includes(b)||timestamp(a.started_at)<timestamp(spec.from)||timestamp(b.started_at)<timestamp(spec.from)||!a.source_head||a.source_head!==b.source_head)continue;
      pairs.push({previous:a,warm:b});
    }
    const known=pairs.filter(p=>['admission_skipped','source_skipped'].every(k=>Number.isSafeInteger(p.warm.evaluations?.[k])&&p.warm.evaluations[k]>=0));
    const success=known.find(p=>p.warm.evaluations.admission_skipped>0&&p.warm.evaluations.source_skipped>0);
    const slim=p=>({pid:p.pid,started_at:p.started_at,completed_at:p.completed_at,source_head:p.source_head,evaluations:p.evaluations});
    const detail={pairs:pairs.map(p=>({previous:slim(p.previous),warm:slim(p.warm)}))};
    if(success)return result('MET','same-revision completed warm pass has both skip counts above zero',detail,success.warm.completed_at,true);
    if(!pairs.length||known.length!==pairs.length)return result('UNRUN','no qualifying same-revision pair, or skip counts unknown',detail);
    return result(closed?'NOT MET':'UNRUN','observed same-revision warm passes have not met both skip targets',detail,closed?spec.cutoff:null);
  }
  const trigger=selected.find(e=>e.type===spec.trigger.type&&e.id===spec.subject&&e.seq>spec.trigger.after_seq&&timestamp(e.at)>=timestamp(spec.from));
  if(!trigger)return result('UNRUN','trigger never occurred',{});
  // The first queue snapshot after the trigger defines its next actual pass;
  // a pass that has not completed cannot be replaced by a later easier one.
  const pass=rows.filter(p=>timestamp(p.queue?.at)>=timestamp(trigger.at)).sort((a,b)=>timestamp(a.queue.at)-timestamp(b.queue.at))[0];
  const detail={trigger:ref(trigger),subject:spec.subject,pass:pass?{pid:pass.pid,started_at:pass.started_at,completed_at:pass.completed_at,source_head:pass.source_head,
    queue:{...pass.queue,candidates:pass.queue.candidates.filter(c=>c.item===spec.subject||pass.admissions?.some(a=>a.item===c.item))},admissions:pass.admissions??[]}:null};
  if((measured.incomplete??[]).some(p=>p.identity===project&&timestamp(p.queue?.at)>=timestamp(trigger.at)&&(!pass||timestamp(p.queue.at)<timestamp(pass.queue.at))))return result('UNRUN','first queue pass after trigger is incomplete',detail,null,false);
  if(!pass)return result('UNRUN','no completed queue pass after the trigger',detail);
  const starts=selected.filter(e=>e.type==='run.started'&&e.item===spec.subject&&e.seq>trigger.seq&&timestamp(e.at)<=timestamp(pass.completed_at));
  const direct=starts.find(e=>e.by!=='line-service'||e.meta?.dispatch_project!==project);
  if(direct)return result('NOT MET','subject started outside the project line', {...detail,start:ref(direct)},direct.at,true);
  const start=starts.find(e=>timestamp(e.at)>=timestamp(pass.started_at));
  const admission=pass.admissions?.find(a=>a.item===spec.subject&&timestamp(a.decision_at)<=timestamp(start?.at)&&timestamp(a.at)>=timestamp(start?.at));
  if(!start)return result('NOT MET','subject did not start within its first completed queue pass',detail,pass.completed_at,true);
  if(!admission||!selected.some(e=>e.type==='run.session_bound'&&e.run===start.id))return result('UNRUN','line start lacks matching pass admission or committed native session', {...detail,start:ref(start)},null,false);
  if(spec.required_class){
    const own=pass.queue.candidates.find(c=>c.item===spec.subject),order=pass.queue.policy?.order;
    if(!own||!Array.isArray(order)||!order.includes(spec.required_class))return result('UNRUN','queue class/order evidence missing',detail);
    const lower=pass.admissions.filter(a=>timestamp(a.at)<timestamp(admission.at)).find(a=>{
      const c=pass.queue.candidates.find(c=>c.item===a.item);return c&&order.indexOf(c.class)>order.indexOf(spec.required_class);
    });
    if(own.class!==spec.required_class||lower)return result('NOT MET','required queue class or precedence not met',detail,pass.completed_at,true);
  }
  return result('MET','subject started by the project line within its first completed queue pass', {...detail,start:ref(start),run:start.id},start.at,true);
}

export function resultMutation({state,item,specNote,result}){
  const current=state.items.get(item);
  const entry=current&&witnessSpecs(current).find(row=>row.spec.id===result.id);
  if(!entry||entry.note.seq!==specNote||witnessHash(entry.spec)!==result.spec_sha256)throw Error('witness spec changed before recording; preserve original evaluation');
  const previous=witnessResults(current).findLast(({result:r,note})=>note.seq>specNote&&r.spec_sha256===result.spec_sha256);
  // Keep original evidence for unchanged UNRUN observations, and never replay
  // a terminal window. A new spec note is an explicit new observation.
  if(previous&&(previous.result.terminal||previous.result.status===result.status&&previous.result.reason===result.reason))return{add:[],result:{recorded:false,result:previous.result}};
  return{add:[{type:'note.added',id:item,text:RESULT_PREFIX+JSON.stringify(result),decision:false}],result:{recorded:true,result}};
}
