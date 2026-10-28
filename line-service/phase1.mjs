// Landed-change facts and record-derived decisions. No native effects/models.
import fs from '../lib/record-observation.mjs';
import {observeGit} from '../lib/record-observation.mjs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {reviewScope,claimedCommitTokens,declaredSourceRanges} from '../settle/review-range.mjs';
import {fold,extendFold,itemStatus,blockersOf,releases,isDeclined} from '../lib/state.mjs';
import {roleIs} from '../lib/roles.mjs';
import {planTransaction,loadRecord} from '../lib/store.mjs';
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
import {additionalTarget,supplementalTarget,canonicalTarget,canonicalSelector,validateAdditionalTarget} from './review-targets.mjs';
import {reviewCorrectionEvents} from './review-findings.mjs';

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
  const result=planTransaction(org,(events,state)=>{
    guard();const p=reviewCompletionPlan({events,state,runId});if(p.closed)return{add:[]};
    const owned=readOwnedRun(org,runId,events);requireController(owned,'brain');assertOwner(owned,{owner:p.run.owner,generation:p.run.owner_generation});
    const file=path.resolve(org,p.run.report.file??'');if(!file.startsWith(org+path.sep)||hash(fs.readFileSync(file))!==p.run.report.sha256)throw Error('immutable review completion bytes changed');
    const mutation=protectRecordMutation({org,state,events,command:'line-service completed review',mutation:{add:[{type:'item.closed',id:p.item.id,as:'done',completed_run:runId,review_verdict:p.fact.seq,note:`Independent ${p.fact.verdict} judgment recorded for ${p.fact.review_key}; linked corrections remain owned and open. Preserve callbacks, HOLD, archives and guarded physical retirement.`}]}});
    return bindCloseoutSources({cwd:repo,org,events,env,mutation});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
  publishCloseoutEvents({cwd:repo,org,added:result.added,start:false,env});return{review_closed:result.added.some(e=>e.type==='item.closed'),run:runId};
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(repo,args)=>{observeGit(repo);return execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}).trim();};
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
  try{return planTransaction(org,(events,state)=>{
    guard();const valid=events.filter(e=>e.type==='line-service.phase0'&&e.project===binding.identity&&e.org===org&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(e.canonical_head??''));
    if(valid.length)return{add:[],result:phase0Boundary(events,{repo,org,identity:binding.identity})};
    const main=loadDiscoveredRoutes({cwd:repo,env}).config.main??'main',head=git(repo,['rev-parse',`refs/heads/${main}`]);
    if(git(repo,['symbolic-ref','--short','HEAD'])!==main||git(repo,['rev-parse','HEAD'])!==head||git(repo,['status','--porcelain=v1']))throw Error('actual canonical main/source CAS changed before first boundary');
    const event={type:'line-service.phase0',id:`first-service-main-${hash(binding.identity).slice(0,20)}`,project:binding.identity,repo,org,source:binding.installation.source,main,canonical_head:head,mode:'first-service-observation',cutoff_at:null,time_qualification:'First actual service observation of canonical main; no historical18:55 or archive-time claim.'};
    const mutation=protectRecordMutation({org,events,state,command:'line-service first review boundary',mutation:{add:[event],result:event}});
    // Working-tree cleanliness is a live observation, not merely a ref/index
    // version. Keep this first-boundary check at its mutation boundary.
    return {...mutation,commit:validate=>{if(git(repo,['status','--porcelain=v1']))throw Error('actual canonical main/source CAS changed before first boundary');validate();}};
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
  const nativeGroups=new Map();for(const q of state.items.values())if(q.meta.review_target?.evidence_kind==='native-landings/v1')nativeGroups.set(`${q.meta.review_source_item}:${q.meta.review_source_run}`,queueProducerGroup(q));
  const entries=heads.map(head=>{
    const owners=landed.get(head)??claims.get(head)??[],owner=owners.length===1?owners[0]:null,item=owner&&state.items.get(owner.item),run=owner&&state.runs.get(owner.run),fix=item&&(item.meta.review_fix_of||roleIs(state.items.get(item.parent),'REV'));
    const native=owner&&nativeGroups.get(`${owner.item}:${owner.run}`);
    return{head,item:owner?.item??null,run:owner?.run??null,key:owner?`${owner.item}:${head}`:null,group_key:owner?(native??producerGroupKey(owner.item,owner.run,run?.report?.sha256)??`producer-pending:${owner.item}:${owner.run}`):`unattributed:${head}`,attribution:owner?(landed.has(head)?'landed-producer':'report-claim'):owners.length?'ambiguous':'missing',producer_report:!!run?.report,native_evidence:Boolean(native),
      ...(fix?{exemption:{reason:'linked formal correction retains its original review; no re-review chain',review_key:item.meta.review_fix_of??null}}:{})};
  });
  return{boundary,tip,heads,graphRows,entries};
}

export function reviewHealth({events,state,index}){
  const rows=index.entries.filter(e=>!e.exemption),groups=new Map(),archived=new Set(events.filter(e=>e.type==='review.recovery-completed'&&e.project===index.boundary.project&&e.org===index.boundary.org).flatMap(e=>e.archived_review_items??[]));
  for(const row of rows){const list=groups.get(row.group_key)??[];list.push(row);groups.set(row.group_key,list);}
  const queued=new Set(),running=new Set(),done=new Set(),queuedCommits=new Set(),doneCommits=new Set(),retained=new Set(),retainedIssues=[];let unknownRunning=0,ambiguousGroups=0;
  for(const [key,owned]of groups){
    const all=[...state.items.values()].filter(q=>roleIs(q,'REV')&&!archived.has(q.id)&&(owned[0].item?sameProducerQueue(q,owned[0].item,owned[0].run):q.meta.review_source_selector===canonicalSelector(owned[0].head))),peers=all.filter(q=>q.meta.review_round_cap===1&&(queueProducerGroup(q)===key||additionalTarget(q.meta.review_target)));
    if(all.length)retained.add(key);
    const partitioned=peers.some(q=>additionalTarget(q.meta.review_target)),seen=new Set();let overlap=false;
    for(const q of peers)for(const h of capturedReviewCommits(q.meta.review_target)){if(seen.has(h))overlap=true;seen.add(h);}
    const ambiguous=all.length!==peers.length||all.length>1&&(!partitioned||overlap);
    if(ambiguous)retainedIssues.push({group:key,item:owned[0].item,run:owned[0].run,review_items:all.map(q=>q.id),reason:'Multiple, partial or UNKNOWN immutable producer review captures retained; no new review or retarget.'});
    if(peers.length)queued.add(key);if(ambiguous&&peers.length>1)ambiguousGroups++;
    // Preserve each actual attempted immutable scope, including split legacy
    // PASS/active reviews. Unstarted partial aliases do not manufacture coverage.
    for(const q of peers)if(q.runs.length||(peers.length===1||partitioned&&!ambiguous)&&!q.meta.hold&&!q.meta.held)for(const h of capturedReviewCommits(q.meta.review_target))if(owned.some(r=>r.head===h))queuedCommits.add(h);
    for(const q of peers)for(const rid of q.runs){const run=state.runs.get(rid);if(!run||run.report||run.abandoned)continue;const w=effectiveWorkerIdentity(run,state);if(!w.identity_conflict&&w.agent&&w.pane&&w.terminal_id&&w.agent_session_id)running.add(key);else unknownRunning++;}
    for(const e of events)if(e.type==='change.reviewed'&&['PASS','FAIL','NEEDS-WORK'].includes(e.verdict)&&((e.review_group_key??queueProducerGroup(state.items.get(e.review_item)))===key||e.item===owned[0].item&&owned.some(r=>r.head===e.head)||peers.some(q=>additionalTarget(q.meta.review_target)&&q.id===e.review_item&&e.item===q.meta.review_source_item&&e.head===q.meta.review_target.head))){
      const target=state.items.get(e.review_item)?.meta.review_target,covered=e.covered_commits??(target?.head===e.head?capturedReviewCommits(target):[e.head]);
      for(const h of covered)if(owned.some(r=>r.head===h))doneCommits.add(h);
    }
    if(owned.every(r=>doneCommits.has(r.head)))done.add(key);
  }
  const missing=[...groups].filter(([key])=>!queued.has(key)&&!done.has(key)),uncovered=rows.filter(r=>!queuedCommits.has(r.head)&&!doneCommits.has(r.head));
  return{owed:groups.size,owed_commits:rows.length,queued:queued.size,queued_commits:queuedCommits.size,running:running.size,running_unknown:unknownRunning,done:done.size,done_commits:doneCommits.size,ambiguous_groups:ambiguousGroups,missing_queue:missing.length,retained_issues:retainedIssues,coverage_gaps:uncovered.map(r=>({head:r.head,item:r.item,run:r.run,group:r.group_key,retained:retained.has(r.group_key)})),
    attribution_gaps:rows.filter(r=>r.attribution==='missing'||r.attribution==='ambiguous'||!r.producer_report&&!r.native_evidence).map(r=>({head:r.head,item:r.item,run:r.run,reason:r.attribution==='missing'||r.attribution==='ambiguous'?`${r.attribution} source attribution`:'immutable producer report pending'})),
    missing:missing.map(([key,owned])=>({group:key,heads:owned.map(r=>r.head),item:owned[0].item,run:owned[0].run})),exemptions:index.entries.filter(r=>r.exemption).map(r=>({head:r.head,item:r.item,run:r.run,...r.exemption})),
    scope:'Canonical commit coverage grouped by immutable producer report. A retained partial target is not full coverage; independent verdicts and linked-fix exemptions remain scoped.'};
}

// Positive native post-FF receipts are producer evidence before a final report.
// Capture only their named commits, never a later live HEAD. Once queued, the
// snapshot stays immutable; later source remains visible debt, not another review.
function landedProducerTarget({events,state,repo,org,identity,item,run,dispatch,file,index,captured}){
  const worker=effectiveWorkerIdentity(run,state);
  if(run.abandoned||worker.identity_conflict||!run.owner||run.owner.legacy||run.owner.controller!=='brain')throw Error('native landed source ownership is UNKNOWN');
  if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(dispatch.base??'')||!fs.lstatSync(file).isFile()||fs.realpathSync(file)!==file)throw Error('original native source baseline/evidence is UNKNOWN or redirected');
  const sequence=captured?.landed_evidence?.landings?.map(e=>e.seq),all=events.filter(e=>e.type==='change.landed'&&e.project===identity&&e.item===item.id&&e.run===run.id&&index.heads.includes(e.head)&&(!sequence||sequence.includes(e.seq)));
  if(!all.length||sequence&&all.length!==sequence.length)throw Error('positive native landed source receipts missing/changed');
  for(const e of all){const p=e.producer;if(!e.landed_at||!p||!p.agent||!p.pane||!p.terminal||!p.session||p.agent!==worker.agent||p.pane!==worker.pane||p.terminal!==worker.terminal_id||p.session!==worker.agent_session_id||p.ownership_generation!==run.owner_generation)throw Error('native landed source ownership receipt is unqualified/changed');}
  const heads=[...new Set(all.map(e=>e.head))],tips=git(repo,['merge-base','--independent',...heads]).split('\n').filter(Boolean);
  if(tips.length!==1||tips[0]===dispatch.base)throw Error('native landed source has no unique changed non-admission target');
  const head=tips[0];git(repo,['merge-base','--is-ancestor',dispatch.base,head]);
  const ordered=git(repo,['rev-list','--reverse',`${dispatch.base}..${head}`]).split('\n').filter(Boolean),owned=ordered.filter(h=>heads.includes(h));
  if(owned.length!==heads.length||events.some(e=>e.type==='change.landed'&&e.project===identity&&heads.includes(e.head)&&(e.run!==run.id||e.item!==item.id)))throw Error('native landed producer range is foreign/ambiguous');
  const base=git(repo,['rev-parse',`${owned[0]}^1`]),range=git(repo,['rev-list','--reverse',`${base}..${head}`]).split('\n').filter(Boolean),diff=git(repo,['diff','--no-ext-diff','--no-textconv',base,head]);if(!diff)throw Error('native landed source has an empty delta');
  const document={schema:'native-landings/v1',item:item.id,run:run.id,project:identity,org,owner:run.owner,owner_generation:run.owner_generation,
    dispatch:{file,token:dispatch.token,item:dispatch.item,run:dispatch.run,common:dispatch.common,org:dispatch.org,workspace:dispatch.workspace,base:dispatch.base},
    original_ask:{started_seq:run.started.seq,brief:run.brief_path??null},base,head,owned_commits:owned,landings:all,producer_report:null,validation:'No test or final-release PASS inferred from landing.'};
  const reportHash=hash(JSON.stringify(document,null,2)+'\n'),evidence=path.join(org,'evidence',item.id,run.id,`review-source-${reportHash}.json`),group=producerGroupKey(item.id,run.id,reportHash),target={head,base,reportHash,evidence,evidence_kind:'native-landings/v1',landed_evidence:document,diff_sha256:hash(diff),dispatch:file,scope:{base,commits:range,claims:owned,unresolved:[],deferred:false},source_group:{key:group,run:run.id,report_sha256:null,evidence_sha256:reportHash,owned_commits:owned}};
  if(captured){
    if(JSON.stringify(captured)!==JSON.stringify(target))throw Error('captured native landed evidence/claim/source changed');
    const stat=fs.lstatSync(evidence);if(!stat.isFile()||fs.realpathSync(evidence)!==evidence||hash(fs.readFileSync(evidence))!==reportHash)throw Error('immutable native landed evidence changed');
  }
  return target;
}

export function publishLandedReviewEvidence(target){
  if(target.evidence_kind!=='native-landings/v1'&&!additionalTarget(target))return;
  const bytes=JSON.stringify(target.landed_evidence,null,2)+'\n';if(hash(bytes)!==target.reportHash)throw Error('native landed evidence digest changed');
  fs.mkdirSync(path.dirname(target.evidence),{recursive:true});if(fs.realpathSync(path.dirname(target.evidence))!==path.dirname(target.evidence))throw Error('native landed evidence directory redirected');
  let fd;try{fd=fs.openSync(target.evidence,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}catch(e){if(e.code!=='EEXIST')throw e;const s=fs.lstatSync(target.evidence);if(!s.isFile()||fs.realpathSync(target.evidence)!==target.evidence||hash(fs.readFileSync(target.evidence))!==target.reportHash)throw Error('immutable native landed evidence collision/changed');}finally{if(fd!==undefined)fs.closeSync(fd);}
  const directory=fs.openSync(path.dirname(target.evidence),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
}

export function observeReviewHealth({repo,org,index,passId,errorCounts,prior,env=process.env}){
  const guard=()=>{const b=serviceRecordBinding({repo,org,env});for(const f of [path.join(b.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')])if(fs.existsSync(f))throw Error('STOP/HOLD prevents review health observation');return b;};
  const b=guard(),{events,state,tornTail}=loadRecord(org);
  if(tornTail)throw Error('incomplete record prevents review health observation');
  prior??=events.findLast(e=>e.type==='line-service.review-health'&&e.project===b.identity&&e.org===org);
  if(prior?.pass_id===passId)return prior;
  if(git(repo,['rev-parse',`refs/heads/${index.boundary.main}`])!==index.tip)throw Error('canonical review index advanced; next real pass supplies fresh counts');
  const refreshed=canonicalReviewIndex({events,state,repo,org,identity:b.identity,boundary:index.boundary,readGit:(_repo,args)=>args[0]==='rev-parse'?index.tip:index.graphRows.join('\n')}),counts=reviewHealth({events,state,index:refreshed});
  return {project:b.identity,org,pass_id:passId,tip:index.tip,boundary:{id:index.boundary.id,head:index.boundary.canonical_head},...counts,errors:errorCounts,
    gap_passes:counts.missing_queue||counts.coverage_gaps.length?(prior?.gap_passes??0)+1:0};
}

export function discoverChanges({events,state,repo,org,identity,boundary,readGit=git,pendingOnly=false,index}) {
  const changes=[],holds=[],unattributed=[];
  try{boundary??=phase0Boundary(events,{repo,org,identity});}catch(e){return {changes,holds:[{reason:e.message}]};}
  index??=canonicalReviewIndex({events,state,repo,org,identity,boundary,readGit});const eligible=new Set(index.heads);
  const authorized=new Map();for(const e of events)if(e.type==='review.recovery-completed'&&e.project===identity&&e.org===org&&e.target?.head)authorized.set(`${e.item}:${e.target.head}`,e);
  const queues=[...state.items.values()].filter(i=>roleIs(i,'REV')&&i.meta.review_source_item),archived=new Set([...authorized.values()].flatMap(e=>e.archived_review_items??[]));
  const landed=new Map();for(const e of events)if(e.type==='change.landed'&&e.project===identity&&eligible.has(e.head)){
    const list=landed.get(e.run)??[];list.push(e.head);landed.set(e.run,list);
  }
  for(const run of state.runs.values()) {
    const item=state.items.get(run.item);
    if(!item||!roleIs(item,'ENG')||roleIs(state.items.get(item.parent),'REV')||item.meta.review_fix_of)continue;
    const group=producerGroupKey(item.id,run.id,run.report?.sha256),backfills=[...authorized.values()].filter(e=>e.run===run.id&&e.item===item.id),tokens=claimedCommitTokens(run.report?.artifacts??[]),nativeQueues=queues.filter(q=>!archived.has(q.id)&&sameProducerQueue(q,item.id,run.id)&&q.meta.review_target?.evidence_kind==='native-landings/v1');
    // Settled history remains two batched Git index reads, no per-report disk
    // or native inventory. An immutable report's intermediate heads are one group.
    if(!(landed.get(run.id)??[]).length&&!backfills.length&&!tokens.some(token=>index.heads.some(head=>head.startsWith(token))))continue;
    try {
        const nativeEvidence=!run.report||nativeQueues.length>0||backfills.some(e=>e.target.evidence_kind==='native-landings/v1'),reportFile=run.report&&path.resolve(org,run.report.file??'');
        if(!nativeEvidence&&(!reportFile.startsWith(path.resolve(org)+path.sep)||hash(fs.readFileSync(reportFile))!==run.report.sha256))throw Error('immutable producer report bytes changed/missing');
        const start=events.find(e=>e.type==='run.started'&&e.id===run.id),file=start?.meta?.dispatch_journal;
        if(!file||!path.resolve(file).startsWith(path.join(path.resolve(org),'dispatch')+path.sep))throw Error('original dispatch/source attribution missing');
        const dispatch=JSON.parse(fs.readFileSync(file,'utf8'));
        if(dispatch.item!==item.id||dispatch.run!==run.id||dispatch.common!==identity||dispatch.org!==org||dispatch.token!==start.meta.dispatch_attempt||dispatch.workspace!==run.workspace)throw Error('original source ownership/project attribution changed');
        let authorization,target;
        if(nativeEvidence){
          if(nativeQueues.length>1||backfills.length>1)throw Error('native producer has multiple/UNKNOWN retained captures; preserve cap1');
          if(backfills.length)authorization=reviewResolution({events,org,item:item.id,head:backfills[0].target.head})?.event;
          target=landedProducerTarget({events,state,repo,org,identity,item,run,dispatch,file,index,captured:nativeQueues[0]?.meta.review_target??authorization?.target});
        }else if(backfills.length){
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
        const retained=queues.filter(q=>!archived.has(q.id)&&sameProducerQueue(q,item.id,run.id)),cutoff={id:boundary.id,seq:boundary.seq,head:boundary.canonical_head,main:boundary.main??'main',time_qualification:boundary.time_qualification??'intended source boundary; exact adoption-time head UNKNOWN'};
        if(!pendingOnly||!retained.length&&!events.some(e=>e.type==='change.reviewed'&&e.item===item.id&&e.head===target.head))changes.push({item,run,target,...(authorization?{authorization}:{}),cutoff});
        if(retained.length&&!authorization){
          // Saved originals are never retargeted. Supplemental captures reserve
          // only strictly later, attributed source outside every retained scope.
          for(const q of retained.filter(q=>additionalTarget(q.meta.review_target))){validateAdditionalTarget({repo,org,identity,index,state,events,target:q.meta.review_target});if(!pendingOnly)changes.push({item,run,target:q.meta.review_target,cutoff});}
          const extra=supplementalTarget({events,state,repo,org,identity,index,item,run,queues:retained});
          if(extra)changes.push({item,run,target:extra,cutoff});
        }
    }catch(e){holds.push({item:item.id,run:run.id,reason:e.message});}
  }
  for(const row of index.entries)if(row.attribution==='missing'){
    const selector=canonicalSelector(row.head),retained=queues.filter(q=>q.meta.review_source_selector===selector);
    if(pendingOnly&&retained.length)continue;
    try{unattributed.push({selector,target:retained.length===1?validateAdditionalTarget({repo,org,identity,index,state,events,target:retained[0].meta.review_target}):canonicalTarget({repo,org,identity,index,head:row.head})});}catch(e){holds.push({head:row.head,reason:e.message});}
  }
  return {changes,holds,index,unattributed};
}

export function blockedChangeKey({events,state,item,run,brief}) {
  if(run?.report?.outcome!=='blocked')return 'ordinary';
  const seq=run.report.seq??0,ids=new Set([item.id,run.id]);
  const answer=events.findLast(e=>e.type==='decision.restart'&&e.by==='line-service'&&e.seq>seq&&e.id===item.id&&e.run===run.id&&e.report_sha256===run.report.sha256&&!events.some(r=>r.type==='decision.restored'&&r.key===e.key)&&events.some(a=>a.type==='decision.applied'&&a.key===e.key&&a.id===item.id&&a.restart_required));
  const reframe=roleIs(item,'DEC')&&events.findLast(e=>e.type==='decision.reframe-authorized'&&e.by==='line-service'&&e.seq>seq&&e.id===item.id&&e.run===run.id&&e.report_sha256===run.report.sha256&&e.key===item.meta.decision_request?.key&&e.route===item.meta.route&&e.failure_count===1&&events.some(f=>f.type==='decision.failed'&&f.key===e.key&&f.judge_run===run.id&&f.count===1));
  const inputs=events.filter(e=>e.seq>seq&&e.by!=='line-service'&&!/^\[watch record-only\]/.test(e.text??'')&&(
    e.type==='question.answered'&&(ids.has(e.id)||state?.items.get(e.id)?.parent===item.id)||
    e.type==='link.removed'&&(ids.has(e.blocked)||ids.has(e.blocker))||e.type==='item.updated'&&e.id===item.id&&Object.keys(e.fields??{}).some(k=>['accept','title'].includes(k))||e.type==='item.reopened'&&e.id===item.id||
    e.type==='item.closed'&&events.some(l=>l.type==='link.added'&&l.blocked===item.id&&l.blocker===e.id)||
    // An explicit non-declined answer to an unlinked question asked under the subject.
    e.type==='item.closed'&&(q=>q?.parent===item.id&&roleIs(q,'HUM')&&q.meta.answer!=null&&q.meta.answered_by!=='auto'&&!isDeclined(q))(state?.items.get(e.id))));
  const original=events.find(e=>e.type==='report.ingested'&&e.run===run.id)?.brief_sha256;
  if(!answer&&!reframe&&!inputs.length&&!(original&&brief&&original!==brief))return null;
  return hash(JSON.stringify([run.report.sha256,inputs.map(e=>e.seq),brief??null,...(answer?[answer.key]:[]),...(reframe?[reframe.key,reframe.seq]:[])]));
}

// Existing original requests keep their exact immutable partial scopes. This
// is never a new queue producer or permission to retarget a saved request.
export function capturedProducerTarget({repo,target,whole}){
  const full=whole?.target;if(!full||whole.authorization||target.source_group)throw Error('partial/UNKNOWN capture is not a supported original legacy scope');
  for(const key of ['reportHash','evidence','dispatch'])if(target[key]!==full[key])throw Error('original capture differs from immutable producer evidence');
  const owned=new Set(capturedReviewCommits(full)),captured=capturedReviewCommits(target);
  if(!captured.length||!owned.has(target.head)||captured.some(h=>!owned.has(h))||target.scope?.unresolved?.length||target.scope?.deferred)throw Error('original captured scope is unknown/admission/foreign to this producer');
  const range=git(repo,['rev-list','--reverse',`${target.base}..${target.head}`]).split('\n').filter(Boolean);git(repo,['merge-base','--is-ancestor',target.base,target.head]);
  if(!range.length||JSON.stringify(range)!==JSON.stringify(target.scope?.commits)||hash(git(repo,['diff','--no-ext-diff','--no-textconv',target.base,target.head]))!==target.diff_sha256)throw Error('original immutable capture range/diff changed');
  return target;
}

export function dispatchInput({events,state,item,org,identity}) {
  if (!item || item.closed || item.kind === 'goal') return null;
  const run = state.runs.get(item.runs.at(-1));
  if(run?.report?.outcome==='blocked'){
    // New source on the original reported run is an owned recovery, not whole
    // product completion or permission to replace that owner. Only the existing
    // explicit reopen/handoff can return remaining scope to ordinary admission.
    const source=events.findLast(e=>e.seq>run.report.seq&&(e.type==='change.landed'&&e.run===run.id&&e.item===item.id&&e.landed_at&&e.producer||e.type==='promotion.reconciled'&&e.heads?.some(h=>h.run===run.id)));
    if(source&&!events.some(e=>e.type==='item.reopened'&&e.id===item.id&&e.seq>source.seq))return null;
  }
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
  const authorization=events.find(e=>e.type==='review.unstarted-authorized'&&e.review_item===item.id&&e.org===org&&e.project===identity);
  const value=`${run?.id??item.created.seq}:${input}${authorization?`:unstarted-${authorization.seq}`:''}`,resolution=events.find(e=>e.type==='dispatch.not-started'&&e.item===item.id&&e.input===value);
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
    // A heading or an isolated emphasized verdict is still the reviewer's
    // explicit declaration. Keep quotes, lists, code and prose out of intake.
    const declaration=line.replace(/^ {0,3}#{1,6}[ \t]+/, '');
    const isolated=/^ {0,3}\*\*(PASS|FAIL|NEEDS-WORK)\*\*[ \t]*$/i.exec(declaration);
    if(isolated){declarations.push(isolated[1].toUpperCase());bodyLines.push(index+1);continue;}
    const match=/^ {0,3}(\*\*)?Verdict:\s*(.*?)\s*$/i.exec(declaration);
    if(match){
      let value=match[2];
      // Markdown may emphasize the entire declaration, including its label.
      // An unmatched outer marker is not an independent explicit judgment.
      if(match[1]){const end=value.indexOf('**');value=end>0?value.slice(0,end):'UNBALANCED';}
      const verdict=/^\**\s*(PASS|FAIL|NEEDS-WORK)\b/i.exec(value);declarations.push(verdict?verdict[1].toUpperCase():value.toUpperCase());bodyLines.push(index+1);
    }
  }
  const distinct=new Set(declarations),verdict=declarations[0];
  if(!declarations.length||declarations.some(v=>!['PASS','FAIL','NEEDS-WORK'].includes(v)))throw Error('queued review report requires explicit PASS, FAIL or NEEDS-WORK verdict');
  if(distinct.size!==1)throw Error('queued review report has ambiguous contradictory verdicts; retain immutable bytes for judgment');
  const findings=[];
  for(const line of String(body).split('\n')){const m=/^\s*[-*]\s*\[(Major|Minor)\]\s*(.+)$/i.exec(line);if(m)findings.push({severity:m[1].toLowerCase(),text:m[2].trim()});}
  const raw=report.extra?.findings;if(Array.isArray(raw))for(const f of raw)if(f&&['major','minor'].includes(String(f.severity).toLowerCase()))findings.push({severity:String(f.severity).toLowerCase(),text:String(f.text??f.summary??''),
    ...(typeof f.correction_check==='string'&&f.correction_check.trim()?{correction_check:f.correction_check.trim()}:{})});
  const corrections=reviewCorrectionEvents({state,events,run,review,report,findings,verdict,sha256,usedIds});
  return [{type:'change.reviewed',item:source,head:target.head,base:target.base,review_key:key,review_group_key:queueProducerGroup(review),covered_commits:capturedReviewCommits(target),review_item:review.id,review_run:run.id,verdict,
    verdict_evidence:{frontmatter:report.extra?.verdict!==undefined,body_lines:bodyLines},findings:corrections.findings,report_sha256:sha256},...corrections.add];
}

// Selected installed record CLIs retain their forwarding. The current service
// records its own review facts from the immutable ingested bytes, without
// replacing that consumer, its pin, its report or its native/run ownership.
export function recordReviewResults({repo,org,runId,env=process.env}) {
  const guard=()=>{const b=serviceRecordBinding({repo,org,env});if([path.join(b.directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')].some(file=>fs.existsSync(file)))throw Error('STOP/HOLD prevents review result mutation');return b;};
  guard();
  return planTransaction(org,(events,state)=>{
    guard();
    const run=state.runs.get(runId),item=state.items.get(run?.item);
    if(!run?.report||!roleIs(item,'REV')||!item.meta.review_target)throw Error('no ingested immutable queued review result');
    const owned=readOwnedRun(org,runId,events);requireController(owned,'brain');assertOwner(owned,{owner:run.owner,generation:run.owner_generation});
    const file=path.resolve(org,run.report.file),text=fs.readFileSync(file,'utf8');
    if(!file.startsWith(path.resolve(org)+path.sep)||hash(text)!==run.report.sha256)throw Error('ingested review bytes changed');
    const parsed=readReport(text);if(parsed.errors.length)throw Error('immutable queued review report is invalid');
    const add=reviewResultEvents({state,events,run,report:parsed.report,sha256:run.report.sha256,body:parsed.body});
    if(!add.length)return {add:[]};
    return protectRecordMutation({org,state,events,mutation:{add},command:'line-service immutable review result'});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
}

export function morningDigest({events,diagnostics=[],since,now=new Date().toISOString()}) {
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
  const health=diagnostics.findLast(e=>e.action==='review-health'&&e.health)?.health??events.findLast(e=>e.type==='line-service.review-health'),before=new Map(),through=new Map();
  const counted=(e,key,count)=>{through.set(key,Math.max(through.get(key)??0,count));if(!inWindow(e))before.set(key,Math.max(before.get(key)??0,count));};
  for(const e of events)if(e.type==='line-service.review-error')counted(e,e.key,Number.isSafeInteger(e.count)?e.count:1);
  else if(e.type==='line-service.review-error-counts'&&e.counts&&typeof e.counts==='object')for(const [key,count]of Object.entries(e.counts))if(Number.isSafeInteger(count))counted(e,key,count);
  for(const e of diagnostics)if(e.notice_record?.entry?.review)counted(e,e.notice_record.key,e.notice_record.entry.count);
  const errors=[...through].map(([key,count])=>({key,count:count-(before.get(key)??0)})).filter(e=>e.count>0);
  return {since:since??null,through:now,landings,reviews,findings:reviews.flatMap(r=>r.findings??[]),holds,idle_hours:idle,review_health:health??null,
    review_errors:{unique:errors.length,occurrences:errors.reduce((n,e)=>n+e.count,0),scope:'Diagnostic cumulative error counts plus retained historical record counts within this window; no delivery or consumption is inferred.'},scope:'Durable intent and outcomes from the record; health and counters from diagnostic journals when supplied. Unknown exact landing/idle intervals stay null.'};
}
