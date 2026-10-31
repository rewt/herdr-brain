// One finite service role. The record owns obligations; this checkpoint only
// orders fair work. No general pass lock, model call or native implementation.
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {loadEvents,writeFileAtomic,planTransaction} from '../lib/store.mjs';
import {bindCloseoutCode} from '../lib/closeout-code.mjs';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {retirementLock} from '../lib/retire-lock.mjs';
import {requireController,readOwnedRun} from '../lib/run-owner-guard.mjs';
import {currentCloseoutEntries,closeoutEvaluations,closeoutEvaluation,closeoutRevision,
  scheduleLineCloseouts,directCloseoutObservation,publishCloseoutEvents,lineServiceOwnsCleanup,unpublishedCloseoutSources,actionableCloseout} from '../lib/closeout.mjs';
import {closeoutNextStage,closeoutWait,closeoutWaitState,registerCloseoutWait,unresolvedGitRemoval} from '../lib/closeout-status.mjs';
import {queueOutcomeDecision,outcomeDecisionKey,obsoleteOutcomeDecision} from './outcome-decision.mjs';
import {recordCloseoutTurn} from './closeout-measurement.mjs';
import {missingCloseoutBinding} from '../lib/closeout-facts.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';
import {vacantAllocation} from '../lib/closeout-vacancy.mjs';
import {endedUnboundRun} from '../lib/closeout-unbound-ended.mjs';

export const closeoutServiceDirectory=(org,common)=>path.join(org,'line-service',createHash('sha256').update(JSON.stringify(common)).digest('hex').slice(0,20));
// Git removal alone may need its existing 600s inventory-sized allowance.
// Reserve another 120s for native exit, preservation and fresh guards. This
// finite role has its own allowance, independent of a general review pass.
export const CLOSEOUT_TURN_BUDGET_MS=720000;
export const CLOSEOUT_MIN_STEP_BUDGET_MS=120000;
function ingestEligible(run,state,identity,events) {
  const item=state.items.get(run?.item);
  if(!item||item.closed||run.report||run.abandoned||!run.report_path||
      !run.owner||run.owner.legacy||run.owner.controller!=='brain')return false;
  if(run.meta?.dispatch_project!==identity&&!events.some(e=>e.type==='run.started'&&e.id===run.id&&e.meta?.dispatch_project===identity))return false;
  // An earlier report is still useful while the current successor is unreported.
  return item.runs.at(-1)===run.id||!state.runs.get(item.runs.at(-1))?.report;
}
export function runCloseoutTurn(options) {
  const clock=options.clock??(()=>performance.now()),now=options.now??(()=>Date.now()),started=clock();
  let successor=false,contended=false;
  try{
    // Intake has its own finite owner. A retained closeout command must never
    // prevent the next scheduled wake from committing a finished report.
    const intake=options.reconcileReports===false?{}:runReportIntake(options),result=closeoutTurn({...options,intake});
    contended=Boolean(result.already_running);return result;
  }
  catch(error){
    // The old turn's finally has released every owner/native/record lock. Join
    // exactly one fresh physical-code process inside the ORIGINAL allowance;
    // it retains every original native intent and re-runs all mutation guards.
    if(error.code!=='CLOSEOUT_CODE_CHANGED')throw error;
    if(options.handoff===false)return{result:'closeout-code-handoff-pending',reason:'bounded fresh successor also changed; original obligations retained',old:error.binding,current:error.current};
    const remaining=(options.budgetMs??CLOSEOUT_TURN_BUDGET_MS)-(clock()-started);
    if(remaining<=0)return{result:'closeout-code-handoff-pending',reason:'original finite allowance spent',old:error.binding,current:error.current};
    const reply=options.cli('line-service/closeout.mjs',['--once','--repo',options.project.canonical,'--org',options.org,
      '--no-handoff','--deadline',String(Math.floor(now()+Math.max(1,remaining)))]);
    successor=true;const result=JSON.parse(reply);
    return{result:'closeout-code-handoff',old:error.binding,current:error.current,successor:result};
  }finally{
    // The successor writes the one census for a handed-off logical turn. Do
    // not spend its effect allowance on obsolete code's diagnostic inventory.
    if(!successor&&!contended)measureTurn(options);
  }
}
function measureTurn({project,org,env=process.env,now=()=>Date.now(),measure=recordCloseoutTurn}) {
  try{measure({project,org,env,now});}
  catch(error){try{fs.appendFileSync(path.join(closeoutServiceDirectory(org,project.identity),'closeout.log'),JSON.stringify({action:'closeout-measurement-failed',
    at:new Date(now()).toISOString(),reason:error.message})+'\n',{mode:0o600});}catch{/* Diagnostics cannot alter the turn result. */}}
}
export function runReportIntake({project,org,cli,guard,maxSteps=8,budgetMs=CLOSEOUT_TURN_BUDGET_MS,
  clock=()=>performance.now(),now=()=>Date.now(),fault=()=>{}}) {
  const directory=closeoutServiceDirectory(org,project.identity),file=path.join(directory,'report-intake.json');
  fs.mkdirSync(directory,{recursive:true});
  let release;
  try{release=retirementLock(path.join(directory,'report-intake.lock'));}
  catch(error){if(error.message.startsWith('locked:'))return{already_running:true};throw error;}
  try{
    guard();const code=bindCloseoutCode(project),started=clock();
    // Migrate only the fair intake cursor. The old checkpoint remains intact;
    // closeout and intake never write one another's scheduling authority.
    const legacy=path.join(directory,'closeout-turn.json');
    const own=fs.existsSync(file),previous=own?JSON.parse(fs.readFileSync(file,'utf8')):
      fs.existsSync(legacy)?JSON.parse(fs.readFileSync(legacy,'utf8')):null;
    if(previous&&(previous.schema!==(own?'line-report-intake/v1':'line-closeout-turn/v1')||previous.identity!==project.identity||previous.org!==org))throw Error('intake checkpoint identity changed');
    const state={schema:'line-report-intake/v1',identity:project.identity,org,attempt:previous?.attempt??0,ingest:previous?.ingest??{},
      failures:own?previous.failures??{}:{},alarm_signature:own?previous.alarm_signature:undefined};
    const save=()=>writeFileAtomic(file,JSON.stringify(state)+'\n',0o600);
    const read=()=>{guard();code.verify();const loaded=loadEvents(org);if(loaded.tornTail)throw Error('incomplete closeout record');return{events:loaded.events,state:fold(loaded.events)};};
    const observed=read();let ingested=0;const errors=[];
    const pending=[...observed.state.runs.values()].filter(r=>ingestEligible(r,observed.state,project.identity,observed.events)&&fs.existsSync(r.report_path))
      .sort((a,b)=>(state.ingest[a.id]??0)-(state.ingest[b.id]??0)||a.started.seq-b.started.seq);
    const pendingIds=new Set(pending.map(r=>r.id));
    for(const id of Object.keys(state.failures))if(!pendingIds.has(id))delete state.failures[id];
    for(const run of pending){
      if(clock()-started>=Math.min(15000,budgetMs/3)||ingested>=maxSteps)break;
      state.ingest[run.id]=++state.attempt;state.pending={stage:'ingest',run:run.id};save();fault('before-ingest');
      try{
        const current=read(),r=current.state.runs.get(run.id),item=current.state.items.get(r?.item);
        if(!r||!ingestEligible(r,current.state,project.identity,current.events))throw Error('run eligibility changed before bounded ingest');
        if(r.workspace&&fs.existsSync(r.workspace)&&gitProject(r.workspace).identity!==project.identity)throw Error('ingest allocation project identity changed');
        requireController(readOwnedRun(org,r.id,current.events),'brain');
        const start=current.events.find(e=>e.type==='run.started'&&e.id===r.id);
        if(r.owner?.legacy||r.meta.dispatch_project!==project.identity&&start?.meta?.dispatch_project!==project.identity)
          throw Error('original ingest project/claim is missing or foreign');
        cli('bin/org.mjs',['ingest',r.report_path,'--run',r.id,...(item.runs.at(-1)===r.id?['--if-current-run',r.id]:[])]);
        fault('after-ingest');
        delete state.failures[run.id];
      }catch(error){
        errors.push({run:run.id,stage:'ingest',reason:error.message});
        const prior=state.failures[run.id];
        state.failures[run.id]=prior?.reason===error.message?{...prior,turns:prior.turns+1}:
          {reason:error.message,turns:1,first_seen:new Date(now()).toISOString()};
      }
      ingested++;delete state.pending;save();
    }
    // Intake must expose its own failures even while the closeout owner is busy.
    // This checkpoint owns visibility only; diagnostics never invoke ingestion.
    const current=read();
    for(const id of Object.keys(state.failures))if(!ingestEligible(current.state.runs.get(id),current.state,project.identity,current.events))delete state.failures[id];
    const alarms=Object.entries(state.failures).filter(([,failure])=>failure.turns>=3).sort(([a],[b])=>a.localeCompare(b))
      .map(([run,failure])=>({run,stage:'ingest',reason:failure.reason,first_seen:failure.first_seen}));
    const signature=JSON.stringify(alarms);
    if(signature!==state.alarm_signature){
      if(alarms.length||state.alarm_signature&&state.alarm_signature!=='[]')fs.appendFileSync(path.join(directory,'closeout.log'),JSON.stringify({
        action:'report-intake-supervisor-alarm',at:new Date(now()).toISOString(),owner:'project-supervisor',count:alarms.length,
        scopes:alarms,authority:'visibility only; original holds and effects retained'})+'\n',{mode:0o600});
      state.alarm_signature=signature;
    }
    state.completed_at=new Date(now()).toISOString();state.errors=errors;state.remaining=Math.max(0,pending.length-ingested);save();
    return{ingested,errors,remaining:state.remaining,attempts:state.ingest};
  }finally{release();}
}
function closeoutTurn({project,org,cli,guard,env=process.env,maxSteps=8,budgetMs=CLOSEOUT_TURN_BUDGET_MS,intake={},
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
    let observed=read(),steps=0;const ingested=intake.ingested??0,errors=[...(intake.errors??[])];
    if(intake.attempts)state.ingest=intake.attempts; // compatibility diagnostic only
    const backlogStarted=clock();
    const backlog=reconcileCloseoutBacklog({project,org,events:observed.events,state:observed.state,expired,
      guard:()=>{guard();code.verify();}});
    state.backlog_reconcile_ms=Math.max(0,clock()-backlogStarted);
    // Re-publish exact committed envelopes only. No re-binding a namesake.
    const sources=unpublishedCloseoutSources(project.identity,org,observed.events);
    if(sources.length)publishCloseoutEvents({cwd:project.canonical,org,env,added:sources,start:false});
    // Old completion writers sometimes had no envelope at all. Type those
    // missing identities in a bounded batch without policy/native rediscovery
    // or a fictitious supervisor-recovery subscription. No executable key is
    // created; only the existing original-evidence refresh can bind a target.
    const boundRuns=new Set(observed.events.flatMap(e=>(e.closeout_targets??[]).filter(t=>t.common===project.identity&&t.panes?.length).map(t=>t.run)));
    const kept=new Set(observed.events.filter(e=>e.type==='closeout.binding-kept'&&e.identity===project.identity).map(e=>JSON.stringify([e.run,e.source])));
    const missing=[];
    for(const source of observed.events.toReversed()){
      if(missing.length>=maxSteps)break;
      const runId=source.type==='report.ingested'?source.run:source.type==='run.abandoned'?(source.run??source.id):source.type==='item.closed'?source.completed_run:null;
      const run=observed.state.runs.get(runId);
      if(!run||run.meta?.dispatch_project&&run.meta.dispatch_project!==project.identity||vacantAllocation(run,observed.events,project.identity)||boundRuns.has(runId)||kept.has(JSON.stringify([runId,{seq:source.seq,type:source.type}])))continue;
      missing.push(missingCloseoutBinding({project,org,source,run,signal:source.type==='item.closed'?'landed':'ready',events:observed.events}));
    }
    if(missing.length)planTransaction(org,current=>({add:missing.filter(row=>!current.some(e=>e.type===row.type&&e.key===row.key&&e.identity===row.identity))}),{actor:'finite missing-binding observation',replaySafe:true});
    fault('after-publication');
    let refreshed=false;
    const refresh=()=>{
      if(expired()||!lineServiceOwnsCleanup(project,org))return;
      refreshed=true;
      try{guard();cli('supervisor/closeout.mjs',['refresh','--repo',project.canonical,'--org',org,
        '--deadline',String(Math.floor(now()+Math.min(60000,budgetMs-(clock()-started))))]);}
      catch(error){if(error.code==='CLOSEOUT_CODE_CHANGED')throw error;errors.push({stage:'refresh',reason:error.message});}
    };
    // Ended binding-gated workers need finality before this turn selects cleanup.
    // Periodic priority also covers turns whose effects consume every second.
    // This is the same finite owner, not another executor or background loop.
    state.turn=(state.turn??0)+1;
    if(!expired()&&(state.turn%4===0||[...observed.state.runs.values()].some(r=>
        r.meta?.dispatch_project===project.identity&&endedUnboundRun(r,observed.events)))){
      try{guard();state.allocations=JSON.parse(cli('supervisor/closeout.mjs',['allocations','--repo',project.canonical,'--org',org,
        '--deadline',String(Math.floor(now()+Math.max(1,budgetMs-(clock()-started))))]));}
      catch(error){if(error.code==='CLOSEOUT_CODE_CHANGED')throw error;errors.push({stage:'allocations',reason:error.message});}
    }
    if(state.turn%4===0){refresh();observed=read();}
    // The finite owner also owns missing-producer/refusal visibility. Register
    // exact waits before selection; an owned next stage remains ordinary progress.
    if(!expired())planTransaction(org,events=>{
      guard();code.verify();
      const owned=currentCloseoutEntries(project.identity,org,events,{onInvalid:()=>{}});
      return{add:owned.flatMap(entry=>{
        if(entry.project!==project.canonical||entry.org!==org)return[];
        const prior=closeoutEvaluation(entry,events);
        return prior?registerCloseoutWait(entry,prior,events,owned):[];
      })};
    },{actor:'line-service',replaySafe:true});
    observed=read();
    const entries=currentCloseoutEntries(project.identity,org,observed.events,{onInvalid:()=>{}}),
      rows=closeoutEvaluations(project.identity,org,observed.events),evaluations=new Map(rows.map(e=>[e.key,e]));
    for(const entry of entries)if(entry.reportCloseout){const prior=closeoutEvaluation(entry,observed.events);if(prior)evaluations.set(entry.key,prior);else evaluations.delete(entry.key);}
    const knownDecisions=new Set([...observed.state.items.values()].map(i=>i.meta.uncertain_outcome?.key).filter(Boolean)),
      decisions=[],subjects=[];
    let existingDecisions=0;
    const eligible=entries.filter(entry=>{
      if(expired())return false;
      if(entry.project!==project.canonical||entry.org!==org)return false;
      const prior=evaluations.get(entry.key);if(prior?.completed)return false;
      const next=prior&&closeoutNextStage(entry,prior,observed.events,entries);
      const wait=prior&&closeoutWait(entry,prior,observed.events),status=closeoutWaitState(wait,observed.events);
      if(prior&&!next&&['defect','failed'].includes(status)){
        const key=`closeout:${entry.key}`;
        // Selection is read-only. Existing decisions already own these defects;
        // no per-defect native/source discovery or record fold is needed. New
        // decisions run after cleanup with their original fresh mutation guards.
        if(knownDecisions.has(outcomeDecisionKey(project.identity,org,key)))existingDecisions++;
        else decisions.push({entry,check:{key,
          subject:{item:entry.item,run:entry.run,key:entry.key,head:entry.head,source:entry.source},wait,status}});
        return false;
      }
      // Match the executor's admission before spending a finite step. Legacy
      // bindings and interrupted Git commands need their original evidence.
      if(!actionableCloseout(entry,observed.events)||unresolvedGitRemoval(entry,observed.events))return false;
      if(!prior)return true;
      if(directCloseoutObservation(entry,prior,observed.events))return true;
      if(next)return next.ready;
      return status==='complete'&&
        closeoutRevision(entry,observed.events,observed.state)>(prior.revision??0);
    });
    const scheduled=scheduleLineCloseouts(eligible,rows,{batch:true,attempts:state.targets,turn:state.turn,reportCursor:state.report_cursor});
    state.subjects=subjects;
    for(const {entry,sessionsOnly}of scheduled){
      if(expired()||steps>=maxSteps)break;
      // Do not spend the final seconds repeating a removal preflight that
      // cannot fit its own inventory allowance. Fairness gives this target a
      // fresh finite turn, rather than shrinking every target to the tail.
      if(budgetMs-(clock()-started)<Math.min(budgetMs,CLOSEOUT_MIN_STEP_BUDGET_MS))break;
      // Checkpoint before dispatch: crashes cannot keep selecting the oldest
      // kept target ahead of its independent peers. Native UNKNOWN stays owned
      // by the closer's exact original intent, never this scheduling checkpoint.
      state.targets[entry.key]=++state.attempt;
      if(entry.reportCloseout)state.report_cursor={seq:entry.source.seq,key:entry.key};
      state.pending={stage:'closeout',key:entry.key,source:entry.source};save();fault('before-closeout');
      try{
        guard();code.verify();
        const result=JSON.parse(cli('supervisor/closeout.mjs',['drain','--repo',project.canonical,'--org',org,
          '--keys',JSON.stringify([entry.key]),'--no-restart','--retry-safe','--deadline',String(Math.floor(now()+Math.max(1,budgetMs-(clock()-started)))),
          ...(sessionsOnly?['--sessions-only']:[])]));
        subjects.push({key:entry.key,run:entry.run,source:entry.source,
          status:result.restart?'source-handoff':result.already_running?'owned':result.evaluated?.length?'evaluated':'not-evaluated',
          evaluations:(result.evaluated??[]).map(({key,source,completed,reason,resources})=>({key,source,completed,
            ...(reason!==undefined?{reason}:{}),...(resources!==undefined?{resources}:{})}))});
        if(result.restart){save();throw Object.assign(Error('closer returned a guarded code handoff'),{code:'CLOSEOUT_CODE_CHANGED',binding:result.restart.old,current:result.restart.current});}
        state.last_result={key:entry.key,result};fault('after-closeout');
      }catch(error){if(error.code==='CLOSEOUT_CODE_CHANGED')throw error;errors.push({key:entry.key,stage:'closeout',reason:error.message});
        subjects.push({key:entry.key,run:entry.run,source:entry.source,status:'failed',reason:error.message});}
      steps++;delete state.pending;save();
    }
    // Reserve a bounded original-binding refresh even while direct keeps stay
    // eligible. Otherwise the old backlog can never acquire its first target.
    if(!refreshed)refresh();
    let decisionSteps=0;
    for(const {entry,check}of decisions){
      if(expired()||decisionSteps>=maxSteps)break;
      decisionSteps++;
      try{
        const current=read(),entries=currentCloseoutEntries(project.identity,org,current.events,{onInvalid:()=>{}}),
          evaluations=new Map(closeoutEvaluations(project.identity,org,current.events).map(e=>[e.key,e]));
        if(obsoleteOutcomeDecision({meta:{uncertain_outcome:{check}}},{events:current.events,entries,evaluations}))continue;
        queueOutcomeDecision({repo:project.canonical,org,env,owner:'closeout-turn',check});
      }catch(error){if(error.code==='CLOSEOUT_CODE_CHANGED')throw error;errors.push({key:entry.key,stage:'outcome-decision',reason:error.message});}
    }
    // One grouped diagnostic, deduplicated by unchanged scope/reason. Counting
    // kept turns never re-invokes or reads an unresolved native effect.
    const final=read(),latest=new Map(closeoutEvaluations(project.identity,org,final.events).map(e=>[e.key,e]));
    state.keeps??={};const alarms=[];
    for(const entry of entries){
      const row=entry.reportCloseout?closeoutEvaluation(entry,final.events):latest.get(entry.key);
      if(!row||row.completed){delete state.keeps[entry.key];continue;}
      const signature=JSON.stringify([entry.source,row.reason,row.resources]),prior=state.keeps[entry.key];
      const keep=state.keeps[entry.key]=prior?.signature===signature?{...prior,turns:prior.turns+1}:
        {signature,turns:1,first_seen:prior?.first_seen??row.condition?.first_seen??row.at??new Date(now()).toISOString()};
      const age=Math.max(0,now()-Date.parse(keep.first_seen));
      if(keep.turns>=3||age>=1800000)alarms.push({key:entry.key,run:entry.run,source:entry.source,reason:row.reason,
        kind:row.condition?.kind??'legacy-owner-evidence',owner:row.condition?.owner??entry.run,first_seen:keep.first_seen,
        continuation:row.condition?.continuation??{kind:'owner-evidence',owner:entry.run}});
    }
    const signature=JSON.stringify(alarms);
    if(signature!==state.alarm_signature){
      if(alarms.length||state.alarm_signature)fs.appendFileSync(path.join(directory,'closeout.log'),JSON.stringify({
        action:'closeout-supervisor-alarm',at:new Date(now()).toISOString(),owner:'project-supervisor',count:alarms.length,
        oldest:alarms.map(a=>a.first_seen).sort()[0]??null,scopes:alarms,authority:'visibility only; original holds and effects retained'})+'\n',{mode:0o600});
      state.alarm_signature=signature;
    }
    state.completed_at=new Date(now()).toISOString();state.errors=errors;state.continuation={
      ingest:intake.remaining??0,closeout:Math.max(0,scheduled.length-steps),decisions:decisions.length-decisionSteps,reconcile_committed_sources:true};
    save();fault('before-ack');
    return{result:'closeout-turn-complete',ingested,steps,backlog_classified:backlog.length,
      backlog_reconcile_ms:state.backlog_reconcile_ms,subjects,decisions:{existing:existingDecisions,attempted:decisionSteps},errors,continuation:state.continuation};
  }finally{release();}
}
