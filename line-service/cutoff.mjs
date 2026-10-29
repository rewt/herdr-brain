// A recorded canonical-main boundary, never a timestamp or admission HEAD.
import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs,isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir,loadEvents,transact } from '../lib/store.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { bundleRelease } from '../lib/releases.mjs';
import {migratedCutover} from './runtime.mjs';

export const developmentRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const hash=v=>createHash('sha256').update(v).digest('hex');
const implementationHash=hash(fs.readFileSync(fileURLToPath(import.meta.url)));
const git=(repo,args)=>execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
export const lineDirectory=(org,identity)=>path.join(org,'line-service',hash(JSON.stringify(identity)).slice(0,20));
export function regularJSON(file) {
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)return null;
  if(!stat.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error(`redirected service receipt: ${file}`);
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
export function lineContext(repo,org) {
  const project=gitProject(repo);if(project.checkout!==project.canonical)throw Error('service context requires canonical project');
  const discovered=findOrgDir({cwd:repo,env:{...process.env,ORG_DIR:''}});
  if(!discovered||fs.realpathSync(discovered)!==fs.realpathSync(org))throw Error('service record differs from actual project');
  org=fs.realpathSync(org);return {...project,repo:project.canonical,org,directory:lineDirectory(org,project.identity)};
}
export function installedContext(repo,org) {
  const c=lineContext(repo,org),file=path.join(c.directory,'installation.json'),installation=regularJSON(file);
  if(!installation||installation.repo!==c.repo||installation.org!==c.org||fs.realpathSync(installation.source)!==developmentRoot||installation.file!==path.join(c.directory,'service.plist')||installation.node!==process.execPath||installation.target!==`gui/${process.getuid()}/dev.herdr.line.${path.basename(c.directory)}`)throw Error('service installation binding is UNKNOWN');
  if(installation.migration)serviceCutoff(loadEvents(c.org).events,{repo:c.repo,org:c.org,identity:c.identity});
  return {...c,installation,installationFile:file};
}
const reject=message=>{throw Object.assign(Error(message),{code:'REVIEW_CUTOFF'});};
export function serviceCutoff(events,{repo,org,identity}) {
  const found=events.filter(e=>e.type==='line-service.cutover'&&e.project===identity&&e.org===org);
  if(found.length!==1)reject('durable service cutover is missing/ambiguous; historical review remains held');
  const e=found[0];
  if(e.repo!==repo||!Number.isSafeInteger(e.seq)||e.seq<1||!e.id||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(e.canonical_head??'')||!e.main)reject('service cutover binding is UNKNOWN');
  const directory=lineDirectory(org,identity),installation=regularJSON(path.join(directory,'installation.json'));
  if(e.source!==developmentRoot||installation?.migration||events.some(row=>row.type==='line-service.runtime-upgraded'&&row.project===identity&&row.org===org)){
    if(!installation||installation.source!==developmentRoot||installation.repo!==repo||installation.org!==org)reject('service cutover binding is UNKNOWN');
    migratedCutover(events,{repo,org,identity,directory,installation,cutover:e});
  }
  return e;
}
export function postCutoffLanding({events,repo,org,identity,head}) {
  const cutoff=serviceCutoff(events,{repo,org,identity});
  // The cutover captured actual canonical main while holding lane-promote.lock.
  // Strict descent plus current canonical containment proves later landing,
  // without authoring a promotion, consulting mtime, or using admission HEAD.
  if(head===cutoff.canonical_head)reject('review target is at/before the recorded service landing cutoff');
  try{git(repo,['merge-base','--is-ancestor',cutoff.canonical_head,head]);}catch{reject('review target is historical/outside the recorded service landing cutoff');}
  const tip=git(repo,['rev-parse',`refs/heads/${cutoff.main}`]);
  try{git(repo,['merge-base','--is-ancestor',head,tip]);}catch{reject('review target has no actual post-cutoff canonical landing');}
  return {id:cutoff.id,seq:cutoff.seq,head:cutoff.canonical_head,main:cutoff.main};
}

export function establishCutover({repo,org,id,cutover=false,initialize=false,phase0Head,evidence,cwd=process.cwd(),env=process.env,call}={}) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9:-]{0,100}$/.test(id??''))throw Error('cutover needs a stable --id');
  if(Boolean(cutover)===Boolean(initialize))throw Error('choose explicit --cutover for an existing stopped job or --initialize for a new job');
  if(!env.HERDR_BRAIN_ROOT||fs.realpathSync(env.HERDR_BRAIN_ROOT)!==developmentRoot||bundleRelease().commit)throw Error('cutover requires actual matching development source');
  if(phase0Head&&(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(phase0Head)||!evidence))throw Error('intended Phase0 boundary needs immutable --phase0-head and producer --evidence');
  const eventType=phase0Head?'line-service.phase0':'line-service.cutover';
  const sourceHead=git(developmentRoot,['rev-parse','HEAD']);
  const c=lineContext(repo,org),bind=()=>{
    const b=nativeSender(c.org,{cwd,env,...(call?{call}:{})});
    if(b.project.checkout!==c.repo||b.project.identity!==c.identity)throw Error('cutover caller is not actual own canonical native context');return b;
  };
  bind();const saved=regularJSON(path.join(c.directory,'installation.json'));
  if(initialize&&(saved||fs.existsSync(path.join(c.directory,'service.plist')))||cutover&&!saved)throw Error('cutover mode differs from retained installation');
  if(saved)installedContext(c.repo,c.org);
  const stopped=path.join(c.directory,'STOP');
  const guard=()=>{
    if(saved&&!fs.existsSync(stopped))throw Error('explicit migration requires this service own STOP');
    if(fs.existsSync(path.join(c.repo,'.lane/supervisor/STOP'))||fs.existsSync(path.join(c.repo,'.lane/supervisor/HOLD')))throw Error('project STOP/HOLD prevents cutover');
    if(JSON.stringify(regularJSON(path.join(c.directory,'installation.json')))!==JSON.stringify(saved))throw Error('installation changed before cutover');
  };
  guard();fs.mkdirSync(c.directory,{recursive:true});
  const releasePass=noticeLock(path.join(c.directory,'pass.lock'));
  try{
    const releasePromotion=acquireLock(path.join(c.identity,'lane-promote.lock'));
    try{
      const main=loadDiscoveredRoutes({cwd:c.repo,env}).config.main??'main';
      if(git(c.repo,['symbolic-ref','--short','HEAD'])!==main)throw Error('cutover needs actual canonical main checkout');
      const head=git(c.repo,['rev-parse','HEAD']);
      const result=transact(c.org,events=>{
        const existing=events.filter(e=>e.type===eventType&&e.project===c.identity&&e.org===c.org);
        if(existing.length){if(existing.length!==1||existing[0].id!==id||(phase0Head&&existing[0].canonical_head!==phase0Head))throw Error('service cutover already exists; no implicit reset');return {add:[],result:existing[0]};}
        guard();const b=bind();if(git(c.repo,['rev-parse','HEAD'])!==head||git(developmentRoot,['rev-parse','HEAD'])!==sourceHead||hash(fs.readFileSync(fileURLToPath(import.meta.url)))!==implementationHash)throw Error('canonical main or actual implementation changed before cutover');
        if(phase0Head){git(c.repo,['merge-base','--is-ancestor',phase0Head,head]);if(!fs.lstatSync(evidence).isFile())throw Error('intended source-boundary evidence is not a regular file');}
        return {add:[{type:eventType,id,project:c.identity,repo:c.repo,org:c.org,source:developmentRoot,main,canonical_head:phase0Head??head,...(phase0Head?{evidence:path.resolve(evidence),time_qualification:'Intended pre-Phase0 source boundary, captured before Phase0 instruction edits; exact canonical main at18:55CDT and exact archive-creation minute UNKNOWN.',cutoff_at:null}:{}),
          mode:cutover?'explicit-stopped-migration':'new-install-boundary',source_head:sourceHead,native_caller:{name:b.native.name,pane:b.native.pane_id,terminal:b.native.terminal_id,session:b.native.agent_session.value},runtime_started:false}],result:null};
      },{actor:bind().native.name,strictTail:true,lockOptions:{recover:false}});
      const event=result.added[0]??result.result;
      return {recorded:true,existing:!result.added.length,[phase0Head?'phase0':'cutover']:event,runtime_started:false,stopped:fs.existsSync(stopped)};
    }finally{releasePromotion();}
  }finally{releasePass();}
}
if(isMain(import.meta.url))try{
  const {values}=parseArgs({options:{repo:{type:'string'},org:{type:'string'},id:{type:'string'},cutover:{type:'boolean'},initialize:{type:'boolean'},'phase0-head':{type:'string'},evidence:{type:'string'}}});
  if(!values.repo||!values.org)throw Error('cutoff.mjs --repo CANONICAL --org RECORD --id ID --cutover|--initialize');
  console.log(JSON.stringify(establishCutover({...values,phase0Head:values['phase0-head']})));
}catch(e){console.error(`line-service cutoff: ${e.message}`);process.exitCode=1;}
