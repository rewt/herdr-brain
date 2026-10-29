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
    if(path.dirname(journal)!==path.join(org,'dispatch')||fs.realpathSync(journal)!==journal||!fs.lstatSync(journal).isFile())throw Error('original dispatch path is foreign or redirected');
    const bytes=fs.readFileSync(journal),job=JSON.parse(bytes);
    if(job.run!==run.id||job.common!==project.identity||job.repo!==project.canonical||job.org!==org||
      job.token!==run.meta.dispatch_attempt||path.basename(journal)!==`${job.token}.json`||
      job.ownership?.generation!==run.owner_generation||job.ownership?.owner?.controller!==run.owner?.controller)
      throw Error('original dispatch/run/project/claim differs');
    return{journal,sha256:createHash('sha256').update(bytes).digest('hex'),stage:job.stage,error:job.error??null,failure:job.failure??null,
      native_launch_attempted:job.native_launch_attempted??null,native_session_bound:Boolean(job.worker?.agentSessionId),
      prompt_binding:job.sessionBinding?.status??null,terminal_abandonment:job.terminal_abandonment??null,
      qualification:'Original saved dispatch observation; an error or unsent prompt is not allocation finality.'};
  }catch(error){return{journal,evidence_error:error.message};}
}

export function reconcileCloseoutBacklog({project,org,events,guard,maxRows=64}) {
  const targets=new Map();
  for(const source of events)for(const target of source.closeout_targets??[])
    if(target.common===project.identity&&target.org===org&&target.project===project.canonical)
      targets.set(JSON.stringify([target.key,{seq:source.seq,type:source.type}]),{...target,source:{seq:source.seq,type:source.type}});
  const classified=new Set(events.filter(e=>e.type==='closeout.wait-classified'&&e.identity===project.identity).map(e=>e.wait_id));
  const rows=[];
  for(const wait of events.filter(e=>e.type==='closeout.waiting'&&e.identity===project.identity)) {
    if(rows.length>=maxRows)break;
    if(classified.has(wait.wait_id)||closeoutWaitState(wait,events)==='complete')continue;
    const entry=targets.get(JSON.stringify([wait.key,wait.source]));if(!entry)continue;
    const prior=events.findLast(e=>e.type==='closeout.evaluated'&&ownsCloseoutFact(entry,e));
    if(!prior)continue;
    const uncertain=Boolean(unresolvedCloseoutEffect(entry,events)||unresolvedGitRemoval(entry,events));
    const condition=closeoutCondition(entry,prior,events,{uncertain});
    const actionable=actionableCloseout(entry,events);
    const next=!uncertain&&actionable&&closeoutNextStage(entry,prior,events,[...targets.values()]);
    // Existing genuine completion writers retain their subscriptions. Only
    // missing-writer defects or already terminal evaluations need reconciling.
    if(!wait.waiting.defect&&!uncertain&&!prior.completed&&!next)continue;
    const disposition=prior.completed?'evaluated':next?'continuation':'held';
    rows.push({type:'closeout.wait-classified',identity:project.identity,key:entry.key,run:entry.run,item:entry.item,
      source:entry.source,wait_id:wait.wait_id,wait_seq:wait.seq,evaluation_seq:prior.seq,disposition,
      binding:{schema:entry.schema,actionable},
      reason:prior.reason??'existing terminal evaluation',condition,resources:closeoutResources(entry,events,condition),
      owner:next?'lane-closeout':condition.owner,
      continuation:next?{kind:'owned-stage',owner:'lane-closeout',stage:next.stage,ready:next.ready}:condition.continuation,
      qualification:'Classification of retained original record evidence; no effect completion or new allocation authority.'});
  }
  // An unreported allocation is real active work, even if its pane looks idle.
  // The original dispatch owner must finalize/abandon it; time grants no close.
  const state=fold(events);
  for(const run of state.runs.values()) {
    if(rows.length>=maxRows)break;
    if(run.report||run.abandoned||!run.workspace||run.meta?.dispatch_project!==project.identity)continue;
    const dispatch=originalDispatch(run,project,org),disposition=dispatch?.error?'dispatch-error-unreported':'active-unreported';
    if(events.some(e=>e.type==='closeout.allocation-kept'&&e.identity===project.identity&&e.run===run.id&&e.started_seq===run.started.seq&&
      e.disposition===disposition&&JSON.stringify(e.dispatch??null)===JSON.stringify(dispatch)))continue;
    rows.push({type:'closeout.allocation-kept',identity:project.identity,run:run.id,item:run.item,cwd:run.workspace,
      started_seq:run.started.seq,claim_generation:run.owner_generation??null,disposition,owner:run.owner?.controller??run.id,dispatch,
      first_seen:run.started.at,reason:'No final report or authorized abandonment; original dispatch owner retains allocation.',
      continuation:{kind:'original-dispatch-finalization',journal:run.meta?.dispatch_journal??null},
      qualification:'No completion, abandonment or native close inferred from an idle pane or age.'});
  }
  if(!rows.length)return[];
  guard();
  return planTransaction(org,current=>{
    guard();
    return{add:rows.filter(row=>row.wait_id?
      current.some(e=>e.seq===row.wait_seq&&e.wait_id===row.wait_id&&e.identity===row.identity&&e.key===row.key&&JSON.stringify(e.source)===JSON.stringify(row.source))&&
        !current.some(e=>e.type===row.type&&e.identity===row.identity&&e.wait_id===row.wait_id):
      !current.some(e=>e.type===row.type&&e.identity===row.identity&&e.run===row.run&&e.started_seq===row.started_seq&&
        e.disposition===row.disposition&&JSON.stringify(e.dispatch??null)===JSON.stringify(row.dispatch??null)))};
  },{actor:'finite closeout backlog classification',replaySafe:true}).added;
}
