// Finite line-owned launcher for the one project observer. No resident manager.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseArgs,isMain} from '../lib/cli-help.mjs';
import {writeFileAtomic} from '../lib/store.mjs';
import {ownerAlive,ownerIdentity} from '../lib/process-owner.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {installedContext} from '../line-service/cutoff.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {herdrSocketPath} from '../lanes/board/herdr-client.mjs';
import {readJson,observerDirectory,observerReceipt} from './shared.mjs';

const source=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
export async function ensureObserver({repo,org,project,env=process.env,retry=false,
  start=spawn,alive=ownerAlive,birth=ownerIdentity,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=5000,guard=()=>{}}) {
  const host=observerDirectory(org),file=path.join(host,'line-host.json');
  fs.mkdirSync(host,{recursive:true});
  const release=noticeLock(path.join(host,'line-host.lock'));
  const save=value=>writeFileAtomic(file,JSON.stringify(value)+'\n',0o600);
  const expected={repo,project,source,socket:herdrSocketPath(env)};
  let attempt=readJson(file);
  const hold=reason=>{
    attempt={...attempt,schema:'brain.line-observer/v1',id:attempt?.id??randomUUID(),state:'held',code:'SHARED_OBSERVER_HELD',
      repo,org,source,reason,evidence:file,owner:'project-supervisor',next_event:'supervisor inspects original receipt and explicitly retries watch/host.mjs'};
    save(attempt);return attempt;
  };
  try {
    guard();
    if(attempt?.state==='held'&&!retry)return attempt;
    const owner=readJson(path.join(host,'owner.json'));
    if(owner&&alive(owner)) {
      try { observerReceipt(org,expected,alive); }
      catch(error){return hold(error.message);}
      const ready={...attempt,state:'ready',host:owner};save(ready);return ready;
    }
    // An interrupted launch without a proven dead child stays UNKNOWN. A
    // definite refusal is sticky; only an explicit supervisor retry can clear it.
    if(attempt?.state==='starting'&&!retry)return hold('original observer start has no ready receipt; retain its uncertain outcome');
    if(attempt?.child&&alive(attempt.child))return hold('original observer child still owns startup; retain it');
    guard();
    const previous=attempt;
    attempt={schema:'brain.line-observer/v1',id:randomUUID(),repo,org,source,state:'starting',at:new Date().toISOString(),
      ...(previous?{previous}:{}),evidence:file,owner:'project-supervisor'};save(attempt);
    const fd=fs.openSync(path.join(host,'host.log'),'a',0o600);
    let child,startError;
    try {
      const childEnv={...env};
      for(const key of Object.keys(childEnv))if(/^(HERDR_(ENV|PANE_ID|TAB_ID|WORKSPACE_ID)|CODEX_(THREAD_ID|SESSION_ID)|GIT_.*|ORG_GUARD_OVERRIDE|LANE_CONFIG)$/.test(key))delete childEnv[key];
      child=start(process.execPath,[path.join(source,'watch/observer.mjs'),'--repo',repo,'--org',org],
        {cwd:repo,env:childEnv,detached:true,stdio:['ignore',fd,fd]});
      child.on('error',error=>{startError=error;});child.unref();
      if(child.pid){attempt.child={pid:child.pid,identity:birth(child.pid)};save(attempt);}
    } finally {fs.closeSync(fd);}
    const deadline=Date.now()+timeoutMs;
    do {
      await wait(50);guard();
      if(startError||child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)
        return hold(`observer refused: ${startError?.message??child.exitCode??child.signalCode}`);
      try {
        const owner=observerReceipt(org,expected,alive);
        if(owner.pid===child.pid&&owner.identity===attempt.child?.identity){attempt={...attempt,state:'ready',host:owner};save(attempt);return attempt;}
      } catch {/* startup is bounded; no dispatch until the exact receipt exists */}
    } while(Date.now()<deadline);
    return hold('observer readiness is uncertain; retain original child and inspect host.log');
  } catch(error) {return hold(error.message);}
  finally {release();}
}

export async function main(argv=process.argv.slice(2),{env=process.env,cwd=process.cwd(),call}={}) {
  const {values:v}=parseArgs({args:argv,usage:'host.mjs --repo CANONICAL --org RECORD [--retry]',options:{repo:{type:'string'},org:{type:'string'},retry:{type:'boolean'}}});
  const c=installedContext(v.repo,v.org);
  const guard=()=>{
    const current=installedContext(c.repo,c.org);
    if(current.installation.source!==source||!['installed'].includes(current.installation.phase))throw Error('observer requires this installed line build');
    if([path.join(c.directory,'STOP'),path.join(c.repo,'.lane/supervisor/STOP'),path.join(c.repo,'.lane/supervisor/HOLD'),
      path.join(c.org,'STOP'),path.join(observerDirectory(c.org),'STOP')].some(f=>fs.existsSync(f)))throw Error('STOP/HOLD prevents observer start');
  };
  if(v.retry){
    const binding=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    if(binding.project.checkout!==c.repo||binding.project.identity!==c.identity)throw Error('observer retry requires actual own canonical native supervisor');
  }
  return ensureObserver({repo:c.repo,org:c.org,project:c.identity,env,retry:v.retry,guard});
}
if(isMain(import.meta.url))try{process.stdout.write(JSON.stringify(await main())+'\n');}
catch(error){process.stderr.write(`observer host: ${error.message}\n`);process.exitCode=1;}
