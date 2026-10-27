import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { fixture, hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';
import { assertFixtureScratch } from './helpers/scratch-fixture.mjs';
import { setTimeout as pause } from 'node:timers/promises';
import { loadTimeout } from '../lib/deadline.mjs';
import { initOrg, loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { joinFleet } from '../lib/fleet.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { completedCloseoutKeys, handoffCloseout, migrateCloseout } from '../lib/closeout-handoff.mjs';
import { completionFingerprint, digest } from '../lib/completion.mjs';
import { bindCloseoutSources, publishCloseoutEvents, readCloseoutEntries, readyLane, retryCloseout,
  closeoutPolicy, recordCompletedReview, retirementOwnerLock, retryPromotionCloseout, closeoutRevision, pruneCompletedCloseout, closeoutKey,
  recoverLane,closeoutOutcomeObservation,safeCloseoutRetry,scheduleLineCloseouts } from '../lib/closeout.mjs';
import { reconcile } from '../supervisor/reconcile.mjs';
import { retirementLock } from '../lib/retire-lock.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { drainCloseout } from '../lib/closeout-consumer.mjs';
import { createHousekeeping, tidyFinishedTabs } from '../housekeeping/housekeeping.mjs';
import { enqueue, finishCleanup, retryCleanup, drain as drainPromotions, queueFor } from '../promote/promote.mjs';
import { stopFixtureInbox } from './helpers/inbox.mjs';
import { retirementStatus, renderRetirementStatus } from '../lib/retire-status.mjs';
import { outstandingEffects } from '../lib/run-owner.mjs';
import { readCloseoutOwnerStatus } from '../lib/closeout-code.mjs';
import { prepareCloseoutPacket, readCloseoutCapabilities } from '../lib/closeout-packet.mjs';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';
import { gitProject } from '../lib/project.mjs';
import { readProjectPolicy } from '../lib/config-policy.mjs';
import { kickCloseout } from '../lib/closeout.mjs';
import {closeoutEvaluations} from '../lib/closeout.mjs';
import {readCloseoutObservations,appendCloseoutObservation} from '../lib/closeout-diagnostics.mjs';

const cli = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const closer = fileURLToPath(new URL('../supervisor/closeout.mjs', import.meta.url));
const lanes = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const retirementCLI = fileURLToPath(new URL('../supervisor/retire.mjs', import.meta.url));
const events = f => loadEvents(f.org).events;
async function waitForChange(_files, predicate, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + loadTimeout(timeoutMs);
  while (!predicate()) { if (Date.now() >= deadline) throw Error('bounded fixture observation timed out'); await pause(25); }
}
function setup(t, { occupied = true, merged = false, terminal = false } = {}) {
  const f = occupied ? exitFixture(t) : fixture(t, { occupied, merged });
  if (occupied && !merged) f.git(['reset', '--hard', `${f.head}^`]);
  isolatedEnv(t, f);
  fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.org\n.lane/\n');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { closeout_queue: true } }));
  fs.writeFileSync(f.eventFile, events(f).filter(e => e.type !== 'item.closed' && e.type !== 'report.ingested').map(e => JSON.stringify(e) + '\n').join(''));
  const commands = sweepCommands(f);
  const options = { herdr: f.job.herdr, command: commands.command,
    log: row => { if (row.action === 'scratch-manifest') assertFixtureScratch(row.manifest, f.env, options.scratchRoots); },
    readOwner: owner => (f.read().info?.process_tree ?? []).some(p => p.pid === owner.pid && p.identity === owner.identity) };
  f.receipts = new Map();
  f.autoTail = true;
  f.append = add => {
    // Existing lifecycle cases own a completed post-return tail. New ordering
    // witnesses explicitly disable this helper and exercise the missing tail.
    add = add.map(e => {
      if (e.type !== 'promotion.reconciled') return e;
      const state = fold([...events(f), ...add]), id = e.batch ?? `fixture-${events(f).length}`;
      const log = path.join(f.scratch, `${id}.gate.log`); fs.writeFileSync(log, 'successful offline gate\n');
      const payload = { version: 1, batch: id, org: f.org, identity: f.common,
        base: f.git(['rev-parse', 'HEAD']), tip: e.tip ?? f.git(['rev-parse', 'HEAD']),
        gate: { exit_code: 0, log, sha256: createHash('sha256').update(fs.readFileSync(log)).digest('hex') },
        items: e.heads.map(h => ({ ...h, item: h.item ?? state.runs.get(h.run).item, superseded: [] })), excluded: [] };
      const receipt = path.join(f.scratch, `${id}.record.json`); fs.writeFileSync(receipt, JSON.stringify(payload));
      f.receipts.set(id, receipt);
      return { ...e, batch: id, base: payload.base, tip: payload.tip, gate: payload.gate, fingerprint: digest(payload), heads: payload.items.map(({item,run,head}) => ({item,run,head})) };
    });
    const result = transact(f.org, current => bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add } }), { actor: 'fixture' });
    publishCloseoutEvents({ cwd: f.repo, org: f.org, added: result.added, start: false, env: f.env });
    if (f.autoTail) for (const source of result.added.filter(e => e.type === 'promotion.reconciled')) {
      const state = fold(events(f));
      if (source.heads.every(h => state.runs.get(h.run)?.report && state.items.get(h.item)?.closed?.as === 'done'))
        handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
    }
    return result.added;
  };
  f.options = options;
  f.drain = extra => drainCloseout({ cwd: f.repo, org: f.org, env: f.env, retirementOptions: options, ...extra });
  f.report = () => f.append([{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' }]);
  f.land = () => { f.git(['merge', '--ff-only', f.head]); return f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }, {
    type: 'promotion.reconciled', identity: f.common, batch: 'fixture', tip: f.head,
    heads: [{ run: 'R-1', item: 'ENG-1', head: f.head }], runs: ['R-1'], items: ['ENG-1'],
  }]); };
  if (terminal) { f.report(); f.land(); }
  return f;
}
const evaluations = f => [...events(f).filter(e => e.type === 'closeout.evaluated'),...readCloseoutObservations(f.common,f.org,events(f))].sort((a,b)=>(a.seq??a.observed_seq)-(b.seq??b.observed_seq));
const effects = f => events(f).filter(e => e.type === 'closeout.effect').map(e => e.outcome);

test('producer linked ordinary native exit and close publish exact completion links and passive stage timings',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  const result=f.drain({keys:[entry.key]});assert.equal(result.evaluated[0].completed,true,JSON.stringify(result));
  const all=events(f),statuses=all.filter(e=>e.type==='closeout.producer-status'&&e.key===entry.key);
  assert.ok(statuses.some(e=>e.producer.action==='agent-exit-requested'&&e.status==='complete'));
  assert.ok(statuses.some(e=>e.producer.action==='shell-close-requested'&&e.status==='complete'));
  for(const status of statuses)assert.ok(all.some(e=>e.seq===status.completion.seq&&e.type===status.completion.type));
  assert.ok(result.evaluated[0].stages.apply_ms>=0);assert.ok(result.evaluated[0].stages.remove_lane_ms>=0);
  const before=f.read().actions.length;assert.deepEqual(f.drain({keys:[entry.key]}).evaluated,[]);assert.equal(f.read().actions.length,before);
});

test('producer linked unresolved native waits do not replay or reobserve after manual retry or elapsed time',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:rows[0].seq,type:'item.closed'},effect:'original-intent',outcome:{action:'agent-exit-requested',run:'R-1',pane:'w:p',tab_id:'w:t',occupant:['worker','codex','w:p','w',f.lane,'term','session'],shell:{pid:1,identity:'shell',command:'[zsh]'}}}]);
  const first=f.drain({keys:[entry.key]});assert.equal(first.evaluated[0].completed,false);
  const calls=f.herdrCalls().length;f.append([{type:'closeout.retry',identity:f.common,keys:[entry.key],why:'old manual retry cannot resolve a missing runtime producer'}]);
  assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);assert.equal(f.herdrCalls().length,calls);assert.deepEqual(f.read().actions,[]);
  const wait=events(f).findLast(e=>e.type==='closeout.waiting'&&e.key===entry.key&&e.revision!==undefined);assert.match(wait.waiting.defect,/no existing runtime transport/);
});

test('cleanup tail publishes every final report and abandonment without closing the item',t=>{
  for(const outcome of ['done','blocked','needs_human','failed','abandoned']){
    const f=setup(t,{merged:true});
    const add=outcome==='abandoned'?[{type:'run.abandoned',id:'R-1'}]:[{type:'report.ingested',run:'R-1',report:{outcome,summary:'Allocation finished'},sha256:'fixture'}];
    const rows=f.append(add),entry=readCloseoutEntries(f.common).find(e=>e.run==='R-1');
    assert.ok(entry,`${outcome} must publish an evaluation request`);assert.equal(entry.signal,'ready');
    assert.equal(fold(events(f)).items.get('ENG-1').closed,null);assert.equal(rows[0].closeout_targets[0].run,'R-1');
  }
});

function historicalTail(t,{kind='eligible'}={}){
  const f=setup(t,{merged:true}),raw=events(f);
  const meta=raw.find(e=>e.type==='run.started').meta;
  if(kind==='unknown')delete meta.agent_session_id;
  fs.writeFileSync(f.eventFile,raw.map(e=>JSON.stringify(e)+'\n').join(''));
  transact(f.org,()=>({add:[{type:'report.ingested',run:'R-1',report:{outcome:'blocked',summary:'old final allocation'},sha256:'old'}]}));
  if(kind==='refused'){
    const all=events(f);all.find(e=>e.type==='report.ingested').report.summary='EPERM original native refusal remains held';
    fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
  }
  if(kind==='working'){f.state.agents[0].agent_status='working';f.save();}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unique-uncommitted'),'retain');
  if(kind==='unlanded')f.git(['reset','--hard',`${f.head}^`]);
  if(kind==='reused')transact(f.org,()=>({add:[{type:'run.started',id:'R-2',item:'ENG-1',workspace:f.lane,meta:{...meta}}]}));
  if(kind==='foreign'){f.state.workspaces[0].worktree.repo_key='/foreign/common';f.save();}
  selectCurrentCleanup(f);
  if(kind==='uncertain'){
    const source=f.append([{type:'lane.ready',common:f.common,run:'R-1'}])[0],entry=readCloseoutEntries(f.common)[0],c=f.retirement(f.options).plan(f.lane).close[0];
    f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:source.seq,type:source.type},effect:'retained-original',outcome:{action:'agent-exit-requested',run:c.run,pane:c.pane,tab_id:c.tab_id,occupant:c.occupant,shell:c.shell}}]);
  }
  return f;
}

test('cleanup tail creates a separate verified historical binding under the paired current policy',async t=>{
  const f=historicalTail(t),{refreshCloseouts}=await import('../lib/closeout-consumer.mjs');assert.equal(typeof refreshCloseouts,'function');
  selectCurrentCleanup(f);const before=fs.readFileSync(f.eventFile),result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  assert.equal(result.created.length,1,JSON.stringify(result));const entry=readCloseoutEntries(f.common)[0];
  assert.equal(entry.source.type,'cleanup.bound');assert.equal(entry.signal,'landed');assert.equal(entry.panes[0].session,'session');
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before,'original launch and report history stay immutable');
  assert.equal(refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options}).created.length,0,'binding is resource-deduplicated');
  const next=f.drain({keys:[entry.key],sessionsOnly:true});assert.equal(next.evaluated[0]?.sessions_retired,true,JSON.stringify(next));
  assert.equal(f.drain({keys:[entry.key],retrySafe:true}).evaluated[0]?.completed,true);
});

test('cleanup tail explicit abandonment permits only a guarded content-released allocation',t=>{
  const f=setup(t,{merged:true});f.append([{type:'run.abandoned',id:'R-1'}]);const entry=readCloseoutEntries(f.common)[0];
  assert.ok(entry);const result=f.drain({keys:[entry.key],sessionsOnly:true});
  assert.equal(result.evaluated[0]?.sessions_retired,true,JSON.stringify(result));assert.equal(fs.existsSync(f.lane),true);
  assert.equal(fold(events(f)).items.get('ENG-1').closed,null);
});

test('cleanup tail historical discovery retains working reused foreign unknown dirty and unlanded allocations',async t=>{
  const {refreshCloseouts}=await import('../lib/closeout-consumer.mjs');assert.equal(typeof refreshCloseouts,'function');
  for(const kind of ['working','reused','foreign','unknown','dirty','unlanded','refused','uncertain']){
    const f=historicalTail(t,{kind}),bytes=fs.readFileSync(f.eventFile),result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
    assert.deepEqual(result.created,[],`${kind}: ${JSON.stringify(result)}`);assert.deepEqual(fs.readFileSync(f.eventFile),bytes);assert.deepEqual(f.read().actions,[]);
  }
});

test('cleanup tail fresh binding preserves an exact active settle reference as an executor fence',async t=>{
  const f=historicalTail(t),{refreshCloseouts}=await import('../lib/closeout-consumer.mjs');
  const directory=path.join(f.org,'settle');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'R-1.json'),JSON.stringify({common:f.common,run:'R-1',workspace:f.lane,stage:'reviewing'}));
  const created=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});assert.equal(created.created.length,1,JSON.stringify(created));
  const entry=readCloseoutEntries(f.common).find(e=>e.key===created.created[0]),bytes=fs.readFileSync(path.join(f.common,'closeout/entries',entry.key+'.json'));
  const result=f.drain({keys:[entry.key],sessionsOnly:true});assert.match(result.evaluated[0]?.reason??'',/settle callback reference/);
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(fs.readFileSync(path.join(f.common,'closeout/entries',entry.key+'.json')),bytes);
  assert.equal(f.read().actions.length,0);
});

test('cleanup tail physical CAS tolerates unrelated completed settle receipt activity',t=>{
  const f=setup(t,{merged:true});f.report();f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);const entry=readCloseoutEntries(f.common).find(e=>e.signal==='landed');
  assert.equal(f.drain({keys:[entry.key],sessionsOnly:true}).evaluated[0]?.sessions_retired,true);
  const dir=path.join(f.org,'settle');fs.mkdirSync(dir,{recursive:true});const command=f.options.command;let observed=0;
  f.options.command=(exe,args,options)=>{if(exe===f.job.herdr)fs.writeFileSync(path.join(dir,'R-9999.json'),JSON.stringify({common:f.common,run:'R-9999',workspace:path.join(f.scratch,'other'),stage:'complete',observed:++observed}));return command(exe,args,options);};
  const result=f.drain({keys:[entry.key],retrySafe:true});assert.equal(result.evaluated[0]?.completed,true,JSON.stringify(result));assert.equal(fs.existsSync(f.lane),false);assert.ok(observed>1);
});

test('cleanup tail observes original absent allocation without inventing process exit or claim release',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=readCloseoutEntries(f.common).find(e=>e.signal==='landed');
  const c=f.retirement(f.options).plan(f.lane).close[0];
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,effect:'original-lost-reply',outcome:{action:'agent-exit-requested',run:c.run,pane:c.pane,tab_id:c.tab_id,occupant:c.occupant,shell:c.shell}}]);
  f.state.agents=[];f.state.panes=[];f.state.tabs=[];f.save();const before=f.read().actions.length;
  const readback=f.drain({keys:[entry.key],retrySafe:true});assert.ok(effects(f).some(e=>e.action==='allocation-absent'),JSON.stringify(readback));
  assert.equal(effects(f).some(e=>e.action==='exit-observed'),false);assert.equal(effects(f).some(e=>e.action==='closed'),false);
  assert.equal(readback.evaluated[0]?.completed,false);assert.equal(fs.existsSync(f.lane),true);assert.equal(f.read().actions.length,before);
  const finish=f.drain({keys:[entry.key],retrySafe:true});assert.equal(finish.evaluated[0]?.completed,true,JSON.stringify(finish));
});

test('cleanup tail absence readback keeps moved replaced refused and unpreserved original scopes',t=>{
  for(const kind of ['moved','replaced','refused','unpreserved']){
    const f=setup(t,{merged:true});f.report();f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);const entry=readCloseoutEntries(f.common).find(e=>e.signal==='landed'),c=f.retirement(f.options).plan(f.lane).close[0];
    f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,effect:'original-intent',outcome:{action:'agent-exit-requested',run:c.run,pane:c.pane,tab_id:c.tab_id,occupant:c.occupant,shell:c.shell}}]);
    if(kind==='moved'){f.state.agents[0].pane_id='moved:p';f.state.panes=[];f.state.tabs=[];}
    if(kind==='replaced'){f.state.agents=[];f.state.panes[0].terminal_id='replacement';}
    if(kind==='refused')f.append([{type:'closeout.evaluated',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,revision:closeoutRevision(entry,events(f)),completed:false,reason:'EPERM native refusal; retain original'}]);
    if(kind==='unpreserved'){f.state.agents=[];f.state.panes=[];f.state.tabs=[];f.git(['worktree','remove',f.lane]);}
    f.save();const bytes=fs.readFileSync(path.join(f.common,'closeout/entries',entry.key+'.json')),before=f.read().actions.length;
    f.drain({keys:[entry.key],retrySafe:true});assert.equal(effects(f).some(e=>e.action==='allocation-absent'),false,kind);assert.equal(f.read().actions.length,before,kind);
    assert.deepEqual(fs.readFileSync(path.join(f.common,'closeout/entries',entry.key+'.json')),bytes);
  }
});

test('cleanup tail fair serial batches continue independent targets and put attempted failures last',()=>{
  const sessions=Array.from({length:5},(_,n)=>({key:`s${n}`,signal:'ready',source:{seq:n+1},panes:[{pane:`p${n}`}]})),physical={key:'landed',signal:'landed',source:{seq:10},panes:[]},bookkeeping={key:'book',signal:'ready',source:{seq:11},panes:[]};
  const result=scheduleLineCloseouts([...sessions,bookkeeping,physical],[],{batch:true,attempts:{s0:2,s1:1}});
  assert.equal(result.length,7);assert.ok(result.findIndex(x=>x.entry.key==='s0')>result.findIndex(x=>x.entry.key==='s1'));
  assert.ok(result.findIndex(x=>x.entry.key==='landed')<result.findIndex(x=>x.entry.key==='book'));
  assert.equal(new Set(result.map(x=>x.entry.key)).size,7);
});
function selectCurrentCleanup(f) {
  const directory = path.join(f.org, 'line-service', createHash('sha256').update(JSON.stringify(f.common)).digest('hex').slice(0, 20));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'installation.json');
  const receipt = { repo: f.repo, org: f.org, source: sourceRoot, node: process.execPath,
    file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` };
  fs.writeFileSync(file, JSON.stringify(receipt));
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { closeout_queue: false, line_service_cleanup: true } }));
  return { file, receipt, directory };
}

test('current cleanup selection suppresses the frozen c160 kick and binds future sources for the named current closer', t => {
  const f = setup(t, { occupied: false }), project = gitProject(f.repo);
  selectCurrentCleanup(f);
  const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/closeout-c160-selection.json', import.meta.url)));
  const policy = new Function('readProjectPolicy', 'fs', `return (${legacy.policy})`)(readProjectPolicy, fs);
  const kick = new Function('closeoutPolicy', 'closeoutRecordMatches', 'queueTransaction', `return (${legacy.kick})`)(
    policy, () => true, () => { throw Error('legacy kick reached queue/spawn'); });
  assert.equal(policy(f.repo), false);
  assert.deepEqual(kick(project, f.org), { evaluated: [] });
  assert.equal(closeoutPolicy(f.repo, 'report.ingested'), true);
  const source = f.report()[0];
  assert.equal(source.closeout_targets.length, 1);
  f.land();
  assert.equal(kickCloseout(project, f.org, { env: f.env }).owned_by, 'line-service');
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false);
  assert.equal(f.drain().owned_by, 'line-service');
  const keys = readCloseoutEntries(f.common).map(e => e.key);
  assert.ok(keys.includes(source.closeout_targets[0].key));
  const result = f.drain({ keys });
  assert.ok(result.evaluated.some(e => e.completed), JSON.stringify(result));
  assertRemoved(f);
});

test('current cleanup selection keeps defaults opt-outs malformed foreign and redirected declarations safe and lossless', t => {
  const f = setup(t, { occupied: false, terminal: true }), selected = selectCurrentCleanup(f);
  const entries = readCloseoutEntries(f.common), keys = entries.map(e => e.key);
  const files = entries.map(e => path.join(f.common, 'closeout/entries', `${e.key}.json`));
  const bytes = files.map(file => fs.readFileSync(file)), record = fs.readFileSync(f.eventFile);
  const policyFile = path.join(f.repo, '.lane.json');
  for (const retirement of [{}, { closeout_queue: false }, { closeout_queue: false, line_service_cleanup: false }]) {
    fs.writeFileSync(policyFile, JSON.stringify({ retirement }));
    assert.equal(closeoutPolicy(f.repo, 'report.ingested'), false);
    if (retirement.closeout_queue === false) assert.equal(f.drain({ keys }).disabled, true);
  }
  for (const retirement of [{ line_service_cleanup: true }, { closeout_queue: true, line_service_cleanup: true },
    { closeout_queue: false, line_service_cleanup: 'true' }]) {
    fs.writeFileSync(policyFile, JSON.stringify({ retirement }));
    assert.throws(() => closeoutPolicy(f.repo), /invalid|requires|boolean/);
  }
  selectCurrentCleanup(f);
  for (const change of [{ source: f.repo }, { repo: f.lane }, { org: f.scratch }, { node: '/foreign/node' },
    { target: 'foreign' }, { file: path.join(f.scratch, 'service.plist') }]) {
    fs.writeFileSync(selected.file, JSON.stringify({ ...selected.receipt, ...change }));
    assert.throws(() => f.drain({ keys }), /ownership is UNKNOWN/);
  }
  fs.unlinkSync(selected.file);
  assert.equal(closeoutPolicy(f.repo), false, 'no declared current owner means no fallback consumer');
  const redirected = path.join(f.scratch, 'installation.json');
  fs.writeFileSync(redirected, JSON.stringify(selected.receipt)); fs.symlinkSync(redirected, selected.file);
  assert.throws(() => f.drain({ keys }), /redirected/);
  fs.unlinkSync(selected.file); fs.writeFileSync(selected.file, '{');
  assert.throws(() => closeoutPolicy(f.repo), /JSON/);
  assert.deepEqual(fs.readFileSync(f.eventFile), record);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]));
  assert.deepEqual(f.read().actions, []);
});

test('current cleanup selection retains HOLD native refusal and original unknown effects without rewriting queued bytes', t => {
  for (const kind of ['HOLD', 'native', 'unknown']) {
    const f = setup(t, { merged: true }); selectCurrentCleanup(f); f.report();
    const source = f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done', completed_run: 'R-1' }])[0];
    const entry = readCloseoutEntries(f.common).find(e => e.key === source.closeout_targets[0].key);
    if (kind === 'HOLD') hold(f);
    if (kind === 'native') f.options.command = () => { throw Error('native refusal EPERM'); };
    if (kind === 'unknown') {
      const candidate = f.retirement(f.options).plan(f.lane).close[0];
      f.append([{ type: 'closeout.effect', key: entry.key, identity: f.common, run: 'R-1', item: 'ENG-1', source: entry.source,
        effect: 'original-intent', outcome: { action: 'agent-exit-requested', run: candidate.run, pane: candidate.pane,
          tab_id: candidate.tab_id, occupant: candidate.occupant, shell: candidate.shell } }]);
    }
    const file = path.join(f.common, 'closeout/entries', `${entry.key}.json`), before = fs.readFileSync(file);
    const result = f.drain({ keys: [entry.key], sessionsOnly: true, retrySafe: true });
    assert.equal(result.evaluated[0]?.completed, false, JSON.stringify(result));
    assert.match(result.evaluated[0].reason, /HOLD|held|EPERM|native|unresolved/i);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(f.read().actions, []);
    assert.equal(fs.existsSync(f.lane), true);
  }
});

test('cleanup handoff packet preserves every queue byte and original birth identity across live unknown later and absent owners', t => {
  for (const kind of ['original', 'later', 'absent']) {
    const f = setup(t, { occupied: false, terminal: true });
    const keys = readCloseoutEntries(f.common).map(e => e.key);
    const lock = path.join(f.common, 'closeout/consumer.lock');
    const owner = { pid: 91833, identity: '1793081341:121264', token: 'original',
      argv: [process.execPath, '/installed/c160/supervisor/closeout.mjs', 'drain', '--keys', JSON.stringify(keys), '--deadline', '1'] };
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
    const originalFile = path.join(f.scratch, 'original-owner.json');
    fs.writeFileSync(originalFile, JSON.stringify(readCloseoutOwnerStatus({ cwd: f.repo, org: f.org, env: f.env })));
    if (kind === 'later') fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ ...owner, pid: 92400, identity: 'new-birth', token: 'later' }));
    if (kind === 'absent') fs.rmSync(lock, { recursive: true });
    const directory = path.join(f.common, 'closeout/entries'), extra = 'b'.repeat(64) + '.json';
    const opaque = Buffer.from([0, 255, 10, 123]);
    fs.writeFileSync(path.join(directory, extra), opaque);
    const before = new Map(fs.readdirSync(directory).map(n => [n, fs.readFileSync(path.join(directory, n))]));
    const record = fs.readFileSync(f.eventFile), status = fs.readFileSync(originalFile);
    const packet = prepareCloseoutPacket({ cwd: f.repo, org: f.org, env: f.env, originalFile,
      candidateRoot: fileURLToPath(new URL('../', import.meta.url)) });
    assert.deepEqual(packet.keys, keys); assert.equal(packet.effects, 0); assert.equal(packet.effects_authorized, false);
    assert.equal(packet.original_outcome, 'UNKNOWN'); assert.equal(packet.original_release, 'UNKNOWN');
    assert.deepEqual(packet.original.claims.consumer.owner, owner);
    assert.deepEqual(Buffer.from(packet.original.base64, 'base64'), status);
    assert.equal(packet.queue.length, before.size);
    for (const entry of packet.queue) {
      assert.deepEqual(Buffer.from(entry.base64, 'base64'), before.get(entry.name));
      assert.equal(entry.sha256, createHash('sha256').update(before.get(entry.name)).digest('hex'));
      assert.deepEqual(fs.readFileSync(path.join(directory, entry.name)), before.get(entry.name));
    }
    assert.equal(packet.current_claims.consumer.liveness, 'UNKNOWN');
    assert.equal(packet.current_claims.consumer.state, kind === 'absent' ? 'absent' : 'stored');
    if (kind === 'later') assert.equal(packet.current_claims.consumer.owner.token, 'later');
    assert.equal(packet.candidate.supported, true);
    assert.equal(packet.phases.length, 2); assert.ok(packet.phases[0].argv.includes('--sessions-only'));
    assert.equal(packet.phases[1].argv.includes('--sessions-only'), false);
    assert.deepEqual(fs.readFileSync(f.eventFile), record); assert.deepEqual(f.read().actions, []);
    if (kind === 'original') {
      const reply = spawnSync(process.execPath, [closer, 'packet', '--repo', f.repo, '--org', f.org,
        '--original', originalFile, '--candidate', fileURLToPath(new URL('../', import.meta.url))], { env: f.env, encoding: 'utf8' });
      assert.equal(reply.status, 0, reply.stderr); assert.equal(JSON.parse(reply.stdout).effects_authorized, false);
    }
  }
});

test('cleanup handoff packet refuses partial foreign ambiguous or redirected preparations without acquiring claims', t => {
  const f = setup(t, { occupied: false, terminal: true });
  const keys = readCloseoutEntries(f.common).map(e => e.key), lock = path.join(f.common, 'closeout/consumer.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 91833, identity: 'kernel-birth', token: 'original',
    argv: [process.execPath, '/installed/c160/supervisor/closeout.mjs', 'drain', '--keys', JSON.stringify(keys)] }));
  const original = readCloseoutOwnerStatus({ cwd: f.repo, org: f.org, env: f.env }), originalFile = path.join(f.scratch, 'original.json');
  const options = { cwd: f.repo, org: f.org, env: f.env, originalFile, candidateRoot: fileURLToPath(new URL('../', import.meta.url)) };
  for (const kind of ['foreign', 'missing-birth', 'ambiguous', 'partial']) {
    const changed = structuredClone(original);
    if (kind === 'foreign') changed.org = f.scratch;
    if (kind === 'missing-birth') delete changed.claims.consumer.owner.identity;
    if (kind === 'ambiguous') changed.claims.consumer.owner.argv.push('--keys', JSON.stringify(keys));
    if (kind === 'partial') changed.claims.consumer.owner.argv[4] = JSON.stringify([...keys, 'a'.repeat(64)]);
    fs.writeFileSync(originalFile, JSON.stringify(changed));
    assert.throws(() => prepareCloseoutPacket(options), /different project|birth|exact named|every original/);
  }
  fs.writeFileSync(originalFile, JSON.stringify(original));
  const file = path.join(f.common, 'closeout/entries', keys[0] + '.json'), retained = path.join(f.scratch, 'retained.json');
  fs.renameSync(file, retained); fs.symlinkSync(retained, file);
  assert.throws(() => prepareCloseoutPacket(options), /symbolic|regular|ELOOP/);
  assert.deepEqual(f.read().actions, []);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/queue.lock')), false);
});

test('cleanup handoff capability binds current clean code and holds an old undeclared code root without executing it', t => {
  const f = setup(t, { occupied: false, terminal: true }), current = readCloseoutCapabilities();
  assert.equal(current.supported, true); assert.equal(current.capabilities.shared_retirement_owner, true);
  // A small committed pre-declaration product models the c160 closed parser;
  // no installed release, project pin or saved job is read or changed.
  const old = path.join(f.scratch, 'old-code'); fs.mkdirSync(path.join(old, 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(old, 'supervisor/closeout.mjs'), `import {parseArgs} from 'node:util';\nparseArgs({allowPositionals:true,options:{keys:{type:'string'},deadline:{type:'string'},'no-restart':{type:'boolean'},repo:{type:'string'},org:{type:'string'}}});\n`);
  f.git(['init', '-qb', 'main'], old); f.git(['config', 'user.name', 'Old code'], old); f.git(['config', 'user.email', 'old@example.invalid'], old);
  f.git(['add', '.'], old); f.git(['commit', '-qm', 'Pre-declaration parser'], old);
  const observed = readCloseoutCapabilities(old);
  assert.equal(observed.supported, false); assert.equal(observed.capabilities, null);
  const keys = readCloseoutEntries(f.common).map(e => e.key), lock = path.join(f.common, 'closeout/consumer.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 91833, identity: 'original-birth', token: 'original',
    argv: [process.execPath, '/installed/c160/supervisor/closeout.mjs', 'drain', '--keys', JSON.stringify(keys)] }));
  const originalFile = path.join(f.scratch, 'original.json');
  fs.writeFileSync(originalFile, JSON.stringify(readCloseoutOwnerStatus({ cwd: f.repo, org: f.org, env: f.env })));
  const packet = prepareCloseoutPacket({ cwd: f.repo, org: f.org, env: f.env, originalFile, candidateRoot: old });
  assert.deepEqual(packet.keys, keys); assert.deepEqual(packet.phases, []); assert.equal(packet.effects_authorized, false);
  for (const flag of ['--sessions-only', '--retry-safe', '--owner']) {
    const reply = spawnSync(process.execPath, [path.join(old, 'supervisor/closeout.mjs'), 'drain', flag], { env: f.env, encoding: 'utf8' });
    assert.notEqual(reply.status, 0); assert.match(reply.stderr, /Unknown option/);
  }
  fs.writeFileSync(path.join(old, 'supervisor/closeout-capabilities.json'), JSON.stringify(current.capabilities));
  assert.throws(() => readCloseoutCapabilities(old), /inventory mismatch/);
  assert.deepEqual(f.read().actions, []);
});

test('closeout owner status preserves the retained legacy owner and refuses to turn old outcomes or an expired deadline into release',t=>{
  const f=setup(t,{occupied:false}),directory=path.join(f.common,'closeout'),owner={pid:91833,identity:'1793081341:121264',token:'original-consumer',at:'2026-10-27T06:09:02.691Z',argv:[process.execPath,'/installed/c160/supervisor/closeout.mjs','drain','--keys',JSON.stringify(['a'.repeat(64)]),'--deadline','1793079848822','--no-restart']};
  f.append([{type:'closeout.code-handoff',identity:f.common,keys:['a'.repeat(64)],old:{code:{root:'/installed/c160'},epoch:{tip:'d937'}},current:{code:{root:'/installed/c160'},epoch:{tip:'00e'}}},{type:'closeout.evaluated',key:'a'.repeat(64),identity:f.common,completed:true}]);
  for(const name of ['consumer.lock','queue.lock']){fs.mkdirSync(path.join(directory,name),{recursive:true});fs.writeFileSync(path.join(directory,name,'owner.json'),JSON.stringify(owner),{mode:0o600});}
  fs.writeFileSync(path.join(directory,'worker.log'),'older successor 0 pending false; evaluations complete\n');
  const before=fs.readFileSync(f.eventFile),claims=['consumer.lock','queue.lock'].map(n=>fs.readFileSync(path.join(directory,n,'owner.json'))),kill=process.kill;
  process.kill=()=>{throw Error('read-only status must never probe or signal an owner');};
  let result;try{result=readCloseoutOwnerStatus({cwd:f.repo,org:f.org,env:f.env});}finally{process.kill=kill;}
  assert.equal(result.schema,'closeout-owner-status/v1');assert.equal(result.effects,0);assert.equal(result.original_outcome,'UNKNOWN');assert.equal(result.original_release,'UNKNOWN');assert.equal(result.claims.consumer.state,'stored');assert.deepEqual(result.claims.consumer.owner,owner);assert.equal(result.claims.consumer.liveness,'UNKNOWN');assert.equal(result.claims.queue.owner.pid,91833);assert.equal(result.source.capabilities.named_sessions,true);assert.equal(result.source.capabilities.zero_elapsed_budget,true);assert.equal(result.successor.capabilities,null,'a source status must not assert capabilities of a different selected root');
  assert.deepEqual(fs.readFileSync(f.eventFile),before);for(const [i,n]of ['consumer.lock','queue.lock'].entries())assert.deepEqual(fs.readFileSync(path.join(directory,n,'owner.json')),claims[i]);assert.deepEqual(f.read().actions,[]);
  const reply=spawnSync(process.execPath,[closer,'status','--owner','--repo',f.repo,'--org',f.org],{env:f.env,encoding:'utf8'});assert.equal(reply.status,0,reply.stderr);assert.equal(JSON.parse(reply.stdout).claims.consumer.owner.token,owner.token);assert.deepEqual(fs.readFileSync(f.eventFile),before);
});
test('closeout owner status keeps absent claims distinct from original success and rejects foreign records or redirected owner files',t=>{
  const f=setup(t,{occupied:false}),empty=readCloseoutOwnerStatus({cwd:f.repo,org:f.org,env:f.env});assert.equal(empty.claims.consumer.state,'absent');assert.equal(empty.original_outcome,'UNKNOWN');assert.equal(empty.original_release,'UNKNOWN');
  const foreign=path.join(f.scratch,'foreign-record');initOrg(foreign);assert.throws(()=>readCloseoutOwnerStatus({cwd:f.repo,org:foreign,env:f.env}),/record.*binding/);
  const lock=path.join(f.common,'closeout/consumer.lock');fs.mkdirSync(lock,{recursive:true});const file=path.join(f.scratch,'foreign-owner.json');fs.writeFileSync(file,JSON.stringify({pid:91833}));fs.symlinkSync(file,path.join(lock,'owner.json'));assert.throws(()=>readCloseoutOwnerStatus({cwd:f.repo,org:f.org,env:f.env}),/redirected|regular/);assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify({pid:91833}));assert.deepEqual(f.read().actions,[]);
});
function assertRemoved(f) {
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.deepEqual(f.read().workspaces, []);
  assert.ok(effects(f).some(e => e.action === 'lane-removed'));
}

test('phase1 conditional source completion binds one real landed worktree removal without promotion callback',t=>{
  const f=setup(t,{occupied:false});f.git(['merge','--ff-only',f.head]);f.report();
  const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);
  const target=rows[0].closeout_targets.find(t=>t.signal==='landed');assert.ok(target);assert.equal(target.head,f.head);
  const result=f.drain({keys:[target.key]});assert.equal(result.evaluated[0]?.completed,true);assert.equal(fs.existsSync(f.lane),false);
});

test('phase1 deadline-deferred closeout retries its original unattempted target and exits once with a fresh budget',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  const bytes=fs.readFileSync(f.eventFile);
  const first=f.drain({keys:[entry.key],retirementOptions:{...f.options,deadline:Date.now()-1}});
  assert.equal(first.evaluated[0].completed,false);assert.match(first.evaluated[0].reason,/deadline/);assert.equal(effects(f).some(e=>e.action==='agent-exit-requested'),false);
  assert.equal(first.evaluated[0].diagnostic,true);assert.deepEqual(fs.readFileSync(f.eventFile),bytes);
  assert.equal(readCloseoutObservations(f.common,f.org,events(f)).length,1);
  assert.deepEqual(f.drain({keys:[entry.key]}).evaluated,[],'restart suppresses the unchanged observation');
  assert.deepEqual(fs.readFileSync(f.eventFile),bytes);
  const next=f.drain({keys:[entry.key],retrySafe:true});assert.equal(next.evaluated[0]?.completed,true,JSON.stringify(next));
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);assert.equal(fs.existsSync(f.lane),false);
});

test('future telemetry diagnostics cannot override a durable native refusal or manufacture completion',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=readCloseoutEntries(f.common).find(e=>e.key===rows[0].closeout_targets.find(t=>t.signal==='landed').key);
  const revision=closeoutRevision(entry,events(f));
  const row={type:'closeout.evaluated',key:entry.key,identity:f.common,item:entry.item,run:entry.run,source:entry.source,revision,completed:false,reason:'native refusal; original identity retained'};
  transact(f.org,()=>({add:[row]}));
  appendCloseoutObservation(f.common,f.org,{...row,reason:'retirement deadline reached; request remains pending'},events(f));
  assert.equal(closeoutEvaluations(f.common,f.org,events(f)).find(e=>e.key===entry.key).reason,row.reason);
  const bytes=fs.readFileSync(f.eventFile);assert.deepEqual(f.drain({keys:[entry.key],retrySafe:true}).evaluated,[]);assert.deepEqual(f.read().actions,[]);assert.deepEqual(fs.readFileSync(f.eventFile),bytes);
  const log=path.join(f.common,'closeout/worker.log');fs.appendFileSync(log,JSON.stringify({schema:'closeout-diagnostic/v1',org:f.org,observed_seq:events(f).at(-1).seq,evaluation:{...row,completed:true}})+'\n');
  assert.throws(()=>f.drain({keys:[entry.key],retrySafe:true}),/invalid closeout diagnostic/);assert.deepEqual(f.read().actions,[]);
});

test('retirement phase closes its one bound session after slow preparation and leaves physical cleanup independent',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed'),command=f.options.command;
  const realNow=Date.now,started=realNow();let delayed=false;
  f.options.command=(exe,args,opt)=>{if(!delayed&&exe===f.job.herdr){delayed=true;Date.now=()=>started+200000;}return command(exe,args,opt);};
  let phase;try{phase=f.drain({keys:[entry.key],sessionsOnly:true});}finally{Date.now=realNow;f.options.command=command;}
  assert.equal(phase.evaluated[0]?.sessions_retired,true,JSON.stringify(phase));assert.equal(phase.evaluated[0].completed,false);assert.equal(fs.existsSync(f.lane),true);
  assert.ok(effects(f).some(e=>e.action==='exit-observed'));assert.ok(effects(f).some(e=>e.action==='closed'));assert.equal(effects(f).some(e=>e.action==='worktree-removed'),false);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);
  const physical=f.drain({keys:[entry.key],retrySafe:true});assert.equal(physical.evaluated[0]?.completed,true,JSON.stringify(physical));assert.equal(fs.existsSync(f.lane),false);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1,'physical completion never replays quit');
});

test('retirement phase fair selection finds native work among thousands of physical requests and preserves one-target phases',()=>{
  const physical=Array.from({length:2035},(_,n)=>({key:String(n),source:{seq:n+1},panes:[{pane:`old:${n}`}]})),build={key:'build',source:{seq:4000},panes:[{pane:'build:p'}]},review={key:'review',source:{seq:4001},panes:[{pane:'review:p'}]};
  const rows=physical.map((e,n)=>({type:'closeout.evaluated',key:e.key,seq:n+1,sessions_retired:true})),entries=[...physical,build,review];
  let chosen=scheduleLineCloseouts(entries,rows);assert.deepEqual(chosen.map(c=>[c.entry.key,c.sessionsOnly]),[['build',true],['0',false]]);
  chosen=scheduleLineCloseouts(entries,[...rows,{type:'closeout.evaluated',key:'build',seq:5000,reason:'original native outcome UNKNOWN'}]);
  assert.deepEqual(chosen.map(c=>[c.entry.key,c.sessionsOnly]),[['review',true],['0',false]],'a retained original intent gets no priority over a never-attempted independent session');
});

test('cleanup retention selects removal work before a continuing stream of empty ready bookkeeping',()=>{
  const landed={key:'landed',signal:'landed',source:{seq:1},panes:[{pane:'retired:p'}]},
    parked={key:'parked',signal:'parked',source:{seq:2},panes:[]},
    review={key:'review',signal:'review-done',source:{seq:3},panes:[{pane:'review:p'}]};
  const rows=[{type:'closeout.evaluated',key:landed.key,seq:100,sessions_retired:true}];
  const ready=Array.from({length:1000},(_,n)=>({key:`ready-${n}`,signal:'ready',source:{seq:1000+n},panes:[]}));
  const before=JSON.stringify([ready,rows,landed,parked,review]);
  let selected=scheduleLineCloseouts([...ready,landed,review],rows);
  assert.deepEqual(selected.map(s=>[s.entry.key,s.sessionsOnly]),[['review',true],['landed',false]]);
  selected=scheduleLineCloseouts([...ready,landed,parked,review],rows);
  assert.deepEqual(selected.map(s=>[s.entry.key,s.sessionsOnly]),[['review',true],['parked',false]],'unattempted removal keeps its normal order within removal work');
  assert.deepEqual(scheduleLineCloseouts(ready,rows).map(s=>[s.entry.key,s.sessionsOnly]),[['ready-0',false]],'bookkeeping still runs when removal work is exhausted');
  assert.equal(JSON.stringify([ready,rows,landed,parked,review]),before,'selection never rewrites queued bytes or evidence');
});

test('cleanup retention advances a retired landed session to guarded physical removal ahead of empty ready requests',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=readCloseoutEntries(f.common).find(e=>e.key===rows[0].closeout_targets.find(t=>t.signal==='landed').key);
  const first=f.drain({keys:[entry.key],sessionsOnly:true});
  assert.equal(first.evaluated[0]?.sessions_retired,true,JSON.stringify(first));assert.equal(first.evaluated[0].completed,false);assert.equal(fs.existsSync(f.lane),true);
  const ready=Array.from({length:32},(_,n)=>({key:`ready-${n}`,signal:'ready',source:{seq:rows[0].seq+n+1},panes:[]}));
  const selected=scheduleLineCloseouts([...ready,entry],closeoutEvaluations(f.common,f.org,events(f)));
  assert.deepEqual(selected.map(s=>[s.entry.key,s.sessionsOnly]),[[entry.key,false]]);
  const result=f.drain({keys:[selected[0].entry.key],retrySafe:true,sessionsOnly:selected[0].sessionsOnly});
  assert.equal(result.evaluated[0]?.completed,true,JSON.stringify(result));assert.equal(fs.existsSync(f.lane),false);
  assert.ok(effects(f).some(e=>e.action==='lane-removed'));assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1,'physical selection never replays the session exit');
});

test('cleanup retention priority preserves HOLD dirty source and original unknown native effects',t=>{
  for(const kind of ['hold','dirty','unknown']){
    const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=readCloseoutEntries(f.common).find(e=>e.key===rows[0].closeout_targets.find(t=>t.signal==='landed').key);
    if(kind==='unknown'){
      f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:entry.run,item:entry.item,source:entry.source,effect:'original-unknown',outcome:{action:'workspace-close-requested',workspace_id:'original-unknown-workspace'}}]);
    }else{
      const first=f.drain({keys:[entry.key],sessionsOnly:true});assert.equal(first.evaluated[0]?.sessions_retired,true,JSON.stringify(first));
      if(kind==='hold')hold(f);else fs.writeFileSync(path.join(f.lane,'unique-untracked-evidence'),'must remain');
    }
    const ready={key:'ready',signal:'ready',source:{seq:rows[0].seq+1},panes:[]},
      selected=scheduleLineCloseouts([ready,entry],[{type:'closeout.evaluated',key:entry.key,seq:rows[0].seq+2,sessions_retired:true}]);
    assert.equal(selected[0].entry.key,entry.key);assert.equal(selected[0].sessionsOnly,false);
    const file=path.join(f.common,'closeout/entries',entry.key+'.json'),bytes=fs.readFileSync(file),before=f.read().actions.length;
    const result=f.drain({keys:[entry.key],retrySafe:true});assert.equal(result.evaluated[0]?.completed,false,JSON.stringify(result));
    assert.match(result.evaluated[0].reason,kind==='hold'?/HOLD/:kind==='dirty'?/clean|dirty|untracked/:/unresolved native/);
    assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(fs.readFileSync(file),bytes);
    assert.equal(effects(f).some(e=>e.action==='lane-removed'),false);
    if(kind==='unknown')assert.equal(f.read().actions.length,before,'unknown original outcome grants no native effect');
  }
});

test('retirement phase retains original unknown exits and a fresh service STOP before any native effect',t=>{
  for(const kind of ['unknown','stop','absent']){
    const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
    if(kind==='unknown'){
      const candidate=f.retirement(f.options).plan(f.lane).close[0];f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:rows[0].seq,type:'item.closed'},effect:'preserved-original-intent',outcome:{action:'agent-exit-requested',run:candidate.run,pane:candidate.pane,tab_id:candidate.tab_id,occupant:candidate.occupant,shell:candidate.shell}}]);
    }else if(kind==='absent'){
      f.state.agents=[];f.state.tabs=[];f.state.panes=[];f.save();
    }else{
      const base=f.options.command;let stopped=false;f.options.command=(exe,args,opt)=>{const result=base(exe,args,opt);if(!stopped&&exe===f.job.herdr){stopped=true;const directory=path.join(f.org,'line-service',createHash('sha256').update(JSON.stringify(f.common)).digest('hex').slice(0,20));fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'STOP'),'actual STOP after selection');}return result;};
    }
    const result=f.drain({keys:[entry.key],sessionsOnly:true,retrySafe:true});assert.equal(result.evaluated[0]?.completed,false);assert.notEqual(result.evaluated[0]?.sessions_retired,true);assert.match(result.evaluated[0].reason,/unresolved native|STOP|UNKNOWN/);assert.deepEqual(f.read().actions,[]);
  }
});

test('phase1 deadline retry preserves an unresolved original native exit intent without another prompt',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry=rows[0].closeout_targets.find(t=>t.signal==='landed');
  f.drain({keys:[entry.key],retirementOptions:{...f.options,deadline:Date.now()-1}});
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:rows[0].seq,type:'item.closed'},effect:'fixture-original-exit-intent',outcome:{action:'agent-exit-requested',run:'R-1',pane:'w:p',tab_id:'w:t',occupant:['worker','codex','w:p','w',f.lane,'term','session'],shell:{pid:1,identity:'shell',command:'[zsh]'}}}]);
  const held=f.drain({keys:[entry.key],retrySafe:true});assert.equal(held.evaluated[0]?.completed,false);assert.match(held.evaluated[0].reason,/unresolved native/);assert.deepEqual(f.read().actions,[]);
  f.append([{type:'closeout.retry',identity:f.common,keys:[entry.key],why:'fixture explicit observation; no permission to replay the native intent'}]);
  const observed=f.drain({keys:[entry.key]});assert.equal(observed.evaluated[0]?.completed,false);assert.match(observed.evaluated[0].reason,/unresolved native/);assert.deepEqual(f.read().actions,[]);
});

test('phase1 safe outcome readback confirms an original lost exit reply without another quit or a close in that pass',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}},base=f.options.command;
  const now=Date.now,deadline=now()+60000;
  f.options.command=(exe,args,opt)=>{const result=base(exe,args,opt);if(exe===f.job.herdr&&args[0]==='agent'&&args[1]==='prompt'){Date.now=()=>deadline;return{...result,status:1,stderr:'lost exit acknowledgement'};}return result;};
  let first;try{first=f.drain({keys:[entry.key],retirementOptions:{...f.options,deadline}});}finally{Date.now=now;}
  assert.equal(first.evaluated[0].completed,false);assert.deepEqual(f.read().actions,[['agent','prompt','worker','/quit']]);
  assert.equal(safeCloseoutRetry(evaluations(f).at(-1),{entry,events:events(f)}),false);
  assert.equal(closeoutOutcomeObservation(evaluations(f).at(-1),{entry,events:events(f)}),true);
  const observed=f.drain({keys:[entry.key],retrySafe:true});assert.equal(observed.evaluated[0].completed,false);assert.equal(observed.evaluated[0].reason,'original native outcome reconciled; fresh drain required');
  assert.deepEqual(f.read().actions,[['agent','prompt','worker','/quit']],'outcome readback has no prompt/close/removal effects');
  assert.ok(effects(f).some(e=>e.action==='exit-observed'));
  assert.equal(safeCloseoutRetry(evaluations(f).at(-1),{entry,events:events(f)}),true);
  const final=f.drain({keys:[entry.key],retrySafe:true});assert.equal(final.evaluated[0].completed,true,JSON.stringify(final));
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);assert.equal(fs.existsSync(f.lane),false);
});

test('phase1 safe outcome readback keeps a still-live or replaced exit target and never bypasses native refusals',t=>{
  const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}};
  const candidate=f.retirement(f.options).plan(f.lane).close[0];assert.equal(candidate.decision,'exit');
  f.append([{type:'closeout.effect',key:entry.key,identity:f.common,run:'R-1',item:'ENG-1',source:{seq:rows[0].seq,type:'item.closed'},effect:'original-unknown-exit',outcome:{action:'agent-exit-requested',run:candidate.run,pane:candidate.pane,tab_id:candidate.tab_id,occupant:candidate.occupant,shell:candidate.shell}}]);
  const first=f.drain({keys:[entry.key],retrySafe:true});assert.equal(first.evaluated[0].completed,false);assert.match(first.evaluated[0].reason,/unresolved native/);assert.deepEqual(f.read().actions,[]);
  for(const reason of ['EPERM native refusal','foreign source','native identity changed','HOLD'])assert.equal(closeoutOutcomeObservation({completed:false,reason},{entry,events:events(f)}),false,reason);
  f.state.agents[0].agent_session={value:'replacement'};
  const shell=f.state.info.process_tree[0];f.state.info={shell_pid:shell.pid,foreground_processes:[{pid:shell.pid,name:'zsh'}],process_tree_complete:true,process_tree:[shell]};f.save();
  const replaced=f.drain({keys:[entry.key],retrySafe:true});assert.equal(replaced.evaluated[0].completed,false);assert.match(replaced.evaluated[0].reason,/identity changed/);assert.deepEqual(f.read().actions,[]);
});

test('continuity service reconciles a successful tab close with no saved closed receipt then completes cleanup without replay',t=>{
  const f=setup(t,{merged:true});f.report();f.append([{type:'line-service.phase0',id:'bound',project:f.common,repo:f.repo,org:f.org,main:'main',canonical_head:f.head}]);
  const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}},base=f.options.command;
  const now=Date.now,deadline=now()+60000;
  let lost=false;f.options.command=(exe,args,opt)=>{const result=base(exe,args,opt);if(!lost&&exe===f.job.herdr&&args[0]==='tab'&&args[1]==='close'){lost=true;Date.now=()=>deadline;return{...result,status:1,stderr:'lost tab-close acknowledgement'};}return result;};
  const drains=[],service=createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,maxStarts:0,recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args)=>{
    assert.equal(args[0],path.join(sourceRoot,'supervisor/closeout.mjs'));assert.ok(args.includes('--retry-safe'));
    const keys=JSON.parse(args[args.indexOf('--keys')+1]);assert.deepEqual(keys,[entry.key]);
    const result=f.drain({keys,retrySafe:true,sessionsOnly:args.includes('--sessions-only'),retirementOptions:{...f.options,...(!drains.length?{deadline}:{})}});drains.push(result);return{status:0,stdout:JSON.stringify(result),stderr:''};
  }});
  try{service.pass();}finally{Date.now=now;}
  assert.equal(lost,true);assert.equal(effects(f).some(e=>e.action==='closed'&&e.tab_id==='w:t'),false);assert.equal(f.read().tabs.length,0);
  const original=f.read().actions;assert.deepEqual(original,[['agent','prompt','worker','/quit'],['tab','close','w:t']]);
  assert.equal(closeoutOutcomeObservation(evaluations(f).at(-1),{entry,events:events(f)}),true);
  service.pass();assert.equal(drains.at(-1).evaluated[0].reason,'original native outcome reconciled; fresh drain required');assert.deepEqual(f.read().actions,original);assert.ok(fs.existsSync(f.lane));
  assert.equal(effects(f).filter(e=>e.action==='closed'&&e.tab_id==='w:t'&&e.reconciled).length,1);
  assert.equal(safeCloseoutRetry(evaluations(f).at(-1),{entry,events:events(f)}),true);
  service.pass();assert.equal(evaluations(f).at(-1).sessions_retired,true);assert.ok(fs.existsSync(f.lane));
  service.pass();assert.equal(evaluations(f).at(-1).completed,true);assert.equal(fs.existsSync(f.lane),false);
  assert.equal(f.read().actions.filter(a=>a[0]==='agent'&&a[1]==='prompt').length,1);assert.equal(f.read().actions.filter(a=>a[0]==='tab'&&a[1]==='close').length,1);
  assert.equal(drains.length,4);
});

test('continuity tab-close readback protects present replaced held refused and unbound targets without another native effect',t=>{
  for(const kind of ['present','replaced','moved','held','stop','native-read-refused','refused','unbound']){
    const f=setup(t,{merged:true});f.report();const rows=f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]),entry={...rows[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:rows[0].seq,type:'item.closed'}};
    f.append([{type:'closeout.effect',key:entry.key,identity:f.common,source:entry.source,effect:'original-close',outcome:{action:'shell-close-requested',tab_id:'w:t',panes:[{pane:'w:p',terminal:kind==='unbound'?'foreign':'term'}]}},
      {type:'closeout.evaluated',key:entry.key,completed:false,revision:entry.source.seq,reason:kind==='refused'?'EPERM native refusal':'unresolved native exit/close intent retained; reconcile its original identity/outcome without replay'}]);
    if(kind==='replaced'){f.state.panes[0].terminal_id='replacement';f.save();}
    if(kind==='moved'){f.state.tabs=[];f.state.panes=[];f.state.agents[0].pane_id='elsewhere';f.save();}
    if(kind==='held')hold(f);
    if(kind==='stop'){fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'stop');}
    if(kind==='native-read-refused'){const base=f.options.command;f.options.command=(exe,args,opt)=>exe===f.job.herdr?{status:1,stdout:'',stderr:'EPERM native refusal'}:base(exe,args,opt);}
    if(['refused','unbound'].includes(kind))assert.equal(closeoutOutcomeObservation(evaluations(f).at(-1),{entry,events:events(f)}),false,kind);
    else{
      assert.equal(closeoutOutcomeObservation(evaluations(f).at(-1),{entry,events:events(f)}),true,kind);
      const result=f.drain({keys:[entry.key],retrySafe:true});assert.equal(result.evaluated[0].completed,false,kind);assert.equal(effects(f).some(e=>e.action==='closed'),false,kind);
      assert.match(result.evaluated[0].reason,kind==='replaced'||kind==='moved'?/identity|moved/:kind==='held'?/HOLD/:kind==='stop'?/STOP/:kind==='native-read-refused'?/EPERM|native refusal/:/unresolved native/);
    }
    assert.deepEqual(f.read().actions,[],kind);assert.ok(fs.existsSync(f.lane),kind);
  }
});

test('default landing and named requests, full-source opt-in, opt-out and canonical ownership', t => {
  const f = fixture(t, { occupied: false });
  fs.unlinkSync(path.join(f.repo, '.lane.json'));
  assert.equal(closeoutPolicy(f.repo), true);
  assert.equal(closeoutPolicy(f.repo, 'report.ingested'), false);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
  assert.equal(closeoutPolicy(f.repo), true);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":false}}');
  assert.equal(closeoutPolicy(f.repo), false);
  fs.writeFileSync(path.join(f.lane, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  assert.deepEqual(publishCloseoutEvents({ cwd: f.lane, org: f.org, added: events(f) }), []);
  assert.deepEqual(readCloseoutEntries(f.common), []);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":"yes"}}');
  assert.throws(() => closeoutPolicy(f.repo), /invalid/);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  assert.equal(closeoutPolicy(f.repo), true);
});

for (const config of [null, {}, { retirement: {} }, { retirement: { closeout_queue: false } }, { retirement: { closeout_queue: true } }])
test(`automatic report stays opt-in; default landing/named policy (${config === null ? 'no config' : JSON.stringify(config)})`, async t => {
  const f = setup(t, { occupied: false }), file = path.join(f.scratch, 'report.md');
  if (config === null) fs.unlinkSync(path.join(f.repo, '.lane.json'));
  else fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify(config));
  assert.equal(closeoutPolicy(f.repo), config?.retirement?.closeout_queue !== false);
  fs.writeFileSync(file, '---\nrun: R-1\noutcome: done\nsummary: Complete.\nblockers: []\nproposals: []\n---\n');
  const result = spawnSync(process.execPath, [cli, 'ingest', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const source = events(f).find(e => e.type === 'report.ingested');
  assert.equal(source.report.outcome, 'done');
  if (config?.retirement?.closeout_queue) {
    assert.equal(source.closeout_targets.length, 1);
    await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
    assert.ok(f.herdrCalls().some(a => a[0] === 'workspace' && a[1] === 'list'));
  } else {
    assert.equal(source.closeout_targets, undefined);
    assert.deepEqual(readCloseoutEntries(f.common), []);
    assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false, 'ingestion never launches the closer');
    assert.deepEqual(f.herdrCalls(), []);
    assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
    const landed = f.land();
    const disabled = config?.retirement?.closeout_queue === false;
    assert.equal(landed.at(-1).closeout_targets?.length ?? 0, disabled ? 0 : 1);
    if (!disabled) {
      assert.equal(readCloseoutEntries(f.common).find(e => e.signal === 'landed').schema, 'closeout-entry/v2');
      f.drain(); assertRemoved(f);
      return;
    }
    readyLane({ cwd: f.repo, org: f.org, topic: 'topic', run: 'R-1', env: f.env, start: false });
    recoverLane({ cwd: f.repo, org: f.org, lane: f.lane, env: f.env, start: false });
    assert.deepEqual(readCloseoutEntries(f.common), []);
    assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false);
    assert.deepEqual(f.herdrCalls(), []);
    assert.equal(fs.existsSync(f.lane), true);
  }
});

for (const type of ['report.ingested', 'review.verdict', 'item.closed', 'promotion.reconciled', 'lane.ready', 'lane.recovery-requested'])
test(`publication rechecks opt-in even when ${type} already has a binding`, t => {
  const f = setup(t, { occupied: false });
  const source = {
    'report.ingested': { type, run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' },
    'review.verdict': { type, common: f.common, run: 'R-1', head: f.head, review: { id: 'bound-review', run: 'R-1' } },
    'item.closed': { type, id: 'ENG-1', as: 'dropped' },
    'promotion.reconciled': { type, identity: f.common, runs: ['R-1'], heads: [{ run: 'R-1', head: f.head }] },
    'lane.ready': { type, common: f.common, run: 'R-1', head: f.head },
    'lane.recovery-requested': { type, common: f.common, run: 'R-1', head: f.head, signal: 'landed' },
  }[type];
  const { added } = transact(f.org, current => bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add: [
    source,
  ] } }));
  assert.equal(added[0].closeout_targets.length, 1);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":false}}');
  assert.deepEqual(publishCloseoutEvents({ cwd: f.repo, org: f.org, added, env: f.env }), []);
  assert.deepEqual(readCloseoutEntries(f.common), []);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false);
  assert.deepEqual(f.herdrCalls(), []);
});

test('a hand-edited unknown desk route holds direct closeout policy and its consumer', t => {
  const f = setup(t, { occupied: false });
  const file = path.join(f.repo, '.lane.json');
  const config = { retirement: { closeout_queue: true }, routes: { reviewer: { kind: 'codex' } }, settle: { review_route: 'reviewer' } };
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(closeoutPolicy(f.repo), true);
  config.settle.review_route = 'unknown-hand-edit'; fs.writeFileSync(file, JSON.stringify(config));
  assert.throws(() => closeoutPolicy(f.repo), /unknown route: unknown-hand-edit.*held/);
  assert.throws(() => f.drain(), /unknown route: unknown-hand-edit.*held/);
  assert.equal(fs.existsSync(f.lane), true);
  assert.deepEqual(effects(f), []);
});

test('source binding uses the supplied fleet environment through publication', t => {
  const f = setup(t, { occupied: false }), env = { ...f.env, HERDR_MONITOR_FLEET: path.join(f.scratch, 'binding-fleet.json') };
  fs.unlinkSync(path.join(f.repo, '.org'));
  joinFleet({ cwd: f.repo, record: f.org, worktrees: path.join(f.scratch, 'worktrees'), layers: [], env });
  const add = [{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' }];
  const unbound = bindCloseoutSources({ cwd: f.repo, org: f.org, events: events(f), mutation: { add }, env: f.env });
  assert.equal(unbound.add[0].closeout_targets, undefined, 'an unrelated discovery environment grants no binding');
  const committed = transact(f.org, current => bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add }, env }));
  assert.equal(committed.added[0].closeout_targets.length, 1);
  const published = publishCloseoutEvents({ cwd: f.repo, org: f.org, added: committed.added, env, start: false });
  assert.equal(published.length, 1);
  assert.equal(readCloseoutEntries(f.common)[0].org, fs.realpathSync(f.org));
});

test('concurrent foreign-record CLI writers neither consume nor prune the project record queue', async t => {
  const f = setup(t); f.report();
  const foreign = path.join(f.scratch, 'foreign-record'); initOrg(foreign);
  const [entry] = readCloseoutEntries(f.common);
  transact(f.org, () => ({ add: [{ type: 'closeout.evaluated', key: entry.key, identity: f.common, run: entry.run,
    item: entry.item, source: entry.source, revision: entry.source.seq, completed: true }] }));
  const entries = path.join(f.common, 'closeout/entries');
  fs.writeFileSync(path.join(entries, `${'f'.repeat(64)}.json`), '{"schema":"closeout-entry/v999"}\n');
  const before = fs.readdirSync(entries).map(name => [name, fs.readFileSync(path.join(entries, name), 'utf8')]);
  const recordBefore = fs.readFileSync(f.eventFile, 'utf8');
  assert.deepEqual(f.drain({ org: foreign, onClaim: () => assert.fail('a foreign record cannot claim the project consumer') }), { evaluated: [] });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => child(process.execPath,
    [cli, 'add', `Foreign ${i}`, '--role', 'engineer'], { cwd: i % 2 ? f.lane : f.repo, env: { ...f.env, ORG_DIR: foreign } })));
  for (const result of results) { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.stderr, ''); }
  const written = loadEvents(foreign).events;
  assert.equal(written.length, 12); assert.ok(written.every(e => e.type === 'item.added'));
  assert.deepEqual(written.map(e => e.seq), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(new Set(results.map(r => r.stdout.trim())).size, 12);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), recordBefore);
  assert.deepEqual(fs.readdirSync(entries).map(name => [name, fs.readFileSync(path.join(entries, name), 'utf8')]), before);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false, 'foreign writes do not launch a closer');
  assert.deepEqual(f.read().actions, []);
});

test('own-record publication and drain ignore foreign-bound entries in the same project queue', t => {
  const f = setup(t); f.report();
  const foreign = path.join(f.scratch, 'foreign-record'); initOrg(foreign);
  const [entry] = readCloseoutEntries(f.common);
  const other = { ...entry, org: foreign, run: 'R-99', signal: 'landed', key: closeoutKey(entry.cwd, 'R-99', 'landed') };
  const file = path.join(f.common, 'closeout/entries', `${other.key}.json`), bytes = JSON.stringify(other) + '\n';
  fs.writeFileSync(file, bytes);
  f.append([{ type: 'item.added', id: 'ENG-2', title: 'Own record update', kind: 'work', role: 'engineer' }]);
  f.drain();
  assert.ok(evaluations(f).some(e => e.key === entry.key), 'the owning request is still evaluated');
  assert.equal(events(f).some(e => e.key === other.key), false, 'foreign entry produces no invalid or evaluated event');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(loadEvents(foreign).events, []);
  assert.deepEqual(f.read().actions, []);
});

for (const field of ['org', 'project']) test(`the owning record still diagnoses a changed ${field} binding without changing the entry`, t => {
  const f = setup(t); f.report();
  const [entry] = readCloseoutEntries(f.common), file = path.join(f.common, 'closeout/entries', `${entry.key}.json`);
  const changed = { ...entry, [field]: path.join(f.scratch, 'changed-binding') };
  const bytes = JSON.stringify(changed) + '\n'; fs.writeFileSync(file, bytes);
  f.drain();
  assert.ok(events(f).some(e => e.type === 'closeout.invalid' && e.key === entry.key && /record\/project binding changed/.test(e.reason)));
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(f.read().actions, []);
});

test('explicit opt-out promotion contention remains pending and retries every cleanup row after release', t => {
  const f = exitFixture(t); isolatedEnv(t, f);
  const queue = f.queue(), release = retirementLock(retirementOwnerLock(f.common));
  let released = false;
  try {
    const result = finishCleanup(f.job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue, { now: 1000 });
    assert.equal(result.outcome, 'promoted'); assert.equal(result.cleanup.state, 'pending');
    assert.match(result.cleanup.last_refusal, /locked:.*retirement\/owner.lock/);
    assert.match(result.reason, /^integrated-but-cleanup-pending:/);
    queue.transaction(data => data.results.push(...['first', 'second'].map(id => ({ ...f.job, ...result, id }))));
    assert.doesNotThrow(() => retryCleanup(queue, { now: result.cleanup.next_attempt_at }));
    assert.deepEqual(queue.load().results.map(r => r.cleanup.attempts), [2, 2], 'contention cannot abort later rows');
    assert.deepEqual(f.read().actions, []); assert.equal(fs.existsSync(f.lane), true);
    const due = queue.load().results[0].cleanup.next_attempt_at;
    release(); released = true;
    retryCleanup(queue, { now: due });
    assert.deepEqual(queue.load().results.map(r => r.cleanup.state), ['complete', 'complete']);
    assert.equal(fs.existsSync(f.lane), false);
  } finally { if (!released) release(); }
});

test('ready ignores detached, non-Git and foreign workspaces, including a foreign lane with the same topic', t => {
  const f = setup(t), detached = path.join(f.scratch, 'detached'), plain = path.join(f.scratch, 'plain'), foreign = path.join(f.scratch, 'foreign');
  f.git(['worktree', 'add', '--detach', detached]); fs.mkdirSync(plain); fs.mkdirSync(foreign);
  f.git(['init', '-b', 'lane/topic'], foreign); f.git(['config', 'user.name', 'Fixture'], foreign);
  f.git(['config', 'user.email', 'fixture@example.invalid'], foreign); f.git(['commit', '--allow-empty', '-m', 'foreign'], foreign);
  f.append([detached, plain, foreign].map((workspace, i) => ({ type: 'run.started', id: `R-${i + 2}`, item: 'ENG-1', workspace, meta: {} })));
  assert.deepEqual(readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false }), { run: 'R-1', signal: 'ready' });
  assert.equal(readCloseoutEntries(f.common)[0].cwd, f.lane);
});

test('non-lane done reports are not applicable, while an unavailable registered lane still records a binding failure', t => {
  const f = setup(t), plain = path.join(f.scratch, 'planning'); fs.mkdirSync(plain);
  const stderr = process.stderr.write, messages = [];
  process.stderr.write = chunk => { messages.push(String(chunk)); return true; };
  try {
    const added = f.append([f.repo, plain].flatMap((workspace, i) => [
      { type: 'run.started', id: `R-${i + 2}`, item: 'ENG-1', workspace, meta: {} },
      { type: 'report.ingested', run: `R-${i + 2}`, report: { outcome: 'done' } },
    ]));
    for (const e of added.filter(e => e.type === 'report.ingested')) {
      assert.deepEqual(e.closeout_targets, []); assert.equal(e.closeout_binding_errors, undefined);
      assert.equal(e.closeout_binding_error, undefined);
    }
    assert.deepEqual(readCloseoutEntries(f.common), []); assert.deepEqual(messages, []);
    fs.renameSync(f.lane, `${f.lane}-unavailable`);
    const [bad] = f.report();
    assert.equal(bad.closeout_binding_errors[0].run, 'R-1');
    assert.match(messages.join(''), /no durable target binding/);
  } finally { process.stderr.write = stderr; }
});

test('promotion retries only its exact deferred lock target; empty drains never revisit completed or unrelated history', async t => {
  const f = setup(t); f.report(); f.land();
  for (let i = 2; i <= 5; i++) {
    const workspace = path.join(f.scratch, `target-${i}`);
    f.git(['worktree', 'add', '-b', `lane/target-${i}`, workspace]);
    f.append([{ type: 'item.added', id: `ENG-${i}`, kind: 'work', role: 'engineer' },
      { type: 'run.started', id: `R-${i}`, item: `ENG-${i}`, workspace, meta: {} },
      { type: 'promotion.reconciled', identity: f.common, heads: [{ run: `R-${i}`, head: f.head }], runs: [`R-${i}`], items: [`ENG-${i}`] }]);
  }
  const entries = readCloseoutEntries(f.common).filter(e => e.signal === 'landed');
  f.append(entries.map(entry => ({ type: 'closeout.evaluated', key: entry.key, identity: f.common, run: entry.run, item: entry.item,
    source: entry.source, revision: closeoutRevision(entry, events(f)), completed: entry.run === 'R-3',
    waiting: { event: entry.run === 'R-4' ? 'target-record-changed' : 'lifecycle-lock-released' } })));
  const jobs = entries.filter(e => e.run !== 'R-2').map(e => ({ id: e.key, org: f.org, run: e.run, topic: e.branch.slice(5), tip: e.run === 'R-5' ? '0'.repeat(40) : e.head }));
  const queue = queueFor(f.repo);
  const before = events(f).length;
  await drainPromotions(queue);
  assert.equal(events(f).length, before, 'empty promotion drain does not retry historical entries');
  const added = retryPromotionCloseout({ cwd: f.repo, org: f.org, jobs, start: false });
  assert.equal(added.length, 1); assert.deepEqual(added[0].keys, [entries.find(e => e.run === 'R-1').key]);
  assert.deepEqual(retryPromotionCloseout({ cwd: f.repo, org: f.org, jobs, start: false }), [], 'an already requested retry adds no churn');
  assert.equal(readCloseoutEntries(f.common).some(e => e.run === 'R-3'), false, 'completed request file is pruned after its durable receipt');
  const completed = entries.find(e => e.run === 'R-3'), source = events(f).find(e => e.seq === completed.source.seq);
  assert.deepEqual(publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], start: false }), [], 'replay cannot resurrect a completed key');
  assert.equal(events(f).find(e => e.seq === source.seq).closeout_targets[0].gitIdentity.ino, completed.gitIdentity.ino, 'exact-run evidence remains in record');
});

test('source replay waiting on queue.lock cannot recreate a request completed and pruned during its wait', async t => {
  const f = setup(t, { occupied: false }), [source] = f.report(), [entry] = readCloseoutEntries(f.common);
  const lock = path.join(f.common, 'closeout/queue.lock'), marker = path.join(f.scratch, 'publisher-waiting');
  const release = retirementLock(lock);
  const replay = child(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { publishCloseoutEvents } from ${JSON.stringify(new URL('../lib/closeout.mjs', import.meta.url).href)};
    const original = fs.readFileSync;
    fs.readFileSync = (...args) => {
      if (args[0] === ${JSON.stringify(path.join(lock, 'owner.json'))}) fs.writeFileSync(${JSON.stringify(marker)}, 'waiting');
      return original(...args);
    };
    console.log(JSON.stringify(publishCloseoutEvents({ cwd: ${JSON.stringify(f.repo)}, org: ${JSON.stringify(f.org)}, added: [${JSON.stringify(source)}], start: false })));
  `], { cwd: f.repo, env: f.env });
  try {
    await waitForChange([marker], () => fs.existsSync(marker), { timeoutMs: 10000 });
    transact(f.org, () => ({ add: [{ type: 'closeout.evaluated', key: entry.key, identity: f.common, run: entry.run,
      item: entry.item, source: entry.source, revision: source.seq, completed: true }] }));
    pruneCompletedCloseout(f.common, f.org, [entry], events(f));
    assert.deepEqual(readCloseoutEntries(f.common), []);
  } finally { release(); }
  const result = await replay;
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), []);
  assert.deepEqual(readCloseoutEntries(f.common), []);
});

test('optional ready, repeated ready and ingested done are one entry; NEEDS-WORK retains its worker', t => {
  const f = setup(t);
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  f.report();
  f.append([{ type: 'item.added', id: 'REV-1', role: 'reviewer', kind: 'work', parent: 'ENG-1' },
    { type: 'run.started', id: 'R-2', item: 'REV-1', workspace: f.lane, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done', extra: { verdict: 'NEEDS-WORK' } } }]);
  assert.equal(readCloseoutEntries(f.common).filter(e => e.run === 'R-1').length, 1);
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).some(e => !e.completed && e.waiting.event === 'target-record-changed'));
  const count = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, count, 'no rescan without a resolving revision');
});

for (const project of ['bch-cloak', 'herdr-brain']) test(`${project}: a landed event immediately releases and removes its exact lane, branch and empty workspace`, t => {
  const f = setup(t, { terminal: true });
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/evidence'), 'unique report and scratch\n');
  const [scratch] = JSON.parse(f.env.HERDR_TEST_SCRATCH_ROOTS), payload = path.join(scratch, 'run-review');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, '.herdr-scratch.json'), JSON.stringify({ schema: 'herdr-scratch/v1', common: f.common, run: 'R-1' }));
  fs.writeFileSync(path.join(payload, 'result'), 'disposable');
  const nativeCommand = f.options.command;
  f.options.command = (exe, args, options) => exe === '/usr/sbin/lsof' && args.includes('-Fpfn0')
    ? { status: 0, stderr: '', stdout: `p${process.pid}\0fcwd\0n${f.repo}\0\n` }
    : nativeCommand(exe, args, options);
  const landed = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.equal(landed.source.type, 'promotion.reconciled');
  f.drain(); assertRemoved(f);
  assert.deepEqual(readCloseoutEntries(f.common), [], 'only durable record evidence remains after completion');
  const evaluated = evaluations(f).findLast(event => event.completed && event.source.type === 'promotion.reconciled');
  const codeRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..')), marker = path.join(codeRoot, '.release-commit');
  assert.ok(evaluated, 'real consumer completed its bound source');
  assert.equal(evaluated.code.code.root, codeRoot);
  assert.equal(evaluated.code.code.kind, fs.existsSync(marker) ? 'release' : 'checkout');
  assert.equal(evaluated.code.code.commit, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : f.git(['rev-parse', 'HEAD'], codeRoot));
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false, 'completed removal releases its consumer claim');
  const actions = effects(f).map(e => e.action);
  for (const action of ['exit-observed', 'closed', 'lane-preflight', 'worktree-removed', 'branch-removed', 'lane-removed']) assert.ok(actions.includes(action), action);
  const proof = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.existsSync(payload), false, 'the queue calls the guarded executor scratch sweep');
  const sweep = JSON.parse(fs.readFileSync(proof.scratchManifest));
  assert.equal(sweep.entries.find(e => e.path === payload).disposition, 'removed');
  assert.equal(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/evidence'), 'utf8'), 'unique report and scratch\n');
  const completion = events(f).find(e => e.type === 'closeout.effect' && e.outcome.action === 'lane-removed');
  const source = events(f).find(e => e.type === 'promotion.reconciled');
  assert.ok(Date.parse(completion.at) - Date.parse(source.at) < 1800000, 'no scheduling delay before closeout');
  const nativeActions = f.read().actions;
  f.drain(); assert.deepEqual(f.read().actions, nativeActions, 'completed effects do not repeat');
});

for (const abandoned of [false, true, 'at-landing']) test(`a fix round retains its ${abandoned === 'at-landing' ? 'unreported until landing' : abandoned ? 'record-superseded' : 'reported'} worker, and landing closes every ended session in that lane`, t => {
  const f = setup(t);
  if (abandoned) {
    readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
    if (abandoned === true) f.append([{ type: 'run.abandoned', id: 'R-1', note: 'superseded by a fresh fix worker' }]);
  } else f.report();
  f.drain();
  assert.deepEqual(f.read().actions, [], 'the worker stays available during review and fixes');
  fs.writeFileSync(path.join(f.lane, 'seed'), 'fixed'); f.git(['commit', '-am', 'fix'], f.lane);
  const head = f.git(['rev-parse', 'HEAD'], f.lane); f.git(['merge', '--ff-only', head]);
  f.state.tabs.push({ tab_id: 'w:fix', workspace_id: 'w' });
  f.state.panes.push({ pane_id: 'w:fix:p', tab_id: 'w:fix', workspace_id: 'w', terminal_id: 'fix-terminal' });
  f.state.agents.push({ ...f.state.agents[0], name: 'fix-worker', pane_id: 'w:fix:p', tab_id: 'w:fix',
    terminal_id: 'fix-terminal', agent_session: { value: 'fix-session' } });
  f.save();
  const base = f.options.command;
  f.options.command = (exe, args, opt) => {
    if (exe !== f.job.herdr) return base(exe, args, opt);
    const current = f.read(), out = result => ({ status: 0, stdout: JSON.stringify({ result }), stderr: '' });
    if (args[0] === 'pane' && args[1] === 'process-info') return out({ process_info: current.exited?.includes(args.at(-1)) ? {
      shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true, process_tree: [current.info.process_tree[0]],
    } : current.info });
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const agent = current.agents.find(a => a.name === args[2]);
      current.actions.push(args); current.exited = [...(current.exited ?? []), agent.pane_id];
      current.agents = current.agents.filter(a => a.name !== args[2]); fs.writeFileSync(f.file, JSON.stringify(current)); return out({});
    }
    return base(exe, args, opt);
  };
  f.append([{ type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane, meta: { agent: 'fix-worker', pane: 'w:fix:p',
    worker_workspace: 'w', terminal_id: 'fix-terminal', agent_session_id: 'fix-session', lane: 'topic' } },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } }]);
  if (abandoned === 'at-landing') {
    f.append([{ type: 'run.abandoned', id: 'R-1', note: 'explicit supersession at reconciliation' }, { type: 'item.closed', id: 'ENG-1', as: 'done' }]);
    f.drain(); assert.deepEqual(f.read().actions, [], 'the successor remains observable for the new supersession proof');
  }
  f.append([...(abandoned === 'at-landing' ? [] : [{ type: 'item.closed', id: 'ENG-1', as: 'done' }]),
    { type: 'promotion.reconciled', identity: f.common, heads: [{ run: 'R-2', item: 'ENG-1', head }], runs: ['R-2'], items: ['ENG-1'] }]);
  const landed = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.deepEqual(landed.panes.map(p => p.run), ['R-1', 'R-2']);
  f.drain(); assertRemoved(f);
  assert.deepEqual(f.read().actions.filter(a => a[0] === 'agent').map(a => a[2]), ['worker', 'fix-worker']);
  assert.equal(f.read().actions.filter(a => a[0] === 'tab').length, 2);
  if (abandoned) assert.ok(events(f).some(e => e.type === 'retirement.release' && e.run === 'R-1'));
});

function reviewFixture(t, followup_expected = false) {
  const f = setup(t), initial = events(f);
  initial[1].meta = { ...initial[1].meta, agent: 'original-worker', pane: 'original-pane', terminal_id: 'original-terminal', agent_session_id: 'original-session' };
  fs.writeFileSync(f.eventFile, initial.map(e => JSON.stringify(e) + '\n').join(''));
  f.report();
  const r = f.retirement(f.options);
  r.recordCallback({ kind: 'settle', pane: 'w:p', agent: 'worker', run: 'R-1' });
  const evidence = path.join(f.scratch, 'review.md'), bytes = '**NEEDS-WORK**\nFindings retained.\n';
  fs.writeFileSync(evidence, bytes);
  const receipt = r.recordReviewVerdict({ pane: 'w:p', run: 'R-1', verdict: 'NEEDS-WORK', head: f.head,
    evidence, sha256: createHash('sha256').update(bytes).digest('hex'), followup_expected, deferCloseout: true });
  recordCompletedReview({ cwd: f.repo, org: f.org, receipt, head: f.head, item: 'ENG-1', start: false, env: f.env });
  return f;
}

test('review.verdict releases only its exact reviewer and preserves the worker and lane for fixes', t => {
  const f = reviewFixture(t), before = fold(events(f));
  assert.equal(events(f).filter(e => e.type === 'review.verdict').length, 1);
  f.drain();
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.read().workspaces.length, 1, 'pane-only release cannot close a workspace');
  assert.equal(events(f).find(e => e.type === 'retirement.release').recipient, 'reviewer');
  assert.deepEqual(fold(events(f)).runs, before.runs);
  assert.deepEqual(olderFold(events(f)).runs, olderFold(events(f).filter(e => !e.type.startsWith('review.') && !e.type.startsWith('closeout.'))).runs);
});

test('an explicit same-session reviewer follow-up keeps until its recorded end', t => {
  const f = reviewFixture(t, true);
  f.drain(); assert.deepEqual(f.read().actions, []);
  const review = events(f).find(e => e.type === 'review.verdict');
  f.append([{ type: 'review.followup-ended', review_id: review.review.id, run: review.run, item: review.item, source_seq: review.seq, why: 'follow-up completed' }]);
  f.drain(); assert.equal(f.read().actions.filter(a => a[0] === 'tab').length, 1);
});

test('HOLD stays deferred with a named resolving event; explicit removal retry re-enqueues and closes', t => {
  const f = setup(t, { terminal: true }), releaseHold = hold(f);
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.waiting.event === 'hold-removed'));
  releaseHold();
  const before = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, before, 'removing an unobservable file is not an implicit poll');
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'hold-removed', start: false });
  f.drain(); assertRemoved(f);
});

for (const changed of ['head', 'pane', 'dirty', 'reference']) test(`${changed} changes keep the bound target with a recorded reason`, t => {
  const f = setup(t, { terminal: true });
  if (changed === 'head' || changed === 'dirty') fs.writeFileSync(path.join(f.lane, 'seed'), 'later work');
  if (changed === 'head') f.git(['commit', '-am', 'later'], f.lane);
  if (changed === 'pane') { f.state.agents[0].agent_session.value = 'replacement'; f.save(); }
  if (changed === 'reference') fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({ schema: 'herdr-reference/v1', owner: 'fixture',
    kind: 'named follow-up', job: 'follow-up', run: 'R-1', item: 'ENG-1', state: 'running', created_at: '2020-01-01', expires_at: '2099-01-01' }));
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.reason && e.waiting.retry));
  assert.equal(fs.existsSync(f.lane), true);
});

test('a blocked target does not hold an unrelated eligible target at the head of the queue', t => {
  const f = setup(t, { terminal: true }), other = path.join(f.scratch, 'other');
  fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({ schema: 'herdr-reference/v1', owner: 'fixture',
    kind: 'named follow-up', job: 'follow-up', run: 'R-1', item: 'ENG-1', state: 'running', created_at: '2020-01-01', expires_at: '2099-01-01' }));
  f.git(['worktree', 'add', '-b', 'lane/other', other]);
  fs.writeFileSync(path.join(other, 'seed'), 'other work'); f.git(['commit', '-am', 'other'], other);
  const head = f.git(['rev-parse', 'HEAD'], other); f.git(['merge', '--ff-only', head]);
  f.append([{ type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer' },
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace: other, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } }, { type: 'item.closed', id: 'ENG-2', as: 'done' },
    { type: 'promotion.reconciled', identity: f.common, heads: [{ run: 'R-2', item: 'ENG-2', head }], runs: ['R-2'], items: ['ENG-2'] }]);
  fs.writeFileSync(path.join(f.common, 'closeout/entries', `${'f'.repeat(64)}.json`), '{"schema":"closeout-entry/v999"}\n');
  f.drain();
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(fs.existsSync(other), false);
  assert.ok(effects(f).some(e => e.action === 'lane-removed' && e.cwd === other));
  assert.ok(events(f).some(e => e.type === 'closeout.invalid' && e.waiting.event === 'entry-repaired'));
});

test('an ended, explicitly dropped unmerged lane is archive-tagged and its evidence survives removal', t => {
  const f = setup(t, { occupied: false, merged: false });
  f.report(); f.append([{ type: 'item.closed', id: 'ENG-1', as: 'dropped' }]);
  f.drain(); assertRemoved(f);
  assert.equal(f.git(['rev-parse', 'refs/tags/archive/lane/topic']), f.head);
  assert.ok(effects(f).some(e => e.action === 'archive-created'));
});

test('restart after agent exit and a failed shell close resumes the shell without sending exit twice', t => {
  const f = setup(t, { terminal: true });
  f.state.failClose = true; f.save();
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  const current = f.read(); current.failClose = false; fs.writeFileSync(f.file, JSON.stringify(current));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'native close transport recovered', start: false });
  f.drain(); assertRemoved(f);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'exit-observed').length, 1);
});

test('restart after worktree removal revalidates preservation and finishes branch/workspace separately', t => {
  const f = setup(t, { terminal: true });
  const [root] = JSON.parse(f.env.HERDR_TEST_SCRATCH_ROOTS), own = path.join(root, 'topic-review');
  fs.mkdirSync(own); fs.writeFileSync(path.join(own, 'result'), 'disposable');
  let refuse = 'worktree';
  const base = f.options.command;
  f.options.command = (exe, args, opt) => exe === 'git' && ((args.includes('-D') && refuse === 'branch') ||
    (args.includes('worktree') && args.includes('remove') && refuse === 'worktree')) ?
    { status: 1, stderr: 'injected branch deletion refusal', stdout: '' } : base(exe, args, opt);
  f.drain();
  assert.equal(fs.existsSync(f.lane), true);
  const discarded = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.existsSync(discarded.evidence.directory), false, 'failed-removal duplicate was safely discarded');
  assert.equal(fs.existsSync(discarded.scratchManifest), false, 'fallback attempt was discarded with its duplicate evidence');
  assert.ok(fs.existsSync(own));
  refuse = 'branch';
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'worktree removal recovered', start: false });
  f.drain();
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(fs.existsSync(own), 'scratch survives partial Git removal');
  const interrupted = effects(f).findLast(e => e.action === 'lane-preflight');
  assert.equal(JSON.parse(fs.readFileSync(interrupted.scratchManifest)).phase, 'not-executed');
  assert.ok(effects(f).some(e => e.action === 'worktree-removed'));
  refuse = null;
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'branch deletion recovered', start: false });
  f.drain(); assertRemoved(f);
  assert.equal(fs.existsSync(own), false, 'queue recovery uses the guarded scratch sweep');
  const completed = effects(f).find(e => e.action === 'lane-removed');
  const manifest = assertFixtureScratch(completed.scratchManifest, f.env);
  assert.equal(manifest.phase, 'complete'); assert.equal(manifest.recovery.manifest, interrupted.scratchManifest);
  assert.equal(manifest.entries.find(entry => entry.path === own).disposition, 'removed');
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'lane-preflight').length, 2, 'each preservation manifest retains its own receipt');
});

test('lost native exit, shell-close and workspace-close replies reconcile exact identity without repeating effects', t => {
  const f = setup(t, { terminal: true }), base = f.options.command, lost = new Set();
  f.options.command = (exe, args, opt) => {
    const result = base(exe, args, opt), key = args.slice(0, 2).join(' ');
    if (exe === f.job.herdr && ['agent prompt', 'tab close', 'workspace close'].includes(key) && !lost.has(key)) {
      lost.add(key); return { ...result, status: 1, stderr: 'injected lost acknowledgement' };
    }
    return result;
  };
  f.drain();
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'reconcile lost native replies', start: false });
  f.drain(); assertRemoved(f);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  assert.ok(effects(f).some(e => e.action === 'closed' && e.tab_id === 'w:t' && e.reconciled));
  assert.ok(effects(f).some(e => e.action === 'closed' && e.workspace_id === 'w' && e.reconciled));
});

test('queue ownership skips both scheduled retirement passes and promotion-owned cleanup', t => {
  const f = setup(t, { terminal: true }), logs = [];
  const release = retirementLock(retirementOwnerLock(f.common)); t.after(release);
  assert.equal(tidyFinishedTabs({ cwd: f.repo, org: f.org, command: () => { throw Error('must not launch tidy'); }, log: e => logs.push(e) }), true);
  const housekeeping = createHousekeeping({ cwd: f.repo, org: f.org, herdr: f.job.herdr, record: undefined,
    command: f.options.command, log: e => logs.push(e) });
  assert.deepEqual(housekeeping.tick({ resume: false }).close, []);
  assert.deepEqual(f.read().actions, []);
  assert.ok(logs.some(e => e.action === 'retirement-skipped'));
  assert.equal(logs.some(e => /sweep|retirement-consumed|promotion-cleanup-retried/.test(e.action)), false);
  assert.equal(finishCleanup(f.job, { outcome: 'promoted' }, f.queue()).cleanup.owner, 'closeout-queue');
});

test('finished-lane age counts worktrees once, including protected/kept lanes, from reconciliation', t => {
  const f = setup(t, { terminal: true }), source = events(f).find(e => e.type === 'promotion.reconciled');
  const snapshot = f.retirement(f.options).observe(), generatedAt = new Date(Date.parse(source.at) + 1800001).toISOString();
  const status = retirementStatus(snapshot, { generatedAt, worktrees: [{ worktree: f.lane, branch: 'lane/topic', tip: f.head }] });
  assert.equal(status.finishedLanesOpenOver30Minutes, 1);
  assert.match(renderRetirementStatus(status), /Finished lanes open longer than 30 min: 1/);
});

test('the closer is finite, has no timers or polling, and a second claim cannot evaluate targets', t => {
  const f = setup(t, { terminal: true });
  const source = fs.readFileSync(new URL('../lib/closeout-executor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(|\bwhile\s*\(|for\s*\(\s*;\s*;/);
  let second;
  f.drain({ onClaim: () => { second = f.drain(); } });
  assert.equal(second.already_running, true);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false, 'consumer exits after drain');
});

test('activation refuses legacy housekeeping ownership until inspected replacement and an explicit retry', t => {
  const f = setup(t, { terminal: true }), owner = path.join(f.org, 'housekeeping/default/lock/owner.json');
  fs.mkdirSync(path.dirname(owner), { recursive: true });
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid }));
  f.drain(); assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => /ownership transfer/.test(e.reason)));
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid, retirement_queue_protocol: 2 }));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'legacy retirement stopped and inspected; adopted runtime restarted', start: false });
  f.drain(); assertRemoved(f);
});

test('source publication recovery retains the original binding when the old worktree name has been recreated', t => {
  const f = setup(t, { occupied: false, terminal: true });
  const source = events(f).find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  fs.unlinkSync(path.join(f.common, 'closeout/entries', `${entry.key}.json`));
  f.git(['worktree', 'remove', f.lane]); f.git(['worktree', 'add', f.lane, 'lane/topic']);
  publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], start: false });
  const recovered = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.deepEqual(recovered.worktreeIdentity, entry.worktreeIdentity);
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  assert.ok(evaluations(f).some(e => /identity/.test(e.reason)));
});

test('a report on disk is inert; the actual ingest CLI carries the same optional ready signal', async t => {
  const f = setup(t), file = path.join(f.scratch, 'report.md');
  fs.writeFileSync(file, '---\nrun: R-1\noutcome: done\nsummary: Complete.\nheadline: The change is complete.\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\ndecisions: []\nquestions: []\nchallenges: []\n---\n');
  assert.deepEqual(readCloseoutEntries(f.common), []);
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  const result = spawnSync(process.execPath, [cli, 'ingest', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(readCloseoutEntries(f.common).length, 1);
  assert.deepEqual(f.read().actions, []);
  assert.equal(events(f).filter(e => e.type === 'report.ingested').length, 1);
});

test('complete-batch binds but cannot start landing; its successful caller tail closes once', async t => {
  const f = setup(t, { merged: true });
  assert.equal(closeoutPolicy(f.repo), true); f.report();
  const gate = path.join(f.scratch, 'gate.log'); fs.writeFileSync(gate, 'offline accepted gate\n');
  const plan = { version: 1, org: f.org, batch: 'bch-eng-1661', identity: f.common, base: f.head, tip: f.head,
    prepared_seq: events(f).at(-1).seq,
    gate: { exit_code: 0, log: gate, sha256: createHash('sha256').update(fs.readFileSync(gate)).digest('hex') },
    items: [{ item: 'ENG-1', run: 'R-1', head: f.head, expected: completionFingerprint(fold(events(f)), 'ENG-1'), why: 'accepted', superseded: [] }], excluded: [] };
  const file = path.join(f.scratch, 'completion.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const result = spawnSync(process.execPath, [cli, 'complete-batch', '--file', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false);
  assert.equal(evaluations(f).length, 0);
  handoffCloseout({ cwd: f.repo, org: f.org, receipt: file, env: f.env });
  f.drain();
  assertRemoved(f);
  assert.equal(events(f).find(e => e.type === 'item.closed').as, 'done');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
});

test('the opted-in native train lands and delegates closeout', async t => {
  let f;
  // After hooks run in registration order. Stop the owner and its lifetime
  // watcher before fixture() removes the scratch directory and owner receipt.
  t.after(async () => {
    if (!f) return;
    assert.ok(fs.existsSync(f.scratch), 'inbox teardown must precede fixture scratch removal');
    await stopFixtureInbox(path.join(f.org, 'supervisor/inbox.log'), {
      script: fileURLToPath(new URL('../supervisor/prompt-supervisor.mjs', import.meta.url)) });
  });
  f = setup(t, { occupied: false }); f.report();
  const queue = queueFor(f.repo);
  enqueue(queue, ['topic'], { org: f.org, run: 'R-1', expectedHead: f.head,
    validate: 'true', laneCLI: lanes, herdr: f.job.herdr, to: 'fixture-supervisor', attempts: 1, retry: 0 });
  await drainPromotions(queue);
  const result = queue.load().results[0];
  assert.equal(result.outcome, 'promoted', JSON.stringify(result));
  assert.equal(result.cleanup.owner, 'closeout-queue');
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
  assertRemoved(f);
  const landed = events(f).find(e => e.type === 'promotion.reconciled');
  assert.equal(landed.closeout_targets[0].signal, 'landed');
  assert.equal(closeoutPolicy(f.repo), true);
});

test('named manual recovery records a fresh bound request for a legacy lane without a landed queue entry', async t => {
  const f = setup(t, { merged: true }); f.report(); f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }]);
  assert.equal(readCloseoutEntries(f.common).some(e => e.signal === 'landed'), false);
  const result = spawnSync(process.execPath, [retirementCLI, 'sweep', '--lane', f.lane, '--repo', f.repo, '--org', f.org], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assertRemoved(f);
  assert.equal(events(f).find(e => e.type === 'lane.recovery-requested').closeout_targets[0].signal, 'landed');
});

function manualContentFixture(t, kind) {
  const f = setup(t, { occupied: false, merged: kind === 'integrated' });
  const original = events(f); original[0].parent = 'G-1';
  fs.writeFileSync(f.eventFile, original.map(e => JSON.stringify(e) + '\n').join(''));
  f.append([{ type: 'item.added', id: 'G-1', kind: 'goal' }]); f.report();
  if (kind === 'archival-retirement') {
    fs.writeFileSync(path.join(f.repo, 'main-only'), 'independent main work');
    f.git(['add', 'main-only']); f.git(['commit', '-qm', 'diverge main']);
    f.git(['cherry-pick', f.head]);
    assert.match(f.git(['cherry', 'main', f.head]), /^- /);
    assert.notEqual(f.git(['rev-parse', 'main']), f.head);
  }
  if (kind === 'archive-tagged') {
    f.git(['tag', 'archive/lane/topic', f.head]);
    f.append([{ type: 'run.abandoned', id: 'R-1', note: 'Explicitly superseded attempt' }]);
  }
  return f;
}

function manualSweep(f) {
  // The CLI and its detached consumer use the same deterministic native cwd/
  // file inventory as the in-process adapter fixtures. Git and Herdr stay real
  // disposable fixtures; no host process inventory is needed for these cases.
  const preload = path.join(f.scratch, 'native-inventory.cjs');
  fs.writeFileSync(preload, `const cp = require('node:child_process'), run = cp.spawnSync;
cp.spawnSync = (exe, args, options) => {
  if (exe === '/usr/sbin/lsof') return { status: 0, stderr: '', stdout:
    'p' + process.pid + '\\0' + (args.includes('-Fpfn0') ? 'fcwd\\0' : '') + 'n' + ${JSON.stringify(f.repo)} + '\\0\\n' };
  return run(exe, args, options);
};
require('node:module').syncBuiltinESMExports();\n`);
  return spawnSync(process.execPath, [retirementCLI, 'sweep', '--lane', f.lane, '--repo', f.repo, '--org', f.org], {
    cwd: f.repo, env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` }, encoding: 'utf8' });
}

for (const kind of ['integrated', 'archival-retirement', 'archive-tagged']) test(`opted-in sweep CLI releases a ${kind} legacy lane with an open item and parent`, async t => {
  const f = manualContentFixture(t, kind);
  assert.equal(readCloseoutEntries(f.common).some(e => ['landed', 'parked'].includes(e.signal)), false);
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/report.md'), 'durable legacy evidence\n');
  const result = manualSweep(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const source = events(f).find(e => e.type === 'lane.recovery-requested');
  assert.equal(source.content.kind, kind); assert.equal(source.content.head, f.head);
  assert.deepEqual(source.closeout_targets[0].content, source.content);
  await waitForChange([f.eventFile], () => evaluations(f).some(e => e.source.seq === source.seq) &&
    !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
  assert.equal(evaluations(f).findLast(e => e.source.seq === source.seq).completed, true, JSON.stringify(evaluations(f)));
  assertRemoved(f);
  const state = fold(events(f));
  assert.equal(state.items.get('ENG-1').closed, null); assert.equal(state.items.get('G-1').closed, null);
  const proof = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/report.md'), 'utf8'), 'durable legacy evidence\n');
  if (kind !== 'integrated') {
    assert.equal(proof.integrated, false);
    assert.equal(f.git(['rev-parse', 'archive/lane/topic^{commit}']), f.head);
  }
  if (kind === 'archival-retirement') {
    assert.equal(proof.eligibility, kind); assert.equal(proof.archival.matchedPatchCount, 1);
    assert.equal(proof.mainTip, source.content.mainTip);
  }
});

for (const changed of ['patch history', 'patch policy', 'archive removed', 'archive moved']) test(`the closeout consumer rechecks named recovery after ${changed} changes`, t => {
  const kind = changed.startsWith('patch') ? 'archival-retirement' : 'archive-tagged';
  const f = manualContentFixture(t, kind);
  const source = recoverLane({ cwd: f.repo, org: f.org, lane: f.lane, env: f.env, start: false });
  assert.equal(source.content.kind, kind);
  assert.deepEqual(readCloseoutEntries(f.common).find(e => e.signal === 'landed').content, source.content);
  if (changed === 'patch history') f.git(['reset', '--hard', 'HEAD^']);
  if (changed === 'patch policy') fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true,"archival_retirement":false}}');
  if (changed === 'archive removed') f.git(['tag', '-d', 'archive/lane/topic']);
  if (changed === 'archive moved') f.git(['tag', '-f', 'archive/lane/topic', 'main']);
  f.drain();
  const evaluated = evaluations(f).find(e => e.source.seq === source.seq);
  assert.equal(evaluated.completed, false); assert.match(evaluated.reason, /not integrated|does not match/);
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.deepEqual(f.read().actions, []);
  assert.equal(effects(f).some(e => ['archive-created', 'lane-preflight', 'lane-removed'].includes(e.action)), false);
  if (!changed.startsWith('archive moved')) assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
});

test('opted-in sweep CLI keeps unintegrated untagged work with an open item', t => {
  const f = manualContentFixture(t, 'unintegrated'), result = manualSweep(f);
  assert.equal(result.status, 1); assert.match(result.stderr, /not integrated or exactly archived/);
  assert.equal(events(f).some(e => e.type === 'lane.recovery-requested'), false);
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
  assert.deepEqual(f.read().actions, []);
});

function child(exe, args, options) {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, options); let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
    c.once('error', reject); c.once('close', status => resolve({ status, stdout, stderr }));
  });
}

test('two concurrent ready enqueues bind one entry and one live closer; shutdown enqueue is not stranded', async t => {
  const f = setup(t), stop = hold(f); f.report(); f.land();
  f.state.delayWorkspace = 25; f.save();
  const results = await Promise.all([1, 2].map(() => child(process.execPath, [lanes, 'ready', 'topic'], { cwd: f.repo, env: f.env })));
  for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(readCloseoutEntries(f.common).filter(e => e.signal === 'ready').length, 1);
  // A retry arrives at the atomic empty-exit handoff. It must get either this
  // consumer or a newly claimed consumer; it cannot disappear between them.
  let wake;
  f.drain({ beforeExit: () => { stop(); wake = child(process.execPath, [closer, 'retry', 'topic', '--why', 'hold-removed'], { cwd: f.repo, env: f.env }); } });
  const result = await wake; assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assertRemoved(f);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1);
});

test('an active consumer skips an unhanded landing and explicit event replay cannot start it', t => {
  const f = setup(t, { occupied: false, merged: true }); f.report(); f.autoTail = false;
  let source;
  const first = f.drain({ onClaim: () => {
    source = f.land().find(e => e.type === 'promotion.reconciled');
    publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], env: f.env });
  } });
  assert.equal(first.evaluated.some(e => e.source.type === 'promotion.reconciled'), false);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false);
  const keys = handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  const result = f.drain({ keys });
  assert.equal(result.evaluated.filter(e => e.completed && e.source.type === 'promotion.reconciled').length, 1, JSON.stringify(result));
  assertRemoved(f);
  f.drain(); // Finish the earlier ready request's separate lane-removed revision.
  const before = events(f); handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  f.drain(); assert.deepEqual(events(f), before);
});

test('native observation, exit and preservation preflight hold only consumer/retirement claims; Git removal alone excludes promotion', t => {
  const f = setup(t), command = f.options.command, log = f.options.log;
  f.report(); initOrg(f.org);
  const manifest = path.join(f.scratch, 'replay-manifest.json'), prepared = path.join(f.scratch, 'replay-prepared.json'), gate = path.join(f.scratch, 'replay-gate.log');
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'native-lock-witness', candidate: f.head,
    items: [{ item: 'ENG-1', run: 'R-1', head: f.head, superseded: [], why: 'accepted offline witness' }], excluded: [] }));
  const args = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
  reconcile(['prepare', ...args, '--manifest', manifest, '--gate-log', gate]);
  f.git(['merge', '--ff-only', f.head]); fs.writeFileSync(gate, 'one successful offline gate\n');
  const finish = () => reconcile(['finish', ...args, '--gate-exit', '0', '--tip', f.head]);
  finish(); handoffCloseout({ cwd: f.repo, org: f.org, receipt: prepared + '.record.json', env: f.env });
  const phases = new Set();
  const checkUnlocked = phase => {
    assert.ok(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
    assert.ok(fs.existsSync(retirementOwnerLock(f.common)));
    assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false, phase);
    if (!phases.has(phase)) assert.equal(finish().replayed, true);
    phases.add(phase);
  };
  f.options.command = (exe, args, opt) => {
    if (exe === f.job.herdr && args[0] === 'workspace' && args[1] === 'list') checkUnlocked('native');
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt') checkUnlocked('exit');
    if (exe === 'git' && args.includes('remove')) {
      assert.ok(fs.existsSync(path.join(f.common, 'lane-promote.lock')));
      assert.throws(finish, /locked:.*lane-promote.lock/);
      phases.add('Git');
    }
    return command(exe, args, opt);
  };
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') checkUnlocked('preflight'); };
  f.drain(); assertRemoved(f); assert.equal(finish().replayed, true);
  assert.deepEqual([...phases].sort(), ['Git', 'exit', 'native', 'preflight']);
});

test('closer lock contention is immediate and discards preparation; an explicit revision observes again', t => {
  const f = setup(t, { occupied: false, terminal: true }), release = acquireLock(path.join(f.common, 'lane-promote.lock'));
  try {
    f.drain();
    assert.ok(evaluations(f).some(e => e.waiting?.event === 'lifecycle-lock-released'));
    assert.equal(fs.existsSync(f.lane), true);
    assert.equal(effects(f).some(e => e.action === 'worktree-removed'), false);
  } finally { release(); }
  const old = evaluations(f).length, native = f.herdrCalls().length;
  f.drain(); assert.equal(evaluations(f).length, old, 'lock release is not a polling signal');
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'lifecycle-lock-released', start: false });
  f.drain(); assertRemoved(f); assert.ok(f.herdrCalls().length > native);
});

for(const change of ['activity','owner','reference','HOLD'])test(`retirement housekeeping final CAS ${change==='activity'?'allows unrelated activity':'retains '+change+' changes'}`,t=>{
  const f=setup(t,{occupied:false,terminal:true}),command=f.options.command,log=f.options.log,job=path.join(f.org,'housekeeping/default'),lock=path.join(job,'lock');fs.mkdirSync(lock,{recursive:true});
  const owner=path.join(lock,'owner.json');fs.writeFileSync(owner,JSON.stringify({pid:40001,cwd:f.repo,retirement_queue_protocol:2}));let prepared=false,changed=false;
  f.options.log=row=>{log(row);if(row.action==='lane-preflight')prepared=true;};
  f.options.command=(exe,args,opt)=>{
    if(prepared&&!changed&&exe==='git'&&fs.existsSync(path.join(f.common,'lane-promote.lock'))){
      changed=true;
      if(change==='activity'){fs.writeFileSync(path.join(job,'state.json'),'another ordinary pass');fs.appendFileSync(path.join(job,'activity.jsonl'),'unrelated heartbeat\n');}
      if(change==='owner')fs.writeFileSync(owner,JSON.stringify({pid:40002,cwd:f.repo,retirement_queue_protocol:2}));
      if(change==='reference'){fs.mkdirSync(path.join(f.org,'references'),{recursive:true});fs.writeFileSync(path.join(f.org,'references/live.json'),JSON.stringify({schema:'herdr-reference/v1',owner:'fixture',kind:'live',run:'R-1',cwd:f.lane,state:'running',created_at:'2020-01-01',expires_at:'2099-01-01'}));}
      if(change==='HOLD')hold(f);
    }
    return command(exe,args,opt);
  };
  const result=f.drain();assert.equal(changed,true,'changed input reaches the final locked removal boundary');
  if(change==='activity')assertRemoved(f);
  else{assert.equal(fs.existsSync(f.lane),true);assert.equal(effects(f).some(e=>e.action==='lane-removed'),false);assert.ok(evaluations(f).some(e=>!e.completed),JSON.stringify(result));}
});

for (const change of ['tip', 'branch generation', 'worktree identity', 'Git directory identity', 'registration', 'untracked', 'index flags',
  'integration', 'source', 'handoff', 'open run', 'job', 'callback', 'reference', 'HOLD', 'protected slot', 'manifest', 'preserved copy', 'source evidence', 'archive collision', 'policy'])
test(`guarded removal keeps when ${change} changes after preparation`, t => {
  const f = setup(t, { occupied: false, terminal: true }), command = f.options.command, log = f.options.log;
  let proof, reads = 0, changed = false;
  const mutate = () => {
    changed = true;
    const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
    if (change === 'tip') { fs.writeFileSync(path.join(f.lane, 'seed'), 'new work'); f.git(['commit', '-am', 'new work'], f.lane); }
    if (change === 'branch generation') { f.git(['update-ref', `refs/heads/${entry.branch}`, `${entry.head}^`]); f.git(['update-ref', `refs/heads/${entry.branch}`, entry.head]); }
    if (change === 'worktree identity') { fs.renameSync(f.lane, f.lane + '-old'); fs.mkdirSync(f.lane); }
    if (change === 'Git directory identity') { fs.renameSync(entry.gitDirectory, entry.gitDirectory + '-old'); fs.cpSync(entry.gitDirectory + '-old', entry.gitDirectory, { recursive: true }); }
    if (change === 'registration') fs.writeFileSync(path.join(entry.gitDirectory, 'gitdir'), f.lane + '-elsewhere/.git\n');
    if (change === 'untracked') fs.writeFileSync(path.join(f.lane, 'new-file'), 'untracked');
    if (change === 'index flags') f.git(['update-index', '--skip-worktree', 'seed'], f.lane);
    if (change === 'integration') f.git(['reset', '--hard', 'HEAD^']);
    if (change === 'source') {
      const all = events(f), source = all.find(e => e.seq === entry.source.seq); source.closeout_targets[0].head = '0'.repeat(40);
      fs.writeFileSync(f.eventFile, all.map(e => JSON.stringify(e) + '\n').join(''));
    }
    if (change === 'handoff') {
      const handoff = events(f).find(e => e.type === 'closeout.handoff'); fs.appendFileSync(handoff.checkpoint, 'changed');
    }
    if (change === 'open run') f.append([{ type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane, meta: {} }]);
    if (change === 'job') {
      const queue = queueFor(f.repo); queue.transaction(data => data.pending.push({ id: 'live', run: 'R-1', topic: 'topic', cwd: f.lane }));
    }
    if (change === 'callback') {
      fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
      fs.writeFileSync(path.join(f.org, 'settle/R-1.json'), JSON.stringify({ common: f.common, run: 'R-1', workspace: f.lane, stage: 'review' }));
    }
    if (change === 'reference') fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({
      schema: 'herdr-reference/v1', owner: 'fixture', kind: 'live', job: 'live', item: 'ENG-1', run: 'R-1', state: 'running',
      created_at: '2020-01-01', expires_at: '2099-01-01' }));
    if (change === 'HOLD') hold(f);
    if (change === 'protected slot') {
      fs.mkdirSync(path.join(f.common, 'sessions'), { recursive: true }); fs.writeFileSync(path.join(f.common, 'sessions/standard-slots.json'), '{"schema":"unknown"}');
    }
    if (change === 'manifest') fs.appendFileSync(proof.evidence.manifest, 'changed');
    if (change === 'preserved copy') fs.writeFileSync(path.join(proof.evidence.directory, 'files/changed'), 'new evidence');
    if (change === 'source evidence') { fs.mkdirSync(path.join(f.lane, '.lane')); fs.writeFileSync(path.join(f.lane, '.lane/new-evidence'), 'new evidence'); }
    if (change === 'archive collision') f.git(['tag', 'archive/lane/topic', `${f.head}^`]);
    if (change === 'policy') fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":false}}');
  };
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') proof = row; };
  f.options.command = (exe, args, opt) => {
    const result = command(exe, args, opt);
    if (proof && exe === '/usr/sbin/lsof' && ++reads === 2) mutate();
    return result;
  };
  const result = f.drain();
  assert.ok(changed, 'mutation reached the boundary after selecting the candidate');
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(effects(f).some(e => ['worktree-removed', 'branch-removed', 'lane-removed'].includes(e.action)), false, JSON.stringify(result));
  assert.ok(result.restart || evaluations(f).some(e => !e.completed && e.reason));
  if (change !== 'archive collision') assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
});

test('a new native occupant before the final observation invalidates the selected vacancy', t => {
  const f = setup(t, { occupied: false, terminal: true }), command = f.options.command, log = f.options.log;
  let prepared = false, observations = 0;
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') prepared = true; };
  f.options.command = (exe, args, opt) => {
    if (prepared && exe === f.job.herdr && args[0] === 'workspace' && args[1] === 'list' && ++observations === 2) {
      f.state.panes.push({ pane_id: 'new:p', tab_id: 'new:t', workspace_id: 'w' });
      f.state.tabs.push({ tab_id: 'new:t', workspace_id: 'w' }); f.save();
    }
    return command(exe, args, opt);
  };
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  assert.ok(evaluations(f).some(e => !e.completed));
  assert.equal(effects(f).some(e => e.action === 'worktree-removed'), false);
});

test('v1 is held until exact-key migration; interruption after the migration journal resumes the same bytes', t => {
  const f = setup(t, { occupied: false }); f.report();
  const [v2] = readCloseoutEntries(f.common), all = events(f), source = all.find(e => e.seq === v2.source.seq);
  source.closeout_targets[0].schema = 'closeout-entry/v1';
  fs.writeFileSync(f.eventFile, all.map(e => JSON.stringify(e) + '\n').join(''));
  const entry = { ...v2, schema: 'closeout-entry/v1' }, file = path.join(f.common, 'closeout/entries', `${entry.key}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
  f.drain(); assert.equal(evaluations(f).length, 0);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw Error('interrupted atomic conversion'); return rename(from, to); };
  try { assert.throws(() => migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env }), /interrupted/); }
  finally { fs.renameSync = rename; }
  assert.equal(readCloseoutEntries(f.common)[0].schema, 'closeout-entry/v1');
  assert.equal(events(f).filter(e => e.type === 'closeout.migrated').length, 1);
  migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env });
  const [converted] = readCloseoutEntries(f.common);
  assert.equal(converted.schema, 'closeout-entry/v2'); assert.equal(converted.cwd, entry.cwd); assert.equal(converted.key, entry.key);
  assert.deepEqual(migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env }), [entry.key]);
  f.drain(); assert.ok(evaluations(f).some(e => e.key === entry.key));
  assert.equal(events(f).filter(e => e.type === 'closeout.migrated').length, 1);
});

test('v1 landed migration requires the original successful completion tail and preserves the exact original target', t => {
  const f = setup(t, { occupied: false }); f.report(); f.autoTail = false;
  const source = f.land().find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed'), all = events(f);
  all.find(e => e.seq === source.seq).closeout_targets[0].schema = 'closeout-entry/v1';
  fs.writeFileSync(f.eventFile, all.map(e => JSON.stringify(e) + '\n').join(''));
  const file = path.join(f.common, 'closeout/entries', `${entry.key}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...entry, schema: 'closeout-entry/v1' }) + '\n');
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  assert.throws(() => migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env }), /original completion receipt/);
  migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, receipt: f.receipts.get(source.batch), env: f.env });
  const converted = readCloseoutEntries(f.common).find(e => e.key === entry.key);
  assert.deepEqual(converted.worktreeIdentity, entry.worktreeIdentity); assert.equal(converted.head, entry.head);
  assert.equal(converted.source.seq, entry.source.seq); assert.ok(converted.handoff);
  const beforeTail = events(f).filter(e => e.type === 'closeout.handoff').length;
  handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  assert.equal(events(f).filter(e => e.type === 'closeout.handoff').length, beforeTail);
  f.drain(); assertRemoved(f);
});

test('a drain launched before fast-forward exits before evaluating the new landing; one fresh successor records the new bytes and epoch', async t => {
  const f = setup(t, { occupied: false }); f.report();
  const stop = hold(f), code = path.join(f.scratch, 'brain-code');
  const source = fileURLToPath(new URL('../', import.meta.url));
  f.git(['clone', '--quiet', '--shared', source, code]);
  f.git(['config', 'user.name', 'Fixture'], code); f.git(['config', 'user.email', 'fixture@example.invalid'], code);
  const beforeCode = f.git(['rev-parse', 'HEAD'], code), marker = path.join(f.scratch, 'loaded'), release = path.join(f.scratch, 'continue');
  const running = child(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { drainCloseout } from ${JSON.stringify(new URL('lib/closeout-consumer.mjs', 'file://' + code + '/').href)};
    import { restartCloseout } from ${JSON.stringify(new URL('lib/closeout-attempt.mjs', 'file://' + code + '/').href)};
    const cwd = ${JSON.stringify(f.repo)}, org = ${JSON.stringify(f.org)};
    const result = drainCloseout({ cwd, org, onClaim: binding => {
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(binding));
      const deadline = Date.now() + 60000;
      while (!fs.existsSync(${JSON.stringify(release)})) {
        if (Date.now() > deadline) throw Error('stale drain barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    } });
    const successor = result.restart && restartCloseout({ cwd, org, restart: result.restart });
    console.log(JSON.stringify({ result, successor }));
  `], { cwd: f.repo, env: f.env });
  let reply, currentCode, head;
  try {
    await waitForChange([marker], () => fs.existsSync(marker));
    // The production incident began 0.2 s before the fast-forward. The barrier
    // proves import/epoch order; elapsed time itself grants no authority.
    await pause(200);
    fs.appendFileSync(path.join(code, 'lib/closeout-consumer.mjs'), '\n// new landing implementation bytes\n');
    f.git(['commit', '-am', 'new closer bytes'], code); currentCode = f.git(['rev-parse', 'HEAD'], code);
    f.land(); head = f.git(['rev-parse', 'HEAD']);
  } finally {
    fs.writeFileSync(release, 'continue'); reply = await running; stop();
  }
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const result = JSON.parse(reply.stdout.trim());
  assert.deepEqual(result.result.evaluated, [], 'the old imports evaluated no post-landing entry');
  assert.equal(result.successor.exit, 0); assert.equal(result.successor.root, code);
  const handoffs = events(f).filter(e => e.type === 'closeout.code-handoff');
  assert.equal(handoffs.length, 1); assert.equal(handoffs[0].old.code.commit, beforeCode);
  assert.equal(handoffs[0].current.code.commit, currentCode);
  assert.notEqual(handoffs[0].old.epoch.tip, head);
  const landed = evaluations(f).filter(e => e.source.type === 'promotion.reconciled');
  assert.equal(landed.length, 1); assert.equal(landed[0].code.code.commit, currentCode); assert.equal(landed[0].code.epoch.tip, head);
  assert.match(landed[0].reason, /HOLD-WORKER-TAB-CLOSE/);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false);
  assert.equal(fs.existsSync(retirementOwnerLock(f.common)), false);
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'hold removed after joined fresh successor', start: false });
  f.drain(); assertRemoved(f);
});


test('a default-on named ready resolves an identical pre-existing automatic ready without rebinding its source', t => {
  const f = setup(t, { merged: true }); f.report();
  const [original] = readCloseoutEntries(f.common);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
  f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }]);
  f.drain(); assert.equal(evaluations(f).length, 0, 'removing full-source opt-in keeps the automatic entry');
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', run: 'R-1', start: false, env: f.env });
  assert.deepEqual(readCloseoutEntries(f.common)[0].source, original.source);
  f.drain();
  assert.equal(f.read().actions.filter(a => a[0] === 'tab' && a[1] === 'close').length, 1,
    JSON.stringify(evaluations(f)));
  assert.equal(fs.existsSync(f.lane), true, 'the ready key still supplies only pane authority');
});

for (const stage of ['checkpoint', 'publication']) test(`completion tail resumes after interruption at ${stage} without a lost handoff or duplicate effect`, t => {
  const f = setup(t, { occupied: false }); f.report(); f.autoTail = false;
  const source = f.land().find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  const file = path.join(f.common, 'closeout/entries', `${entry.key}.json`), open = fs.openSync, rename = fs.renameSync;
  let interrupted = false;
  fs.openSync = (target, flags, ...args) => {
    if (stage === 'checkpoint' && target === f.eventFile && flags === 'a') { interrupted = true; throw Error('interrupted completion checkpoint append'); }
    return open(target, flags, ...args);
  };
  fs.renameSync = (from, to) => {
    if (stage === 'publication' && to === file) { interrupted = true; throw Error('interrupted handoff publication acknowledgement'); }
    return rename(from, to);
  };
  const tail = () => handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  try { assert.throws(tail, /interrupted/); }
  finally { fs.openSync = open; fs.renameSync = rename; }
  assert.ok(interrupted);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(readCloseoutEntries(f.common).find(e => e.key === entry.key).handoff, undefined);
  f.drain(); assert.ok(!evaluations(f).some(e => e.source.seq === source.seq), 'an interrupted tail never becomes actionable');
  tail(); f.drain(); assertRemoved(f);
  const before = events(f); tail(); f.drain(); assert.deepEqual(events(f), before);
  assert.equal(events(f).filter(e => e.type === 'closeout.handoff').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
});

test('replacing an obsolete disposable handoff survives publication recovery, removal, restart and promotion bookkeeping', t => {
  const f = setup(t, { occupied: false }); f.report(); f.autoTail = false;
  const source = f.land().find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  const inside = path.join(f.lane, '.lane/completion.record.json'); fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.copyFileSync(f.receipts.get(source.batch), inside);
  const before = events(f);
  assert.throws(() => handoffCloseout({ cwd: f.repo, org: f.org, receipt: inside, env: f.env }), /proof is inside a closing worktree/);
  assert.deepEqual(events(f), before); assert.equal(fs.existsSync(f.lane), true);
  assert.deepEqual(f.read().actions, []);
  // Retain history produced by a pre-guard writer, whose receipt/checkpoint
  // would both disappear at worktree removal. Recovery must leave it obsolete.
  const oldCheckpoint = inside + '.closeout.json';
  const oldTail = { schema: 'closeout-completion/v1', identity: f.common, project: f.repo, org: f.org,
    source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint, digest: digest(source), batch: source.batch },
    receipt: { file: inside, sha256: createHash('sha256').update(fs.readFileSync(inside)).digest('hex'), fingerprint: source.fingerprint }, keys: [entry.key] };
  fs.writeFileSync(oldCheckpoint, JSON.stringify(oldTail));
  f.append([{ type: 'closeout.handoff', identity: f.common, project: f.repo, org: f.org,
    source: { seq: source.seq, type: source.type }, checkpoint: oldCheckpoint, digest: digest(oldTail), keys: [entry.key] }]);
  const obsolete = events(f).find(e => e.type === 'closeout.handoff');
  const receipt = path.join(f.scratch, 'retained-completion.record.json'); fs.copyFileSync(inside, receipt);
  const entryFile = path.join(f.common, 'closeout/entries', `${entry.key}.json`), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === entryFile) throw Error('interrupted replacement publication'); return rename(from, to); };
  try { assert.throws(() => handoffCloseout({ cwd: f.repo, org: f.org, receipt, env: f.env }), /interrupted replacement publication/); }
  finally { fs.renameSync = rename; }
  const handoff = events(f).findLast(e => e.type === 'closeout.handoff');
  assert.notEqual(handoff.seq, obsolete.seq);
  assert.ok(handoff.checkpoint.startsWith(path.join(f.common, 'closeout/completions') + path.sep));
  fs.unlinkSync(entryFile); // Restart publication from the immutable source.
  publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], env: f.env, start: false });
  assert.deepEqual(readCloseoutEntries(f.common).find(e => e.key === entry.key).handoff, { seq: handoff.seq, digest: handoff.digest });
  const queue = queueFor(f.repo), job = { id: 'replacement-cleanup', org: f.org, run: entry.run, item: entry.item, topic: 'topic', tip: entry.head,
    outcome: 'promoted', delivered: true, reconciliation: { state: 'complete', fingerprint: source.fingerprint, receipt },
    cleanup: { state: 'pending', owner: 'closeout-queue', keys: [entry.key], source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint } } };
  queue.transaction(data => data.results.push(job));
  const command = f.options.command; let refuse = true;
  f.options.command = (exe, args, opt) => exe === 'git' && args.includes('-D') && refuse ?
    { status: 1, stdout: '', stderr: 'injected branch removal interruption' } : command(exe, args, opt);
  f.drain({ keys: [entry.key] });
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(fs.existsSync(receipt)); assert.ok(fs.existsSync(handoff.checkpoint));
  assert.equal(fs.existsSync(oldCheckpoint), false);
  assert.equal(evaluations(f).findLast(e => e.key === entry.key).completed, false);
  refuse = false;
  retryCloseout({ cwd: f.repo, org: f.org, topic: entry.key, why: 'branch removal recovered', env: f.env, start: false });
  f.drain({ keys: [entry.key] }); assertRemoved(f);
  assert.deepEqual(evaluations(f).findLast(e => e.key === entry.key).handoff, { seq: handoff.seq, digest: handoff.digest });
  assert.deepEqual(completedCloseoutKeys({ cwd: f.repo, org: f.org, expected: { common: f.common, project: f.repo, org: f.org,
    item: entry.item, run: entry.run, topic: 'topic', tip: entry.head, source: job.cleanup.source }, env: f.env }), [entry.key]);
  assert.deepEqual(outstandingEffects(f.org, fold(events(f)).runs.get(entry.run), f.common), []);
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state, 'complete');
  const completed = events(f); handoffCloseout({ cwd: f.repo, org: f.org, receipt, env: f.env });
  f.drain({ keys: [entry.key] }); assert.deepEqual(events(f), completed);
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
});

test('named drains and their stale-code successors isolate two eligible lanes, including an empty key set', t => {
  const f = setup(t, { occupied: false, terminal: true }), other = path.join(f.scratch, 'other-lane');
  f.git(['worktree', 'add', '-b', 'lane/other', other]);
  f.append([{ type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer' },
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace: other, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' }, sha256: 'fixture-two' },
    { type: 'item.closed', id: 'ENG-2', as: 'done' },
    { type: 'promotion.reconciled', identity: f.common, batch: 'other-landing', tip: f.head,
      heads: [{ run: 'R-2', item: 'ENG-2', head: f.head }], runs: ['R-2'], items: ['ENG-2'] }]);
  const entries = readCloseoutEntries(f.common), one = entries.find(e => e.run === 'R-1' && e.signal === 'landed');
  const otherEntries = entries.filter(e => e.run === 'R-2'), bytes = otherEntries.map(e =>
    fs.readFileSync(path.join(f.common, 'closeout/entries', `${e.key}.json`), 'utf8'));
  const before = events(f);
  assert.deepEqual(f.drain({ keys: [], onClaim: () => assert.fail('empty keys cannot claim or observe') }), { evaluated: [] });
  assert.deepEqual(events(f), before); assert.deepEqual(f.herdrCalls(), []);
  const stale = f.drain({ keys: [one.key], onClaim: () => f.git(['commit', '--allow-empty', '-qm', 'main epoch changed']) });
  assert.deepEqual(stale.evaluated, []); assert.deepEqual(stale.restart.keys, [one.key]);
  assert.deepEqual(events(f).findLast(e => e.type === 'closeout.code-handoff').keys, [one.key]);
  f.drain({ keys: stale.restart.keys });
  assert.equal(fs.existsSync(f.lane), false); assert.equal(fs.existsSync(other), true);
  assert.ok(otherEntries.every(e => !events(f).some(event => event.key === e.key)));
  assert.deepEqual(otherEntries.map(e => fs.readFileSync(path.join(f.common, 'closeout/entries', `${e.key}.json`), 'utf8')), bytes);
  f.drain(); assert.equal(fs.existsSync(other), false); assert.equal(f.git(['branch', '--list', 'lane/other']), '');
});

test('KEEP followed by a successful named closer retry clears the promotion result and ownership readers', t => {
  const f = setup(t, { occupied: false, terminal: true }), stop = hold(f), queue = queueFor(f.repo);
  const source = events(f).find(e => e.type === 'promotion.reconciled'), target = source.closeout_targets[0];
  f.drain({ keys: [target.key] });
  assert.match(evaluations(f).findLast(e => e.key === target.key).reason, /HOLD/);
  const row = { ...f.job, id: 'kept-completion', org: f.org, run: target.run, item: target.item, topic: 'topic',
    tip: target.head, outcome: 'promoted', delivered: true,
    reconciliation: { state: 'complete', fingerprint: source.fingerprint, receipt: f.receipts.get(source.batch) },
    cleanup: { state: 'pending', owner: 'closeout-queue', keys: [target.key],
      source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint } } };
  queue.transaction(data => data.results.push(row));
  const read = () => outstandingEffects(f.org, fold(events(f)).runs.get(target.run), f.common);
  assert.ok(read().includes('promotion:unreconciled/pending-callback'));
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state, 'pending');
  const receipt = fs.readFileSync(row.reconciliation.receipt), reconciled = events(f).filter(e => e.type === 'promotion.reconciled');
  stop(); retryCloseout({ cwd: f.repo, org: f.org, topic: target.key, why: 'hold removed', env: f.env, start: false });
  f.drain({ keys: [target.key] }); assertRemoved(f);
  assert.deepEqual(read(), [], 'the reader recognizes the durable exact outcome before bookkeeping catches up');
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state, 'complete');
  assert.deepEqual(events(f).filter(e => e.type === 'promotion.reconciled'), reconciled);
  assert.deepEqual(fs.readFileSync(row.reconciliation.receipt), receipt);
});

test('a production drain fast-forwarded during module loading hands only its named landing to one fresh successor', async t => {
  const f = setup(t, { occupied: false }); f.report(); const stop = hold(f);
  const code = path.join(f.scratch, 'loading-code'), marker = path.join(f.scratch, 'graph-loading'), release = path.join(f.scratch, 'graph-continue');
  f.git(['clone', '--quiet', '--shared', fileURLToPath(new URL('../', import.meta.url)), code]);
  f.git(['config', 'user.name', 'Loading fixture'], code); f.git(['config', 'user.email', 'loading@example.invalid'], code);
  const runtime = path.join(code, 'lib/closeout-executor.mjs'), original = fs.readFileSync(runtime, 'utf8');
  fs.appendFileSync(runtime, `
fs.writeFileSync(${JSON.stringify(marker)}, 'old modules loaded');
const loadingDeadline = Date.now() + 60000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() > loadingDeadline) throw Error('loading barrier expired');
  await new Promise(resolve => setTimeout(resolve, 10));
}
`);
  f.git(['commit', '-am', 'Pause during consumer loading'], code);
  const beforeCode = f.git(['rev-parse', 'HEAD'], code), branch = f.git(['symbolic-ref', '--short', 'HEAD'], code);
  f.git(['checkout', '-qb', 'new-loading-code'], code);
  fs.writeFileSync(runtime, original + '\n// newly landed removal implementation\n');
  f.git(['commit', '-am', 'Land fresh consumer bytes'], code); const freshCode = f.git(['rev-parse', 'HEAD'], code);
  f.git(['checkout', '-q', branch], code);
  const key = closeoutKey(f.lane, 'R-1', 'landed');
  const running = child(process.execPath, [path.join(code, 'supervisor/closeout.mjs'), 'drain', '--repo', f.repo,
    '--org', f.org, '--keys', JSON.stringify([key])], { cwd: f.repo, env: f.env });
  let reply;
  try {
    await waitForChange([marker], () => fs.existsSync(marker));
    f.git(['merge', '--ff-only', 'new-loading-code'], code); f.land();
  } finally { fs.writeFileSync(release, 'continue'); reply = await running; stop(); }
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const result = JSON.parse(reply.stdout.trim());
  assert.deepEqual(result.evaluated, []); assert.deepEqual(result.restart.keys, [key]);
  assert.equal(result.restart.old.code.commit, beforeCode); assert.equal(result.restart.current.code.commit, freshCode);
  assert.equal(result.successor.exit, 0); assert.equal(result.successor.root, code);
  const observed = evaluations(f); assert.equal(observed.length, 1); assert.equal(observed[0].key, key);
  assert.equal(observed[0].code.code.commit, freshCode); assert.equal(observed[0].code.epoch.tip, f.head);
  assert.match(observed[0].reason, /HOLD/);
  assert.equal(events(f).filter(e => e.type === 'closeout.code-handoff').length, 1);
  retryCloseout({ cwd: f.repo, org: f.org, topic: key, why: 'hold removed after fresh loading successor', env: f.env, start: false });
  f.drain({ keys: [key] }); assertRemoved(f);
});

for (const budgetMs of [50000, 180000, 240000]) test(`loaded removal reserves both Git steps inside a fixed ${budgetMs / 1000} s closeout pass`, t => {
  const f = setup(t, { occupied: false, terminal: true });
  let now = Date.now();
  const deadline = now + budgetMs, preparationMs = 30000, calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(os, 'loadavg', () => [16, 16, 16]);
  t.mock.method(os, 'availableParallelism', () => 4);
  const command = f.options.command, log = f.options.log;
  f.options.command = (exe, args, options) => {
    if (exe === 'git' && ((args[2] === 'worktree' && args[3] === 'remove') || (args[2] === 'branch' && args[3] === '-D')))
      calls.push({ action: args[2], timeout: options.timeout });
    return command(exe, args, options);
  };
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') now += preparationMs; };
  const result = f.drain({ retirementOptions: { ...f.options, deadline } });
  const availableMs = budgetMs - preparationMs;
  if (budgetMs === 50000) {
    assert.deepEqual(calls, [], 'insufficient base reserve starts neither Git effect');
    assert.ok(result.evaluated.some(e => !e.completed && /removal needs .*pass has/.test(e.reason)), JSON.stringify(result));
    assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.equal(effects(f).some(e => ['worktree-removed', 'branch-removed', 'lane-removed'].includes(e.action)), false);
  } else {
    assertRemoved(f);
    assert.deepEqual(calls.map(c => c.action), ['worktree', 'branch']);
    assert.ok(calls.every(c => c.timeout >= 30000), JSON.stringify(calls));
    const reservedMs = calls.reduce((sum, c) => sum + c.timeout, 0);
    assert.ok(reservedMs <= availableMs, JSON.stringify({ availableMs, calls }));
    if (budgetMs === 180000) assert.equal(reservedMs, availableMs, 'load headroom fits the original remaining deadline');
    else {
      assert.ok(calls[0].timeout >= 120000, 'a larger pass retains the full load-scaled worktree allowance');
      assert.equal(calls[1].timeout, 60000, 'the existing branch allowance cap stays intact');
    }
  }
  t.diagnostic(JSON.stringify({ budgetMs, preparationMs, calls }));
});
