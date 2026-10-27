import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {copyProduct} from '../lib/product-files.mjs';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { transact, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { gitProject } from '../lib/project.mjs';
import { createLineService, sourceRoot } from '../line-service/line-service.mjs';
import { reviewAttempt } from '../line-service/review.mjs';
import { validateQueuedReview, reviewQueueBrief } from '../line-service/review-queue.mjs';
import { checkUnlandedCap, countUnlanded, matchesDispatchStart } from '../dispatch/unlanded-cap.mjs';
import { checkSessionCap } from '../dispatch/session-cap.mjs';
import { fixture as dispatchFixture, promptCalls } from '../dispatch/test/dispatch-fixture.mjs';

const root = fs.realpathSync(sourceRoot), entry = path.join(root, 'bin/org.mjs');
function fixture(t, { outcome = 'blocked' } = {}) {
  const f = configFixture(t, { custom: true }), org = f.env.ORG_DIR, identity = gitProject(f.cwd).identity;
  const git = (args, cwd = f.cwd) => { const r = spawnSync('git', ['-C', cwd, ...args], { env: f.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.writeFileSync(path.join(f.cwd, 'code.mjs'), 'export const value=0;\n'); git(['add', 'code.mjs']); git(['commit', '-qm', 'Base']);
  const base = git(['rev-parse', 'HEAD']), workspace = path.join(f.scratch, 'lane'); git(['worktree', 'add', '-qb', 'lane/implementation', workspace]);
  fs.writeFileSync(path.join(workspace, 'code.mjs'), 'export const value=1;\n'); git(['add', 'code.mjs'], workspace); git(['commit', '-qm', 'Landed implementation'], workspace);
  const head = git(['rev-parse', 'HEAD'], workspace); git(['merge', '--ff-only', head]);
  const dispatch = path.join(org, 'dispatch', 'source.json'); fs.mkdirSync(path.dirname(dispatch), { recursive: true });
  fs.writeFileSync(dispatch, JSON.stringify({ token: 'fixture', stage: 'complete', run: 'R-1', item: 'ENG-1', org, common: identity, workspace, base }));
  const report = `---\nrun: R-1\noutcome: ${outcome}\nsummary: Landed code with red producer evidence.\nartifacts:\n  - "Commit: ${head}"\n  - code.mjs\n---\n`, reportHash = createHash('sha256').update(report).digest('hex');
  fs.mkdirSync(path.join(org, 'reports'), { recursive: true }); fs.writeFileSync(path.join(org, 'reports', 'R-1.md'), report);
  transact(org, () => ({ add: [
    {type:'line-service.cutover',id:'fixture-cutover',project:identity,repo:f.cwd,org,source:root,main:'main',canonical_head:base},
    {type:'line-service.phase0',id:'fixture-phase0',project:identity,repo:f.cwd,org,source:root,main:'main',canonical_head:base},
    { type: 'item.added', id: 'ENG-1', title: 'Build', role: 'engineer', meta: {} },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace, meta: { lane: 'implementation', dispatch_journal: dispatch, dispatch_attempt: 'fixture' } },
    { type: 'run.claimed', run: 'R-1', record: org, project: identity, owner: { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root, identity: gitProject(root).identity } } },
    { type: 'report.ingested', run: 'R-1', item: 'ENG-1', file: 'reports/R-1.md', sha256: reportHash, report: { outcome, summary: 'Committed red code', artifacts: [`Commit: ${head}`, 'code.mjs'], blockers: [], extra: {} } },
  ] }));
  const env = { ...f.env, ORG_ACTOR: 'line-service', HERDR_BRAIN_ROOT: root };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'CODEX_THREAD_ID']) delete env[key];
  const run = (args, extra = {}, file = entry) => spawnSync(process.execPath, [file, ...args], { cwd: f.cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  const context = () => { const events = loadEvents(org).events, state = fold(events); return { org, repo: f.cwd, identity, events, state, item: state.items.get('ENG-1') }; };
  const create = () => { const r = run(['queue-review', 'R-1', '--head', head, '--base', base]); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  return { ...f, org, identity, workspace, base, head, git, env, run, context, create };
}

test('review queue atomically creates one landed tuple item across concurrent create and replay', async t => {
  const f = fixture(t), args = [entry, 'queue-review', 'R-1', '--head', f.head, '--base', f.base];
  f.git(['reset','--hard',f.base]); const unlanded=f.run(['queue-review','R-1']); assert.notEqual(unlanded.status,0); assert.match(unlanded.stderr,/not actually landed/); f.git(['merge','--ff-only',f.head]);
  const launch = () => new Promise(resolve => { const child = spawn(process.execPath, args, { cwd: f.cwd, env: f.env }); let stdout='', stderr=''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.on('exit', status => resolve({status,stdout,stderr})); });
  const replies = await Promise.all([launch(), launch()]);
  for (const r of replies) assert.equal(r.status, 0, r.stderr);
  const ids = replies.map(r => JSON.parse(r.stdout).review_item); assert.equal(ids[0], ids[1]);
  assert.equal(f.create().review_item, ids[0]); const c = f.context(), q = c.state.items.get(ids[0]);
  assert.equal(c.events.filter(e => e.type === 'item.added' && e.role === 'reviewer').length, 1);
  assert.equal(q.meta.review_key, `ENG-1:${f.head}`); assert.equal(q.meta.review_target.reportHash, c.state.runs.get('R-1').report.sha256);
  f.git(['worktree', 'remove', '--force', f.workspace]);
  assert.equal(validateQueuedReview({ ...f.context(), item: q }).head, f.head, 'immutable queued review survives source cleanup');
  assert.match(reviewQueueBrief(q), /zero reviewer suites/); assert.match(reviewQueueBrief(q), /linked engineer follow-up/);
});

test('review queue preserves outside-owner manual UNKNOWN and unrecognized service inventory without external probes', t => {
  const f = fixture(t), c = f.context(), external = '/outside-owner/archive/ENG-1/producer/review-launch.json';
  c.state.runs.get('R-1').report.artifacts.push(external);
  const lstat = fs.lstatSync; let probes = 0;
  fs.lstatSync = (file, ...args) => { if (String(file).startsWith('/outside-owner/')) probes++; return lstat(file, ...args); };
  try { assert.match(reviewAttempt(c.item, c), /bound source-owner review reference/); } finally { fs.lstatSync = lstat; }
  assert.equal(probes, 0);
  fs.mkdirSync(path.join(f.org, 'line-service/unknown'), {recursive:true}); fs.writeFileSync(path.join(f.org, 'line-service/unknown/effects.json'), '{"result":"review_pending","qualification":"UNKNOWN"}');
  const rejected = f.run(['queue-review','R-1']); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /unrecognized service review inventory/);
  assert.equal([...f.context().state.items.values()].filter(i => i.role === 'reviewer').length, 0);
  fs.unlinkSync(path.join(f.org,'line-service/unknown/effects.json')); fs.mkdirSync(path.join(f.org,'settle'),{recursive:true}); fs.writeFileSync(path.join(f.org,'settle/opaque.json'),'{"qualification":"UNKNOWN"}');
  assert.throws(()=>reviewAttempt(f.context().item,f.context()),/unmapped review inventory/);
});

test('review admission is separate from eight build slots while native total capacity and ambiguous dispatch remain held', t => {
  const f = fixture(t), qid = f.create().review_item;
  const add = [];
  for (let n=2;n<=9;n++) add.push({type:'item.added',id:`ENG-${n}`,title:'Pending build',role:'engineer'}, {type:'run.started',id:`R-${n}`,item:`ENG-${n}`,workspace:f.cwd,meta:{dispatch_project:f.identity,dispatch_unlanded_admitted:true}});
  add.push({type:'item.added',id:'ENG-10',title:'Next build',role:'engineer'});
  transact(f.org, () => ({add})); const c=f.context(), config={dispatch:{max_unlanded:8,max_sessions:1}};
  assert.throws(() => checkUnlandedCap({config,events:c.events,journals:[],common:f.identity,request:{item:'ENG-10'}}), e=>e.code==='DISPATCH_UNLANDED_CAP');
  const review=checkUnlandedCap({config,events:c.events,journals:[],common:f.identity,request:{item:qid}});
  assert.equal(review.admission.kind,'review'); assert.equal(review.admission.admitted,false);
  const pending={item:qid,common:f.identity,stage:'starting',token:'queued',journal:'pending',unlandedCap:review};
  assert.equal(countUnlanded({events:c.events,journals:[pending],common:f.identity}).items.length,8);
  const meta={dispatch_project:f.identity,dispatch_journal:'pending',dispatch_attempt:'queued',dispatch_unlanded_admitted:false,dispatch_role:'review'};
  assert.equal(matchesDispatchStart({item:qid,meta},pending),true);
  fs.mkdirSync(path.join(f.org,'retirement/occupants'),{recursive:true}); fs.writeFileSync(path.join(f.org,'retirement/occupants/held.json'),JSON.stringify({schema:'retirement-occupant/v1',kind:'settle',run:'R-1',common:f.identity,cwd:f.cwd,process:{pid:12345,identity:'held'}}));
  assert.throws(()=>checkSessionCap({config,org:f.org,common:f.identity,kill:()=>{},readProcess:()=>({ok:true,value:{pid:12345,identity:'held'}})}),e=>e.code==='DISPATCH_SESSION_CAP');
  fs.writeFileSync(path.join(f.org,'dispatch/uncertain.json'),JSON.stringify({item:qid,stage:'launching'}));
  assert.throws(()=>validateQueuedReview({...f.context(),item:f.context().state.items.get(qid)}),/existing\/ambiguous saved dispatch/);
});

test('line service creates a record review item then normal review-lane dispatch exactly once without a settle driver', t => {
  const f=fixture(t,{outcome:'done'}), calls=[], notices=[];
  const command=(exe,args,options)=>{
    calls.push(args);
    if(args[0]===entry) return spawnSync(exe,args,{...options,env:f.env});
    if(args[0]===path.join(root,'supervisor/closeout.mjs')) return {status:0,stdout:'{"evaluated":[]}',stderr:''};
    assert.equal(args[0],path.join(root,'dispatch/dispatch.mjs')); return {status:0,stdout:'{"run":"R-2","item":"REV-1"}',stderr:''};
  };
  const service=()=>createLineService({repo:f.cwd,org:f.org,to:'test-supervisor',env:f.env,capacity:()=>({cap:7,count:0}),command,recordNotice:data=>{notices.push(data.reason);return{id:data.id,state:'record-only'};}});
  service().pass(); service().pass();
  assert.equal(calls.filter(a=>a[0]===entry&&a[1]==='queue-review').length,1);
  const dispatched=calls.filter(a=>a[0]===path.join(root,'dispatch/dispatch.mjs')); assert.equal(dispatched.length,1,notices.join('\n'));
  const args=dispatched[0]; assert.equal(args[args.indexOf('--base')+1],f.head); assert.match(args[args.indexOf('--lane')+1],/^review-rev-/); assert.equal(args[args.indexOf('--route')+1],'review-codex');
  assert.equal(calls.some(a=>/settle\/|supervisor\/supervisor/.test(a[0])),false);
  assert.equal(f.context().state.items.get('ENG-1').closed.as,'done','pending queued review does not gate truthful source completion');
});

test('review queue dispatch uses normal native route and immutable lane with zero-suite reviewer prompt', t => {
  const f=fixture(t), qid=f.create().review_item, d=dispatchFixture(t,{project:f,sourceEntry:true});
  const lane=path.join(d.root,'bin/lane'); fs.writeFileSync(lane,fs.readFileSync(lane,'utf8').replaceAll('lane/topic','lane/review-queue'));
  const result=d.dispatch([qid,'--lane','review-queue','--route','review-codex','--base',f.head,'--brief',d.brief],{env:{...d.env,HERDR_BRAIN_ROOT:root}});
  assert.equal(result.status,0,result.stderr);
  const job=d.jobs().map(file=>JSON.parse(fs.readFileSync(file))).find(j=>j.item===qid), prompt=promptCalls(d)[0].a[3];
  assert.equal(job.reviewQueue.head,f.head); assert.equal(job.base,f.head); assert.equal(d.show(job.run).meta.dispatch_role,'review'); assert.equal(d.show(job.run).meta.dispatch_unlanded_admitted,false);
  assert.match(prompt,/zero reviewer suites/); assert.match(prompt,/Captured immutable HEAD/); assert.doesNotMatch(prompt,/Start ONE independent async post-code review|Self-land your own finished committed source|Run only the ask/);
  const again=d.dispatch([qid,'--lane','review-second','--route','review-codex','--base',f.head,'--brief',d.brief],{env:{...d.env,HERDR_BRAIN_ROOT:root}}); assert.notEqual(again.status,0); assert.match(again.stderr,/already has a run/);
  assert.equal(promptCalls(d).length,1);
});

test('permanent review capacity reaches the normal guarded reviewer launch at a full build pool and respects an explicit shared native ceiling',t=>{
  for(const shared of [false,true]){
    const f=fixture(t),qid=f.create().review_item,file=path.join(f.cwd,'.lane.json'),config=JSON.parse(fs.readFileSync(file));config.dispatch={...config.dispatch,max_sessions:1,max_review_sessions:3,...(shared?{max_total_sessions:1}:{})};fs.writeFileSync(file,JSON.stringify(config));
    fs.writeFileSync(path.join(f.org,'dispatch/pending-build.json'),JSON.stringify({stage:'open',detached:true,item:'ENG-90',common:f.identity}));
    const d=dispatchFixture(t,{project:f,sourceEntry:true}),lane=path.join(d.root,'bin/lane');fs.writeFileSync(lane,fs.readFileSync(lane,'utf8').replaceAll('lane/topic','lane/review-capacity'));
    const result=d.dispatch([qid,'--lane','review-capacity','--route','review-codex','--base',f.head,'--brief',d.brief],{env:{...d.env,HERDR_BRAIN_ROOT:root}});
    if(shared){assert.equal(result.status,1);assert.match(result.stderr,/session cap 1 reached/);assert.equal(promptCalls(d).length,0);}
    else{assert.equal(result.status,0,result.stderr);assert.equal(promptCalls(d).length,1);const job=d.jobs().map(p=>JSON.parse(fs.readFileSync(p))).find(j=>j.item===qid);assert.equal(job.sessionCap.kind,'review');assert.equal(job.sessionCap.review_cap,3);assert.equal(job.sessionCap.native_cap,4);}
  }
});

test('review queue current default refuses a parallel legacy lane-review before native effects', t => {
  const f=fixture(t), file=path.join(f.cwd,'.lane.validation.json'), policy=JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file,JSON.stringify({...policy,landing_waiver:'operator-20261025-until-stable-release'}));
  const result=spawnSync(process.execPath,[path.join(root,'lanes/lane.mjs'),'review','implementation','--round','1','--run','R-1','--brief',path.join(f.org,'reports/R-1.md'),'--parallel-review','--captured-head',f.head,'--captured-base',f.base],{cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.notEqual(result.status,0); assert.match(result.stderr,/no new legacy lane-review launch/);
  assert.equal(fs.existsSync(path.join(f.org,'settle/R-1.review-launch.json')),false);
});

test('adopted queue source entry requires matching actual implementation and preserves ordinary and immutable forwarding', async t => {
  const f=fixture(t), pinned=path.join(f.bundle,'bin/org.mjs');
  fs.writeFileSync(pinned,`if(['queue-review','status'].includes(process.argv[2])){console.log(JSON.stringify({pinned:true}));process.exit(0);}\n`+fs.readFileSync(pinned,'utf8').replace(/^#![^\n]*\n/,''));
  const manifest=spawnSync(process.execPath,[path.join(root,'herdr/releases.mjs'),'manifest',f.bundle,path.join(f.bundle,'.release-acceptance.json')],{cwd:f.cwd,env:f.env,encoding:'utf8'}); assert.equal(manifest.status,0,manifest.stderr);
  await f.adopt();
  // Constrain default forwarding's account lookup to this fixture, never the real installation.
  const account=path.join(f.scratch,'account.mjs'); fs.writeFileSync(account,`import os from 'node:os';import{syncBuiltinESMExports}from'node:module';const prior=os.userInfo;os.userInfo=(...args)=>({...prior(...args),homedir:${JSON.stringify(f.home)}});syncBuiltinESMExports();`);
  const extra={NODE_OPTIONS:`${f.env.NODE_OPTIONS??''} --import=${JSON.stringify(account)}`};
  const before=fs.readFileSync(f.binding().file,'utf8');
  const bad=f.run(['queue-review','R-1'],{...extra,HERDR_BRAIN_ROOT:f.cwd}); assert.notEqual(bad.status,0); assert.match(bad.stderr,/must match the invoked development source root/);
  const missingNative=f.run(['queue-review','R-1'],{...extra,ORG_ACTOR:'fixture-worker'}); assert.notEqual(missingNative.status,0); assert.match(missingNative.stderr,/native caller binding is missing/);
  const queued=f.run(['queue-review','R-1'],extra); assert.equal(queued.status,0,queued.stderr); assert.equal(JSON.parse(queued.stdout).result,'review_queued');
  const forwarded=f.run(['status','--json'],extra); assert.equal(forwarded.status,0,forwarded.stderr); assert.equal(JSON.parse(forwarded.stdout).pinned,true);
  const saved=f.run(['queue-review','R-1'],{...extra,HERDR_BRAIN_ROOT:f.cwd},pinned); assert.equal(saved.status,0,saved.stderr); assert.equal(JSON.parse(saved.stdout).pinned,true);
  assert.equal(fs.readFileSync(f.binding().file,'utf8'),before);
});

test('inflight queue capability survives a committed development landing while immutable saved tampering and foreign selectors remain held',async t=>{
  const f=fixture(t),copy=path.join(f.scratch,'development-source');copyProduct(root,copy);
  const git=args=>{const r=spawnSync('git',['-C',copy,...args],{encoding:'utf8',env:f.env});assert.equal(r.status,0,r.stderr);};
  git(['init','-qb','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);git(['add','.']);git(['commit','-qm','Captured source']);
  const helper=await import(pathToFileURL(path.join(copy,'line-service/review-queue.mjs'))),run={owner:{controller:'brain',legacy:false,release:{id:'source',root:copy,commit:null}}};assert.equal(helper.queueConsumer({run,env:{HERDR_BRAIN_ROOT:copy}}),copy);
  fs.appendFileSync(path.join(copy,'dispatch/session-cap.mjs'),'\n// unrelated committed follow-through\n');git(['add','.']);git(['commit','-qm','Unrelated source landing']);assert.equal(helper.queueConsumer({run,env:{HERDR_BRAIN_ROOT:copy}}),copy);
  assert.throws(()=>helper.queueConsumer({run,env:{HERDR_BRAIN_ROOT:f.cwd}}),/selector differs/);assert.throws(()=>helper.queueConsumer({run:{owner:{...run.owner,legacy:true}},env:{}}),/ownership is UNKNOWN/);
  const frozen=await import(pathToFileURL(path.join(f.bundle,'line-service/review-queue.mjs')));fs.appendFileSync(path.join(f.bundle,'dispatch/session-cap.mjs'),'\n// immutable bytes changed\n');assert.throws(()=>frozen.queueConsumer({run,env:{HERDR_BRAIN_ROOT:f.bundle}}),/immutable saved/);
  assert.equal([...f.context().state.items.values()].some(i=>i.role==='reviewer'),false);
});

test('typed initial review capacity refusal waits for fresh availability then continues once without a fictitious native attempt',t=>{
  const f=fixture(t);f.create();let dispatches=0,busy=false;const reason='review cap 3 reached: unknown liveness and uncertain launch remain occupied';
  const service=()=>createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,recordNotice:d=>({id:d.id,state:'record-only'}),capacity:()=>{if(busy)throw Object.assign(Error(reason),{code:'DISPATCH_REVIEW_CAP'});return{cap:3,count:0};},command:(_exe,args)=>{
    assert.equal(args[0],path.join(root,'dispatch/dispatch.mjs'));dispatches++;
    return dispatches===1?{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_REVIEW_CAP',reason}),stderr:reason}:{status:0,stdout:JSON.stringify({result:'detached',journal:path.join(f.org,'dispatch/new-original.json')}),stderr:''};
  }});
  service().pass();assert.equal(dispatches,1);busy=true;service().pass();assert.equal(dispatches,1);busy=false;service().pass();service().pass();assert.equal(dispatches,2);
  const directory=path.join(f.org,'line-service',createHash('sha256').update(JSON.stringify(f.identity)).digest('hex').slice(0,20)),entry=Object.entries(JSON.parse(fs.readFileSync(path.join(directory,'effects.json'))).actions).find(([k])=>k.startsWith('dispatch:REV-'))[1];
  assert.equal(entry.history.length,1);assert.equal(JSON.parse(entry.history[0].receipt.stdout).code,'DISPATCH_REVIEW_CAP');assert.equal(entry.result.result,'detached');assert.equal(f.context().events.some(e=>e.type==='run.started'&&e.item.startsWith('REV-')),false);
});
