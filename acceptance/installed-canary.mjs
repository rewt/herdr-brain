// Extension of the installed-cycle scenario. The controller and all product
// children run inside its kernel-denied scratch world. Native/model responses,
// launchctl and account/open-file observations are explicitly scripted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {expiredCloseoutControl} from './installed-closeout-control.mjs';
import {processControlPid, setProcessControl} from './installed-observations.mjs';

export function processContinuityControl({ownerAlive, lookupProcess, observe = () => {}}) {
  const original = {pid:processControlPid,ppid:0,pgid:processControlPid,identity:`0:${processControlPid}`,
    command:'[canary-process-control]',state:'S'};
  const check = phase => observe(phase, original);
  try {
    setProcessControl(original);
    assert.equal(ownerAlive(original), true);check('original');
    setProcessControl({...original,identity:'0:1'});
    assert.equal(ownerAlive(original), false, 'a reused PID is not the original launch');check('reused');
    setProcessControl(null);
    assert.equal(ownerAlive(original), false, 'an absent process is not continuity');check('absent');
    setProcessControl({...original,identity:'malformed'});
    assert.equal(lookupProcess(original.pid, {identityOnly:true}).ok, false, 'invalid births must not become evidence');check('malformed');
    setProcessControl(original);
    assert.equal(ownerAlive(original), true);check('recovered');
    return {scratch:original,pidReuseRefused:true,absentProcessRefused:true,malformedIdentityRefused:true,originalRestored:true};
  } finally {
    setProcessControl(null);
  }
}

export async function runCanary(c) {
  const {config,write,stage,module,env,run,checked,git,record,state,journals,service,audit,project,directory,
    producer,item,successorItem,base,until,idle,report,controls,controlOptions,ownerAlive}=c;
  const {root,repo,org,home,bundle,commit}=config;
  const failures=[];
  const {loadRecord,transact}=await module('lib/store.mjs');
  const events=()=>loadRecord(org).events;
  const nativeFile=path.join(root,'native.json');
  const native=()=>JSON.parse(fs.readFileSync(nativeFile));
  const changeNative=fn=>{const n=native();fn(n);n.seq=(n.seq??1)+1;fs.writeFileSync(nativeFile,JSON.stringify(n));};
  const calls=()=>fs.readFileSync(path.join(root,'native-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const prompts=job=>calls().filter(a=>a[0]==='agent'&&a[1]==='prompt'&&a[2]===job.worker.agentName&&a[3]!=='/exit');
  const workerEnv=job=>({...env,HERDR_ENV:'1',HERDR_PANE_ID:job.worker.pane,HERDR_WORKSPACE_ID:job.worker.workspaceId,
    HERDR_TAB_ID:job.worker.tabId,CODEX_THREAD_ID:job.worker.agentSessionId,ORG_ACTOR:job.worker.agentName});
  const promote=job=>checked(process.execPath,[path.join(job.release.root,'lanes/lane.mjs'),'promote',job.lane,'--expected-head-from-worktree'],
    {cwd:job.worker.cwd,env:workerEnv(job)});
  const available=job=>state().runs.get(job.run).report||events().some(e=>e.type==='report.available'&&e.run===job.run);
  const finished=job=>state().runs.get(job.run).report&&state().items.get(job.item).closed;
  const land=(job,file)=>{
    const before=git(['rev-parse','HEAD'],job.worker.cwd);
    fs.writeFileSync(path.join(job.worker.cwd,file),'Installed ordinary work\n');
    git(['add',file],job.worker.cwd);git(['commit','-qm','Scripted ordinary installed work'],job.worker.cwd);
    const head=git(['rev-parse','HEAD'],job.worker.cwd);promote(job);assert.equal(git(['rev-parse','main']),head);
    return {base:before,head};
  };
  const complete=async(job,artifacts,extra='')=>{
    const at=new Date().toISOString(),start=performance.now();report(job,artifacts,extra);
    await until(()=>available(job),'actual watcher report notice');
    const availability=performance.now()-start;
    service(0).pass();
    await until(()=>finished(job)&&!fs.existsSync(job.worker.cwd)&&!native().workspaces[job.worker.workspaceId],
      'same-turn source, session, native workspace and folder closeout');
    const after=events(),ingested=after.filter(e=>e.type==='report.ingested'&&e.run===job.run);
    assert.equal(ingested.length,1);assert.equal(native().workspaces[job.worker.workspaceId],undefined);
    assert.equal(git(['branch','--list','lane/'+job.lane]),'');
    const receipts=after.filter(e=>e.run===job.run&&e.type.startsWith('closeout.'));
    assert.ok(receipts.some(e=>e.type==='closeout.effect'&&e.outcome?.action==='worktree-removed'),JSON.stringify(receipts));
    const result={run:job.run,item:job.item,report_at:at,watcher_notice_ms:availability,total_ms:performance.now()-start,
      ingested:ingested[0].seq,receipts,folderRemoved:true,nativeReleased:true,branchDeletedAfterAncestry:true};
    write(job.run+'-completion.json',result);return result;
  };
  if(config.sharedOnly){
    await sharedCase();
    await until(()=>!fs.existsSync(path.join(directory,'closeout-turn.lock')),'shared finite closeout teardown');
    write('outcome.json',{schema:'brain.installed-shared-control/v1',scope:['shared-observer'],status:'PASS',candidate:config.candidate,
      fixtureOnly:true,ready:false,wholeCanary:'UNRUN',originalLifecycleEvidence:'reuse separately retained original packet; never infer whole-canary PASS'});
    return;
  }

  // The unchanged installed writer must commit the original launch binding
  // before the first input. Fault a separate controller-local scratch PID at
  // the declared seam; the live producer's native/process rows stay untouched.
  const launch = producer.launchProcess, binding = events().find(e => e.type === 'run.session_bound' && e.run === producer.run);
  assert.equal(producer.sessionBinding.status, 'bound');
  assert.deepEqual(binding.process, launch);assert.equal(binding.session, producer.worker.agentSessionId);
  const input = fs.readFileSync(path.join(root, 'evidence/native-input.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.agent === producer.worker.agentName);
  assert.equal(input.length, 1);assert.equal(input[0].binding.seq, binding.seq);
  assert.equal(input[0].process.pid, launch.pid);assert.equal(input[0].process.identity, launch.identity);
  const {lookupProcess} = await module('lib/processes.mjs');
  const originalProcess = native().workspaces[producer.worker.workspaceId].agentProcess;
  assert.notEqual(launch.pid, processControlPid);
  assert.equal(ownerAlive(launch), true);
  const processControl = processContinuityControl({ownerAlive,lookupProcess,
    observe:()=>assert.equal(ownerAlive(launch), true, 'producer continuity survives each scratch fault')});
  assert.deepEqual(native().workspaces[producer.worker.workspaceId].agentProcess, originalProcess);
  assert.equal(ownerAlive(launch), true);
  stage('launch-process-control', {launch,bindingSeq:binding.seq,input:input[0],...processControl,
    producerUnaffected:true,prompts:prompts(producer).length});

  // Complete ordinary A without injecting faults into its original watcher.
  // STOP intentionally ends a per-run watcher, so promotion boundary controls
  // use their own later allocation rather than destroying S1/S7's observation.
  const lane=producer.worker.cwd;
  fs.writeFileSync(path.join(lane,'answer.txt'),'Installed consumer change\n');
  git(['add','answer.txt'],lane);git(['commit','-qm','Scripted installed canary change'],lane);
  const head=git(['rev-parse','HEAD'],lane);
  promote(producer);assert.equal(git(['rev-parse','main']),head);
  stage('land',{base,head,originalAttempt:producer.token});

  // S7: exactly the existing immutable-root maintenance seam, while the
  // producer and its original callback remain captured and live.
  if (!config.skipPassedCases.includes('S7')) {
    const captured=()=>Object.fromEntries(journals().map(j=>[j.file,createHash('sha256').update(fs.readFileSync(j.file)).digest('hex')]));
    const saved=captured(),installation=fs.readFileSync(path.join(directory,'installation.json'),'utf8'),plist=fs.readFileSync(path.join(directory,'service.plist'),'utf8');
    assert.equal(ownerAlive(producer.watcher),true);
    const {main:nextControls}=await import(new URL('../line-service/launchd.mjs',`file://${config.successor}/harness/`).href);
    controls(['stop','--repo',repo,'--org',org],controlOptions);
    checked(process.execPath,[path.join(bundle,'herdr/releases.mjs'),'pin',home,repo,'successor']);
    git(['add','.herdr-release.json']);git(['commit','-qm','Select identical scratch successor']);
    const forward=['upgrade','--repo',repo,'--org',org,'--id','canary-forward','--from-root',bundle,'--target-root',config.successor];
    const forwardPlan=nextControls([...forward,'--dry-run'],controlOptions);
    const forwardReceipt=nextControls([...forward,'--expected-plan',forwardPlan.archive.sha256],controlOptions);
    // A nonexistent rollback target is rejected before a new maintenance effect.
    const missing=['upgrade','--repo',repo,'--org',org,'--id','canary-missing','--from-root',config.successor,'--target-root',path.join(home,'releases/missing'),'--rollback','--dry-run'];
    assert.throws(()=>nextControls(missing,controlOptions));
    checked(process.execPath,[path.join(config.successor,'herdr/releases.mjs'),'pin',home,repo,'scenario']);
    git(['add','.herdr-release.json']);git(['commit','-qm','Select original scratch candidate']);
    const rollback=['upgrade','--repo',repo,'--org',org,'--id','canary-rollback','--from-root',config.successor,'--target-root',bundle,'--rollback'];
    const rollbackPlan=nextControls([...rollback,'--dry-run'],controlOptions);
    const rollbackReceipt=nextControls([...rollback,'--expected-plan',rollbackPlan.archive.sha256],controlOptions);
    assert.equal(fs.readFileSync(path.join(directory,'installation.json'),'utf8'),installation);
    assert.equal(fs.readFileSync(path.join(directory,'service.plist'),'utf8'),plist);
    assert.deepEqual(captured(),saved);assert.equal(ownerAlive(producer.watcher),true);
    controls(['restart','--repo',repo,'--org',org],controlOptions);
    stage('S7',{forwardPlan,forwardReceipt,rollbackPlan,rollbackReceipt,jobsUnchanged:saved,callback:producer.to,
      missingTargetRefused:true,originalInstallationRestored:true,originalPlistRestored:true});
  }

  // Report A with two real intake controls. Source close and physical cleanup
  // must happen while its one original review has no verdict or worker.
  const proposals=[{role:'engineer',title:'Ordinary retained canary proposal',why:'Scripted intake control'},
    {role:'engineer',title:'Reserved retained canary proposal',why:'Scripted reserved control',operator_reserved:true}];
  report(producer,[`source: ${head}; base: ${base}`],'',proposals);
  const reportAt=performance.now();await until(()=>available(producer),'A watcher availability');
  const noticeMs=performance.now()-reportAt;
  for(const name of ['STOP','HOLD']) {
    const file=path.join(repo,'.lane/supervisor',name);fs.writeFileSync(file,'Fixture-owned report cleanup boundary\n');
    assert.match(service(0).pass().held,/STOP\/HOLD/);assert.ok(fs.existsSync(lane));
    assert.equal(native().workspaces[producer.worker.workspaceId].agent.name,producer.worker.agentName);fs.unlinkSync(file);
  }
  // Folder removal precedes branch deletion and empty-workspace closure.
  // Observe the original closer through completion before asserting its effects.
  service(0).pass();await until(()=>finished(producer)&&!fs.existsSync(lane)&&
    !native().workspaces[producer.worker.workspaceId]&&events().some(e=>e.type==='closeout.evaluated'&&
      e.run===producer.run&&e.reportCloseout&&e.completed),'A source, native and physical cleanup before review');
  assert.ok(noticeMs<=60000,'report availability exceeds declared 60 s observation');
  assert.ok(performance.now()-reportAt<=120000,'report cleanup exceeds declared 120 s observation');
  const reviewItems=()=>[...state().items.values()].filter(i=>i.meta.review_source_run===producer.run);
  assert.equal(reviewItems().length,1);const review=reviewItems()[0];
  assert.equal(review.runs.length,0);assert.equal(review.meta.review_round_cap,1);
  assert.deepEqual({base:review.meta.review_target.base,head:review.meta.review_target.head},{base,head});
  assert.match(git(['show',`${head}:answer.txt`]),/Installed consumer change/);
  assert.equal(native().workspaces[producer.worker.workspaceId],undefined);
  assert.equal(git(['branch','--list','lane/'+producer.lane]),'');
  stage('S1',{item,run:producer.run,base,head,report_to_cleanup_ms:performance.now()-reportAt,
    review:review.id,reviewRuns:0,sourceClosed:true,nativeReleased:true,folderRemoved:true,sourceReadableAfterRemoval:true,
    watcherNoticeMs:noticeMs,closeout:events().filter(e=>e.run===producer.run&&e.type.startsWith('closeout.')),
    firstTurn:JSON.parse(fs.readFileSync(path.join(directory,'closeout-turn.json'))),cleanupHeldAtReportBoundary:['STOP','HOLD']});

  // Exhaust the original finite allowance. The production turn may neither
  // register a wait nor issue another command; subsequent ordinary scheduling
  // still dispatches B and the original A review, without an item start/nudge.
  const {runCloseoutTurn}=await module('line-service/closeout-turn.mjs');
  const waits=events().filter(e=>e.type==='closeout.waiting');
  const {deadline,contentions}=await expiredCloseoutControl({runCloseoutTurn,until,
    options:{project,org,env,guard:()=>{},measure:()=>{},
      cli:()=>assert.fail('expired original turn issued a command')}});
  assert.deepEqual(events().filter(e=>e.type==='closeout.waiting'),waits);
  const intake=[...state().items.values()].filter(i=>i.created.run===producer.run);
  assert.equal(intake.filter(i=>i.meta.proposal_intake).length,2);
  const {proposalDisposition,proposalToken}=await module('lib/proposal-intake.mjs');
  const ordinary=intake.find(i=>i.title===proposals[0].title),reserved=intake.find(i=>i.title===proposals[1].title);
  const authority={native_caller:{name:'scratch-supervisor',terminal_id:'control-terminal'}};
  const disposition=id=>({state:state(),events:events(),id,expect:proposalToken(state(),id),cut:'selection',why:'Explicit scratch selection cut',authority});
  const mutation=proposalDisposition(disposition(ordinary.id));transact(org,()=>mutation);
  assert.throws(()=>proposalDisposition(disposition(reserved.id)),/retained|unselected dependency-free/);
  assert.equal(state().items.get(reserved.id).runs.length,0);
  const startedAt=performance.now();service(8).pass();
  const b=journals().find(j=>j.item===successorItem),reviewJob=journals().find(j=>j.item===review.id);
  assert.ok(b,audit());assert.ok(reviewJob,audit());assert.equal(b.stage,'complete');assert.equal(reviewJob.stage,'complete');
  assert.equal(b.release.root,bundle);assert.equal(reviewJob.release.root,bundle);
  assert.equal(state().runs.get(reviewJob.run).report,null);
  assert.equal(prompts(b).length,1);assert.equal(reviewItems().length,1);
  assert.ok(performance.now()-startedAt<=120000,'eligible successor native input exceeds declared 120 s observation');
  stage('S6',{proposals:intake.map(i=>({id:i.id,title:i.title,meta:i.meta})),ordinaryDisposition:mutation,
    reservedRetained:true,deadline,contentions,originalWaitCount:waits.length,waitCount:events().filter(e=>e.type==='closeout.waiting').length,
    successorNativeInputMs:performance.now()-startedAt});
  const bSource=land(b,'successor.txt');
  const bCompletion=await complete(b,[`source: ${bSource.head}; base: ${bSource.base}`]);
  assert.equal(state().runs.get(reviewJob.run).report,null,'B completes with A review pending');
  const reviewCompletion=await complete(reviewJob,[],'verdict: PASS\n');
  assert.equal(reviewItems().length,1);assert.equal(state().items.get(review.id).runs.length,1);
  assert.equal(events().filter(e=>e.type==='change.reviewed'&&e.review===review.id).length ||
    events().filter(e=>e.type==='change.reviewed'&&e.head===head).length,1);
  assert.equal(calls().some(a=>a[0]==='pane'&&a[1]==='run'&&/test\/helpers|npm test/.test(a[3]??'')),false);
  stage('S2',{ordinaryUnits:[{item,run:producer.run,base,head},{item:successorItem,run:b.run,...bSource}],
    bCompletion,reviewCompletion,originalReview:review.id,originalReviewRun:reviewJob.run,reviewerSuites:0});
  async function drainReviews(){
    // Pin commits and B's landing have their own canonical review obligations.
    // Account for those explicitly, without manufacturing another review of A.
    service(8).pass();
    for(const job of journals())if(job.stage==='complete'&&!state().runs.get(job.run).report&&state().items.get(job.item).meta.review_key)
      await complete(job,[],'verdict: PASS\n');
  }
  await drainReviews();
  // S4 between-stage controls have their own attempt. Preserve even an actual
  // prohibited FF as FAIL, then observe independent cleanup without replay.
  const guardItem=record(['add','Guarded installed promotion control','--role','engineer']).match(/ENG-\d+/)[0];service(1).pass();
  const guardJob=journals().find(j=>j.item===guardItem);assert.ok(guardJob,audit());
  const guardBase=git(['rev-parse','main']);
  fs.writeFileSync(path.join(guardJob.worker.cwd,'guard.txt'),'Guarded control\n');git(['add','guard.txt'],guardJob.worker.cwd);
  git(['commit','-qm','Guarded control'],guardJob.worker.cwd);const guardHead=git(['rev-parse','HEAD'],guardJob.worker.cwd),selectionGuards=[];
  for(const name of ['STOP','HOLD']) {
    const file=path.join(repo,'.lane/supervisor',name);fs.writeFileSync(file,'Fixture-owned between-stage hold\n');
    const result=run(process.execPath,[path.join(bundle,'lanes/lane.mjs'),'promote',guardJob.lane,'--expected-head-from-worktree'],{cwd:guardJob.worker.cwd,env:workerEnv(guardJob)});
    if(result.status===0){assert.equal(git(['rev-parse','main']),guardHead);failures.push({case:'S4',guard:name,reason:'Project guard permitted worker promotion',result});}
    else{assert.match(result.stderr+result.stdout,/STOP|HOLD|stopped|hold/i);assert.equal(git(['rev-parse','main']),guardBase);}
    assert.ok(fs.existsSync(guardJob.worker.cwd));assert.match(service(0).pass().held,/STOP\/HOLD/);
    selectionGuards.push({name,status:result.status,stdout:result.stdout,stderr:result.stderr});fs.unlinkSync(file);
  }
  if(git(['rev-parse','main'])!==guardHead)promote(guardJob);
  report(guardJob,[`source: ${guardHead}; base: ${guardBase}`]);service(0).pass();
  await until(()=>finished(guardJob)&&!fs.existsSync(guardJob.worker.cwd),'guard allocation original report cleanup');
  stage('S4-boundary',{status:failures.length?'FAIL':'PASS',failures,originalAttempt:guardJob.token,head:guardHead,guards:selectionGuards,
    stoppedWatcherRetained:true,rearmed:false,reportIntake:'normal line reconciliation',resumedOriginal:failures.length===0});
  await drainReviews();

  // S8 equivalent installed same-release policy control: use the supported
  // record selection policy, not a rebuild. The demo's real owner remains live
  // acceptance owner; its offline control is not silently counted here.
  const policyItem=record(['add','Same-release selected configuration control','--role','engineer']).match(/ENG-\d+/)[0];
  record(['set',policyItem,'meta.queue_selected=false']);service(1).pass();
  assert.equal(state().items.get(policyItem).runs.length,0);
  const oldRun=JSON.stringify(state().runs.get(producer.run));
  const policyBefore=JSON.parse(record(['config','--json']));
  const digest=createHash('sha256').update(fs.readFileSync(path.join(repo,'.lane.json'))).digest('hex');
  record(['config','set','routes.engineer.effort','high','--expect',digest,'--who-asked','Installed canary equivalent same-release operations control']);
  const policyAfter=JSON.parse(record(['config','--json']));
  git(['add','.lane.json']);git(['commit','-qm','Audited scratch project operations change']);
  record(['set',policyItem,'meta.queue_selected=true']);service(2).pass();
  const policyJob=journals().find(j=>j.item===policyItem);assert.ok(policyJob,audit());assert.equal(policyJob.release.commit,commit);
  assert.equal(state().runs.get(policyJob.run).meta.effort,'high');
  assert.equal(JSON.stringify(state().runs.get(producer.run)),oldRun);
  // This clean unlanded branch is retained by the real closer. An unsaved file
  // on a different allocation is tested below, never removed by fixture fiat.
  fs.writeFileSync(path.join(policyJob.worker.cwd,'unlanded.txt'),'Keep unlanded work\n');
  git(['add','unlanded.txt'],policyJob.worker.cwd);git(['commit','-qm','Retained unlanded control'],policyJob.worker.cwd);
  const unlanded=git(['rev-parse','HEAD'],policyJob.worker.cwd);
  report(policyJob,[]);await until(()=>available(policyJob),'policy watcher');service(0).pass();
  await until(()=>!fs.existsSync(policyJob.worker.cwd),'safe unlanded folder closeout');
  assert.equal(git(['rev-parse','refs/heads/lane/'+policyJob.lane]),unlanded);
  assert.equal(state().items.get(reserved.id).runs.length,0);
  stage('S8',{selection:'equivalent supported audited project route configuration and record selection',reason:'ENG-1041 live demonstration remains with its owner',
    item:policyItem,run:policyJob.run,commit,root:policyJob.release.root,unselectedRuns:0,selectedPrompts:prompts(policyJob).length,
    reservedRuns:0,unlandedBranchRetained:unlanded,effectivePolicy:state().items.get(policyItem).meta,policyBefore,policyAfter,
    audit:events().filter(e=>e.type==='config.changed'),nextRunEffort:'high',oldRunUnchanged:true});
  await drainReviews();

  // Script native refusal and lost replies on separate original attempts. Two
  // subsequent normal turns must not retry or replace either original input.
  const uncertainItem=record(['add','Retain original lost reply','--role','engineer']).match(/ENG-\d+/)[0];
  fs.writeFileSync(path.join(root,'lose-prompt-reply'),'scripted reply loss');service(1).pass();fs.unlinkSync(path.join(root,'lose-prompt-reply'));
  const unknown=journals().find(j=>j.item===uncertainItem);assert.ok(unknown,audit());
  const refusedItem=record(['add','Retain explicitly refused input','--role','engineer']).match(/ENG-\d+/)[0];
  fs.writeFileSync(path.join(root,'refuse-prompt'),'scripted native fence');service(1).pass();fs.unlinkSync(path.join(root,'refuse-prompt'));
  const refused=journals().find(j=>j.item===refusedItem);assert.ok(refused,audit());
  const originals=new Map([unknown,refused].map(j=>[j.file,fs.readFileSync(j.file)]));
  for(let i=0;i<2;i++)service(0).pass();
  for(const job of [unknown,refused]){
    assert.deepEqual(fs.readFileSync(job.file),originals.get(job.file));assert.equal(prompts(job).length,1);
    assert.equal(journals().filter(j=>j.item===job.item).length,1);assert.ok(fs.existsSync(job.worker.cwd));
  }
  stage('S3',{reconciliationTurns:2,attempts:[unknown,refused].map(j=>({item:j.item,run:j.run,token:j.token,stage:j.stage,error:j.error,
    journal:j.file,sha256:createHash('sha256').update(originals.get(j.file)).digest('hex'),prompts:prompts(j).length,folderKept:true}))});

  // S5 missing-folder control: move only this explicitly disposable fixture
  // allocation to a retained archive. Absence never authorizes another input.
  const missingArchive=path.join(root,'missing-allocation-retained');fs.renameSync(unknown.worker.cwd,missingArchive);
  for(let i=0;i<2;i++)service(0).pass();
  assert.deepEqual(fs.readFileSync(unknown.file),originals.get(unknown.file));assert.equal(prompts(unknown).length,1);
  assert.equal(state().runs.get(unknown.run).report,null);assert.ok(fs.existsSync(missingArchive));
  const {legacyExitQualification,legacyExitAllocation,observeLegacyExitAbsence}=await module('lib/closeout-legacy-exits.mjs');
  const entry={reportCloseout:true,common:project.identity,project:repo,key:'scripted-legacy',source:{seq:1,type:'report.ingested'},
    cwd:refused.worker.cwd,run:'R-legacy',item:'ENG-legacy',panes:[{run:'R-legacy',agent:'old-worker',pane:'old:p',workspace:'old',terminal:'old-term',session:'old-session',tab:'old:t'}]};
  const fact={identity:entry.common,key:entry.key,source:entry.source};
  const intent={type:'closeout.effect',...fact,seq:2,at:'2026-10-30T00:00:00Z',effect:'original-legacy-exit',producer:'native-closeout/v2',
    outcome:{action:'agent-exit-requested',run:entry.run,pane:'old:p',tab_id:'old:t',occupant:['old-worker','codex','old:p','old',entry.cwd,'old-term','old-session'],shell:{pid:1,identity:'old-shell',command:'[sh]'}}};
  const native_result={action:'skip-close',reason:'occupant or shell identity changed during agent exit'};
  const legacy=[intent,{type:'closeout.evaluated',...fact,seq:3,completed:false,native_result,code:{code:{kind:'checkout',root:repo,common:project.identity,
    commit,graph:'closer-imports/v1',files:'b52b10e3883eb09e2692c14e41ea771cb4604ce38363e3693d2cea88dc50bce5'},epoch:{branch:'main',tip:commit}}},
    {type:'closeout.command-failed',...fact,seq:4,intent:intent.effect,native_result,failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}}];
  assert.ok(legacyExitQualification(entry,intent,legacy));
  const model=(cwd,session)=>({items:new Map([[entry.item,{runs:[entry.run,'R-successor']}]]),runs:new Map([['R-successor',
    {id:'R-successor',workspace:cwd,report:{outcome:'done'},meta:{agent:'new',pane:'new:p',terminal_id:'new-term',agent_session_id:session}}]])});
  assert.equal(legacyExitAllocation(entry,legacy,model(entry.cwd,'new-session')),false);
  assert.equal(legacyExitAllocation(entry,legacy,model(entry.cwd+'-new','old-session')),false);
  assert.equal(legacyExitAllocation(entry,legacy,model(entry.cwd+'-new','new-session')),true);
  const snapshot={errors:[],nativeInventory:{complete:true,panes:[]},agents:[]};
  assert.ok(observeLegacyExitAbsence(entry,intent,legacy,snapshot,new Date().toISOString()));
  assert.equal(observeLegacyExitAbsence(entry,intent,legacy,{...snapshot,agents:[native().workspaces[refused.worker.workspaceId].agent]},new Date().toISOString()),undefined);
  assert.ok(fs.existsSync(refused.worker.cwd));assert.equal(git(['rev-parse','HEAD'],refused.worker.cwd),git(['rev-parse','refs/heads/lane/'+refused.lane]));
  write('legacy-control.json',{fixtureOnly:true,entry,legacy,reusedLaneRefused:true,reusedSessionRefused:true,separateFinishedAccepted:true});
  stage('S5',{missingFolder:true,missingArchive,originalAttempt:unknown.token,journalUnchanged:true,prompts:1,reconciliationTurns:2,
    legacyFixture:'legacy-control.json',legacyUnknownRetained:true,reusedLaneRefused:true,reusedSessionRefused:true,successorFolderAndBranchSurvive:true});

  // Dirty preservation through actual report closeout, with capacity permitting
  // unrelated work despite the original uncertain/refused allocations.
  const dirtyItem=record(['add','Retain unsaved installed work','--role','engineer']).match(/ENG-\d+/)[0];service(1).pass();
  const dirty=journals().find(j=>j.item===dirtyItem);assert.ok(dirty,audit());
  fs.writeFileSync(path.join(dirty.worker.cwd,'unsaved.txt'),'Keep unsaved fixture work\n');
  report(dirty,[]);await until(()=>available(dirty),'dirty control report');service(0).pass();
  assert.equal(fs.readFileSync(path.join(dirty.worker.cwd,'unsaved.txt'),'utf8'),'Keep unsaved fixture work\n');
  stage('S1-preservation',{dirtyRun:dirty.run,folderKept:true,unsavedBytes:'Keep unsaved fixture work\n',unlandedBranchRetained:unlanded,
    closeout:events().filter(e=>e.run===dirty.run&&e.type.startsWith('closeout.'))});

  await sharedCase();
  const {productFiles,payloadEntry}=await module('lib/product-files.mjs');
  assert.deepEqual(Object.fromEntries(productFiles(bundle).sort().map(f=>[f,payloadEntry(bundle,f)])),config.candidate.files);
  write('outcome.json',{schema:config.skipPassedCases.length?'brain.installed-lifecycle-control/v1':'brain.installed-canary/v1',ready:false,fixtureOnly:true,scriptedMechanics:true,
    candidate:config.candidate,cases:['S0','S1','S2','S3','S4','S5','S6','S7','S8','shared-observer'].filter(name=>!config.skipPassedCases.includes(name)),
    skippedCases:config.skipPassedCases,wholeCanary:config.skipPassedCases.length?'UNRUN':'executed',status:failures.length?'FAIL':'PASS',failures,
    originalReview:review.id,reviewerSuites:0,base,head,ordinarySuccessor:b.run,limits:['No real model/native/account execution','No real probation/soak/adoption','Synthetic acceptance never qualifies real runtime'],
    packet:{stages:'stages.json',tuple:'original-candidate.json',equivalence:'candidate-equivalence.json',commands:'commands.jsonl',native:'../native-calls.jsonl',record:'../project/.org/events.jsonl'}});
  // Stop only owned fixture observers/watchers after preserving their original
  // journals and proving they cannot be replayed. Dirty/UNKNOWN files archive.
  for(const job of journals())if(job.watchMode!=='shared'&&job.watcher&&ownerAlive(job.watcher))process.kill(job.watcher.pid,'SIGTERM');
  await until(()=>journals().every(j=>j.watchMode==='shared'||!j.watcher||!ownerAlive(j.watcher)),'owned watcher teardown');
  await until(()=>!fs.existsSync(path.join(directory,'closeout-turn.lock')),'finite closeout teardown');
  for(const [file,bytes]of originals)assert.deepEqual(fs.readFileSync(file),bytes);
  stage('fixture-teardown',{originalJournalsUnchanged:true,watchersStopped:true,retainedWorkArchived:true});
  assert.deepEqual(failures,[],'Canary failures remain failed after independent observations');

  async function sharedCase(){
    // Real observer entry, real 30 s safety reconciliation and real original
    // finite watcher consumers; only snapshot/account/transport and dropped
    // hint inputs are scripted. No per-run resident process is created.
    fs.writeFileSync(process.env.HERDR_SOCKET_PATH,'scripted protocol-22 socket identity');
    // Enable the same project choice used by installed ordinary/review starts.
    // The real line owns startup; this harness supplies no watch-mode flag and
    // starts no observer process.
    const policy=path.join(repo,'.lane.json');
    const selected=JSON.parse(fs.readFileSync(policy));selected.dispatch={...selected.dispatch,watch_mode:'shared'};
    fs.writeFileSync(policy,JSON.stringify(selected)+'\n');
    // This fixture's project policy is tracked. Keep canonical main clean for
    // real report closeout, and exclude only a review of fixture configuration.
    git(['add','.lane.json']);git(['commit','-qm','Select shared observation in scratch project']);
    const existingItems=new Set(state().items.keys()),savedDrop=env.INSTALLED_CYCLE_DROP_HINTS;
    env.INSTALLED_CYCLE_DROP_HINTS='1';
    const ownerFile=path.join(org,'watch/observer/owner.json'),sessionlessStart=path.join(root,'sessionless-start');
    fs.writeFileSync(sessionlessStart,'Codex session is established by the first prompt\n');
    let owner;
    try {
      service(0).pass();
      for(const queued of state().items.values())if(!existingItems.has(queued.id)&&queued.meta?.review_target)
        record(['set',queued.id,'meta.queue_selected=false']);
      await until(()=>fs.existsSync(ownerFile),'line-owned shared observer receipt');
      owner=JSON.parse(fs.readFileSync(ownerFile));assert.equal(owner.source,bundle);
      const sharedHost=job=>{
        assert.equal(job.watchMode,'shared');assert.equal(job.watcher.run,job.run);
        assert.equal(job.watcher.shared,path.join(org,'watch/shared',job.run+'.json'));
        assert.deepEqual(job.watcher.host,{pid:owner.pid,identity:owner.identity,log:owner.log});
        assert.equal(ownerAlive(job.watcher.host),true,'shared duty belongs to the live original observer');
        assert.equal(job.watcher.pid,undefined,'shared duty has no per-run resident');
        const duty=JSON.parse(fs.readFileSync(job.watcher.shared));
        assert.equal(duty.run,job.run);assert.equal(duty.source,bundle);
        assert.deepEqual(duty.ownership,job.ownership);
        assert.equal(duty.native.session,undefined,'registration precedes the first Codex session');
        assert.equal(state().runs.get(job.run).meta.agent_session_id,undefined,'original launch receipt has no session');
        const binding=events().find(e=>e.type==='run.session_bound'&&e.run===job.run);
        assert.ok(binding,'the original dispatch commits its late session binding');
        assert.equal(binding.session,native().workspaces[job.worker.workspaceId].agent.agent_session.value);
        assert.equal(job.sessionBinding.status,'bound');assert.equal(prompts(job).length,1);
      };
      const sharedItem=record(['add','Shared installed observation control','--role','engineer']).match(/ENG-\d+/)[0];service(1).pass();
      const job=journals().find(j=>j.item===sharedItem);assert.ok(job,audit());sharedHost(job);
      const step=path.join(org,'watch/steps',job.run+'.json'),observations=path.join(org,'watch/observer/observations.jsonl');
      const rows=()=>fs.existsSync(observations)?fs.readFileSync(observations,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
      const settled=async(file,label)=>until(()=>{
        if(!fs.existsSync(file)||JSON.parse(fs.readFileSync(file)).phase!=='waiting')return false;
        const last=rows().at(-1);return last?.action==='reconciled'&&last.active===0&&last.queued===0;
      },label);
      await settled(step,'initial shared consumer durably waiting and observer idle');
      const baseline=rows().filter(r=>r.action==='safety-repair').length;
      changeNative(n=>{n.workspaces[job.worker.workspaceId].agent.agent_status='blocked';});
      await until(()=>events().some(e=>e.type==='note.added'&&e.id===job.run&&e.text.includes('[watch-blocked]')),'lost blocked hint recovered by 30 s safety timer');
      const blockedNotes=events().filter(e=>e.type==='note.added'&&e.id===job.run&&e.text.includes('[watch-blocked]'));
      assert.equal(blockedNotes.length,1);
      await settled(step,'blocked consumer durably waiting and observer idle');
      assert.ok(rows().some(r=>r.action==='safety-repair'&&r.run===job.run&&r.current.state==='blocked'));
      // Vanish the native worker without changing its original binding.
      const original=native().workspaces[job.worker.workspaceId].agent;
      const originalJournal=fs.readFileSync(job.file),originalDuty=fs.readFileSync(job.watcher.shared);
      changeNative(n=>{delete n.workspaces[job.worker.workspaceId].agent;});
      await until(()=>events().some(e=>e.type==='note.added'&&e.id===job.run&&e.text.includes('gone')),'lost vanished hint recovered');
      // A delivered missing-worker notice completes the finite step; it does
      // not authorize finality or cleanup of the original allocation. Genuine
      // consumer errors, rather than a vanished worker, require a held duty.
      await until(()=>JSON.parse(fs.readFileSync(step)).phase==='complete'&&
        rows().some(r=>r.action==='consumer-finished'&&r.run===job.run&&r.result.code===0),
        'vanished original consumer notice durably completed');
      const vanishedBytes=fs.readFileSync(step),vanishedStep=JSON.parse(vanishedBytes);
      assert.equal(fs.existsSync(path.join(org,'watch/observer/held',job.run+'.json')),false);
      const reportItem=record(['add','Shared report and cleanup control','--role','engineer']).match(/ENG-\d+/)[0];service(1).pass();
      const reportJob=journals().find(j=>j.item===reportItem);assert.ok(reportJob,audit());sharedHost(reportJob);
      await settled(path.join(org,'watch/steps',reportJob.run+'.json'),'report shared consumer durably waiting and observer idle');
      report(reportJob,[]);
      await until(()=>events().some(e=>e.type==='note.added'&&e.id===reportJob.run&&e.watch_notice_id===`watch:${reportJob.run}:final`),'lost report hint recovered by original finite watcher');
      service(0).pass();await until(()=>!fs.existsSync(reportJob.worker.cwd)&&!native().workspaces[reportJob.worker.workspaceId],
        'shared report physical and native cleanup');
      assert.equal(events().filter(e=>e.type==='report.ingested'&&e.run===reportJob.run).length,1);
      assert.equal(native().workspaces[reportJob.worker.workspaceId],undefined);
      assert.equal(journals().filter(j=>j.item===sharedItem||j.item===reportItem).length,2);
      const repairs=rows().filter(r=>r.action==='safety-repair');assert.ok(repairs.length>baseline);
      assert.ok(repairs.some(r=>r.run===reportJob.run&&r.current.report!=='missing'&&r.previous.report==='missing'));
      const reconciled=rows().filter(r=>r.action==='reconciled'&&r.reason==='safety');assert.ok(reconciled.length>=3);
      assert.ok(rows().every(r=>r.active===undefined||r.active<=2));
      const goneNotes=events().filter(e=>e.type==='note.added'&&e.id===job.run&&e.text.includes('gone'));
      assert.equal(goneNotes.length,1);assert.deepEqual(fs.readFileSync(step),vanishedBytes);
      assert.deepEqual(fs.readFileSync(job.file),originalJournal);assert.deepEqual(fs.readFileSync(job.watcher.shared),originalDuty);
      assert.equal(state().runs.get(job.run).report,null);assert.ok(fs.existsSync(job.worker.cwd));assert.equal(prompts(job).length,1);
      assert.equal(rows().some(r=>r.run===job.run&&['consumer-held','observation-held'].includes(r.action)),false);
      stage('shared-observer',{source:bundle,owner,run:job.run,reportRun:reportJob.run,watchMode:'shared',perRunResidents:0,
        watchers:[job.watcher,reportJob.watcher],
        sessionlessRegistration:true,sessionBindings:events().filter(e=>e.type==='run.session_bound'&&[job.run,reportJob.run].includes(e.run)),
        droppedHints:['native blocked','native vanished','report file'],safetyMs:30000,reconciled,repairs,blockedNotes,
        vanishedStep,goneNotes,originalDutyUnchanged:true,originalJournalUnchanged:true,vanishedAllocationRetained:true,
        completedStepNotReplayed:true,originalBinding:original,reportOnce:true,reportFolderRemoved:true,reportNativeReleased:true,consumerCap:2});
    } finally {
      fs.rmSync(sessionlessStart,{force:true});
      if(savedDrop===undefined)delete env.INSTALLED_CYCLE_DROP_HINTS;else env.INSTALLED_CYCLE_DROP_HINTS=savedDrop;
      // Fixture teardown uses the supported line STOP boundary.
      fs.writeFileSync(path.join(directory,'STOP'),'Shared canary teardown\n');
      owner??=fs.existsSync(ownerFile)?JSON.parse(fs.readFileSync(ownerFile)):null;
      if(owner)await until(()=>!ownerAlive(owner),'line-owned observer stopped');
    }
  }
}
