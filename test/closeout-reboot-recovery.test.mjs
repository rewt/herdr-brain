import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {currentCloseoutEntries,fileIdentity,sameFileIdentity,closeoutRevision} from '../lib/closeout.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';
import {closeoutNextStage} from '../lib/closeout-status.mjs';

function fixture(t){
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const turn=()=>runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,
    cli:(_file,args)=>args[0]==='refresh'?'{}':JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true}))});
  return{...f,turn};
}
function savedBeforeReboot(f){
  const all=events(f),source=all.find(e=>e.type==='report.ingested');
  for(const entry of source.closeout_targets)for(const identity of [entry.worktreeIdentity,entry.gitIdentity,entry.branchLog.identity])identity.dev++;
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
  return currentCloseoutEntries(f.common,f.org,events(f))[0];
}
function prior(f,entry,reason,extra={}){
  return f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,
    revision:closeoutRevision(entry,events(f)),completed:false,reason,...extra}])[0];
}

test('reboot identity admits device renumbering and refuses replacement inode, birth and missing birth',t=>{
  const f=fixture(t),file=path.join(f.lane,'seed'),identity=fileIdentity(file);
  assert.equal(sameFileIdentity(file,{...identity,dev:identity.dev+1}),true);
  assert.equal(sameFileIdentity(file,{...identity,ino:identity.ino+1}),false);
  assert.equal(sameFileIdentity(file,{...identity,birthtimeMs:identity.birthtimeMs+1}),false);
  assert.equal(sameFileIdentity(file,{...identity,dev:identity.dev+1,birthtimeMs:0}),false);
  assert.equal(sameFileIdentity(file,null),false);
});

test('finite closer releases a clean landed original allocation saved before reboot without rebinding',t=>{
  const f=fixture(t),entry=savedBeforeReboot(f);
  prior(f,entry,'queued branch generation changed; keep',{condition:{kind:'allocation-changed',continuation:{kind:'owner-evidence'}}});
  const original=fs.readFileSync(f.eventFile),result=f.turn();
  assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);assert.equal(result.subjects[0].evaluations[0].completed,true);
  assert.equal(fs.existsSync(f.lane),false);assert.deepEqual(f.read().agents,[]);
  assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,original.length),original);
  assert.equal(events(f).some(e=>e.type==='cleanup.bound'),false);
  assert.ok(effects(f).some(e=>e.action==='lane-preflight'));
});

for(const mode of ['rename-copy','reflog-expire'])
test(`reflog correction releases identical history after two ${mode} rewrites without rebinding`,async t=>{
  const f=fixture(t),entry=savedBeforeReboot(f),old=prior(f,entry,'queued branch generation changed; keep');
  const bytes=fs.readFileSync(entry.branchLog.path),tree=fileIdentity(f.lane),gitDir=fileIdentity(entry.gitDirectory);
  for(let n=0;n<2;n++){
    const before=fileIdentity(entry.branchLog.path);await pause(5);
    if(mode==='rename-copy'){
      const backup=entry.branchLog.path+`.original-${n}`;
      fs.renameSync(entry.branchLog.path,backup);fs.copyFileSync(backup,entry.branchLog.path);
    }else f.git(['reflog','expire','--expire=never','--all']);
    const after=fileIdentity(entry.branchLog.path);
    assert.notEqual(after.ino,before.ino);assert.notEqual(after.birthtimeMs,before.birthtimeMs);
    assert.deepEqual(fs.readFileSync(entry.branchLog.path),bytes);
    assert.deepEqual(fileIdentity(f.lane),tree);assert.deepEqual(fileIdentity(entry.gitDirectory),gitDir);
    assert.equal(f.git(['rev-parse','lane/topic']),entry.head);
    assert.deepEqual(closeoutNextStage(entry,old,events(f)),{stage:'pre-effect-observation',ready:true});
  }
  const original=fs.readFileSync(f.eventFile),result=f.turn();
  assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);
  assert.equal(result.subjects[0].evaluations[0].completed,true,JSON.stringify(result));
  assert.equal(fs.existsSync(f.lane),false);assert.deepEqual(f.read().agents,[]);
  assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.equal(events(f).some(e=>['cleanup.bound','run.session_bound'].includes(e.type)&&e.seq>entry.source.seq),false);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,original.length),original);
  for(const action of ['lane-preflight','worktree-removed','branch-removed','lane-removed'])assert.ok(effects(f).some(e=>e.action===action),action);
});

for(const kind of ['changed-log','recreated-branch','replaced-folder','replaced-git-directory','STOP','dirty','unmerged','UNKNOWN','refusal'])
test(`reboot recovery retains the real ${kind} safeguard`,t=>{
  const f=fixture(t),entry=savedBeforeReboot(f);
  const old=prior(f,entry,'queued branch generation changed; keep');
  if(kind==='recreated-branch'){
    const original=fs.readFileSync(entry.branchLog.path);
    f.git(['update-ref','-d','refs/heads/lane/topic']);
    f.git(['update-ref','-m','recreated branch','refs/heads/lane/topic',entry.head]);
    assert.equal(f.git(['rev-parse','lane/topic']),entry.head);
    assert.notDeepEqual(fs.readFileSync(entry.branchLog.path),original);
  }
  if(kind==='replaced-git-directory'){
    fs.renameSync(entry.gitDirectory,entry.gitDirectory+'.original');
    fs.cpSync(entry.gitDirectory+'.original',entry.gitDirectory,{recursive:true});
  }
  if(kind==='changed-log')fs.appendFileSync(entry.branchLog.path,'different branch history\n');
  if(kind==='replaced-folder'){
    fs.renameSync(f.lane,f.lane+'.original');fs.mkdirSync(f.lane);
    fs.copyFileSync(path.join(f.lane+'.original','.git'),path.join(f.lane,'.git'));
  }
  if(kind==='STOP'){fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'stop');}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'retain');
  if(kind==='unmerged')f.git(['reset','--hard',f.head+'^']);
  if(kind==='UNKNOWN')f.append([{type:'closeout.effect',identity:f.common,key:entry.key,source:entry.source,effect:'unknown',
    producer:'native-closeout/v2',outcome:{action:'shell-close-requested',tab_id:'w:t',panes:[{pane:'w:p',terminal:'term'}]}}]);
  if(kind==='refusal')prior(f,entry,'original native refusal remains held; explicit owner clearing evidence required',{failure:{kind:'fence',code:'EPERM'}});
  if(['changed-log','recreated-branch','replaced-folder','replaced-git-directory'].includes(kind))assert.equal(closeoutNextStage(entry,old,events(f)),undefined);
  const original=fs.readFileSync(f.eventFile),calls=f.herdrCalls();f.drain({keys:[entry.key],retrySafe:true});
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,original.length),original);
  if(kind==='unmerged'){
    assert.equal(fs.existsSync(f.lane),false,'the clean folder can release while its unmerged branch is retained');
    assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  }else assert.equal(fs.existsSync(f.lane),true);
  if(['changed-log','recreated-branch','replaced-folder','replaced-git-directory','STOP','UNKNOWN','refusal'].includes(kind))assert.deepEqual(f.read().actions,[]);
  if(['UNKNOWN','refusal'].includes(kind))assert.deepEqual(f.herdrCalls(),calls);
});

test('finite closer resumes an exact pre-effect STOP keep after the fence clears without a completion decision',t=>{
  const f=fixture(t),entry=currentCloseoutEntries(f.common,f.org,events(f))[0],stop=path.join(f.repo,'.lane/supervisor/STOP');
  fs.mkdirSync(path.dirname(stop),{recursive:true});fs.writeFileSync(stop,'stop');
  prior(f,entry,'STOP/HOLD prevents queued retirement effect',{condition:{kind:'safety-hold',continuation:{kind:'owner-evidence'}}});
  assert.ok(f.drain({keys:[entry.key],retrySafe:true}).evaluated.every(e=>!e.completed));assert.deepEqual(f.read().actions,[]);
  fs.unlinkSync(stop);const original=fs.readFileSync(f.eventFile),result=f.turn();
  assert.deepEqual(result.errors,[]);assert.equal(result.subjects[0].evaluations[0].completed,true);
  assert.equal(fs.existsSync(f.lane),false);assert.deepEqual(result.decisions,{existing:0,attempted:0});
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,original.length),original);
});
