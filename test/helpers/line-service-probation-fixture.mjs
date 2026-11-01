import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {configFixture} from './config-home-fixture.mjs';
import {copyProduct,productFiles,payloadEntry} from '../../lib/product-files.mjs';
import {freezeReleaseValidation} from '../../herdr/validation-admission.mjs';
import {loadEvents,transact} from '../../lib/store.mjs';
import {gitProject} from '../../lib/project.mjs';
import {lineDirectory} from '../../line-service/cutoff.mjs';
import {launchPlist} from '../../line-service/plist.mjs';
import {requireReadyAcceptance,selectRelease,requireHomeRelease} from '../../lib/releases.mjs';
import {fixture as dispatchFixture,promptCalls} from '../../dispatch/test/dispatch-fixture.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function fixture(t,{development=false,phase='installed',sourceSuffix='',productRoot=path.resolve(import.meta.dirname,'../..')}={}){
  let f;
  // The product's sealed payload is immutable; only private fixture teardown
  // makes its directories writable before configFixture removes its scratch.
  const teardown={after:fn=>t.after(()=>{
    if(f&&development){const folder=path.join(f.env.ORG_DIR,'line-service');
      const writable=dir=>{if(!fs.existsSync(dir))return;fs.chmodSync(dir,0o755);for(const e of fs.readdirSync(dir,{withFileTypes:true}))if(e.isDirectory())writable(path.join(dir,e.name));};writable(folder);}
    fn();
  })};
  f=configFixture(development?teardown:t,{custom:true});const org=f.env.ORG_DIR;
  // A private canonical Brain source, record, fleet and native observations.
  // Every release/READY/native receipt here is synthetic offline fixture data.
  copyProduct(productRoot,f.cwd);
  fs.writeFileSync(path.join(f.cwd,'.promote.json'),'{"to":"fixture-supervisor"}\n');
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');
  f.git('add','.');f.git('commit','-qm','Private Brain source');
  const commit=f.git('rev-parse','HEAD'),identity=gitProject(f.cwd).identity,directory=lineDirectory(org,identity);
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'service.plist'),installationFile=path.join(directory,'installation.json'),stop=path.join(directory,'STOP');
  const installation={target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,source:f.cwd+sourceSuffix,node:process.execPath,file,phase,
    ...(phase==='uncertain-or-refused'?{error:'Original refused bootstrap'}:{})};
  fs.writeFileSync(installationFile,JSON.stringify(installation)+'\n');
  fs.writeFileSync(file,launchPlist({label:`dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,to:'fixture-supervisor',herdr:'/saved/bin/herdr',socket:'/saved/native.sock',directory,node:process.execPath,source:f.cwd}));
  fs.writeFileSync(stop,'Original service STOP\n');
  const boundary={id:'original-cutover',project:identity,repo:f.cwd,org,source:f.cwd,main:'main',canonical_head:commit};
  transact(org,()=>({add:[{type:'item.added',id:'G-1',kind:'goal',title:'Private trial owner'}]}));
  transact(org,()=>({add:['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type}))}));
  const retained=path.join(org,'dispatch/retained.json');fs.mkdirSync(path.dirname(retained),{recursive:true});
  const jobs=JSON.stringify({stage:'UNKNOWN',root:f.bundle,watcher:{callback:'original-review',recipient:'fixture-supervisor'},sharedObserver:{root:f.bundle,registration:'original'}});
  fs.writeFileSync(retained,jobs);
  const agent=f.observation.agents[0],env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:agent.pane_id,HERDR_WORKSPACE_ID:agent.workspace_id,CODEX_THREAD_ID:agent.agent_session.value};
  const call=()=>JSON.stringify({result:{agent}}),calls=[];let loaded=false,refusal;
  const command=(exe,args,options)=>{
    calls.push({exe,args});
    if(exe==='/usr/bin/plutil')return spawnSync(exe,args,options);
    assert.equal(exe,'/bin/launchctl');
    if(args[0]==='print')return loaded?{status:0,stdout:'loaded'}:{status:113,stderr:'Could not find service in domain'};
    if(args[0]==='bootstrap'){if(refusal)return{status:1,stderr:refusal};loaded=true;return{status:0};}
    if(args[0]==='bootout'){loaded=false;return{status:0};}
    throw Error('unexpected native operation');
  };
  const module=(root,file)=>import(pathToFileURL(path.join(root,file)).href),args={repo:f.cwd,org,cwd:f.cwd,env,call,command,home:f.installationHome};
  const {migrateRuntime}=await module(f.bundle,'line-service/migrate-runtime.mjs');
  if(!development){const migration={...args,id:'fixture-migration'},plan=migrateRuntime({...migration,dryRun:true});
    migrateRuntime({...migration,expectedPlan:plan.archive.sha256});}
  const previous={installation:fs.readFileSync(installationFile,'utf8'),plist:fs.readFileSync(file,'utf8')};
  const next=f.release('trial',{commit});copyProduct(productRoot,next);fs.unlinkSync(path.join(next,'.release-acceptance.json'));
  const frozenFile=path.join(next,'.release-validation.json');
  const frozen=freezeReleaseValidation(f.cwd,'trial',frozenFile,env,{commit,mode:'routine'});
  // Synthetic package provenance follows the production routine manifest
  // contract; it is not producer/live/stable evidence for a real release.
  const runtime=productFiles(next).sort();
  fs.writeFileSync(frozenFile,JSON.stringify({...frozen,validation:{cwd:f.cwd,common:identity,commit,tree:f.git('rev-parse',`${commit}^{tree}`),
    inventorySha256:'0'.repeat(64),runtimeSha256:sha(JSON.stringify(Object.fromEntries(runtime.map(file=>[file,payloadEntry(next,file)])))),routine:{fullCoverage:'UNRUN'}}}));
  const manifest=spawnSync(process.execPath,[path.resolve('herdr/releases.mjs'),'manifest',next],{env,encoding:'utf8'});assert.equal(manifest.status,0,manifest.stderr);
  const {probationControl}=await module(f.cwd,'line-service/probation.mjs');
  const control=extra=>probationControl({...args,id:'original-trial',fromRoot:development?f.cwd:f.bundle,targetRoot:next,developmentRecovery:development,...extra});
  const authorize=()=>{
    const preview=control({dryRun:true});
    const note=transact(org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text:preview.required_decision}]}),{actor:agent.name}).added[0];
    return control({expectedPlan:preview.plan_sha256,authority:note.seq});
  };
  const {main}=await module(next,'line-service/launchd.mjs');
  const upgrade=['upgrade','--repo',f.cwd,'--org',org,'--id','trial-entry','--from-root',f.bundle,'--target-root',next];
  const enter=()=>{const p=main([...upgrade,'--dry-run'],args);return main([...upgrade,'--expected-plan',p.archive.sha256],args);};
  const withdraw=()=>main(['probation-withdraw','--repo',f.cwd,'--org',org,'--id','original-trial'],args);
  const rollback=['upgrade','--repo',f.cwd,'--org',org,'--id','trial-rollback','--from-root',next,'--target-root',f.bundle,'--rollback'];
  const back=extra=>{const p=main([...rollback,'--dry-run'],args);return main([...rollback,'--expected-plan',p.archive.sha256],{...args,...extra});};
  const {acceptedRuntime}=await module(next,'line-service/runtime.mjs');
  const admit=()=>acceptedRuntime(f.cwd,{root:next,home:f.installationHome});
  return{...f,org,identity,directory,file,installationFile,stop,retained,jobs,agent,args,module,next,control,authorize,main,enter,withdraw,back,rollback,admit,previous,calls,
    setLoaded:v=>loaded=v,setRefusal:v=>refusal=v};
}
export const state=f=>({installation:fs.readFileSync(f.installationFile,'utf8'),plist:fs.readFileSync(f.file,'utf8'),events:fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8'),jobs:fs.readFileSync(f.retained,'utf8')});

