import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,effects,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {runCloseoutTurn,CLOSEOUT_TURN_BUDGET_MS} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';

function unbound(t,{merged=true,shell=false}={}){
  const f=setup(t,{direct:true,bound:true,merged});selectCurrentCleanup(f);
  fs.writeFileSync(f.eventFile,events(f).filter(e=>e.type!=='run.session_bound').map(e=>JSON.stringify(e)+'\n').join(''));
  f.state.agents=[];
  if(shell){f.state.info.process_tree=[f.state.info.process_tree[0]];f.state.info.foreground_processes=[{pid:1,name:'zsh'}];
    f.state.panes[0].foreground_cwd=f.lane;}
  else{f.state.tabs=[];f.state.panes=[];}
  f.save();f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];assert.deepEqual(entry.panes,[]);
  return{...f,entry,drain:()=>f.drain({keys:[entry.key],retrySafe:true})};
}

for(const shell of [false,true])for(const merged of [false,true])test(`unbound finished allocation removes its clean folder (shell=${shell}, merged=${merged}) without inventing a session`,t=>{
  const f=unbound(t,{merged,shell}),before=fs.readFileSync(f.eventFile);
  const row=f.drain().evaluated[0];assert.equal(row.completed,true,JSON.stringify(row));
  assert.equal(row.resources.session.status,'unbound');assert.equal(row.resources.session.completion,'UNKNOWN');
  assert.equal(fs.existsSync(f.lane),false);
  assert.equal(Boolean(f.git(['branch','--list','lane/topic'])),!merged);
  assert.equal(events(f).some(e=>e.type==='run.session_bound'),false);
  assert.equal(effects(f).some(e=>e.action==='agent-exit-requested'),false);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});

for(const kind of ['occupant','dirty','replaced-pane','UNKNOWN','refusal','claim','HOLD'])test(`unbound physical disposal preserves ${kind}`,t=>{
  const f=unbound(t,{shell:kind==='replaced-pane'});
  if(kind==='occupant'){f.state.agents=[{name:'worker',cwd:f.lane,agent_status:'idle'}];f.save();}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'unique');
  if(kind==='replaced-pane'){f.state.panes[0].terminal_id='replacement';f.save();}
  if(kind==='UNKNOWN')f.append([{type:'closeout.effect',identity:f.common,key:f.entry.key,source:f.entry.source,
    effect:'original',producer:'native-closeout/v2',outcome:{action:'shell-close-requested',tab_id:'w:t',panes:[{pane:'w:p',terminal:'term'}]}}]);
  if(kind==='refusal')f.append([{type:'closeout.evaluated',identity:f.common,key:f.entry.key,source:f.entry.source,
    run:'R-1',reason:'EPERM native refusal',completed:false}]);
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true}}]);
  if(kind==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  const before=fs.readFileSync(f.eventFile),calls=f.herdrCalls();f.drain();
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  if(['UNKNOWN','refusal'].includes(kind))assert.deepEqual(f.herdrCalls(),calls);
});

test('an old missing-identity evaluation gets physical disposition without replacing its source',t=>{
  const f=unbound(t);f.append([{type:'closeout.evaluated',identity:f.common,key:f.entry.key,source:f.entry.source,run:'R-1',
    reason:'original native session identity missing; keep allocation for original binding producer',completed:false,revision:f.entry.source.seq}]);
  assert.equal(f.drain().evaluated[0].completed,true);assert.equal(fs.existsSync(f.lane),false);
  assert.equal(events(f).some(e=>e.type==='cleanup.bound'),false);
});

test('a late target receives a fresh finite removal allowance on the next turn',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const lane=f.lane+'-second';f.git(['worktree','add','-qb','lane/second',lane,f.head]);
  f.append([{type:'item.added',id:'ENG-2',role:'engineer',title:'second'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:lane,meta:{lane:'second'}}]);
  f.append([{type:'report.ingested',run:'R-2',sha256:'second',report:{outcome:'done'}}]);
  let clock=0;const seen=[];
  const args={project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},clock:()=>clock,now:()=>1000000+clock,
    cli:(_file,argv)=>{
      if(argv[0]==='refresh')return '{}';
      const allowance=Number(argv[argv.indexOf('--deadline')+1])-(1000000+clock);
      // Preserve a short tail that cannot admit another target in this turn.
      seen.push({key:JSON.parse(argv[argv.indexOf('--keys')+1])[0],allowance});clock+=CLOSEOUT_TURN_BUDGET_MS-16000;
      return '{"evaluated":[]}';
    }};
  const first=runCloseoutTurn(args);assert.equal(first.steps,1);assert.equal(first.continuation.closeout,1);
  runCloseoutTurn(args);assert.equal(seen.length,2);assert.notEqual(seen[0].key,seen[1].key);
  assert.ok(seen.every(s=>s.allowance===CLOSEOUT_TURN_BUDGET_MS));
});
