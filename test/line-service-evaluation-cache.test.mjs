import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createLineService,sourceRoot,serviceDirectory} from '../line-service/line-service.mjs';
import {negativeEvaluationCache,sourceEvaluationInputs} from '../line-service/evaluation-cache.mjs';
import {evaluationCacheFile,readSchedulingJournal} from '../line-service/journal.mjs';
import {gitProject} from '../lib/project.mjs';
import {initOrg,transact,loadRecord} from '../lib/store.mjs';
import {dispatchSourceBinding,deliveredSourceProof} from '../lib/source-provenance.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'negative-evaluation-'))),repo=path.join(root,'project'),org=path.join(repo,'.org');
  fs.mkdirSync(repo);fs.writeFileSync(path.join(root,'.identity-root'),'fixture\n');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env={...process.env,ORG_DIR:org,MONITOR_SUPERVISOR_AGENT:'supervisor-test',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  for(const name of ['LANE_CONFIG','HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID'])delete env[name];
  const gitAt=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const git=(...args)=>gitAt(repo,...args);
  git('init','-qb','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'initial');git('add','.');git('commit','-qm','Initial');initOrg(org);
  const config=path.join(repo,'.lane.json');fs.writeFileSync(config,JSON.stringify({routes:{engineer:{kind:'codex'}},dispatch:{max_sessions:4}}));
  const identity=gitProject(repo).identity,directory=serviceDirectory(org,identity),boundary={id:'fixture',repo,org,project:identity,source:sourceRoot,main:'main',canonical_head:git('rev-parse','HEAD')};
  const append=add=>transact(org,()=>({add}));
  append(['line-service.cutover','line-service.phase0'].map(type=>({type,...boundary})));
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:new Date().toISOString(),repo,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const calls=[];
  const pass=(options={})=>{
    const before=fs.existsSync(path.join(directory,'passes.jsonl'))?fs.statSync(path.join(directory,'passes.jsonl')).size:0;
    createLineService({repo,org,env,to:'supervisor-test',haltAfter:100,capacity:()=>({count:0,cap:4}),recordNotice:d=>({id:d.id,state:'record-only'}),
      command:(_exe,args)=>{if(args[0].endsWith('/dispatch/dispatch.mjs'))calls.push(args[1]);return{status:0,stdout:'{}',stderr:''};},...options}).pass({reconcileCloseout:false});
    return fs.readFileSync(path.join(directory,'passes.jsonl')).subarray(before).toString().trim().split('\n').map(JSON.parse);
  };
  return{root,repo,org,env,identity,directory,append,config,calls,pass,git,gitAt};
}
const work=(id,extra={})=>({type:'item.added',id,role:'engineer',title:id,...extra});
const summary=rows=>rows.findLast(r=>r.action==='pass-complete');

test('pass residual partitions held admission and a yielded command with real writer contention',t=>{
  const f=fixture(t);f.append([work('ENG-1',{meta:{hold:true}}),work('ENG-2')]);
  const lock=path.join(f.directory,'pass.lock'),ready=path.join(f.root,'contender-ready'),dispatches=[];
  const rows=f.pass({command:(_exe,args)=>{
    assert.equal(fs.existsSync(lock),false,'commands run after the scheduling lock is yielded');
    if(args[0].endsWith('/dispatch/dispatch.mjs')){
      dispatches.push(args[1]);
      // A separate real writer releases normally while this pass waits to return.
      const script=`import fs from 'node:fs';import {noticeLock} from ${JSON.stringify(new URL('../supervisor/notice-lock.mjs',import.meta.url).href)};
        const unlock=noticeLock(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(ready)},'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);unlock();`;
      const child=spawn(process.execPath,['--input-type=module','-e',script],{env:f.env,stdio:'ignore'});
      t.after(()=>{if(child.exitCode===null)child.kill();});
      const setupDeadline=Date.now()+10000;
      while(!fs.existsSync(ready)&&Date.now()<setupDeadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
      assert.ok(fs.existsSync(ready),'fixture writer published its lock');
    }
    return{status:0,stdout:'{}',stderr:''};
  }});
  const pass=summary(rows),timing=pass.timing;
  const fields=['source_scan_ms','admission_scan_ms','canonical_index_ms','maintenance_review_ms',
    'lock_reacquire_wait_ms','journal_cache_checkpoint_ms','notice_audit_ms','unattributed_ms'];
  for(const field of fields)assert.ok(Number.isFinite(timing[field])&&timing[field]>=0,field);
  assert.ok(Math.abs(fields.reduce((n,k)=>n+timing[k],0)-timing.other_scan_and_guard_ms)<0.001);
  assert.ok(Math.abs(timing.other_scan_and_guard_ms+timing.effect_command_ms+timing.record_snapshot_ms-timing.duration_ms)<0.001);
  for(const field of fields.filter(k=>k!=='unattributed_ms'))assert.ok(timing[field]>0,field);
  assert.ok(timing.lock_reacquire_wait_ms>=50,'contention is timed separately from the command and admission');
  assert.deepEqual(dispatches,['ENG-2']);assert.equal(pass.starts,1);
  assert.ok(rows.some(r=>r.action==='hold'&&r.scope?.item==='ENG-1'));
  const effects=readSchedulingJournal(path.join(f.directory,'effects.json'));
  const launches=Object.entries(effects.actions).filter(([key])=>key.startsWith('dispatch:'));
  assert.equal(launches.length,1);assert.equal(launches[0][1].state,'complete');assert.equal(launches[0][1].commands.length,1);
  assert.equal(fs.existsSync(lock),false,'normal lock release remains intact');
  t.diagnostic(JSON.stringify({timing,dispatches,scope:'fixture commands; installed live witness unrun'}));
});

test('a service cache-write failure diagnoses the hold and preserves effect completion without replay',t=>{
  const f=fixture(t);f.append([work('ENG-1',{meta:{hold:true}}),work('ENG-2')]);
  const file=path.join(f.directory,'effects.json'),cache=evaluationCacheFile(file),foreign=path.join(f.root,'foreign-cache');
  fs.writeFileSync(foreign,'preserve original target');fs.symlinkSync(foreign,cache);
  const rows=f.pass(),pass=summary(rows);
  assert.ok(rows.some(r=>r.action==='evaluation-cache-write-held'&&/redirected/.test(r.reason)));
  assert.equal(pass.action,'pass-complete');assert.equal(pass.timing.evaluation_cache_writes,0);
  assert.equal(fs.readFileSync(foreign,'utf8'),'preserve original target');assert.ok(fs.lstatSync(cache).isSymbolicLink());
  const effects=JSON.parse(fs.readFileSync(file)),launch=Object.entries(effects.actions).find(([key])=>key.startsWith('dispatch:'));
  assert.equal(Object.hasOwn(effects,'negative_evaluations'),false);
  assert.equal(launch[1].state,'complete');assert.equal(launch[1].commands.length,1);
  const original=structuredClone(launch[1]);assert.deepEqual(f.calls,['ENG-2']);
  const next=f.pass();assert.ok(summary(next));
  assert.equal(summary(next).evaluations.admission_evaluated,2,'failed cache checkpoint evaluates fresh');
  assert.deepEqual(f.calls,['ENG-2'],'a cache failure cannot replay the completed effect');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[launch[0]],original);
  assert.equal(fs.existsSync(path.join(f.directory,'pass.lock')),false);
});

test('held observations checkpoint once per lock turn and warm passes write no unchanged cache',t=>{
  const f=fixture(t);f.append([work('ENG-1',{meta:{hold:true}}),work('ENG-2',{meta:{hold:true}})]);
  const first=summary(f.pass()),cache=evaluationCacheFile(path.join(f.directory,'effects.json')),inode=fs.statSync(cache).ino;
  assert.equal(first.timing.evaluation_cache_writes,1);
  assert.equal(first.timing.evaluation_cache_bytes,fs.statSync(cache).size);
  assert.ok(first.timing.effects_journal_bytes>0);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))),'negative_evaluations'),false);
  const warm=summary(f.pass());assert.equal(warm.evaluations.admission_skipped,2);
  assert.equal(warm.timing.evaluation_cache_writes,0);assert.equal(fs.statSync(cache).ino,inode);
  assert.ok(warm.resources.cpu_us.user>=0&&warm.resources.cpu_us.system>=0);assert.ok(warm.resources.rss_bytes>0);
  assert.ok(warm.timing.snapshot_materialize_ms>=0&&warm.timing.snapshot_identity_ms>=0);
  assert.equal(f.calls.length,0);
});

test('warm review admission holds remain visible without evaluation or launch and recover after policy release',t=>{
  const f=fixture(t),config=JSON.parse(fs.readFileSync(f.config));
  config.review_admission={enabled:true,producer_groups:[],canonical_commits:[],hold_ordinary:true};
  fs.writeFileSync(f.config,JSON.stringify(config));
  f.append([work('ENG-1'),{type:'item.added',id:'REV-1',role:'reviewer',title:'Legacy review'}]);
  const held=()=>JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).review_admission.held;
  const expected=[['ENG-1','ordinary','REVIEW_ADMISSION_ORDINARY_HELD'],['REV-1','unknown','REVIEW_ADMISSION_BINDING_UNKNOWN']];
  const projection=rows=>rows.map(({item,kind,code})=>[item,kind,code]).sort(([a],[b])=>a.localeCompare(b));
  const cold=f.pass(),original=held();
  assert.deepEqual(projection(original),expected);
  assert.deepEqual(projection(cold.filter(row=>row.action==='review-admission-held')),expected);
  assert.equal(summary(cold).evaluations.admission_evaluated,2);
  for(let n=0;n<2;n++){
    const warm=f.pass(),rows=held(),journal=warm.filter(row=>row.action==='review-admission-held');
    assert.equal(summary(warm).evaluations.admission_skipped,2);
    assert.equal(summary(warm).evaluations.admission_evaluated,0);
    assert.deepEqual(rows,original.map(row=>({...row,cached:true})));
    assert.deepEqual(projection(journal),expected);
    assert.ok(journal.every(row=>row.stage==='launch'&&row.cached===true));
    assert.equal(warm.some(row=>['hold','admission-eligible','effect-intent'].includes(row.action)&&['ENG-1','REV-1'].includes(row.item)),false);
    assert.deepEqual(f.calls,[]);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).actions).some(key=>key.startsWith('dispatch:')),false);
  }
  // A policy change must discard the negative and use fresh launch guards.
  config.review_admission.hold_ordinary=false;fs.writeFileSync(f.config,JSON.stringify(config));
  const released=f.pass();
  assert.equal(summary(released).evaluations.admission_evaluated,2);
  assert.equal(summary(released).evaluations.admission_skipped,0);
  assert.deepEqual(f.calls,['ENG-1']);
  assert.deepEqual(projection(held()),expected.slice(1));
  const warm=f.pass();
  assert.ok(warm.some(row=>row.action==='review-admission-held'&&row.item==='REV-1'&&row.cached===true));
  assert.equal(warm.some(row=>row.action==='review-admission-held'&&row.item==='ENG-1'),false);
  assert.deepEqual(f.calls,['ENG-1'],'a retained dispatch is not replayed by a later pass');
  t.diagnostic(JSON.stringify({cold:summary(cold).evaluations,released:summary(released).evaluations,warm_held:held(),dispatches:f.calls,native:'scripted; live acceptance unrun'}));
});

test('large held backlog skips unchanged evaluations across process instances and invalidates only dependent ancestry/links',t=>{
  const f=fixture(t),events=[];
  for(let n=1;n<=200;n++)events.push({type:'item.added',id:`G-${n}`,kind:'goal',title:'Parent',meta:{hold:true}},work(`ENG-${n}`,{parent:`G-${n}`}));
  events.push(work('ENG-201',{meta:{hold:true}}),{type:'link.added',blocker:'ENG-201',blocked:'ENG-1'});f.append(events);
  const first=f.pass(),second=f.pass();
  assert.equal(summary(first).evaluations.admission_evaluated,201);
  assert.equal(summary(second).evaluations.admission_evaluated,0);
  assert.equal(summary(second).evaluations.admission_skipped,201);
  t.diagnostic(JSON.stringify({warm_diagnostics:second.filter(r=>['hold','admission-eligible'].includes(r.action))}));
  assert.equal(second.filter(r=>['hold','admission-eligible'].includes(r.action)).length,0);
  assert.equal(f.calls.length,0);
  f.append([{type:'note.added',id:'G-2',text:'Ancestor input changed'}]);
  const parent=f.pass();assert.equal(summary(parent).evaluations.admission_evaluated,1);
  assert.deepEqual(parent.filter(r=>r.action==='admission-eligible').map(r=>r.item),['ENG-2']);
  f.append([{type:'item.updated',id:'ENG-201',fields:{title:'Changed linked prerequisite'}}]);
  assert.equal(summary(f.pass()).evaluations.admission_evaluated,2,'the prerequisite and its dependent re-evaluate');
  f.append([{type:'link.removed',blocker:'ENG-201',blocked:'ENG-1'}]);
  assert.equal(summary(f.pass()).evaluations.admission_evaluated,2,'both link endpoints changed');
  const config=JSON.parse(fs.readFileSync(f.config));config.ordinary_admission={selected_only:true,items:[]};fs.writeFileSync(f.config,JSON.stringify(config));
  assert.equal(summary(f.pass()).evaluations.admission_evaluated,201,'admission policy invalidates all affected candidates');
  const last=f.pass();assert.equal(summary(last).evaluations.admission_evaluated,0);assert.equal(last.filter(r=>r.action==='ordinary-admission-held').length,0);
  const retained=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).ordinary_admission;
  assert.deepEqual(retained.held,[],'unselected rows are excluded before per-item admission');
  assert.equal(retained.exclusions.count,201);
  assert.deepEqual(retained.exclusions.by_code,{ORDINARY_ADMISSION_NOT_SELECTED:201});
  t.diagnostic(JSON.stringify({first:summary(first),unchanged:summary(second),parent:summary(parent),policy_unchanged:summary(last)}));
});

test('deleted source trees retain one diagnosed hold, then cache it until own input changes',t=>{
  const f=fixture(t);f.append([work('ENG-1'),{type:'run.started',id:'R-1',item:'ENG-1',workspace:path.join(f.root,'deleted-tree')},
    {type:'report.ingested',run:'R-1',file:'runs/R-1/report.md',sha256:'fixture',report:{outcome:'done',artifacts:['Commit: '+ 'a'.repeat(40)]}}]);
  const first=f.pass(),second=f.pass();
  assert.ok(first.some(r=>r.action==='hold'&&r.boundary==='review-source:R-1:'));
  assert.equal(summary(second).evaluations.source_evaluated,0);assert.equal(summary(second).evaluations.source_skipped,1);
  const original=fs.readFileSync(path.join(f.directory,'effects.json'),'utf8');assert.match(original,/unknown delivered source/);
  fs.mkdirSync(path.join(f.root,'deleted-tree'));
  assert.equal(summary(f.pass()).evaluations.source_evaluated,1,'a formerly missing workspace is observed next pass');
  f.append([{type:'note.added',id:'R-1',text:'New source evidence'}]);assert.equal(summary(f.pass()).evaluations.source_evaluated,1);
});

test('another subject mentioning an ancestor in recurring diagnostics does not invalidate its subtree',t=>{
  const f=fixture(t);f.append([{type:'item.added',id:'G-1',kind:'goal',title:'Held goal',meta:{hold:true}},
    work('ENG-1',{parent:'G-1'}),work('ENG-2')]);
  f.pass();
  f.append([{type:'closeout.evaluated',item:'ENG-2',run:'R-2',resources:{author_packet:{report:{summary:'Follow G-1'}}}}]);
  const warm=f.pass();assert.equal(summary(warm).evaluations.admission_skipped,1);
  assert.equal(warm.some(r=>r.action==='admission-eligible'&&r.item==='ENG-1'),false);
  f.append([{type:'item.updated',id:'G-1',fields:{meta:{hold:false}}}]);
  const released=f.pass();assert.equal(summary(released).evaluations.admission_evaluated,2);
  assert.ok(f.calls.includes('ENG-1'),'an actual ancestor change still wakes its child');
});

test('own Git inputs and brief bytes invalidate negatives while an unrelated revision does not authorize a start',t=>{
  const f=fixture(t),lane=path.join(f.root,'lane'),brief=path.join(f.root,'ask.md');fs.mkdirSync(lane);fs.writeFileSync(path.join(lane,'source'),'one');fs.writeFileSync(brief,'first');
  fs.mkdirSync(path.join(lane,'.git'));fs.writeFileSync(path.join(lane,'.git/HEAD'),'first');
  f.append([work('ENG-1'),work('ENG-2'),{type:'run.started',id:'R-1',item:'ENG-1',workspace:lane,brief_path:brief}]);
  const document={actions:{}},counts={};let revision='first';
  const cache=()=>negativeEvaluationCache({store:()=>document,identity:f.identity,repo:f.repo,org:f.org,revision,counts});
  const evaluate=c=>{const s=loadRecord(f.org);return['ENG-1','ENG-2'].map(item=>c.probe('admission',{snapshot:s,item,policy:{}}));};
  evaluate(cache()).forEach(p=>p.retain('held'));assert.ok(evaluate(cache()).every(p=>p.skip));
  fs.writeFileSync(path.join(lane,'source'),'two');assert.ok(evaluate(cache()).every(p=>p.skip),'checkout bytes are not read by scheduling evaluations');
  fs.writeFileSync(path.join(lane,'.git/HEAD'),'second');let probes=evaluate(cache());assert.deepEqual(probes.map(p=>p.skip),[false,true]);probes[0].retain('held');
  fs.writeFileSync(brief,'second');probes=evaluate(cache());assert.deepEqual(probes.map(p=>p.skip),[false,true]);probes[0].retain('held');
  document.negative_evaluations.entries['admission:ENG-1'].negative=false;
  assert.equal(evaluate(cache())[0].skip,false,'a positive hint is never reused');
  evaluate(cache()).forEach(p=>{if(!p.skip)p.retain('held');});
  revision='unrelated landing';assert.ok(evaluate(cache()).every(p=>p.skip));
  document.negative_evaluations.entries=null;assert.ok(evaluate(cache()).every(p=>!p.skip));
});

test('real pass processes reuse admission and source negatives with linked skills and runtime output in a worker checkout',t=>{
  const f=fixture(t),lane=path.join(f.root,'lane'),skills=path.join(f.root,'shared-skills');
  fs.mkdirSync(path.join(lane,'.agents/skills'),{recursive:true});fs.mkdirSync(skills);
  fs.symlinkSync(skills,path.join(lane,'.agents/skills/project-deliver'),'dir');
  f.append([work('ENG-1'),{type:'run.started',id:'R-1',item:'ENG-1',workspace:lane},
    {type:'report.ingested',run:'R-1',file:'runs/R-1/report.md',sha256:'fixture',report:{outcome:'blocked',artifacts:['Commit: '+ 'a'.repeat(40)]}}]);
  const pass=()=>{
    const before=fs.existsSync(path.join(f.directory,'passes.jsonl'))?fs.statSync(path.join(f.directory,'passes.jsonl')).size:0;
    const script=`import {createLineService} from ${JSON.stringify(new URL('../line-service/line-service.mjs',import.meta.url).href)};
      createLineService({repo:${JSON.stringify(f.repo)},org:${JSON.stringify(f.org)},env:process.env,to:'supervisor-test',haltAfter:100,
      capacity:()=>({count:0,cap:4}),recordNotice:d=>({id:d.id,state:'record-only'}),command:()=>{throw Error('unexpected effect');}}).pass({reconcileCloseout:false});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.repo,env:f.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return fs.readFileSync(path.join(f.directory,'passes.jsonl')).subarray(before).toString().trim().split('\n').map(JSON.parse);
  };
  const first=pass();assert.equal(summary(first).evaluations.admission_evaluated,1);assert.equal(summary(first).evaluations.source_evaluated,1);
  fs.writeFileSync(path.join(lane,'runtime-output'),'unrelated');
  const warm=pass();assert.notEqual(summary(first).pid,summary(warm).pid);
  assert.equal(summary(warm).evaluations.admission_skipped,1);assert.equal(summary(warm).evaluations.source_skipped,1);
  t.diagnostic(JSON.stringify({warm_diagnostics:warm.filter(r=>['hold','admission-eligible'].includes(r.action))}));
  assert.equal(warm.filter(r=>['hold','admission-eligible'].includes(r.action)).length,0);
  f.append([{type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}}]);
  const changed=pass();assert.equal(summary(changed).evaluations.admission_evaluated,1);assert.equal(summary(changed).evaluations.source_evaluated,1);
  const recovered=pass();assert.equal(summary(recovered).evaluations.admission_skipped,1);assert.equal(summary(recovered).evaluations.source_skipped,1);
});

test('original-cache-Major: real same-revision processes skip covered source and held siblings despite an unrelated ancestor mention',t=>{
  const f=fixture(t),lane=path.join(f.root,'covered-worker'),skills=path.join(f.root,'shared-skills'),brief=path.join(f.root,'ask.md');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),base=f.git('rev-parse','HEAD');
  f.git('worktree','add','-qb','covered-worker',lane);
  fs.mkdirSync(path.join(lane,'.agents/skills'),{recursive:true});fs.mkdirSync(skills);
  fs.symlinkSync(skills,path.join(lane,'.agents/skills/project-deliver'),'dir');
  fs.writeFileSync(brief,'Original producer brief');fs.writeFileSync(path.join(lane,'source'),'Delivered source');
  f.gitAt(lane,'add','source');f.gitAt(lane,'commit','-qm','Covered producer');
  const head=f.gitAt(lane,'rev-parse','HEAD');f.git('merge','--ff-only',head);
  const dispatch=path.join(f.org,'dispatch/covered.json'),reportFile=path.join(f.org,'reports/R-1.md'),report='Immutable covered producer report\n';
  fs.mkdirSync(path.dirname(dispatch),{recursive:true});fs.mkdirSync(path.dirname(reportFile),{recursive:true});
  fs.writeFileSync(dispatch,JSON.stringify({token:'covered',stage:'complete',run:'R-1',item:'ENG-1',org:f.org,common:f.identity,workspace:lane,base}));
  fs.writeFileSync(reportFile,report);
  const worker={agent:'fixture-worker',pane:'fixture:p1',worker_workspace:'fixture',terminal_id:'fixture-terminal',agent_session_id:'fixture-session'};
  f.append([{type:'item.added',id:'G-1',kind:'goal',title:'Shared held ancestor',meta:{hold:true}},
    work('ENG-1',{parent:'G-1'}),work('ENG-2',{parent:'G-1'}),work('ENG-3',{parent:'G-1'}),
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:lane,brief_path:brief,meta:{...worker,dispatch_record:f.org,dispatch_project:f.identity,dispatch_journal:dispatch,dispatch_attempt:'covered'}},
    {type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:{controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}}},
    {type:'run.started',id:'R-3',item:'ENG-3',workspace:f.repo},{type:'item.closed',id:'ENG-3',as:'done'}]);
  const captured=loadRecord(f.org),run=captured.state.runs.get('R-1');
  f.append([{type:'change.landed',item:'ENG-1',run:'R-1',head,base,project:f.identity,landed_at:new Date().toISOString(),landing_tip:head,previous_main:base,
    source:{...dispatchSourceBinding({run,events:captured.events,identity:f.identity,org:f.org}),base,head},
    producer:{agent:worker.agent,pane:worker.pane,terminal:worker.terminal_id,session:worker.agent_session_id,ownership_generation:run.owner_generation}},
    {type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(report),report:{outcome:'done',artifacts:[`source: ${head}; base: ${base}`]}},
    {type:'item.added',id:'REV-1',role:'reviewer',title:'Original covered review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_round_cap:1,
      review_target:{head,base,reportHash:hash(report),evidence:reportFile,diff_sha256:hash(f.git('diff','--no-ext-diff','--no-textconv',base,head)),scope:{base,commits:[head],claims:[head],unresolved:[],deferred:false}}}},
    {type:'change.reviewed',item:'ENG-1',head,base,review_item:'REV-1',verdict:'PASS',findings:[]},{type:'item.closed',id:'REV-1',as:'done'},
    {type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);
  const delivered=loadRecord(f.org),proof=deliveredSourceProof({project:{identity:f.identity,canonical:f.repo},org:f.org,run:delivered.state.runs.get('R-1'),...delivered,git:(_repo,args)=>f.git(...args)});
  assert.equal(proof.status,'covered');assert.equal(proof.coverage,'guarded');
  const effects=path.join(f.root,'unexpected-effects'),entries=()=>readSchedulingJournal(path.join(f.directory,'effects.json')).negative_evaluations.entries;
  const pass=()=>{
    const journal=path.join(f.directory,'passes.jsonl'),before=fs.existsSync(journal)?fs.statSync(journal).size:0;
    const script=`import fs from 'node:fs';import {createLineService} from ${JSON.stringify(new URL('../line-service/line-service.mjs',import.meta.url).href)};
      createLineService({repo:${JSON.stringify(f.repo)},org:${JSON.stringify(f.org)},env:process.env,to:'supervisor-test',haltAfter:100,
        capacity:()=>({count:0,cap:4}),recordNotice:d=>({id:d.id,state:'record-only'}),command:()=>{fs.appendFileSync(${JSON.stringify(effects)},'effect\\n');throw Error('unexpected effect');}}).pass({reconcileCloseout:false});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.repo,env:f.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const rows=fs.readFileSync(journal).subarray(before).toString().trim().split('\n').map(JSON.parse);
    assert.ok(summary(rows));assert.equal(summary(rows).starts,0);assert.equal(fs.existsSync(effects),false,'no cached observation may authorize an effect');
    assert.equal(rows.some(r=>r.action==='effect-intent'),false);return rows;
  };
  const first=pass();assert.equal(entries()['source:R-1'].reason,'no pending source');
  f.append([{type:'report.ingested',run:'R-3',item:'ENG-3',file:'reports/R-3.md',sha256:'unrelated-report',report:{outcome:'blocked',summary:'Unrelated report names shared G-1',artifacts:[]}}]);
  const warm=pass(),start=rows=>rows.find(r=>r.action==='pass-start');
  t.diagnostic(JSON.stringify({first:summary(first),warm:summary(warm),warm_rows:warm}));
  assert.notEqual(summary(first).pid,summary(warm).pid);assert.equal(start(first).source_head,start(warm).source_head);
  assert.ok(summary(warm).evaluations.admission_skipped>=1);assert.ok(summary(warm).evaluations.source_skipped>=1);
  assert.equal(summary(warm).evaluations.source_evaluated,0);assert.equal(summary(warm).evaluations.admission_evaluated,0);
  assert.equal(warm.some(r=>['hold','admission-eligible'].includes(r.action)),false);
  f.append([{type:'item.updated',id:'ENG-2',fields:{meta:{hold:true}}}]);
  const changed=pass();assert.equal(summary(changed).evaluations.source_skipped,1);assert.equal(summary(changed).evaluations.admission_evaluated,1);
  const recovered=pass();assert.equal(summary(recovered).evaluations.source_skipped,1);
  assert.equal(summary(recovered).evaluations.admission_skipped,1);
  fs.writeFileSync(brief,'Changed producer brief');
  const sourceChanged=pass();assert.equal(summary(sourceChanged).evaluations.source_evaluated,1);
  assert.equal(summary(sourceChanged).evaluations.admission_skipped,1,'the unchanged held sibling stays warm');
  const sourceRecovered=pass();assert.equal(summary(sourceRecovered).evaluations.source_skipped,1);
  t.diagnostic(JSON.stringify({changed:summary(changed),recovered:summary(recovered),source_changed:summary(sourceChanged),source_recovered:summary(sourceRecovered),source_proof:proof}));
});

test('source negatives stay warm across consecutive passes with routine writes and unchanged Git config replacements',t=>{
  const f=fixture(t),workers=[];
  for(let n=1;n<=3;n++){
    const lane=path.join(f.root,`source-worker-${n}`);f.git('worktree','add','-qb',`source-worker-${n}`,lane);workers.push(lane);
    f.append([work(`ENG-${n}`,{meta:{hold:true}}),{type:'run.started',id:`R-${n}`,item:`ENG-${n}`,workspace:lane},
      {type:'report.ingested',run:`R-${n}`,file:`runs/R-${n}/report.md`,sha256:'fixture',report:{outcome:'blocked',artifacts:['Commit: '+'a'.repeat(40)]}}]);
  }
  const pass=()=>{
    const before=fs.existsSync(path.join(f.directory,'passes.jsonl'))?fs.statSync(path.join(f.directory,'passes.jsonl')).size:0;
    const script=`import {createLineService} from ${JSON.stringify(new URL('../line-service/line-service.mjs',import.meta.url).href)};
      createLineService({repo:${JSON.stringify(f.repo)},org:${JSON.stringify(f.org)},env:process.env,to:'supervisor-test',haltAfter:100,
      capacity:()=>({count:0,cap:4}),command:()=>{throw Error('unexpected effect');}}).pass({reconcileCloseout:false});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.repo,env:f.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return fs.readFileSync(path.join(f.directory,'passes.jsonl')).subarray(before).toString().trim().split('\n').map(JSON.parse);
  };
  const cacheFile=evaluationCacheFile(path.join(f.directory,'effects.json')),entries=()=>JSON.parse(fs.readFileSync(cacheFile)).entries;
  const first=pass(),retained=Object.keys(entries()).filter(k=>k.startsWith('source:')).length;
  assert.equal(retained,3);assert.equal(summary(first).evaluations.source_evaluated,retained);
  for(const entry of Object.values(entries())){
    assert.match(entry.components.implementation,/^[a-f0-9]{64}$/);
    assert.ok(Object.keys(entry.components).some(k=>k.startsWith('physical:')));
  }
  const config=path.join(f.identity,'config'),bytes=fs.readFileSync(config),replace=()=>{
    const before=fs.statSync(config).ino;fs.writeFileSync(config+'.routine-replacement',bytes);fs.renameSync(config+'.routine-replacement',config);
    assert.notEqual(fs.statSync(config).ino,before);
  };
  // effects.json and passes.jsonl are rewritten/appended by each real process.
  // Also exercise the already delivered content-based Git config input: its
  // metadata replacement between early source and late admission is harmless.
  replace();const second=pass();assert.notEqual(summary(first).pid,summary(second).pid);
  assert.equal(summary(second).evaluations.source_skipped,retained);assert.equal(summary(second).evaluations.source_changed??0,0);
  assert.equal(summary(second).evaluations.admission_skipped,3);
  // A matching legacy entry upgrades its evidence without losing a warm hit.
  const saved=JSON.parse(fs.readFileSync(cacheFile));delete saved.entries['source:R-1'].components;fs.writeFileSync(cacheFile,JSON.stringify(saved));
  replace();const upgraded=pass();assert.equal(summary(upgraded).evaluations.source_skipped,retained);assert.ok(entries()['source:R-1'].components);
  fs.writeFileSync(path.join(workers[0],'source'),'genuinely changed source');f.gitAt(workers[0],'add','source');f.gitAt(workers[0],'commit','-qm','Changed source input');
  const changed=pass(),misses=changed.filter(r=>r.action==='evaluation-cache-miss'&&r.miss==='changed'),sourceMiss=misses.find(r=>r.stage==='source');
  assert.equal(summary(changed).evaluations.source_changed,1);assert.equal(summary(changed).evaluations.source_skipped,retained-1);
  assert.equal(sourceMiss.run,'R-1');assert.match(sourceMiss.component,/^physical:head:/);assert.notEqual(sourceMiss.previous,sourceMiss.current);
  for(const [stage,count]of Object.entries(summary(changed).evaluations).filter(([k])=>k.endsWith('_changed')))
    assert.equal(misses.filter(r=>r.stage===stage.slice(0,-'_changed'.length)).length,count,'every changed miss has component evidence');
  const recovered=pass();assert.equal(summary(recovered).evaluations.source_skipped,retained);assert.equal(summary(recovered).evaluations.source_changed??0,0);
  t.diagnostic(JSON.stringify({first:summary(first),second:summary(second),changed:summary(changed).evaluations,misses}));
});

test('a different source revision cannot erase other subjects while relevant unknown Git inventories remain fresh',t=>{
  const f=fixture(t),document={actions:{}},counts={};f.append([work('ENG-1'),work('ENG-2')]);
  const snapshot=loadRecord(f.org),cache=revision=>negativeEvaluationCache({store:()=>document,identity:f.identity,repo:f.repo,org:f.org,revision,counts});
  const subject=item=>({snapshot,item,policy:{}}),a=cache('first'),b=cache('second');
  a.probe('admission',subject('ENG-1')).retain('held');
  b.probe('admission',subject('ENG-2')).retain('held');
  assert.equal(a.probe('admission',subject('ENG-1')).skip,true,'a resumed older pass retains unrelated negatives');
  assert.equal(b.probe('admission',subject('ENG-1')).skip,true,'an unrelated repository revision is not changed evaluator code');
  assert.equal(b.probe('admission',subject('ENG-2')).skip,true);
  const lane=path.join(f.root,'lane');fs.mkdirSync(path.join(lane,'.git'),{recursive:true});
  fs.symlinkSync(f.identity,path.join(lane,'.git/refs'),'dir');
  f.append([{type:'run.started',id:'R-1',item:'ENG-1',workspace:lane}]);
  const unknown=()=>b.probe('source',{snapshot:loadRecord(f.org),item:'ENG-1',run:'R-1',policy:{}});
  unknown().retain('held');assert.equal(unknown().skip,false,'a relevant linked Git inventory is never truncated or reused');
  assert.equal(counts.source_uncacheable,2);
});

test('fresh launch boundary refuses a hold introduced after cached negative invalidation and capacity observation',t=>{
  const f=fixture(t);f.append([work('ENG-1',{meta:{hold:true}})]);f.pass();
  f.append([{type:'item.updated',id:'ENG-1',fields:{meta:{hold:false}}}]);
  const rows=f.pass({capacity:()=>{f.append([{type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}}]);return{count:0,cap:4};}});
  assert.equal(f.calls.length,0);assert.ok(rows.some(r=>r.action==='hold'&&/dispatch readiness/.test(r.reason)));
  assert.equal(summary(rows).evaluations.admission_evaluated,1);
  f.append([work('ENG-2')]);
  const next=f.pass();assert.deepEqual(f.calls,['ENG-2']);
  assert.ok(next.some(r=>r.action==='admission-decision'));assert.ok(next.some(r=>r.action==='effect-intent'));
  fs.writeFileSync(path.join(f.directory,'STOP'),'stop');f.append([work('ENG-3')]);
  assert.ok(f.pass().some(r=>r.action==='pass-held'&&/STOP/.test(r.reason)));assert.deepEqual(f.calls,['ENG-2']);
});

test('unrelated main landings and ref packing preserve negatives; an own branch commit wakes both stages',t=>{
  const f=fixture(t),lane=path.join(f.root,'worker');f.git('worktree','add','-qb','worker',lane);
  f.append([work('ENG-1'),work('ENG-2'),{type:'run.started',id:'R-1',item:'ENG-1',workspace:lane}]);
  const document={},counts={},probe=(stage,item)=>negativeEvaluationCache({store:()=>document,identity:f.identity,repo:f.repo,org:f.org,counts})
    .probe(stage,{snapshot:loadRecord(f.org),item,...(item==='ENG-1'?{run:'R-1'}:{}),policy:{}});
  for(const stage of ['source','admission'])for(const item of ['ENG-1','ENG-2'])probe(stage,item).retain('held');
  fs.writeFileSync(path.join(f.repo,'unrelated'),'another subject');f.git('add','unrelated');f.git('commit','-qm','Unrelated landing');
  f.git('pack-refs','--all','--prune');
  for(const stage of ['source','admission'])for(const item of ['ENG-1','ENG-2'])assert.equal(probe(stage,item).skip,true,`${stage}:${item}`);
  fs.writeFileSync(path.join(lane,'source'),'worker change');f.gitAt(lane,'add','source');f.gitAt(lane,'commit','-qm','Own input');
  for(const stage of ['source','admission']){
    assert.equal(probe(stage,'ENG-1').skip,false,`${stage} observes the packed branch advancing`);
    assert.equal(probe(stage,'ENG-2').skip,true,`${stage} keeps the unrelated subject cached`);
  }
  assert.equal(f.calls.length,0,'negative observations grant no start authority');
});

test('a foreign linked Git common directory remains uncacheable instead of hiding uninventoried configuration',t=>{
  const f=fixture(t),lane=path.join(f.root,'foreign-worker'),common=path.join(f.root,'foreign.git'),dir=path.join(common,'worktrees/worker');
  fs.mkdirSync(lane);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(lane,'.git'),`gitdir: ${dir}\n`);
  fs.writeFileSync(path.join(dir,'commondir'),'../..\n');fs.writeFileSync(path.join(dir,'HEAD'),'ref: refs/heads/worker\n');
  f.append([work('ENG-1'),{type:'run.started',id:'R-1',item:'ENG-1',workspace:lane}]);
  const document={},counts={},cache=negativeEvaluationCache({store:()=>document,identity:f.identity,repo:f.repo,org:f.org,counts}),
    probe=()=>cache.probe('source',{snapshot:loadRecord(f.org),item:'ENG-1',run:'R-1',policy:{}});
  probe().retain('foreign source retained');assert.equal(probe().skip,false);assert.equal(counts.source_uncacheable,2);
});

test('shared Git config replacement preserves warm passes while changed bytes, redirects and missing inputs invalidate',t=>{
  const f=fixture(t),lane=path.join(f.root,'worker');f.git('worktree','add','-qb','worker',lane);
  f.append([work('ENG-1',{meta:{hold:true}}),{type:'run.started',id:'R-1',item:'ENG-1',workspace:lane},
    {type:'report.ingested',run:'R-1',file:'runs/R-1/report.md',sha256:'fixture',report:{outcome:'blocked',artifacts:['Commit: '+'a'.repeat(40)]}}]);
  const cold=summary(f.pass()).evaluations,warm=()=>{
    const result=summary(f.pass()).evaluations;
    assert.equal(result.admission_skipped,1);assert.equal(result.source_skipped,1);return result;
  },fresh=()=>{
    const result=summary(f.pass()).evaluations;
    assert.equal(result.admission_evaluated,1);assert.equal(result.source_evaluated,1);return result;
  };
  assert.equal(cold.admission_evaluated,1);assert.equal(cold.source_evaluated,1);warm();
  const config=path.join(f.identity,'config'),bytes=fs.readFileSync(config),mode=fs.statSync(config).mode;
  const replace=(file,content)=>{fs.writeFileSync(file+'.replacement',content,{mode});fs.renameSync(file+'.replacement',file);};
  const allocatedBefore=fs.statSync(config).ino;
  f.git('worktree','add','-qb','other-worker',path.join(f.root,'other-worker'));
  assert.deepEqual(fs.readFileSync(config),bytes);warm();
  const allocationReplacedConfig=fs.statSync(config).ino!==allocatedBefore;
  const before=fs.statSync(config).ino;replace(config,bytes);assert.notEqual(fs.statSync(config).ino,before);
  const replaced=warm();
  f.git('config','core.filemode','false');fresh();warm();
  const worktreeConfig=path.join(f.identity,'config.worktree');
  fs.writeFileSync(worktreeConfig,'[core]\n\tfilemode = false\n');fresh();warm();
  replace(worktreeConfig,fs.readFileSync(worktreeConfig));warm();
  const target=config+'.target';fs.renameSync(config,target);fs.symlinkSync(target,config);fresh();warm();
  fs.unlinkSync(config);fs.renameSync(target,config);fresh();warm();
  fs.unlinkSync(worktreeConfig);fresh();warm();
  fs.mkdirSync(worktreeConfig);
  const unknown=fresh();assert.equal(unknown.admission_uncacheable,1);assert.equal(unknown.source_uncacheable,1);
  fresh();fs.rmdirSync(worktreeConfig);fresh();warm();
  assert.equal(f.calls.length,0,'negative reuse grants no launch authority');
  t.diagnostic(JSON.stringify({cold,allocationReplacedConfig,replaced,unknown}));
});

test('canonical source projection changes for own membership and competing attribution, not another landing',t=>{
  const base='a'.repeat(40),own='b'.repeat(40),other='c'.repeat(40),later='d'.repeat(40);
  const row=(head,item,run)=>({head,item,run,attribution:'report-claim'}),run={id:'R-1',report:{artifacts:[`source: ${own}; base: ${base}`]}},item={id:'ENG-1'};
  const index={heads:[own],graphRows:[`${own} ${base}`],entries:[row(own,item.id,run.id)]};
  const original=sourceEvaluationInputs(index,item,run);
  const unrelated={heads:[later,other,own],graphRows:[`${later} ${other}`,`${other} ${own}`,...index.graphRows],entries:[row(later,'ENG-3','R-3'),row(other,'ENG-2','R-2'),...index.entries]};
  assert.deepEqual(sourceEvaluationInputs(unrelated,item,run),original);
  const ambiguous={...unrelated,entries:unrelated.entries.map(r=>r.head===own?{...r,item:null,run:null,attribution:'ambiguous'}:r)};
  assert.notDeepEqual(sourceEvaluationInputs(ambiguous,item,run),original,'a peer claiming this producer head is relevant');
  assert.notDeepEqual(sourceEvaluationInputs({...index,heads:[],graphRows:[],entries:[]},item,run),original,'losing actual canonical membership invalidates');
  const shortRun={...run,report:{artifacts:[`Commit: ${own.slice(0,7)}`]}},collision=own.slice(0,7)+'e'.repeat(33);
  assert.notDeepEqual(sourceEvaluationInputs({...index,heads:[own,collision]},item,shortRun),sourceEvaluationInputs(index,item,shortRun),'a new ambiguous abbreviated claim invalidates');
});

test('real passes skip source and admission across unrelated concurrent landings, then recover a lost or damaged cache once',t=>{
  const f=fixture(t),lane=path.join(f.root,'worker');f.git('worktree','add','-qb','worker',lane);
  fs.writeFileSync(path.join(lane,'source'),'delivered');f.gitAt(lane,'add','source');f.gitAt(lane,'commit','-qm','Producer source');
  const head=f.gitAt(lane,'rev-parse','HEAD');f.git('merge','--ff-only','worker');
  f.append([work('ENG-1',{meta:{hold:true}}),{type:'run.started',id:'R-1',item:'ENG-1',workspace:lane},
    {type:'report.ingested',run:'R-1',file:'runs/R-1/report.md',sha256:'fixture',report:{outcome:'blocked',artifacts:[`Commit: ${head}`]}}]);
  const first=f.pass();assert.equal(summary(first).evaluations.source_evaluated,1);assert.equal(summary(first).evaluations.admission_evaluated,1);
  fs.writeFileSync(path.join(f.repo,'unrelated'),'landing one');f.git('add','unrelated');f.git('commit','-qm','Other producer');
  f.append([work('ENG-2'),{type:'item.closed',id:'ENG-2',as:'done'},{type:'note.added',id:'ENG-2',text:'Unrelated report names ENG-1 and R-1'}]);
  const warm=f.pass();assert.equal(summary(warm).evaluations.source_skipped,1);assert.equal(summary(warm).evaluations.admission_skipped,1);
  assert.equal(warm.some(r=>r.action==='hold'&&r.boundary?.startsWith('review-source:R-1:')),false);
  const file=evaluationCacheFile(path.join(f.directory,'effects.json')),damage=value=>{if(value===undefined)fs.unlinkSync(file);else fs.writeFileSync(file,JSON.stringify(value));};
  for(const value of [undefined,{schema:'damaged',entries:null}]){
    damage(value);const recovery=f.pass();
    assert.equal(summary(recovery).evaluations.source_evaluated,1);assert.equal(summary(recovery).evaluations.admission_evaluated,1);
    const recovered=f.pass();assert.equal(summary(recovered).evaluations.source_skipped,1);assert.equal(summary(recovered).evaluations.admission_skipped,1);
  }
  f.append([{type:'note.added',id:'R-1',text:'New report evidence'}]);
  const changed=f.pass();assert.equal(summary(changed).evaluations.source_evaluated,1);assert.equal(summary(changed).evaluations.admission_evaluated,1);
  assert.equal(f.calls.length,0);
  t.diagnostic(JSON.stringify({first:summary(first).evaluations,unrelated_landing:summary(warm).evaluations,own_report:summary(changed).evaluations}));
});

test('an unchanged subject with a pending consumer obligation is rechecked without replay or launch authority',t=>{
  const f=fixture(t);f.append([work('ENG-1'),work('ENG-2'),{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.repo},
    {type:'change.landed',project:f.identity,item:'ENG-1',run:'R-1',head:'b'.repeat(40),base:'a'.repeat(40)},
    {type:'dispatch.waiting',project:f.identity,item:'ENG-2',pending:true}]);
  const document={},counts={},cache=()=>negativeEvaluationCache({store:()=>document,identity:f.identity,repo:f.repo,org:f.org,counts}),
    source=()=>cache().probe('source',{snapshot:loadRecord(f.org),item:'ENG-1',run:'R-1',policy:{}}),
    admission=()=>cache().probe('admission',{snapshot:loadRecord(f.org),item:'ENG-2',policy:{}});
  source().retain('held');admission().retain('held');
  assert.equal(source().skip,false);assert.equal(admission().skip,false);
  assert.equal(counts.source_obligation,2);assert.equal(counts.admission_obligation,2);
  assert.equal(f.calls.length,0);assert.equal(Object.keys(document.actions??{}).length,0);
});

test('a dependency completion wakes its held dependent and admits it once with free capacity',t=>{
  const f=fixture(t);f.append([work('ENG-1',{meta:{queue_selected:true}}),work('ENG-2'),{type:'link.added',blocker:'ENG-2',blocked:'ENG-1'}]);
  f.pass();f.calls.length=0;
  assert.equal(summary(f.pass()).evaluations.admission_skipped,1,'dependent remains negative while its blocker is unfinished');
  f.append([{type:'item.closed',id:'ENG-2',as:'done'}]);
  const changed=f.pass();assert.ok(changed.some(row=>row.action==='admission-eligible'&&row.item==='ENG-1'));
  assert.deepEqual(f.calls,['ENG-1']);
});
