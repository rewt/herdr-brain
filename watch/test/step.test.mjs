import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {initOrg,transact,loadRecord} from '../../lib/store.mjs';
import {gitProject} from '../../lib/project.mjs';
import {brainOwner,outstandingEffects,readOwnedRun} from '../../lib/run-owner.mjs';
import {bundleRelease} from '../../lib/releases.mjs';
import {sharedDirectory,registrationFile,stepFile,nativeBinding} from '../shared.mjs';

const watch=path.resolve(import.meta.dirname,'../watch.mjs'),source=path.resolve(import.meta.dirname,'../..');
const reportText=(run='R-1')=>`---\nrun: ${run}\noutcome: done\nsummary: Finished the isolated task.\nheadline: The task is complete\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`;
function fixture(t,{startGrace='0',idleGrace='0',longAfter='3600'}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'watch-step-'))),repo=path.join(root,'project'),org=path.join(repo,'.org'),report=path.join(root,'report.md');fs.mkdirSync(repo);
  const fleet=process.env.HERDR_MONITOR_FLEET;process.env.HERDR_MONITOR_FLEET=path.join(root,'fleet');
  t.after(()=>{if(fleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=fleet;fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(spawnSync('git',['init','-qb','main'],{cwd:repo}).status,0);
  const project=gitProject(repo),owner=brainOwner();initOrg(org);
  const native={name:'worker-one',pane_id:'w1:p1',workspace_id:'w1',terminal_id:'term-one',cwd:repo,agent_session:{value:'original-session'},agent_status:'working',state_change_seq:1};
  const initial=transact(org,()=>({add:[{type:'item.added',id:'ENG-9',title:'Isolated work',role:'engineer'},
    {type:'run.started',id:'R-1',item:'ENG-9',workspace:repo,report_path:report,meta:{agent:native.name,pane:native.pane_id,worker_workspace:native.workspace_id,terminal_id:native.terminal_id,agent_session_id:native.agent_session.value,dispatch_project:project.identity,dispatch_record:org}},
    {type:'run.claimed',run:'R-1',record:org,project:project.identity,owner}]}));
  const ownership={owner,generation:initial.added.at(-1).seq};
  const status=path.join(root,'native.json'),calls=path.join(root,'calls'),herdr=path.join(root,'herdr');
  fs.writeFileSync(status,JSON.stringify(native));
  fs.writeFileSync(herdr,`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');const n=JSON.parse(fs.readFileSync(${JSON.stringify(status)}));if(n===null){process.stderr.write(JSON.stringify({error:{code:'agent_not_found',message:'gone'}}));process.exitCode=1;}else process.stdout.write(JSON.stringify({result:{agent:n}}));\n`,{mode:0o755});
  const args=['R-1','--org',org,'--cwd',repo,'--to','supervisor-test','--report',report,'--herdr',herdr,'--record-only','--start-grace',startGrace,'--idle-grace',idleGrace,'--long-after',longAfter];
  const d={schema:'brain.shared-watch/v1',run:'R-1',org,project:project.identity,repo,cwd:repo,source,release:bundleRelease(),ownership,native:nativeBinding(native),to:'supervisor-test',report,argv:args,
    consumer:'watch/watch.mjs --step',wake_fact:'native lifecycle, report/record change or coarse-safety-reconciliation',stuck_owner:'supervisor-test'};
  fs.mkdirSync(sharedDirectory(org),{recursive:true});fs.writeFileSync(registrationFile(org,'R-1'),JSON.stringify(d));
  const step=()=>spawnSync(process.execPath,[watch,...args,'--step'],{cwd:repo,env:{...process.env,ORG_DIR:org,ORG_ACTOR:'watch-step-fixture'},encoding:'utf8'});
  const state=()=>JSON.parse(fs.readFileSync(stepFile(org,'R-1')));
  const setNative=value=>fs.writeFileSync(status,JSON.stringify(value));
  const notices=()=>loadRecord(org).state.runs.get('R-1').notes.filter(n=>n.text.startsWith('[watch record-only]'));
  return {root,repo,org,report,native,step,state,setNative,notices,calls};
}
function ok(f){const r=f.step();assert.equal(r.status,0,r.stderr||r.stdout);return r;}

test('finite watcher validates a working report without final delivery, then hands the stopped report off once',t=>{
  const f=fixture(t);fs.writeFileSync(f.report,reportText());ok(f);
  assert.equal(f.state().phase,'waiting');assert.equal(f.notices().length,0);assert.equal(loadRecord(f.org).events.filter(e=>e.type==='report.available').length,1);
  assert.ok(outstandingEffects(f.org,{...readOwnedRun(f.org,'R-1'),report:{}},gitProject(f.repo).identity).includes('watch:shared-pending'),'report ingestion alone cannot drop shared observation duty');
  f.setNative({...f.native,agent_status:'done',state_change_seq:2,completion_seq:2});ok(f);
  assert.equal(f.state().phase,'complete');assert.ok(!outstandingEffects(f.org,{...readOwnedRun(f.org,'R-1'),report:{}},gitProject(f.repo).identity).includes('watch:shared-pending'));assert.equal(f.notices().length,1);assert.match(f.notices()[0].text,/org-report/);
  const nativeCalls=fs.readFileSync(f.calls,'utf8');assert.doesNotMatch(nativeCalls,/"wait"/,'finite consumer never spawns a native wait process');
});

test('blocked, invalid, idle and resumed work retain their distinct notices and dedup across finite restarts',t=>{
  const f=fixture(t);ok(f);const oldCheckpoint=fs.readFileSync(stepFile(f.org,'R-1'));
  f.setNative({...f.native,agent_status:'blocked',state_change_seq:2});ok(f);
  fs.writeFileSync(stepFile(f.org,'R-1'),oldCheckpoint);ok(f);
  assert.equal(f.notices().length,1);assert.match(f.notices()[0].text,/watch-blocked/);
  fs.writeFileSync(f.report,'---\nrun: R-1\noutcome: invalid\n---');ok(f);assert.equal(f.notices().length,2);assert.match(f.notices()[1].text,/watch-invalid-report/);
  fs.unlinkSync(f.report);f.setNative({...f.native,agent_status:'idle',state_change_seq:3});ok(f);ok(f);assert.equal(f.notices().length,3);
  f.setNative({...f.native,agent_status:'working',state_change_seq:4});ok(f);
  f.setNative({...f.native,agent_status:'idle',state_change_seq:5});ok(f);assert.equal(f.notices().length,4);
});

test('startup and idle grace retain their original deadlines across finite consumers',t=>{
  const f=fixture(t,{startGrace:'60',idleGrace:'90'});f.setNative({...f.native,agent_status:'idle'});ok(f);
  const start=f.state();ok(f);assert.equal(f.state().state.armedAt,start.state.armedAt);assert.ok(f.state().next_at<=start.next_at+10);assert.equal(f.notices().length,0);
  f.setNative(f.native);ok(f);f.setNative({...f.native,agent_status:'idle',state_change_seq:3});ok(f);
  const idle=f.state();ok(f);assert.equal(f.state().state.idleGraceUntil,idle.state.idleGraceUntil);assert.equal(f.notices().length,0);
});

test('long-run notification is one original logical event across finite consumers',t=>{
  const f=fixture(t,{longAfter:'0'});ok(f);ok(f);assert.equal(f.notices().length,1);assert.match(f.notices()[0].text,/watch-long-running/);assert.equal(f.state().state.longNotified,true);
});

test('definite vanished worker preserves the no-report exception and exact native replacement stays unavailable',t=>{
  const f=fixture(t);f.setNative({...f.native,agent_status:'done',agent_session:{value:'replacement-session'}});fs.writeFileSync(f.report,reportText());ok(f);
  assert.equal(f.state().phase,'waiting');assert.equal(f.notices().length,0);assert.match(f.state().state.pendingUnavailable,/original native occupant changed/);
  fs.unlinkSync(f.report);f.setNative(null);const result=f.step();assert.equal(result.status,1);assert.match(result.stderr,/gone without a valid report/);assert.equal(f.state().phase,'failed');
  assert.ok(f.notices().some(n=>/state=gone/.test(n.text)));
});

test('changed claim stops the original finite duty before a notice and retains its registration',t=>{
  const f=fixture(t);ok(f);
  transact(f.org,()=>({add:[{type:'run.claimed',run:'R-1',record:f.org,project:gitProject(f.repo).identity,owner:{...loadRecord(f.org).state.runs.get('R-1').owner,controller:'other'}}]}));
  const r=f.step();assert.equal(r.status,1);assert.match(r.stderr,/RUN_OWNED_ELSEWHERE/);assert.equal(f.notices().length,0);assert.ok(fs.existsSync(registrationFile(f.org,'R-1')));
});
