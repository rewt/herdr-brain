import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLineService, sourceRoot, reviewAttempt, serviceDirectory, routeFor } from '../line-service/line-service.mjs';
import { launchPlist } from '../line-service/launchd.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { gitProject } from '../lib/project.mjs';
import { loadEvents,transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { captureProductCheckout } from '../lib/product-files.mjs';
import { tierFiles } from './helpers/tier.mjs';
import {createHash} from 'node:crypto';
import {haltObservation} from '../line-service/halt-repair.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-service-'))), repo = path.join(root, 'project'), org = path.join(repo, '.org');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(repo); fs.writeFileSync(path.join(root, '.identity-root'), 'fixture\n');
  const env = { ...process.env, ORG_DIR: org, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['LANE_CONFIG', 'HERDR_ENV', 'HERDR_PANE_ID', 'CODEX_THREAD_ID']) delete env[key];
  const exec = (exe, args) => {
    const r = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();
  };
  const git = args => exec('git', args), record = args => exec(process.execPath, [path.join(sourceRoot, 'bin/org.mjs'), ...args]);
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Line fixture']); git(['config', 'user.email', 'line@example.invalid']);
  fs.writeFileSync(path.join(repo, 'source'), 'initial'); git(['add', '.']); git(['commit', '-qm', 'Initial']); record(['init']);
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ routes: { engineer: { kind: 'codex', model: 'fixture', effort: 'high' } }, dispatch: { max_sessions: 2 } }));
  const boundary = {id:'fixture-cutover',project:gitProject(repo).identity,repo,org,source:fs.realpathSync(sourceRoot),main:'main',canonical_head:git(['rev-parse','HEAD'])};
  // These fixtures start after a recorded boundary, before any fixture work.
  transact(org,()=>({add:['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type}))}));
  // Review steps mutate only through an installed service binding, as in production.
  const directory = serviceDirectory(org, boundary.project); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ at: '2026-10-27T00:00:00Z', repo, org, source: sourceRoot, node: process.execPath, file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` }));
  const add = (title, priority = 1, extra = []) => record(['add', title, '--role', 'engineer', '--priority', String(priority), ...extra]).split(' ')[0];
  const show = id => JSON.parse(record(['show', id, '--json']));
  const calls = [], notes = [];
  let fail;
  const command = (exe, args, options) => {
    calls.push({ exe, args, options });
    if (fail) return { status: 1, stdout: '', stderr: fail };
    return { status: 0, stdout: JSON.stringify({ result: args[1] === 'handle' ? 'review_pending' : 'dispatched' }), stderr: '' };
  };
  const service = (overrides = {}) => createLineService({ repo, org, to: 'supervisor-test', env, command,
    haltAfter:100,capacity: () => ({ count: 0, cap: 2 }), recordNotice: data => { notes.push({ to:'supervisor-test',text:data.reason,options:data }); return { id:data.id,state:'record-only' }; }, ...overrides });
  return { repo, org, env, record, git, add, show, calls, notes, service, setFailure: value => { fail = value; } };
}

test('default routing handles known role and narrow task aliases without recasting supervisor or orchestrator work',()=>{
  const route={kind:'codex'},config={routes:{narrow:route},selection_policy:{by_task_class:{'implementation-narrow':'narrow'}}};
  for(const role of ['engineer','engineering'])assert.equal(routeFor({role,meta:{}},config),'narrow');
  for(const role of ['supervisor','orchestrator'])assert.throws(()=>routeFor({role,meta:{}},config),/unsupported line role/);
  assert.throws(()=>routeFor({role:'engineer',capability:'unknown',meta:{}},config),/unknown task class: unknown/);
  assert.equal(routeFor({role:'supervisor',meta:{route:'narrow'}},config),'narrow','an explicit existing route remains authoritative');
  for(const role of ['architect','architecture','planner'])assert.equal(routeFor({role,meta:{}},{routes:{unblock:route},selection_policy:{by_task_class:{review:'unblock'}}}),'unblock','partial project selection policy retains the established planning route');
});

test('a changed supervisor address recovers only the exact zero-effect pre-journal failure once and preserves its original receipt',t=>{
  const f=fixture(t),item=f.add('Previously stranded engineering'),s=f.service(),directory=s.directory;
  const configFile=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(configFile));config.routes.review={kind:'claude'};fs.writeFileSync(configFile,JSON.stringify(config));
  const created=f.show(item).created.seq,key=`dispatch:${item}:${created}:ordinary`,brief=path.join(directory,createHash('sha256').update(JSON.stringify(key)).digest('hex')+'.ask.md');
  const reason='Worker brief missing required fields: PROJECT SUPERVISOR address (configure owning project promote.to or launch MONITOR_SUPERVISOR_AGENT); no worker spawned';
  fs.writeFileSync(brief,'# Original assignment\n');
  const original={state:'held',at:'2026-10-27T00:00:00Z',error:'dispatch: '+reason,receipt:{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason}),stderr:'dispatch: '+reason}};
  fs.writeFileSync(path.join(directory,'effects.json'),JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
  s.pass();assert.equal(f.calls.length,0,'an unchanged missing address never retries');
  const changed={env:{...f.env,MONITOR_SUPERVISOR_AGENT:'supervisor-test'}};
  f.service(changed).pass();f.service(changed).pass();assert.equal(f.calls.length,1,fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8'));assert.equal(f.calls[0].args[1],item);
  const actions=JSON.parse(fs.readFileSync(path.join(directory,'effects.json'))).actions;
  assert.deepEqual(actions[key].receipt,original.receipt);assert.ok(actions[key].prejournal_recovery);
  assert.equal(actions[actions[key].prejournal_recovery.key].state,'complete');
});

test('three completed engineering-idle passes file and immediately dispatch one repair across restart while original native refusal remains retained',t=>{
  const f=fixture(t),item=f.add('Native refusal'),options={haltAfter:3};f.setFailure('native permission refused');
  for(let n=0;n<3;n++)f.service(options).pass();
  const repairs=()=>[...fold(loadEvents(f.org).events).items.values()].filter(i=>i.meta.halt_repair===1);
  assert.equal(repairs().length,1);const repair=repairs()[0];
  assert.equal(f.calls.filter(c=>c.args[1]===item).length,1);
  assert.equal(f.calls.filter(c=>c.args[1]===repair.id).length,1,'fresh ordinary dispatch in the threshold pass');
  for(let n=0;n<3;n++)f.service(options).pass();
  assert.equal(repairs().length,1);assert.equal(f.calls.filter(c=>c.args[1]===repair.id).length,1);
  const release=noticeLock(path.join(f.service().directory,'pass.lock'));
  try{assert.throws(()=>f.service(options).pass(),/locked/);}finally{release();}
  assert.equal(repairs().length,1);
});

test('engineering-idle excludes held ancestry reserved work and unchanged blocked reports while independent work still dispatches',t=>{
  const f=fixture(t),held=f.add('Explicit hold'),parent=f.add('Closed review ancestry'),child=f.add('Selected child',99,['--parent',parent]),blocked=f.add('Unchanged blocked report');
  const reserved=f.add('Reserved publication'),ancestor=f.add('Reserved ancestor'),descendant=f.add('Reserved descendant',99,['--parent',ancestor]);
  transact(f.org,()=>({add:[
    {type:'item.updated',id:held,fields:{meta:{hold:true}}},
    {type:'item.closed',id:parent,as:'done'},
    {type:'item.updated',id:child,fields:{meta:{queue_selected:true}}},
    {type:'item.updated',id:reserved,fields:{meta:{category:'publish'}}},
    {type:'item.updated',id:ancestor,fields:{meta:{operator_reserved:true}}},
    {type:'run.started',id:'R-1',item:blocked,meta:{}},
    {type:'report.ingested',run:'R-1',sha256:'unchanged-report',file:'reports/R-1.md',report:{outcome:'blocked',summary:'Needs a real reframe.'}},
    {type:'link.added',blocker:parent,blocked}
  ]}));
  const original=loadEvents(f.org).events;
  for(let n=0;n<3;n++)f.service({haltAfter:3}).pass();
  assert.equal(f.calls.length,0,'no native dispatch or recursive repair for inadmissible work');
  const state=fold(loadEvents(f.org).events);
  assert.equal([...state.items.values()].some(i=>i.meta.halt_repair===1),false);
  assert.deepEqual(loadEvents(f.org).events,original,'holds, reports and ancestry stay unchanged');
  const effects=JSON.parse(fs.readFileSync(path.join(f.service().directory,'effects.json')));
  assert.equal(effects.halt_progress.count,0);
  const observations=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.action==='engineering-idle-observation');
  assert.ok(observations.every(r=>r.observation.ready.length===0));
  const ready=f.add('Independent eligible engineering');
  f.service({haltAfter:3}).pass();
  assert.deepEqual(f.calls.map(c=>c.args[1]),[ready],'existing ordinary dispatch admits independent work');
  assert.ok(!f.calls.some(c=>[held,child,blocked,reserved,ancestor,descendant].includes(c.args[1])));
});

test('engineering-idle includes an authorized blocked restart even before the record status changes',()=>{
  const events=[
    {type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Blocked engineering'},
    {type:'run.started',id:'R-1',item:'ENG-1',meta:{}},
    {type:'report.ingested',run:'R-1',sha256:'original-report',file:'reports/R-1.md',report:{outcome:'blocked'}},
  ].map((e,n)=>({...e,seq:n+1,by:'fixture',at:'2026-10-27T00:00:00Z'}));
  const observe=()=>haltObservation({events,state:fold(events),identity:'fixture',config:{}});
  assert.deepEqual(observe().ready,[]);
  events.push({type:'item.updated',id:'ENG-1',fields:{title:'Explicitly reframed engineering'},seq:4,by:'fixture'});
  assert.deepEqual(observe().ready,['ENG-1'],'use the normal changed-input restart predicate');
});

test('priority READY dispatch uses existing admission and retains its one effect across restart', t => {
  const f = fixture(t); const high = f.add('High', 7);
  const s = f.service({ to: 'brain-chat', env: { ...f.env, MONITOR_SUPERVISOR_AGENT: 'supervisor-test' } });
  s.pass(); s.pass();
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]; assert.equal(call.args[0], path.join(sourceRoot, 'dispatch/dispatch.mjs')); assert.equal(call.args[1], high);
  assert.ok(!call.args.includes('--to')); assert.ok(!call.args.includes('--reuse'));
  assert.equal(call.options.env.HERDR_PANE_ID, undefined); assert.equal(call.options.env.HERDR_ENV, undefined);
  assert.equal(call.options.env.MONITOR_SUPERVISOR_AGENT, 'supervisor-test');
});
test('standing order changes the next native dispatch and skips held, reserved, dependent and unselected proposals',t=>{
  const f=fixture(t),a=f.add('Stable Brain',1),b=f.add('Rehearsal',9999),ready=f.add('Independent normal work',0);
  const goal=f.record(['add','Standing outcomes','--goal']).split(' ')[0];
  const setOrder=order=>f.record(['set',goal,`meta.queue_order=${JSON.stringify(order)}`]);
  setOrder(['stable','rehearsal']);
  f.record(['set',a,'meta.queue_class=stable']);f.record(['set',b,'meta.queue_class=rehearsal']);
  const held=f.add('Real hold',20000),reserved=f.add('Reserved',19000),dependent=f.add('Dependent',18000),proposal=f.add('Unselected record',17000);
  f.record(['set',held,'meta.hold=true','meta.queue_class=stable']);
  f.record(['set',reserved,'meta.operator_reserved=true','meta.queue_class=stable']);
  f.record(['block',dependent,'--by',held]);f.record(['set',dependent,'meta.queue_class=stable']);
  // Simulate normal report-proposal provenance without invoking intake.
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-900',kind:'work',role:'engineer',title:'Spawned proposal',from_run:'R-previous',priority:30000,meta:{queue_class:'stable'}},
    {type:'item.updated',id:proposal,fields:{meta:{queue_selected:false}}}]}));
  f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],a);
  setOrder(['rehearsal','stable']);f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],b);
  f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],ready,'lower ready work is not gated by blocked higher outcomes');
  assert.ok(f.calls.every(c=>![held,reserved,dependent,proposal,'ENG-900'].includes(c.args[1])));
  f.record(['set','ENG-900','meta.queue_selected=true']);f.service({maxStarts:1}).pass();assert.equal(f.calls.at(-1).args[1],'ENG-900');
  const trace=fs.readFileSync(path.join(f.service().directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.filter(r=>r.action==='queue-order').at(-1).policy.order,['rehearsal','stable']);
});
test('standing outcome selection does not launch a child of a held or reserved ancestor',t=>{
  const f=fixture(t),parent=f.add('Held ancestor'),child=f.add('Child',999,['--parent',parent]),ready=f.add('Independent');
  f.record(['set',parent,'meta.hold=true']);f.record(['set',child,'meta.queue_selected=true']);
  f.service().pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[ready]);
  f.record(['set',parent,'meta.hold=false','meta.operator_reserved=true']);f.service().pass();assert.ok(!f.calls.some(c=>c.args[1]===child));
});
for(const change of ['standing order','candidate class','inherited class','selection'])test(`admission defers ${change} changed during capacity without spending an effect`,t=>{
  const f=fixture(t),goal=f.record(['add','Standing outcomes','--goal']).split(' ')[0];
  f.record(['set',goal,'meta.queue_order=["stable","rehearsal"]','meta.queue_class=rehearsal']);
  const a=f.add('Old preferred candidate',1),b=f.add('New preferred candidate',999,change==='inherited class'?['--parent',goal]:[]);
  f.record(['set',a,'meta.queue_class=stable']);
  if(change!=='inherited class')f.record(['set',b,`meta.queue_class=${change==='selection'?'stable':'rehearsal'}`]);
  if(change==='selection')f.record(['set',b,'meta.queue_selected=false']);
  const held=f.add('Held',10000),reserved=f.add('Reserved',9000),uncertain=f.add('Uncertain launch',8000);
  f.record(['set',held,'meta.hold=true','meta.queue_class=stable']);
  f.record(['set',reserved,'meta.operator_reserved=true','meta.queue_class=stable']);
  const directory=f.service().directory,journal=path.join(directory,'effects.json'),key=`dispatch:${uncertain}:${f.show(uncertain).created.seq}:ordinary`;
  const original={state:'started',at:'2026-10-27T00:00:00Z',error:'native outcome UNKNOWN'};
  fs.writeFileSync(journal,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:original}}));
  let changed=false;
  const s=f.service({maxStarts:1,capacity:()=>{
    if(!changed){
      changed=true;
      if(change==='standing order')f.record(['set',goal,'meta.queue_order=["rehearsal","stable"]']);
      else if(change==='candidate class')f.record(['set',b,'meta.queue_class=stable']);
      else if(change==='inherited class')f.record(['set',goal,'meta.queue_class=stable']);
      else f.record(['set',b,'meta.queue_selected=true']);
    }
    return {count:0,cap:1};
  }});
  s.pass();assert.equal(changed,true);assert.equal(f.calls.length,0,'the stale candidate never launches');
  const actions=JSON.parse(fs.readFileSync(journal)).actions;
  assert.deepEqual(Object.keys(actions),[key],'a harmless selection change creates no failed dispatch effect');
  assert.deepEqual(actions[key].at,original.at);assert.equal(actions[key].state,'started');
  s.pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[b],'the next pass recomputes the newly preferred eligible candidate');
  s.pass();assert.deepEqual(f.calls.map(c=>c.args[1]),[b,a],'the deferred candidate remains launchable later');
  assert.equal(JSON.parse(fs.readFileSync(journal)).actions[key].state,'started','the uncertain original remains occupied');
  const trace=fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(trace.some(r=>r.action==='queue-selection-changed'&&r.stage==='after-capacity'&&r.item===a));
});
test('blocked and reserved work stays held while another READY item dispatches', t => {
  const f = fixture(t), blocker = f.add('Blocker'); const blocked = f.add('Blocked', 20);
  f.record(['block', blocked, '--by', blocker]); const reserved = f.add('Reserved', 30); f.record(['set', reserved, 'meta.operator_reserved=true']);
  const ready = f.add('Ready', 10); f.service().pass(); f.service().pass(); f.service().pass();
  assert.ok(f.calls.every(call => ![blocked, reserved].includes(call.args[1])));
  assert.equal(f.calls[0].args[1], ready); assert.equal(f.notes.length,0);const notices=Object.values(JSON.parse(fs.readFileSync(path.join(f.service().directory,'effects.json'))).record_notices);assert.ok(notices.some(n=>/reserved/.test(n.reason)&&n.count===3));
});
test('STOP, HOLD and an incomplete tail prevent all effects', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service();
  fs.writeFileSync(path.join(s.directory, 'STOP'), 'stop'); assert.match(s.pass().held, /STOP/); fs.unlinkSync(path.join(s.directory, 'STOP'));
  fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/HOLD'), 'hold'); assert.match(s.pass().held, /HOLD/);
  fs.unlinkSync(path.join(f.repo, '.lane/supervisor/HOLD')); fs.appendFileSync(path.join(f.org, 'events.jsonl'), '{'); assert.match(s.pass().held, /tail/);
  assert.equal(f.calls.length, 0);
});
test('a real command refusal is recorded once and never re-executed on restart', t => {
  const f = fixture(t); f.add('Ready'); f.setFailure('native permission refused'); const s = f.service(); s.pass(); f.service().pass(); f.service().pass();
  assert.equal(f.calls.length, 1);
  const evidence = JSON.parse(fs.readFileSync(path.join(s.directory, 'effects.json'))); const action = Object.values(evidence.actions)[0];
  assert.equal(action.state, 'held'); assert.equal(action.receipt.status, 1); assert.match(action.error, /native permission/);
  assert.ok(f.notes.length <= 2);
});
test('unknown native capacity holds dispatch without spending an effect', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service({ capacity: () => { throw Object.assign(Error('actual cap reached'), { code: 'DISPATCH_SESSION_CAP' }); } });
  s.pass(); assert.equal(f.calls.length, 0);
  f.service().pass(); assert.equal(f.calls.length, 1);
});
test('singleton rejects a concurrent pass without stealing its owner', t => {
  const f = fixture(t); f.add('Ready'); const s = f.service(), release = noticeLock(path.join(s.directory, 'pass.lock'));
  try { assert.throws(() => s.pass(), /locked/); assert.equal(f.calls.length, 0); } finally { release(); }
  s.pass(); assert.equal(f.calls.length, 1);
});
test('existing uncertain native review on any item run holds a second review', t => {
  const f = fixture(t), item = f.add('Code');
  const run = f.record(['start', item, '--workspace', f.repo]).match(/R-\d+/)[0];
  const events = loadEvents(f.org).events, identity = gitProject(f.repo).identity, current = fold(events).items.get(item);
  const directory = path.join(f.org, 'retirement/occupants'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'native.json'), JSON.stringify({ kind: 'settle', common: identity, run }));
  assert.equal(reviewAttempt(current, { org: f.org, identity, events }), 'existing native reviewer');
});
test('launchd uses only actual transport paths, an explicit project and no caller identity', () => {
  const plist = launchPlist({ label: 'fixture', repo: '/project', org: '/record', to: 'supervisor-test', herdr: '/bin/herdr', socket: '/actual/socket', directory: '/record/service', node: '/node20', searchPath: '/bin', interval: 30 });
  assert.match(plist, /--once/); assert.match(plist, /StartInterval.*30/); assert.match(plist, /HERDR_SOCKET_PATH/);
  assert.doesNotMatch(plist, /HERDR_ENV|PANE_ID|SESSION_ID|THREAD_ID/);
  assert.ok(!plist.includes('KeepAlive')); assert.match(plist, /<string>\/project<\/string>/);
});

test('historical closed, retired and unclaimed reports do not recreate review debt or disturb a held review', t => {
  const f = fixture(t);
  const reported = (title, workspace, owned = false, outcome = 'done') => {
    const item = f.add(title), run = f.record(['start', item, '--workspace', workspace]).match(/R-\d+/)[0];
    if (owned) f.record(['claim', run, '--controller', 'brain']);
    const file = f.show(run).report_path;
    fs.writeFileSync(file, `---\nrun: ${run}\noutcome: ${outcome}\nsummary: Historical completed work.\nheadline: Historical work finished\nblockers: []\nproposals: []\nartifacts: []\n---\n`);
    f.record(['ingest', file]); return { item, run };
  };
  const old = reported('Old closed work', f.repo); f.record(['close', old.item]);
  const retired = path.join(f.repo, 'retired'); fs.mkdirSync(retired);
  const missing = reported('Retired work', retired, true); fs.rmSync(retired, { recursive: true });
  reported('Old unclaimed work', f.repo);
  const held = reported('Recent held async review', f.repo, true, 'blocked'), saved = path.join(f.org, 'settle', `${held.run}.json`);
  fs.mkdirSync(path.dirname(saved), { recursive: true }); const receipt = '{"stage":"reviewing","reason":"native refusal; preserve original attempt"}\n'; fs.writeFileSync(saved, receipt);
  const ready = f.add('Independent ready work', 9);
  f.service().pass(); f.service().pass();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args[1], ready);
  assert.equal(f.notes.length, 0); assert.equal(fs.readFileSync(saved, 'utf8'), receipt);
  assert.equal(f.show(missing.run).abandoned, null); assert.equal(f.show(held.item).closed, null);
});

test('source inventory includes line-service and its release controls while retaining runtime parity guard', t => {
  const f = fixture(t);
  for (const name of ['line-service', 'lib']) fs.mkdirSync(path.join(f.repo, name));
  fs.writeFileSync(path.join(f.repo, 'line-service/line-service.mjs'), 'export const service = true;\n');
  fs.writeFileSync(path.join(f.repo, 'lib/module.mjs'), 'export const guard = true;\n');
  f.git(['add', 'line-service', 'lib']); f.git(['commit', '-qm', 'Runtime fixture']);
  const captured = captureProductCheckout(f.repo);
  assert.ok(captured.runtime.includes('line-service/line-service.mjs'));
  assert.ok(tierFiles('release').includes('test/line-service.test.mjs'));
  fs.writeFileSync(path.join(f.repo, 'lib/.DS_Store'), 'Finder metadata');
  assert.throws(() => captureProductCheckout(f.repo), /source runtime inventory mismatch/);
  fs.unlinkSync(path.join(f.repo, 'lib/.DS_Store'));
  fs.writeFileSync(path.join(f.repo, 'lib/untracked-runtime.mjs'), 'export const extra = true;\n');
  assert.throws(() => captureProductCheckout(f.repo), /source runtime inventory mismatch/);
});

function completedSource(f) {
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.org/\n.lane/\n');
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Committed fixture routing']);
  const item = f.add('Finished source'), run = f.record(['start', item, '--workspace', f.repo]).match(/R-\d+/)[0];
  f.record(['claim', run, '--controller', 'brain']);
  const file = f.show(run).report_path;
  fs.writeFileSync(file, `---\nrun: ${run}\noutcome: done\nsummary: The committed source is finished.\nheadline: The source is finished\nblockers: []\nproposals: []\nartifacts: []\n---\n`);
  f.record(['ingest', file]);
  const saved = path.join(f.org, 'settle', `${run}.json`), review = '{"stage":"reviewing","reason":"native review held; no retry"}\n';
  fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.writeFileSync(saved, review);
  const command = (exe, args, options) => {
    f.calls.push({ exe, args, options });
    if (args[0] === path.join(sourceRoot, 'bin/org.mjs') && args[1] === 'close') {
      const directory = f.activeService.directory, effects = JSON.parse(fs.readFileSync(path.join(directory, 'effects.json')));
      assert.equal(Object.entries(effects.actions).find(([key]) => key.startsWith(`source-complete:${run}:`))?.[1].state, 'started');
      assert.equal(options.env.ORG_GUARD_OVERRIDE, undefined); assert.equal(options.env.ORG_ACTOR, 'line-service');
      return spawnSync(exe, args, options); // Real conditional record transaction, not an invented receipt.
    }
    return { status: 0, stdout: JSON.stringify({ result: 'dispatched' }), stderr: '' };
  };
  return { item, run, saved, review, command };
}

test('conditional source completion closes real done source while retaining review and physical holds', t => {
  const f = fixture(t), done = completedSource(f);
  fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'), 'physical hold');
  const ready = f.add('Independent ready work', 9);
  f.activeService = f.service({ command: done.command, env: { ...f.env, ORG_GUARD_OVERRIDE: 'forbidden-inherited-override' } });
  f.activeService.pass(); f.activeService.pass();
  assert.equal(f.show(done.item).closed.as, 'done'); assert.equal(fs.readFileSync(done.saved, 'utf8'), done.review);
  assert.ok(fs.existsSync(path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE')));
  const closes = f.calls.filter(c => c.args[1] === 'close'); assert.equal(closes.length, 1);
  assert.deepEqual(closes[0].args.slice(1, 5), ['close', done.item, '--if-current-run', done.run]);
  assert.ok(f.calls.some(c => c.args[0].endsWith('/dispatch/dispatch.mjs') && c.args[1] === ready));
  const effects = JSON.parse(fs.readFileSync(path.join(f.activeService.directory, 'effects.json'))), entry = Object.entries(effects.actions).find(([key]) => key.startsWith(`source-complete:${done.run}:`))[1];
  assert.equal(entry.state, 'complete'); assert.equal(entry.result.close.status, 0); assert.equal(entry.result.report_sha256, f.show(done.run).report.sha256);
});

test('conditional source completion retains an exact needs-judgment refusal once and continues independent work', t => {
  const f = fixture(t), done = completedSource(f);
  f.record(['close', done.item, '--if-current-run', done.run]); f.record(['reopen', done.item]);
  const ready = f.add('Independent ready work', 9);
  f.activeService = f.service({ command: done.command,alertAfter:1 }); f.activeService.pass(); f.activeService.pass();
  assert.equal(f.show(done.item).closed, null); assert.equal(fs.readFileSync(done.saved, 'utf8'), done.review);
  const closes = f.calls.filter(c => c.args[1] === 'close'); assert.equal(closes.length, 1);
  assert.ok(closes[0].args.includes('--if-current-run'));
  const notes=Object.values(JSON.parse(fs.readFileSync(path.join(f.activeService.directory,'effects.json'))).record_notices).filter(n=>n.boundary.startsWith(`source-complete:${done.run}:`));
  assert.equal(notes.length,1);assert.match(notes[0].reason,/reopened after completion.*conditional close needs supervisor judgment/);assert.equal(f.notes.length,0);
  assert.ok(f.calls.some(c => c.args[0].endsWith('/dispatch/dispatch.mjs') && c.args[1] === ready));
  const effects = JSON.parse(fs.readFileSync(path.join(f.activeService.directory, 'effects.json'))), entry = Object.entries(effects.actions).find(([key]) => key.startsWith(`source-complete:${done.run}:`))[1];
  assert.equal(entry.state, 'held'); assert.notEqual(entry.receipt.status, 0); assert.match(entry.receipt.stderr, /supervisor judgment/);
});

test('producer linked source completion retains an old held effect without fabricating a landing and queues one defect',t=>{
  const f=fixture(t),done=completedSource(f);f.activeService=f.service({command:done.command});
  const run=f.show(done.run),directory=f.activeService.directory,file=path.join(directory,'effects.json'),key=`source-complete:${done.run}:${run.report.sha256}`;
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T00:00:00Z',repo:f.repo,org:f.org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  fs.writeFileSync(file,JSON.stringify({identity:gitProject(f.repo).identity,org:f.org,actions:{[key]:{state:'held',at:'2026-10-26T00:00:00Z',error:'reported head was not integrated'}},notices:{}}));
  f.activeService.pass();f.activeService.pass();assert.equal(f.show(done.item).closed,null);
  const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.actions[key].state,'held');assert.equal(Object.keys(saved.outcome_decisions).length,1);
  assert.equal(f.calls.filter(c=>c.args[1]==='close').length,0);assert.equal(fs.readFileSync(done.saved,'utf8'),done.review);
});
