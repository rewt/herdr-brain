import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setup,events,selectCurrentCleanup,cli} from './helpers/closeout-fixture.mjs';
import {initOrg} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {selfClosedDecision} from '../lib/self-closed-decision.mjs';
import {runReportIntake,runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {countSessions} from '../dispatch/session-cap.mjs';

function decision(t,as='done') {
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);initOrg(f.org);
  const file=path.join(f.org,'runs/R-1/report.md'),rows=events(f);
  rows.find(e=>e.type==='item.added').role='decision';
  rows.find(e=>e.type==='run.started').report_path=file;
  fs.writeFileSync(f.eventFile,rows.map(e=>JSON.stringify(e)+'\n').join(''));
  f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,
    owner:{controller:'brain',legacy:false,release:{id:'source',root:process.cwd(),identity:gitProject(process.cwd()).identity,commit:null}}}]);
  // Match the historical worker close: no completed_run annotation.
  const [closed]=f.append([{type:'item.closed',id:'ENG-1',as,by:'worker',note:'Decision and delegated next action recorded.'}]);
  const text='---\nrun: R-1\noutcome: done\nsummary: Decision already recorded; closer owns allocation release.\n---\n';
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);
  const calls=[];
  const ingest=(_file,args)=>{
    calls.push(args);
    const r=spawnSync(process.execPath,[cli,...args],{cwd:f.repo,env:f.env,encoding:'utf8'});
    if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout;
  };
  const options={project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},cli:ingest};
  const capacity=()=>countSessions({state:fold(events(f)),events:events(f),common:f.common,
    kill:()=>{},readProcess:pid=>({ok:true,value:{pid,identity:'native birth'}}),
    agent:()=>{throw Error('no live lookup needed');}}).filter(s=>s.kind==='decision').length;
  return {...f,file,text,closed,calls,options,capacity};
}

for(const as of ['done','dropped']) {
test(`self-closed ${as} decision recovers failed intake, releases its cap and closes its original allocation without judgment replay`,t=>{
  const f=decision(t,as),before=fs.readFileSync(f.eventFile);
  assert.equal(f.capacity(),1,'self-close alone still holds the decision cap');
  fs.writeFileSync(f.file,'unfinished report');
  const failed=runReportIntake(f.options);
  assert.equal(failed.errors.length,1);assert.equal(f.capacity(),1);
  assert.equal(fold(events(f)).runs.get('R-1').report,null);
  fs.writeFileSync(f.file,f.text);
  assert.deepEqual(runReportIntake(f.options).errors,[]);
  const committed=events(f),report=committed.find(e=>e.type==='report.ingested');
  assert.deepEqual(report.already_closed_by_run,{item:'ENG-1',run:'R-1',seq:f.closed.seq,by:'worker'});
  assert.equal(report.sha256,createHash('sha256').update(f.text).digest('hex'));
  assert.equal(fs.readFileSync(path.join(f.org,report.file),'utf8'),f.text);
  assert.equal(f.capacity(),0);
  assert.equal(runReportIntake(f.options).ingested,0);
  assert.equal(f.calls.length,2,'only the failed attempt and its recovery invoke intake');
  assert.deepEqual(fold(events(f)).items.get('ENG-1').closed,fold(committed).items.get('ENG-1').closed);
  const result=runCloseoutTurn({...f.options,measure:()=>{},cli:(_file,args)=>args[0]==='refresh'?'{}':
    JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true}))});
  assert.deepEqual(result.errors,[]);
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(f.read().workspaces,[]);
  const after=events(f);
  assert.equal(after.filter(e=>e.type==='report.ingested').length,1);
  assert.equal(after.filter(e=>e.type==='item.closed').length,1,'no judgment or closure replay');
  assert.equal(fold(after).items.get('ENG-1').closed.as,as,'original disposition survives closeout');
  assert.equal(after.some(e=>['run.abandoned','decision.applied','decision.stale'].includes(e.type)),false);
  assert.ok(after.some(e=>e.type==='closeout.evaluated'&&e.completed));
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});
}

test('self-closed decision intake excludes foreign, superseded, abandoned and conflicting identities',()=>{
  const base=[{seq:1,type:'item.added',id:'DEC-1',role:'decision'},
    {seq:2,type:'run.started',id:'R-1',item:'DEC-1',meta:{agent:'worker'}},
    {seq:3,type:'item.closed',id:'DEC-1',as:'done',by:'worker'}];
  const proof=rows=>{const state=fold(rows);return selfClosedDecision(state.runs.get('R-1'),state,rows);};
  const variants=[rows=>{rows[0].role='engineer';},rows=>{rows[2].by='supervisor';},
    rows=>{rows[2].as='unknown';},rows=>{rows[2].completed_run='R-2';},
    rows=>{rows[2].seq=1;},rows=>{rows[1].meta={};},
    rows=>rows.push({seq:4,type:'run.started',id:'R-2',item:'DEC-1'}),
    rows=>rows.push({seq:4,type:'run.abandoned',id:'R-1'}),
    rows=>rows.push({seq:4,type:'run.session_bound',run:'R-1',session:'foreign'}),
    rows=>rows.push({seq:4,type:'item.reopened',id:'DEC-1'})];
  for(const as of ['done','dropped']) {
    base[2].as=as;assert.ok(proof(base));
    for(const change of variants){const rows=structuredClone(base);change(rows);assert.equal(proof(rows),null);}
  }
});

for(const as of ['done','dropped']) {
test(`self-closed ${as} intake rechecks the exact closure under the record mutation guard`,t=>{
  const f=decision(t,as);
  f.append([{type:'item.reopened',id:'ENG-1'},{type:'item.closed',id:'ENG-1',as:'done',by:'supervisor'}]);
  const r=spawnSync(process.execPath,[cli,'ingest',f.file,'--run','R-1','--if-current-run','R-1',
    '--if-self-closed',String(f.closed.seq)],{cwd:f.repo,env:f.env,encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/original self-closed decision changed/);
  assert.equal(runReportIntake(f.options).ingested,0);
  assert.equal(fold(events(f)).runs.get('R-1').report,null);
  assert.equal(f.capacity(),1);
});
}
