import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,promptCalls} from './dispatch-fixture.mjs';

const launches=f=>f.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch');
function correction(t,{author=false,merged=false,sameLane=false}={}) {
  const f=fixture(t),workspace=path.join(f.root,'author');
  const topic=sameLane?'topic':'author';
  let head;
  if(author) {
    f.git(['worktree','add','-b','lane/'+topic,workspace]);
    f.git(['commit','--allow-empty','-m','author source'],workspace);
    head=f.git(['rev-parse','HEAD'],workspace);
    if(merged)f.git(['merge','--ff-only',head]);
  }
  const run=f.rec(['start',f.item,'--workspace',author?workspace:f.repo,...(author?['--meta','lane='+topic]:[])]).match(/^(R-\d+) started/m)[1];
  const report=path.join(f.root,'blocked.md');
  fs.writeFileSync(report,`---\nrun: ${run}\noutcome: blocked\nsummary: Saved work needs a fresh fix\n---\n`);
  f.rec(['ingest',report]);
  return {...f,author:workspace,authorHead:head};
}
function inject(f,script,marker,body) {
  const file=path.join(f.root,'bin',script),source=fs.readFileSync(file,'utf8');
  assert.ok(source.includes(marker));fs.writeFileSync(file,source.replace(marker,marker+'\n'+body));
}
const advanceMain="git(['commit','--allow-empty','-m','concurrent main landing']);";
const job=f=>JSON.parse(fs.readFileSync(f.jobs()[0]));

test('fresh fix launches its frozen main commit while main advances during preparation',t=>{
  const f=correction(t),base=f.git(['rev-parse','HEAD']);
  inject(f,'lane',"if(a[0]==='prepare' && !entry()) process.exit(1);",`if(a[0]==='prepare'){${advanceMain}}`);
  const result=f.start();assert.equal(result.status,0,result.stderr);
  const saved=job(f);
  assert.equal(saved.correctionLaunchProtocol,1);
  assert.equal(saved.correction.ref,undefined);assert.equal(saved.base,base);
  assert.notEqual(f.git(['rev-parse','main']),base);
  assert.equal(f.git(['rev-parse','HEAD'],saved.workspace),base);
  assert.equal(saved.stage,'complete');assert.equal(saved.failure,undefined);
  assert.equal(launches(f).length,1);assert.equal(promptCalls(f).length,1);
  assert.equal(f.jobs().length,1);assert.ok(saved.watcher.pid);
});

for(const phase of ['prepare','launch','watch'])test(`fresh fix reuses a fully merged retained same-item lane while main advances during ${phase}`,t=>{
  const f=correction(t,{author:true,merged:true,sameLane:true});
  f.git(['commit','--allow-empty','-m','main ahead of retained author']);
  const base=f.git(['rev-parse','main']);
  const marker=phase==='prepare'?"if(a[0]==='prepare' && !entry()) process.exit(1);":phase==='launch'?"if(a[0]==='dispatch') {":"} else if(type==='watch') {";
  inject(f,phase==='watch'?'watch':'lane',marker,phase==='prepare'?`if(a[0]==='prepare'){${advanceMain}}`:advanceMain);
  const result=f.start(['--base','main']);assert.equal(result.status,0,result.stderr);
  const saved=job(f);
  assert.equal(saved.correction.ref,undefined,'a merged retained branch is main-based source');
  assert.equal(saved.correction.base,base);assert.equal(saved.base,base);
  assert.notEqual(f.authorHead,base);assert.notEqual(f.git(['rev-parse','main']),base);
  assert.equal(saved.workspace,f.author);assert.equal(f.git(['rev-parse','HEAD'],f.author),base);
  assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='open').length,0,'retain the existing allocation');
  assert.equal(saved.stage,'complete');assert.equal(saved.failure,undefined);
  assert.equal(launches(f).length,1);assert.equal(promptCalls(f).length,1);
  assert.equal(f.jobs().length,1);assert.ok(saved.watcher.pid);
});

for(const change of ['head','dirty','rewind'])test(`fresh main-based fix refuses changed ${change} before native launch`,t=>{
  const f=correction(t);
  f.git(['commit','--allow-empty','-m','integration before selection']);
  const mutation={
    head:"git(['-C',entry(),'commit','--allow-empty','-m','changed allocation']);",
    dirty:"fs.writeFileSync(path.join(entry(),'unsaved'),'changed allocation');",
    rewind:"git(['reset','--hard','HEAD^']);",
  }[change];
  inject(f,'lane',"if(a[0]==='prepare' && !entry()) process.exit(1);",`if(a[0]==='prepare'){${mutation}}`);
  const result=f.start();assert.equal(result.status,1,result.stderr);
  const saved=job(f);
  assert.equal(saved.failure.code,'DISPATCH_INPUT_CHANGED');
  assert.equal(saved.native_launch_attempted,false);
  assert.equal(launches(f).length,0);assert.equal(promptCalls(f).length,0);
});

for(const merged of [false,true])test(`fresh fix refuses changed ${merged?'previously merged retained':'unlanded'} author branch before native launch`,t=>{
  const f=correction(t,{author:true,merged,sameLane:merged});
  inject(f,'lane',"if(a[0]==='prepare' && !entry()) process.exit(1);",`if(a[0]==='prepare')git(['-C',${JSON.stringify(f.author)},'commit','--allow-empty','-m','changed author']);`);
  const result=f.start();assert.equal(result.status,1,result.stderr);
  const saved=job(f);
  assert.equal(saved.failure.code,'DISPATCH_INPUT_CHANGED');
  assert.match(saved.error,/saved author source changed before fresh fix launch/);
  assert.equal(saved.native_launch_attempted,false);
  assert.equal(launches(f).length,0);assert.equal(promptCalls(f).length,0);
});

for(const phase of ['launch','watch'])test(`fresh fix prompts its frozen allocation when main advances during ${phase}`,t=>{
  const f=correction(t),base=f.git(['rev-parse','HEAD']);
  inject(f,phase==='launch'?'lane':'watch',phase==='launch'?"if(a[0]==='dispatch') {":"} else if(type==='watch') {",advanceMain);
  const result=f.start();assert.equal(result.status,0,result.stderr);
  const saved=job(f);
  assert.equal(saved.correction.base,base);assert.equal(saved.base,base);
  assert.notEqual(f.git(['rev-parse','main']),base);
  assert.equal(f.git(['rev-parse','HEAD'],saved.workspace),base);
  assert.equal(saved.stage,'complete');assert.equal(saved.failure,undefined);
  assert.equal(launches(f).length,1);assert.equal(promptCalls(f).length,1);
  assert.equal(f.jobs().length,1);assert.ok(saved.watcher.pid);
});

test('fresh fix keeps its frozen author commit when the integrated author ref is removed during startup',t=>{
  const f=correction(t,{author:true});
  inject(f,'watch',"} else if(type==='watch') {",`
    git(['merge','--ff-only',${JSON.stringify(f.authorHead)}]);
    git(['worktree','remove',${JSON.stringify(f.author)}]);
    git(['branch','-d','lane/author']);
    ${advanceMain}
  `);
  const result=f.start();assert.equal(result.status,0,result.stderr);
  const saved=job(f);
  assert.equal(saved.correction.ref,'refs/heads/lane/author');
  assert.equal(saved.base,f.authorHead);
  assert.equal(f.git(['rev-parse','HEAD'],saved.workspace),f.authorHead);
  assert.equal(f.git(['for-each-ref','--format=%(objectname)','refs/heads/lane/author']),'');
  assert.equal(launches(f).length,1);assert.equal(promptCalls(f).length,1);
  assert.equal(saved.stage,'complete');assert.equal(f.jobs().length,1);
});

for(const change of ['head','dirty','hold','native'])test(`fresh fix still refuses changed ${change} after main advances before prompt`,t=>{
  const f=correction(t);
  const mutation={
    head:"git(['-C',Object.values(workers)[0].cwd,'commit','--allow-empty','-m','changed allocation']);",
    dirty:"fs.writeFileSync(path.join(Object.values(workers)[0].cwd,'unsaved'),'changed allocation');",
    hold:`const r=spawnSync(process.execPath,[${JSON.stringify(path.resolve('bin/org.mjs'))},'set',${JSON.stringify(f.item)},'meta.hold=true'],{encoding:'utf8'});if(r.status)throw Error(r.stderr);`,
    native:"Object.values(workers)[0].terminal_id='foreign-terminal';save();",
  }[change];
  inject(f,'watch',"} else if(type==='watch') {",advanceMain+mutation);
  const result=f.start();assert.equal(result.status,1,result.stderr);
  const saved=job(f);
  assert.equal(launches(f).length,1);assert.equal(promptCalls(f).length,0);
  assert.equal(f.jobs().length,1);assert.ok(saved.worker);assert.ok(saved.watcher);
  if(change==='native')assert.match(saved.error,/worker occupant identity changed/);
  else {
    assert.equal(saved.failure.code,'DISPATCH_INPUT_CHANGED');
    assert.match(saved.error,change==='hold'?/closed\/held\/reserved/:/launched fresh fix source changed/);
  }
});
