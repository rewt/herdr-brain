#!/usr/bin/env node
// The installed line's finite fast role. launchd and hints share this entry;
// the existing closer remains the sole native/Git retirement executor.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,isMain} from '../lib/cli-help.mjs';
import {gitProject} from '../lib/project.mjs';
import {findOrgDir} from '../lib/store.mjs';
import {lineServiceOwnsCleanup} from '../lib/closeout.mjs';
import {foregroundCommand} from '../dispatch/foreground-command.mjs';
import {serviceSource} from './runtime.mjs';
import {installedContext} from './cutoff.mjs';
import {runCloseoutTurn,closeoutServiceDirectory} from './closeout-turn.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export function closeoutTurnMain(argv=process.argv.slice(2)){
  const {values:v}=parseArgs({args:argv,options:{once:{type:'boolean'},repo:{type:'string'},org:{type:'string'}}});
  if(!v.once||!v.repo)throw Error('use --once --repo CANONICAL; the owning line supplies finite wakes');
  const project=gitProject(v.repo),org=fs.realpathSync(v.org??findOrgDir({cwd:v.repo,env:{...process.env,ORG_DIR:''}}));
  serviceSource(project.canonical);installedContext(project.canonical,org);
  const env={...process.env,ORG_DIR:org,ORG_ACTOR:'line-service',HERDR_BRAIN_ROOT:root};
  for(const k of Object.keys(env))if(/^(HERDR_(ENV|PANE_ID|TAB_ID|WORKSPACE_ID)|CODEX_(SESSION_ID|THREAD_ID)|GIT_.*|LANE_CONFIG|ORG_GUARD_OVERRIDE)$/.test(k))delete env[k];
  const guard=()=>{
    if(project.checkout!==project.canonical||gitProject(project.canonical).identity!==project.identity||!lineServiceOwnsCleanup(project,org))throw Error('line closeout owner/source changed');
    serviceSource(project.canonical);
    for(const file of [path.join(closeoutServiceDirectory(org,project.identity),'STOP'),...['STOP','HOLD'].map(n=>path.join(project.canonical,'.lane/supervisor',n))])
      if(fs.existsSync(file))throw Error('STOP/HOLD prevents line closeout');
  };
  const cli=(file,args)=>{
    const r=foregroundCommand(process.execPath,[path.join(root,file),...args],{cwd:project.canonical,env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:0});
    if(r.error||r.status!==0)throw Error(r.stderr||r.stdout||r.error?.message||`exit ${r.status}`);return r.stdout.trim();
  };
  return runCloseoutTurn({project,org,env,cli,guard});
}
if(isMain(import.meta.url))try{process.stdout.write(JSON.stringify(closeoutTurnMain())+'\n');}
catch(error){process.stderr.write(`line-closeout: ${error.message}\n`);process.exitCode=1;}
