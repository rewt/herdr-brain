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
import {acquireLock} from '../lanes/promotion-lock.mjs';
import {setup,events,evaluations,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';

const entry=f=>currentCloseoutEntries(f.common,f.org,events(f))[0];
const drain=f=>f.drain({keys:[entry(f).key],retrySafe:true});
const latest=f=>evaluations(f).findLast(e=>e.key===entry(f).key);

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

test('structured native refusal and historical ambiguity stay held without new reads or erased evidence',t=>{
  for(const legacy of [false,true]){
    const f=setup(t,{direct:true,bound:true});f.report();const e=entry(f);
    f.append([{type:'closeout.evaluated',key:e.key,identity:f.common,run:e.run,item:e.item,source:e.source,revision:e.source.seq,
      completed:false,reason:legacy?'original native refusal remains held; explicit owner clearing evidence required':'native command refused',
      ...(!legacy?{failure:{code:'NATIVE_REFUSAL',kind:'fence'}}:{})}]);
    const before=events(f),calls=f.herdrCalls();assert.deepEqual(drain(f).evaluated,[]);assert.deepEqual(f.herdrCalls(),calls);
    assert.deepEqual(events(f).slice(0,before.length),before);assert.equal(fs.existsSync(f.lane),true);
  }
});

for(const change of ['session','STOP','HOLD','generation','preservation','missing-session'])test(`typed closeout keeps ${change} at its actual boundary`,t=>{
  const f=setup(t,{direct:true,bound:true});f.report();
  if(change==='session'){f.state.agents[0].agent_session.value='replacement';f.save();}
  if(change==='STOP'||change==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor',change),{recursive:true});
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
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();const command=f.options.command;let lost=true;
  f.options.command=(exe,args,options)=>{
    const result=command(exe,args,options);
    if(lost&&exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close'){lost=false;return{status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:'lost tab completion'};}
    return result;
  };
  drain(f);const e=entry(f),start=events(f).findLast(e=>e.type==='closeout.effect'&&e.outcome.action==='shell-close-requested');
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
