import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadTimeout} from '../../lib/deadline.mjs';
import {fixture,promptCalls,until} from './dispatch-fixture.mjs';

const LANE=fileURLToPath(new URL('../../lanes/lane.mjs',import.meta.url));
const launches=f=>f.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch');
const saved=f=>JSON.parse(fs.readFileSync(f.jobs()[0]));

function scenario(t,phase,{correction=false,author=false}={}) {
  const f=fixture(t),marker=path.join(f.root,'paused'),release=path.join(f.root,'continue');
  const pause=`fs.writeFileSync(${JSON.stringify(marker)},'ready');
    const deadline=Date.now()+${loadTimeout(30000)};
    while(!fs.existsSync(${JSON.stringify(release)})) {
      if(Date.now()>=deadline)throw Error('main-move barrier expired');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }`;
  // Use the product's actual open/prepare CLI. Only native launch/watch/prompt
  // stay offline, using the existing dispatch fixture's identity contract.
  const fake=path.join(f.root,'bin','lane');
  let source=fs.readFileSync(fake,'utf8');
  const open="if(a[0]==='open') git(['worktree','add','-b','lane/'+a[1],path.join(root,fs.existsSync(path.join(root,'lane'))?'lane-'+a[1]:'lane'),a.slice(2).find(x=>!x.startsWith('--'))??'HEAD']);";
  assert.ok(source.includes(open));
  source=source.replace(open,`if(['open','prepare'].includes(a[0])) {
    ${phase==='prepare'?`if(a[0]==='prepare'){${pause}}`:''}
    const actual=spawnSync(process.execPath,[${JSON.stringify(LANE)},...a],{encoding:'utf8'});
    fs.appendFileSync(path.join(root,'real-lane-calls'),JSON.stringify({stage:a[0],status:actual.status,stdout:actual.stdout,stderr:actual.stderr})+'\\n');
    if(actual.status!==0){process.stderr.write(actual.stderr);process.exit(actual.status??1);}
  }`);
  fs.writeFileSync(fake,source);
  const preload=path.join(f.root,'open-barrier.cjs');
  fs.writeFileSync(preload,`if(process.argv[1]===${JSON.stringify(LANE)}) {
    const fs=require('node:fs'),cp=require('node:child_process');
    const execute=cp.execFileSync;
    cp.execFileSync=function(command,args,...rest) {
      if(${JSON.stringify(phase)}==='open' && command==='git' && args[2]==='worktree' && args[3]==='add') {${pause}}
      return execute.call(this,command,args,...rest);
    };
    require('node:module').syncBuiltinESMExports();
  }`);
  // Put every allocation and all runtime state under this disposable project.
  fs.writeFileSync(path.join(f.repo,'.gitignore'),'.lane/\n');
  f.git(['add','.lane.json','.gitignore']);f.git(['commit','-m','project policy']);
  if(correction||author) {
    let workspace=f.repo;
    if(author) {
      workspace=path.join(f.root,'author');
      f.git(['worktree','add','-b','lane/author',workspace]);
      f.git(['commit','--allow-empty','-m','kept author source'],workspace);
    }
    const run=f.rec(['start',f.item,'--workspace',workspace,...(author?['--meta','lane=author']:[])]).match(/^(R-\d+) started/m)[1];
    const report=path.join(f.root,'blocked.md');
    fs.writeFileSync(report,`---\nrun: ${run}\noutcome: blocked\nsummary: Continue the saved source\n---\n`);
    f.rec(['ingest',report]);
  }
  const base=f.git(['rev-parse',author?'lane/author':'main']);
  const landing=path.join(f.root,'landing');
  f.git(['worktree','add','-b','parallel-landing',landing,'main']);
  fs.writeFileSync(path.join(landing,'concurrent.txt'),'independent source landing\n');
  f.git(['add','concurrent.txt'],landing);f.git(['commit','-m','concurrent landing'],landing);
  const head=f.git(['rev-parse','HEAD'],landing);
  assert.equal(f.git(['for-each-ref','--format=%(objectname)','refs/heads/lane/topic']),'','brand-new lane');
  const pending=f.concurrent([f.item,'--lane','topic','--route','engineer','--brief',f.brief,'--base',author?'lane/author':'main'],{
    LANE_WORKTREE_ROOT:path.join(f.root,'worktrees'),
    NODE_OPTIONS:`${f.env.NODE_OPTIONS??''} --require=${preload}`,
  });
  return {...f,base,head,marker,release,pending};
}

async function advance(f,mutate=()=>{}) {
  try {
    await until(()=>fs.existsSync(f.marker),loadTimeout(20000));
    const job=saved(f);
    assert.equal(job.stage,'open');assert.equal(job.native_launch_attempted,false);
    assert.equal(job.base,f.base);
    // A separate Git process lands a genuinely changed tree while dispatch is
    // alive inside open/prepare, rather than changing a mocked source answer.
    f.git(['merge','--ff-only','--','parallel-landing']);
    assert.equal(f.git(['rev-parse','main']),f.head);
    mutate();
  } finally { fs.writeFileSync(f.release,'continue'); }
  return f.pending.done;
}

for(const phase of ['open','prepare'])for(const correction of [false,true]) {
  test(`brand-new ${correction?'main-based fix':'engineering'} lane survives a concurrent FF landing during real ${phase}`,async t=>{
    const f=scenario(t,phase,{correction}),result=await advance(f);
    assert.equal(result.status,0,result.stderr+result.stdout);
    const job=saved(f),receipt=JSON.parse(result.stdout);
    assert.equal(f.jobs().length,1);assert.equal(job.stage,'complete');assert.equal(job.failure,undefined);
    assert.equal(job.base,f.base);assert.notEqual(job.base,f.head);
    assert.equal(f.git(['rev-parse','HEAD'],job.workspace),job.base);
    assert.equal(f.git(['status','--porcelain=v1'],job.workspace),'');
    const real=fs.readFileSync(path.join(f.root,'real-lane-calls'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(real.map(r=>[r.stage,r.status]),[['open',0],['prepare',0]]);
    assert.equal(launches(f).length,1);assert.equal(promptCalls(f).length,1);
    assert.equal(f.calls().filter(c=>c.type==='watch').length,1);
    assert.deepEqual(receipt.watcher,job.watcher);assert.equal(f.show(job.run).meta.agent,job.worker.agentName);
    assert.equal(f.state().runs.size,correction?2:1);
    t.diagnostic(JSON.stringify({phase,correction,selected_base:job.base,landed_main:f.head,allocation_head:job.base,
      real_open:1,real_prepare:1,launches:1,prompts:1,watchers:1,main_only_refusals:0}));
  });
}

for(const phase of ['open','prepare'])for(const change of ['author','item']) {
  test(`concurrent main landing during ${phase} still refuses a changed ${change}`,async t=>{
    const f=scenario(t,phase,{author:change==='author'});
    const result=await advance(f,()=>{
      if(change==='author')f.git(['commit','--allow-empty','-m','genuinely changed author'],path.join(f.root,'author'));
      else f.rec(['set',f.item,'meta.hold=true']);
    });
    assert.equal(result.status,1,result.stderr+result.stdout);
    const job=saved(f);
    assert.equal(job.failure.code,'DISPATCH_INPUT_CHANGED');
    assert.match(job.error,change==='author'?/saved author source changed/:/closed\/held\/reserved/);
    assert.equal(job.native_launch_attempted,false);assert.equal(job.worker,undefined);
    assert.equal(launches(f).length,0);assert.equal(promptCalls(f).length,0);
    assert.equal(f.calls().filter(c=>c.type==='watch').length,0);assert.equal(f.jobs().length,1);
  });
}
