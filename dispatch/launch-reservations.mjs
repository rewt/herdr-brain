#!/usr/bin/env node
// Dispose of an exact, provably unlaunched request. No native completion,
// journal rewrite, replacement launch, identity adoption or supervisor cycle.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {isMain} from '../lib/cli-help.mjs';
import {gitProject} from '../lib/project.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold,openQuestionsFor} from '../lib/state.mjs';
import {assertOwner,readOwnedRun} from '../lib/run-owner-guard.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {invokeHerdr} from '../lib/herdr-command.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {lockRequest} from './request-lock.mjs';
import {acquireSessionCapLock} from './session-cap.mjs';

export const MIN_LAUNCH_AGE_MS = 60_000;
// Audited legacy lane source: its require(launch-guard) throws in checkLaunch,
// before shell preparation and agent start. Error code alone is not proof.
const PRE_NATIVE_IMPORT_BLOB = '2688f81b4bc7fedc71c9dc2b803a0d87a1df76c23f3a0d0977b3e40b33e37944';
const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function plain(file){if(!fs.lstatSync(file).isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error('launch evidence is redirected');return fs.readFileSync(file);}

export function launchDisposition({job,run,events=[],now=Date.now(),laneSource}){
  const keep=reason=>({disposition:'KEEP',reason});
  if(!run)return keep('original run is missing');
  if(run.abandoned)return{disposition:'RELEASED',reason:'recorded run abandonment',seq:run.abandoned.seq};
  if(run.report)return{disposition:'RELEASED',reason:'recorded worker report',seq:run.report.seq};
  const keys=['agent','pane','worker_workspace','terminal_id','agent_session_id'];
  if(job.worker||job.launchProcess||job.sessionBinding||job.watcher||
      keys.some(k=>run.meta?.[k])||events.some(e=>(e.id===run.id||e.run===run.id)&&
        (e.type==='run.session_bound'||e.type==='dispatch.completed'&&(e.exit_code===0||e.worker||e.stage!=='launching')||e.type==='run.updated'&&keys.some(k=>e.meta?.[k]))))
    return keep('native worker, process, session, watcher or historical binding exists');
  if(job.stage!=='launching')return keep('original journal is not at launching');
  const times=[Date.parse(run.started?.at),...(job.failure?.observed_at?[Date.parse(job.failure.observed_at)]:[])];
  if(times.some(t=>!Number.isFinite(t)||now-t<MIN_LAUNCH_AGE_MS))return keep('launch is younger than the fixed one-minute bound or has unknown time');
  if(/EPERM|EACCES|native refusal|foreign|identity|reserved|HOLD|STOP/i.test(job.error??''))return keep('native refusal or ownership/STOP/HOLD boundary remains stopped');
  if(job.native_launch_attempted===false)return{disposition:'ELIGIBLE',reason:'explicit pre-native launch barrier'};
  if(/(?:^|\n)(?:.* dispatch: )?lane: could not verify initial pane environment [^\n;]+; initial tab retained, nothing started$/.test(job.error??''))
    return{disposition:'ELIGIBLE',reason:'definitive initial-shell refusal before agent start'};
  if(job.native_launch_attempted===true&&job.failure?.stage==='launching'&&job.failure.code==='ERR_REQUIRE_ASYNC_MODULE'&&
      /dispatch: lane: require\(\) cannot be used on an ESM graph with top-level await\./.test(job.error??'')&&
      laneSource&&digest(laneSource)===PRE_NATIVE_IMPORT_BLOB)
    return{disposition:'ELIGIBLE',reason:'audited pre-native launch-guard import crash',lane_source_sha256:PRE_NATIVE_IMPORT_BLOB};
  return keep('native launch outcome is ambiguous; age and missing agent entries do not prove no worker');
}

export function inspectLaunch({repo,org,journal,events=loadEvents(org).events,now=Date.now()}){
  const project=gitProject(repo);org=fs.realpathSync(org);journal=path.resolve(journal);
  if(path.dirname(journal)!==path.join(org,'dispatch'))throw Error('request is outside its owning dispatch directory');
  const bytes=plain(journal),job=JSON.parse(bytes),run=fold(events).runs.get(job.run);
  if(job.repo!==project.canonical||job.org!==org||job.common!==project.identity||path.basename(journal)!==`${job.token}.json`||
      !run||run.item!==job.item||run.workspace!==job.workspace||run.meta.dispatch_journal!==journal||
      run.meta.dispatch_attempt!==job.token||run.meta.dispatch_project!==project.identity||run.meta.dispatch_record!==org)
    throw Error('original request/run/project binding differs');
  let laneSource;
  if(job.failure?.code==='ERR_REQUIRE_ASYNC_MODULE'&&/^[a-f0-9]{40}$/.test(job.base??''))
    try{laneSource=execFileSync('git',['-C',project.canonical,'show',`${job.base}:lanes/lane.mjs`],{stdio:['ignore','pipe','pipe']});}catch{/* Missing source is KEEP. */}
  return{journal,run:run.id,item:job.item,token:job.token,journal_sha256:digest(bytes),...launchDisposition({job,run,events,now,laneSource})};
}

export function resolveLaunch({repo,org,journal,id,decisionSeq,cwd=process.cwd(),env=process.env,call=invokeHerdr,admissionLock=acquireSessionCapLock}){
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id??'')||!Number.isSafeInteger(decisionSeq))throw Error('resolution needs a stable id and scoped decision sequence');
  const project=gitProject(repo);repo=project.canonical;org=fs.realpathSync(org);journal=path.resolve(journal);
  const binding=nativeSender(org,{cwd,env,call});
  const supervisor=readProjectPolicy(repo,'promote',env,{canonical:repo}).config.to;
  if(project.checkout!==repo||binding.project.checkout!==repo||binding.project.identity!==project.identity||!supervisor||binding.native.name!==supervisor)
    throw Error('only the actual canonical project supervisor may resolve another launch');
  if(!env.HERDR_BRAIN_ROOT||fs.realpathSync(env.HERDR_BRAIN_ROOT)!==root)throw Error('explicit matching source entry required');
  const initial=inspectLaunch({repo,org,journal}),bytes=plain(journal),job=JSON.parse(bytes);
  const tuple=b=>JSON.stringify([b.native.name,b.native.pane_id,b.native.workspace_id,b.native.terminal_id,b.native.agent_session.value]);
  const sourceHead=git(root,['rev-parse','HEAD']),targetHead=git(repo,['rev-parse','HEAD']);
  const requestLock=lockRequest(journal);let release;
  try{
    release=admissionLock(project.identity);
    const guard=events=>{
      if(tuple(nativeSender(org,{cwd,env,call}))!==tuple(binding)||readProjectPolicy(repo,'promote',env,{canonical:repo}).config.to!==supervisor)
        throw Error('native supervisor identity changed');
      if(git(root,['rev-parse','HEAD'])!==sourceHead||git(root,['status','--porcelain=v1'])||git(repo,['rev-parse','HEAD'])!==targetHead||git(repo,['status','--porcelain=v1']))
        throw Error('committed source/clean project CAS changed');
      if(digest(plain(journal))!==initial.journal_sha256)throw Error('original journal changed');
      for(const file of [path.join(lineDirectory(org,project.identity),'STOP'),...['STOP','HOLD'].map(n=>path.join(repo,'.lane/supervisor',n))])
        if(fs.existsSync(file))throw Error('STOP/HOLD prevents launch resolution');
      const state=fold(events),run=assertOwner(readOwnedRun(org,job.run,events),job.ownership);
      for(const name of fs.readdirSync(path.dirname(journal)).filter(n=>n.endsWith('.json')&&!n.endsWith('.routes.json'))){
        const peerFile=path.join(path.dirname(journal),name);if(peerFile===journal)continue;
        const peer=JSON.parse(plain(peerFile));
        if(peer.run===job.run||peer.token===job.token)throw Error('original launch has a competing journal; retain both requests');
      }
      for(let item=state.items.get(job.item);item;item=state.items.get(item.parent))
        if(item.role==='human'||['hold','held','reserved','operator_reserved'].some(k=>item.meta?.[k]))throw Error('item/ancestor reserved or held');
      if(openQuestionsFor(state,job.item).length)throw Error('pending operator question prevents launch resolution');
      const decision=events.find(e=>e.seq===decisionSeq&&e.type==='note.added'&&e.decision&&e.by===binding.native.name&&e.id===job.item&&
        [id,journal,initial.journal_sha256,'NOT_STARTED'].every(v=>e.text.includes(v)));
      if(!decision)throw Error('exact supervisor NOT_STARTED decision with journal hash is required');
      if(fs.existsSync(job.workspace)){
        const old=gitProject(job.workspace);
        if(old.identity!==project.identity||old.checkout!==job.workspace||git(job.workspace,['status','--porcelain=v1','--untracked-files=all']))throw Error('original workspace is foreign or dirty');
        for(const p of ['.lane/HOLD','.lane/supervisor/HOLD','.lane/supervisor/STOP'])if(fs.existsSync(path.join(job.workspace,p)))throw Error('original workspace STOP/HOLD');
      }
      const reply=JSON.parse(call('herdr',['agent','list']));
      if(reply.error||!Array.isArray(reply.result?.agents))throw Error('fresh native inventory is unavailable');
      if(reply.result.agents.some(a=>[a.cwd,a.foreground_cwd].filter(Boolean).some(p=>path.resolve(p)===job.workspace)))throw Error('original workspace has a native occupant');
      const result=inspectLaunch({repo,org,journal,events});
      if(result.disposition!=='ELIGIBLE')throw Error(`launch reservation retained: ${result.reason}`);
      return{run,result};
    };
    const events=loadEvents(org).events,prior=events.find(e=>e.type==='dispatch.launch-resolved'&&(e.id===id||e.journal===journal));
    if(prior){
      if(prior.id!==id||prior.journal!==journal||prior.journal_sha256!==initial.journal_sha256||prior.decision_seq!==decisionSeq||
          digest(plain(prior.archive.file))!==prior.archive.sha256)throw Error('existing disposition differs or its archive changed');
      return{...prior,existing:true};
    }
    guard(events);
    const archive=path.join(org,'evidence/launch-reservations',id,'request.json');fs.mkdirSync(path.dirname(archive),{recursive:true});
    try{const fd=fs.openSync(archive,'wx',0o444);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    catch(error){if(error.code!=='EEXIST'||digest(plain(archive))!==initial.journal_sha256)throw error;}
    const fd=fs.openSync(path.dirname(archive),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const result=transact(org,events=>{
      const {result}=guard(events);
      if(events.some(e=>e.type==='dispatch.launch-resolved'&&(e.id===id||e.journal===journal)))throw Error('original disposition already recorded');
      return protectRecordMutation({org,events,state:fold(events),command:'dispatch resolve-launch',mutation:{add:[
        {type:'dispatch.launch-resolved',id,journal,run:job.run,item:job.item,token:job.token,project:project.identity,org,
          journal_sha256:initial.journal_sha256,decision_seq:decisionSeq,ownership:job.ownership,native_caller:binding.native,
          source_head:sourceHead,target_head:targetHead,disposition:'NOT_STARTED',reason:result.reason,
          ...(result.lane_source_sha256?{lane_source_sha256:result.lane_source_sha256}:{}),archive:{file:archive,sha256:initial.journal_sha256},native_completion:false},
        {type:'run.abandoned',id:job.run,note:`Definitive NOT_STARTED: ${result.reason}; reservation ${id}. No native completion or replacement.`}
      ]}});
    },{actor:binding.native.name,strictTail:true,lockOptions:{recover:false}});
    return{...result.added[0],existing:false};
  }finally{try{release?.();}finally{requestLock.release();}}
}

if(isMain(import.meta.url)){
  try{
    const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{repo:{type:'string',default:process.cwd()},org:{type:'string',default:process.env.ORG_DIR},journal:{type:'string'},id:{type:'string'},'decision-seq':{type:'string'}}});
    if(p.length!==1||!['inspect','resolve'].includes(p[0])||!v.org||!v.journal)throw Error('usage: launch-reservations.mjs inspect|resolve --org DIR --journal FILE [--repo DIR] [--id ID --decision-seq SEQ]');
    console.log(JSON.stringify(p[0]==='inspect'?inspectLaunch(v):resolveLaunch({...v,decisionSeq:Number(v['decision-seq'])}),null,2));
  }catch(error){console.error(`launch-reservations: ${error.message}`);process.exitCode=1;}
}
