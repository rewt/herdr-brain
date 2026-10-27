import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {transact,loadEvents} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {resolveNotStarted,resolvedNotStarted} from '../dispatch/not-started.mjs';
import {lockRequest} from '../dispatch/request-lock.mjs';
import {checkSessionCap} from '../dispatch/session-cap.mjs';
import {dispatchInput} from '../line-service/phase1.mjs';
import {createLineService,serviceDirectory} from '../line-service/line-service.mjs';
const source=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const sourceGit=args=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,common=gitProject(f.cwd).identity,a=f.observation.agents[0],sourceHead=sourceGit(['rev-parse','HEAD']),lane=path.join(f.ownerRoot,'original-lane');
  f.git('worktree','add','-qb','lane/line-eng-1-1',lane);
  transact(org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Real proof'}]}));const item=fold(loadEvents(org).events).items.get('ENG-1'),input=`${item.created.seq}:ordinary`,key=`dispatch:ENG-1:${input}`;
  const journal=path.join(org,'dispatch/original.json');fs.mkdirSync(path.dirname(journal),{recursive:true});const job={token:'original',repo:f.cwd,org,common,item:item.id,lane:'line-eng-1-1',base:f.git('rev-parse','HEAD'),stage:'open',run:null,worker:null,detached:true,sourceSelection:{head:sourceGit(['rev-parse','HEAD^']),root:source}};fs.writeFileSync(journal,JSON.stringify(job));
  const directory=serviceDirectory(org,common),effectsFile=path.join(directory,'effects.json'),effect={state:'held',at:'2026-10-27T04:01:10Z',error:'spawnSync pinned Node ETIMEDOUT',receipt:{status:null,signal:'SIGTERM',stdout:'',stderr:'',error:'ETIMEDOUT'}};fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(effectsFile,JSON.stringify({identity:common,org,actions:{[key]:effect},notices:{}}));
  const disposition=path.join(org,'not-started.json');fs.writeFileSync(disposition,JSON.stringify({original_request:journal,conclusion:'NOT STARTED, high confidence',disposition:'Delegate authorizes archive of exact request and one fresh LINE-owned start on changed source; no manual proof dispatch.'}));
  const id='fixture-not-started';transact(org,()=>({add:[{type:'note.added',id:item.id,decision:true,text:`Delegate disposition ONLY ${item.id} ${journal} ${id} NOT STARTED; fresh source ${sourceHead}, archive original receipt and let existing line act, no retry.`}]}),{actor:a.name});
  const call=(_exe,args)=>JSON.stringify({result:args[1]==='list'?{agents:[a]}:{agent:a}}),env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:a.pane_id,HERDR_WORKSPACE_ID:a.workspace_id,CODEX_THREAD_ID:a.agent_session.value,HERDR_BRAIN_ROOT:source};
  const args={repo:f.cwd,org,journal,disposition,decisionSeq:loadEvents(org).events.at(-1).seq,id,changedSource:sourceHead,role:'supervisor',cwd:f.cwd,env,call};
  return{...f,org,common,lane,job,journal,args,key,effect,effectsFile,call,item,context:()=>{const events=loadEvents(org).events;return{events,state:fold(events),org,identity:common,item:fold(events).items.get(item.id)};}};
}
test('not-started exact owner disposition archives raw evidence and lets only the line start fresh once on changed source',t=>{
  const f=fixture(t),jobBytes=fs.readFileSync(f.journal),effectBytes=fs.readFileSync(f.effectsFile),before=dispatchInput(f.context());
  const cap={config:{dispatch:{max_sessions:1}},org:f.org,common:f.common};assert.throws(()=>checkSessionCap(cap),/cap 1 reached/);
  const result=resolveNotStarted(f.args);assert.equal(result.result,'not_started_archived');assert.equal(result.original_success,false);assert.deepEqual(fs.readFileSync(f.journal),jobBytes);assert.deepEqual(fs.readFileSync(f.effectsFile),effectBytes);
  const after=dispatchInput(f.context());assert.notEqual(after,before);assert.match(after,/:resolved-\d+$/);assert.equal(checkSessionCap(cap).count,0);assert.equal(resolveNotStarted(f.args).existing,true);
  let starts=0;const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,capacity:()=>({count:0,cap:1}),recordNotice:r=>({id:r.id}),command:(_exe,args)=>{
    if(args[0].endsWith('/dispatch/dispatch.mjs')){starts++;assert.ok(args.includes('--detach'));assert.equal(args.includes('--retry'),false);const journal=path.join(f.org,'dispatch/fresh.json');fs.writeFileSync(journal,JSON.stringify({token:'fresh',repo:f.cwd,org:f.org,common:f.common,item:f.item.id,brief:args[args.indexOf('--brief')+1],stage:'open',native_launch_attempted:false}));return{status:0,stdout:JSON.stringify({result:'detached',journal}),stderr:''};}
    return{status:0,stdout:'{}',stderr:''};}});
  service.pass();service.pass();assert.equal(starts,1);assert.deepEqual(fs.readFileSync(f.journal),jobBytes);assert.equal(loadEvents(f.org).events.filter(e=>e.type==='dispatch.not-started').length,1);
  fs.writeFileSync(f.journal,JSON.stringify({...f.job,stage:'worker',run:'R-9'}));assert.throws(()=>dispatchInput(f.context()),/progressed/);
});
test('not-started resolution refuses native progress foreign caller dirty lane STOP and unchanged source before recording disposition',t=>{
  for(const kind of ['progress','foreign','dirty','stop','unchanged','occupied']){
    const f=fixture(t),args={...f.args};
    if(kind==='progress')fs.writeFileSync(f.journal,JSON.stringify({...f.job,native_launch_attempted:true}));
    if(kind==='foreign')args.env={...args.env,CODEX_THREAD_ID:'foreign'};
    if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'not-integrated'),'unfinished');
    if(kind==='stop'){fs.mkdirSync(path.join(f.cwd,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.cwd,'.lane/supervisor/STOP'),'STOP');}
    if(kind==='unchanged')fs.writeFileSync(f.journal,JSON.stringify({...f.job,sourceSelection:{head:args.changedSource,root:source}}));
    if(kind==='occupied')args.call=(exe,a)=>a[1]==='list'?JSON.stringify({result:{agents:[{name:'actual-occupant',cwd:f.lane}]}}):f.call(exe,a);
    assert.throws(()=>resolveNotStarted(args),/progress|binding|dirty|STOP|unchanged|occupant/);assert.equal(loadEvents(f.org).events.some(e=>e.type==='dispatch.not-started'),false);
  }
});
test('not-started request serialization recovers positive ESRCH only and preserves live denied or unknown ownership',t=>{
  const f=fixture(t);
  for(const code of ['live','EPERM','EACCES','unknown']){fs.writeFileSync(f.journal+'.lock','876543');assert.throws(()=>lockRequest(f.journal,{kill:()=>{if(code!=='live')throw Object.assign(Error(code),{code});}}),/running|EPERM|EACCES|unknown/);assert.equal(fs.readFileSync(f.journal+'.lock','utf8'),'876543');}
  const held=lockRequest(f.journal,{kill:()=>{throw Object.assign(Error('absent'),{code:'ESRCH'});}});assert.equal(fs.readFileSync(f.journal+'.lock','utf8'),String(process.pid));held.release();assert.equal(fs.existsSync(f.journal+'.lock'),false);
});
test('not-started native refusal remains stopped despite an elapsed-only disposition',t=>{
  const f=fixture(t);fs.writeFileSync(f.journal,JSON.stringify({...f.job,error:'EPERM native refusal'}));
  assert.throws(()=>resolveNotStarted(f.args),/native refusal\/ownership guard/);assert.equal(loadEvents(f.org).events.some(e=>e.type==='dispatch.resolution-intent'||e.type==='dispatch.not-started'),false);
});
