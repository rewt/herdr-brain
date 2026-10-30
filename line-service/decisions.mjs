// Fresh judgment is ordinary record work. Only the existing line owns effects.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {transact,loadRecord} from '../lib/store.mjs';
import {nextItemId,ancestors,itemStatus,releases,isDeclined} from '../lib/state.mjs';
import {roleIs} from '../lib/roles.mjs';
import {intentFirstCreation} from '../lib/dispatch-template.mjs';
import {readReport} from '../lib/report.mjs';
import {readOwnedRun,requireController,assertOwner,ownerBinding} from '../lib/run-owner-guard.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {bindCloseoutSources,publishCloseoutEvents} from '../lib/closeout.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {itemLaunchHold} from '../lib/item-launch-hold.mjs';
import {loadDiscoveredRoutes,resolveLaunchRoute} from '../lanes/routes.mjs';
import {blockedChangeKey} from './phase1.mjs';
import {queueSelected,queuePolicy} from './priority-order.mjs';
import {serviceRecordBinding} from './record-inbox.mjs';
import {lineDirectory} from './cutoff.mjs';
import {parseArgs,isMain} from '../lib/cli-help.mjs';

const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
export const decisionHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const git=(cwd,args,encoding='utf8')=>execFileSync('git',['--no-optional-locks','-C',cwd,...args],{encoding,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});
const readGit=(cwd,args)=>git(cwd,args).trim();
export const decisionReserved=new Set(['security','funds-and-chain','publish','delete-data','licensing','priorities','identity','native-refusal','operator-design']);
const reserved=i=>i.role==='human'||i.meta.operator_reserved||i.meta.reserved||decisionReserved.has(i.meta.category);
export const isDecision=item=>roleIs(item,'DEC')&&item.meta.decision_request?.schema==='line-decision/v1';
const active=(events,identity,org)=>events.findLast(e=>['line.decisions-activated','line.decisions-deactivated'].includes(e.type)&&e.project===identity&&e.org===org);
export function decisionActivation(events,identity,org){const e=active(events,identity,org);return e?.type==='line.decisions-activated'?e:null;}

export function decisionRoute(config,{failedFamily}={}) {
  if(!failedFamily){const route=resolveLaunchRoute(config,{route:'unblock'});if(route.kind!=='codex')throw Error('provisional decision route must be the supported Codex unblock route');return 'unblock';}
  // Use only a configured supported route; never synthesize a new executor.
  const route=Object.keys(config.routes??{}).find(name=>name==='review'&&resolveLaunchRoute(config,{route:name}).kind!==failedFamily);
  if(!route)throw Error('one other-family decision reframe route is unavailable; park');return route;
}
function relatedLinks(state,id){return state.links.filter(l=>l.blocked===id||l.blocker===id).filter(l=>!isDecision(state.items.get(l.blocker)));}
export function decisionCapture({state,events,item,activation}) {
  const run=state.runs.get(item?.runs.at(-1));
  if(!activation||!item||item.closed||!queueSelected(item)||itemLaunchHold(state,item.id)||reserved(item)||isDecision(item)||!run?.report||run.abandoned||!['blocked','needs_human','failed'].includes(run.report.outcome))return null;
  if(activation.subjects?.length&&!activation.subjects.includes(item.id))return null;
  if(!run.owner||run.owner.legacy||run.owner.controller!=='brain')return null;
  // A pending reserved question is a mechanical wait: its own blocker and notes
  // must not become a new intent, judge or second human question.
  if(state.links.some(l=>l.blocked===item.id&&(q=>q&&!q.closed&&(q.role==='human'||q.meta.operator_reserved))(state.items.get(l.blocker))))return null;
  // `record ask --wait --parent` questions carry no link: pending, or answered
  // no after this report, they hold the subject the same way.
  if([...state.items.values()].some(q=>q.parent===item.id&&roleIs(q,'HUM')&&(!q.closed||isDeclined(q)&&q.closed.seq>(run.report.seq??0))))return null;
  const ownDecisionIds=new Set([...state.items.values()].filter(isDecision).map(i=>i.id));
  const inputs=events.filter(e=>!ownDecisionIds.has(e.id)&&!ownDecisionIds.has(e.blocker));
  let brief=null;try{brief=bytesHash(fs.readFileSync(run.brief_path));}catch{}
  if(run.report.outcome==='blocked'&&blockedChangeKey({events:inputs,state,item,run,brief}))return null; // existing restart rule owns it
  const links=relatedLinks(state,item.id),lineage=ancestors(state,item.id);
  // Safety/delegation categories on ancestors fence the subject too.
  if(lineage.some(reserved))return null;
  const intent={subject:{id:item.id,title:item.title,accept:item.accept,role:item.role,capability:item.capability,parent:item.parent,meta:item.meta,notes:item.notes,closed:item.closed},
    ancestors:lineage.map(i=>({id:i.id,title:i.title,accept:i.accept,meta:i.meta,notes:i.notes,closed:i.closed})),policy:queuePolicy(state),links,
    dependencies:links.map(l=>state.items.get(l.blocker===item.id?l.blocked:l.blocker)),
    run:{id:run.id,owner:run.owner,generation:run.owner_generation,report:run.report.sha256,report_seq:run.report.seq,brief,workspace:run.workspace}};
  const key=decisionHash([activation.seq,intent]);
  return {schema:'line-decision/v1',key,premise:decisionHash([item.id,item.title,item.accept,run.report.blockers]),activation:activation.seq,subject:item.id,run:run.id,intent,allowed:['reopen','reshape','supersede','park','ask_operator']};
}
export function decisionCandidates({state,events,identity,org}) {
  const activation=decisionActivation(events,identity,org);if(!activation)return [];
  return [...state.items.values()].map(item=>decisionCapture({state,events,item,activation})).filter(Boolean).filter(request=>
    ![...state.items.values()].some(i=>isDecision(i)&&i.meta.decision_request.key===request.key));
}
export function decisionQueueMutation({state,events,request,config,archive}) {
  const existing=[...state.items.values()].filter(i=>isDecision(i)&&i.meta.decision_request.key===request.key);
  if(existing.length)return {add:[],result:{existing:true,item:existing[0].id}};
  if([...state.items.values()].some(i=>isDecision(i)&&!i.closed&&i.meta.decision_request.subject===request.subject))throw Error('subject has a pending/ambiguous decision; retain its original attempt');
  const previous=events.filter(e=>e.type==='decision.applied'&&e.premise===request.premise&&e.restart_required);
  if(previous.length>=2)throw Error('same-premise answers exhausted; park subject for a new contract');
  const id=nextItemId(state,{kind:'work',role:'decision'}),route=decisionRoute(config,previous.length?{failedFamily:previous.at(-1).family??'codex'}:{});
  return {add:[intentFirstCreation({type:'item.added',id,kind:'work',role:'decision',parent:request.subject,title:`Decide blocked work: ${state.items.get(request.subject).title}`,priority:state.items.get(request.subject).priority,
    accept:['Return one typed decision report on the immutable request. Zero suites, source edits, lifecycle or outward actions.'],meta:{decision_request:request,decision_archive:archive,route,queue_selected:true}}),
    {type:'link.added',blocker:id,blocked:request.subject}],result:{item:id,key:request.key}};
}
export function decisionBrief(item) {
  const r=item.meta.decision_request;
  return `# Fresh decision on ${r.subject}\n\nRead the FULL immutable request and evidence: ${item.meta.decision_archive.file}\nArchive SHA256: ${item.meta.decision_archive.sha256}\nSubject ${r.subject}; original run ${r.run}; intent ${r.key}.\nReturn one ordinary report. Its front matter must contain a decision mapping:\n\ndecision:\n  version: 1\n  key: ${r.key}\n  action: reopen\n  category: design\n  reason: State the premise, confidence, falsifying observation and recommended concrete next step.\n\nAllowed actions: ${r.allowed.join(', ')}. reshape additionally accepts title and accept; supersede requires successor; ask_operator requires question and recommend with a reserved category. Never perform the answer yourself. The consumer rechecks current intent, claims, source/native ownership and STOP/HOLD. Unknown starts and native refusals are retained. No review or model calls, no tests.\n`;
}
export function typedDecision(report,request) {
  const answer=report.extra?.decision;
  if(report.outcome!=='done'||!answer||Array.isArray(answer)||answer.version!==1||answer.key!==request.key||!request.allowed.includes(answer.action)||typeof answer.reason!=='string'||!answer.reason.trim())throw Error('decision report needs one typed answer bound to the captured intent');
  const keys=new Set(['version','key','action','category','reason',...(answer.action==='reshape'?['title','accept']:answer.action==='supersede'?['successor']:answer.action==='ask_operator'?['question','recommend']:[])]);
  if(Object.keys(answer).some(k=>!keys.has(k)))throw Error('decision answer contains unsupported effects');
  if(answer.action==='ask_operator'){
    if(!decisionReserved.has(answer.category)||!answer.question?.trim()||!['yes','no'].includes(answer.recommend))throw Error('operator question needs an explicit reserved category, question and recommendation');
  }else if(!['design','prover','tooling','goals','other'].includes(answer.category))throw Error('reserved action cannot be automatically applied');
  if(answer.action==='reshape'&&(!answer.title&&!answer.accept||answer.title!==undefined&&(typeof answer.title!=='string'||!answer.title.trim())||answer.accept!==undefined&&(!Array.isArray(answer.accept)||!answer.accept.length||answer.accept.some(t=>typeof t!=='string'||!t.trim()))))throw Error('reshape requires a concrete title or acceptance list');
  if(answer.action==='supersede'&&typeof answer.successor!=='string')throw Error('supersede needs an exact successor');
  return answer;
}
export function decisionApplyMutation({state,events,item,answer,archive,activation}) {
  const r=item.meta.decision_request,run=state.runs.get(item.runs.at(-1));
  const prior=events.find(e=>e.type==='decision.applied'&&e.key===r.key);if(prior)return{add:[],result:{existing:true,applied:prior.seq}};
  if(!run?.report||item.closed||itemLaunchHold(state,item.id)||!same(typedDecision(run.report,r),answer))throw Error('decision report/hold changed');
  const subject=state.items.get(r.subject),capture=decisionCapture({state,events,item:subject,activation});
  if(!capture||!same(capture,r))throw Error('decision current intent/run/claim/HOLD changed; stale answer retained');
  if(!archive?.file||!archive.sha256)throw Error('decision application requires its exact recovery archive');
  const add=[],changes=[];
  const update=(id,fields)=>add.push({type:'item.updated',id,fields});
  if(answer.action==='reshape')update(subject.id,{...(answer.title?{title:answer.title}:{}),...(answer.accept?{accept:answer.accept}:{})});
  if(['reopen','reshape'].includes(answer.action))add.push({type:'item.reopened',id:subject.id,note:answer.reason});
  if(answer.action==='park')update(subject.id,{meta:{hold:true,hold_reason:answer.reason,decision_hold:r.key}});
  if(answer.action==='supersede'){
    const successor=state.items.get(answer.successor);
    if(!successor||successor.id===subject.id||successor.closed||itemLaunchHold(state,successor.id)||reserved(successor)||isDecision(successor)||!queueSelected(successor)||ancestors(state,successor.id).some(i=>i.id===subject.id))throw Error('supersede successor is missing, held, reserved, descendant or unselected; park');
    if(!archive.source)throw Error('supersede requires an exact recoverable source archive; park');
    // Transfer every incoming/outgoing unfinished dependency; closure cannot
    // silently release dependents or discard unfinished prerequisites.
    const links=relatedLinks(state,subject.id);
    for(const link of links){
      if(link.blocker===successor.id||link.blocked===successor.id)throw Error('successor dependency would become self-referential; park');
      const other=state.items.get(link.blocker===subject.id?link.blocked:link.blocker);
      if(!other||releases(state,other.id,itemStatus(state,other.id)))continue;
      const moved={blocker:link.blocker===subject.id?successor.id:link.blocker,blocked:link.blocked===subject.id?successor.id:link.blocked};
      const seen=new Set(),visit=id=>{if(id===moved.blocker)return true;if(seen.has(id))return false;seen.add(id);return state.links.filter(l=>l.blocker===id&&l.blocker!==subject.id&&l.blocked!==subject.id).some(l=>visit(l.blocked));};
      if(visit(moved.blocked))throw Error('dependency transfer would create a cycle; park');
      add.push({type:'link.removed',blocker:link.blocker,blocked:link.blocked});
      if(!state.links.some(l=>l.blocker===moved.blocker&&l.blocked===moved.blocked))add.push({type:'link.added',...moved});
    }
    update(subject.id,{meta:{superseded_by:successor.id}});
    add.push({type:'item.closed',id:subject.id,as:'dropped',note:`Recoverably superseded by ${successor.id}: ${answer.reason}`});
  }
  if(answer.action==='ask_operator'){
    const id=nextItemId(state,{kind:'work',role:'human'});
    add.push(intentFirstCreation({type:'item.added',id,kind:'work',role:'human',title:answer.question,why:answer.reason,parent:subject.id,meta:{operator_reserved:true,category:answer.category,decider:'brain-chat',recommend:answer.recommend,decision_key:r.key}}),
      {type:'note.added',id,text:answer.reason,kind:'why'},{type:'link.added',blocker:id,blocked:subject.id});
  }
  add.push({type:'note.added',id:subject.id,text:answer.reason,decision:true,kind:'delegated-answer'},
    {type:'item.closed',id:item.id,as:'done',completed_run:run.id,note:'Typed answer applied; consequence remains to be observed.'});
  // Explicit restart marker is narrow and typed; never impersonate a human to
  // bypass phase1's exclusion of incidental service-authored changes.
  if(['reopen','reshape'].includes(answer.action))add.push({type:'decision.restart',id:subject.id,run:r.run,key:r.key,decision:item.id,report_sha256:state.runs.get(r.run).report.sha256});
  for(const id of new Set([subject.id,...add.filter(e=>e.type.startsWith('link.')).flatMap(e=>[e.blocker,e.blocked])]))if(state.items.has(id))changes.push({id});
  add.push({type:'decision.applied',id:subject.id,decision:item.id,judge_run:run.id,key:r.key,action:answer.action,premise:r.premise,family:run.meta.harness,archive,changes,link_changes:add.filter(e=>e.type.startsWith('link.')),restart_required:['reopen','reshape'].includes(answer.action)});
  return{add,result:{applied:true,key:r.key,action:answer.action}};
}

function immutable(file,bytes){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)){if(!fs.lstatSync(file).isFile()||fs.realpathSync(file)!==file||!fs.readFileSync(file).equals(Buffer.from(bytes)))throw Error('immutable decision evidence differs');}
  else {const fd=fs.openSync(file,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  return {file,sha256:bytesHash(bytes)};
}
function evidence(org,run){
  const file=path.resolve(org,run.report.file);if(!file.startsWith(org+path.sep)||fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile())throw Error('immutable report path is foreign/redirected');
  const bytes=fs.readFileSync(file,'utf8');if(bytesHash(bytes)!==run.report.sha256)throw Error('immutable report bytes changed');return bytes;
}
function boundaries(binding){
  for(const file of [path.join(binding.directory,'STOP'),path.join(binding.repo,'.lane/supervisor/STOP'),path.join(binding.repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents decision effect');
}
function sourceProof(run,identity){
  if(!run.workspace)throw Error('subject source ownership is UNKNOWN');
  // gitProject through ownership validation also checks the real common dir.
  const owned=readOwnedRun(identity.org,run.id);requireController(owned,'brain');assertOwner(owned,ownerBinding(run));
  if(owned.owner.release.identity&&owned.owner.release.identity!==identity.identity)throw Error('foreign subject source owner');
  const raw=readGit(run.workspace,['rev-parse','--git-common-dir']),common=fs.realpathSync(path.resolve(run.workspace,raw));
  if(common!==identity.identity||readGit(run.workspace,['status','--porcelain=v1','--untracked-files=all']))throw Error('subject source is foreign or dirty; preserve original owner');
  return {workspace:run.workspace,head:readGit(run.workspace,['rev-parse','HEAD']),common};
}
function judgeProof(run,state,binding,native){
  const owned=readOwnedRun(binding.org,run.id);requireController(owned,'brain');assertOwner(owned,ownerBinding(run));
  const w=effectiveWorkerIdentity(run,state),n=native(['agent','get',w.agent]).agent;
  if(w.identity_conflict||!n||n.name!==w.agent||n.pane_id!==w.pane||n.workspace_id!==w.worker_workspace||n.terminal_id!==w.terminal_id||!w.agent_session_id||n.agent_session?.value!==w.agent_session_id||fs.realpathSync(n.cwd)!==fs.realpathSync(run.workspace))throw Error('judge native ownership changed/UNKNOWN; retain original attempt');
  sourceProof(run,binding);return ownerBinding(run);
}
export function queueDecision({repo,org,request,env=process.env}){
  const binding=serviceRecordBinding({repo,org,env});boundaries(binding);
  return transact(org,(events,state)=>{
    const fresh=serviceRecordBinding({repo,org,env});boundaries(fresh);
    const capture=decisionCapture({state,events,item:state.items.get(request.subject),activation:decisionActivation(events,fresh.identity,org)});
    if(!same(capture,request))throw Error('decision subject changed before creation');
    const run=state.runs.get(request.run),source=sourceProof(run,fresh),report=evidence(org,run);
    const packet={request,source,report,contract:state.items.get(request.subject),attempts:state.items.get(request.subject).runs.map(id=>{const r=state.runs.get(id);return {id,owner:r?.owner,generation:r?.owner_generation,report:r?.report,notes:r?.notes};}),ledger:events.filter(e=>(e.id===request.subject||e.run===request.run)&&['note.added','decision.failed','decision.applied'].includes(e.type))};
    const archive=immutable(path.join(org,'evidence','decisions',request.key,'request.json'),JSON.stringify(packet,null,2)+'\n');
    return protectRecordMutation({org,state,events,command:'line decision queue',mutation:decisionQueueMutation({state,events,request,config:loadDiscoveredRoutes({cwd:repo,env}).config,archive})});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;
}
export function applyDecision({repo,org,itemId,env=process.env,native}){
  const binding=serviceRecordBinding({repo,org,env});boundaries(binding);
  const result=transact(org,(events,state)=>{
    const fresh=serviceRecordBinding({repo,org,env});boundaries(fresh);
    const item=state.items.get(itemId);if(!isDecision(item))throw Error('not a captured decision');
    const request=item.meta.decision_request;
    if(events.some(e=>e.type==='decision.applied'&&e.key===request.key))return{add:[],result:{existing:true}};
    const run=state.runs.get(item.runs.at(-1));if(!run?.report||run.abandoned)throw Error('judge report absent; original start/claim remains owned');
    judgeProof(run,state,fresh,native);
    const activation=decisionActivation(events,fresh.identity,org),subject=state.items.get(request.subject);
    const finish=mutation=>bindCloseoutSources({cwd:repo,org,events,env,mutation:protectRecordMutation({org,state,events,command:'line decision apply',mutation})});
    if(!same(decisionCapture({state,events,item:subject,activation}),request))return finish({add:[{type:'decision.stale',id:request.subject,decision:item.id,key:request.key,judge_run:run.id},
      {type:'item.closed',id:item.id,as:'dropped',note:'Current intent/claim/HOLD changed. Retain the immutable answer; no subject effect.'}],result:{stale:true}});
    const parsed=readReport(evidence(org,run)),original=state.runs.get(request.run),source=sourceProof(original,fresh);
    const packetBytes=fs.readFileSync(item.meta.decision_archive.file,'utf8');
    if(bytesHash(packetBytes)!==item.meta.decision_archive.sha256||!same(JSON.parse(packetBytes).source,source))throw Error('captured source/evidence changed; retain original owner');
    let answer;
    try{if(parsed.errors.length)throw Error('immutable judge report invalid');answer=typedDecision(parsed.report,request);}
    catch(error){return finish(decisionFailureMutation({state,events,item,run,reason:error.message,config:loadDiscoveredRoutes({cwd:repo,env}).config}));}
    const before={subject,links:relatedLinks(state,subject.id),source,report:original.report,judge:{run:run.id,sha256:run.report.sha256,claim:ownerBinding(run)},answer};
    let sourceArchive;
    if(answer.action==='supersede')sourceArchive=immutable(path.join(org,'evidence','decisions',request.key,'source.tar'),git(source.workspace,['archive','--format=tar',source.head],null));
    const archive={...immutable(path.join(org,'evidence','decisions',request.key,'application.json'),JSON.stringify(before,null,2)+'\n'),...(sourceArchive?{source:sourceArchive}:{})};
    // Native/source claims are fresh at the actual transaction boundary too.
    judgeProof(run,state,fresh,native);if(!same(sourceProof(original,fresh),source))throw Error('source changed before answer application');
    const mutation=decisionApplyMutation({state,events,item,answer,archive,activation:decisionActivation(events,fresh.identity,org)});
    return bindCloseoutSources({cwd:repo,org,events,env,mutation:protectRecordMutation({org,state,events,command:'line decision apply',mutation})});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
  publishCloseoutEvents({cwd:repo,org,added:result.added,start:false,env});return result.result;
}

// A failure counts once per immutable report, never by red assertion or time.
export function decisionFailureMutation({state,events,item,run,reason,config}){
  const request=item.meta.decision_request,prior=events.filter(e=>e.type==='decision.failed'&&e.key===request.key);
  if(prior.some(e=>e.judge_run===run.id))return{add:[],result:{existing:true}};
  let route;if(!prior.length)try{route=decisionRoute(config,{failedFamily:run.meta.harness});}catch{}
  const add=[{type:'decision.failed',id:request.subject,decision:item.id,key:request.key,judge_run:run.id,family:run.meta.harness,reason,count:prior.length+1}];
  if(route)add.push({type:'item.updated',id:item.id,fields:{meta:{route}}},{type:'item.reopened',id:item.id,note:'One fresh other-family reframe of the immutable contract and failed-answer ledger.'},
    {type:'decision.reframe-authorized',id:item.id,key:request.key,run:run.id,report_sha256:run.report.sha256,route,failure_count:1});
  else add.push({type:'item.updated',id:item.id,fields:{meta:{hold:true,hold_reason:'Decision reframe exhausted/unavailable; reshape the contract.',decision_hold:request.key}}});
  return{add,result:{failed:true,reframe:route??null,parked:!route}};
}

// Observations are separate from intent/application. A detached acknowledgement
// alone is never restart proof and a question creation is never an answer.
export function observeDecisionConsequences({repo,org,env=process.env,native}){
  const binding=serviceRecordBinding({repo,org,env});boundaries(binding);
  return transact(org,(events,state)=>{
    const fresh=serviceRecordBinding({repo,org,env});boundaries(fresh);
    const add=[];
    for(const applied of events.filter(e=>e.type==='decision.applied')){
      if(events.some(e=>e.type==='decision.consequence'&&e.key===applied.key))continue;
      const item=state.items.get(applied.id),request=state.items.get(applied.decision)?.meta.decision_request;
      if(!item||!request)continue;
      if(applied.restart_required){
        const run=state.runs.get(item.runs.at(-1));if(!run||run.id===request.run||run.started.seq<applied.seq)continue;
        // Completed dispatch journal positively proves actual prompt delivery.
        const file=run.meta.dispatch_journal;if(!file)continue;
        const job=JSON.parse(fs.readFileSync(file,'utf8'));
        if(job.run!==run.id||job.stage!=='complete'||job.item!==item.id||job.org!==org||job.common!==binding.identity)continue;
        judgeProof(run,state,fresh,native);
        add.push({type:'decision.consequence',id:item.id,key:applied.key,decision:applied.decision,run:run.id,result:'restarted',success:run.report?run.report.outcome==='done':null,scope:'Actual native worker and completed original dispatch observed; final work result may still be pending.'});
      }else if(applied.action==='supersede'&&item.closed?.as==='dropped'&&item.meta.superseded_by)
        add.push({type:'decision.consequence',id:item.id,key:applied.key,result:'superseded',success:true,successor:item.meta.superseded_by});
      else if(applied.action==='park'&&item.meta.decision_hold===applied.key&&item.meta.hold)
        add.push({type:'decision.consequence',id:item.id,key:applied.key,result:'parked',success:false});
      else if(applied.action==='ask_operator'){
        const q=[...state.items.values()].find(i=>i.meta.decision_key===applied.key&&i.meta.operator_reserved);
        if(q?.meta.answered_by==='human'&&q.meta.answer)add.push({type:'decision.consequence',id:item.id,key:applied.key,result:'operator-answered',question:q.id,answer:q.meta.answer,success:false,scope:'Operator answer observed; its reserved effect still belongs to the actual authorized owner.'});
      }
    }
    return protectRecordMutation({org,state,events,command:'line decision consequence',mutation:{add}});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).added;
}

// Exact rollback before any consequence or later affected write. Reopening is
// deliberately insufficient once downstream work has run: that requires a new
// decision/intent rather than pretending downstream effects were reversed.
export function decisionRestoreMutation({events,state,key}){
  if(events.some(e=>e.type==='decision.restored'&&e.key===key))return{add:[],result:{existing:true}};
  const applied=events.filter(e=>e.type==='decision.applied'&&e.key===key);if(applied.length!==1)throw Error('exact application is missing/ambiguous');
  const event=applied[0];
  if(event.action==='ask_operator')throw Error('reserved question retained; its disposition requires the actual operator route');
  if(events.some(e=>e.type==='decision.consequence'&&e.key===key))throw Error('consequence observed; exact automatic restore is no longer reversible');
  const ids=new Set(event.changes.map(c=>c.id));
  if(events.some(e=>e.seq>event.seq&&[e.id,e.item,e.blocker,e.blocked].some(id=>ids.has(id))))throw Error('affected state changed after application; preserve downstream work');
  // Restore the captured pre-application state, including absent metadata keys.
  const before=JSON.parse(fs.readFileSync(event.archive.file,'utf8'));
  if(bytesHash(fs.readFileSync(event.archive.file))!==event.archive.sha256)throw Error('application archive changed');
  let links=structuredClone(state.links);
  for(const change of [...event.link_changes].reverse()){
    if(change.type==='link.added')links=links.filter(l=>l.blocker!==change.blocker||l.blocked!==change.blocked);
    else if(!links.some(l=>l.blocker===change.blocker&&l.blocked===change.blocked))links.push(before.links.find(l=>l.blocker===change.blocker&&l.blocked===change.blocked)??{blocker:change.blocker,blocked:change.blocked});
  }
  const undo=[...event.link_changes].reverse().map(change=>({type:change.type==='link.added'?'link.removed':'link.added',blocker:change.blocker,blocked:change.blocked}));
  // Expose every transferred edge to the EXISTING promotion write guard. The
  // final snapshot restores original link provenance after the guarded inverses.
  return{add:[...undo,{type:'decision.restored',id:event.id,decision:event.decision,key,archive:event.archive,items:[before.subject],links}],result:{restored:true}};
}

// Owner activation is a supported, explicit local effect. No pins, runtime or
// watcher files are edited; existing installed passes consume this record event.
export function activateDecisions({org,run:id,head,subjects=[],authority,cwd=process.cwd(),env=process.env,call,disable=false,restore}) {
  org=fs.realpathSync(org);if(!authority||!head)throw Error('activation requires adopted authority and expected landed head');
  return transact(org,(events,state)=>{
    const b=nativeSender(org,{cwd,env,...(call?{call}:{})}),repo=b.project.canonical,n=b.native,run=state.runs.get(id),w=run&&effectiveWorkerIdentity(run,state);
    if(!run||run.report||run.abandoned||run.workspace!==b.project.checkout||state.items.get(run.item)?.runs.at(-1)!==id||itemLaunchHold(state,run.item)||w.identity_conflict||w.agent!==n.name||w.pane!==n.pane_id||w.terminal_id!==n.terminal_id||w.agent_session_id!==n.agent_session.value)throw Error('activation needs the current native owning worker/claim');
    requireController(readOwnedRun(org,id),'brain');assertOwner(readOwnedRun(org,id),ownerBinding(run));
    const directory=lineDirectory(org,b.project.identity);boundaries({directory,repo});
    if(b.project.identity!==readGit(root,['rev-parse','--path-format=absolute','--git-common-dir']))throw Error('decision-loop rollout is Brain only; other projects await their owning adopted release');
    if(readGit(root,['status','--porcelain=v1'])||readGit(repo,['status','--porcelain=v1'])||readGit(root,['rev-parse','HEAD'])!==head)throw Error('activation requires clean expected landed source');
    readGit(repo,['merge-base','--is-ancestor',head,'HEAD']);
    if(restore)return protectRecordMutation({org,state,events,command:'decision exact restore',mutation:decisionRestoreMutation({state,events,key:restore})});
    if(authority!=='operator-adopted-20261027/decision-loop.md'||!state.items.get(run.item).accept.some(text=>text.includes('ADOPTED-WORKFLOW-20261027/decision-loop.md')))throw Error('activation requires the adopted decision-loop owning contract');
    for(const subject of subjects)if(!state.items.has(subject))throw Error('activation subject missing');
    const previous=active(events,b.project.identity,org),type=disable?'line.decisions-deactivated':'line.decisions-activated';
    if(previous?.type===type){if(!same(previous.subjects,subjects)||previous.authority!==authority)throw Error('activation scope differs; explicitly deactivate before a new intent');return{add:[],result:{existing:true,seq:previous.seq}};}
    return protectRecordMutation({org,state,events,command:'decision-loop owner activation',mutation:{add:[{type,project:b.project.identity,repo,org,subjects,authority,source_head:head,run:id,claim:ownerBinding(run),native_caller:{name:n.name,pane:n.pane_id,terminal:n.terminal_id,session:n.agent_session.value}}],result:{active:!disable,subjects,source_head:head}}});
  },{actor:readOwnedRun(org,id).meta.agent,strictTail:true,lockOptions:{recover:false}}).result;
}
export function decisionCommand(argv=process.argv.slice(2)){
  const {values:v}=parseArgs({args:argv,options:{org:{type:'string'},run:{type:'string'},'expected-head':{type:'string'},subject:{type:'string',multiple:true},authority:{type:'string'},activate:{type:'boolean'},deactivate:{type:'boolean'},restore:{type:'string'}}});
  if(!v.org||!v.run||[v.activate,v.deactivate,v.restore].filter(Boolean).length!==1)throw Error('decisions --org RECORD --run OWN --activate|--deactivate --expected-head SHA --authority ADOPTED [--subject ID]');
  console.log(JSON.stringify(activateDecisions({org:v.org,run:v.run,head:v['expected-head'],authority:v.authority,subjects:v.subject??[],disable:v.deactivate,restore:v.restore})));
}
if(isMain(import.meta.url))decisionCommand();
