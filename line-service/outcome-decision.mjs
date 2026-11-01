// Missing completion producers and native refusals are ordinary record work.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {transact,loadRecord} from '../lib/store.mjs';
import {nextItemId} from '../lib/state.mjs';
import {intentFirstCreation} from '../lib/dispatch-template.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {serviceRecordBinding} from './record-inbox.mjs';
import {uncertainOutcomeDoctrine} from '../lib/uncertain-outcome.mjs';
import {closeoutNextStage,closeoutWait,closeoutWaitState} from '../lib/closeout-status.mjs';
import {currentCloseoutEntries,closeoutEvaluation,closeoutEvaluations} from '../lib/closeout.mjs';
import {recordOnlyJudgment} from './decision-policy.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const outcomeDecisionKey=(identity,org,key)=>createHash('sha256').update(JSON.stringify([identity,org,key])).digest('hex');

// Match the finite turn, including record-only report targets and their exact
// source evaluation. A later report cannot inherit an older source's completion.
function currentView(identity,org,events,options) {
  const entries=currentCloseoutEntries(identity,org,events,options),
    evaluations=new Map(closeoutEvaluations(identity,org,events).map(e=>[e.key,e]));
  for(const entry of entries)if(entry.reportCloseout){
    const prior=closeoutEvaluation(entry,events);
    if(prior)evaluations.set(entry.key,prior);else evaluations.delete(entry.key);
  }
  return {events,entries,evaluations};
}

// Admission and idle diagnosis observe the same queued cleanup policy. Cache
// only within one scan; a fresh event snapshot refreshes its cleanup view.
export function observeOutcomeDecisions({identity,org}) {
  let view;
  return (item,{events})=>{
    if(!item?.meta?.uncertain_outcome)return null;
    if(view?.events!==events)view=currentView(identity,org,events,{onInvalid:()=>{}});
    return obsoleteOutcomeDecision(item,view);
  };
}

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
export function queueOutcomeDecision({repo,org,env,check,owner='pass'}) {
  if(owner!=='pass'&&(owner!=='closeout-turn'||!check.key.startsWith('closeout:')))throw Error('finite closeout owner may queue only closeout decisions');
  const binding=serviceRecordBinding({repo,org,env,owner}),key=outcomeDecisionKey(binding.identity,org,check.key);
  const guard=()=>{
    serviceRecordBinding({repo,org,env,owner});
    for(const file of [path.join(binding.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents outcome decision');
  };
  const find=state=>[...state.items.values()].find(i=>i.meta.uncertain_outcome?.key===key);
  guard();
  const observed=loadRecord(org);
  if(observed.tornTail)throw Error('incomplete record tail; retain original outcome decision');
  const prior=find(observed.state);
  // Returning an existing durable decision is a read, including a closed one.
  // Do not contend for the append lock on every unchanged legacy defect. New
  // decisions still use the original single-shot guarded no-recovery append.
  if(prior)return{item:prior.id,key};
  return transact(org,(events,state)=>{
    guard();
    const existing=find(state);
    if(existing)return {add:[],result:{item:existing.id,key}};
    // Keep the captured proposal and deduplication owner, but never select work
    // that admission already knows cannot run. Close the exact proposal using
    // existing record events: later policy changes, source requeues or reopened
    // ancestors must not revive it. A fresh, current defect remains ordinary work.
    const reason=recordOnlyJudgment({meta:{uncertain_outcome:{check}}})
      ? 'automatic review/dispatch outcome judgments are retired'
      : !check.key.startsWith('closeout:')?null:obsoleteOutcomeDecision({meta:{uncertain_outcome:{check}}},
        currentView(binding.identity,org,events,{keys:[check.subject.key]}));
    const id=nextItemId(state,{kind:'work',role:'decision'});
    const mutation={add:[intentFirstCreation({type:'item.added',id,kind:'work',role:'decision',title:'Resolve a missing completion producer or recorded refusal',
      ...(state.items.has(check.subject.item)?{parent:check.subject.item}:{}),
      accept:['Inspect the captured subject, actual producer and recorded status. Return one normal decision report with a concrete next step; zero suites, source edits, native effects or authority to clear a refusal. '+uncertainOutcomeDoctrine],
      meta:{route:'unblock',queue_selected:!reason,uncertain_outcome:{key,check:structuredClone(check)},
        ...(reason?{outcome_disposition:{status:'retired',reason,owner:check.subject.run??check.subject.item??'line-service'}}:{}),
        purpose:'Resolve this exact completion defect; independent subjects continue.',scope:JSON.stringify(check.subject),evidence:JSON.stringify(check)}}),
      ...(reason?[{type:'item.closed',id,as:'dropped',note:`Retired exact outcome proposal: ${reason}. Original subject, evidence and effect owner remain authoritative; no completion or refusal clearance is attested.`}]:[])],result:{item:id,key}};
    return protectRecordMutation({org,state,events,command:'queue outcome decision',mutation});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;
}
