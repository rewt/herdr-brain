#!/usr/bin/env node
// The consumer rollback round trip under the real launchd of this login session,
// on scratch consumers only. Launchctl, the job's environment and its line passes
// are real. Herdr is a recording stand-in, so no job can reach a real pane.
// No BCH path, real record or real pin is read or written.
//
// A job resolves its release home from the account (never HOME), so it can only
// admit an offered release that really is offered. Two modes follow from that:
//   scratch  sealed copies whose only payload change is the release home, with a
//            fixture offer in a scratch home. Proves launchd behavior, not the bytes.
//   --exact  the named installed roots, unchanged. Needs both READY in the real
//            home, so it is the release coordinator's run once a candidate has its
//            offer record. It writes nothing there. A candidate not yet READY exits
//            3 as UNRUN, after observing only the old release's own leg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseArgs,isMain} from '../lib/cli-help.mjs';
import {initOrg,transact} from '../lib/store.mjs';
import {copyProduct} from '../lib/product-files.mjs';
import {checkRelease,releaseAcceptance,releaseHome} from '../lib/releases.mjs';
import {gitProject} from '../lib/project.mjs';
import {ROUTE_PRESET} from '../lanes/preset.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {PASS_JOURNAL_LIMIT} from '../line-service/pass-journal.mjs';

export const SCHEMA='brain.rollback-launchd/v1';
const HOME_LINE="export const releaseHome = () => path.join(os.userInfo().homedir, '.local/share/herdr-monitor');";
const RELEASES='lib/releases.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>fs.readFileSync(file,'utf8');
const PASS_MS=180000;

// What launchd itself reports, kept apart from what the tools claim.
export function launchdView(text){
  const field=name=>new RegExp(`^\\s*${name} = (.+)$`,'m').exec(text)?.[1]??null;
  return {state:field('state'),program:field('program'),runs:Number(field('runs')??NaN),last_exit:field('last exit code'),
    arguments:/arguments = \{\n([\s\S]*?)\n\s*\}/.exec(text)?.[1].split('\n').map(line=>line.trim())??[],
    spawn_type:field('spawn type'),nice:field('nice')};
}

// A release is usable here only if the real home itself admits it unchanged.
export function exactPrerequisite(root,home=releaseHome()){
  const id=path.basename(root);
  try{
    if(root!==path.join(fs.realpathSync(path.join(home,'releases')),id))return {ready:false,root,reason:'not an installed root of the real home'};
    const acceptance=releaseAcceptance(checkRelease(home,id,{verifyFiles:true}),home);
    return acceptance.ready?{ready:true,root}:{ready:false,root,reason:acceptance.reason};
  }catch(error){return {ready:false,root,reason:error.message};}
}

// Copy an installed root, change only its release home and reseal with its own tool.
// Its validation proof binds the unchanged payload, so a copy correctly cannot carry it.
export function sealedCopy(source,home,id){
  const root=path.join(home,'releases',id);
  copyProduct(source,root);
  fs.copyFileSync(path.join(source,'.release-commit'),path.join(root,'.release-commit'));
  const file=path.join(root,RELEASES),before=read(file);
  if(before.split(HOME_LINE).length!==2)throw Error(`${id}: release home line not found once in ${RELEASES}`);
  fs.chmodSync(file,0o644);fs.writeFileSync(file,before.replace(HOME_LINE,()=>`export const releaseHome = () => ${JSON.stringify(home)};`));
  const summary=path.join(source,'.release-acceptance.json'),args=[path.join(root,'herdr/releases.mjs'),'manifest',root,...(fs.existsSync(summary)?[summary]:[])];
  const sealed=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
  if(sealed.status!==0)throw Error(`${id}: reseal failed: ${sealed.stderr||sealed.stdout}`);
  const manifestFile=path.join(root,'.release-manifest.json'),manifest=JSON.parse(read(manifestFile)),original=JSON.parse(read(path.join(source,'.release-manifest.json')));
  if(original.release)fs.writeFileSync(manifestFile,JSON.stringify({...manifest,release:original.release},null,2)+'\n');
  const changed=payloadDifference(source,root).filter(file=>![RELEASES,'.release-validation.json'].includes(file));
  if(changed.length)throw Error(`${id}: copy differs beyond the release home: ${changed.join(', ')}`);
  return root;
}

export function payloadDifference(source,copy){
  const files=root=>JSON.parse(read(path.join(root,'.release-manifest.json'))).files;
  const a=files(source),b=files(copy);
  return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(file=>a[file]!==b[file]).sort();
}

// Labelled in place: this admits a scratch copy in a scratch home and proves no canary.
function fixtureOffer(home,root,id){
  const manifestFile=path.join(root,'.release-manifest.json'),commit=read(path.join(root,'.release-commit')).trim();
  const evidence=[{file:manifestFile,sha256:'a'.repeat(64)}],scope='Scratch rollback witness fixture; nothing ran and nothing is offered';
  const unsigned={schema:'consumer-release-offer/v1',commit,manifestSha256:sha(fs.readFileSync(manifestFile)),coordinatorItem:'SCRATCH',
    canary:{status:'PASS',scope,evidence:['installed','probation','soak'].map(stage=>({stage,...evidence[0]}))},
    landing:{status:'PASS',scope,evidence},majors:{scope,unresolved:[],corrections:[]}};
  const attestationDigest=sha(JSON.stringify(unsigned)),packet={...unsigned,attestationDigest,attestationSeq:1},bytes=Buffer.from(JSON.stringify(packet));
  fs.mkdirSync(path.join(home,'offers'),{recursive:true});
  fs.writeFileSync(path.join(home,'offers',id+'.json'),JSON.stringify({schema:'consumer-release-offer-record/v1',release:id,commit,manifestSha256:unsigned.manifestSha256,
    packetSha256:sha(bytes),packetBase64:bytes.toString('base64'),packet,fullSuite:{status:'UNRUN',details:'No full-suite run supplied; background information only.'},coordinator:'scratch-witness',
    disposition:{seq:1,type:'note.added',decision:true,by:'scratch-witness',id:'SCRATCH',text:`Consumer release offer reconciled: ${attestationDigest}`}}));
}

function standIn(bin,checkout){
  fs.mkdirSync(bin,{recursive:true});
  const file=path.join(bin,'herdr'),agent={name:'scratch-supervisor',pane_id:'scratch-pane',workspace_id:'scratch-workspace',tab_id:'scratch-tab',terminal_id:'scratch-terminal',
    cwd:checkout,agent:'claude',agent_status:'idle',agent_session:{kind:'id',value:'scratch-session'}};
  fs.writeFileSync(file,`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(bin,'calls.jsonl'))},JSON.stringify(args)+'\\n');
console.log(JSON.stringify(args[0]==='agent'&&args[1]==='get'?{result:{agent:${JSON.stringify(agent)}}}:{result:{agents:[],workspaces:[],tabs:[],panes:[]}}));
`,{mode:0o755});
  return file;
}

// One scratch consumer, installed and migrated the way the old release's own tool does it.
async function consumer(scratch,name,{oldRoot,log}){
  const owner=path.join(scratch,name),repo=path.join(owner,'project'),org=path.join(repo,'.org'),bin=path.join(owner,'bin');
  fs.mkdirSync(repo,{recursive:true});
  fs.writeFileSync(path.join(owner,'.identity-root'),'scratch\n');
  fs.writeFileSync(path.join(owner,'.lane.json'),JSON.stringify({...ROUTE_PRESET,worktree_root:'parent-lanes'}));
  const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')&&!key.startsWith('HERDR_')&&key!=='ORG_DIR'&&key!=='ORG_ACTOR'&&key!=='CODEX_THREAD_ID'));
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{env:clean,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-qb','main');git('config','user.name','Scratch');git('config','user.email','scratch@example.invalid');
  fs.appendFileSync(path.join(repo,'.git/info/exclude'),'.org/\n.lane/\n');
  fs.writeFileSync(path.join(repo,'.lane.json'),'{\n  "archive": {"dirs": ["archive"]}, "main": "main", "dispatch": {"max_sessions": 4, "max_unlanded": 8}\n}\n');
  fs.writeFileSync(path.join(repo,'.lane.validation.json'),'{"fast":"node --version","promotion":"node --version","environment":"scratch"}\n');
  fs.writeFileSync(path.join(repo,'.promote.json'),'{"max_batch":3}\n');
  fs.writeFileSync(path.join(repo,'.housekeeping.json'),'{"enabled":false}\n');
  const pin=release=>{fs.writeFileSync(path.join(repo,'.herdr-release.json'),JSON.stringify({release})+'\n');git('add','.');git('commit','-qm','Select '+release);};
  pin(path.basename(oldRoot));
  initOrg(org);
  const identity=gitProject(repo).identity,directory=lineDirectory(org,identity);
  fs.mkdirSync(directory,{recursive:true});
  const label=`dev.herdr.line.${path.basename(directory)}`,target=`gui/${process.getuid()}/${label}`,file=path.join(directory,'service.plist');
  const installationFile=path.join(directory,'installation.json'),source=path.join(owner,'retained-development-source'),herdr=standIn(bin,repo),socket=path.join(bin,'native.sock');
  const {launchPlist}=await import(pathToFileURL(path.join(oldRoot,'line-service/launchd.mjs')).href);
  fs.writeFileSync(installationFile,JSON.stringify({at:new Date().toISOString(),target,repo,org,source:source+path.sep,node:process.execPath,file,phase:'installed'})+'\n');
  fs.writeFileSync(file,launchPlist({label,repo,org,to:'scratch-supervisor',herdr,socket,directory,node:process.execPath,source,interval:3600,searchPath:'/usr/bin:/bin'}));
  fs.writeFileSync(path.join(directory,'STOP'),'Scratch consumer starts stopped\n');
  const boundary={id:'scratch-cutover',project:identity,repo,org,source,main:'main',canonical_head:git('rev-parse','HEAD')};
  const add=rows=>transact(org,()=>({add:rows}),{actor:'scratch-witness'});
  add(['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type})));
  const env={...clean,PATH:`${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,HERDR_ENV:'1',HERDR_PANE_ID:'scratch-pane',HERDR_WORKSPACE_ID:'scratch-workspace',HERDR_SOCKET_PATH:socket};
  const c={name,owner,repo,org,bin,directory,target,file,installationFile,env,pin,add,log,
    tool:(root,args,expect)=>step(c,root,args,expect),
    print:()=>spawnSync('/bin/launchctl',['print',target],{encoding:'utf8',maxBuffer:4*1024*1024})};
  return c;
}

function step(c,root,args,expect){
  const started=Date.now(),result=spawnSync(process.execPath,[path.join(root,'line-service/launchd.mjs'),...args,'--repo',c.repo,'--org',c.org],{cwd:c.repo,env:c.env,encoding:'utf8',maxBuffer:8*1024*1024});
  const row={consumer:c.name,tool:path.basename(root),args,exit:result.status,ms:Date.now()-started,stdout:result.stdout,stderr:result.stderr};
  c.log(row);
  if(expect){
    if(result.status===0)throw Error(`${args.join(' ')}: expected refusal ${expect}, but it succeeded`);
    if(!expect.test(result.stderr+result.stdout))throw Error(`${args.join(' ')}: refused differently: ${result.stderr||result.stdout}`);
    return {refused:(result.stderr||result.stdout).trim().split('\n').at(-1)};
  }
  if(result.status!==0)throw Error(`${args.join(' ')}: ${result.stderr||result.stdout}`);
  return result.stdout.trim()?JSON.parse(result.stdout):{};
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,what,ms=PASS_MS){
  const deadline=Date.now()+ms;
  for(;;){
    const value=check();if(value)return value;
    if(Date.now()>deadline)throw Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}
const logFile=c=>path.join(c.directory,'launchd.log');
const logBytes=c=>fs.existsSync(logFile(c))?fs.statSync(logFile(c)).size:0;
// Only a line the job itself wrote since this start counts as its pass.
const passSince=(c,offset)=>{
  if(logBytes(c)<=offset)return null;
  const rows=fs.readFileSync(logFile(c)).subarray(offset).toString().split('\n').filter(Boolean);
  return rows.map(row=>{try{return JSON.parse(row);}catch{return null;}}).find(row=>row?.result==='pass-complete')??null;
};
const finiteActive=c=>['pass.lock','closeout-turn.lock'].some(name=>fs.existsSync(path.join(c.directory,name)));

// Real bootstrap, the job's own pass, a refused control while loaded, real bootout.
async function runLeg(c,root,{whileLoaded,process_type}){
  const offset=logBytes(c),restarted=c.tool(root,['restart']);
  if(!restarted.restarted)throw Error('restart did not report a start');
  const pass=await until(()=>passSince(c,offset),`${path.basename(root)} line pass under launchd`);
  await until(()=>!finiteActive(c),'finite pass and closeout locks to clear');
  const printed=c.print();
  if(printed.status!==0)throw Error(`job left launchd before stop: ${printed.stderr}`);
  const view=launchdView(printed.stdout);
  c.log({consumer:c.name,launchctl_print:view,raw_print:printed.stdout});
  if(!view.arguments.includes(path.join(root,'line-service/line-service.mjs')))throw Error(`launchd is not running ${root}: ${view.arguments.join(' ')}`);
  if(view.last_exit!=='0')throw Error(`job last exit code ${view.last_exit}: ${tail(path.join(c.directory,'launchd.error.log'))}`);
  const plist=read(c.file);
  if(plist.includes('<key>ProcessType</key><string>Interactive</string>')!==process_type)throw Error('job class differs from the release that wrote its plist');
  if(!(process_type?/interactive/:/daemon/).test(view.spawn_type??''))throw Error(`launchd spawn type ${view.spawn_type} differs from the job's plist`);
  const loadedRefusal=whileLoaded?.()??null;
  c.tool(root,['stop']);
  const after=c.print();
  if(after.status===0||!/could not find service/i.test(after.stderr+after.stdout))throw Error(`bootout left ${c.target} loaded: ${after.stdout}${after.stderr}`);
  return {root,runs:view.runs,last_exit:view.last_exit,spawn_type:view.spawn_type,nice:view.nice,pass_result:pass.result,process_type,
    ...(loadedRefusal?{loaded_refusal:loadedRefusal}:{})};
}
const tail=file=>fs.existsSync(file)?read(file).slice(-600):'';
const plan=(c,root,args)=>c.tool(root,[...args,'--dry-run']);
const apply=(c,root,args)=>{const planned=plan(c,root,args);return {planned,result:c.tool(root,[...args,'--expected-plan',planned.archive.sha256])};};
const receipts=c=>({installation:read(c.installationFile),plist:read(c.file)});
const same=(a,b)=>a.installation===b.installation&&a.plist===b.plist;

async function migrated(scratch,name,context){
  const {oldRoot}=context,c=await consumer(scratch,name,context),args=['migrate','--id','scratch-move'];
  apply(c,oldRoot,args);
  c.add([{type:'item.added',id:'ENG-1',title:'Pinned consumer work',role:'engineer'},{type:'item.closed',id:'ENG-1',as:'done'},
    {type:'report.ingested',run:'R-1',report:{outcome:'done'}},{type:'change.landed',run:'R-1'}]);
  return c;
}
function routes(c,oldRoot,candidateRoot){
  return {forward:['upgrade','--id','offer-adoption','--from-root',oldRoot,'--target-root',candidateRoot],
    back:['upgrade','--id','offer-rollback','--from-root',candidateRoot,'--target-root',oldRoot,'--rollback'],
    again:['upgrade','--id','offer-return','--from-root',oldRoot,'--target-root',candidateRoot]};
}

// Success: old release runs, adopts the offered one, runs, returns, runs again, and
// adopts it once more. The journal is over the rotation limit from the first adoption,
// as on a long-running consumer, so the job's own first write rotates it.
async function roundTrip(scratch,context){
  const {oldRoot,candidateRoot}=context,c=await migrated(scratch,'round-trip',context),legs={},{forward,back,again}=routes(c,oldRoot,candidateRoot);
  const consumerName=c.name;context.consumers.push(c);
  const before=receipts(c);
  legs.old_before=await runLeg(c,oldRoot,{process_type:false});
  const journal=path.join(c.directory,'passes.jsonl');
  fs.appendFileSync(journal,JSON.stringify({action:'scratch-history',pad:'x'.repeat(PASS_JOURNAL_LIMIT)})+'\n');
  const journalBytes=fs.statSync(journal).size;
  const oldToolRefusal=c.tool(oldRoot,[...forward,'--dry-run'],/incomplete release|acceptance-not-ready/).refused;
  c.pin(path.basename(candidateRoot));
  const preview=plan(c,candidateRoot,forward).rollback;
  if(preview?.admitted!==true||preview.tool!==candidateRoot||preview.target!==oldRoot)throw Error(`forward preview does not admit the way back: ${JSON.stringify(preview)}`);
  apply(c,candidateRoot,forward);
  // STOP alone is not enough: only launchd's own answer shows the job is gone.
  legs.offered=await runLeg(c,candidateRoot,{process_type:true,whileLoaded:()=>{
    fs.writeFileSync(path.join(c.directory,'STOP'),'Scratch STOP while still loaded\n');
    c.pin(path.basename(oldRoot));
    return c.tool(candidateRoot,[...back,'--dry-run'],/remains loaded/).refused;
  }});
  const segments=()=>JSON.parse(read(journal+'.segments/index.json')).segments;
  if(!fs.existsSync(journal+'.segments/index.json')||!segments().length||fs.statSync(journal).size>=PASS_JOURNAL_LIMIT)throw Error('the adopted job did not rotate a journal over the limit');
  const rollback=apply(c,candidateRoot,back);
  if(rollback.result.direction!=='rollback')throw Error('rollback did not report its direction');
  const restored=same(receipts(c),before);
  if(!restored)throw Error('rollback did not restore the exact installation and plist bytes');
  legs.old_after=await runLeg(c,oldRoot,{process_type:false});
  if(rollback.planned.journal_offset?.basis!=='live-file')throw Error('rollback plan carries no conversion of the rotated journal');
  c.pin(path.basename(candidateRoot));
  const returned=apply(c,candidateRoot,again);
  if(returned.planned.journal_offset?.basis!=='whole-journal')throw Error('return plan carries no conversion of the rotated journal');
  legs.returned=await runLeg(c,candidateRoot,{process_type:true});
  return {consumer:consumerName,status:'PASS',old_tool_refusal:oldToolRefusal,preview,unread:rollback.planned.unread,restored_exact_bytes:restored,
    journal:{bytes_before_adoption:journalBytes,segments:segments().length,rollback:rollback.planned.journal_offset,return:returned.planned.journal_offset},legs};
}

// Failure: events the old release never met refuse, leaving everything in place.
// Recovery: the adopted release still starts, then the owner's bound acceptance returns.
async function refusalAndRecovery(scratch,context){
  const {oldRoot,candidateRoot}=context,c=await migrated(scratch,'recovery',context),legs={},{forward,back}=routes(c,oldRoot,candidateRoot);
  context.consumers.push(c);
  const before=receipts(c);
  c.pin(path.basename(candidateRoot));apply(c,candidateRoot,forward);
  const adopted=receipts(c);
  c.pin(path.basename(oldRoot));
  c.add([{type:'review.finding-linked',item:'ENG-1',run:'R-2'},{type:'closeout.effect',run:'R-2',outcome:{action:'agent-exit-requested'}}]);
  const refusal=c.tool(candidateRoot,[...back,'--dry-run'],/record-incompatible/).refused;
  if(!same(receipts(c),adopted)||c.print().status===0)throw Error('the refused rollback changed the adopted service');
  if(fs.existsSync(path.join(c.directory,'upgrades/offer-rollback.json')))throw Error('the refused rollback left an archive');
  c.pin(path.basename(candidateRoot));
  legs.adopted_after_refusal=await runLeg(c,candidateRoot,{process_type:true});
  c.pin(path.basename(oldRoot));
  const accept=[...back,'--accept-unread'],accepted=apply(c,candidateRoot,accept);
  if(!same(receipts(c),before))throw Error('accepted rollback did not restore the exact installation and plist bytes');
  const archive=JSON.parse(read(path.join(c.directory,'upgrades/offer-rollback.json')));
  if(JSON.stringify(archive.unread_accepted)!==JSON.stringify(accepted.planned.unread)||!archive.unread_accepted.length)throw Error('archive does not bind the accepted unread list');
  legs.old_with_unread=await runLeg(c,oldRoot,{process_type:false});
  return {consumer:c.name,status:'PASS',refusal,unread_accepted:archive.unread_accepted,restored_exact_bytes:true,legs};
}

const listing=dir=>fs.existsSync(dir)?fs.readdirSync(dir).sort():null;
const realListing=home=>JSON.stringify([listing(home),listing(path.join(home,'releases'))]);
// Never touches a target this run did not derive from its own scratch consumer.
export function bootoutOwned(c,scratch,run=spawnSync){
  if(!c.directory.startsWith(scratch+path.sep)||!/^gui\/\d+\/dev\.herdr\.line\.[^/]+$/.test(c.target)||path.basename(c.directory)!==c.target.split('.').at(-1))throw Error(`not a scratch target: ${c.target}`);
  const printed=run('/bin/launchctl',['print',c.target],{encoding:'utf8'});
  if(printed.status!==0)return false;
  const out=run('/bin/launchctl',['bootout',c.target],{encoding:'utf8'});
  if(out.status!==0)throw Error(`bootout refused for ${c.target}: ${out.stderr}`);
  return true;
}

function identity(root){
  const manifest=read(path.join(root,'.release-manifest.json'));
  return {root,release:path.basename(root),commit:read(path.join(root,'.release-commit')).trim(),manifest_sha256:sha(manifest),kind:JSON.parse(manifest).release?.kind??null};
}

export async function runWitness({oldRoot,candidateRoot,evidence,exact=false,keep=false}){
  fs.mkdirSync(evidence,{recursive:true});
  const steps=path.join(evidence,'steps.jsonl'),write=value=>{fs.writeFileSync(path.join(evidence,'outcome.json'),JSON.stringify(value,null,2)+'\n');return value;};
  const log=row=>fs.appendFileSync(steps,JSON.stringify({at:new Date().toISOString(),...row})+'\n');
  const base={schema:SCHEMA,mode:exact?'exact':'scratch',launchd:'real',native_caller:'stand-in',herdr_transport:'stand-in',ready:false,exact_candidate:exact?'observed':'UNRUN',
    bch:'not read',unrun:['A real native caller and real Herdr transport during these legs','BCH real installation and record','Real in-flight work; only closed scratch work is present',
      ...(exact?[]:['The exact release bytes: these copies differ in their release home and carry no validation proof'])]};
  if(process.platform!=='darwin'||process.version!=='v20.19.4')return write({...base,status:'UNRUN',reason:'needs macOS and pinned Node 20.19.4'});
  const missing=exact?[oldRoot,candidateRoot].map(root=>exactPrerequisite(root)).filter(row=>!row.ready):[];
  const unready={status:'UNRUN',exact_candidate:'UNRUN',reason:'exact mode needs both releases READY in the real home',missing};
  if(missing.some(row=>row.root===oldRoot))return write({...base,...unready});
  const realHome=releaseHome(),homeBefore=realListing(realHome),scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rollback-launchd-')));
  const context={log,consumers:[],oldRoot,candidateRoot};
  const payload={};
  let result;
  try{
    if(!exact){
      const home=path.join(scratch,'home');
      fs.mkdirSync(path.join(home,'releases'),{recursive:true});
      context.oldRoot=sealedCopy(oldRoot,home,'scratch-old');
      context.candidateRoot=sealedCopy(candidateRoot,home,'scratch-offered');
      fixtureOffer(home,context.candidateRoot,'scratch-offered');
      for(const [name,source,copy] of [['old',oldRoot,context.oldRoot],['candidate',candidateRoot,context.candidateRoot]])
        payload[name]={...identity(source),copy:identity(copy),payload_changes:payloadDifference(source,copy)};
    }else{payload.old=identity(oldRoot);if(fs.existsSync(path.join(candidateRoot,'.release-manifest.json')))payload.candidate=identity(candidateRoot);}
    if(missing.length){
      const c=await migrated(scratch,'old-only',context);context.consumers.push(c);
      result={...base,...unready,releases:payload,old_release_leg:await runLeg(c,oldRoot,{process_type:false})};
    }else{
      const round_trip=await roundTrip(scratch,context);
      const recovery=await refusalAndRecovery(scratch,context);
      result={...base,status:'PASS',releases:payload,round_trip,recovery};
    }
  }catch(error){
    result={...base,status:'FAIL',releases:payload,error:error.message};
  }
  const cleanup={booted_out:[],errors:[]};
  for(const c of context.consumers){
    for(const name of ['launchd.log','launchd.error.log','controls.jsonl','passes.jsonl','service.plist','installation.json']){
      const file=path.join(c.directory,name);
      if(fs.existsSync(file)){fs.mkdirSync(path.join(evidence,c.name),{recursive:true});fs.copyFileSync(file,path.join(evidence,c.name,name));}
    }
    const calls=path.join(c.bin,'calls.jsonl');
    if(fs.existsSync(calls))fs.copyFileSync(calls,path.join(evidence,c.name,'herdr-calls.jsonl'));
    const printed=c.print();if(printed.status===0)fs.writeFileSync(path.join(evidence,c.name,'launchctl-print-at-cleanup.txt'),printed.stdout);
    try{if(bootoutOwned(c,scratch))cleanup.booted_out.push(c.target);}catch(error){cleanup.errors.push(error.message);}
  }
  result.targets=context.consumers.map(c=>c.target);
  result.real_home_listing_unchanged=realListing(realHome)===homeBefore;
  if(!result.real_home_listing_unchanged&&result.status!=='FAIL'){result.status='FAIL';result.error='the real release home listing changed';}
  if(cleanup.errors.length&&result.status!=='FAIL'){result.status='FAIL';result.error='cleanup refused';}
  result.cleanup=cleanup;
  if(result.status!=='FAIL'&&!keep)fs.rmSync(scratch,{recursive:true,force:true});else result.scratch=scratch;
  return write(result);
}

export async function main(argv=process.argv.slice(2)){
  const {values:v}=parseArgs({args:argv,usage:'rollback-launchd.mjs --old-root INSTALLED_ROOT --candidate-root INSTALLED_ROOT --evidence DIR [--exact] [--keep]',
    options:{'old-root':{type:'string'},'candidate-root':{type:'string'},evidence:{type:'string'},exact:{type:'boolean'},keep:{type:'boolean'}}});
  for(const name of ['old-root','candidate-root','evidence'])if(!path.isAbsolute(v[name]??''))throw Error(`--${name} needs an absolute path`);
  const result=await runWitness({oldRoot:v['old-root'],candidateRoot:v['candidate-root'],evidence:v.evidence,exact:v.exact,keep:v.keep});
  process.stdout.write(JSON.stringify({status:result.status,mode:result.mode,reason:result.reason,error:result.error,evidence:v.evidence})+'\n');
  process.exitCode=result.status==='PASS'?0:result.status==='UNRUN'?3:1;
}
if(isMain(import.meta.url))main().catch(error=>{process.stderr.write(`rollback-launchd: ${error.message}\n`);process.exitCode=1;});
