import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';

test('unreported backlog retains the exact original dispatch error and missing SID without finalizing or rebinding',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);
  const original=events(f),run=original.find(e=>e.type==='run.started'),token='original',journal=path.join(f.org,'dispatch',token+'.json');
  run.meta={...run.meta,dispatch_project:f.common,dispatch_attempt:token,dispatch_journal:journal};
  fs.writeFileSync(f.eventFile,original.map(e=>JSON.stringify(e)+'\n').join(''));
  const saved=fold(events(f)).runs.get(run.id);
  fs.mkdirSync(path.dirname(journal),{recursive:true});
  const job={token,run:run.id,repo:f.repo,org:f.org,common:f.common,ownership:{generation:saved.owner_generation,owner:saved.owner},stage:'watch',
    worker:{agentSessionId:null},native_launch_attempted:true,error:'original watcher exited during startup',failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}};
  fs.writeFileSync(journal,JSON.stringify(job)+'\n');const bytes=fs.readFileSync(journal),before=events(f),calls=f.herdrCalls();
  const args={project:gitProject(f.repo),org:f.org,events:before,guard:()=>{}};
  const rows=reconcileCloseoutBacklog(args);assert.equal(rows.length,1);
  assert.equal(rows[0].disposition,'dispatch-error-unreported');assert.equal(rows[0].dispatch.native_session_bound,false);
  assert.equal(rows[0].dispatch.error,job.error);assert.equal(rows[0].dispatch.failure.kind,'unknown');
  assert.deepEqual(fs.readFileSync(journal),bytes);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,[]);
  assert.equal(events(f).some(e=>e.type==='run.abandoned'||e.type==='run.session_bound'),false);
  assert.deepEqual(events(f).slice(0,before.length),before);assert.deepEqual(reconcileCloseoutBacklog({...args,events:events(f)}),[]);
});
