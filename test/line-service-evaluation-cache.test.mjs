import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createLineService,sourceRoot,serviceDirectory} from '../line-service/line-service.mjs';
import {negativeEvaluationCache} from '../line-service/evaluation-cache.mjs';
import {gitProject} from '../lib/project.mjs';
import {initOrg,transact,loadRecord} from '../lib/store.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'negative-evaluation-'))),repo=path.join(root,'project'),org=path.join(repo,'.org');
  fs.mkdirSync(repo);fs.writeFileSync(path.join(root,'.identity-root'),'fixture\n');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env={...process.env,ORG_DIR:org,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  for(const name of ['LANE_CONFIG','HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID'])delete env[name];
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
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
  return{root,repo,org,env,identity,directory,append,config,calls,pass};
}
const work=(id,extra={})=>({type:'item.added',id,role:'engineer',title:id,...extra});
const summary=rows=>rows.findLast(r=>r.action==='pass-complete');

test('large held backlog skips unchanged evaluations across process instances and invalidates only dependent ancestry/links',t=>{
  const f=fixture(t),events=[];
  for(let n=1;n<=200;n++)events.push({type:'item.added',id:`G-${n}`,kind:'goal',title:'Parent',meta:{hold:true}},work(`ENG-${n}`,{parent:`G-${n}`}));
  events.push(work('ENG-201',{meta:{hold:true}}),{type:'link.added',blocker:'ENG-201',blocked:'ENG-1'});f.append(events);
  const first=f.pass(),second=f.pass();
  assert.equal(summary(first).evaluations.admission_evaluated,201);
  assert.equal(summary(second).evaluations.admission_evaluated,0);
  assert.equal(summary(second).evaluations.admission_skipped,201);
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
  const retained=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).ordinary_admission.held;assert.equal(retained.length,201);assert.ok(retained.every(row=>row.cached===true));
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

test('Git inputs, brief bytes, source revision and malformed hints invalidate negatives without authorizing a start',t=>{
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
  revision='changed source';assert.ok(evaluate(cache()).every(p=>!p.skip));
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
  assert.equal(warm.filter(r=>['hold','admission-eligible'].includes(r.action)).length,0);
  f.append([{type:'item.updated',id:'ENG-1',fields:{title:'Relevant subject changed'}}]);
  const changed=pass();assert.equal(summary(changed).evaluations.admission_evaluated,1);assert.equal(summary(changed).evaluations.source_evaluated,1);
  const recovered=pass();assert.equal(summary(recovered).evaluations.admission_skipped,1);assert.equal(summary(recovered).evaluations.source_skipped,1);
});

test('a different source revision cannot erase other subjects while relevant unknown Git inventories remain fresh',t=>{
  const f=fixture(t),document={actions:{}},counts={};f.append([work('ENG-1'),work('ENG-2')]);
  const snapshot=loadRecord(f.org),cache=revision=>negativeEvaluationCache({store:()=>document,identity:f.identity,repo:f.repo,org:f.org,revision,counts});
  const subject=item=>({snapshot,item,policy:{}}),a=cache('first'),b=cache('second');
  a.probe('admission',subject('ENG-1')).retain('held');
  b.probe('admission',subject('ENG-2')).retain('held');
  assert.equal(a.probe('admission',subject('ENG-1')).skip,true,'a resumed older pass retains unrelated negatives');
  assert.equal(b.probe('admission',subject('ENG-1')).skip,false,'changed code still requires fresh evaluation');
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
