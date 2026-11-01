import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {closeoutCondition,preEffectCloseout} from '../lib/closeout-facts.mjs';
import {closeoutNextStage,closeoutWaitId} from '../lib/closeout-status.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {setup,events,evaluations,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

const reason='preservation claim inputs changed; prepare again; lane kept';

function changingClaim(t,{changes=1,claim}={}) {
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const command=f.options.command,log=f.options.log;
  let prepared=false,reads=0,changed=0;
  const preparations=[];
  f.options.log=row=>{
    log(row);
    if(row.action==='lane-preflight'){prepared=true;reads=0;preparations.push(row);}
  };
  f.options.command=(exe,args,options)=>{
    const result=command(exe,args,options);
    // The second observation follows sealLocalRemoval's baseline. Append a
    // real evidence claim for the same item during that final native read.
    if(prepared&&exe==='/usr/sbin/lsof'&&++reads===2&&changed<changes){
      const evidence=path.join(f.scratch,`late-claim-${++changed}.txt`);
      fs.writeFileSync(evidence,'late preservation input');
      f.append(claim?claim(f,evidence):[{type:'note.added',id:'ENG-1',text:'late evidence',evidence:[evidence]}]);
    }
    return result;
  };
  const entry=()=>currentCloseoutEntries(f.common,f.org,events(f))[0];
  const turn=()=>runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,
    guard:()=>{},measure:()=>{},reconcileReports:false,maxSteps:1,
    cli:(_file,argv)=>argv[0]==='refresh'?'{}':JSON.stringify(f.drain({
      keys:JSON.parse(argv[argv.indexOf('--keys')+1]),retrySafe:true,
      sessionsOnly:argv.includes('--sessions-only')}))});
  return{f,entry,turn,preparations,changed:()=>changed};
}

const auditRow=f=>({type:'supervisor.exception-disposition',
  evidence:{audit:path.join(f.org,'line-service/passes.jsonl'),
    incident:{boundary:'dispatch:ENG-unrelated',scope:{subject:'ENG-unrelated'},reason:'held ready item'}}});

test('unrelated supervisor audit batches do not waste a preservation preparation',t=>{
  const {f,turn,preparations,changed}=changingClaim(t,{claim:f=>Array.from({length:8},()=>auditRow(f))});
  turn();assert.equal(changed(),1);assert.equal(preparations.length,1);
  assert.equal(evaluations(f).at(-1).completed,true);
  assert.equal(fs.existsSync(f.lane),false);
  assert.equal(effects(f).filter(e=>e.action==='worktree-removed').length,1);
});

for(const kind of ['lane-path','item','run','extra-claim','unknown','unknown-evidence'])
test(`a real ${kind} claim still refuses removal and recovers on fresh preparation`,t=>{
  const {f,turn,preparations}=changingClaim(t,{claim:(f,evidence)=>{
    const row=auditRow(f);
    if(kind==='lane-path')row.evidence.audit=path.join(f.lane,'output.txt');
    if(kind==='item')row.item='ENG-1';
    if(kind==='run')row.run='R-1';
    if(kind==='extra-claim')row.artifacts=['./output.txt'];
    if(kind==='unknown')row.type='future.claim';
    if(kind==='unknown-evidence')row.evidence.path='./output.txt';
    return[row];
  }});
  turn();assert.equal(evaluations(f).at(-1).reason,reason);
  assert.equal(fs.existsSync(f.lane),true);
  assert.equal(effects(f).some(e=>e.action==='git-removal-started'),false);
  turn();assert.equal(evaluations(f).at(-1).completed,true);
  assert.equal(preparations.length,2);assert.equal(fs.existsSync(f.lane),false);
});

for(const historical of [false,true])test(`${historical?'historical':'current'} preservation claim change is prepared again by the finite owning closer`,t=>{
  const {f,entry,turn,preparations,changed}=changingClaim(t);
  turn();const first=evaluations(f).at(-1),target=entry();
  assert.equal(changed(),1);assert.equal(first.completed,false);assert.equal(first.reason,reason);
  assert.equal(first.condition.kind,'pre-effect-change');assert.equal(first.waiting.next,'pre-effect-observation');
  assert.equal(fs.existsSync(f.lane),true);
  assert.equal(effects(f).some(e=>e.action==='git-removal-started'),false,'rejected claim sent no Git removal');
  assert.equal(effects(f).filter(e=>e.action==='lane-evidence-discarded').length,1);
  if(historical){
    const old={...first,condition:{...first.condition,kind:'safety-hold',owner:'R-1',continuation:{kind:'owner-evidence',owner:'R-1'}}};
    delete old.seq;delete old.at;
    const [saved]=f.append([old]);
    f.append([{type:'closeout.waiting',identity:f.common,key:target.key,run:target.run,item:target.item,
      source:target.source,revision:saved.revision,wait_id:closeoutWaitId(target,saved),
      waiting:{owner:'line-service',defect:`No existing completion writer for this exact wait: ${reason}`,producers:[]}}]);
  }
  const preserved=events(f),result=turn();
  assert.equal(result.steps,1);assert.equal(result.decisions.attempted,0);
  assert.equal(evaluations(f).at(-1).completed,true,JSON.stringify(result));
  assert.equal(preparations.length,2,'next bounded turn prepared a fresh preservation bundle');
  assert.notEqual(preparations[0].evidence.directory,preparations[1].evidence.directory);
  assert.ok(fs.existsSync(preparations[1].evidence.manifest));
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(f.read().workspaces,[]);
  assert.deepEqual(events(f).slice(0,preserved.length),preserved,'original claim refusal and wait remain immutable');
  assert.equal([...fold(events(f)).items.values()].some(i=>i.role==='decision'),false);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);
  assert.equal(f.read().actions.filter(a=>a[0]==='tab'&&a[1]==='close').length,1);
  assert.equal(effects(f).filter(e=>e.action==='worktree-removed').length,1);
  assert.equal(effects(f).filter(e=>e.action==='branch-removed').length,1);
});

test('continued preservation claim changes yield bounded turns and recover after churn ends',t=>{
  const {f,turn,preparations,changed}=changingClaim(t,{changes:2});
  for(let n=1;n<=2;n++){
    const result=turn();assert.equal(result.steps,1);assert.equal(result.decisions.attempted,0);
    assert.equal(changed(),n);assert.equal(preparations.length,n);
    assert.equal(evaluations(f).at(-1).reason,reason);assert.equal(fs.existsSync(f.lane),true);
    assert.equal(effects(f).some(e=>e.action==='git-removal-started'),false);
  }
  turn();assert.equal(preparations.length,3);assert.equal(evaluations(f).at(-1).completed,true);
  assert.equal(fs.existsSync(f.lane),false);
  assert.equal(events(f).some(e=>e.type==='item.added'&&e.role==='decision'),false);
});

test('fresh preparation keeps unsaved work after a changed preservation claim',t=>{
  const {f,turn,preparations}=changingClaim(t);turn();
  const file=path.join(f.lane,'unsaved.txt');fs.writeFileSync(file,'keep this work');
  const result=turn();assert.equal(result.decisions.attempted,0);
  assert.equal(evaluations(f).at(-1).completed,false);
  assert.equal(fs.readFileSync(file,'utf8'),'keep this work');
  assert.equal(preparations.length,1,'fresh cleanliness guard stopped before preservation');
  assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.equal(effects(f).some(e=>e.action==='git-removal-started'),false);
});

test('only the exact claim-change keep can reopen a historical hold, with refusals and UNKNOWN effects still fenced',()=>{
  const entry={common:'/git',key:'key',run:'R-1',source:{seq:1,type:'cleanup.bound'}};
  const prior={completed:false,reason,condition:{kind:'safety-hold',continuation:{kind:'owner-evidence'}}};
  assert.equal(preEffectCloseout(entry,prior,[]),true);
  assert.equal(preEffectCloseout(entry,prior,[],{uncertain:true}),false);
  for(const changed of ['preservation source record changed; prepare again; lane kept',`${reason}; STOP`,
    'original report allocation/current run/claim changed; keep'])
    assert.equal(preEffectCloseout(entry,{...prior,reason:changed},[]),false);
  const refused={...prior,failure:{kind:'fence',code:'NATIVE_REFUSAL'}};
  assert.equal(preEffectCloseout(entry,refused,[]),false);
  assert.equal(closeoutCondition(entry,{reason},[],{uncertain:true}).kind,'uncertain-invocation');
  const intent={type:'closeout.effect',identity:entry.common,key:entry.key,source:entry.source,effect:'original',
    outcome:{action:'agent-exit-requested'}};
  assert.equal(closeoutNextStage(entry,prior,[intent]),undefined);
  const fence={type:'closeout.command-failed',identity:entry.common,key:entry.key,source:entry.source,
    failure:{kind:'fence',code:'EPERM'}};
  assert.equal(closeoutNextStage(entry,prior,[fence]),undefined);
});
