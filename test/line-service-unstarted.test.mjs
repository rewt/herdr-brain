import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {validateQueuedReview,reserveUnstartedReview} from '../line-service/review-queue.mjs';
import {recoverUnstartedReview} from '../line-service/review-unstarted.mjs';
import {reviewDigest as hash,resolvedReviewJournal} from '../line-service/review-resolutions.mjs';
import {dispatchInput} from '../line-service/phase1.mjs';
import {fixture as dispatchFixture,promptCalls} from '../dispatch/test/dispatch-fixture.mjs';
import {spawnChild,waitForExit} from './helpers/child.mjs';
import {lockRequest} from '../dispatch/request-lock.mjs';

const root=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url))),entry=path.join(root,'bin/org.mjs');
function fixture(t,{canonical=true,abandoned=true}={}){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,base=f.git('rev-parse','HEAD');
  const git=(args,cwd=f.cwd)=>{const r=spawnSync('git',['-C',cwd,...args],{env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  fs.writeFileSync(path.join(f.cwd,'build'),'actual source');git(['add','build']);git(['commit','-qm','Landed change']);const head=git(['rev-parse','HEAD']);
  const directory=lineDirectory(org,identity);fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({repo:f.cwd,org,source:root,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const add=(rows,actor='fixture-supervisor')=>transact(org,()=>({add:rows}),{actor});
  add([{type:'line-service.cutover',id:'cutover',project:identity,repo:f.cwd,org,source:root,main:'main',canonical_head:base},{type:'line-service.phase0',id:'phase0',project:identity,repo:f.cwd,org,source:root,main:'main',canonical_head:base}]);
  const owner={controller:'brain',legacy:false,release:{id:'source',root,commit:null,identity:gitProject(root).identity}};
  fs.mkdirSync(path.join(org,'dispatch'),{recursive:true});
  if(!canonical){
    const dispatch=path.join(org,'dispatch/source.json'),report='---\nrun: R-1\noutcome: done\nsummary: Landed source.\nartifacts:\n  - "Commit: '+head+'"\n---\n';
    fs.writeFileSync(dispatch,JSON.stringify({token:'source',run:'R-1',item:'ENG-1',org,common:identity,workspace:f.cwd,base,stage:'complete'}));fs.writeFileSync(path.join(org,'reports/R-1.md'),report);
    add([{type:'item.added',id:'ENG-1',role:'engineer',title:'Build'},{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.cwd,meta:{lane:'source',dispatch_journal:dispatch,dispatch_attempt:'source'}},{type:'run.claimed',run:'R-1',project:identity,record:org,owner},{type:'report.ingested',run:'R-1',file:'reports/R-1.md',sha256:hash(report),report:{outcome:'done',artifacts:[`Commit: ${head}`],extra:{},blockers:[],proposals:[]}}]);
  }
  const serviceEnv={...f.env,ORG_ACTOR:'line-service',HERDR_BRAIN_ROOT:root};for(const k of ['HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID'])delete serviceEnv[k];
  const queued=spawnSync(process.execPath,[entry,'queue-review',canonical?`canonical:${head}`:'R-1'],{cwd:f.cwd,env:serviceEnv,encoding:'utf8'});assert.equal(queued.status,0,queued.stderr);const reviewId=JSON.parse(queued.stdout).review_item;
  const context=()=>{const events=loadEvents(org).events,state=fold(events);return{events,state,org,repo:f.cwd,identity,item:state.items.get(reviewId)};};
  const workspace=path.join(f.ownerRoot,'review-original');git(['worktree','add','-qb','lane/review-original',workspace,head]);
  const journal=path.join(org,'dispatch/original.json'),routeConfig=path.join(org,'dispatch/original.routes.json'),brief=path.join(org,'original-ask.md');fs.writeFileSync(routeConfig,'{}');fs.writeFileSync(brief,'Review the exact original change.');
  const meta={lane:'review-original',route:'review-codex',dispatch_journal:journal,dispatch_attempt:'original',dispatch_project:identity,dispatch_record:org,dispatch_role:'review'};
  add([{type:'run.started',id:'R-918',item:reviewId,workspace,report_path:path.join(org,'runs/R-918/report.md'),meta},{type:'run.claimed',run:'R-918',project:identity,record:org,owner},...(abandoned?[{type:'run.abandoned',id:'R-918',note:'Positive zero-native disposition; preserve history.'}]:[])]);
  const r=context().state.runs.get('R-918'),job={token:'original',repo:f.cwd,org,common:identity,item:reviewId,lane:'review-original',route:'review-codex',release:{root,id:null,commit:null,protocol:1},sourceSelection:{root,head:git(['rev-parse','HEAD'],root)},reviewQueueProtocol:1,reviewQueue:context().item.meta.review_target,reviewQueueBrief:'Exact scope; zero suites.',workspace,brief,routeConfig,base:head,run:r.id,stage:'worker',native_launch_attempted:false,ownership:{owner:r.owner,generation:r.owner_generation},failure:{code:'DISPATCH_SESSION_CAP_LOCKED',kind:'guard-or-command',stage:'worker',native_launch_attempted:false},error:'admission lock wait exhausted'};
  fs.writeFileSync(journal,JSON.stringify(job));fs.mkdirSync(journal+'.driver');fs.writeFileSync(journal+'.driver/results.jsonl',JSON.stringify({journal,run:r.id,stage:'worker',native_launch_attempted:false,exit_code:1})+'\n');
  const resolution=path.join(org,'unstarted.json'),id='never-started-original',native=f.observation.agents[0],env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:native.pane_id,HERDR_WORKSPACE_ID:native.workspace_id,CODEX_THREAD_ID:native.agent_session.value,HERDR_BRAIN_ROOT:root};
  let input,decisionSeq;
  const authorize=(extra={})=>{input={review_item:reviewId,journal,journal_sha256:hash(fs.readFileSync(journal)),head,base,...extra};fs.writeFileSync(resolution,JSON.stringify(input));add([{type:'note.added',id:reviewId,decision:true,text:`Authorize ${id} only for ${reviewId} ${head} original ${journal} SHA256 ${input.journal_sha256}; retain all history, one unchanged normal dispatch.`}],native.name);decisionSeq=context().events.at(-1).seq;};authorize();
  const calls=[],call=(_exe,args)=>{calls.push(args);return JSON.stringify({result:args[1]==='list'?{agents:[native]}:{agent:native}});};
  const args=()=>({repo:f.cwd,org,reviewId,resolution,decisionSeq,id,role:'supervisor',cwd:f.cwd,env,call});
  return{...f,org,identity,base,head,git,reviewId,context,workspace,journal,job,add,resolution,env,serviceEnv,args,authorize,calls,call,directory};
}

for(const canonical of [true,false])test(`never-started ${canonical?'canonical':'producer'} recovery retains history and authorizes one normal dispatch`,t=>{
  const f=fixture(t,{canonical}),before=f.context(),bytes=fs.readFileSync(f.journal),claims=before.events.filter(e=>e.type==='run.claimed'),input=dispatchInput({...before,item:before.item,identity:f.identity});
  assert.throws(()=>validateQueuedReview(before),/already has a run/);
  const result=recoverUnstartedReview(f.args());assert.equal(result.result,'unstarted_review_ready');assert.equal(result.dispatch_base,f.head);
  const after=f.context(),q=after.item;assert.deepEqual(q.meta,before.item.meta);assert.deepEqual(q.runs,['R-918']);assert.deepEqual(after.events.filter(e=>e.type==='run.claimed'),claims);assert.deepEqual(fs.readFileSync(f.journal),bytes);
  assert.equal(after.events.some(e=>e.type==='change.reviewed'),false);assert.equal(after.events.filter(e=>e.type==='review.unstarted-authorized').length,1);assert.equal(validateQueuedReview(after).head,f.head);assert.notEqual(dispatchInput({...after,item:q,identity:f.identity}),input);
  assert.equal(resolvedReviewJournal({...after,common:f.identity,journal:f.journal}),true);
  assert.equal(recoverUnstartedReview(f.args()).existing,true);assert.equal(f.calls.every(a=>a[0]==='agent'&&['get','list'].includes(a[1])),true);
  const grant=after.events.find(e=>e.type==='review.unstarted-authorized'),manifest=JSON.parse(fs.readFileSync(grant.archive.file)),saved=manifest.files.find(row=>row.original===f.journal);assert.deepEqual(fs.readFileSync(saved.archive),bytes);
  const job={...f.job,token:'replacement',run:null,lane:'review-replacement',workspace:null,stage:'open',to:null},journal=path.join(f.org,'dispatch/replacement.json');
  reserveUnstartedReview({org:f.org,repo:f.cwd,journal,job,env:f.env});fs.writeFileSync(journal,JSON.stringify(job));
  assert.equal(validateQueuedReview({...f.context(),allowJournal:journal}).head,f.head);
  assert.throws(()=>reserveUnstartedReview({org:f.org,repo:f.cwd,journal:journal+'x',job:{...job,token:'other'},env:f.env}),/already reserved/);
  assert.throws(()=>validateQueuedReview(f.context()),/already reserved/);
});

test('never-started recovery atomically abandons only a positively unstarted open original',t=>{
  const f=fixture(t,{abandoned:false}),old=f.context().state.runs.get('R-918');recoverUnstartedReview(f.args());
  const c=f.context(),r=c.state.runs.get(old.id);assert.ok(r.abandoned);assert.deepEqual(r.owner,old.owner);assert.equal(r.owner_generation,old.owner_generation);assert.equal(c.events.filter(e=>e.type==='run.abandoned').length,1);assert.equal(validateQueuedReview(c).head,f.head);
});

for(const kind of ['true','unknown','worker','process','binding','watcher','native-refusal','preparation','claim','record-binding','report','verdict','native-present','native-unknown','hold','ancestor-hold','stop','peer'])test(`never-started recovery retains ${kind} without authorization or native effects`,t=>{
  const f=fixture(t);let call=f.call;
  const job={...f.job};
  if(kind==='true')job.native_launch_attempted=true;
  if(kind==='unknown')delete job.native_launch_attempted;
  if(kind==='worker')job.worker={agentName:'real-start'};
  if(kind==='process')job.launchProcess={pid:123,identity:'real-birth'};
  if(kind==='binding')job.sessionBinding={status:'pending'};
  if(kind==='watcher')job.watcher={pid:123};
  if(kind==='native-refusal')job.error='EPERM native refusal';
  if(kind==='preparation'){job.error='prepare failed: actual missing input';job.failure.code='PREPARATION_FAILED';}
  if(kind==='claim')job.ownership.generation++;
  if(kind==='record-binding')job.run='R-999';
  fs.writeFileSync(f.journal,JSON.stringify(job));f.authorize();
  if(kind==='report'){fs.mkdirSync(path.join(f.org,'runs/R-918'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-918/report.md'),'Incoming report');}
  if(kind==='verdict')f.add([{type:'change.reviewed',review_item:f.reviewId,item:f.reviewId,head:f.head,verdict:'PASS'}]);
  if(kind==='hold')f.add([{type:'item.updated',id:f.reviewId,fields:{meta:{hold:true}}}]);
  if(kind==='ancestor-hold')f.add([{type:'item.added',id:'G-99',kind:'goal',meta:{hold:true}},{type:'item.updated',id:f.reviewId,fields:{parent:'G-99'}}]);
  if(kind==='stop')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');
  if(kind==='peer')fs.writeFileSync(path.join(f.org,'dispatch/peer.json'),JSON.stringify({...job,token:'peer'}));
  if(kind==='native-present')call=(_exe,args)=>args[1]==='list'?JSON.stringify({result:{agents:[{name:'started',cwd:f.workspace}]}}):f.call(_exe,args);
  if(kind==='native-unknown')call=(_exe,args)=>args[1]==='list'?JSON.stringify({error:{code:'EACCES'}}):f.call(_exe,args);
  const before=f.context().events,bytes=fs.readFileSync(f.journal);assert.throws(()=>recoverUnstartedReview({...f.args(),call}));
  assert.equal(f.context().events.some(e=>e.type==='review.unstarted-authorized'),false);assert.deepEqual(f.context().events,before);assert.deepEqual(fs.readFileSync(f.journal),bytes);
});

test('never-started archive survives an ambiguous final boundary and resumes only its original intent',t=>{
  const f=fixture(t);let reads=0;const call=(exe,args)=>{if(args[1]==='list'&&++reads===3)throw Error('native refusal at final boundary');return f.call(exe,args);};
  assert.throws(()=>recoverUnstartedReview({...f.args(),call}),/native refusal/);const pending=f.context();assert.equal(pending.events.filter(e=>e.type==='review.unstarted-intent').length,1);assert.equal(pending.events.some(e=>e.type==='review.unstarted-authorized'),false);
  const file=path.join(f.org,'evidence/review-recovery/never-started-original/manifest.json'),bytes=fs.readFileSync(file);assert.throws(()=>recoverUnstartedReview({...f.args(),id:'another'}),/decision|intent/);
  assert.equal(recoverUnstartedReview(f.args()).result,'unstarted_review_ready');assert.deepEqual(fs.readFileSync(file),bytes);
});

test('never-started archive and claim changes stay held at normal dispatch consumption',t=>{
  for(const kind of ['journal','archive','claim','target']){
    const f=fixture(t);recoverUnstartedReview(f.args());
    if(kind==='journal')fs.appendFileSync(f.journal,' ');
    if(kind==='archive'){const grant=f.context().events.find(e=>e.type==='review.unstarted-authorized');fs.chmodSync(grant.archive.file,0o644);fs.appendFileSync(grant.archive.file,' ');}
    if(kind==='claim')f.add([{type:'run.claimed',run:'R-918',project:f.identity,record:f.org,owner:f.context().state.runs.get('R-918').owner}]);
    if(kind==='target')f.add([{type:'item.updated',id:f.reviewId,fields:{meta:{review_target:{...f.job.reviewQueue,head:f.base}}}}]);
    assert.throws(()=>validateQueuedReview(f.context()));assert.equal(f.context().events.some(e=>e.type==='review.unstarted-consumed'),false);
  }
});

test('never-started durable subject binding accepts CLI-derived display fields and holds a changed title',t=>{
  const f=fixture(t);recoverUnstartedReview(f.args());const c=f.context();
  assert.equal(validateQueuedReview({...c,item:{...c.item,status:'ready',computed_display:{owner:'display-only'}}}).head,f.head);
  f.add([{type:'item.updated',id:f.reviewId,fields:{title:'Changed durable intent'}}]);
  assert.throws(()=>validateQueuedReview(f.context()),/subject\/run version changed/);
});

test('never-started preparation recovery requires and archives an actual current source fix',t=>{
  const f=fixture(t),current=f.git(['log','-1','--format=%H','--','line-service/review-unstarted.mjs'],root),previous=f.git(['rev-parse',current+'^'],root),job={...f.job,sourceSelection:{root,head:previous},failure:{code:'PREPARATION_FAILED'},error:'prepare failed in original source'};
  fs.writeFileSync(f.journal,JSON.stringify(job));
  f.authorize({fix:{commit:current,file:'.nvmrc',why:'Claimed fix with unchanged input'}});
  assert.throws(()=>recoverUnstartedReview(f.args()),/did not change/);
  f.authorize({fix:{commit:current,file:'line-service/review-unstarted.mjs',why:'The actual changed recovery preparation implementation'}});
  assert.equal(recoverUnstartedReview(f.args()).result,'unstarted_review_ready');
  const grant=f.context().events.find(e=>e.type==='review.unstarted-authorized'),manifest=JSON.parse(fs.readFileSync(grant.archive.file)),fixed=manifest.files.find(e=>e.original===path.join(root,'line-service/review-unstarted.mjs'));
  assert.ok(fixed);assert.equal(hash(fs.readFileSync(fixed.archive)),hash(fs.readFileSync(fixed.original)));assert.equal(grant.fix.previous,previous);
});

for(const stale of [false,true])test(`request lock elects one owner from synchronized ${stale?'stale':'fresh'} contenders`,async t=>{
  const scratch=fs.mkdtempSync(path.join(tmpdir(),'request-lock-'));t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  const journal=path.join(scratch,'original.json'),ready=path.join(scratch,'ready'),outcomes=path.join(scratch,'outcomes'),dead=2147483647;
  fs.writeFileSync(journal,'original request bytes');fs.mkdirSync(ready);fs.mkdirSync(outcomes);
  if(stale){fs.writeFileSync(journal+'.lock',String(dead));fs.mkdirSync(journal+'.locks');fs.writeFileSync(path.join(journal+'.locks',`${dead}-stale`),'');}
  const source=`
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import {lockRequest} from ${JSON.stringify(new URL('../dispatch/request-lock.mjs',import.meta.url).href)};
    import {loadTimeout} from ${JSON.stringify(new URL('../lib/deadline.mjs',import.meta.url).href)};
    const [journal,ready,outcomes]=process.argv.slice(1),scan=fs.readdirSync.bind(fs);
    const wait=predicate=>{const until=Date.now()+loadTimeout(10000);while(!predicate()){assert.ok(Date.now()<until,'fixture barrier did not complete');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}};
    let first=true;
    fs.readdirSync=(directory,...options)=>{
      if(directory===journal+'.locks'&&first){first=false;fs.writeFileSync(ready+'/'+process.pid,'');wait(()=>scan(ready).length===2);}
      return scan(directory,...options);
    };
    let held,result;
    try{held=lockRequest(journal,{kill:(pid,signal)=>{if(pid===${dead})throw Object.assign(Error('absent fixture owner'),{code:'ESRCH'});return process.kill(pid,signal);}});result={acquired:true};}
    catch(e){result={acquired:false,error:e.message};}
    fs.writeFileSync(outcomes+'/'+process.pid,JSON.stringify(result));
    if(held){wait(()=>scan(outcomes).length===2);assert.equal(fs.readFileSync(held.lock,'utf8'),String(process.pid));held.release();}
    console.log(JSON.stringify(result));
  `;
  const children=Array.from({length:2},()=>spawnChild(t,process.execPath,['--input-type=module','-e',source,journal,ready,outcomes]));
  const replies=await Promise.all(children.map(waitForExit));for(const r of replies)assert.equal(r.status,0,r.stderr);
  const results=replies.map(r=>JSON.parse(r.stdout));assert.equal(results.filter(r=>r.acquired).length,1,JSON.stringify(results));
  assert.match(results.find(r=>!r.acquired).error,/already running/);assert.equal(fs.readFileSync(journal,'utf8'),'original request bytes');
  assert.equal(fs.existsSync(journal+'.lock'),false);assert.deepEqual(fs.readdirSync(journal+'.locks'),[]);
});

test('request lock retains live denied unknown and invalid owners and recovers only ESRCH',t=>{
  const scratch=fs.mkdtempSync(path.join(tmpdir(),'request-lock-'));t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  const journal=path.join(scratch,'original.json'),lock=journal+'.lock',directory=lock+'s';fs.writeFileSync(journal,'unchanged request');fs.mkdirSync(directory);
  for(const location of ['lock','contender'])for(const code of ['live','EPERM','EACCES','unknown','invalid']){
    const peer=location==='lock'?lock:path.join(directory,'1-retained'),bytes=code==='invalid'?'invalid':'1';fs.writeFileSync(peer,location==='lock'?bytes:'');
    const file=location==='contender'&&code==='invalid'?path.join(directory,'invalid-retained'):peer;if(file!==peer)fs.renameSync(peer,file);
    assert.throws(()=>lockRequest(journal,{kill:()=>{if(code!=='live')throw Object.assign(Error(code),{code});}}),/running|EPERM|EACCES|unknown|invalid/);
    assert.equal(fs.readFileSync(file,'utf8'),location==='lock'?bytes:'');fs.unlinkSync(file);assert.deepEqual(fs.readdirSync(directory),[]);
  }
  fs.writeFileSync(lock,'1');fs.writeFileSync(path.join(directory,'1-stale'),'');
  const held=lockRequest(journal,{kill:()=>{throw Object.assign(Error('absent'),{code:'ESRCH'});}});assert.equal(fs.readFileSync(lock,'utf8'),String(process.pid));held.release();
  assert.equal(fs.readFileSync(journal,'utf8'),'unchanged request');assert.deepEqual(fs.readdirSync(directory),[]);
});

test('request lock retains a live higher contender when its arbitration wait expires',t=>{
  const scratch=fs.mkdtempSync(path.join(tmpdir(),'request-lock-'));t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  const journal=path.join(scratch,'original.json'),directory=journal+'.locks',peer=path.join(directory,`${process.pid}9-retained`);
  fs.writeFileSync(journal,'original request');fs.mkdirSync(directory);fs.writeFileSync(peer,'retained contender');
  let time=0;const clock=t.mock.method(Date,'now',()=>time+=1e12);
  try{assert.throws(()=>lockRequest(journal,{kill:()=>{}}),/already running/);}finally{clock.mock.restore();}
  assert.equal(fs.readFileSync(peer,'utf8'),'retained contender');assert.deepEqual(fs.readdirSync(directory),[path.basename(peer)]);
  assert.equal(fs.existsSync(journal+'.lock'),false);assert.equal(fs.readFileSync(journal,'utf8'),'original request');
});

test('never-started public owner command serializes competing authorizations without replacing history',async t=>{
  const f=fixture(t),bin=path.join(f.ownerRoot,'bin');fs.mkdirSync(bin);const native=f.observation.agents[0];
  fs.writeFileSync(path.join(bin,'herdr'),`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]!=='agent'||!['get','list'].includes(a[1]))process.exit(9);console.log(JSON.stringify({result:a[1]==='list'?{agents:[${JSON.stringify(native)}]}:{agent:${JSON.stringify(native)}}}));\n`,{mode:0o755});
  const env={...f.env,PATH:bin+':'+f.env.PATH},args=[entry,'queue-review',f.reviewId,'--recover-unstarted','--role','supervisor','--resolution',f.resolution,'--decision-seq',String(f.args().decisionSeq),'--id',f.args().id];
  const start=async()=>{const child=spawnChild(t,process.execPath,args,{cwd:f.cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const done=await waitForExit(child);return{...done,stdout,stderr};};
  const replies=await Promise.all([start(),start()]);assert.ok(replies.some(r=>r.stdout.includes('unstarted_review_ready')),JSON.stringify(replies));
  const c=f.context();assert.equal(c.events.filter(e=>e.type==='review.unstarted-authorized').length,1);assert.equal(c.events.filter(e=>e.type==='review.unstarted-intent').length,1);assert.deepEqual(c.item.runs,['R-918']);assert.equal(c.events.some(e=>e.type==='review.unstarted-consumed'),false);
  for(const r of replies)if(!r.stdout.includes('unstarted_review_ready'))assert.match(r.stderr,/already running|lock/i);
});

test('never-started canonical authorization reaches the existing normal dispatcher once with exact HEAD as base',t=>{
  const f=fixture(t);recoverUnstartedReview(f.args());const d=dispatchFixture(t,{project:f,sourceEntry:true}),lane=path.join(d.root,'bin/lane');fs.writeFileSync(lane,fs.readFileSync(lane,'utf8').replaceAll('lane/topic','lane/review-replacement'));
  const options={env:{...d.env,HERDR_BRAIN_ROOT:root}},args=[f.reviewId,'--lane','review-replacement','--route','review-codex','--base',f.head,'--brief',d.brief];
  const wrong=d.dispatch(args.map(a=>a===f.head?f.base:a),options);assert.equal(wrong.status,1);assert.equal(f.context().events.some(e=>e.type==='review.unstarted-consumed'),false);
  const result=d.dispatch(args,options);assert.equal(result.status,0,result.stderr);assert.equal(promptCalls(d).length,1);
  const c=f.context();assert.equal(c.item.runs.length,2);assert.equal(c.item.runs[0],'R-918');assert.equal(c.events.filter(e=>e.type==='review.unstarted-consumed').length,1);assert.equal(c.events.filter(e=>e.type==='run.claimed'&&e.run==='R-918').length,1);
  const again=d.dispatch(args,options);assert.equal(again.status,1);assert.equal(promptCalls(d).length,1);
});
