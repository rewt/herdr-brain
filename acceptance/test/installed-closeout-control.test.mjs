import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {expiredCloseoutControl} from '../installed-closeout-control.mjs';
import {runCloseoutTurn,closeoutServiceDirectory} from '../../line-service/closeout-turn.mjs';
import {retirementLock} from '../../lib/retire-lock.mjs';
import {gitProject} from '../../lib/project.mjs';
import {initOrg,loadEvents} from '../../lib/store.mjs';
import {harnessEnvironment} from '../run.mjs';
import {enterScratchHomes} from '../environment.mjs';

test('expired canary control recovers when a finite owner takes the lock after an absence observation', async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'canary-closeout-')));
  const env=harnessEnvironment(process.env,root),restore=enterScratchHomes(env,[root]);
  t.after(()=>{restore();fs.rmSync(root,{recursive:true,force:true});});
  const git=args=>execFileSync('git',args,{cwd:root,env,stdio:'pipe'});
  git(['init','-qb','main']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Scratch']);
  const project=gitProject(root),org=path.join(root,'.org');initOrg(org);
  const directory=closeoutServiceDirectory(org,project.identity),lock=path.join(directory,'closeout-turn.lock');
  fs.mkdirSync(directory,{recursive:true});
  assert.equal(fs.existsSync(lock),false,'the old absence check passes');
  const release=retirementLock(lock);
  let attempts=0,commands=0;
  const before=loadEvents(org).events;
  try {
    const result=await expiredCloseoutControl({runCloseoutTurn,options:{project,org,env,guard:()=>{},measure:()=>{},
      cli:()=>{commands++;assert.fail('zero budget issued a command');}},
      until:async predicate=>{
        attempts++;assert.equal(predicate(),false,'supported contention is still pending');
        attempts++;assert.equal(predicate(),false,'repeated contention is still pending');
        release();
        attempts++;assert.equal(predicate(),true,'the original control recovers after release');
      }});
    assert.equal(result.contentions,2);assert.equal(result.deadline.result,'closeout-turn-complete');
    assert.equal(result.deadline.steps,0);assert.equal(result.deadline.backlog_classified,0);
    assert.equal(attempts,3);assert.equal(commands,0);
    assert.deepEqual(loadEvents(org).events,before,'no waits or effects were registered');
  } finally {release();}
});

test('expired canary control preserves bounded contention failure', async()=>{
  let attempts=0;
  await assert.rejects(expiredCloseoutControl({runCloseoutTurn:()=>{attempts++;return {already_running:true};},options:{},
    until:async predicate=>{assert.equal(predicate(),false);assert.equal(predicate(),false);throw Error('observation deadline');}}),/observation deadline/);
  assert.equal(attempts,2);
});

test('expired canary control does not retry unexpected results or exceptions', async()=>{
  for(const turn of [()=>({result:'closeout-code-handoff-pending'}),()=>{throw Error('native refusal');},
    ()=>({steps:1,backlog_classified:0})]) {
    let attempts=0;
    await assert.rejects(expiredCloseoutControl({runCloseoutTurn:()=>{attempts++;return turn();},options:{},
      until:async predicate=>{assert.equal(predicate(),true);}}));
    assert.equal(attempts,1);
  }
});
