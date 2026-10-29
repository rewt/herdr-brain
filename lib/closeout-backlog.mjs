// Record-side reconciliation only. Classification never completes an effect,
// replaces an allocation, closes a decision or authorizes native/Git work.
import {planTransaction} from './store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fold} from './state.mjs';
import {closeoutCondition,closeoutResources,ownsCloseoutFact} from './closeout-facts.mjs';
import {unresolvedCloseoutEffect,actionableCloseout} from './closeout.mjs';
import {unresolvedGitRemoval,closeoutNextStage,closeoutWaitState} from './closeout-status.mjs';

function originalDispatch(run,project,org) {
  const journal=run.meta?.dispatch_journal;
  if(!journal)return null;
  try{
    // Resolve the owning org ancestor, not the dispatch directory or leaf:
    // org aliases are valid, but redirected journals/directories remain foreign.
    const original=path.join(fs.realpathSync(org),'dispatch',path.basename(journal));
    if(path.dirname(journal)!==path.join(org,'dispatch')||fs.realpathSync(journal)!==original||!fs.lstatSync(journal).isFile())throw Error('original dispatch path is foreign or redirected');
    const bytes=fs.readFileSync(journal),job=JSON.parse(bytes);
    if(job.run!==run.id||job.common!==project.identity||job.repo!==project.canonical||fs.realpathSync(job.org)!==fs.realpathSync(org)||
      job.token!==run.meta.dispatch_attempt||path.basename(journal)!==`${job.token}.json`||
      job.ownership?.generation!==run.owner_generation||job.ownership?.owner?.controller!==run.owner?.controller)
      throw Error('original dispatch/run/project/claim differs');
    return{journal,sha256:createHash('sha256').update(bytes).digest('hex'),stage:job.stage,error:job.error??null,failure:job.failure??null,
      native_launch_attempted:job.native_launch_attempted??null,native_session_bound:Boolean(job.worker?.agentSessionId),
      prompt_binding:job.sessionBinding?.status??null,terminal_abandonment:job.terminal_abandonment??null,
      qualification:'Original saved dispatch observation; an error or unsent prompt is not allocation finality.'};
  }catch(error){return{journal,evidence_error:error.message};}
}

const allocationId=row=>JSON.stringify([row.identity,row.run,row.started_seq]);
function allocationFact(row) {
  if(!row)return null;
  const d=row.dispatch;
  // Hash/stage/launch/binding progress describe the saved observation, not a
  // new retention reason. Keep significant error and ownership changes visible.
  return JSON.stringify([row.claim_generation??null,row.cwd,row.owner,row.disposition,
    d?.journal??null,d?.evidence_error??null,d?.error??null,d?.failure??null,d?.terminal_abandonment??null]);
}

export function reconcileCloseoutBacklog({project,org,events,state,guard,maxRows=64,expired=()=>false}) {
  if(expired())return[];
  const targets=new Map(),classified=new Map(),allocations=new Map(),waits=[];
  // Share the finite turn's allowance even when every wait is already
  // classified. Index preparation itself must not escape the deadline.
  for(const source of events){
    if(expired())return[];
    for(const target of source.closeout_targets??[]){
      if(expired())return[];
      if(target.common===project.identity&&target.org===org&&target.project===project.canonical)
        targets.set(JSON.stringify([target.key,{seq:source.seq,type:source.type}]),{...target,source:{seq:source.seq,type:source.type}});
    }
    if(source.identity!==project.identity)continue;
    if(source.type==='closeout.wait-classified')classified.set(source.wait_id,source);
    if(source.type==='closeout.allocation-kept')allocations.set(allocationId(source),source);
    if(source.type==='closeout.waiting')waits.push(source);
  }
  const rows=[];
  for(const wait of waits) {
    if(expired()||rows.length>=maxRows)break;
    if(closeoutWaitState(wait,events)==='complete')continue;
    const entry=targets.get(JSON.stringify([wait.key,wait.source]));if(!entry)continue;
    const prior=events.findLast(e=>e.type==='closeout.evaluated'&&ownsCloseoutFact(entry,e));
    if(!prior)continue;
    const uncertain=Boolean(unresolvedCloseoutEffect(entry,events)||unresolvedGitRemoval(entry,events));
    const condition=closeoutCondition(entry,prior,events,{uncertain});
    const actionable=actionableCloseout(entry,events);
    const next=actionable&&!unresolvedGitRemoval(entry,events)&&closeoutNextStage(entry,prior,events,[...targets.values()]);
    const binding={schema:entry.schema,actionable,...(next?{next}:{})},previous=classified.get(wait.wait_id);
    if(previous?.evaluation_seq===prior.seq&&JSON.stringify(previous.binding)===JSON.stringify(binding))continue;
    // Existing genuine completion writers retain their subscriptions. Only
    // missing-writer defects or already terminal evaluations need reconciling.
    if(!wait.waiting.defect&&!uncertain&&!prior.completed&&!next)continue;
    const disposition=prior.completed?'evaluated':next?'continuation':'held';
    rows.push({type:'closeout.wait-classified',identity:project.identity,key:entry.key,run:entry.run,item:entry.item,
      source:entry.source,wait_id:wait.wait_id,wait_seq:wait.seq,evaluation_seq:prior.seq,disposition,
      binding,
      reason:prior.reason??'existing terminal evaluation',condition,resources:closeoutResources(entry,events,condition),
      owner:next?'lane-closeout':condition.owner,
      continuation:next?{kind:'owned-stage',owner:'lane-closeout',stage:next.stage,ready:next.ready}:condition.continuation,
      qualification:'Classification of retained original record evidence; no effect completion or new allocation authority.'});
  }
  // An unreported allocation is real active work, even if its pane looks idle.
  // The original dispatch owner must finalize/abandon it; time grants no close.
  // The turn already folded this exact observation. Standalone callers keep
  // the fallback, but never start it after the shared allowance is spent.
  if(!expired()&&rows.length<maxRows)for(const run of (state??fold(events)).runs.values()) {
    if(expired()||rows.length>=maxRows)break;
    if(run.report||run.abandoned||!run.workspace||run.meta?.dispatch_project!==project.identity)continue;
    const dispatch=originalDispatch(run,project,org),disposition=dispatch?.error?'dispatch-error-unreported':'active-unreported';
    const row={type:'closeout.allocation-kept',identity:project.identity,run:run.id,item:run.item,cwd:run.workspace,
      started_seq:run.started.seq,claim_generation:run.owner_generation??null,disposition,owner:run.owner?.controller??run.id,dispatch,
      first_seen:run.started.at,reason:'No final report or authorized abandonment; original dispatch owner retains allocation.',
      continuation:{kind:'original-dispatch-finalization',journal:run.meta?.dispatch_journal??null},
      qualification:'No completion, abandonment or native close inferred from an idle pane or age.'};
    if(allocationFact(allocations.get(allocationId(row)))===allocationFact(row))continue;
    rows.push(row);
  }
  if(!rows.length)return[];
  // Finish the bounded batch's original CAS/guarded append even if its final
  // observation used the tail of the allowance. Do not discard partial progress
  // or skip commit-time validation; the next wait/allocation starts next turn.
  guard();
  return planTransaction(org,current=>{
    guard();
    // Match planning against the latest committed row: an older matching
    // binding must not suppress a return to it after an intervening change.
    const latest=new Map(current.filter(e=>e.type==='closeout.wait-classified'&&e.identity===project.identity).map(e=>[e.wait_id,e]));
    const kept=new Map(current.filter(e=>e.type==='closeout.allocation-kept'&&e.identity===project.identity).map(e=>[allocationId(e),e]));
    return{add:rows.filter(row=>row.wait_id?
      current.some(e=>e.seq===row.wait_seq&&e.wait_id===row.wait_id&&e.identity===row.identity&&e.key===row.key&&JSON.stringify(e.source)===JSON.stringify(row.source))&&
        !(latest.get(row.wait_id)?.evaluation_seq===row.evaluation_seq&&JSON.stringify(latest.get(row.wait_id).binding)===JSON.stringify(row.binding)):
      allocationFact(kept.get(allocationId(row)))!==allocationFact(row))};
  },{actor:'finite closeout backlog classification',replaySafe:true}).added;
}
