import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {initOrg,transact,loadRecord} from '../../lib/store.mjs';
import {gitProject} from '../../lib/project.mjs';
import {brainOwner} from '../../lib/run-owner.mjs';
import {bundleRelease} from '../../lib/releases.mjs';
import {sharedDirectory,registrationFile,stepFile,nativeBinding} from '../shared.mjs';

const watch=path.resolve(import.meta.dirname,'../watch.mjs');
export const source=path.resolve(import.meta.dirname,'../..');
export const reportText=(run='R-1')=>`---\nrun: ${run}\noutcome: done\nsummary: Finished the isolated task.\nheadline: The task is complete\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`;
export function fixture(t,{startGrace='0',idleGrace='0',longAfter='3600',lateSession=false,sessionless=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'watch-step-'))),repo=path.join(root,'project'),org=path.join(repo,'.org'),report=path.join(root,'report.md');fs.mkdirSync(repo);
  const fleet=process.env.HERDR_MONITOR_FLEET;process.env.HERDR_MONITOR_FLEET=path.join(root,'fleet');
  t.after(()=>{if(fleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=fleet;fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(spawnSync('git',['init','-qb','main'],{cwd:repo}).status,0);
  const project=gitProject(repo),owner=brainOwner();initOrg(org);
  const native={name:'worker-one',pane_id:'w1:p1',workspace_id:'w1',terminal_id:'term-one',cwd:repo,
    ...(sessionless?{}:{agent_session:{value:'original-session'}}),agent_status:sessionless?'idle':'working',state_change_seq:1};
  const initial=transact(org,()=>({add:[{type:'item.added',id:'ENG-9',title:'Isolated work',role:'engineer'},
    {type:'run.started',id:'R-1',item:'ENG-9',workspace:repo,report_path:report,meta:{dispatch_project:project.identity,dispatch_record:org,dispatch_journal:path.join(root,'dispatch.json'),dispatch_attempt:'original-attempt'}},
    {type:'run.claimed',run:'R-1',record:org,project:project.identity,owner},
    {type:'run.updated',id:'R-1',meta:{agent:native.name,pane:native.pane_id,worker_workspace:native.workspace_id,terminal_id:native.terminal_id,...(lateSession||sessionless?{}:{agent_session_id:native.agent_session.value})}}]}));
  const ownership={owner,generation:initial.added.find(e=>e.type==='run.claimed').seq};
  const status=path.join(root,'native.json'),calls=path.join(root,'calls'),herdr=path.join(root,'herdr');
  fs.writeFileSync(status,JSON.stringify(native));
  fs.writeFileSync(herdr,`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');const n=JSON.parse(fs.readFileSync(${JSON.stringify(status)}));if(n===null){process.stderr.write(JSON.stringify({error:{code:'agent_not_found',message:'gone'}}));process.exitCode=1;}else{if(a[0]==='agent'&&a[1]==='prompt'){n.agent_session??={value:'original-session'};n.agent_status='working';fs.writeFileSync(${JSON.stringify(status)},JSON.stringify(n));}process.stdout.write(JSON.stringify({result:{agent:n}}));}\n`,{mode:0o755});
  const args=['R-1','--org',org,'--cwd',repo,'--to','supervisor-test','--report',report,'--herdr',herdr,'--record-only','--start-grace',startGrace,'--idle-grace',idleGrace,'--long-after',longAfter];
  const d={schema:'brain.shared-watch/v1',run:'R-1',org,project:project.identity,repo,cwd:repo,source,release:bundleRelease(),ownership,native:nativeBinding(native),to:'supervisor-test',report,argv:args,
    consumer:'watch/watch.mjs --step',wake_fact:'native lifecycle, report/record change or coarse-safety-reconciliation',stuck_owner:'supervisor-test'};
  fs.mkdirSync(sharedDirectory(org),{recursive:true});fs.writeFileSync(registrationFile(org,'R-1'),JSON.stringify(d));
  const step=()=>spawnSync(process.execPath,[watch,...args,'--step'],{cwd:repo,env:{...process.env,ORG_DIR:org,ORG_ACTOR:'watch-step-fixture'},encoding:'utf8'});
  const state=()=>JSON.parse(fs.readFileSync(stepFile(org,'R-1')));
  const setNative=value=>fs.writeFileSync(status,JSON.stringify(value));
  const notices=()=>loadRecord(org).state.runs.get('R-1').notes.filter(n=>n.text.startsWith('[watch record-only]'));
  const register=()=>spawnSync(process.execPath,[watch,...args,'--shared'],{cwd:repo,env:{...process.env,ORG_DIR:org,ORG_ACTOR:'watch-step-fixture'},encoding:'utf8'});
  const getNative=()=>JSON.parse(fs.readFileSync(status));
  const prompt=()=>spawnSync(herdr,['agent','prompt',native.name,'Original first task'],{encoding:'utf8'});
  return {root,repo,org,report,native,step,state,setNative,getNative,prompt,notices,calls,register,ownership};
}
