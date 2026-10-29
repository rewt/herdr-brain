// Record-side reconciliation only. Classification never completes an effect,
// replaces an allocation, closes a decision or authorizes native/Git work.
import {planTransaction} from './store.mjs';
import {fold} from './state.mjs';
import {closeoutCondition,closeoutResources,ownsCloseoutFact} from './closeout-facts.mjs';
import {unresolvedCloseoutEffect} from './closeout.mjs';
import {unresolvedGitRemoval,closeoutNextStage,closeoutWaitState} from './closeout-status.mjs';

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
    const next=!uncertain&&closeoutNextStage(entry,prior,events,[...targets.values()]);
    // Existing genuine completion writers retain their subscriptions. Only
    // missing-writer defects or already terminal evaluations need reconciling.
    if(!wait.waiting.defect&&!uncertain&&!prior.completed&&!next)continue;
    const disposition=prior.completed?'evaluated':next?'continuation':'held';
    rows.push({type:'closeout.wait-classified',identity:project.identity,key:entry.key,run:entry.run,item:entry.item,
      source:entry.source,wait_id:wait.wait_id,wait_seq:wait.seq,evaluation_seq:prior.seq,disposition,
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
    if(run.report||run.abandoned||!run.workspace||run.meta?.dispatch_project!==project.identity||
      events.some(e=>e.type==='closeout.allocation-kept'&&e.identity===project.identity&&e.run===run.id&&e.started_seq===run.started.seq))continue;
    rows.push({type:'closeout.allocation-kept',identity:project.identity,run:run.id,item:run.item,cwd:run.workspace,
      started_seq:run.started.seq,claim_generation:run.owner_generation??null,disposition:'active-unreported',owner:run.owner?.controller??run.id,
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
      !current.some(e=>e.type===row.type&&e.identity===row.identity&&e.run===row.run&&e.started_seq===row.started_seq))};
  },{actor:'finite closeout backlog classification',replaySafe:true}).added;
}
