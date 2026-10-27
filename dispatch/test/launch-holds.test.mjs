import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture,promptCalls,RECORD} from './dispatch-fixture.mjs';
import {makeFixture,ignoreLaneState,openLane,writeFakeHerdr,lane,git} from '../../lanes/test/lane-fixture.mjs';
import {bundleRelease} from '../../lib/releases.mjs';
import {launchDigest} from '../launch-guard.mjs';

const addParent=(f)=>{
  const ancestor=f.rec(['add','Ancestor','--goal']).match(/G-\d+/)[0];
  const parent=f.rec(['add','Parent','--goal','--parent',ancestor]).match(/G-\d+/)[0];
  f.rec(['set',f.item,`parent=${parent}`]);
  return {ancestor,parent,item:f.item};
};
function inject(f,script,marker,commands){
  const file=path.join(f.root,'bin',script),source=fs.readFileSync(file,'utf8');
  assert.ok(source.includes(marker),marker);
  const mutation=commands.map(args=>`{
    const changed=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...${JSON.stringify(args)}],{encoding:'utf8'});
    if(changed.status!==0)throw Error(changed.stderr);
  }`).join('\n');
  const injection=script==='lane'?`if(a[0]==='prepare'){\n${mutation}\n}`:mutation;
  fs.writeFileSync(file,source.replace(marker,marker+'\n'+injection));
}
const effects=f=>f.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch');

for(const [subject,field]of [['item','meta.hold=true'],['parent','meta.held=true'],['ancestor','meta.reserved=true']]){
  test(`prepared dispatch rechecks a real ${subject} ${field} before native launch`,t=>{
    const f=fixture(t),ids=addParent(f);
    inject(f,'lane',"if(a[0]==='prepare' && !entry()) process.exit(1);",[['set',ids[subject],field]]);
    const result=f.start();
    assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/closed\/held\/reserved/);
    assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='prepare').length,1);
    assert.equal(effects(f).length,0);assert.equal(promptCalls(f).length,0);
    const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
    assert.equal(job.failure.code,'DISPATCH_INPUT_CHANGED');
    assert.equal(job.failure.launch_input.subject,ids[subject]);assert.equal(job.native_launch_attempted,false);
    assert.equal(f.jobs().length,1);
  });
}

for(const [subject,args]of [['item',id=>['set',id,'meta.operator_reserved=true']],['parent',id=>['close',id]],['ancestor',id=>['set',id,'meta.hold=true']]]){
  test(`watched dispatch retains its original worker when ${subject} changes before prompt`,t=>{
    const f=fixture(t),ids=addParent(f);
    inject(f,'watch',"} else if(type==='watch') {",[args(ids[subject])]);
    const result=f.start();assert.equal(result.status,1,result.stderr);
    assert.equal(effects(f).length,1);assert.equal(promptCalls(f).length,0);
    const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
    assert.equal(job.failure.code,'DISPATCH_INPUT_CHANGED');assert.equal(job.failure.launch_input.subject,ids[subject]);
    assert.ok(job.worker.agentName);assert.ok(job.watcher.pid);assert.equal(job.to,job.worker.agentName);
    assert.equal(f.show(job.run).meta.agent,job.worker.agentName);assert.equal(job.native_launch_attempted,true);
    assert.equal(f.jobs().length,1);
  });
}

test('the last prompt boundary catches an ancestor hold during the visible-screen read',t=>{
  const f=fixture(t),ids=addParent(f);
  inject(f,'herdr',"if(a[0]==='pane' && a[1]==='read') {",[['set',ids.ancestor,'meta.hold=true']]);
  const result=f.start();assert.equal(result.status,1,result.stderr);
  assert.equal(effects(f).length,1);assert.equal(promptCalls(f).length,0);
  const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(job.failure.launch_input.subject,ids.ancestor);assert.ok(job.watcher.pid);
});

test('unrelated record holds and routine evidence do not invalidate the admitted original prompt',t=>{
  const f=fixture(t);addParent(f);
  const other=f.rec(['add','Unrelated work','--role','engineer']).match(/ENG-\d+/)[0];
  inject(f,'watch',"} else if(type==='watch') {",[['set',other,'meta.hold=true'],['note',f.item,'Unrelated evidence arrived']]);
  const result=f.start();assert.equal(result.status,0,result.stderr);
  assert.equal(effects(f).length,1);assert.equal(promptCalls(f).length,1);assert.equal(f.jobs().length,1);
});

test('a fresh actual parent chain is followed after preparation, without holding unrelated work',t=>{
  const f=fixture(t),ids=addParent(f);
  const next=f.rec(['add','New held parent','--goal']).match(/G-\d+/)[0];
  f.rec(['set',next,'meta.hold=true']);
  inject(f,'lane',"if(a[0]==='prepare' && !entry()) process.exit(1);",[['set',ids.parent,`parent=${next}`]]);
  const result=f.start();assert.equal(result.status,1,result.stderr);assert.equal(effects(f).length,0);
  assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='prepare').length,1);
  assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).failure.launch_input.subject,next);
  const other=f.rec(['add','Independent launch','--role','engineer']).match(/ENG-\d+/)[0];
  const independent=f.dispatch([other,'--lane','topic','--route','engineer','--brief',f.brief]);
  assert.equal(independent.status,0,independent.stderr);assert.equal(promptCalls(f).length,1);
});

test('a superseding run after watcher preparation prevents the old prompt',t=>{
  const f=fixture(t);
  inject(f,'watch',"} else if(type==='watch') {",[['start',f.item,'--workspace',f.repo]]);
  const result=f.start();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/superseded/);
  assert.equal(effects(f).length,1);assert.equal(promptCalls(f).length,0);
});

function nativeFixture(t,{staleClaim=false}={}){
  const f=makeFixture({main:'main',validate:'true',routes:{engineer:{kind:'codex'}}});
  t.after(()=>f.cleanup());ignoreLaneState(f);
  const topic='launch-holds',workspace=openLane(f,topic),org=path.join(f.root,'org');
  f.env.ORG_DIR=org;
  const rec=args=>{
    const r=spawnSync(process.execPath,[RECORD,...args],{cwd:f.repo,env:f.env,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  rec(['init']);
  const ancestor=rec(['add','Actual ancestor','--goal']).match(/G-\d+/)[0];
  const item=rec(['add','Launch once','--role','engineer','--parent',ancestor]).match(/ENG-\d+/)[0];
  const journal=path.join(org,'dispatch','original.json'),common=git(f.repo,['rev-parse','--path-format=absolute','--git-common-dir']);
  fs.mkdirSync(path.dirname(journal));
  const token='original',run=rec(['start',item,'--route','engineer','--workspace',workspace,
    ...Object.entries({dispatch_journal:journal,dispatch_attempt:token,dispatch_project:common,dispatch_record:org}).flatMap(([k,v])=>['--meta',`${k}=${v}`])]).match(/^(R-\d+) started/m)[1];
  const claim=JSON.parse(rec(['claim',run,'--controller','brain']));
  const job={repo:f.repo,org,common,workspace,lane:topic,token,item,run,route:'engineer',declared:{harness:'codex',model:null,effort:null},
    release:bundleRelease(),ownership:{owner:claim.owner,generation:claim.generation},stage:'launching',native_launch_attempted:true};
  if(staleClaim)rec(['claim',run,'--controller','other','--transfer-from','brain','--why','Fixture transfer before the pending intent',
    '--expected-owner',JSON.stringify(job.ownership.owner),'--expected-generation',String(job.ownership.generation)]);
  const bytes=JSON.stringify(job);fs.writeFileSync(journal,bytes);
  const fake=writeFakeHerdr(f,{lanePath:workspace,branch:`lane/${topic}`,initiallyOpened:true});
  const dispatch=(prompt)=>lane(f,['dispatch',topic,'--route','engineer','--json','--dispatch-journal',journal,'--dispatch-sha256',launchDigest(bytes),...(prompt?['Deliver once']:[])]);
  const mutate=(marker,commands)=>{
    const file=path.join(f.bin,'herdr'),source=fs.readFileSync(file,'utf8');assert.ok(source.includes(marker));
    const body=commands.map(args=>`execFileSync(${JSON.stringify(process.execPath)},[${JSON.stringify(RECORD)},...${JSON.stringify(args)}],{env:process.env,stdio:'pipe'});`).join('\n');
    fs.writeFileSync(file,source.replace(marker,marker+'\n'+body));
  };
  return {f,rec,ancestor,item,run,job,journal,fake,dispatch,mutate};
}

for(const change of ['hold','close','reserved'])test(`native agent start rechecks an ancestor ${change} after shell setup`,t=>{
  const x=nativeFixture(t),args=change==='close'?['close',x.ancestor]:['set',x.ancestor,`meta.${change==='hold'?'hold':'reserved'}=true`];
  x.mutate('} else if (args[0] === "agent" && args[1] === "list") {',[args]);
  const result=x.dispatch();assert.equal(result.status,1,result.stderr);
  const receipt=JSON.parse(result.stdout);assert.equal(receipt.code,'DISPATCH_INPUT_CHANGED');
  assert.equal(receipt.launch_input.subject,x.ancestor);assert.equal(receipt.launch_input.run,x.run);
  assert.equal(x.fake.calls().filter(a=>a[0]==='agent'&&a[1]==='start').length,0);
  assert.equal(x.fake.calls().filter(a=>a[1]==='prompt').length,0);
  assert.equal(JSON.parse(fs.readFileSync(x.journal)).stage,'launching');
});

test('native launch refuses a stale captured claim before creating effects',t=>{
  const x=nativeFixture(t,{staleClaim:true});
  const result=x.dispatch();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/RUN_OWNED_ELSEWHERE/);
  assert.equal(x.fake.calls().filter(a=>a[1]==='start').length,0);
});

test('native launch refuses changed pending intent bytes without starting a replacement',t=>{
  const x=nativeFixture(t);fs.writeFileSync(x.journal,JSON.stringify({...x.job,token:'replacement'}));
  const result=x.dispatch();assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stdout).code,'DISPATCH_INPUT_CHANGED');assert.equal(x.fake.calls().length,0);
});

test('unrelated held work permits exactly one native start and direct prompt',t=>{
  const x=nativeFixture(t),other=x.rec(['add','Unrelated held item','--role','engineer']).match(/ENG-\d+/)[0];
  x.mutate('} else if (args[0] === "agent" && args[1] === "list") {',[['set',other,'meta.hold=true']]);
  const result=x.dispatch(true);assert.equal(result.status,0,result.stderr);
  assert.equal(x.fake.calls().filter(a=>a[1]==='start').length,1);assert.equal(x.fake.calls().filter(a=>a[1]==='prompt').length,1);
});

test('native start refusal keeps its original attempt without retry or adoption',t=>{
  const x=nativeFixture(t);x.f.env.FAKE_HERDR_START_FAIL='1';
  const result=x.dispatch();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/outcome UNKNOWN/);
  assert.equal(x.fake.calls().filter(a=>a[1]==='start').length,1);assert.equal(x.fake.calls().filter(a=>a[1]==='prompt').length,0);
});

test('direct prompt checks current ancestors again after the live hook screen',t=>{
  const x=nativeFixture(t);
  x.mutate('if (args[args.indexOf("--source") + 1] === "visible") {',[['set',x.ancestor,'meta.operator_reserved=true']]);
  const result=x.dispatch(true);assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stdout).code,'DISPATCH_INPUT_CHANGED');
  assert.equal(x.fake.calls().filter(a=>a[1]==='start').length,1);assert.equal(x.fake.calls().filter(a=>a[1]==='prompt').length,0);
});
