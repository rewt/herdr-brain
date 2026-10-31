import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {captureReads} from '../lib/record-observation.mjs';
import {gitProject} from '../lib/project.mjs';
import {bindCloseoutSources,currentCloseoutEntries,unresolvedCloseoutEffect} from '../lib/closeout.mjs';
import {closeoutNextStage} from '../lib/closeout-status.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {refreshCloseouts} from '../lib/closeout-consumer.mjs';
import {closeoutCondition,preEffectCloseout,recordedCloseoutRefusal} from '../lib/closeout-facts.mjs';
import {sealRemovalInputs} from '../lib/retire-local.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {setup,events,evaluations,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

const entry=f=>currentCloseoutEntries(f.common,f.org,events(f))[0];
const drain=f=>f.drain({keys:[entry(f).key],retrySafe:true});
const latest=f=>evaluations(f).findLast(e=>e.key===entry(f).key);

test('named pre-effect keeps ignore safety keywords in paths branches and occupant names',()=>{
  const target={run:'R-1',common:'/git',key:'target',source:{seq:1,type:'cleanup.bound'}};
  for(const word of ['STOP','hold','ownership','claim','source binding','generation','identity','preservation','evidence-changed','archive-changed']){
    const name=`lane/topic-${word}-fix`,file=`/project/${name}/index.lock`;
    for(const [reason,kind] of [
      [`removal preflight input changed: ${file}; prepare and observe again; lane kept`,'pre-effect-change'],
      [`locked: ${file}; owner is live or unknown`,'contention'],
      [`locked: ${file}; inspect owner.json and surviving processes before removing a stale lock`,'contention'],
      [`locked Git metadata refs/heads/${name}.lock`,'contention'],
      [`process cwd reference ${file}`,'active-process'],
      [`settle callback reference ${name}`,'active-process'],
      [`watcher callback reference ${name}`,'active-process'],
      [`occupant ${name} is working`,'active-process'],
    ]){
      const condition=closeoutCondition(target,{reason},[]),prior={completed:false,reason,condition};
      assert.equal(condition.kind,kind,reason);assert.equal(condition.owner,'lane-closeout',reason);
      assert.equal(condition.continuation.kind,'pre-effect-observation',reason);
      assert.equal(preEffectCloseout(target,prior,[]),true,reason);
      assert.deepEqual(closeoutNextStage(target,prior,[]),{stage:'pre-effect-observation',ready:true},reason);
    }
  }
});

test('named pre-effect formats preserve real fences uncertainty and historical safety holds',()=>{
  const target={run:'R-1',common:'/git',key:'target',source:{seq:1,type:'cleanup.bound'}};
  for(const reason of [
    'STOP/HOLD prevents queued retirement effect',
    'preservation claim inputs changed; prepare again; lane kept',
    'original report allocation/current run/claim changed; keep',
    'occupant or shell identity changed during agent exit',
    'source binding changed: locked Git metadata refs/heads/lane/topic.lock',
    'preservation evidence changed: removal preflight input changed: /project/index',
    'locked: /project/index; STOP/HOLD prevents queued retirement effect',
    'process cwd reference /project; preservation claim changed',
  ]){
    const condition=closeoutCondition(target,{reason},[]);
    assert.equal(condition.kind,'safety-hold',reason);assert.equal(condition.continuation.kind,'owner-evidence',reason);
    assert.equal(preEffectCloseout(target,{completed:false,reason,condition},[]),false,reason);
  }
  const reason='removal preflight input changed: /project/identity; prepare and observe again; lane kept';
  assert.equal(closeoutCondition(target,{reason,failure:{kind:'fence',code:'NATIVE_REFUSAL'}},[]).kind,'native-refusal');
  assert.equal(closeoutCondition(target,{reason},[],{uncertain:true}).kind,'uncertain-invocation');
  assert.equal(preEffectCloseout(target,{completed:false,reason,condition:{kind:'safety-hold'}},[]),false,
    'a new classifier must not reopen an existing typed hold');
});

test('real removal input seal with a safety word in its path remains eligible for fresh observation',t=>{
  const f=setup(t,{direct:true,bound:true}),file=path.join(f.scratch,'identity-claim-HOLD-input');
  fs.writeFileSync(file,'original');const verify=sealRemovalInputs([file]);fs.writeFileSync(file,'changed bytes');
  assert.throws(verify,error=>{
    const target={run:'R-1',common:f.common,key:'target',source:{seq:1,type:'cleanup.bound'}};
    const condition=closeoutCondition(target,{reason:error.message},[]);
    assert.equal(condition.kind,'pre-effect-change');
    assert.equal(preEffectCloseout(target,{completed:false,reason:error.message,condition},[]),true);
    return true;
  });
});

test('late binding keeps original finality age and names the uncertain effect footprint',()=>{
  const entry={run:'R-1',common:'/git',key:'target',source:{seq:9,type:'cleanup.bound'}},
    events=[{type:'report.ingested',run:'R-1',seq:4,at:'2026-01-01T00:00:00Z'},
      {type:'cleanup.bound',seq:9,at:'2026-01-01T01:00:00Z'},
      {type:'closeout.effect',seq:10,identity:entry.common,key:entry.key,source:entry.source,effect:'original',outcome:{action:'git-removal-started',operation:'branch'}}];
  const condition=closeoutCondition(entry,{reason:'original command returned without completion'},events,{uncertain:true});
  assert.equal(condition.first_seen,events[0].at);assert.deepEqual(condition.resources,['branch']);
  assert.deepEqual(condition.evidence.intent,{effect:'original',seq:10,action:'git-removal-started'});
  assert.equal(condition.continuation.kind,'owner-evidence');
});

test('negated report prose grants no refusal; independent session folder and unlanded branch receipts survive restart',t=>{
  const f=setup(t,{direct:true,bound:true});
  f.append([{type:'report.ingested',run:'R-1',sha256:'fixture',report:{outcome:'blocked',
    summary:'No native refusal; not EPERM or EACCES. No shell/native mismatch.'}}]);
  const row=drain(f).evaluated[0];assert.equal(row.completed,true,JSON.stringify(row));
  assert.equal(row.resources.session.status,'closed');assert.equal(row.resources.folder.status,'removed');
  assert.equal(row.resources.branch.status,'retained');assert.equal(row.resources.branch.head,f.head);
  assert.equal(row.resources.author_packet.status,'preserved');assert.ok(fs.existsSync(row.resources.author_packet.packet));
  assert.equal(f.git(['rev-parse','refs/heads/lane/topic']),f.head);
  const actions=f.read().actions,before=events(f);drain(f);assert.deepEqual(events(f),before);assert.deepEqual(f.read().actions,actions);
});

test('dirty report folder retains exact bytes after closing its verified session and progresses only from fresh guards',t=>{
  const f=setup(t,{direct:true,bound:true});f.report();
  const dirty=path.join(f.lane,'unsaved');fs.writeFileSync(dirty,'irreplaceable draft\n');
  const first=drain(f).evaluated[0];assert.equal(first.completed,false);assert.equal(first.condition.kind,'dirty-work');
  assert.equal(first.resources.session.status,'closed');assert.equal(first.resources.folder.status,'kept');
  assert.equal(fs.readFileSync(dirty,'utf8'),'irreplaceable draft\n');assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.equal(first.failure,undefined);assert.equal(first.condition.continuation.kind,'pre-effect-observation');
  const count=events(f).filter(e=>e.type==='closeout.evaluated').length,actions=f.read().actions;
  drain(f);assert.equal(events(f).filter(e=>e.type==='closeout.evaluated').length,count,'unchanged keep deduplicates');
  // Fixture owner preserves its draft outside the disposable lane before release.
  fs.renameSync(dirty,path.join(f.scratch,'saved-draft'));
  assert.equal(drain(f).evaluated[0].completed,true);
  assert.deepEqual(f.read().actions.filter(a=>a[0]!=='workspace'),actions,'no duplicate exit/tab close');
});

for(const obstruction of ['cwd','lock'])test(`pre-effect ${obstruction} release admits one guarded finite continuation`,t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();let release,blocked=true;
  const command=f.options.command;
  if(obstruction==='lock')release=acquireLock(path.join(f.common,'lane-promote.lock'));
  else f.options.command=(exe,args,options)=>exe==='/usr/sbin/lsof'&&blocked?
    {status:0,stderr:'',stdout:`p${process.pid}\0n${f.repo}\0\np99999\0n${f.lane}\0\n`}:command(exe,args,options);
  try{const row=drain(f).evaluated[0];assert.equal(row.completed,false);assert.equal(row.condition.kind,obstruction==='lock'?'contention':'active-process');
    assert.equal(row.failure,undefined);assert.equal(closeoutNextStage(entry(f),row,events(f)).ready,true);}
  finally{release?.();blocked=false;}
  assert.equal(drain(f).evaluated[0].completed,true);assert.equal(fs.existsSync(f.lane),false);
});

test('new refusal facts require structured fences even when reasons quote permission errors',()=>{
  const target={run:'R-1',common:'/git',key:'target',source:{seq:1,type:'cleanup.bound'}};
  for(const text of ['EPERM','EACCES','native refusal','Permission denied','operation not permitted','original native refusal']){
    const reason=`removal preflight input changed: /project/${text}; prepare and observe again; lane kept`;
    for(const failure of [undefined,{kind:'unknown',code:'OUTCOME_UNKNOWN'}]){
      const condition=closeoutCondition(target,{reason,failure},[]);
      assert.equal(condition.kind,'pre-effect-change',reason);
      const row={type:'closeout.evaluated',identity:target.common,key:target.key,source:target.source,completed:false,reason,failure,condition};
      assert.equal(recordedCloseoutRefusal(target,[row]),undefined,reason);
      assert.equal(preEffectCloseout(target,row,[row]),true,reason);
      assert.equal(closeoutCondition(target,{reason,failure},[],{uncertain:true}).kind,'uncertain-invocation',reason);
    }
    assert.equal(closeoutCondition(target,{reason,failure:{kind:'fence',code:'NATIVE_REFUSAL'}},[]).kind,'native-refusal',reason);
  }
});

test('successful adapter results quoting permission errors do not create a refusal or stop cleanup',t=>{
  const f=setup(t,{direct:true,bound:true});f.report();const log=f.options.log;
  // Add diagnostic prose to the returned result after its exact completion was
  // journaled. It cannot override that receipt or invent a structured refusal.
  f.options.log=row=>{log(row);if(row.action==='closed'&&row.tab_id)row.why='No native refusal: not EPERM, EACCES, Permission denied or operation not permitted';};
  const row=drain(f).evaluated[0];assert.equal(row.completed,true,JSON.stringify(row));
  assert.equal(row.condition,undefined);assert.equal(row.failure,undefined);
  assert.equal(row.resources.session.status,'closed');assert.equal(row.resources.folder.status,'removed');
  assert.equal(row.resources.branch.status,'retained');assert.equal(f.git(['rev-parse','lane/topic']),f.head);
  assert.equal(recordedCloseoutRefusal(entry(f),events(f)),undefined);
  const before=events(f),actions=f.read().actions;drain(f);
  assert.deepEqual(events(f),before);assert.deepEqual(f.read().actions,actions);
});

test('structured native refusal and historical ambiguity stay held without new reads or erased evidence',t=>{
  for(const legacy of [false,'untyped','typed']){
    const f=setup(t,{direct:true,bound:true});f.report();const e=entry(f);
    f.append([{type:'closeout.evaluated',key:e.key,identity:f.common,run:e.run,item:e.item,source:e.source,revision:e.source.seq,
      completed:false,reason:legacy?'original native refusal remains held; explicit owner clearing evidence required':'native command refused',
      ...(!legacy?{failure:{code:'NATIVE_REFUSAL',kind:'fence'}}:{}),
      ...(legacy==='typed'?{condition:{kind:'legacy-refusal',resources:['session']}}:{})}]);
    const before=events(f),calls=f.herdrCalls();assert.deepEqual(drain(f).evaluated,[]);assert.deepEqual(f.herdrCalls(),calls);
    assert.deepEqual(events(f).slice(0,before.length),before);assert.equal(fs.existsSync(f.lane),true);
  }
});

for(const change of ['session','STOP','HOLD','generation','preservation','missing-session'])test(`typed closeout keeps ${change} at its actual boundary`,t=>{
  const f=setup(t,{direct:true,bound:true});f.report();
  if(change==='session'){f.state.agents[0].agent_session.value='replacement';f.save();}
  if(change==='STOP'||change==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor',change==='HOLD'?'HOLD-WORKER-TAB-CLOSE':change),{recursive:true});
  if(change==='generation')f.git(['reflog','expire','--expire=all','refs/heads/lane/topic']);
  if(change==='missing-session'){
    const original=events(f);original.find(e=>e.type==='report.ingested').closeout_targets[0].panes=[];
    fs.writeFileSync(f.eventFile,original.map(e=>JSON.stringify(e)+'\n').join(''));
  }
  if(change==='preservation'){
    const log=f.options.log;f.options.log=row=>{log(row);if(row.action==='lane-preflight')fs.writeFileSync(path.join(row.evidence.directory,'sha256.json'),'lost');};
  }
  const row=drain(f).evaluated[0];assert.equal(row.completed,false,JSON.stringify(row));
  assert.equal(fs.existsSync(f.lane),true);assert.equal(effects(f).some(e=>e.action==='worktree-removed'),false);
  if(change!=='preservation')assert.deepEqual(f.read().actions,[]);
  assert.equal(row.resources.folder.status,'kept');
});

test('new UNKNOWN intent accepts only its exact linked completion and performs zero reads or resends',t=>{
  const f=setup(t,{direct:true,bound:true});f.report();const command=f.options.command;
  f.options.command=(exe,args,options)=>exe===f.job.herdr&&args[0]==='agent'&&args[1]==='prompt'?
    {status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:'lost original reply'}:command(exe,args,options);
  drain(f);const e=entry(f),before=events(f),start=before.find(e=>e.type==='closeout.effect'&&e.outcome.action==='agent-exit-requested');
  assert.equal(start.producer,'native-closeout/v2');assert.ok(unresolvedCloseoutEffect(e,before));
  const calls=f.herdrCalls(),actions=f.read().actions;let native=0;
  f.options.command=(exe,args,options)=>{if(exe===f.job.herdr)native++;assert.equal(args.includes('kill'),false);return command(exe,args,options);};
  const completion={type:'closeout.effect',key:e.key,identity:f.common,source:e.source,effect:'foreign-completion',
    outcome:{action:'exit-observed',pane:'w:p',occupant:{terminal_id:'term',agent_session_id:'session'}}};
  f.append([completion]);assert.ok(unresolvedCloseoutEffect(e,events(f)),'unlinked absence/receipt cannot settle intent');
  for(let i=0;i<3;i++)assert.deepEqual(drain(f).evaluated,[]);
  assert.equal(native,0);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,actions);
  assert.deepEqual(events(f).slice(0,before.length),before);
  const linked={...completion,intent:start.effect,effect:'original-completion'};f.append([linked]);
  assert.equal(unresolvedCloseoutEffect(e,events(f)),undefined,'exact original completion is admitted');
});

test('semantic binding observation ignores unrelated main index/config activity but rejects exact target movement',t=>{
  const f=setup(t,{direct:true,bound:true});
  const source={type:'report.ingested',run:'R-1',sha256:'fixture',report:{outcome:'done'}};
  const prepared=captureReads(()=>bindCloseoutSources({cwd:f.repo,org:f.org,events:events(f),mutation:{add:[source]}}));
  assert.equal(prepared.value.add[0].closeout_targets.length,1);
  f.git(['update-index','--index-version','4']);f.git(['config','color.ui','false']);
  assert.doesNotThrow(prepared.validate);
  f.git(['commit','--allow-empty','-m','replacement head'],f.lane);assert.throws(prepared.validate,/observation.*conflict/i);
});

test('removal ignores unrelated canonical index lock and config while retaining effective policy guards',t=>{
  for(const relevant of [false,true]){
    const f=setup(t,{direct:true,bound:true,merged:true});f.report();const log=f.options.log,command=f.options.command;let prepared=false,changed=false;
    f.options.log=row=>{log(row);if(row.action==='lane-preflight')prepared=true;};
    f.options.command=(exe,args,options)=>{
      if(prepared&&!changed&&exe==='git'&&fs.existsSync(path.join(f.common,'lane-promote.lock'))){
        changed=true;fs.writeFileSync(path.join(f.common,'index.lock'),'unrelated main index writer');
        f.git(['config',relevant?'core.filemode':'color.ui',relevant?'false':'false']);
      }
      return command(exe,args,options);
    };
    const row=drain(f).evaluated[0];assert.equal(changed,true);
    assert.equal(row.completed,!relevant,JSON.stringify(row));assert.equal(fs.existsSync(f.lane),relevant);
    assert.equal(fs.readFileSync(path.join(f.common,'index.lock'),'utf8'),'unrelated main index writer');
  }
});

test('original tab-close completion recovers partial effects without a duplicate exit or close',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();const command=f.options.command;let lost=true,atSend;
  f.options.command=(exe,args,options)=>{
    const result=command(exe,args,options);
    if(lost&&exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close'){lost=false;atSend=f.herdrCalls().length;return{status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:'lost tab completion'};}
    return result;
  };
  drain(f);const e=entry(f),start=events(f).findLast(e=>e.type==='closeout.effect'&&e.outcome.action==='shell-close-requested');
  assert.equal(f.herdrCalls().length,atSend,'no same-turn readback after the producer lost its reply');
  assert.ok(unresolvedCloseoutEffect(e,events(f)));const before=f.read().actions,calls=f.herdrCalls();
  // Reconciliation does not reobserve an already-bound original UNKNOWN.
  selectCurrentCleanup(f);refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  assert.deepEqual(f.herdrCalls(),calls);
  assert.deepEqual(drain(f).evaluated,[]);assert.deepEqual(f.read().actions,before);
  f.append([{type:'closeout.effect',identity:f.common,key:e.key,run:e.run,item:e.item,source:e.source,intent:start.effect,
    effect:'original-tab-completion',outcome:{action:'closed',tab_id:start.outcome.tab_id}}]);
  assert.equal(drain(f).evaluated[0].completed,true);
  assert.deepEqual(f.read().actions.filter(a=>a[0]!=='workspace'),before);
  assert.equal(fs.existsSync(f.lane),false);
});

test('actual structured tab refusal remains scoped and held after its producer returns',t=>{
  const f=setup(t,{direct:true,bound:true});f.report();const command=f.options.command;
  f.options.command=(exe,args,options)=>exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close'?
    {status:1,stdout:'',stderr:JSON.stringify({error:{code:'NATIVE_REFUSAL',message:'original native permission required'}})}:command(exe,args,options);
  const row=drain(f).evaluated[0];assert.equal(row.condition.kind,'native-refusal');assert.equal(row.failure.code,'NATIVE_REFUSAL');
  assert.deepEqual(row.condition.resources,['session']);assert.ok(row.resources.session.evidence.intent.effect);
  const calls=f.herdrCalls(),actions=f.read().actions,before=events(f);
  assert.deepEqual(drain(f).evaluated,[]);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,actions);
  assert.deepEqual(events(f).slice(0,before.length),before);assert.equal(fs.existsSync(f.lane),true);
});

test('unchanged keeps yield one grouped supervisor alarm without per-pass decisions or effect retry',t=>{
  const f=setup(t,{direct:true,bound:true}),binding=selectCurrentCleanup(f);f.report();
  f.state.agents[0].agent_status='working';f.save();
  const args={project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,cli:(_file,argv)=>argv[0]==='refresh'?'{}':JSON.stringify(drain(f))};
  for(let i=0;i<4;i++)runCloseoutTurn(args);
  const log=fs.readFileSync(path.join(binding.directory,'closeout.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.filter(e=>e.action==='closeout-supervisor-alarm').length,1);
  assert.equal(log.find(e=>e.action==='closeout-supervisor-alarm').count,1);
  assert.equal(events(f).some(e=>e.type==='item.added'&&e.role==='decision'),false);
  assert.deepEqual(f.read().actions,[]);
});
