// Landed-change facts and record-derived decisions. No native effects/models.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {reviewScope,claimedCommitTokens} from '../settle/review-range.mjs';
import {nextItemId,fold,extendFold,itemStatus} from '../lib/state.mjs';
import {roleIs} from '../lib/roles.mjs';
import {transact} from '../lib/store.mjs';
import {readReport} from '../lib/report.mjs';
import {readOwnedRun,requireController,assertOwner} from '../lib/run-owner.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {serviceRecordBinding} from './record-inbox.mjs';
import {reviewResolution} from './review-resolutions.mjs';
import {resolvedDispatchInput} from '../dispatch/not-started.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}).trim();
const ancestor=(repo,a,b)=>{try{git(repo,['merge-base','--is-ancestor',a,b]);return true;}catch{return false;}};
export function phase0Boundary(events,{repo,org,identity}) {
  const rows=events.filter(e=>e.type==='line-service.phase0'&&e.project===identity&&e.org===org);
  if(rows.length!==1||rows[0].repo!==repo||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(rows[0].canonical_head??'')||!Number.isSafeInteger(rows[0].seq)||rows[0].seq<1||!rows[0].main)throw Error('explicit intended Phase0 source boundary missing/ambiguous; exact18:55 head is UNKNOWN');
  return rows[0];
}

export function discoverChanges({events,state,repo,org,identity,boundary,readGit=git,pendingOnly=false}) {
  const changes=[],holds=[];
  try{boundary??=phase0Boundary(events,{repo,org,identity});}catch(e){return {changes,holds:[{reason:e.message}]};}
  const tip=readGit(repo,['rev-parse',`refs/heads/${boundary.main??'main'}`]),seen=new Set();
  const eligible=new Set(readGit(repo,['rev-list',`${boundary.canonical_head}..${tip}`]).split('\n').filter(Boolean));
  const authorized=new Map();for(const e of events)if(e.type==='review.recovery-completed'&&e.project===identity&&e.org===org&&e.target?.head)authorized.set(`${e.item}:${e.target.head}`,e);
  const settled=new Set([...state.items.values()].filter(i=>roleIs(i,'REV')&&i.meta.review_key).map(i=>i.meta.review_key));
  for(const e of events)if(e.type==='change.reviewed')settled.add(`${e.item}:${e.head}`);
  const landed=new Map();for(const e of events)if(e.type==='change.landed'&&e.project===identity&&eligible.has(e.head)){
    const list=landed.get(e.run)??[];list.push(e.head);landed.set(e.run,list);
  }
  for(const run of state.runs.values()) {
    const item=state.items.get(run.item);
    if(!item||!roleIs(item,'ENG')||!run.report||roleIs(state.items.get(item.parent),'REV')||item.meta.review_fix_of)continue;
    // Two Git reads index the owed interval. Settled history performs no Git,
    // filesystem/native inventory or per-report hash read.
    const tokens=claimedCommitTokens(run.report.artifacts??[]);
    const backfills=[...authorized.values()].filter(e=>e.run===run.id&&e.item===item.id),candidates=[...eligible,...backfills.map(e=>e.target.head)];
    const owed=head=>(eligible.has(head)||authorized.get(`${item.id}:${head}`)?.run===run.id)&&(!pendingOnly||!settled.has(`${item.id}:${head}`));
    if(!(landed.get(run.id)??[]).some(owed)&&!backfills.some(e=>owed(e.target.head))&&!tokens.some(token=>candidates.some(head=>head.startsWith(token)&&owed(head))))continue;
    let claims;try{claims=[...new Set([...reviewScope({workspace:repo,base:boundary.canonical_head,head:boundary.canonical_head,artifacts:run.report.artifacts??[]}).claims,...(landed.get(run.id)??[]),...backfills.map(e=>e.target.head)])];}
    catch(e){holds.push({item:item.id,run:run.id,reason:e.message});continue;}
    for(const head of claims) {
      if(!owed(head))continue;
      const key=`${item.id}:${head}`;if(seen.has(key))continue;
      try {
        const reportFile=path.resolve(org,run.report.file??'');
        if(!reportFile.startsWith(path.resolve(org)+path.sep)||hash(fs.readFileSync(reportFile))!==run.report.sha256)throw Error('immutable producer report bytes changed/missing');
        const start=events.find(e=>e.type==='run.started'&&e.id===run.id),file=start?.meta?.dispatch_journal;
        if(!file||!path.resolve(file).startsWith(path.join(path.resolve(org),'dispatch')+path.sep))throw Error('original dispatch/source attribution missing');
        const dispatch=JSON.parse(fs.readFileSync(file,'utf8'));
        if(dispatch.item!==item.id||dispatch.run!==run.id||dispatch.common!==identity||dispatch.org!==org||dispatch.token!==start.meta.dispatch_attempt||dispatch.workspace!==run.workspace)throw Error('original source ownership/project attribution changed');
        const authorization=authorized.has(key)?reviewResolution({events,org,item:item.id,head})?.event:null,base=authorization?.target.base??git(repo,['rev-parse',`${head}^1`]),diff=git(repo,['diff','--no-ext-diff','--no-textconv',base,head]);
        if(!diff)continue;
        const target={head,base,reportHash:run.report.sha256,evidence:reportFile,diff_sha256:hash(diff),dispatch:file,
          scope:authorization?.target.scope??{base,commits:[head],claims:[head],unresolved:[],deferred:false}};
        if(authorization&&JSON.stringify(authorization.target)!==JSON.stringify(target))throw Error('authorized legacy source/evidence tuple changed');
        changes.push({item,run,target,...(authorization?{authorization}:{}),cutoff:{id:boundary.id,seq:boundary.seq,head:boundary.canonical_head,main:boundary.main??'main',time_qualification:boundary.time_qualification??'intended source boundary; exact adoption-time head UNKNOWN'}});seen.add(key);
      }catch(e){holds.push({item:item.id,run:run.id,head,reason:e.message});}
    }
  }
  return {changes,holds};
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
  const add=[{type:'change.reviewed',item:source,head:target.head,base:target.base,review_key:key,review_item:review.id,review_run:run.id,verdict,
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
  return {since:since??null,through:now,landings,reviews,findings:reviews.flatMap(r=>r.findings??[]),holds,idle_hours:idle,scope:'Record-observed facts; unknown exact landing/idle intervals stay null.'};
}
