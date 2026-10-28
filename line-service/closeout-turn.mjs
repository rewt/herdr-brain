// One finite service role. The record owns obligations; this checkpoint only
// orders fair work. No general pass lock, model call or native implementation.
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {loadEvents,writeFileAtomic} from '../lib/store.mjs';
import {bindCloseoutCode} from '../lib/closeout-code.mjs';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {retirementLock} from '../lib/retire-lock.mjs';
import {requireController,readOwnedRun} from '../lib/run-owner-guard.mjs';
import {currentCloseoutEntries,closeoutEvaluations,closeoutEvaluation,closeoutRevision,
  scheduleLineCloseouts,directCloseoutObservation,publishCloseoutEvents,lineServiceOwnsCleanup} from '../lib/closeout.mjs';
import {closeoutNextStage,closeoutWait,closeoutWaitState} from '../lib/closeout-status.mjs';

export const closeoutServiceDirectory=(org,common)=>path.join(org,'line-service',createHash('sha256').update(JSON.stringify(common)).digest('hex').slice(0,20));
export function runCloseoutTurn({project,org,cli,guard,env=process.env,maxSteps=8,budgetMs=45000,
  clock=()=>performance.now(),now=()=>Date.now(),fault=()=>{}}) {
  const directory=closeoutServiceDirectory(org,project.identity),file=path.join(directory,'closeout-turn.json');
  fs.mkdirSync(directory,{recursive:true});
  let release;
  try{release=retirementLock(path.join(directory,'closeout-turn.lock'));}
  catch(error){if(error.message.startsWith('locked:'))return{already_running:true};throw error;}
  try{
    guard();const code=bindCloseoutCode(project);
    const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):
      {schema:'line-closeout-turn/v1',identity:project.identity,org,attempt:0,ingest:{},targets:{}};
    if(state.schema!=='line-closeout-turn/v1'||state.identity!==project.identity||state.org!==org)throw Error('closeout checkpoint identity changed');
    const save=()=>writeFileAtomic(file,JSON.stringify(state)+'\n',0o600),started=clock(),expired=()=>clock()-started>=budgetMs;
    const read=()=>{guard();code.verify();const loaded=loadEvents(org);if(loaded.tornTail)throw Error('incomplete closeout record');return{events:loaded.events,state:fold(loaded.events)};};
    let observed=read(),ingested=0,steps=0;const errors=[];
    // The file is only a validation candidate. Reconcile all committed run
    // sources, so losing an availability hint or dying before ingest is safe.
    const pending=[...observed.state.runs.values()].filter(r=>!r.report&&!r.abandoned&&r.report_path&&fs.existsSync(r.report_path))
      .sort((a,b)=>(state.ingest[a.id]??0)-(state.ingest[b.id]??0)||a.started.seq-b.started.seq);
    for(const run of pending){
      if(expired()||clock()-started>=budgetMs/3||ingested>=maxSteps)break;
      state.ingest[run.id]=++state.attempt;state.pending={stage:'ingest',run:run.id};save();fault('before-ingest');
      try{
        const current=read(),r=current.state.runs.get(run.id),item=current.state.items.get(r?.item);
        if(!r||r.report||r.abandoned||item?.runs.at(-1)!==r.id)throw Error('current run changed before bounded ingest');
        if(r.workspace&&fs.existsSync(r.workspace)&&gitProject(r.workspace).identity!==project.identity)throw Error('ingest allocation project identity changed');
        requireController(readOwnedRun(org,r.id,current.events),'brain');
        const start=current.events.find(e=>e.type==='run.started'&&e.id===r.id);
        if(r.owner?.legacy||r.meta.dispatch_project!==project.identity&&start?.meta?.dispatch_project!==project.identity)
          throw Error('original ingest project/claim is missing or foreign');
        cli('bin/org.mjs',['ingest',r.report_path,'--run',r.id,'--if-current-run',r.id]);
        fault('after-ingest');
      }catch(error){errors.push({run:run.id,stage:'ingest',reason:error.message});}
      ingested++;delete state.pending;save();
    }
    // Refresh uses the existing original-evidence repair, never a new binder.
    if(!expired()&&lineServiceOwnsCleanup(project,org)){
      try{guard();cli('supervisor/closeout.mjs',['refresh','--repo',project.canonical,'--org',org]);}
      catch(error){errors.push({stage:'refresh',reason:error.message});}
    }
    observed=read();
    // Re-publish exact committed envelopes only. No re-binding a namesake.
    const sources=observed.events.filter(e=>e.closeout_targets?.some(t=>t.common===project.identity&&t.org===org&&!t.reportCloseout));
    if(sources.length)publishCloseoutEvents({cwd:project.canonical,org,env,added:sources,start:false});
    fault('after-publication');
    const entries=currentCloseoutEntries(project.identity,org,observed.events,{onInvalid:()=>{}}),
      rows=closeoutEvaluations(project.identity,org,observed.events),evaluations=new Map(rows.map(e=>[e.key,e]));
    for(const entry of entries)if(entry.reportCloseout){const prior=closeoutEvaluation(entry,observed.events);if(prior)evaluations.set(entry.key,prior);else evaluations.delete(entry.key);}
    const eligible=entries.filter(entry=>{
      if(entry.project!==project.canonical||entry.org!==org)return false;
      const prior=evaluations.get(entry.key);if(prior?.completed)return false;
      if(!prior)return true;
      if(directCloseoutObservation(entry,prior,observed.events))return true;
      const next=closeoutNextStage(entry,prior,observed.events,entries);if(next)return next.ready;
      return closeoutWaitState(closeoutWait(entry,prior,observed.events),observed.events)==='complete'&&
        closeoutRevision(entry,observed.events,observed.state)>(prior.revision??0);
    });
    const scheduled=scheduleLineCloseouts(eligible,rows,{batch:true,attempts:state.targets});
    for(const {entry,sessionsOnly}of scheduled){
      if(expired()||steps>=maxSteps)break;
      // Checkpoint before dispatch: crashes cannot keep selecting the oldest
      // kept target ahead of its independent peers. Native UNKNOWN stays owned
      // by the closer's exact original intent, never this scheduling checkpoint.
      state.targets[entry.key]=++state.attempt;state.pending={stage:'closeout',key:entry.key,source:entry.source};save();fault('before-closeout');
      try{
        guard();code.verify();
        const result=JSON.parse(cli('supervisor/closeout.mjs',['drain','--repo',project.canonical,'--org',org,
          '--keys',JSON.stringify([entry.key]),'--no-restart','--retry-safe','--deadline',String(now()+Math.max(1,budgetMs-(clock()-started))),
          ...(sessionsOnly?['--sessions-only']:[])]));
        state.last_result={key:entry.key,result};fault('after-closeout');
      }catch(error){errors.push({key:entry.key,stage:'closeout',reason:error.message});}
      steps++;delete state.pending;save();
    }
    state.completed_at=new Date(now()).toISOString();state.errors=errors;state.continuation={
      ingest:Math.max(0,pending.length-ingested),closeout:Math.max(0,scheduled.length-steps),reconcile_committed_sources:true};
    save();fault('before-ack');
    return{result:'closeout-turn-complete',ingested,steps,errors,continuation:state.continuation};
  }finally{release();}
}
