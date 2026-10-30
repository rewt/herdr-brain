// Read-only policy inspection and subject projection shared by all line starts.
import fs from 'node:fs';
import {parseArgs,isMain} from '../lib/cli-help.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {reviewAdmissionHold} from '../lib/review-admission.mjs';
import {ordinaryAdmissionHold,validateOrdinaryAdmission} from '../lib/ordinary-admission.mjs';
import {producerGroupKey} from './review-group.mjs';
import {isQueueReview} from './review-queue.mjs';
import {roleIs} from '../lib/roles.mjs';
import {gitProject} from '../lib/project.mjs';
import {findOrgDir,loadRecord} from '../lib/store.mjs';
import {discoverChanges} from './phase1.mjs';
import {itemStatus} from '../lib/state.mjs';
import {queueSelected} from './priority-order.mjs';

export const readReviewAdmission=(repo,env=process.env)=>readProjectPolicy(repo,'lane',env).config.review_admission??{enabled:false};
export const readOrdinaryAdmission=(repo,env=process.env)=>readProjectPolicy(repo,'lane',env).config.ordinary_admission??{selected_only:false};
export function reviewAdmissionSubject({item,run,target,selector}={}){
  if(selector?.startsWith('canonical:'))return{kind:'canonical',selector:selector.slice('canonical:'.length)};
  if(isQueueReview(item)){
    target=item.meta.review_target;
    if(target?.evidence_kind==='canonical-unattributed/v1')return{kind:'canonical',selector:target.head};
    const key=target?.source_group?.key??producerGroupKey(item.meta.review_source_item,item.meta.review_source_run,target?.reportHash);
    return{kind:key?'producer':'unknown',selector:key};
  }
  if(target)return{kind:'producer',selector:target.source_group?.key??producerGroupKey(item?.id,run?.id,target.reportHash)};
  return{kind:roleIs(item,'REV')?'unknown':'ordinary',selector:item?.id};
}

export function inspectReviewAdmission({repo,org,env=process.env,ordinaryPolicy}){
  const project=gitProject(repo,{env});repo=project.canonical;
  const own=findOrgDir({cwd:repo,env:{...env,ORG_DIR:''}});
  if(!own||org&&fs.realpathSync(org)!==fs.realpathSync(own))throw Error('review admission inspection requires the owning project record');
  org=fs.realpathSync(own);
  const {events,state,tornTail}=loadRecord(org);if(tornTail)throw Error('incomplete record tail');
  const policy=readReviewAdmission(repo,env),ordinary_admission=ordinaryPolicy===undefined?readOrdinaryAdmission(repo,env):validateOrdinaryAdmission(ordinaryPolicy),discovered=discoverChanges({events,state,repo,org,identity:project.identity});
  const row=(stage,subject,fields)=>({...fields,stage,...subject,hold:reviewAdmissionHold(policy,subject)});
  return{schema:'review-admission-view/v1',project:project.identity,repo,org,policy,ordinary_admission,ordinary_admission_preview:ordinaryPolicy!==undefined,
    candidates:[...discovered.changes.map(c=>row('queue',reviewAdmissionSubject(c),{item:c.item.id,run:c.run.id,head:c.target.head})),
      ...(discovered.unattributed??[]).map(c=>row('queue',reviewAdmissionSubject(c),{head:c.target.head})),
      ...[...state.items.values()].filter(i=>!i.closed&&isQueueReview(i)).map(item=>row('launch',reviewAdmissionSubject({item}),{item:item.id,head:item.meta.review_target?.head})),
      ...[...state.items.values()].filter(i=>!i.closed&&!roleIs(i,'REV')&&i.kind!=='goal'&&(ordinary_admission.selected_only||queueSelected(i)&&itemStatus(state,i.id)==='ready')).map(item=>({
        ...row('launch',reviewAdmissionSubject({item}),{item:item.id}),status:itemStatus(state,item.id),selected:queueSelected(item,state,ordinary_admission),
        hold:reviewAdmissionHold(policy,{kind:'ordinary'})??ordinaryAdmissionHold(ordinary_admission,{item,state})}))],
    source_holds:discovered.holds,qualification:'Read-only selection projection. Allowed does not imply native readiness, permission, test coverage or a verdict.'};
}

if(isMain(import.meta.url)){
  const {values}=parseArgs({options:{repo:{type:'string'},org:{type:'string'},'ordinary-admission':{type:'string'}}});
  process.stdout.write(JSON.stringify(inspectReviewAdmission({repo:values.repo??process.cwd(),org:values.org,ordinaryPolicy:values['ordinary-admission']===undefined?undefined:JSON.parse(values['ordinary-admission'])}),null,2)+'\n');
}
