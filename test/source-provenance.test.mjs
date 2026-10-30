import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {initOrg,transact,loadEvents} from '../lib/store.mjs';
import {dispatchSourceBinding,deliveredSourceProof} from '../lib/source-provenance.mjs';
import {sourceCompletionProof} from '../line-service/source-completion.mjs';
import {recordOwnLanding} from '../lib/landing-receipt.mjs';
import {ownWorktreeGuard} from '../promote/own-worktree.mjs';
import {canonicalReviewIndex,reviewHealth,discoverChanges} from '../line-service/phase1.mjs';
import {createHash} from 'node:crypto';

const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t){
  const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-provenance-'))),repo=path.join(scratch,'repo'),workspace=path.join(scratch,'lane'),clone=path.join(scratch,'clone');
  t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));fs.mkdirSync(repo);git(repo,['init','-qb','main']);git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(repo,'.git/info/exclude'),'.org/\n.lane/\n');fs.writeFileSync(path.join(repo,'seed'),'base');git(repo,['add','.']);git(repo,['commit','-qm','Base']);
  const project=gitProject(repo),org=path.join(repo,'.org');initOrg(org);const base=git(repo,['rev-parse','HEAD']);git(repo,['worktree','add','-qb','lane/source',workspace]);
  fs.writeFileSync(path.join(workspace,'source'),'delivered');git(workspace,['add','.']);git(workspace,['commit','-qm','Delivered']);const head=git(workspace,['rev-parse','HEAD']);
  git(repo,['clone','-q',workspace,clone]);
  const journal=path.join(org,'dispatch/source.json');fs.mkdirSync(path.dirname(journal));fs.writeFileSync(journal,JSON.stringify({run:'R-1',item:'ENG-1',common:project.identity,org,workspace,base,token:'source'}));
  const native={name:'worker',pane_id:'pane',workspace_id:'workspace',terminal_id:'terminal',cwd:workspace,agent_session:{value:'session'}};
  const report=`---\nrun: R-1\noutcome: done\nsummary: Delivered source.\nartifacts:\n  - "source: ${head}; base: ${base}"\n---\n`;
  const file=path.join(org,'runs/R-1/report.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,report);
  const owner={controller:'brain',legacy:false,release:{id:'source',commit:null,root:repo,identity:project.identity}};
  transact(org,()=>({add:[{type:'line-service.phase0',id:'fixture',project:project.identity,repo,org,main:'main',canonical_head:base},
    {type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Source'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace,meta:{dispatch_project:project.identity,dispatch_record:org,dispatch_attempt:'source',dispatch_journal:journal,lane:'source',agent:native.name,pane:native.pane_id,worker_workspace:native.workspace_id,terminal_id:native.terminal_id,agent_session_id:native.agent_session.value}},
    {type:'run.claimed',run:'R-1',project:project.identity,record:org,owner}]}));
  const context=()=>{const events=loadEvents(org).events,state=fold(events);return{project,org,repo,identity:project.identity,events,state,run:state.runs.get('R-1'),git,identify:gitProject};};
  const artifacts=[`source: ${head}; base: ${base}`];
  const env={...process.env,ORG_DIR:org,HERDR_ENV:'1',HERDR_PANE_ID:'pane',HERDR_WORKSPACE_ID:'workspace',CODEX_THREAD_ID:'session'};
  const args={canonical:repo,workspace,base,head,landedAt:'2026-10-30T17:00:00Z',env,call:()=>JSON.stringify({result:{agent:native}})};
  const land=()=>{git(repo,['merge','--ff-only',head]);return recordOwnLanding(args);};
  const ingest=()=>transact(org,()=>({add:[{type:'report.ingested',run:'R-1',file:'runs/R-1/report.md',sha256:createHash('sha256').update(report).digest('hex'),report:{outcome:'done',artifacts}}]}));
  return{scratch,repo,workspace,clone,base,head,project,org,artifacts,context,args,land,ingest};
}

test('source provenance compares equal hashes in distinct clones and the unchanged registered lane without borrowing coverage',t=>{
  const f=fixture(t);assert.equal(git(f.clone,['rev-parse','HEAD']),f.head);assert.notEqual(gitProject(f.clone).identity,f.project.identity);
  // Raw external integration is observable but has no guarded producer receipt.
  git(f.repo,['merge','--ff-only',f.head]);git(f.workspace,['reset','--hard',f.base]);f.ingest();
  const c=f.context(),unknown=deliveredSourceProof(c);assert.equal(unknown.status,'unknown');
  assert.throws(()=>sourceCompletionProof(c),/claimed delivered source is unknown/);
  const external=deliveredSourceProof({...c,artifacts:[`${f.artifacts[0]}; repository: ${f.clone}`]});assert.equal(external.status,'external');
  const found=discoverChanges(c);assert.equal(found.changes.length,1);assert.equal(found.changes[0].target.source_provenance.status,'unknown');
  const health=reviewHealth({...c,index:canonicalReviewIndex(c)});assert.equal(health.guarded_commits,0);assert.equal(health.uncovered_source.length,1);
  assert.equal(c.events.some(e=>e.type==='change.landed'),false,'review observation does not manufacture a guarded landing');
});

test('guarded source provenance survives a real same-common-directory worktree and removed allocation with exact ranges',t=>{
  const f=fixture(t);assert.equal(gitProject(f.workspace).identity,f.project.identity);assert.equal(f.land().changes.length,1);f.ingest();
  let c=f.context(),proof=sourceCompletionProof(c);assert.equal(proof.source_provenance.status,'covered');assert.equal(proof.source_head,f.head);
  const landing=c.events.find(e=>e.type==='change.landed');assert.equal(landing.source.repository,f.project.identity);assert.equal(landing.source.claim_generation,c.run.owner_generation);
  assert.equal(discoverChanges(c).changes[0].target.source_provenance.status,'covered');
  assert.equal(deliveredSourceProof({...c,artifacts:[`${f.artifacts[0]}; repository: ${f.clone}`]}).status,'external','equal hashes never override an explicit foreign source');
  git(f.repo,['worktree','remove',f.workspace]);proof=sourceCompletionProof(f.context());assert.equal(proof.allocation,'absent');assert.equal(proof.source_provenance.status,'covered');
});

test('source provenance refuses missing dispatch, stale claims and incomplete or empty claimed ranges',t=>{
  const f=fixture(t);f.land();f.ingest();const c=f.context();
  for(const mutate of [x=>delete x.events.find(e=>e.type==='run.started').meta.dispatch_record,x=>x.run.owner_generation++,x=>x.events.find(e=>e.type==='change.landed').source.repository=f.clone]){
    const x=structuredClone({events:c.events,run:c.run});mutate(x);assert.equal(deliveredSourceProof({...c,...x}).status,'unknown');
  }
  assert.equal(deliveredSourceProof({...c,artifacts:[`source: ${f.base}; base: ${f.base}`]}).status,'unknown');
  assert.equal(deliveredSourceProof({...c,artifacts:[...f.artifacts,`Commit: ${f.base}`]}).status,'unknown','one covered range cannot hide another claim');
});

test('self landing binds immutable dispatch repository before its effect and keeps post-FF receipt uncertainty',t=>{
  const f=fixture(t),c=f.context();
  const foreign={...c,events:structuredClone(c.events),run:structuredClone(c.run)};foreign.events.find(e=>e.type==='run.started').meta.dispatch_project=gitProject(f.clone).identity;
  assert.throws(()=>dispatchSourceBinding({...foreign,identity:f.project.identity}),/differs/);
  const guard=ownWorktreeGuard({canonical:f.repo,identity:f.project.identity,workspace:f.workspace,topic:'source',env:f.args.env,call:f.args.call});
  let effects=0;guard(()=>effects++);assert.equal(effects,1);
  transact(f.org,()=>({add:[{type:'run.updated',id:'R-1',meta:{dispatch_project:gitProject(f.clone).identity}}]}));
  assert.throws(()=>guard(()=>effects++),/differs/);assert.equal(effects,1);
  git(f.repo,['merge','--ff-only',f.head]);assert.throws(()=>recordOwnLanding(f.args),/differs/);
  assert.equal(git(f.repo,['rev-parse','HEAD']),f.head,'receipt failure never undoes the successful FF');
  assert.equal(f.context().events.some(e=>e.type==='change.landed'),false);f.ingest();assert.equal(deliveredSourceProof(f.context()).status,'unknown');
});

test('planning reports require no synthetic source delivery',t=>{
  const f=fixture(t);git(f.workspace,['reset','--hard',f.base]);const c=f.context();c.run.report={artifacts:[]};
  const proof=sourceCompletionProof(c);assert.equal(proof.source_provenance.status,'none');assert.equal(c.events.some(e=>e.type==='change.landed'),false);
});
