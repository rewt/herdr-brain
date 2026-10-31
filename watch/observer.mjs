#!/usr/bin/env node
// One project observer. All mutations remain finite original watcher consumers;
// neither event payloads nor this rebuildable cache authorize an effect.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HerdrClient,herdrSocketPath} from '../lanes/board/herdr-client.mjs';
import {openRecordReader} from '../lib/record-reader.mjs';
import {gitProject} from '../lib/project.mjs';
import {bundleRelease} from '../lib/releases.mjs';
import {writeFileAtomic,findOrgDir} from '../lib/store.mjs';
import {ownerAlive,ownerIdentity} from '../lib/process-owner.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {parseArgs,isMain} from '../lib/cli-help.mjs';
import {sharedDirectory,observerDirectory,stepFile,readJson,stamp,digest,nativeBinding,sameNative} from './shared.mjs';

export const SAFETY_RECONCILIATION_MS=30_000;
const lifecycle=['pane.closed','pane.exited','pane.agent_detected','pane.moved'];
const source=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');

export function createObserver({repo,org,socket=herdrSocketPath(),client=new HerdrClient({socketPath:socket}),
  now=Date.now,consume,subjects,log=()=>{},alive=ownerAlive,safetyMs=SAFETY_RECONCILIATION_MS,maxConsumers=2}={}) {
  const project=gitProject(repo);
  repo=project.canonical;org=fs.realpathSync(org);
  if(!Number.isSafeInteger(safetyMs)||safetyMs<1||!Number.isSafeInteger(maxConsumers)||maxConsumers<1)throw Error('invalid observer bounds');
  const directory=observerDirectory(org),registrations=sharedDirectory(org);
  fs.mkdirSync(registrations,{recursive:true});fs.mkdirSync(directory,{recursive:true});
  const heldDirectory=path.join(directory,'held');fs.mkdirSync(heldDirectory,{recursive:true});
  const cache=new Map(),active=new Map(),queue=new Map(),faults=new Map();
  let stopped=false,ready=false,subscription='',revision=0,scan,again=false,lastSafety=now(),fileWatch;
  const counters={reconciliations:0,safety_reconciliations:0,repairs:0,consumer_starts:0,consumer_failures:0};
  const stoppedByProject=()=>[path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD'),
    path.join(org,'STOP'),path.join(directory,'STOP')].some(f=>fs.existsSync(f));
  const emit=(action,detail={})=>log({schema:'brain.run-observer/v1',at:new Date(now()).toISOString(),action,project:project.identity,org,...detail});
  const readSubjects=subjects??(duties=>{
    const reader=openRecordReader(path.join(org,'events.jsonl'));
    try {
      if(reader.tornTail)throw Error('incomplete record prevents observation');
      const result=new Map(duties.map(d=>{
        const r=reader.state.runs.get(d.run);
        return [d.run,r?{generation:r.owner_generation,owner:r.owner,abandoned:r.abandoned,report:r.report}:null];
      }));return result;
    }finally{reader.close();}
  });
  const runConsumer=consume??(d=>new Promise((resolve,reject)=>{
    const env={...process.env,ORG_ACTOR:'run-observer',SUPERVISOR_INPUT_WAIT_SECONDS:'0',HERDR_SOCKET_PATH:socket};
    for(const k of Object.keys(env))if(/^(HERDR_(ENV|PANE_ID|TAB_ID|WORKSPACE_ID)|CODEX_(THREAD_ID|SESSION_ID)|GIT_.*|ORG_GUARD_OVERRIDE)$/.test(k))delete env[k];
    const fd=fs.openSync(path.join(directory,`${d.run}.log`),'a',0o600);
    let child;
    try{child=spawn(process.execPath,[path.join(d.source,'watch/watch.mjs'),...d.argv,'--step'],{cwd:repo,env,stdio:['ignore',fd,fd]});}
    finally{fs.closeSync(fd);}
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  }));
  function pump(){
    if(stopped||stoppedByProject())return;
    for(const [id,entry] of queue){
      if(active.size>=maxConsumers)break;
      queue.delete(id);if(active.has(id))continue;
      const started=now();counters.consumer_starts++;
      emit('consumer-start',{run:id,consumer:entry.d.consumer,stuck_owner:entry.d.stuck_owner,
        observed_at:entry.observed_at,queue_ms:Math.max(0,started-entry.observed_at)});
      const task=Promise.resolve().then(()=>runConsumer(entry.d)).then(result=>{
        const saved=readJson(stepFile(org,id));
        if(result.code===0&&(!saved||!['waiting','held','complete'].includes(saved.phase)))throw Error('finite watcher returned without a durable outcome; retain original');
        if(result.code!==0)throw Error(`original watcher exit ${result.code}; signal ${result.signal??'none'}`);
        emit('consumer-finished',{run:id,duration_ms:Math.max(0,now()-started),result});
      }).catch(error=>{
        counters.consumer_failures++;faults.set(id,error.message);
        writeFileAtomic(path.join(heldDirectory,`${id}.json`),JSON.stringify({run:id,ownership:entry.d.ownership,registration:digest(entry.d),
          consumer:entry.d.consumer,wake_fact:entry.d.wake_fact,stuck_owner:entry.d.stuck_owner,reason:error.message,at:new Date(now()).toISOString()})+'\n');
        emit('consumer-held',{run:id,reason:error.message,stuck_owner:entry.d.stuck_owner});
      }).finally(()=>{active.delete(id);pump();wake('consumer');});
      active.set(id,task);
    }
  }
  async function reconcile(reason='hint'){
    if(stopped||stoppedByProject())return {held:true};
    if(scan){again=true;return scan;}
    scan=(async()=>{
      counters.reconciliations++;if(reason==='safety'){counters.safety_reconciliations++;lastSafety=now();}
      const before=revision,server=stamp(socket);
      const duties=fs.readdirSync(registrations).filter(f=>/^R-\d+\.json$/.test(f)).filter(f=>!['complete','failed'].includes(readJson(stepFile(org,f.slice(0,-5)))?.phase)).map(f=>readJson(path.join(registrations,f)));
      for(const d of duties)if(d?.schema!=='brain.shared-watch/v1'||d.org!==org||d.repo!==repo||d.project!==project.identity||d.source!==source||
        d.consumer!=='watch/watch.mjs --step'||!Array.isArray(d.argv)||!d.stuck_owner)throw Error('foreign/malformed original observation registration; retain it');
      let snapshot,unavailable;
      try{snapshot=await client.snapshot();if(stamp(socket)!==server)throw Error('server socket changed during snapshot');
        if(!Array.isArray(snapshot.agents)||!Array.isArray(snapshot.panes)||snapshot.protocol<22)throw Error('incomplete/unsupported native snapshot');
      }catch(error){unavailable=error.message;emit('native-unavailable',{reason:unavailable});}
      // Subscribe before refreshing after acknowledgement. A rejected pane
      // rejects the whole set; only a new acknowledged set can mark it ready.
      if(snapshot){
        const panes=new Set(snapshot.panes.map(p=>p.pane_id));
        const next=[...lifecycle.map(type=>({type})),...duties.filter(d=>panes.has(d.native?.pane)).map(d=>({type:'pane.agent_status_changed',pane_id:d.native.pane}))];
        const key=digest({server,next});if(key!==subscription){ready=false;subscription=key;client.subscribe(next);}
      }
      const records=readSubjects(duties);
      const ids=new Set(duties.map(d=>d.run));for(const id of cache.keys())if(!ids.has(id))cache.delete(id);
      for(const d of duties){
        const held=readJson(path.join(heldDirectory,`${d.run}.json`));
        if(held){if(held.registration!==digest(d))throw Error('held observation registration changed');faults.set(d.run,held.reason);}
        const step=readJson(stepFile(org,d.run));
        if(step&&digest(step.ownership)!==digest(d.ownership))throw Error('watcher step ownership changed; retain it');
        if(['complete','failed'].includes(step?.phase)||faults.has(d.run))continue;
        const native=snapshot?.agents.find(a=>a.name===d.native.agent||a.pane_id===d.native.pane);
        const bound=sameNative(d.native,native),record=records.get(d.run);
        const observation={server,protocol:snapshot?.protocol,version:snapshot?.version,unavailable,
          native:nativeBinding(native),bound,state:native?.agent_status,
          state_change_seq:bound?native.state_change_seq:null,completion_seq:bound?native.completion_seq:null,
          report:stamp(d.report),record};
        const fingerprint=digest(observation),prior=cache.get(d.run),changed=prior?.fingerprint!==fingerprint;
        if(changed){
          if(reason==='safety'&&prior){counters.repairs++;emit('safety-repair',{run:d.run,previous:prior.observation,current:observation});}
          emit('observation',{run:d.run,claim:d.ownership.generation,...observation});
          cache.set(d.run,{fingerprint,observation});
        }
        const due=step?.next_at!==null&&step?.next_at!==undefined&&step.next_at<=now();
        // An original finite consumer surviving a host restart still owns its
        // run. Unknown birth/liveness throws; it never permits a replacement.
        if(active.has(d.run)||step?.phase==='running'&&alive(step))continue;
        if(changed||due||!step)queue.set(d.run,{d,observed_at:now()});
      }
      emit('reconciled',{reason,ready,server,rss:process.memoryUsage().rss,high_water_rss_bytes:process.resourceUsage().maxRSS*1024,active:active.size,queued:queue.size,counters:{...counters}});
      if(before!==revision)again=true;
      pump();return {ready,counters:{...counters}};
    })();
    try{return await scan;}finally{scan=null;if(again&&!stopped){again=false;wake('during-refresh');}}
  }
  function wake(reason){
    revision++;
    if(stopped)return;
    if(scan){again=true;return;}
    if(wake.pending)return;
    wake.pending=true;queueMicrotask(()=>{wake.pending=false;reconcile(reason).catch(error=>emit('observation-held',{reason:error.message}));});
  }
  const handlers={ready:()=>{ready=true;wake('subscription-ready');},disconnected:()=>{ready=false;wake('reconnect');},
    connectionError:error=>{ready=false;emit('subscription-error',{reason:error.message});},
    event:event=>{if(event.event==='events_lost'){ready=false;subscription='';}wake('native-hint');}};
  for(const [event,handler]of Object.entries(handlers))client.on(event,handler);
  function start(){
    // Filesystem attachment precedes initial catch-up. Lost/error hints are
    // repaired by exactly one named timer; there is no per-run wait process.
    try{fileWatch=fs.watch(org,{recursive:true},(_kind,file)=>{
      const name=String(file??'');if(!file||name==='events.jsonl'||/^runs[\/\\].*report\.md$/.test(name)||/^watch[\/\\]shared[\/\\]/.test(name))wake('file-hint');
    });fileWatch.on('error',error=>{fileWatch.close();emit('file-hints-unavailable',{reason:error.message});});}
    catch(error){emit('file-hints-unavailable',{reason:error.message});}
    client.subscribe(lifecycle.map(type=>({type})));subscription='initial';
    return reconcile('startup');
  }
  async function tick(){return reconcile(now()-lastSafety>=safetyMs?'safety':'deadline');}
  function nextDelay(){
    const deadlines=[lastSafety+safetyMs,...[...cache.keys()].filter(id=>!active.has(id)&&!queue.has(id)&&!faults.has(id)).map(id=>{const s=readJson(stepFile(org,id));return s?.phase==='waiting'?s.next_at:null;}).filter(n=>typeof n==='number')];
    return Math.max(10,Math.min(...deadlines)-now());
  }
  async function close(){stopped=true;queue.clear();fileWatch?.close();for(const [event,handler]of Object.entries(handlers))client.off(event,handler);client.close();await scan;await Promise.all(active.values());}
  return {start,reconcile,tick,nextDelay,close,counters,directory,stoppedByProject,idle:async()=>{do{await scan;await Promise.all([...active.values()]);await new Promise(resolve=>setImmediate(resolve));}while(scan||active.size||queue.size||wake.pending);}};
}

export async function main(argv=process.argv.slice(2)){
  const {values:v}=parseArgs({args:argv,usage:'observer.mjs --repo CANONICAL --org RECORD [--once | --status]',options:{repo:{type:'string'},org:{type:'string'},once:{type:'boolean'},status:{type:'boolean'}}});
  if(!v.repo)throw Error('--repo CANONICAL required');
  const project=gitProject(v.repo),repo=project.canonical;
  if(project.checkout!==repo)throw Error('observer requires canonical project checkout');
  const org=fs.realpathSync(v.org??findOrgDir({cwd:repo})),directory=observerDirectory(org),file=path.join(directory,'owner.json');
  if(v.status){const owner=readJson(file);return {owner,alive:owner?ownerAlive(owner):false};}
  if(process.version!=='v20.19.4')throw Error('use pinned Node 20.19.4');
  fs.mkdirSync(directory,{recursive:true});const release=noticeLock(path.join(directory,'host.lock'));
  const log=path.join(directory,'observations.jsonl'),emit=row=>fs.appendFileSync(log,JSON.stringify(row)+'\n',{mode:0o600});
  let observer,stopping=false;
  const stop=()=>{stopping=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    observer=createObserver({repo,org,log:emit});
    if(observer.stoppedByProject())throw Error('STOP/HOLD prevents observer start');
    writeFileAtomic(file,JSON.stringify({schema:'brain.run-observer-owner/v1',org,repo,project:project.identity,source,socket:herdrSocketPath(),
      release:bundleRelease(),pid:process.pid,identity:ownerIdentity(process.pid),log,at:new Date().toISOString()})+'\n');
    await observer.start();
    while(!v.once&&!stopping&&!observer.stoppedByProject()){
      await new Promise(resolve=>{const timer=setTimeout(done,Math.min(1000,observer.nextDelay()));function done(){clearTimeout(timer);resolve();}});
      if(observer.nextDelay()<=10)await observer.tick();
    }
    if(v.once)await observer.idle();
    return {counters:observer.counters,directory};
  }finally{await observer?.close();release();process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
if(isMain(import.meta.url))try{process.stdout.write(JSON.stringify(await main())+'\n');}catch(error){process.stderr.write(`observer: ${error.message}\n`);process.exitCode=1;}
