// Landed-change facts and record-derived decisions. No native effects/models.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {reviewScope,claimedCommitTokens,declaredSourceRanges} from '../settle/review-range.mjs';
import {nextItemId,fold,extendFold,itemStatus,blockersOf,releases} from '../lib/state.mjs';
import {roleIs} from '../lib/roles.mjs';
import {transact} from '../lib/store.mjs';
import {readReport} from '../lib/report.mjs';
import {readOwnedRun,requireController,assertOwner} from '../lib/run-owner.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {serviceRecordBinding} from './record-inbox.mjs';
import {reviewResolution} from './review-resolutions.mjs';
import {resolvedDispatchInput} from '../dispatch/not-started.mjs';
import {bindCloseoutSources,publishCloseoutEvents} from '../lib/closeout.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {loadDiscoveredRoutes} from '../lanes/routes.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {producerGroupKey,queueProducerGroup,sameProducerQueue,capturedReviewCommits} from './review-group.mjs';

export function reviewCompletionPlan({events,state,runId}){
  const run=state.runs.get(runId),item=state.items.get(run?.item),key=item?.meta.review_key;
  if(!run?.report||run.abandoned||!roleIs(item,'REV')||!key||item.meta.review_round_cap!==1||item.runs.at(-1)!==runId||run.report.outcome!=='done')throw Error('review completion needs its current immutable done report');
  if(item.closed)return{closed:true};
  if(item.meta.operator_reserved||item.meta.reserved||item.meta.hold||item.meta.held||['security','funds-and-chain','publish','delete-data','licensing','priorities'].includes(item.meta.category)||run.report.blockers?.length||(run.report.questions??run.report.extra?.questions)?.length||
    [...state.items.values()].some(q=>q.parent===item.id&&roleIs(q,'HUM')&&!q.closed)||item.runs.some(id=>id!==runId&&!state.runs.get(id)?.report&&!state.runs.get(id)?.abandoned))throw Error('review completion needs judgment for held/reserved report scope');
  const fact=events.find(e=>e.type==='change.reviewed'&&e.review_run===runId&&e.review_item===item.id&&e.review_key===key&&e.head===item.meta.review_target?.head&&e.report_sha256===run.report.sha256);
  if(!fact||!['PASS','FAIL','NEEDS-WORK'].includes(fact.verdict))throw Error('review completion needs its typed exact-target verdict');
  if(item.outcome&&item.outcome.run!==runId||events.some(e=>e.type==='item.closed'&&e.id===item.id&&e.seq>run.report.seq))throw Error('review completion was superseded or reopened; retain judgment');
  const blockers=blockersOf(state,item.id);
  for(const id of blockers){const child=state.items.get(id);if(releases(state,id,itemStatus(state,id,new Set(),item.id)))continue;
    if(!roleIs(child,'ENG')||child.parent!==item.id||child.created.run!==runId||child.meta.review_fix_of!==key)throw Error('review completion has an unresolved independent blocker');}
  const ids=new Set([item.id,...blockers]),revision=Math.max(fact.seq,...events.filter(e=>['item.updated','item.closed','item.reopened','link.added','link.removed'].includes(e.type)&&[e.id,e.blocker,e.blocked].some(id=>ids.has(id))).map(e=>e.seq));
  return{run,item,fact,token:hash(JSON.stringify([runId,run.report.sha256,fact.seq,revision])),closed:false};
}

// Finishing a judgment does not finish its linked product corrections. The
// ordinary closeout queue still owns all callback/native/archive retirement.
export function recordReviewCompletion({repo,org,runId,env=process.env}){
  const guard=()=>{const b=serviceRecordBinding({repo,org,env});for(const f of [path.join(b.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(f))throw Error('STOP/HOLD prevents review completion');return b;};
  guard();
  const result=transact(org,events=>{
    guard();const state=fold(events),p=reviewCompletionPlan({events,state,runId});if(p.closed)return{add:[]};
    const owned=readOwnedRun(org,runId);requireController(owned,'brain');assertOwner(owned,{owner:p.run.owner,generation:p.run.owner_generation});
    const file=path.resolve(org,p.run.report.file??'');if(!file.startsWith(org+path.sep)||hash(fs.readFileSync(file))!==p.run.report.sha256)throw Error('immutable review completion bytes changed');
    const mutation=protectRecordMutation({org,state,events,command:'line-service completed review',mutation:{add:[{type:'item.closed',id:p.item.id,as:'done',completed_run:runId,review_verdict:p.fact.seq,note:`Independent ${p.fact.verdict} judgment recorded for ${p.fact.review_key}; linked corrections remain owned and open. Preserve callbacks, HOLD, archives and guarded physical retirement.`}]}});
    return bindCloseoutSources({cwd:repo,org,events,env,mutation});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
  publishCloseoutEvents({cwd:repo,org,added:result.added,start:false,env});return{review_closed:result.added.some(e=>e.type==='item.closed'),run:runId};
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}).trim();
const ancestor=(repo,a,b)=>{try{git(repo,['merge-base','--is-ancestor',a,b]);return true;}catch{return false;}};
export function phase0Boundary(events,{repo,org,identity}) {
  const rows=events.filter(e=>e.type==='line-service.phase0'&&e.project===identity&&e.org===org&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(e.canonical_head??''));
  if(rows.length!==1||rows[0].repo!==repo||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(rows[0].canonical_head??'')||!Number.isSafeInteger(rows[0].seq)||rows[0].seq<1||!rows[0].main)throw Error('explicit intended Phase0 source boundary missing/ambiguous; exact18:55 head is UNKNOWN');
  return rows[0];
}

// The real installed pass records its first main once. Explicit source
// boundaries retain their original heads and historical time qualifications.
export function ensureReviewBoundary({repo,org,env=process.env}){
  const guard=()=>{const b=serviceRecordBinding({repo,org,env});for(const file of [path.join(b.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(file))throw Error('STOP/HOLD prevents first review boundary');return b;};
  const binding=guard(),release=acquireLock(path.join(binding.identity,'lane-promote.lock'));
  try{return transact(org,events=>{
    guard();const valid=events.filter(e=>e.type==='line-service.phase0'&&e.project===binding.identity&&e.org===org&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(e.canonical_head??''));
    if(valid.length)return{add:[],result:phase0Boundary(events,{repo,org,identity:binding.identity})};
    const main=loadDiscoveredRoutes({cwd:repo,env}).config.main??'main',head=git(repo,['rev-parse',`refs/heads/${main}`]);
    if(git(repo,['symbolic-ref','--short','HEAD'])!==main||git(repo,['rev-parse','HEAD'])!==head||git(repo,['status','--porcelain=v1']))throw Error('actual canonical main/source CAS changed before first boundary');
    const event={type:'line-service.phase0',id:`first-service-main-${hash(binding.identity).slice(0,20)}`,project:binding.identity,repo,org,source:binding.installation.source,main,canonical_head:head,mode:'first-service-observation',cutoff_at:null,time_qualification:'First actual service observation of canonical main; no historical18:55 or archive-time claim.'};
    return protectRecordMutation({org,events,state:fold(events),command:'line-service first review boundary',mutation:{add:[event],result:event}});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;}finally{release();}
}

// Canonical commits define debt; report claims only help attribute that debt.
// Unclaimed/unreported changes stay visible instead of vanishing from the index.
export function canonicalReviewIndex({events,state,repo,org,identity,boundary,readGit=git}){
  boundary??=phase0Boundary(events,{repo,org,identity});
  const tip=readGit(repo,['rev-parse',`refs/heads/${boundary.main}`]),graphRows=readGit(repo,['rev-list','--parents',`${boundary.canonical_head}..${tip}`]).split('\n').filter(Boolean),parents=new Map(graphRows.map(row=>{const [head,...p]=row.split(' ');return[head,p];})),heads=[...parents.keys()],headSet=new Set(heads),landed=new Map(),claims=new Map();
  const add=(map,head,item,run)=>{const list=map.get(head)??[];if(!list.some(v=>v.item===item&&v.run===run))list.push({item,run});map.set(head,list);};
  for(const e of events)if(e.type==='change.landed'&&e.project===identity&&headSet.has(e.head))add(landed,e.head,e.item,e.run);
  const resolve=token=>{const found=[...heads,boundary.canonical_head].filter(h=>h.startsWith(token));return found.length===1?found[0]:null;};
  for(const run of state.runs.values())if(run.report&&roleIs(state.items.get(run.item),'ENG')){
    for(const token of claimedCommitTokens(run.report.artifacts??[])){const head=resolve(token);if(head&&headSet.has(head))add(claims,head,run.item,run.id);}
    // Only the explicit source/base artifact claims a whole range. Use the
    // already indexed graph; report prose/admission/packet references do not.
    for(const range of declaredSourceRanges(run.report.artifacts??[])){
      const head=resolve(range.head),base=resolve(range.base);if(!head||!base)continue;
      const excluded=new Set(),visit=(h,out)=>{if(out.has(h))return;out.add(h);for(const p of parents.get(h)??[])visit(p,out);};
      visit(base,excluded);const included=new Set();visit(head,included);
      if(!included.has(base))continue;
      for(const h of included)if(headSet.has(h)&&!excluded.has(h))add(claims,h,run.item,run.id);
    }
  }
  const entries=heads.map(head=>{
    const owners=landed.get(head)??claims.get(head)??[],owner=owners.length===1?owners[0]:null,item=owner&&state.items.get(owner.item),run=owner&&state.runs.get(owner.run),fix=item&&(item.meta.review_fix_of||roleIs(state.items.get(item.parent),'REV'));
    return{head,item:owner?.item??null,run:owner?.run??null,key:owner?`${owner.item}:${head}`:null,group_key:owner?(producerGroupKey(owner.item,owner.run,run?.report?.sha256)??`producer-pending:${owner.item}:${owner.run}`):`unattributed:${head}`,attribution:owner?(landed.has(head)?'landed-producer':'report-claim'):owners.length?'ambiguous':'missing',producer_report:!!run?.report,
      ...(fix?{exemption:{reason:'linked formal correction retains its original review; no re-review chain',review_key:item.meta.review_fix_of??null}}:{})};
  });
  return{boundary,tip,heads,graphRows,entries};
}

export function reviewHealth({events,state,index}){
  const rows=index.entries.filter(e=>!e.exemption),groups=new Map(),archived=new Set(events.filter(e=>e.type==='review.recovery-completed'&&e.project===index.boundary.project&&e.org===index.boundary.org).flatMap(e=>e.archived_review_items??[]));
  for(const row of rows){const list=groups.get(row.group_key)??[];list.push(row);groups.set(row.group_key,list);}
  const queued=new Set(),running=new Set(),done=new Set(),queuedCommits=new Set(),doneCommits=new Set(),retained=new Set(),retainedIssues=[];let unknownRunning=0,ambiguousGroups=0;
  for(const [key,owned]of groups){
    const all=[...state.items.values()].filter(q=>roleIs(q,'REV')&&sameProducerQueue(q,owned[0].item,owned[0].run)&&!archived.has(q.id)),peers=all.filter(q=>q.meta.review_round_cap===1&&queueProducerGroup(q)===key);
    if(all.length)retained.add(key);
    if(all.length>1||all.length!==peers.length)retainedIssues.push({group:key,item:owned[0].item,run:owned[0].run,review_items:all.map(q=>q.id),reason:'Multiple, partial or UNKNOWN immutable producer review captures retained; no new review or retarget.'});
    if(peers.length)queued.add(key);if(peers.length>1)ambiguousGroups++;
    // Preserve each actual attempted immutable scope, including split legacy
    // PASS/active reviews. Unstarted partial aliases do not manufacture coverage.
    for(const q of peers)if(q.runs.length||peers.length===1&&!q.meta.hold&&!q.meta.held)for(const h of capturedReviewCommits(q.meta.review_target))if(owned.some(r=>r.head===h))queuedCommits.add(h);
    for(const q of peers)for(const rid of q.runs){const run=state.runs.get(rid);if(!run||run.report||run.abandoned)continue;const w=effectiveWorkerIdentity(run,state);if(!w.identity_conflict&&w.agent&&w.pane&&w.terminal_id&&w.agent_session_id)running.add(key);else unknownRunning++;}
    for(const e of events)if(e.type==='change.reviewed'&&['PASS','FAIL','NEEDS-WORK'].includes(e.verdict)&&((e.review_group_key??queueProducerGroup(state.items.get(e.review_item)))===key||e.item===owned[0].item&&owned.some(r=>r.head===e.head))){
      const target=state.items.get(e.review_item)?.meta.review_target,covered=e.covered_commits??(target?.head===e.head?capturedReviewCommits(target):[e.head]);
      for(const h of covered)if(owned.some(r=>r.head===h))doneCommits.add(h);
    }
    if(owned.every(r=>doneCommits.has(r.head)))done.add(key);
  }
  const missing=[...groups].filter(([key])=>!queued.has(key)&&!done.has(key)),uncovered=rows.filter(r=>!queuedCommits.has(r.head)&&!doneCommits.has(r.head));
  return{owed:groups.size,owed_commits:rows.length,queued:queued.size,queued_commits:queuedCommits.size,running:running.size,running_unknown:unknownRunning,done:done.size,done_commits:doneCommits.size,ambiguous_groups:ambiguousGroups,missing_queue:missing.length,retained_issues:retainedIssues,coverage_gaps:uncovered.map(r=>({head:r.head,item:r.item,run:r.run,group:r.group_key,retained:retained.has(r.group_key)})),
    attribution_gaps:rows.filter(r=>r.attribution==='missing'||r.attribution==='ambiguous'||!r.producer_report).map(r=>({head:r.head,item:r.item,run:r.run,reason:r.attribution==='missing'||r.attribution==='ambiguous'?`${r.attribution} source attribution`:'immutable producer report pending'})),
    missing:missing.map(([key,owned])=>({group:key,heads:owned.map(r=>r.head),item:owned[0].item,run:owned[0].run})),exemptions:index.entries.filter(r=>r.exemption).map(r=>({head:r.head,item:r.item,run:r.run,...r.exemption})),
    scope:'Canonical commit coverage grouped by immutable producer report. A retained partial target is not full coverage; independent verdicts and linked-fix exemptions remain scoped.'};
}

export function recordReviewError({repo,org,key,count,boundary,reason,scope,env=process.env}){
  serviceRecordBinding({repo,org,env});
  return transact(org,events=>{const b=serviceRecordBinding({repo,org,env}),id=`${key}:${count}`;
    return protectRecordMutation({org,events,state:fold(events),command:'line-service review error',mutation:{add:events.some(e=>e.type==='line-service.review-error'&&e.id===id)?[]:[{type:'line-service.review-error',id,project:b.identity,org,key,count,boundary,reason,scope}]}});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
}

export function recordReviewHealth({repo,org,index,passId,errorCounts,env=process.env}){
  const guard=()=>{const b=serviceRecordBinding({repo,org,env});for(const f of [path.join(b.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(f))throw Error('STOP/HOLD prevents review health observation');return b;};
  guard();
  return transact(org,events=>{
    const b=guard(),prior=events.findLast(e=>e.type==='line-service.review-health'&&e.project===b.identity&&e.org===org);
    if(prior?.pass_id===passId)return{add:[],result:prior};
    if(git(repo,['rev-parse',`refs/heads/${index.boundary.main}`])!==index.tip)throw Error('canonical review index advanced; next real pass supplies fresh counts');
    const refreshed=canonicalReviewIndex({events,state:fold(events),repo,org,identity:b.identity,boundary:index.boundary,readGit:(_repo,args)=>args[0]==='rev-parse'?index.tip:index.graphRows.join('\n')}),counts=reviewHealth({events,state:fold(events),index:refreshed});
    const event={type:'line-service.review-health',project:b.identity,org,pass_id:passId,tip:index.tip,boundary:{id:index.boundary.id,head:index.boundary.canonical_head},...counts,errors:errorCounts,
      gap_passes:counts.missing_queue||counts.coverage_gaps.length?(prior?.gap_passes??0)+1:0};
    return protectRecordMutation({org,events,state:fold(events),command:'line-service review health',mutation:{add:[event],result:event}});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}}).result;
}

export function discoverChanges({events,state,repo,org,identity,boundary,readGit=git,pendingOnly=false,index}) {
  const changes=[],holds=[];
  try{boundary??=phase0Boundary(events,{repo,org,identity});}catch(e){return {changes,holds:[{reason:e.message}]};}
  index??=canonicalReviewIndex({events,state,repo,org,identity,boundary,readGit});const eligible=new Set(index.heads);
  const authorized=new Map();for(const e of events)if(e.type==='review.recovery-completed'&&e.project===identity&&e.org===org&&e.target?.head)authorized.set(`${e.item}:${e.target.head}`,e);
  const queues=[...state.items.values()].filter(i=>roleIs(i,'REV')&&i.meta.review_source_item),archived=new Set([...authorized.values()].flatMap(e=>e.archived_review_items??[]));
  const landed=new Map();for(const e of events)if(e.type==='change.landed'&&e.project===identity&&eligible.has(e.head)){
    const list=landed.get(e.run)??[];list.push(e.head);landed.set(e.run,list);
  }
  for(const run of state.runs.values()) {
    const item=state.items.get(run.item);
    if(!item||!roleIs(item,'ENG')||!run.report||roleIs(state.items.get(item.parent),'REV')||item.meta.review_fix_of)continue;
    const group=producerGroupKey(item.id,run.id,run.report.sha256),backfills=[...authorized.values()].filter(e=>e.run===run.id&&e.item===item.id),tokens=claimedCommitTokens(run.report.artifacts??[]);
    // Settled history remains two batched Git index reads, no per-report disk
    // or native inventory. An immutable report's intermediate heads are one group.
    if(!(landed.get(run.id)??[]).length&&!backfills.length&&!tokens.some(token=>index.heads.some(head=>head.startsWith(token))))continue;
    if(pendingOnly&&queues.some(q=>!archived.has(q.id)&&sameProducerQueue(q,item.id,run.id)))continue;
    try {
        const reportFile=path.resolve(org,run.report.file??'');
        if(!reportFile.startsWith(path.resolve(org)+path.sep)||hash(fs.readFileSync(reportFile))!==run.report.sha256)throw Error('immutable producer report bytes changed/missing');
        const start=events.find(e=>e.type==='run.started'&&e.id===run.id),file=start?.meta?.dispatch_journal;
        if(!file||!path.resolve(file).startsWith(path.join(path.resolve(org),'dispatch')+path.sep))throw Error('original dispatch/source attribution missing');
        const dispatch=JSON.parse(fs.readFileSync(file,'utf8'));
        if(dispatch.item!==item.id||dispatch.run!==run.id||dispatch.common!==identity||dispatch.org!==org||dispatch.token!==start.meta.dispatch_attempt||dispatch.workspace!==run.workspace)throw Error('original source ownership/project attribution changed');
        let authorization,target;
        if(backfills.length){
          if(backfills.length!==1)throw Error('producer has multiple recovery targets; preserve its one replacement budget');
          authorization=reviewResolution({events,org,item:item.id,head:backfills[0].target.head})?.event;target=authorization.target;
          if(target.reportHash!==run.report.sha256||target.evidence!==reportFile||target.dispatch!==file||hash(git(repo,['diff','--no-ext-diff','--no-textconv',target.base,target.head]))!==target.diff_sha256)throw Error('authorized legacy source/evidence tuple changed');
          git(repo,['merge-base','--is-ancestor',target.head,index.tip]);
        }else{
          const resolved=reviewScope({workspace:repo,base:boundary.canonical_head,head:boundary.canonical_head,artifacts:run.report.artifacts??[]});
          if(resolved.unresolved.length)throw Error('whole producer source group has unresolved committed claims');
          const claims=[...new Set([...resolved.claims,...(landed.get(run.id)??[])])],tips=claims.length?git(repo,['merge-base','--independent',...claims]).split('\n').filter(Boolean):[];
          if(tips.length!==1)throw Error('whole producer source group has missing/ambiguous final committed target');const head=tips[0];
          if(!eligible.has(head))throw Error('whole producer final target is not actually landed after its boundary');
          if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(dispatch.base??'')||dispatch.base===head)throw Error('admission/unknown baseline is not positively delivered changed source');
          git(repo,['merge-base','--is-ancestor',dispatch.base,head]);
          const foreign=h=>events.some(e=>e.type==='change.landed'&&e.project===identity&&e.head===h&&(e.run!==run.id||e.item!==item.id));
          if(foreign(head))throw Error('claimed producer final target belongs to another recorded source owner');
          const order=git(repo,['rev-list','--reverse',`${dispatch.base}..${head}`]).split('\n').filter(Boolean),first=order.find(h=>claims.includes(h)&&!foreign(h));if(!first)throw Error('producer has no positively delivered non-admission change');
          const declared=[...new Set(declaredSourceRanges(run.report.artifacts??[]).filter(r=>head.startsWith(r.head)).map(r=>git(repo,['rev-parse',`${r.base}^{commit}`])))];
          if(declared.length>1)throw Error('whole producer source group has contradictory immutable bases');const base=declared[0]??git(repo,['rev-parse',`${first}^1`]);
          git(repo,['merge-base','--is-ancestor',base,head]);const range=git(repo,['rev-list','--reverse',`${base}..${head}`]).split('\n').filter(Boolean),ownedCommits=range.filter(h=>eligible.has(h)&&h!==dispatch.base&&!foreign(h)&&(declared.length||claims.includes(h)));
          if(claims.some(h=>eligible.has(h)&&h!==dispatch.base&&!foreign(h)&&!ownedCommits.includes(h)))throw Error('whole producer range omits delivered source; no partial review');const diff=git(repo,['diff','--no-ext-diff','--no-textconv',base,head]);if(!diff)throw Error('whole producer source has an empty delta; no code review target');
          target={head,base,reportHash:run.report.sha256,evidence:reportFile,diff_sha256:hash(diff),dispatch:file,scope:{base,commits:range,claims:ownedCommits,unresolved:[],deferred:false},source_group:{key:group,run:run.id,report_sha256:run.report.sha256,owned_commits:ownedCommits}};
        }
        if(pendingOnly&&events.some(e=>e.type==='change.reviewed'&&e.item===item.id&&e.head===target.head))continue;
        changes.push({item,run,target,...(authorization?{authorization}:{}),cutoff:{id:boundary.id,seq:boundary.seq,head:boundary.canonical_head,main:boundary.main??'main',time_qualification:boundary.time_qualification??'intended source boundary; exact adoption-time head UNKNOWN'}});
    }catch(e){holds.push({item:item.id,run:run.id,reason:e.message});}
  }
  return {changes,holds,index};
}

export function blockedChangeKey({events,state,item,run,brief}) {
  if(run?.report?.outcome!=='blocked')return 'ordinary';
  const seq=run.report.seq??0,ids=new Set([item.id,run.id]);
  const inputs=events.filter(e=>e.seq>seq&&e.by!=='line-service'&&!/^\[watch record-only\]/.test(e.text??'')&&(
    e.type==='note.added'&&ids.has(e.id)||e.type==='question.answered'&&(ids.has(e.id)||state?.items.get(e.id)?.parent===item.id)||
    e.type==='link.removed'&&(ids.has(e.blocked)||ids.has(e.blocker))||e.type==='item.updated'&&e.id===item.id||
    e.type==='item.closed'&&events.some(l=>l.type==='link.added'&&l.blocked===item.id&&l.blocker===e.id)));
  const original=events.find(e=>e.type==='report.ingested'&&e.run===run.id)?.brief_sha256;
  if(!inputs.length&&!(original&&brief&&original!==brief))return null;
  return hash(JSON.stringify([run.report.sha256,inputs.map(e=>e.seq),brief??null]));
}

export function dispatchInput({events,state,item,org,identity}) {
  if (!item || item.closed || item.kind === 'goal') return null;
  const run = state.runs.get(item.runs.at(-1));
  let brief;
  try { if(run?.brief_path) brief=hash(fs.readFileSync(run.brief_path)); } catch { /* absence is not changed input */ }
  const input=blockedChangeKey({events,state,item,run,brief});
  if(!input)return null;
  let status=itemStatus(state,item.id);
  if(status==='blocked'&&run?.report?.outcome==='blocked') {
    const items=new Map(state.items);items.set(item.id,{...item,outcome:null});
    status=itemStatus({...state,items},item.id);
  }
  if(status!=='ready')return null;
  const value=`${run?.id??item.created.seq}:${input}`,resolution=events.find(e=>e.type==='dispatch.not-started'&&e.item===item.id&&e.input===value);
  if(!resolution)return value;
  if(!org||!identity||resolution.org!==org||resolution.project!==identity)throw Error('original dispatch resolution needs actual owning record/project context');
  return resolvedDispatchInput({events,org,common:identity,item:item.id,input:value});
}

export function reviewResultEvents({state,events,run,report,sha256,body=report.body??'',usedIds=[]}) {
  const review=state.items.get(run.item),target=review?.meta.review_target,source=review?.meta.review_source_item;
  if(!roleIs(review,'REV')||!target||!source)return [];
  const key=`${source}:${target.head}`;
  if(events.some(e=>e.type==='change.reviewed'&&e.review_run===run.id&&e.review_key===key))return [];
  const declarations=[],bodyLines=[];
  if(report.extra?.verdict!==undefined)declarations.push(String(report.extra.verdict).trim().toUpperCase());
  let fence=null;
  for(const [index,line]of String(body).split('\n').entries()){
    const marker=/^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;continue;}
    if(fence)continue;
    const match=/^\s{0,3}Verdict:\s*(.*?)\s*$/i.exec(line);
    if(match){const verdict=/^\**\s*(PASS|FAIL|NEEDS-WORK)\b/i.exec(match[1]);declarations.push(verdict?verdict[1].toUpperCase():match[1].toUpperCase());bodyLines.push(index+1);}
  }
  const distinct=new Set(declarations),verdict=declarations[0];
  if(!declarations.length||declarations.some(v=>!['PASS','FAIL','NEEDS-WORK'].includes(v)))throw Error('queued review report requires explicit PASS, FAIL or NEEDS-WORK verdict');
  if(distinct.size!==1)throw Error('queued review report has ambiguous contradictory verdicts; retain immutable bytes for judgment');
  const findings=[];
  for(const line of String(body).split('\n')){const m=/^\s*[-*]\s*\[(Major|Minor)\]\s*(.+)$/i.exec(line);if(m)findings.push({severity:m[1].toLowerCase(),text:m[2].trim()});}
  const raw=report.extra?.findings;if(Array.isArray(raw))for(const f of raw)if(f&&['major','minor'].includes(String(f.severity).toLowerCase()))findings.push({severity:String(f.severity).toLowerCase(),text:String(f.text??f.summary??'')});
  // A reviewer may use ordinary proposals. Keep them linked to this one change,
  // not an additional reviewer or recursive review chain.
  const add=[{type:'change.reviewed',item:source,head:target.head,base:target.base,review_key:key,review_group_key:producerGroupKey(source,review.meta.review_source_run,target.reportHash),covered_commits:capturedReviewCommits(target),review_item:review.id,review_run:run.id,verdict,
    verdict_evidence:{frontmatter:report.extra?.verdict!==undefined,body_lines:bodyLines},findings,report_sha256:sha256}];
  const taken=new Set(usedIds);
  for(const severity of ['major','minor']) {
    const rows=findings.filter(f=>f.severity===severity);if(!rows.length&&!(severity==='major'&&verdict!=='PASS'))continue;
    if((report.proposals??[]).some(p=>p.role==='engineer'&&(severity==='major'||p.extra?.severity==='minor')))continue;
    const id=nextItemId(state,{kind:'work',role:'engineer'},taken);taken.add(id);
    add.push({type:'item.added',id,kind:'work',role:'engineer',title:`${severity==='major'?'Fix':'Follow up'} ${source} at ${target.head.slice(0,10)}`,parent:review.id,from_run:run.id,
      accept:rows.map(f=>f.text),why:rows.length?rows.map(f=>f.text).join('\n'):`Review ${verdict}; resolve its findings without a second review.`,
      meta:{review_fix_of:key,review_source_item:source,review_source_run:review.meta.review_source_run,review_owner_run:review.meta.review_source_run,severity,review_round_cap:1}});
  }
  return add;
}

// Selected installed record CLIs retain their forwarding. The current service
// records its own review facts from the immutable ingested bytes, without
// replacing that consumer, its pin, its report or its native/run ownership.
export function recordReviewResults({repo,org,runId,env=process.env}) {
  const guard=()=>{const b=serviceRecordBinding({repo,org,env});if([path.join(b.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')].some(file=>fs.existsSync(file)))throw Error('STOP/HOLD prevents review result mutation');return b;};
  guard();
  return transact(org,events=>{
    guard();
    const state=fold(events),run=state.runs.get(runId),item=state.items.get(run?.item);
    if(!run?.report||!roleIs(item,'REV')||!item.meta.review_target)throw Error('no ingested immutable queued review result');
    const owned=readOwnedRun(org,runId);requireController(owned,'brain');assertOwner(owned,{owner:run.owner,generation:run.owner_generation});
    const file=path.resolve(org,run.report.file),text=fs.readFileSync(file,'utf8');
    if(!file.startsWith(path.resolve(org)+path.sep)||hash(text)!==run.report.sha256)throw Error('ingested review bytes changed');
    const parsed=readReport(text);if(parsed.errors.length)throw Error('immutable queued review report is invalid');
    const proposals=[...state.items.values()].filter(i=>i.created?.run===run.id&&roleIs(i,'ENG'));
    const add=reviewResultEvents({state,events,run,report:parsed.report,sha256:run.report.sha256,body:parsed.body});
    if(!add.length)return {add:[]};
    for(const child of proposals)if(!child.meta.review_fix_of)add.push({type:'item.updated',id:child.id,fields:{meta:{review_fix_of:item.meta.review_key,review_owner_run:item.meta.review_source_run,review_source_item:item.meta.review_source_item,review_round_cap:1}}});
    return protectRecordMutation({org,state,events,mutation:{add},command:'line-service immutable review result'});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
}

export function morningDigest({events,since,now=new Date().toISOString()}) {
  const inWindow=e=>!since||Date.parse(e.at)>=Date.parse(since),state=fold(events);
  const landings=events.filter(e=>e.type==='change.landed'&&inWindow(e)).map(e=>{
    const start=state.runs.get(e.run)?.started.at;
    return {...e,build_to_main_minutes:start&&e.landed_at?Math.max(0,(Date.parse(e.landed_at)-Date.parse(start))/60000):null};
  });
  const reviews=events.filter(e=>e.type==='change.reviewed'&&inWindow(e));
  const holds=[...state.items.values()].filter(i=>!i.closed&&(i.meta.hold||i.meta.held||['blocked','needs_human'].includes(itemStatus(state,i.id)))).map(i=>({item:i.id,title:i.title}));
  let idle=null;
  if(events[0]?.seq===1&&since&&Date.parse(events[0].at)<=Date.parse(since)){
    let previous=Date.parse(since),partial=fold(events.filter(e=>Date.parse(e.at)<=previous));idle=0;
    for(const e of events.filter(e=>Date.parse(e.at)>Date.parse(since))){
      const at=Date.parse(e.at);if(at>previous){if([...partial.items.values()].some(i=>itemStatus(partial,i.id)==='ready')&&![...partial.runs.values()].some(r=>!r.report&&!r.abandoned))idle+=(at-previous)/3600000;previous=at;}
      extendFold(partial,[e]);
    }
    const end=Date.parse(now);if(end>previous&&[...partial.items.values()].some(i=>itemStatus(partial,i.id)==='ready')&&![...partial.runs.values()].some(r=>!r.report&&!r.abandoned))idle+=(end-previous)/3600000;
  }
  const health=events.findLast(e=>e.type==='line-service.review-health'),errors=events.filter(e=>e.type==='line-service.review-error'&&inWindow(e));
  return {since:since??null,through:now,landings,reviews,findings:reviews.flatMap(r=>r.findings??[]),holds,idle_hours:idle,review_health:health??null,
    review_errors:{unique:new Set(errors.map(e=>e.key)).size,occurrences:errors.length,scope:'Typed review errors since this capability; prior raw journals remain preserved.'},scope:'Record-observed facts; unknown exact landing/idle intervals stay null.'};
}
